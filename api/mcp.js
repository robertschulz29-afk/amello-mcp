// api/mcp.js
// Full drop-in MCP JSON-RPC endpoint (CommonJS) for Vercel.
// Overwrites previous /api/mcp handler: robust, logs outbound calls, registers tools.
//
// Usage: POST JSON-RPC (tools/list or tools/call) to /api/mcp
// GET /api/mcp -> readiness / manifest (tools list)

const API_BASE = process.env.API_BASE || "https://prod-api.amello.plusline.net/api/v1";
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
}

function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(s).toString());
  res.end(s);
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
  // returns { obj, preview, err }
  if (req.method !== "POST") return { obj: undefined };

  // If body already parsed by platform (Vercel may do it)
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    try { return { obj: req.body, preview: JSON.stringify(req.body).slice(0,160) }; }
    catch { return { err: "Could not stringify parsed body" }; }
  }

  // If body present as Buffer/TypedArray/string on req.body
  if (req.body != null) {
    try {
      let s;
      if (typeof req.body === "string") s = req.body;
      else if (Buffer.isBuffer(req.body)) s = req.body.toString("utf8");
      else if (isTypedArray(req.body)) s = Buffer.from(req.body).toString("utf8");
      if (s != null) {
        s = stripBOM(s);
        return { obj: JSON.parse(s), preview: s.slice(0,160) };
      }
    } catch (e) {
      return { err: "Invalid JSON in req.body" };
    }
  }

  // Stream fallback
  try {
    const s = stripBOM(await readStreamUtf8(req));
    if (!s) return { err: "Missing request body" };
    return { obj: JSON.parse(s), preview: s.slice(0,160) };
  } catch {
    return { err: "Invalid JSON in request stream" };
  }
}

function normalizeReq(x) {
  if (!x || typeof x !== "object") return null;
  if (typeof x.method === "string") {
    return { jsonrpc: "2.0", id: x.id ?? null, method: x.method, params: x.params };
  }
  return null;
}

// Build absolute URL from route while preserving API_BASE pathname.
// This avoids new URL(...) surprises. API_BASE may include /api/v1.
function buildUrl(route) {
  // Normalize route -> must start with '/': if user passed "find-hotels" convert to "/find-hotels"
  const routePath = route?.startsWith("/") ? route : `/${route || ""}`;

  try {
    const parsed = new URL(API_BASE);
    const origin = parsed.origin; // protocol + host
    const basePath = parsed.pathname.replace(/\/$/, ""); // strip trailing slash
    return origin + basePath + routePath;
  } catch (e) {
    // Fallback: simple join
    return (API_BASE.replace(/\/$/, "") + routePath);
  }
}

