// api/mcp.js
// Complete drop-in MCP JSON-RPC endpoint for Vercel.
// Fix: ensures API_BASE always uses /api/v1 so outbound URLs are correct.
//
// Env:
//  - API_BASE (optional) e.g. https://prod-api.amello.plusline.net or https://prod-api.amello.plusline.net/api/v1
//  - AMELLO_API_TOKEN (optional)
//  - API_TIMEOUT_MS (optional, ms)

const DEFAULT_API_BASE = "https://prod-api.amello.plusline.net/api/v1";
const RAW_API_BASE = process.env.API_BASE || DEFAULT_API_BASE;
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

// normalize API base so it ALWAYS ends with "/api/v1" and has no trailing slash beyond that
function normalizeApiBase(raw) {
  if (!raw || typeof raw !== "string") return DEFAULT_API_BASE;
  let s = raw.trim();
  // remove trailing slash(es)
  s = s.replace(/\/+$/, "");
  if (!s.endsWith("/api/v1")) {
    s = s + "/api/v1";
  }
  return s;
}
const API_BASE = normalizeApiBase(RAW_API_BASE);

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
    try {
      req.on?.("data", (c) => chunks.push(Buffer.from(c)));
      req.on?.("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on?.("error", () => resolve(""));
    } catch (e) {
      resolve("");
    }
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
    } catch {
      return { err: "Invalid JSON in req.body" };
    }
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

// apply path parameters for routes like /booking/{id}
function applyPathParams(route, pathParams = {}) {
  return String(route || "").replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(String(pathParams[key] ?? "")));
}

