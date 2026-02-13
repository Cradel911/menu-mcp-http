import express from "express";
import fetch from "node-fetch";
import pdf from "pdf-parse";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const SET_MENU_URL = process.env.SET_MENU_URL;
const API_KEY = process.env.API_KEY; // optional

if (!SET_MENU_URL) throw new Error("Missing SET_MENU_URL env var");

const app = express();
app.use(express.json({ limit: "2mb" }));

function auth(req, res, next) {
  if (!API_KEY) return next();
  const h = req.headers["authorization"] || "";
  if (h !== `Bearer ${API_KEY}`) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Build MCP server + tool(s)
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
  "Fetch set menu and return the most relevant parts for a question.",
  async ({ question }) => {
    const text = await loadPdfText(SET_MENU_URL);

    // Simple relevance: return the whole text for now (we can optimize to chunking later)
    return {
      content: [{ type: "text", text: `Question: ${question}\n\nMenu:\n${text}` }],
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
// ChatAgent should point its SSE MCP "Endpoint" to: https://YOUR_DOMAIN/sse
app.get("/sse", auth, async (req, res) => {
  // Client will POST messages to /messages
  const transport = new SSEServerTransport("/messages", res);
  await mcp.connect(transport);
});

// The exact handler name can vary by MCP SDK version.
// This implementation tries the common patterns.
app.post("/messages", auth, express.json({ limit: "2mb" }), async (req, res) => {
  try {
    if (typeof SSEServerTransport.handlePostMessage === "function") {
      return await SSEServerTransport.handlePostMessage(req, res);
    }
    // Some versions expose handleRequest instead
    if (typeof SSEServerTransport.handleRequest === "function") {
      return await SSEServerTransport.handleRequest(req, res);
    }

    return res.status(500).json({
      error:
        "SSEServerTransport handler not found. Please share the Railway log error and @modelcontextprotocol/sdk version.",
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
