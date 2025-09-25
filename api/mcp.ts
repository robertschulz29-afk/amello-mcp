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
  return x && typeof x === "object" && typeof (x as any).byteLength === "number" && typeof (x as any).BYTES_PER_ELEMENT === "number";
}

function bufToUtf8(x: any): string | undefined {
  try {
    if (typeof x === "string") return x;
    if (Buffer.isBuffer(x)) return x.toString("utf8");
    if (isTypedArray(x)) return Buffer.from(x).toString("utf8");
  } catch { /* noop */ }
  return undefined;
}

async function readStream(req: VercelRequest): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  return await new Promise<string | undefined>((resolve) => {
    const r = req as any;
    r.on?.("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    r.on?.("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      resolve(s.length ? s : undefined);
    });
    r.on?.("error", () => resolve(undefined));
    // If the stream was already consumed, we’ll just resolve undefined later.
  });
}

/**
 * Normalize the JSON-RPC payload so the MCP transport always receives either:
 *  - an already-parsed object, or
 *  - a valid JSON string.
 */
async function getJsonRpcPayload(req: VercelRequest): Promise<{ envelope?: any; raw?: string; error?: string }> {
  if (req.method !== "POST") return {};
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  // 1) If Vercel body-parser gave us an object, use it directly.
  if (ct.includes("application/json") && req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    return { envelope: req.body };
  }

  // 2) If we have a string/Buffer, convert to string and parse.
  const fromBody = bufToUtf8(req.body);
  if (fromBody !== undefined) {
    try {
      const env = JSON.parse(fromBody);
      return { envelope: env, raw: fromBody };
    } catch (e: any) {
      return { error: "Invalid JSON", raw: fromBody };
    }
  }

  // 3) Fallback: read the stream (covers cases where body-parser didn't run).
  const fromStream = await readStream(req);
  if (fromStream !== undefined) {
    try {
      const env = JSON.parse(fromStream);
      return { envelope: env, raw: fromStream };
    } catch {
      return { error: "Invalid JSON", raw: fromStream };
    }
  }

  return { error: "Missing request body" };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  // Preflight / HEAD
  if (req.method === "OPTIONS" || req.method === "HEAD") {
    return res.status(204).end();
  }

  // Friendly GET (opening the URL in a browser without event-stream)
  if (req.method === "GET") {
    const accept = String(req.headers["accept"] || "");
    if (!accept.includes("text/event-stream")) {
      return res.status(200).json({
        ok: true,
        message: "MCP endpoint is ready. Use POST with JSON-RPC for calls, or GET with Accept: text/event-stream for sessions."
      });
    }
  }

  try {
    const { envelope, raw, error } = await getJsonRpcPayload(req);

    console.log(
      "[mcp] method=%s path=%s ct=%s accept=%s hasEnvelope=%s hasRaw=%s error=%s",
      req.method,
      req.url,
      req.headers["content-type"],
      req.headers["accept"],
      envelope ? "yes" : "no",
      raw ? "yes" : "no",
      error || "none"
    );

    // If POST and the JSON was invalid/missing, return a proper JSON-RPC parse error (400).
    if (req.method === "POST" && error) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error", data: error },
        id: null
      });
    }

    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator });
    await server.connect(transport);

    // Pass the parsed envelope when available; otherwise pass the raw string for the transport to parse.
    await transport.handleRequest(req as any, res as any, envelope ?? raw);
  } catch (err: any) {
    console.error("[mcp] error:", err?.stack || err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null
    });
  }
}
