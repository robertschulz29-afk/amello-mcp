// Calls Amello API directly (no MCP dependency) and returns clean JSON for GPT Actions.
// Env:
//   AMELLO_BASE_URL    (default https://prod-api.amello.plusline.net)
//   AMELLO_AUTH_SCHEME (bearer | x-api-key | none; default bearer)
//   AMELLO_API_KEY     (if required)
//   AMELLO_EXTRA_HEADERS (JSON string, optional)

const AMELLO_BASE_URL = (process.env.AMELLO_BASE_URL || 'https://prod-api.amello.plusline.net').replace(/\/+$/, '');
const AUTH_SCHEME = (process.env.AMELLO_AUTH_SCHEME || 'bearer').toLowerCase();
const API_KEY = process.env.AMELLO_API_KEY || '';
let EXTRA_HEADERS = {};
try { EXTRA_HEADERS = process.env.AMELLO_EXTRA_HEADERS ? JSON.parse(process.env.AMELLO_EXTRA_HEADERS) : {}; } catch { EXTRA_HEADERS = {}; }

function authHeaders() {
  const h = {};
  if (AUTH_SCHEME === 'bearer' && API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  else if (AUTH_SCHEME === 'x-api-key' && API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sub = url.pathname.replace(/^\/api\/bridge/, '') || '/';

    if (sub === '/' || sub === '/health') {
      return json(res, 200, { ok: true });
    }

    switch (sub) {
      case '/find-hotels':
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
        return proxyJson(res, `${AMELLO_BASE_URL}/api/v1/find-hotels`, 'POST', await readJson(req));

      case '/hotel-offer':
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
        return proxyJson(res, `${AMELLO_BASE_URL}/api/v1/hotel/offer`, 'POST', await readJson(req));

      case '/hotels': {
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET' });
        const q = new URLSearchParams(url.search);
        if (!q.get('locale')) return json(res, 400, { error: 'Missing query param: locale' });
        const target = new URL(`${AMELLO_BASE_URL}/api/v1/hotels`);
        target.searchParams.set('locale', q.get('locale'));
        if (q.get('page')) target.searchParams.set('page', q.get('page'));
        return proxyJson(res, target.toString(), 'GET');
      }

      case '/currencies': {
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET' });
        const q = new URLSearchParams(url.search);
        if (!q.get('locale')) return json(res, 400, { error: 'Missing query param: locale' });
        const target = new URL(`${AMELLO_BASE_URL}/api/v1/currencies`);
        target.searchParams.set('locale', q.get('locale'));
        return proxyJson(res, target.toString(), 'GET');
      }

      default:
        return json(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
};

async function proxyJson(res, targetUrl, method, bodyObj) {
  const headers = {
    accept: 'application/json',
    ...authHeaders(),
    ...EXTRA_HEADERS
  };

  const init = { method, headers };
  if (bodyObj !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(bodyObj);
  }

  const r = await fetch(targetUrl, init);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  let data;
  if (ct.includes('application/json') || ct.includes('ld+json')) {
    try { data = await r.json(); } catch { data = await r.text(); }
  } else {
    data = await r.text();
  }
  return json(res, r.status, data);
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
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