// Fixed callApi: always prepend normalized API_BASE + route (rawPath must start with '/')
async function callApi(method, route, args = {}) {
  const start = Date.now();
  // ensure route starts with '/'
  const rawPath = (typeof route === "string" && route.startsWith("/")) ? route : `/${String(route || "")}`;

  // apply path params first
  const appliedPath = applyPathParams(rawPath, args.pathParams || {});

  // build final URL by concatenating API_BASE + appliedPath
  // API_BASE already normalized to .../api/v1 (no trailing slash)
  const urlString = API_BASE + appliedPath;
  const url = new URL(urlString);

  // append query params
  const q = args.query || {};
  for (const [k, v] of Object.entries(q)) {
    if (v == null) continue;
    url.searchParams.set(k, String(v));
  }

  // headers + body
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...bearerHeaders(),
    ...(args.headers || {})
  };

  const init = { method: String(method || "GET").toUpperCase(), headers };
  if (init.method !== "GET" && init.method !== "HEAD" && args.body !== undefined) {
    try { init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body); }
    catch { init.body = String(args.body); }
  }

  // previews for logs
  const bodyPreview = typeof init.body === "string" ? init.body.slice(0, 2000) : undefined;
  const headersPreview = {};
  for (const k of Object.keys(headers)) headersPreview[k] = String(headers[k]).slice(0, 400);

  console.log("[mcp:debug] OUTBOUND", {
    url: url.toString(),
    method: init.method,
    headers: headersPreview,
    bodyPreview: bodyPreview ? (bodyPreview.length > 1000 ? bodyPreview.slice(0,1000) + "…(truncated)" : bodyPreview) : undefined
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  init.signal = controller.signal;

  try {
    const res = await fetch(url.toString(), init);
    const text = await res.text();
    clearTimeout(timer);

    console.log("[mcp:debug] RESPONSE", {
      url: url.toString(),
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type"),
      bodyPreview: text ? (text.length > 4000 ? text.slice(0,4000) + "…(truncated)" : text) : null
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);

    if ((res.headers.get("content-type") || "").includes("application/json")) {
      try { return text ? JSON.parse(text) : {}; }
      catch (e) { throw new Error("JSON parse error: " + e.message + " RAW:" + (text || "").slice(0,2000)); }
    }
    return text;
  } catch (e) {
    console.error("[mcp:debug] ERROR calling Amello:", e?.stack || e?.message || String(e));
    throw e;
  } finally {
    console.log("[mcp:debug] call duration_ms:", Date.now() - start);
  }
}

// Minimal tool registry
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

// Simple wrappers
function okText(text, data) {
  const blocks = [{ type: "text", text }];
  return data !== undefined ? { content: blocks, structuredContent: data } : { content: blocks };
}
function errText(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Register tools (same set as you requested)
function registerAmelloTools(server) {
  server.registerTool(
    { name: "ping", description: "Health check", inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } }, required: ["ok","message"] } },
    async () => ({ content: [{ type: "text", text: "pong" }], structuredContent: { ok: true, message: "pong" } })
  );

  server.registerTool(
    {
      name: "booking_search",
      description: "GET /booking/search — find booking by bookingReferenceNumber + email + locale",
      inputSchema: { type: "object", required: ["query"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, query: { type: "object", additionalProperties: false, required: ["bookingReferenceNumber","email","locale"], properties: { bookingReferenceNumber: { type: "string" }, email: { type: "string" }, locale: { type: "string", enum: ["de_DE","en_DE"] } } } } },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/booking/search", { headers, query }); return okText("BookingSearch OK", data); }
      catch (e) { return errText(`booking_search failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "booking_cancel",
      description: "POST /booking/cancel — cancel booking with itineraryNumber, bookingNumber, email, locale",
      inputSchema: { type: "object", required: ["body"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, body: { type: "object", additionalProperties: false, required: ["itineraryNumber","bookingNumber","email","locale"], properties: { itineraryNumber: { type: "string" }, bookingNumber: { type: "string" }, email: { type: "string" }, locale: { type: "string", enum: ["de_DE","en_DE"] } } } } },
      outputSchema: { type: "object", properties: { itineraryNumber: { type: "string" }, bookingNumber: { type: "string" }, email: { type: "string" }, status: { type: "string" } } }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/booking/cancel", { headers, body }); return okText("BookingCancel OK", data); }
      catch (e) { return errText(`booking_cancel failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "find_hotels",
      description: "POST /find-hotels — find hotels by destination, dates, currency, roomConfigurations, locale",
      inputSchema: { type: "object", required: ["body"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, body: { type: "object", required: ["destination","departureDate","returnDate","currency","roomConfigurations","locale"], additionalProperties: true } } },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/find-hotels", { headers, body }); const n = Array.isArray(data?.data?.results) ? data.data.results.length : 0; return okText(`FindHotels OK (${n} results)`, data); }
      catch (e) { return errText(`find_hotels failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "currencies_list",
      description: "GET /currencies — list supported currencies (requires locale)",
      inputSchema: { type: "object", required: ["query"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, query: { type: "object", required: ["locale"], additionalProperties: false, properties: { locale: { type: "string", enum: ["de_DE","en_DE"] } } } } },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/currencies", { headers, query }); return okText("Currencies OK", data); }
      catch (e) { return errText(`currencies_list failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "hotels_list",
      description: "GET /hotels — paginated hotel list",
      inputSchema: { type: "object", required: ["query"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, query: { type: "object", required: ["locale"], additionalProperties: false, properties: { locale: { type: "string", enum: ["de_DE","en_DE"] }, page: { type: "integer", minimum: 1 } } } } },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotels", { headers, query }); return okText("Hotels OK", data); }
      catch (e) { return errText(`hotels_list failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "hotel_offers",
      description: "POST /hotel/offer — get hotel offers for multiple rooms",
      inputSchema: { type: "object", required: ["body"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, body: { type: "object", required: ["hotelId","departureDate","returnDate","currency","roomConfigurations","locale"], additionalProperties: true } } },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/hotel/offer", { headers, body }); return okText("HotelOffers OK", data); }
      catch (e) { return errText(`hotel_offers failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "hotel_reference",
      description: "GET /hotel-reference — codes, names, rooms",
      inputSchema: { type: "object", required: ["query"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, query: { type: "object", required: ["locale"], additionalProperties: false, properties: { locale: { type: "string", enum: ["de_DE","en_DE"] } } } } },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotel-reference", { headers, query }); return okText("HotelReference OK", data); }
      catch (e) { return errText(`hotel_reference failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "crapi_hotel_contact",
      description: "GET /crapi/hotel/contact — all hotel contact info",
      inputSchema: { type: "object", required: ["query"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, query: { type: "object", required: ["locale"], additionalProperties: false, properties: { locale: { type: "string", enum: ["de_DE","en_DE"] } } } } },
      outputSchema: { type: "object", properties: { code: { type: "string" }, contact: { type: "object" } } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/crapi/hotel/contact", { headers, query }); return okText("CRAPI HotelContact OK", data); }
      catch (e) { return errText(`crapi_hotel_contact failed: ${e.message || String(e)}`); }
    }
  );

  server.registerTool(
    {
      name: "package_offer",
      description: "POST /offer/package — create a packaged offer",
      inputSchema: { type: "object", required: ["body"], additionalProperties: false, properties: { headers: { type: "object", additionalProperties: true }, body: { type: "object", required: ["hotelId","departureDate","returnDate","currency","roomConfigurations","locale"], additionalProperties: true } } },
      outputSchema: { type: "object", properties: { offerId: { type: "string" } }, required: ["offerId"] }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/offer/package", { headers, body }); return okText("PackageOffer OK", data); }
      catch (e) { return errText(`package_offer failed: ${e.message || String(e)}`); }
    }
  );
}

// Handle single RPC calls (tools/list, tools/call)
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

// Vercel handler
module.exports = async function handler(req, res) {
  try {
    setCors(res);

    if (req.method === "OPTIONS" || req.method === "HEAD") { res.statusCode = 204; return res.end(); }

    if (req.method === "GET") {
      const accept = String(req.headers["accept"] || "");
      if (!accept.includes("text/event-stream")) {
        return sendJson(res, 200, { ok: true, message: "MCP endpoint ready. POST JSON-RPC to this URL." });
      }
      return sendJson(res, 400, rpcError(null, -32601, "SSE sessions not supported in this build"));
    }

    if (req.method !== "POST") return sendJson(res, 405, rpcError(null, -32601, "Method not allowed"));

    const { obj, err, preview } = await getJsonBody(req);
    console.log("[mcp] method=%s path=%s ct=%s accept=%s hasObj=%s err=%s preview=%s",
      req.method, req.url, String(req.headers["content-type"] || ""), String(req.headers["accept"] || ""), !!obj, String(err || ""), String(preview || ""));

    if (err) {
      console.error("[mcp] body parse error:", err);
      return sendJson(res, 400, rpcError(null, -32700, "Invalid JSON"));
    }

    const reqObj = (obj && typeof obj === "object") ? obj : null;
    if (!reqObj || typeof reqObj.method !== "string") {
      console.error("[mcp] invalid rpc payload", obj);
      return sendJson(res, 400, rpcError(null, -32600, "Invalid Request"));
    }

    const server = makeToolRegistry();
    registerAmelloTools(server);

    const result = await handleRpcSingle(reqObj, server.tools);
    return sendJson(res, 200, result);

  } catch (e) {
    console.error("[mcp] top-level crash:", e && e.stack ? e.stack : e);
    return sendJson(res, 500, rpcError(null, -32603, "Internal error", e?.message || String(e)));
  }
};
