module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname; // e.g. /api/bridge/currencies
    const m = pathname.match(/^\/api\/bridge(\/.*)?$/);
    const sub = m && m[1] ? m[1] : '/';

    const routes = {
      '/find-hotels': { tool: 'amello.find_hotels_post', method: 'POST' },
      '/hotel-offer': { tool: 'amello.hotel_offer_post',  method: 'POST' },
      '/hotels':      { tool: 'amello.hotels_get',        method: 'GET'  },
      '/currencies':  { tool: 'amello.currencies_get',    method: 'GET'  },
      '/':            { health: true,                     method: 'GET'  }
    };

    if (sub === '/' || sub === '/health') return json(res, 200, { ok: true });
    const route = routes[sub];
    if (!route) return json(res, 404, { error: 'Not found' });
    if (req.method !== route.method) return json(res, 405, { error: `Use ${route.method}` });

    const mcpUrl = process.env.MCP_SERVER_URL;
    if (!mcpUrl) return json(res, 500, { error: 'MCP_SERVER_URL env not set' });

    const payload = await readJson(req);
    const args = buildToolArgs({ sub, url, payload });

    const rpc = { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: route.tool, arguments: args } };
    const mcpResp = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc) });
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

function buildToolArgs({ sub, url, payload }) {
  const qp = Object.fromEntries(new URLSearchParams(url.search));
  switch (sub) {
    case '/find-hotels': return { body: payload, headers: {} };
    case '/hotel-offer': return { body: payload, headers: {} };
    case '/hotels':      return { query: { locale: qp.locale, page: qp.page ? Number(qp.page) : undefined }, headers: {} };
    case '/currencies':  return { query: { locale: qp.locale }, headers: {} };
    default:             return payload || {};
  }
}
