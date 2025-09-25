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

/** Read the request body as either an already-parsed object (Vercel) or a raw string (fallback). */
async function getJsonRpcPayload(req: VercelRequest): Promise<any> {
  if (req.method !== "POST") return undefined;

  const ct = String(req.headers["content-type"] || "").toLowerCase();

  // Vercel usually parses JSON automatically
  if (ct.includes("application/json") && req.body != null) {
    // If it's already an object, pass the object (let transport stringify/validate)
    if (typeof req.body === "object") return req.body;
    // If it's already a JSON string, pass string
    if (typeof req.body === "string") return req.body;
  }

  // Fallback: read raw bytes and return string
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

  // Nice UX for opening the endpoint in a browser (no event-stream Accept)
  if (req.method === "GET") {
    const accept = String(req.headers["accept"] || "");
    if (!accept.includes("text/event-stream")) {
      return res.status(200).json({
        ok: true,
        message:
          "MCP endpoint ready. Use POST with JSON-RPC for requests, or GET with Accept: text/event-stream for sessions.",
      });
    }
  }

  try {
    const payload = await getJsonRpcPayload(req);

    console.log(
      "[mcp] method=%s path=%s ct=%s accept=%s hasBody=%s",
      req.method,
      req.url,
      req.headers["content-type"],
      req.headers["accept"],
      payload != null
    );

    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator });
    await server.connect(transport);

    // IMPORTANT: pass the payload (object or string). If undefined, the transport will handle non-POSTs.
    await transport.handleRequest(req as any, res as any, payload);
  } catch (err: any) {
    console.error("[mcp] error:", err?.stack || err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null,
    });
  }
}
