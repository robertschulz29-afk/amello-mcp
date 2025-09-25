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

function isTypedArray(x: any): x is Uint8Array {
  return x && typeof x === "object" && typeof (x as any).byteLength === "number"
    && typeof (x as any).BYTES_PER_ELEMENT === "number";
}
function stripBOM(s: string) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
async function readStreamUtf8(req: VercelRequest): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  return await new Promise<string | undefined>((resolve) => {
    const r = req as any;
    r.on?.("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    r.on?.("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      resolve(s.length ? s : undefined);
    });
    r.on?.("error", () => resolve(undefined));
  });
}

/** Parse and validate a JSON-RPC 2.0 envelope as an OBJECT. */
async function getJsonRpcEnvelope(req: VercelRequest): Promise<{ env?: any; error?: { code: number; message: string; data?: string } }> {
  if (req.method !== "POST") return {};

  const ct = String(req.headers["content-type"] || "").toLowerCase();

  let raw: string | undefined;
  let parsed: any;

  // 1) If Vercel parsed JSON already, use it
  if (ct.includes("application/json") && req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    parsed = req.body;
  } else {
    // 2) Normalize req.body to string if present
    if (typeof req.body === "string") raw = req.body;
    else if (Buffer.isBuffer(req.body)) raw = req.body.toString("utf8");
    else if (isTypedArray(req.body)) raw = Buffer.from(req.body).toString("utf8");

    // 3) Fallback: read stream
    if (raw == null) raw = await readStreamUtf8(req);

    if (!raw) {
      return { error: { code: -32700, message: "Parse error", data: "Missing request body" } };
    }
    try {
      parsed = JSON.parse(stripBOM(raw));
    } catch {
      return { error: { code: -32700, message: "Parse error", data: "Invalid JSON" } };
    }
  }

  // Minimal JSON-RPC 2.0 validation (shape-only; transport will do deeper checks)
  if (!parsed || typeof parsed !== "object" || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    return { error: { code: -32600, message: "Invalid Request", data: "Not a JSON-RPC 2.0 object with method" } };
  }
  return { env: parsed };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  if (req.method === "OPTIONS" || req.method === "HEAD") {
    return res.status(204).end();
  }

  // If you open the URL in a browser tab (no event-stream Accept), return a friendly JSON.
  if (req.method === "GET") {
    const accept = String(req.headers["accept"] || "");
    if (!accept.includes("text/event-stream")) {
      return res.status(200).json({
        ok: true,
        message: "MCP endpoint ready. POST JSON-RPC envelopes here, or GET with Accept: text/event-stream to establish a session.",
      });
    }
  }

  try {
    const { env, error } = await getJsonRpcEnvelope(req);

    console.log(
      "[mcp] method=%s path=%s ct=%s accept=%s env=%s error=%s",
      req.method,
      req.url,
      req.headers["content-type"],
      req.headers["accept"],
      env ? "yes" : "no",
      error ? `${error.code}:${error.message}` : "none"
    );

    if (req.method === "POST" && error) {
      // Return proper JSON-RPC error envelope (400) for client-side parse/shape problems
      return res.status(400).json({ jsonrpc: "2.0", error, id: null });
    }

    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator });
    await server.connect(transport);

    // CRITICAL: pass a validated OBJECT, not a string/buffer.
    await transport.handleRequest(req as any, res as any, env);
  } catch (err: any) {
    console.error("[mcp] error:", err?.stack || err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null,
    });
  }
}
