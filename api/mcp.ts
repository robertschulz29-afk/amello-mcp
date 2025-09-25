import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAmelloTools } from "../src/amelloTools";


function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
}

// robust session id generator (SDK asks for options; we supply one)
const sessionIdGenerator = () => {
  try {
    // Node 20+ has crypto.randomUUID on globalThis.crypto
    // @ts-ignore
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  // fallback
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  if (req.method === "OPTIONS" || req.method === "HEAD") {
    res.status(204).end();
    return;
  }

  try {
    console.log("[mcp] method=%s path=%s accept=%s", req.method, req.url, req.headers["accept"]);

    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    // IMPORTANT: pass an options object so constructor doesn’t read props on undefined
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator, // optional but silences the undefined access in the SDK
      // you can add other opts here later if needed
    });

    await server.connect(transport);

    // Let transport parse the request; don’t pass req.body explicitly
    await transport.handleRequest(req as any, res as any);
  } catch (err: any) {
    console.error("[mcp] error:", err?.stack || err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null,
    });
  }
}
