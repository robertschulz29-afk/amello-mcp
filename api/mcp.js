// api/mcp.js
// Minimal JSON-RPC router for MCP tools on Vercel (no SDK transport).
// Implements: tools/list, tools/call. Always returns JSON bodies.

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
}
function sendJson(res, status, obj) {
  const str = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(str).toString());
  res.end(str);
}
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError  = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });

function isTypedArray(x) {
  return x && typeof x === "object" && typeof x.byteLength === "number" && typeof x.BYTES_PER_ELEMENT === "number";
}
function stripBOM(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

async function readStreamUtf8(req) {
  const chunks = [];
  return await new Promise((resolve) => {
    req.on?.("data", (c) => chunks.push(Buffer.from(c)));
    req.on?.("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      resolve(s.length ? s : undefined);
    });
    req.on?.("error", () => resolve(undefined));
  });
}

async function getJsonBody(req) {
  if (req.method !== "POST") return {};
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  // already-parsed JSON
  if (ct.includes("application/json") && req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    try { return { obj: req.body, preview: JSON.stringify(req.body).slice(0, 160) }; }
    catch { return { err: "Could not serialize parsed JSON body" }; }
  }

  // string/buffer/typed array
  if (req.body != null) {
    try {
      let s;
      if (typeof req.body === "string") s = req.body;
      else if (Buffer.isBuffer(req.body)) s = req.body.toString("utf8");
      else if (isTypedArray(req.body)) s = Buffer.from(req.body).toString("utf8");
      if (s != null) {
        s = stripBOM(s);
        const obj = JSON.parse(s);
        return { obj, preview: s.slice(0, 160) };
      }
    } catch { return { err: "Invalid JSON in req.body" }; }
  }

  // stream fallback
  const fromStream = await readStreamUtf8(req);
  if (fromStream != null) {
    try {
      const s = stripBOM(fromStream);
      const obj = JSON.parse(s);
      return { obj, preview: s.slice(0, 160) };
    } catch { return { err: "Invalid JSON in request stream" }; }
  }

  return { err: "Missing request body" };
}

function normalizeReq(x) {
  if (!x || typeof x !== "object") return null;
  if (typeof x.method === "string") return { jsonrpc: "2.0", id: x.id ?? null, method: x.method, params: x.params };
  return null;
}

function captureTools(registerFn) {
  const tools = [];
  const register = (opts, handler) => {
    if (!opts || typeof opts.name !== "string" || typeof handler !== "function") {
      throw new Error("registerTool requires {name,...} and a handler(args)=>result");
    }
    tools.push({ ...opts, handler });
  };
  const serverLike = { registerTool: register, tool: register, onNotification: () => {}, onRequest: () => {} };
  registerFn(serverLike);
  return tools;
}

async function handleRpcSingle(reqObj, tools) {
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
    const name = params?.name;
    const args = (params && (params.arguments ?? params.args)) || {};
    const tool = tools.find(t => t.name === name);
    if (!tool) return rpcError(id, -32601, `Tool not found: ${name}`);
    try {
      const out = await Promise.resolve(tool.handler(args));
      return rpcResult(id, out);
    } catch (e) {
      return rpcError(id, -32603, "Tool execution error", e?.message || String(e));
    }
  }

  return rpcError(id, -32601, `Unknown method: ${method}`);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS" || req.method === "HEAD") { res.statusCode = 204; return res.end(); }

  if (req.method === "GET") {
    const accept = String(req.headers["accept"] || "");
    if (!accept.includes("text/event-stream")) {
      return sendJson(res, 200, { ok: true, message: "MCP endpoint ready. POST JSON-RPC to this URL." });
    }
  }

  if (req.method !== "POST") return sendJson(res, 405, rpcError(null, -32601, "Method not allowed"));

  const { obj, err, preview } = await getJsonBody(req);
  console.log("[mcp] method=%s path=%s ct=%s accept=%s hasObj=%s err=%s preview=%s",
    req.method, req.url, req.headers["content-type"], req.headers["accept"],
    obj ? "yes" : "no", err || "none", preview ?? "");

  if (!obj) return sendJson(res, 400, rpcError(null, -32700, "Parse error", err || "Invalid JSON"));

  let requests = [];
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const norm = normalizeReq(it);
      if (!norm) return sendJson(res, 400, rpcError(it?.id ?? null, -32600, "Invalid Request"));
      requests.push(norm);
    }
  } else {
    const norm = normalizeReq(obj);
    if (!norm) return sendJson(res, 400, rpcError(obj?.id ?? null, -32600, "Invalid Request"));
    requests = [norm];
  }

  // dynamic import to avoid cold-start crashes
  let TOOLS;
  try {
    const mod = await import("./_lib/amelloTools.js");
    const registerAmelloTools = mod.registerAmelloTools;
    if (typeof registerAmelloTools !== "function") {
      return sendJson(res, 500, rpcError(null, -32603, "Internal error", "registerAmelloTools not exported as a function"));
    }
    TOOLS = captureTools(registerAmelloTools);
  } catch (e) {
    console.error("[mcp] amelloTools import failed:", e?.stack || e);
    return sendJson(res, 500, rpcError(null, -32603, "Internal error", `amelloTools import failed: ${e?.message || String(e)}`));
  }

  try {
    if (requests.length === 1) {
      const result = await handleRpcSingle(requests[0], TOOLS);
      return sendJson(res, 200, result);
    } else {
      const results = await Promise.all(requests.map(r => handleRpcSingle(r, TOOLS)));
      return sendJson(res, 200, results);
    }
  } catch (e) {
    console.error("[mcp] call failed:", e?.stack || e);
    return sendJson(res, 500, rpcError(null, -32603, "Internal error", e?.message || String(e)));
  }
}
