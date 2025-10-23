// api/mcp.js  (DROP-IN)
// Explicit MCP tools for selected Amello endpoints on Vercel Serverless (Node 18+).
// Deps installed via package.json: @modelcontextprotocol/sdk, zod.
// NOTE: The SDK exposes ESM entry points. We dynamically import them from CommonJS.

const AMELLO_BASE_URL = (process.env.AMELLO_BASE_URL || 'https://prod-api.amello.plusline.net').replace(/\/+$/, '');
const AUTH_SCHEME = (process.env.AMELLO_AUTH_SCHEME || 'bearer').toLowerCase(); // 'bearer' | 'x-api-key' | 'none'
const API_KEY = process.env.AMELLO_API_KEY || '';
let EXTRA_HEADERS = {};
try {
  EXTRA_HEADERS = process.env.AMELLO_EXTRA_HEADERS ? JSON.parse(process.env.AMELLO_EXTRA_HEADERS) : {};
} catch { EXTRA_HEADERS = {}; }

// ---- lazy ESM imports so CommonJS can use ESM packages ----
let _sdk = null;
let _http = null;
let _zod = null;
async function loadDeps() {
  if (!_sdk) _sdk = await import('@modelcontextprotocol/sdk/server/mcp.js');
  if (!_http) _http = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  if (!_zod) _zod = await import('zod');
  return { _sdk, _http, _zod };
}

