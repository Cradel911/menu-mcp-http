import express from "express";
import fetch from "node-fetch";
import pdf from "pdf-parse";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const SET_MENU_URL = process.env.SET_MENU_URL;
const API_KEY = process.env.API_KEY; // optional

if (!SET_MENU_URL) {
  throw new Error("Missing SET_MENU_URL env var");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

function auth(req, res, next) {
  if (!API_KEY) return next();

  const h = req.headers["authorization"] || "";
  if (h !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ----------------------
// MCP server + tool(s)
// ----------------------
const mcp = new McpServer({ name: "menu-mcp", version: "1.0.0" });

async function loadPdfText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download PDF: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const data = await pdf(buf);
  return (data.text || "").trim();
}

mcp.tool(
  "get_set_menu_text",
  "Fetch and return the set menu text from the public PDF.",
  async () => {
    const text = await loadPdfText(SET_MENU_URL);
    return {
      content: [{ type: "text", text }],
    };
  }
);

mcp.tool(
  "get_set_menu_context",
  "Fetch set menu and return the menu text along with the user's question.",
  async ({ question }) => {
    const text = await loadPdfText(SET_MENU_URL);
    return {
      content: [
        {
          type: "text",
          text: `Question: ${question}\n\nMenu:\n${text}`,
        },
      ],
    };
  }
);

// ----------------------
// MCP over HTTP endpoint
// ----------------------
app.post("/mcp", auth, async (req, res) => {
  const transport = new StreamableHTTPServerTransport(req, res);
  await mcp.connect(transport);
});

// ----------------------
// MCP over SSE endpoints
// ----------------------
// ChatAgent SSE endpoint: https://YOUR_DOMAIN/sse
app.get("/sse", auth, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  await mcp.connect(transport);
});

app.post("/messages", auth, express.json({ limit: "2mb" }
