// api/mcp.js
// Single-file CommonJS MCP endpoint for Vercel with robust API_BASE normalization.
// Replaces previous file — drop in and redeploy.

const DEFAULT_API_ROOT = "https://prod-api.amello.plusline.net/api/v1";
const DEFAULT_API_PATH = DEFAULT_API_ROOT;
const RAW_API_BASE = DEFAULT_API_ROOT;

function normalizeApiBase(rawBase) {
  // Remove trailing slashes
  let base = rawBase.replace(/\/+$/g, "");
  // If the provided value already contains "/api/v1" anywhere, keep base up to that path
  const idx = base.indexOf(DEFAULT_API_PATH);
  if (idx !== -1) {
    return base.slice(0, idx + DEFAULT_API_PATH.length);
  }
  // Otherwise append the default API path
  return base + DEFAULT_API_PATH;
}
const API_BASE = normalizeApiBase(RAW_API_BASE);
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
const rpcError  = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });

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

function bearerHeaders() {
  const t = process.env.AMELLO_API_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}
function applyPathParams(route, pathParams = {}) {
  return route.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(String(pathParams[key])));
}

async function callApi(method, route, args = {}) {
  // Ensure route begins with a leading slash
  let rawRoute = String(route || "");
  if (!rawRoute.startsWith("/")) rawRoute = "/" + rawRoute;

  // Build URL + query using normalized API_BASE
  const url = new URL(applyPathParams(rawRoute, args.pathParams || {}), API_BASE);
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

  let bodyPreview = undefined;
  if (args.body !== undefined) {
    try { bodyPreview = typeof args.body === "string" ? args.body.slice(0, 1024) : JSON.stringify(args.body).slice(0, 1024); } catch { bodyPreview = "<unable to serialize body>"; }
  }

  console.log("[mcp:debug] OUTBOUND", {
    url: url.toString(),
    method: String(method || "GET").toUpperCase(),
    headers,
    bodyPreview
  });

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

    console.log("[mcp:debug] RESPONSE", {
      url: url.toString(),
      status: res.status,
      statusText: res.statusText,
      contentType: ct,
      bodyPreview: (typeof text === "string" ? text.slice(0, 1024) : String(text)).replace(/\n/g, " ")
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
    if (ct.includes("application/json")) return text ? JSON.parse(text) : {};
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* Minimal registry */
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
function okText(text, data) { const blocks = [{ type: "text", text }]; return data !== undefined ? { content: blocks, structuredContent: data } : { content: blocks }; }
function errText(message) { return { content: [{ type: "text", text: message }], isError: true }; }

function registerAmelloTools(server) {
  // Ping
  server.registerTool(
    { name: "ping", description: "Health check", inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, message: { type: "string" } }, required: ["ok","message"] } },
    async () => ({ content: [{ type: "text", text: "pong" }], structuredContent: { ok: true, message: "pong" } })
  );

  // find_hotels
  server.registerTool(
    { name: "find_hotels", description: "POST /find-hotels", inputSchema: { type: "object", required: ["body"], properties: { headers: { type: "object" }, body: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "object", properties: { data: { type: "object" } } } },
    async ({ headers, body }) => {
      try {
        const data = await callApi("POST", "/find-hotels", { headers, body });
        const n = Array.isArray(data?.data?.results) ? data.data.results.length : 0;
        return okText(`FindHotels OK (${n} results)`, data);
      } catch (e) { return errText(`find_hotels failed: ${e.message || String(e)}`); }
    }
  );

  // currencies_list
  server.registerTool(
    { name: "currencies_list", description: "GET /currencies", inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "array", items: { type: "object" } } },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/currencies", { headers, query }); return okText("Currencies OK", data); }
      catch (e) { return errText(`currencies_list failed: ${e.message || String(e)}`); }
    }
  );

  // booking_search
  server.registerTool(
    { name: "booking_search", description: "GET /booking/search", inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "object", properties: { data: { type: "object" } } } },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/booking/search", { headers, query }); return okText("BookingSearch OK", data); }
      catch (e) { return errText(`booking_search failed: ${e.message || String(e)}`); }
    }
  );

  // booking_cancel
  server.registerTool(
    { name: "booking_cancel", description: "POST /booking/cancel", inputSchema: { type: "object", required: ["body"], properties: { headers: { type: "object" }, body: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "object", properties: { itineraryNumber: { type: "string" }, bookingNumber: { type: "string" }, email: { type: "string" }, status: { type: "string" } } } },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/booking/cancel", { headers, body }); return okText("BookingCancel OK", data); }
      catch (e) { return errText(`booking_cancel failed: ${e.message || String(e)}`); }
    }
  );

  // hotels_list
  server.registerTool(
    { name: "hotels_list", description: "GET /hotels", inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "array", items: { type: "object" } } },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotels", { headers, query }); return okText("Hotels OK", data); }
      catch (e) { return errText(`hotels_list failed: ${e.message || String(e)}`); }
    }
  );

  // hotel_offers
  server.registerTool(
    { name: "hotel_offers", description: "POST /hotel/offer", inputSchema: { type: "object", required: ["body"], properties: { headers: { type: "object" }, body: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "object", properties: { data: { type: "object" } } } },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/hotel/offer", { headers, body }); return okText("HotelOffers OK", data); }
      catch (e) { return errText(`hotel_offers failed: ${e.message || String(e)}`); }
    }
  );

  // hotel_reference
  server.registerTool(
    { name: "hotel_reference", description: "GET /hotel-reference", inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "array", items: { type: "object" } } },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotel-reference", { headers, query }); return okText("HotelReference OK", data); }
      catch (e) { return errText(`hotel_reference failed: ${e.message || String(e)}`); }
    }
  );

  // crapi_hotel_contact
  server.registerTool(
    { name: "crapi_hotel_contact", description: "GET /crapi/hotel/contact", inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "object", properties: { code: { type: "string" }, contact: { type: "object" } } } },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/crapi/hotel/contact", { headers, query }); return okText("CRAPI HotelContact OK", data); }
      catch (e) { return errText(`crapi_hotel_contact failed: ${e.message || String(e)}`); }
    }
  );

  // package_offer
  server.registerTool(
    { name: "package_offer", description: "POST /offer/package", inputSchema: { type: "object", required: ["body"], properties: { headers: { type: "object" }, body: { type: "object" } }, additionalProperties: false }, outputSchema: { type: "object", properties: { offerId: { type: "string" } }, required: ["offerId"] } },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/offer/package", { headers, body }); return okText("PackageOffer OK", data); }
      catch (e) { return errText(`package_offer failed: ${e.message || String(e)}`); }
    }
  );
}

