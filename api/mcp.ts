import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAmelloTools } from "../src/amelloTools.js";

function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  // Always answer preflight
  if (req.method === "OPTIONS") return res.status(204).end();
  // Some platforms HEAD a route before POST/GET; don’t 405 that
  if (req.method === "HEAD") return res.status(204).end();

  try {
    // Basic visibility in Vercel logs
    console.log("[mcp] method=%s accept=%s", req.method, req.headers["accept"]);

    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport);

    // Delegate to transport (supports POST for JSON-RPC; GET/DELETE for streams/sessions)
    await transport.handleRequest(req as any, res as any, req.body);
  } catch (err: any) {
    console.error("[mcp] error:", err?.stack || err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null,
    });
  }
}
