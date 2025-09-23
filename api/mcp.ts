import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAmelloTools } from "../src/amelloTools.js";

function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (use POST)." },
      id: null
    });
  }
  try {
    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);
    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);
  } catch (err: any) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null
    });
  }
}
