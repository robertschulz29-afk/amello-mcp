// api/mcp.ts
// Minimal JSON-RPC router for MCP tools on Vercel (SDK transport bypass).
// - Implements: tools/list, tools/call
// - Accepts: single or batch JSON-RPC 2.0 requests
// - Robust body parsing (object/string/Buffer/Uint8Array)
// - No @vercel/node or SDK HTTP transport required

import { registerAmelloTools } from "./_lib/amelloTools.js";

/* -------------------- CORS & helpers -------------------- */
function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
}
const isTypedArray = (x: any): x is Uint8Array =>
  x && typeof x === "object" && typeof (x as any).byteLength === "number" && typeof (x as any).BYTES_PER_ELEMENT === "number";
const stripBOM = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

async function readStreamUtf8(req: any): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  return await new Promise<string | undefined>((resolve) => {
    req.on?.("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on?.("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      resolve(s.length ? s : undefined);
    });
    req.on?.("error", () => resolve(undefined));
  });
}

async function getJsonBody(req: any): Promise<{ obj?: any; err?: string; preview?: string }> {
  if (req.method !== "POST") return {};
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  // 1) If Vercel already parsed JSON into req.body:
  if (ct.includes("application/json") && req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    try {
      return { obj: req.body, preview: JSON.stringify(req.body).slice(0, 120) };
    } catch {
      return { err: "Could not serialize parsed JSON body" };
    }
  }

  // 2) If body is string/buffer/typed array:
  if (req.body != null) {
    try {
      let s: string | undefined;
      if (typeof req.body === "string") s = req.body;
      else if (Buffer.isBuffer(req.body)) s = req.body.toString("utf8");
      else if (isTypedArray(req.body)) s = Buffer.from(req.body).toString("utf8");
      if (s != null) {
        s = stripBOM(s);
        const obj = JSON.parse(s);
        return { obj, preview: s.slice(0, 120) };
      }
    } catch {
      return { err: "Invalid JSON in req.body" };
    }
  }

  // 3) Fallback: read request stream
  const fromStream = await readStreamUtf8(req);
  if (fromStream != null) {
    try {
      const s = stripBOM(fromStream);
      const obj = JSON.parse(s);
      return { obj, preview: s.slice(0, 120) };
    } catch {
      return { err: "Invalid JSON in request stream" };
    }
  }

  return { err: "Missing request body" };
}

/* -------------------- Tool registry shim -------------------- */
type ToolOptions = {
  name: string;
  description?: string;
  inputSchema?: any;
  outputSchema?: any;
};
type ToolHandler = (args: any) => Promise<any> | any;
type ToolEntry = ToolOptions & { handler: ToolHandler };

function captureTools(registerFn: (serverLike: any) => void): ToolEntry[] {
  const tools: ToolEntry[] = [];

  const register = (opts: ToolOptions, handler: ToolHandler) => {
    if (!opts?.name || typeof handler !== "function") throw new Error("registerTool requires {name,...} and a handler(args)=>result");
    tools.push({ ...opts, handler });
  };

  // Expose both styles so your amelloTools.ts works either way
  const serverLike = {
    registerTool: register,
    tool: register, // alias
    onNotification: () => {},
    onRequest: () => {},
  };

  registerFn(serverLike);
  return tools;
}

/* -------------------- JSON-RPC helpers -------------------- */
type JsonRpcReq = { jsonrpc: "2.0"; id?: any; method: string; params?: any };
const isJsonRpcReq = (x: any): x is JsonRpcReq => x && x.jsonrpc === "2.0" && typeof x.method === "string";

const rpcResult = (id: any, result: any) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError  = (id: any, code: number, message: string, data?: any) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });

/* -------------------- Method impls -------------------- */
async function handleRpcSingle(reqObj: JsonRpcReq, tools: ToolEntry[]) {
  const { id, method, params } = reqObj;

  if (method === "tools/list") {
    const list = tools.map(t => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
      outputSchema: t.outputSchema ?? {},
    }));
    return rpcResult(id, { tools: list });
  }

  if (method === "tools/call") {
    const name = params?.name as string;
    const args = params?.arguments ?? params?.args ?? {};
    const tool = tools.find(t => t.name === name);
    if (!tool) return rpcError(id, -32601, `Tool not found: ${name}`);

    try {
      const out = await Promise.resolve(tool.handler(args));
      return rpcResult(id, out);
    } catch (e: any) {
      return rpcError(id, -32603, "Tool execution error", e?.message || String(e));
    }
  }

  return rpcError(id, -32601, `Unknown method: ${method}`);
}

/* -------------------- Handler -------------------- */
export default async function handler(req: any, res: any) {
  setCors(res);

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

  if (req.method !== "POST") {
    return res.status(405).json(rpcError(null, -32601, "Method not allowed"));
  }

  const { obj, err, preview } = await getJsonBody(req);
  console.log(
    "[mcp] method=%s path=%s ct=%s accept=%s hasObj=%s err=%s preview=%s",
    req.method, req.url, req.headers["content-type"], req.headers["accept"],
    obj ? "yes" : "no", err || "none", preview ?? ""
  );

  if (!obj) {
    return res.status(400).json(rpcError(null, -32700, "Parse error", err || "Invalid JSON"));
  }

  // Capture tools (once per invocation)
  let TOOLS: ToolEntry[];
  try {
    TOOLS = captureTools(registerAmelloTools);
  } catch (e: any) {
    console.error("[mcp] tool registration failed:", e?.stack || e);
    return res.status(500).json(rpcError(null, -32603, "Internal error", "Tool registration failed"));
  }

  try {
    // Batch or single
    if (Array.isArray(obj)) {
      const results = await Promise.all(obj.map((it) => {
        if (!isJsonRpcReq(it)) return rpcError(it?.id, -32600, "Invalid Request");
        return handleRpcSingle(it, TOOLS);
      }));
      return res.status(200).json(results);
    } else {
      if (!isJsonRpcReq(obj)) return res.status(400).json(rpcError(obj.id, -32600, "Invalid Request"));
      const result = await handleRpcSingle(obj, TOOLS);
      return res.status(200).json(result);
    }
  } catch (e: any) {
    console.error("[mcp] call failed:", e?.stack || e);
    return res.status(500).json(rpcError(null, -32603, "Internal error", e?.message || String(e)));
  }
}
