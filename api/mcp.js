// /api/mcp.js
// Unified Amello MCP endpoint – accepts both plain {name,arguments} and JSON-RPC.

const DEFAULT_API_BASE = "https://prod-api.amello.plusline.net/api/v1";
const API_BASE = process.env.API_BASE || DEFAULT_API_BASE;
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
}
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { return {}; }
}

async function callApi(method, path, { query, body } = {}) {
  const url = new URL(path, API_BASE);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const opt = {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  };
  if (method !== "GET" && body) opt.body = JSON.stringify(body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  opt.signal = ctrl.signal;

  try {
    const res = await fetch(url, opt);
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
    return JSON.parse(txt);
  } finally { clearTimeout(timer); }
}

// ---- tool handlers ----
const tools = {
  currencies_list: async (a = {}) => {
    const locale = a.locale || a.query?.locale || "en_DE";
    return await callApi("GET", "/currencies", { query: { locale } });
  },
  find_hotels: async (a = {}) => {
    const body = a.body || a;
    return await callApi("POST", "/find-hotels", { body });
  },
  hotels_list: async (a = {}) => {
    const locale = a.locale || a.query?.locale || "en_DE";
    const page = a.page || a.query?.page || 1;
    return await callApi("GET", "/hotels", { query: { locale, page } });
  },
  booking_search: async (a = {}) => {
    return await callApi("GET", "/booking/search", { query: a.query || a });
  },
  booking_cancel: async (a = {}) => {
    return await callApi("POST", "/booking/cancel", { body: a.body || a });
  },
  package_offer: async (a = {}) => {
    return await callApi("POST", "/offer/package", { body: a.body || a });
  },
  ping: async () => ({ ok: true, message: "pong" })
};

// ---- main handler ----
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  try {
    const body = await readJson(req);

    // Accept plain or JSON-RPC
    const isRpc = body.jsonrpc && body.method;
    let name, args;

    if (isRpc) {
      if (body.method === "tools/call") {
        name = body.params?.name;
        args = body.params?.arguments || body.params?.args || {};
      } else if (body.method === "tools/list") {
        return send(res, 200, { result: Object.keys(tools) });
      }
    } else {
      name = body.name;
      args = body.arguments || {};
    }

    if (!name) return send(res, 400, { error: "Missing tool name" });
    const fn = tools[name];
    if (!fn) return send(res, 404, { error: `Unknown tool: ${name}` });

    const result = await fn(args);
    return send(res, 200, result);
  } catch (e) {
    return send(res, 500, { error: e.message || String(e) });
  }
};
