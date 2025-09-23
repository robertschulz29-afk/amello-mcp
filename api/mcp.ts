import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAmelloTools } from "../src/amelloTools.js";

/** Loosen CORS so browser-based clients (Inspector, your web console) can call it. */
function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  // IMPORTANT: allow GET/DELETE as well; clients use them for sessions/streams
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  // Always answer preflight
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    // Create a fresh server each request (stateless-friendly for serverless)
    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    // Streamable HTTP transport understands GET (event stream), POST (RPC), DELETE (close)
    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport);

    // Delegate the raw Node request/response to the transport.
    // For POST, Vercel has already parsed JSON into req.body; for GET/DELETE it will be undefined.
    await transport.handleRequest(req as any, res as any, req.body);
  } catch (err: any) {
    // Return a JSON-RPC error envelope so clients surface a useful message
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null
    });
  }
}
