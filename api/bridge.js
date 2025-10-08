// Calls your public MCP server's tools via JSON-RPC over Streamable HTTP.
// Exposes classic REST endpoints the GPT Action can call.

// ENV:
//   MCP_SERVER_URL = https://<your-vercel-app>.vercel.app/api/mcp
// (or wherever your MCP server lives)

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Route → tool mapping
    const routes = {
      '/api/bridge/find-hotels': { tool: 'amello.find_hotels_post', method: 'POST' },
      '/api/bridge/hotel-offer': { tool: 'amello.hotel_offer_post',  method: 'POST' },
      '/api/bridge/hotels':      { tool: 'amello.hotels_get',       method: 'GET'  },
      '/api/bridge/currencies':  { tool: 'amello.currencies_get',   method: 'GET'  },
    };

    if (!routes[pathname]) {
      if (pathname === '/api/bridge/health') return res.status(200).json({ ok: true });
      return res.status(404).json({ error: 'Not found' });
    }

    const { tool, method } = routes[pathname];
    if (req.method !== method) return res.status(405).json({ error: `Use ${method}` });

    const mcpUrl = process.env.MCP_SERVER_URL;
    if (!mcpUrl) return res.status(500).json({ error: 'MCP_SERVER_URL env not set' });

    // Read JSON body or query to build tool arguments
    const payload = await readJson(req);
    const args = buildToolArgs({ pathname, method, url, payload });

    // Minimal JSON-RPC call to MCP "tools/call"
    const rpc = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: tool,
        arguments: args
      }
    };
