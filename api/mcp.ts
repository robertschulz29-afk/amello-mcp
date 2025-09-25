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

function stripBOM(s: string) {
  // Remove UTF-8 BOM if present
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
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

/**
 * Always return a clean JSON string ready for the MCP transport,
 * or an error message describing why we couldn't produce one.
 */
async function getJsonRpcString(req: VercelRequest): Promise<{ json?: string; error?: string }> {
  if (req.method !== "POST") return {};

  const ct = String(req.headers["content-type"] || "").toLowerCase();

  // 1) If Vercel parsed JSON already, stringify it
  if (ct.includes("application/json") && req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    try {
      return { json: JSON.stringify(req.body) };
    } catch {
      return { error: "Could not serialize parsed JSON body" };
    }
  }

  // 2) If we have string/Buffer/Uint8Array in req.body, normalize to string
  if (req.body != null) {
    try {
      let s: string | undefined;
      if (typeof req.body === "string") s = req.body;
      else if (Buffer.isBuffer(req.body)) s = req.body.toString("utf8");
      else if (isTypedArray(req.body)) s = Buffer.from(req.body).toString("utf8");
      if (s != null) return { json: stripBOM(s) };
    } catch {
      /* fallthrough */
    }
  }

  // 3) Fallback: read the stream
  const fromStream = await readStreamUtf8(req);
  if (fromStream != null) return { json: stripBOM(fromStream) };

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
        message: "MCP endpoint ready. POST JSON-RPC to this URL, or GET with Accept: text/event-stream for sessions.",
      });
    }
  }

  try {
    const { json, error } = await getJsonRpcString(req);

    console.log(
      "[mcp] method=%s path=%s ct=%s accept=%s hasJson=%s error=%s preview=%s",
      req.method,
      req.url,
      req.headers["content-type"],
      req.headers["accept"],
      json ? "yes" : "no",
      error || "none",
      json ? JSON.stringify(json.slice(0, 80)) : ""
    );

    // If POST and we couldn't get a JSON string, return a JSON-RPC parse error (400)
    if (req.method === "POST" && !json) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error", data: error || "Invalid request" },
        id: null,
      });
    }

    const server = new McpServer({ name: "amello-remote", version: "1.0.0" });
    registerAmelloTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator });
    await server.connect(transport);

    // IMPORTANT: always pass a string for POST; let transport parse it.
    await transport.handleRequest(req as any, res as any, json);
  } catch (err: any) {
    console.error("[mcp] error:", err?.stack || err);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error", data: String(err?.message || err) },
      id: null,
    });
  }
}
