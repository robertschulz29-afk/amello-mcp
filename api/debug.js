// api/debug.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");

  if (req.method === "OPTIONS" || req.method === "HEAD") {
    res.statusCode = 204;
    return res.end();
  }

  const info = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    typeofBody: typeof req.body,
    hasBody: req.body != null
  };

  let parsed = null;
  try {
    if (typeof req.body === "string") parsed = JSON.parse(req.body);
    else if (req.body && typeof req.body === "object") parsed = req.body;
  } catch (e) {
    parsed = { parseError: String(e) };
  }

  const payload = { ok: true, info, parsed };
  const str = JSON.stringify(payload);
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(str).toString());
  res.end(str);
}
