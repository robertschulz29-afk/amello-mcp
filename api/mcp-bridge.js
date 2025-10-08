// api/mcp-bridge.js
// Simple REST bridge -> MCP JSON-RPC (CommonJS for Vercel /api/* functions)

const MCP_URL = process.env.MCP_URL || "https://amello-mcp.vercel.app/api/mcp";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(s).toString());
  res.end(s);
}

async function readJson(req) {
  return await new Promise((resolve) => {
    const chunks = [];
    req.on("data", c => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ __parseError: true }); }
    });
    req.on("error", () => resolve({}));
  });
}

async function rpc(method, params) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { passthrough: text }; }
  return { status: r.status, json };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = new URL(req.url, "http://x"); // base ignored by Vercel
  const path = url.pathname || "/api/mcp-bridge";

  try {
    if (req.method === "GET" && path.endsWith("/list")) {
      const { json } = await rpc("tools/list", {});
      return send(res, 200, json);
    }

    if (req.method === "POST" && path.endsWith("/call")) {
      const body = await readJson(req);
      if (body.__parseError) return send(res, 400, { error: "Invalid JSON" });
      const name = body?.name;
      const args = body?.arguments ?? {};
      if (!name) return send(res, 400, { error: "Missing field: name" });
      const { json } = await rpc("tools/call", { name, arguments: args });
      return send(res, 200, json);
    }

    // Basic index/help
    if (req.method === "GET") {
      return send(res, 200, {
        ok: true,
        message: "MCP Bridge ready",
        endpoints: {
          list:   "GET  /api/mcp-bridge/list",
          call:   "POST /api/mcp-bridge/call { name, arguments }"
        },
        target: MCP_URL
      });
    }

    return send(res, 405, { error: "Method not allowed" });
  } catch (e) {
    return send(res, 500, { error: e?.message || String(e) });
  }
};
