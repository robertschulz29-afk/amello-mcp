// api/mcp.js
// Minimal, tolerant JSON-RPC router for MCP tools on Vercel (no SDK HTTP transport).
// Implements: tools/list, tools/call
// Robust body parsing (object/string/Buffer/Uint8Array), BOM stripping
// Always returns JSON bodies and logs one concise line per POST.

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

function isTypedArray(x) {
  return x && typeof x === "object" && typeof x.byteLength === "number" && typeof x.BYTES_PER_ELEMENT === "number";
}
function stripBOM(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

async function readStreamUtf8(req) {
  const chunks = [];
  return await new Promise((resolve) => {
    req.on?.("data", (c) => chunks.push(Buffer.from(c)));
    req.on?.("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      resolve(s.length ? s : undefined);
    });
    req.on?.("error", () => resolve(undefined));
  });
}

async function get
