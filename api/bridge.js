module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    const routes = {
      '/api/bridge/find-hotels': { tool: 'amello.find_hotels_post', method: 'POST' },
      '/api/bridge/hotel-offer': { tool: 'amello.hotel_offer_post',  method: 'POST' },
      '/api/bridge/hotels':      { tool: 'amello.hotels_get',       method: 'GET'  },
      '/api/bridge/currencies':  { tool: 'amello.currencies_get',   method: 'GET'  },
    };

    if (pathname === '/api/bridge/health') return json(res, 200, { ok: true });
    if (!routes[pathname]) return json(res, 404, { error: 'Not found' });
    const { tool, method } = routes[pathname];
    if (req.method !== method) return json(res, 405, { error: `Use ${method}` });

    const mcpUrl = process.env.MCP_SERVER_URL;
    if (!mcpUrl) return json(res, 500, { error: 'MCP_SERVER_URL env not set' });

    const payload = await readJson(req);
    const args = buildToolArgs({ pathname, method, url, payload });

    const rpc = { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } };

    const mcpResp = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpc)
    });

    const out = await mcpResp.json();
    if (out.error) return json(res, 502, { mcpError: out.error });

    const result = out.result || out;
    const structured = result.structuredContent || result;
    return json(res, structured?.status || 200, structured?.data ?? structured);
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
};

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', c => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function buildToolArgs({ pathname, method, url, payload }) {
  const qp = Object.fromEntries(new URLSearchParams(url.search));
  switch (pathname) {
    case '/api/bridge/find-hotels':
      return { body: payload, headers: {} };
    case '/api/bridge/hotel-offer':
      return { body: payload, headers: {} };
    case '/api/bridge/hotels':
      return { query: { locale: qp.locale, page: qp.page ? Number(qp.page) : undefined }, headers: {} };
    case '/api/bridge/currencies':
      return { query: { locale: qp.locale }, headers: {} };
    default:
      return payload || {};
  }
}
