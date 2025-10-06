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
const rpcError  = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });

function stripBOM(s) { return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
async function readStreamUtf8(req) {
  const chunks = [];
  return await new Promise((resolve) => {
    req.on?.("data", (c) => chunks.push(Buffer.from(c)));
    req.on?.("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on?.("error", () => resolve(""));
  });
}
/** IMPORTANT: never touch req.body on Vercel—use stream only. */
async function getJsonBody(req) {
  if (req.method !== "POST") return { obj: undefined, preview: undefined, err: undefined };
  let raw = "";
  try { raw = stripBOM(await readStreamUtf8(req)); } catch { return { err: "Body read error" }; }
  if (!raw) return { err: "Missing request body" };
  try { const obj = JSON.parse(raw); return { obj, preview: raw.slice(0, 160) }; }
  catch { return { err: "Invalid JSON" }; }
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
  for (const [k, v] of Object.entries(q)) if (v != null) url.searchParams.set(k, String(v));

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

/** Minimal registry */
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

/** Output helpers */
const okText  = (text, data) => (data !== undefined
  ? { content: [{ type: "text", text }], structuredContent: data }
  : { content: [{ type: "text", text }] });
const errText = (message) => ({ content: [{ type: "text", text: message }], isError: true });

/** Register Amello tools (NO OpenAPI dependency). */
function registerAmelloTools(server) {
  // Health
  server.registerTool(
    {
      name: "ping",
      description: "Health check",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: { type: "object", additionalProperties: false,
        properties: { ok: { type: "boolean" }, message: { type: "string" } },
        required: ["ok","message"]
      }
    },
    async () => ({ content: [{ type: "text", text: "pong" }], structuredContent: { ok: true, message: "pong" } })
  );

  // Booking search (GET /booking/search)
  server.registerTool(
    {
      name: "booking_search",
      description: "GET /booking/search — Find booking by bookingReferenceNumber + email + locale.",
      inputSchema: {
        type: "object", required: ["query"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: { type: "object", additionalProperties: false, required: ["bookingReferenceNumber","email","locale"],
            properties: {
              bookingReferenceNumber: { type: "string", description: "Itinerary/booking reference, e.g. 45666CK000940" },
              email: { type: "string", description: "Booking contact email" },
              locale: { type: "string", enum: ["de_DE","en_DE"], description: "ISO-639 + ISO-3166, underscore-separated" }
            }
          }
        }
      },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/booking/search", { headers, query }); return okText("BookingSearch OK", data); }
      catch (e) { return errText(`booking_search failed: ${e.message || String(e)}`); }
    }
  );

  // Booking cancel (POST /booking/cancel)
  server.registerTool(
    {
      name: "booking_cancel",
      description: "POST /booking/cancel — Cancel booking by itineraryNumber + bookingNumber + email + locale.",
      inputSchema: {
        type: "object", required: ["body"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: { type: "object", additionalProperties: false, required: ["itineraryNumber","bookingNumber","email","locale"],
            properties: {
              itineraryNumber: { type: "string" },
              bookingNumber:   { type: "string" },
              email:           { type: "string" },
              locale:          { type: "string", enum: ["de_DE","en_DE"] }
            }
          }
        }
      },
      outputSchema: { type: "object",
        properties: {
          itineraryNumber: { type: "string" },
          bookingNumber: { type: "string" },
          email: { type: "string" },
          status: { type: "string", enum: ["CNCLD","ERROR","OK"] }
        }
      }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/booking/cancel", { headers, body }); return okText("BookingCancel OK", data); }
      catch (e) { return errText(`booking_cancel failed: ${e.message || String(e)}`); }
    }
  );

  // Find hotels (POST /find-hotels)
  server.registerTool(
    {
      name: "find_hotels",
      description: "POST /find-hotels — Find hotels by destination, dates, currency, roomConfigurations, locale.",
      inputSchema: {
        type: "object", required: ["body"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: { type: "object", required: ["destination","departureDate","returnDate","currency","roomConfigurations","locale"], additionalProperties: true,
            properties: {
              destination: { type: "object", required: ["id","type"],
                properties: {
                  id: { type: "string" },
                  type: { type: "string", enum: ["country-code","city-code","region-code"] },
                  label: { type: "string" }
                }
              },
              hotelId: { type: "string" },
              departureDate: { type: "string" },
              returnDate: { type: "string" },
              currency: { type: "string" },
              roomConfigurations: { type: "array", items: { type: "object" } },
              locale: { type: "string", enum: ["de_DE","en_DE"] }
            }
          }
        }
      },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/find-hotels", { headers, body });
            const n = Array.isArray(data?.data?.results) ? data.data.results.length : 0;
            return okText(`FindHotels OK (${n} results)`, data); }
      catch (e) { return errText(`find_hotels failed: ${e.message || String(e)}`); }
    }
  );

  // Currencies (GET /currencies)
  server.registerTool(
    {
      name: "currencies_list",
      description: "GET /currencies — List supported currencies (requires locale).",
      inputSchema: {
        type: "object", required: ["query"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: { type: "object", required: ["locale"], additionalProperties: false,
            properties: { locale: { type: "string", enum: ["de_DE","en_DE"] } }
          }
        }
      },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/currencies", { headers, query }); return okText("Currencies OK", data); }
      catch (e) { return errText(`currencies_list failed: ${e.message || String(e)}`); }
    }
  );

  // Hotels list (GET /hotels)
  server.registerTool(
    {
      name: "hotels_list",
      description: "GET /hotels — Paginated hotel list (requires locale; optional page).",
      inputSchema: {
        type: "object", required: ["query"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: { type: "object", required: ["locale"], additionalProperties: false,
            properties: {
              locale: { type: "string", enum: ["de_DE","en_DE"] },
              page:   { type: "integer", minimum: 1 }
            }
          }
        }
      },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotels", { headers, query }); return okText("Hotels OK", data); }
      catch (e) { return errText(`hotels_list failed: ${e.message || String(e)}`); }
    }
  );

  // Hotel offers (POST /hotel/offer)
  server.registerTool(
    {
      name: "hotel_offers",
      description: "POST /hotel/offer — Hotel offers for multiple rooms (send empty roomConfigurations to get proposal).",
      inputSchema: {
        type: "object", required: ["body"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: { type: "object", required: ["hotelId","departureDate","returnDate","currency","roomConfigurations","locale"], additionalProperties: true,
            properties: {
              hotelId: { type: "string" },
              departureDate: { type: "string" },
              returnDate: { type: "string" },
              currency: { type: "string" },
              roomConfigurations: { type: "array", items: { type: "object" } },
              locale: { type: "string", enum: ["de_DE","en_DE"] }
            }
          }
        }
      },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/hotel/offer", { headers, body }); return okText("HotelOffers OK", data); }
      catch (e) { return errText(`hotel_offers failed: ${e.message || String(e)}`); }
    }
  );

  // Hotel reference (GET /hotel-reference)
  server.registerTool(
    {
      name: "hotel_reference",
      description: "GET /hotel-reference — Hotel codes, names, rooms.",
      inputSchema: {
        type: "object", required: ["query"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: { type: "object", required: ["locale"], additionalProperties: false,
            properties: { locale: { type: "string", enum: ["de_DE","en_DE"] } }
          }
        }
      },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/hotel-reference", { headers, query }); return okText("HotelReference OK", data); }
      catch (e) { return errText(`hotel_reference failed: ${e.message || String(e)}`); }
    }
  );

  // CRAPI hotel contact (GET /crapi/hotel/contact)
  server.registerTool(
    {
      name: "crapi_hotel_contact",
      description: "GET /crapi/hotel/contact — All hotel contact info.",
      inputSchema: {
        type: "object", required: ["query"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: { type: "object", required: ["locale"], additionalProperties: false,
            properties: { locale: { type: "string", enum: ["de_DE","en_DE"] } }
          }
        }
      },
      outputSchema: { type: "object", properties: { code: { type: "string" }, contact: { type: "object" } } }
    },
    async ({ headers, query }) => {
      try { const data = await callApi("GET", "/crapi/hotel/contact", { headers, query }); return okText("CRAPI HotelContact OK", data); }
      catch (e) { return errText(`crapi_hotel_contact failed: ${e.message || String(e)}`); }
    }
  );

  // Package offer (POST /offer/package)
  server.registerTool(
    {
      name: "package_offer",
      description: "POST /offer/package — Create packaged offer.",
      inputSchema: {
        type: "object", required: ["body"], additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: { type: "object", required: ["hotelId","departureDate","returnDate","currency","roomConfigurations","locale"], additionalProperties: true,
            properties: {
              hotelId: { type: "string" },
              departureDate: { type: "string" },
              returnDate: { type: "string" },
              currency: { type: "string" },
              roomConfigurations: { type: "array", items: { type: "object" } },
              locale: { type: "string", enum: ["de_DE","en_DE"] }
            }
          }
        }
      },
      outputSchema: { type: "object", properties: { offerId: { type: "string" } }, required: ["offerId"] }
    },
    async ({ headers, body }) => {
      try { const data = await callApi("POST", "/offer/package", { headers, body }); return okText("PackageOffer OK", data); }
      catch (e) { return errText(`package_offer failed: ${e.message || String(e)}`); }
    }
  );
}

/** JSON-RPC */
function normalizeReq(x) {
  if (!x || typeof x !== "object") return null;
  if (typeof x.method === "string") return { jsonrpc: "2.0", id: x.id ?? null, method: x.method, params: x.params };
  return null;
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

/** Vercel handler */
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
    console.log("[mcp] method=%s path=%s ct=%s accept=%s hasObj=%s err=%s preview=%s",
      req.method, req.url, req.headers["content-type"], req.headers["accept"],
      obj ? "yes" : "no", err || "none", preview ?? "");

    if (!obj) return sendJson(res, 400, rpcError(null, -32700, "Parse error", err || "Invalid JSON"));

    const registry = makeToolRegistry();
    registerAmelloTools(registry);
    const tools = registry.tools;

    const requests = Array.isArray(obj) ? obj.map(normalizeReq) : [normalizeReq(obj)];
    if (requests.some(r => !r)) return sendJson(res, 400, rpcError(null, -32600, "Invalid Request"));

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
