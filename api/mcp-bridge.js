// /api/mcp-bridge.js
// Drop-in Amello MCP HTTP bridge for Vercel
// Accepts plain { name, arguments } and forwards to the MCP JSON-RPC endpoint.

const MCP_URL = process.env.MCP_URL || "https://amello-mcp.vercel.app/api/mcp";
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

async function forwardToMcp(name, args) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    const json = JSON.parse(text);
    // Return structured content or raw result
    return json.result?.structuredContent || json.result || json;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  try {
    const { name, arguments: args } = await readBody(req);
    if (!name) {
      res.statusCode = 400;
      return res.end("Missing tool name");
    }

    const result = await forwardToMcp(name, args || {});
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
};
