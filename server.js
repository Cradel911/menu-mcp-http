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
    return { content: [{ type: "text", text }] };
  }
);

mcp.tool(
  "get_set_menu_context",
  "Fetch set menu and return the menu text along with the user's question.",
  async ({ question }) => {
    const text = await loadPdfText(SET_MENU_URL);
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
// ChatAgent SSE endpoint: https://YOUR_DOMAIN/sse
// ChatAgent will then POST to /messages?sessionId=...
const sseTransports = new Map(); // sessionId -> transport

app.get("/sse", auth, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);

  const sessionId = transport.sessionId;
  if (sessionId) {
    sseTransports.set(sessionId, transport);
  }

  res.on("close", () => {
    if (sessionId) sseTransports.delete(sessionId);
  });

  await mcp.connect(transport);
});

app.post("/messages", auth, express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId || !sseTransports.has(sessionId)) {
      return res.status(400).json({ error: "Unknown or missing sessionId" });
    }

    const transport = sseTransports.get(sessionId);

    // Method names vary by SDK version, so try common ones.
    if (typeof transport.handlePostMessage === "function") {
      return await transport.handlePostMessage(req, res);
    }
    if (typeof transport.handleRequest === "function") {
      return await transport.handleRequest(req, res);
    }
    if (typeof transport.handleMessage === "function") {
      return await transport.handleMessage(req, res);
    }

    return res.status(500).json({
      error:
        "No supported handler on SSE transport instance. Check @modelcontextprotocol/sdk SSE transport API for your version.",
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.stack || e?.message || e) });
  }
});

// ----------------------
// Health
// ----------------------
app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));