// ---- tiny helpers ----
function authHeaders() {
  const h = {};
  if (AUTH_SCHEME === 'bearer' && API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  else if (AUTH_SCHEME === 'x-api-key' && API_KEY) h['X-API-Key'] = API_KEY;
  return h;
}

async function doJson(url, init) {
  const res = await fetch(url, init);
  const outHeaders = {};
  res.headers.forEach((v, k) => { outHeaders[k] = v; });
  const ct = (outHeaders['content-type'] || '').toLowerCase();
  let data;
  if (ct.includes('application/json') || ct.includes('ld+json')) {
    try { data = await res.json(); } catch { data = await res.text(); }
  } else {
    data = await res.text();
  }
  return { status: res.status, headers: outHeaders, data };
}

// ---- build MCP server once (singleton) ----
let serverPromise = null;
async function buildServer() {
  const { _sdk, _http, _zod } = await loadDeps();
  const { McpServer } = _sdk;
  const { z } = _zod;

  // =============================
  // ZOD SCHEMAS (inputs)
  // =============================
  const LocaleEnum = z.enum(['de_DE', 'en_DE']);

  const MoneySchema = z.object({
    value: z.number(),
    decimals: z.number(),
    currency: z.object({
      code: z.string(),
      favorite: z.boolean().optional(),
      cobos: z.boolean().optional(),
      juniper: z.boolean().optional(),
      name: z.string().optional(),
      symbol: z.string().optional(),
      decimalPlaces: z.number().optional()
    }).partial(),
    inMinorUnits: z.string().optional()
  }).partial();

  const TravellersSchema = z.object({
    id: z.number().int(),
    adultCount: z.number().int().min(0),
    childrenAges: z.array(z.number().int().min(0)).optional()
  });

  const RoomConfigInputSchema = z.object({
    travellers: TravellersSchema
  });
  const MultiroomConfigsSchema = z.array(RoomConfigInputSchema);

  // 1) POST /api/v1/hotel/offer
  const HotelOfferBodySchema = z.object({
    hotelId: z.string(),
    departureDate: z.string(), // ISO date (YYYY-MM-DD)
    returnDate: z.string(),    // ISO date
    currency: z.string(),      // e.g., 'EUR'
    roomConfigurations: MultiroomConfigsSchema, // [] allowed => framework only
    locale: LocaleEnum
  });

  // 2) POST /api/v1/find-hotels
  const DestinationSchema = z.object({
    id: z.string(),       // e.g., "AT"
    type: z.string()      // e.g., "country-code"
  });
  const FindHotelsBodySchema = z.object({
    destination: DestinationSchema,
    departureDate: z.string(), // ISO date
    returnDate: z.string(),    // ISO date
    currency: z.string(),      // e.g., 'EUR'
    roomConfigurations: MultiroomConfigsSchema,
    locale: LocaleEnum
  });

  // 3) GET /api/v1/hotels
  const HotelsGetQuerySchema = z.object({
    locale: LocaleEnum,
    page: z.number().int().min(1).optional().default(1)
  });

  // 4) GET /api/v1/currencies
  const CurrenciesGetQuerySchema = z.object({
    locale: LocaleEnum
  });

  // =============================
  // MCP SERVER
  // =============================
  const server = new McpServer({
    name: 'amello-mcp-explicit',
    version: '1.0.0'
  });

  // ----------------------------------------
  // amello.hotel_offer_post  (POST /api/v1/hotel/offer)
  // ----------------------------------------
  server.registerTool(
    'amello.hotel_offer_post',
    {
      title: 'POST /api/v1/hotel/offer — Get hotel offers (multiroom / framework)',
      description: [
        'Creates a HotelOffers request for a specific hotel and stay window.',
        'Send an empty "roomConfigurations" array to receive only framework data (no offers).',
        '',
        'Request: application/json',
        'Body shape:',
        JSON.stringify(HotelOfferBodySchema.shape, null, 2),
        '',
        'Expected responses:',
        '- 200 application/json: HotelOffers resource created (offers + filters + roomConfiguration echoes)',
        '- 400 application/ld+json: Invalid input',
        '- 422 application/ld+json: Validation violations'
      ].join('\n'),
      inputSchema: z.object({
        body: HotelOfferBodySchema,
        headers: z.record(z.string()).optional()
      }),
      outputSchema: z.object({
        status: z.number(),
        headers: z.record(z.string()),
        data: z.any()
      })
    },
    async ({ body, headers }) => {
      const url = `${AMELLO_BASE_URL}/api/v1/hotel/offer`;
      const res = await doJson(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...authHeaders(),
          ...EXTRA_HEADERS,
          ...(headers || {})
        },
        body: JSON.stringify(body)
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        structuredContent: res
      };
    }
  );

  // ----------------------------------------
  // amello.find_hotels_post  (POST /api/v1/find-hotels)
  // ----------------------------------------
  server.registerTool(
    'amello.find_hotels_post',
    {
      title: 'POST /api/v1/find-hotels — Find hotels by region (multiroom)',
      description: [
        'Gets hotels in a region for the specified dates and room configurations.',
        '',
        'Request: application/json',
        'Body shape:',
        JSON.stringify(FindHotelsBodySchema.shape, null, 2),
        '',
        'Expected responses:',
        '- 200 application/json: FindHotelsMultiroom resource (data.results[], filters)',
        '- 400 application/ld+json: Invalid input',
        '- 422 application/ld+json: Validation violations'
      ].join('\n'),
      inputSchema: z.object({
        body: FindHotelsBodySchema,
        headers: z.record(z.string()).optional()
      }),
      outputSchema: z.object({
        status: z.number(),
        headers: z.record(z.string()),
        data: z.any()
      })
    },
    async ({ body, headers }) => {
      const url = `${AMELLO_BASE_URL}/api/v1/find-hotels`;
      const res = await doJson(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...authHeaders(),
          ...EXTRA_HEADERS,
          ...(headers || {})
        },
        body: JSON.stringify(body)
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        structuredContent: res
      };
    }
  );

  // ----------------------------------------
  // amello.hotels_get  (GET /api/v1/hotels)
  // ----------------------------------------
  server.registerTool(
    'amello.hotels_get',
    {
      title: 'GET /api/v1/hotels — Get hotels',
      description: [
        'Retrieves a paginated collection of hotels.',
        'Required query param: locale (de_DE | en_DE). Optional: page (default 1).',
        '',
        'Expected responses:',
        '- 200 application/json: Hotel collection (array of { data: {...} })'
      ].join('\n'),
      inputSchema: z.object({
        query: HotelsGetQuerySchema,
        headers: z.record(z.string()).optional()
      }),
      outputSchema: z.object({
        status: z.number(),
        headers: z.record(z.string()),
        data: z.any()
      })
    },
    async ({ query, headers }) => {
      const q = HotelsGetQuerySchema.parse(query);
      const url = new URL(`${AMELLO_BASE_URL}/api/v1/hotels`);
      url.searchParams.set('locale', q.locale);
      url.searchParams.set('page', String(q.page || 1));
      const res = await doJson(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...authHeaders(),
          ...EXTRA_HEADERS,
          ...(headers || {})
        }
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        structuredContent: res
      };
    }
  );

  // ----------------------------------------
  // amello.currencies_get  (GET /api/v1/currencies)
  // ----------------------------------------
  server.registerTool(
    'amello.currencies_get',
    {
      title: 'GET /api/v1/currencies — Get data for all currencies',
      description: [
        'Retrieves currency metadata (code, symbol, decimal places, flags).',
        'Required query param: locale (de_DE | en_DE).',
        '',
        'Expected responses:',
        '- 200 application/json: Currency collection (array of { data: [ ... ] })'
      ].join('\n'),
      inputSchema: z.object({
        query: z.object({ locale: LocaleEnum.shape._def.values ? LocaleEnum : LocaleEnum }), // safe reuse
        headers: z.record(z.string()).optional()
      }),
      outputSchema: z.object({
        status: z.number(),
        headers: z.record(z.string()),
        data: z.any()
      })
    },
    async ({ query, headers }) => {
      const q = CurrenciesGetQuerySchema.parse(query);
      const url = new URL(`${AMELLO_BASE_URL}/api/v1/currencies`);
      url.searchParams.set('locale', q.locale);
      const res = await doJson(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...authHeaders(),
          ...EXTRA_HEADERS,
          ...(headers || {})
        }
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        structuredContent: res
      };
    }
  );

  return server;
}

async function getServer() {
  if (!serverPromise) {
    serverPromise = buildServer().catch((e) => {
      // surface errors cleanly on first request
      serverPromise = null;
      throw e;
    });
  }
  return serverPromise;
}

// =============================
// VERCEL HANDLER (Streamable HTTP MCP)
// =============================
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      // A simple GET helps you smoke-test the route without MCP client
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, endpoint: '/api/mcp', method: req.method }));
      return;
    }

    const { _http } = await loadDeps();
    const { StreamableHTTPServerTransport } = _http;

    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => { try { transport.close(); } catch {} });

    let body = req.body;
    if (body === undefined) {
      body = await new Promise((resolve, reject) => {
        let buf = '';
        req.setEncoding('utf8');
        req.on('data', (c) => { buf += c; });
        req.on('end', () => {
          try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
        });
        req.on('error', reject);
      });
    }

    const server = await getServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('[api/mcp] error:', e);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
};
