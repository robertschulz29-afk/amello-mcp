import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAmelloTools } from "./_lib/amelloTools.js";

function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
}

const sessionIdGenerator = () => {
  try {
    // @ts-ignore
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

// Robustly obtain a raw JSON body string for POST
async function getRawBody(req: VercelRequest): Promise<string | undefined> {
  if (req.method !== "POST") return undefined;

  // Vercel often gives parsed JSON at req.body
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") {
    try { return JSON.stringify(req.body); } catch { /* fall through */ }
  }

  // Fallback: read the stream (in case bodyParser didn't run)
  const chunks: Buffer[] = [];
  return await new Promise<string | undefined>((resolve) => {
    (req as any).on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    (req as any).on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      resolve(s.length ? s : undefined);
    });
    (req as any).on("error", () => resolve(undefined));
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  if (req.method === "OPTIONS" || req.method === "HEAD") {
    res.status(204).end();
    return;
  }

  try {
    const rawBody = await getRawBody(req);
    console.log("[mcp] method=%s path=%s accept=%s bodyLen=%s",
      req.method, req.url, req.headers["accept"], rawBody?.length ?? 0);

    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    // Pass options so constructor doesn't read from undefined
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator });
    await server.connect(transport);

    // IMPORTANT: pass the raw body so the transport sees the JSON-RPC envelope
    await transport.handleRequest(req as any, res as any, rawBody);
  } catch (err: any) {
    console.error("[mcp] error:", err?.stack || err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null,
    });
  }
}