function bearerHeaders() {
  const t = process.env.AMELLO_API_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function callApi(method, route, args = {}) {
  // route: e.g. "/find-hotels" or "find-hotels" or "/booking/cancel" or "/currencies"
  const url = buildUrl(route);
  const query = args.query || {};
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...bearerHeaders(),
    ...(args.headers || {})
  };

  // attach query params
  const urlObj = new URL(url);
  Object.entries(query).forEach(([k,v]) => {
    if (v === undefined || v === null) return;
    urlObj.searchParams.set(k, String(v));
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const init = { method: String(method || "GET").toUpperCase(), headers, signal: controller.signal };
  if (init.method !== "GET" && init.method !== "HEAD" && args.body !== undefined) {
    init.body = (typeof args.body === "string") ? args.body : JSON.stringify(args.body);
  }

  console.log("[mcp:debug] OUTBOUND", {
    url: urlObj.toString(),
    method: init.method,
    headers: Object.keys(headers).length ? headers : undefined,
    bodyPreview: init.body ? (typeof init.body === "string" ? init.body.slice(0,1000) : String(init.body)) : undefined
  });

  try {
    const res = await fetch(urlObj.toString(), init);
    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();

    console.log("[mcp:debug] RESPONSE", {
      url: urlObj.toString(),
      status: res.status,
      statusText: res.statusText,
      contentType,
      bodyPreview: text ? (text.length > 1000 ? text.slice(0,1000) + "…(truncated)" : text) : undefined
    });

    if (!res.ok) {
      // throw error with server body for debugging
      throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
    }

    if (contentType.includes("application/json")) {
      try { return text ? JSON.parse(text) : {}; }
      catch (e) { return text; }
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------- tool registry helpers -------------------- */
function makeRegistry() {
  const tools = [];
  const register = (meta, handler) => {
    if (!meta || typeof meta.name !== "string" || typeof handler !== "function") {
      throw new Error("registerTool requires (meta {name}) and handler(fn)");
    }
    // basic default schemas to help the model
    meta.inputSchema = meta.inputSchema ?? { type: "object", properties: {}, additionalProperties: true };
    meta.outputSchema = meta.outputSchema ?? { type: "object", properties: {}, additionalProperties: true };
    tools.push({ ...meta, handler });
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

/* -------------------- register the Amello tools -------------------- */
const registry = makeRegistry();
const server = registry; // alias

// ping
server.registerTool(
  {
    name: "ping",
    description: "Health check: returns pong",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } }, required: ["ok","message"] }
  },
  async () => okText("pong", { ok: true, message: "pong" })
);

// booking_search (GET /booking/search)
server.registerTool(
  {
    name: "booking_search",
    description: "GET /booking/search — bookingReferenceNumber + email + locale",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        headers: { type: "object", additionalProperties: true },
        query: {
          type: "object",
          required: ["bookingReferenceNumber","email","locale"],
          additionalProperties: false,
          properties: {
            bookingReferenceNumber: { type: "string", description: "Itinerary/booking reference" },
            email: { type: "string" },
            locale: { type: "string", enum: ["de_DE","en_DE"] }
          }
        }
      }
    },
    outputSchema: {
      type: "object",
      properties: { data: { type: "object" } }
    }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const query = args?.query ?? {};
      const data = await callApi("GET", "/booking/search", { headers, query });
      return okText("BookingSearch OK", data);
    } catch (e) { return errText(`booking_search failed: ${e.message || String(e)}`); }
  }
);

// booking_cancel (POST /booking/cancel)
server.registerTool(
  {
    name: "booking_cancel",
    description: "POST /booking/cancel — cancel booking",
    inputSchema: {
      type: "object",
      required: ["body"],
      additionalProperties: false,
      properties: {
        headers: { type: "object", additionalProperties: true },
        body: {
          type: "object",
          required: ["itineraryNumber","bookingNumber","email","locale"],
          properties: {
            itineraryNumber: { type: "string" },
            bookingNumber: { type: "string" },
            email: { type: "string" },
            locale: { type: "string", enum: ["de_DE","en_DE"] }
          }
        }
      }
    },
    outputSchema: {
      type: "object",
      properties: { itineraryNumber:{type:"string"}, bookingNumber:{type:"string"}, email:{type:"string"}, status:{type:"string"} }
    }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const body = args?.body ?? {};
      const data = await callApi("POST", "/booking/cancel", { headers, body });
      return okText("BookingCancel OK", data);
    } catch (e) { return errText(`booking_cancel failed: ${e.message || String(e)}`); }
  }
);

// find_hotels (POST /find-hotels)
server.registerTool(
  {
    name: "find_hotels",
    description: "POST /find-hotels — find hotels by destination/dates/locale",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        headers: { type: "object", additionalProperties: true },
        body: { type: "object", additionalProperties: true }
      }
    },
    outputSchema: { type: "object", properties: { data: { type: "object" } } }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const body = args?.body ?? {};
      const data = await callApi("POST", "/find-hotels", { headers, body });
      return okText(`FindHotels OK`, data);
    } catch (e) { return errText(`find_hotels failed: ${e.message || String(e)}`); }
  }
);

// currencies_list (GET /currencies?locale=...)
server.registerTool(
  {
    name: "currencies_list",
    description: "GET /currencies — list currencies for locale",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "object", required: ["locale"], properties: { locale: { type: "string" } } } }
    },
    outputSchema: { type: "array", items: { type: "object" } }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const query = args?.query ?? {};
      const data = await callApi("GET", "/currencies", { headers, query });
      return okText("Currencies OK", data);
    } catch (e) { return errText(`currencies_list failed: ${e.message || String(e)}`); }
  }
);

// hotels_list (GET /hotels?locale=...&page=...)
server.registerTool(
  {
    name: "hotels_list",
    description: "GET /hotels — paginated hotel list (locale required)",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "object", required: ["locale"], properties: { locale: { type: "string" }, page: { type: "integer" } } }
      }
    },
    outputSchema: { type: "array", items: { type: "object" } }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const query = args?.query ?? {};
      const data = await callApi("GET", "/hotels", { headers, query });
      return okText("Hotels OK", data);
    } catch (e) { return errText(`hotels_list failed: ${e.message || String(e)}`); }
  }
);

// hotel_offers (POST /hotel/offer)
server.registerTool(
  {
    name: "hotel_offers",
    description: "POST /hotel/offer — get hotel offers for multiple rooms",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: { body: { type: "object", additionalProperties: true } }
    },
    outputSchema: { type: "object", properties: { data: { type: "object" } } }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const body = args?.body ?? {};
      const data = await callApi("POST", "/hotel/offer", { headers, body });
      return okText("HotelOffers OK", data);
    } catch (e) { return errText(`hotel_offers failed: ${e.message || String(e)}`); }
  }
);