function extractToolArgs(params) {
  if (!params) return {};
  if (params.arguments && typeof params.arguments === "object") return params.arguments;
  if (params.args && typeof params.args === "object") return params.args;

  if (typeof params === "object" && Object.keys(params).length > 0) {
    const copy = {};
    for (const k of Object.keys(params)) {
      if (k === "name" || k === "method") continue;
      copy[k] = params[k];
    }
    if (Object.keys(copy).length > 0) return copy;
    return params;
  }
  return {};
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
    const name = params?.name || params?.tool || params?.method;
    if (!name) return rpcError(id, -32602, "Missing tool name in params.name");

    const args = extractToolArgs(params);

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
      return sendJson(res, 501, { ok: false, message: "SSE not implemented." });
    }

    if (req.method !== "POST") return sendJson(res, 405, rpcError(null, -32601, "Method not allowed"));

    const { obj, err, preview } = await getJsonBody(req);
    console.log("[mcp] method=%s path=%s ct=%s accept=%s hasObj=%s err=%s preview=%s API_BASE=%s", req.method, req.url, req.headers["content-type"], req.headers["accept"], !!obj, err || "none", preview, API_BASE);

    if (err) {
      console.error("[mcp] top-level crash: %s", err);
      return sendJson(res, 500, rpcError(null, -32603, "Invalid JSON"));
    }

    const requests = Array.isArray(obj) ? obj : [obj];

    const server = makeToolRegistry();
    registerAmelloTools(server);

    console.log("[mcp] registered tools:", server.tools.map(t => t.name).join(", "));

    const results = [];
    for (const rq of requests) {
      const norm = (rq && typeof rq === "object" && typeof rq.method === "string") ? rq : null;
      if (!norm) {
        results.push(rpcError(null, -32600, "Invalid Request"));
        continue;
      }
      console.log("[mcp] incoming rpc:", JSON.stringify({ id: norm.id, method: norm.method, paramsPreview: JSON.stringify(norm.params || {}).slice(0,160) }));
      const out = await handleRpcSingle(norm, server.tools);
      results.push(out);
    }

    const responseBody = Array.isArray(obj) ? results : results[0];
    return sendJson(res, 200, responseBody);
  } catch (ex) {
    console.error("[mcp] top-level crash:", ex && ex.stack ? ex.stack : String(ex));
    return sendJson(res, 500, { error: { code: "500", message: "Top-level handler crash", detail: String(ex) } });
  }
};
