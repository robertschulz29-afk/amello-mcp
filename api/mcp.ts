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
  try { /* @ts-ignore */ if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

function isTypedArray(x: any): x is Uint8Array {
  return x && typeof x === "object" && typeof (x as any).byteLength === "number" && typeof (x as any).BYTES_PER_ELEMENT === "number";
}
function stripBOM(s: string) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

async function readStreamUtf8(req: VercelRequest) {
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

/** Normalize body → JSON string (no BOM) → parsed object */
async function getJsonRpcObject(req: VercelRequest): Promise<{ obj?: any; err?: string; preview?: string }> {
  if (req.method !== "POST") return {};
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  // Vercel often gives parsed JSON already
  if (ct.includes("application/json") && req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    try {
      const preview = JSON.stringify(req.body).slice(0, 80);
      return { obj: req.body, preview };
    } catch { /* fall through */ }
  }

  // If we have string/Buffer/Uint8Array, normalize to string then parse
  const body = req.body;
  if (body != null) {
    try {
      let s: string | undefined;
      if (typeof body === "string") s = body;
      else if (Buffer.isBuffer(body)) s = body.toString("utf8");
      else if (isTypedArray(body)) s = Buffer.from(body).toString("utf8");
      if (s != null) {
        s = stripBOM(s);
        const obj = JSON.parse(s);
        return { obj, preview: s.slice(0, 80) };
      }
    } catch { return { err: "Invalid JSON in req.body" }; }
  }

  // Fallback: read the stream
  const fromStream = await readStreamUtf8(req);
  if (fromStream != null) {
    try {
      const s = stripBOM(fromStream);
      const obj = JSON.parse(s);
      return { obj, preview: s.slice(0, 80) };
    } catch {
      return { err: "Invalid JSON in request stream" };
    }
  }

  return { err: "Missing request body" };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  // Preflight / HEAD
  if (req.method === "OPTIONS" || req.method === "HEAD") return res.status(204).end();

  // Friendly GET for browsers
  if (req.method === "GET") {
    const accept = String(req.headers["accept"] || "");
    if (!accept.includes("text/event-stream")) {
      return res.status(200).json({
        ok: true,
        message: "MCP endpoint ready. POST JSON-RPC to this URL, or GET with Accept: text/event-stream for sessions.",
      });
    }
  }

  try {
    const { obj, err, preview } = await getJsonRpcObject(req);

    console.log(
      "[mcp] method=%s path=%s ct=%s accept=%s obj=%s err=%s preview=%s",
      req.method,
      req.url,
      req.headers["content-type"],
      req.headers["accept"],
      obj ? "yes" : "no",
      err || "none",
      preview ?? ""
    );

    if (req.method === "POST" && !obj) {
      // Proper JSON-RPC parse error
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error", data: err || "Invalid request" },
        id: null,
      });
    }

    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator });
    await server.connect(transport);

    // IMPORTANT: Pass the parsed object (not string) to the transport
    await transport.handleRequest(req as any, res as any, obj);
  } catch (e: any) {
    console.error("[mcp] error:", e?.stack || e);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(e?.message || e) },
      id: null,
    });
  }
}
