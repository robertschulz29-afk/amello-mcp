// CommonJS MCP bridge endpoint for Vercel
// Receives { name, arguments } from /api/mcp-bridge/call
// Forwards to Amello API tools

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

function bearerHeaders() {
  const t = process.env.AMELLO_API_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function callApi(method, route, args = {}) {
  const url = new URL(route, API_BASE);
  const q = args.query || {};
  for (const [k, v] of Object.entries(q)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...bearerHeaders(),
    ...(args.headers || {})
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const init = { method, headers, signal: controller.signal };
  if (method !== "GET" && args.body) init.body = JSON.stringify(args.body);
  try {
    const res = await fetch(url.toString(), init);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? JSON.parse(text) : text;
  } finally { clearTimeout(timer); }
}

const tools = {
  "currencies_list": async (args = {}) => {
    const locale = args.locale || args.query?.locale || "en_DE";
    const data = await callApi("GET", "/currencies", { query: { locale } });
    return { ok: true, data: data.data ?? data };
  },
  "find_hotels": async (args = {}) => {
    const data = await callApi("POST", "/find-hotels", { body: args });
    return { ok: true, data };
  },
  "hotels_list": async (args = {}) => {
    const locale = args.locale || args.query?.locale || "en_DE";
    const page = args.page || args.query?.page || 1;
    const data = await callApi("GET", "/hotels", { query: { locale, page } });
    return { ok: true, data };
  },
  "ping": async () => ({ ok: true, message: "pong" })
};

module.exports = async function handler(req, res) {
  try {
    setCors(res);
    if (req.method === "OPTIONS" || req.method === "HEAD") return res.end();
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const { name, arguments: args } = body;

    const fn = tools[name];
    if (!fn) return sendJson(res, 400, { error: `Unknown tool: ${name}` });

    const result = await fn(args || {});
    return sendJson(res, 200, result);
  } catch (e) {
    return sendJson(res, 500, { error: e.message || String(e) });
  }
};
