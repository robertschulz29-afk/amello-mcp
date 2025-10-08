// CommonJS, single-file MCP JSON-RPC endpoint for Vercel.
// No TypeScript, no build, no external deps.

const DEFAULT_API_BASE = "https://prod-api.amello.plusline.net/api/v1";
const API_BASE = process.env.API_BASE || DEFAULT_API_BASE;
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

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
const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });

function isTypedArray(x) { return x && typeof x === "object" && typeof x.byteLength === "number" && typeof x.BYTES_PER_ELEMENT === "number"; }
function stripBOM(s) { return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

async function readStreamUtf8(req) {
  const chunks = [];
  return await new Promise((resolve) => {
    req.on?.("data", (c) => chunks.push(Buffer.from(c)));
    req.on?.("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on?.("error", () => resolve(""));
  });
}
async function getJsonBody(req) {
  if (req.method !== "POST") return { obj: undefined, preview: undefined, err: undefined };
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  if (ct.includes("application/json") && req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    try { return { obj: req.body, preview: JSON.stringify(req.body).slice(0, 160) }; }
    catch { return { err: "Could not serialize parsed JSON body" }; }
  }

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

  const s = stripBOM(await readStreamUtf8(req));
  if (s) {
    try { const obj = JSON.parse(s); return { obj, preview: s.slice(0, 160) }; }
    catch { return { err: "Invalid JSON in request stream" }; }
  }

  return { err: "Missing request body" };
}

function normalizeReq(x) {
  if (!x || typeof x !== "object") return null;
  if (typeof x.method === "string") return { jsonrpc: "2.0", id: x.id ?? null, method: x.method, params: x.params };
  return null;
}

function bearerHeaders() {
  const t = process.env.AMELLO_API_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}
function applyPathParams(route, pathParams = {}) {
  return route.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(String(pathParams[key])));
}
async function callApi(method, route, args = {}) {
  const url = new URL(applyPathParams(route, args.pathParams || {}), API_BASE);
  const q = args.query || {};
  for (const [k, v] of Object.entries(q)) {
    if (v == null) continue;
    url.searchParams.set(k, String(v));
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...bearerHeaders(),
    ...(args.headers || {})
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const init = { method: String(method || "GET").toUpperCase(), headers, signal: controller.signal };
  if (init.method !== "GET" && init.method !== "HEAD" && args.body !== undefined) {
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  try {
    const res = await fetch(url.toString(), init);
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
    if (ct.includes("application/json")) return text ? JSON.parse(text) : {};
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function makeToolRegistry() {
  const tools = [];
  const register = (opts, handler) => {
    if (!opts || typeof opts.name !== "string" || typeof handler !== "function") {
      throw new Error("registerTool requires {name,...} and a handler(args)=>result");
    }
    tools.push({ ...opts, handler });
  };
  return { tools, registerTool: register, tool: register };
}

function okText(text, data) {
  const blocks = [{ type: "text", text }];
  return data !== undefined ? { content: blocks, structuredContent: data } : { content: blocks };
}
function errText(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function registerAmelloTools(server) {
  server.registerTool(
    {
      name: "ping",
      description: "Health check",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } }, required: ["ok", "message"] }
    },
    async () => ({ content: [{ type: "text", text: "pong" }], structuredContent: { ok: true, message: "pong" } })
  );

  server.registerTool(
    {
      name: "booking_search",
      description: "GET /booking/search",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: {
            type: "object",
            required: ["bookingReferenceNumber", "email", "locale"],
            properties: {
              bookingReferenceNumber: { type: "string" },
              email: { type: "string" },
              locale: { type: "string", enum: ["de_DE", "en_DE"] }
            }
          }
        }
      }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/booking/search", { headers, query }); return okText("BookingSearch OK", data); }
      catch (e) { return errText(`booking_search failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "find_hotels",
      description: "POST /find-hotels",
      inputSchema: {
        type: "object",
        required: ["body"],
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: { type: "object", required: ["destination","departureDate","returnDate","currency","roomConfigurations","locale"] }
        }
      }
    },
    async ({ headers, body }) => {
      try {
        const data = await callApi("POST", "/find-hotels", { headers, body });
        return okText(`FindHotels OK (${(data?.data?.results?.length)||0} results)`, data);
      } catch (e) { return errText(`find_hotels failed: ${e.message || String(e)}`); }
    }
  );

  // Corrected currencies_list tool
  server.registerTool(
    {
      name: "currencies_list",
      description: "GET /currencies — list supported currencies (requires locale)",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: { type: "object", required: ["locale"], properties: { locale: { type: "string", enum: ["de_DE","en_DE"] } } }
        }
      },
      outputSchema: { type: "object" }
    },
    async ({ headers, query }) => {
      try {
        const data = await callApi("GET", "/currencies", {
          headers,
          query: { locale: query.locale }
        });
        return okText("Currencies OK", data.data ?? data);
      } catch (e) {
        return errText(`currencies_list failed: ${e.message || String(e)}`);
      }
    }
  );

  server.registerTool(
    {
      name: "hotels_list",
      description: "GET /hotels — paginated hotel list",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: { type: "object", required: ["locale"], properties: { locale: { type: "string" }, page: { type: "integer" } } }
        }
      }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotels", { headers, query }); return okText("Hotels OK", data); }
      catch (e) { return errText(`hotels_list failed: ${e.message || String(e)}`); }
    }
  );
}

async function handleRpcSingle(reqObj, tools) {
  const { id, method, params } = reqObj;

  if (method === "tools/list") {
    const list = tools.map(t => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || {},
      outputSchema: t.outputSchema || {}
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

module.exports = async function handler(req, res) {
  try {
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
    console.log("[mcp] method=%s path=%s hasObj=%s err=%s preview=%s",
      req.method, req.url, obj ? "yes" : "no", err || "none", preview ?? "");

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

    const registry = makeToolRegistry();
    registerAmelloTools(registry);
    const tools = registry.tools;

    if (requests.length === 1) {
      const result = await handleRpcSingle(requests[0], tools);
      return sendJson(res, 200, result);
    } else {
      const results = await Promise.all(requests.map(r => handleRpcSingle(r, tools)));
      return sendJson(res, 200, results);
    }
  } catch (e) {
    console.error("[mcp] top-level crash:", e?.stack || e);
    return sendJson(res, 500, { error: { code: "500", message: "Top-level handler crash", detail: String(e) } });
  }
};