// hotel_reference (GET /hotel-reference?locale=...)
server.registerTool(
  {
    name: "hotel_reference",
    description: "GET /hotel-reference — hotel codes, names, rooms",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "object", required: ["locale"], properties: { locale: { type: "string" } } } } },
    outputSchema: { type: "array", items: { type: "object" } }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const query = args?.query ?? {};
      const data = await callApi("GET", "/hotel-reference", { headers, query });
      return okText("HotelReference OK", data);
    } catch (e) { return errText(`hotel_reference failed: ${e.message || String(e)}`); }
  }
);

// crapi_hotel_contact (GET /crapi/hotel/contact?locale=...)
server.registerTool(
  {
    name: "crapi_hotel_contact",
    description: "GET /crapi/hotel/contact — all hotel contact info",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "object", required: ["locale"], properties: { locale: { type: "string" } } } } },
    outputSchema: { type: "object", properties: { code: { type: "string" }, contact: { type: "object" } } }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const query = args?.query ?? {};
      const data = await callApi("GET", "/crapi/hotel/contact", { headers, query });
      return okText("CRAPI HotelContact OK", data);
    } catch (e) { return errText(`crapi_hotel_contact failed: ${e.message || String(e)}`); }
  }
);

// package_offer (POST /offer/package)
server.registerTool(
  {
    name: "package_offer",
    description: "POST /offer/package — create packaged offer",
    inputSchema: { type: "object", required: ["body"], properties: { body: { type: "object", additionalProperties: true } } },
    outputSchema: { type: "object", properties: { offerId: { type: "string" } } }
  },
  async (args) => {
    try {
      const headers = args?.headers ?? {};
      const body = args?.body ?? {};
      const data = await callApi("POST", "/offer/package", { headers, body });
      return okText("PackageOffer OK", data);
    } catch (e) { return errText(`package_offer failed: ${e.message || String(e)}`); }
  }
);

/* -------------------- RPC handling -------------------- */
async function handleRpcSingle(reqObj) {
  const { id, method, params } = reqObj;
  if (method === "tools/list") {
    const list = server.tools.map(t => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || {},
      outputSchema: t.outputSchema || {}
    }));
    return rpcResult(id, { tools: list });
  }

  if (method === "tools/call") {
    // params may contain { name, arguments } or { name, args }
    const name = params?.name;
    const args = params?.arguments ?? params?.args ?? {};
    if (!name) return rpcError(id, -32602, "Missing tool name in params");

    const tool = server.tools.find(t => t.name === name);
    if (!tool) return rpcError(id, -32601, `Tool not found: ${name}`);

    try {
      // call handler with the raw args object so each tool can use query/body/headers/pathParams
      const out = await Promise.resolve(tool.handler(args));
      // if handler returned an MCP-style object (content / structuredContent) return it as result
      return rpcResult(id, out);
    } catch (e) {
      console.error("[mcp] tool execution error:", e);
      return rpcError(id, -32603, "Tool execution error", e?.message || String(e));
    }
  }

  return rpcError(id, -32601, `Unknown method: ${method}`);
}

/* -------------------- Vercel-compatible handler (CommonJS) -------------------- */
module.exports = async function handler(req, res) {
  try {
    setCors(res);

    if (req.method === "OPTIONS" || req.method === "HEAD") { res.statusCode = 204; return res.end(); }

    if (req.method === "GET") {
      // readiness + manifest-like minimal info
      return sendJson(res, 200, { ok: true, message: "MCP endpoint ready. POST JSON-RPC to this URL, or GET with Accept: text/event-stream for sessions.", tools: server.tools.map(t => ({ name: t.name, description: t.description })) });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, rpcError(null, -32601, "Method not allowed"));
    }

    const { obj, err, preview } = await getJsonBody(req);
    console.log("[mcp] method=%s path=%s ct=%s accept=%s hasObj=%s err=%s preview=%s",
      req.method, req.url, String(req.headers["content-type"]||""), String(req.headers["accept"]||""), !!obj, err ? err : "none", preview ?? "n/a");

    if (err) {
      // return invalid request
      return sendJson(res, 400, rpcError(null, -32700, "Parse error", err));
    }

    const normalized = normalizeReq(obj);
    if (!normalized) {
      return sendJson(res, 400, rpcError(null, -32600, "Invalid Request"));
    }

    const out = await handleRpcSingle(normalized);
    // always return 200 with JSON-RPC envelope (MCP expectation)
    return sendJson(res, 200, out);
  } catch (topErr) {
    console.error("[mcp] top-level crash:", topErr);
    // JSON-RPC internal error
    return sendJson(res, 500, rpcError(null, -32603, "Internal error", topErr?.message || String(topErr)));
  }
};
