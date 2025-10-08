// COMPLETE DROP-IN FILE
// HTTP bridge for ChatGPT -> Amello MCP JSON-RPC
// Forwards simplified GET/POST calls to the MCP server at /api/mcp

const MCP_URL = process.env.MCP_URL || "https://amello-mcp.vercel.app/api/mcp";

export default async function handler(req, res) {
  const { pathname } = new URL(req.url, `https://${req.headers.host}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // ---------- LIST TOOLS ----------
    if (pathname.endsWith("/list") || req.method === "GET") {
      const rpcBody = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      };

      const response = await fetch(MCP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpcBody)
      });

      const data = await response.json();
      // unwrap to match GPT expectation: { result: { tools: [...] } }
      if (data.result && data.result.tools) {
        return res.status(200).json({ result: { tools: data.result.tools } });
      }
      return res.status(500).json({ error: "Unexpected MCP response", data });
    }

    // ---------- CALL TOOL ----------
    if (pathname.endsWith("/call") || req.method === "POST") {
      const { name, arguments: args } = req.body || {};
      if (!name) return res.status(400).json({ error: "Missing 'name' in body" });

      const rpcBody = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args || {} }
      };

      const response = await fetch(MCP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpcBody)
      });

      const data = await response.json();
      // unwrap JSON-RPC envelope
      if (data.result) return res.status(200).json(data.result);
      return res.status(500).json({ error: "Unexpected MCP response", data });
    }

    // ---------- FALLBACK ----------
    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error("[bridge] error:", err);
    return res.status(500).json({ error: "Bridge error", details: err.message });
  }
}
