// api/mcp.js
// Single-file CommonJS MCP endpoint for Vercel.
// Drop into your project at api/mcp.js (replace existing).

const DEFAULT_API_BASE = process.env.API_BASE || "https://prod-api.amello.plusline.net/api/v1";
const API_BASE = DEFAULT_API_BASE;
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

// ---------- helpers ----------
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

/**
 * Robustly obtain JSON body:
 * - Supports frameworks that already set `req.body`
 * - Supports raw incoming stream
 * - Returns { obj, preview, err }
 */
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

  // fallback read stream
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

// ---------- minimal tool registry ----------
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

/** small wrappers for result shape */
function okText(text, data) {
  const blocks = [{ type: "text", text }];
  return data !== undefined ? { content: blocks, structuredContent: data } : { content: blocks };
}
function errText(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Register the Amello tools we want to expose. Keep these minimal but complete. */
function registerAmelloTools(server) {
  // health / ping
  server.registerTool(
    {
      name: "ping",
      description: "Health check",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, message: { type: "string" } }, required: ["ok", "message"] }
    },
    async () => ({ content: [{ type: "text", text: "pong" }], structuredContent: { ok: true, message: "pong" } })
  );

  // booking_search
  server.registerTool(
    {
      name: "booking_search",
      description: "GET /booking/search — find booking by bookingReferenceNumber + email + locale",
      inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/booking/search", { headers, query }); return okText("BookingSearch OK", data); }
      catch (e) { return errText(`booking_search failed: ${e.message || String(e)}`); }
    }
  );

  // booking_cancel
  server.registerTool(
    {
      name: "booking_cancel",
      description: "POST /booking/cancel — cancel booking",
      inputSchema: { type: "object", required: ["body"], properties: { headers: { type: "object" }, body: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { itineraryNumber: { type: "string" }, bookingNumber: { type: "string" }, email: { type: "string" }, status: { type: "string" } } }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/booking/cancel", { headers, body }); return okText("BookingCancel OK", data); }
      catch (e) { return errText(`booking_cancel failed: ${e.message || String(e)}`); }
    }
  );

  // find_hotels
  server.registerTool(
    {
      name: "find_hotels",
      description: "POST /find-hotels — find hotels",
      inputSchema: { type: "object", required: ["body"], properties: { headers: { type: "object" }, body: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, body }) => {
      try {
        const data = await callApi("POST", "/find-hotels", { headers, body });
        const n = Array.isArray(data?.data?.results) ? data.data.results.length : 0;
        return okText(`FindHotels OK (${n} results)`, data);
      } catch (e) { return errText(`find_hotels failed: ${e.message || String(e)}`); }
    }
  );

  // currencies list
  server.registerTool(
    {
      name: "currencies_list",
      description: "GET /currencies — list supported currencies (requires locale)",
      inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/currencies", { headers, query }); return okText("Currencies OK", data); }
      catch (e) { return errText(`currencies_list failed: ${e.message || String(e)}`); }
    }
  );

  // hotels list
  server.registerTool(
    {
      name: "hotels_list",
      description: "GET /hotels — paginated hotel list",
      inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotels", { headers, query }); return okText("Hotels OK", data); }
      catch (e) { return errText(`hotels_list failed: ${e.message || String(e)}`); }
    }
  );

  // hotel_offers
  server.registerTool(
    {
      name: "hotel_offers",
      description: "POST /hotel/offer — get hotel offers for multiple rooms",
      inputSchema: { type: "object", required: ["body"], properties: { headers: { type: "object" }, body: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/hotel/offer", { headers, body }); return okText("HotelOffers OK", data); }
      catch (e) { return errText(`hotel_offers failed: ${e.message || String(e)}`); }
    }
  );

  // hotel_reference
  server.registerTool(
    {
      name: "hotel_reference",
      description: "GET /hotel-reference — codes, names, rooms",
      inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotel-reference", { headers, query }); return okText("HotelReference OK", data); }
      catch (e) { return errText(`hotel_reference failed: ${e.message || String(e)}`); }
    }
  );

  // crapi hotel contact
  server.registerTool(
    {
      name: "crapi_hotel_contact",
      description: "GET /crapi/hotel/contact — all hotel contact info",
      inputSchema: { type: "object", required: ["query"], properties: { headers: { type: "object" }, query: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { code: { type: "string" }, contact: { type: "object" } } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/crapi/hotel/contact", { headers, query }); return okText("CRAPI HotelContact OK", data); }
      catch (e) { return errText(`crapi_hotel_contact failed: ${e.message || String(e)}`); }
    }
  );

  // package offer
  server.registerTool(
    {
      name: "package_offer",
      description: "POST /offer/package — create a packaged offer",
      inputSchema: { type: "object", required: ["body"], properties: { headers: { type: "object" }, body: { type: "object" } }, additionalProperties: false },
      outputSchema: { type: "object", properties: { offerId: { type: "string" } }, required: ["offerId"] }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/offer/package", { headers, body }); return okText("PackageOffer OK", data); }
      catch (e) { return errText(`package_offer failed: ${e.message || String(e)}`); }
    }
  );
}

// ---------- RPC handling ----------
/**
 * Robust extraction of arguments:
 * - Accepts params.arguments, params.args, params (without name), or empty
 * - Ensures tool receives { headers?, query?, pathParams?, body? } when available
 */
function extractToolArgs(params) {
  if (!params) return {};
  // If explicit arguments container present
  if (params.arguments && typeof params.arguments === "object") return params.arguments;
  if (params.args && typeof params.args === "object") return params.args;

  // If params looks like { name: 'tool', ...other props } then use other props
  if (typeof params === "object" && Object.keys(params).length > 0) {
    const copy = {};
    for (const k of Object.keys(params)) {
      if (k === "name" || k === "method") continue;
      copy[k] = params[k];
    }
    // If copy is empty object, maybe params actually *are* the args (no name)
    const keys = Object.keys(copy);
    if (keys.length > 0) return copy;
    // fallback: return params itself (safe)
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
    // name can be in params.name
    const name = params?.name || params?.tool || params?.method;
    if (!name) return rpcError(id, -32602, "Missing tool name in params.name");

    // robust args extraction (see function above)
    const args = extractToolArgs(params);

    const tool = tools.find(t => t.name === name);
    if (!tool) return rpcError(id, -32601, `Tool not found: ${name}`);

    try {
      // call handler; handler may return structured response object already
      const out = await Promise.resolve(tool.handler(args));
      return rpcResult(id, out);
    } catch (e) {
      return rpcError(id, -32603, "Tool execution error", e?.message || String(e));
    }
  }

  return rpcError(id, -32601, `Unknown method: ${method}`);
}

// ---------- top-level handler for Vercel ----------
module.exports = async function handler(req, res) {
  try {
    setCors(res);

    if (req.method === "OPTIONS" || req.method === "HEAD") { res.statusCode = 204; return res.end(); }

    if (req.method === "GET") {
      const accept = String(req.headers["accept"] || "");
      if (!accept.includes("text/event-stream")) {
        return sendJson(res, 200, { ok: true, message: "MCP endpoint ready. POST JSON-RPC to this URL." });
      }
      // SSE sessions not implemented in this single-file; return informative message
      return sendJson(res, 501, { ok: false, message: "SSE sessions not implemented in this endpoint." });
    }

    if (req.method !== "POST") return sendJson(res, 405, rpcError(null, -32601, "Method not allowed"));

    const { obj, err, preview } = await getJsonBody(req);
    console.log("[mcp] method=%s path=%s ct=%s accept=%s hasObj=%s err=%s preview=%s",
      req.method, req.url, req.headers["content-type"], req.headers["accept"], !!obj, err || "none", preview);

    if (err) {
      console.error("[mcp] top-level crash: %s", err);
      return sendJson(res, 500, rpcError(null, -32603, "Invalid JSON"));
    }

    // normalize and accept either single request or batch
    const requests = Array.isArray(obj) ? obj : [obj];

    // create tool registry and register tools
    const server = makeToolRegistry();
    registerAmelloTools(server);

    // for debug: show tools count
    console.log("[mcp] registered tools:", server.tools.map(t => t.name).join(", "));

    const results = [];
    for (const rq of requests) {
      const norm = (rq && typeof rq === "object" && typeof rq.method === "string") ? rq : null;
      if (!norm) {
        results.push(rpcError(null, -32600, "Invalid Request"));
        continue;
      }
      // Deep log of incoming RPC call preview for debugging
      console.log("[mcp] incoming rpc:", JSON.stringify({ id: norm.id, method: norm.method, paramsPreview: JSON.stringify(norm.params || {}).slice(0,160) }));

      // handle single RPC
      const out = await handleRpcSingle(norm, server.tools);
      results.push(out);
    }

    // If single request, return single result
    const responseBody = Array.isArray(obj) ? results : results[0];
    return sendJson(res, 200, responseBody);

  } catch (ex) {
    console.error("[mcp] top-level crash:", ex && ex.stack ? ex.stack : String(ex));
    return sendJson(res, 500, { error: { code: "500", message: "Top-level handler crash", detail: String(ex) } });
  }
};
