import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/* ---------------------------- configuration ---------------------------- */

const API_BASE = process.env.API_BASE ?? "https://prod-api.amello.plusline.net/api/v1";
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS ?? 30000);

/* -------------------------------- types -------------------------------- */
type PathParams = Record<string, string | number>;
type AnyRecord = Record<string, unknown>;
interface CallArgs {
  pathParams?: PathParams;
  query?: AnyRecord;
  headers?: Record<string, string>;
  body?: unknown;
}

/* --------------------------------- utils -------------------------------- */

function authHeaders(): Record<string, string> {
  const t = process.env.AMELLO_API_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}
function applyPathParams(route: string, pathParams: PathParams = {}): string {
  return route.replace(/\{([^}]+)\}/g, (_: string, key: string) =>
    encodeURIComponent(String(pathParams[key]))
  );
}
function normalizeRoute(route: string, baseUrl: string): string {
  let r = route.replace(/^\/+/, "");
  const basePath = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, "");
  if (basePath && (r === basePath || r.startsWith(basePath + "/"))) {
    r = r.slice(basePath.length).replace(/^\/+/, "");
  }
  return r;
}
function joinUrl(baseUrl: string, route: string): URL {
  const b = new URL(baseUrl);
  const basePath = b.pathname.endsWith("/") ? b.pathname : b.pathname + "/";
  const r = normalizeRoute(route, baseUrl);
  b.pathname = basePath + r;
  b.search = "";
  b.hash = "";
  return b;
}
async function callApi(method: string, route: string, args: CallArgs = {}) {
  const url = joinUrl(API_BASE, applyPathParams(route, args.pathParams || {}));
  const query = args.query || {};
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...authHeaders(),
    ...(args.headers || {}),
  };
  const init: RequestInit = { method: method.toUpperCase(), headers };
  if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD" && args.body !== undefined) {
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), TIMEOUT_MS);
  (init as any).signal = ac.signal;

  let res: Response;
  try {
    res = await fetch(url.toString(), init);
  } finally {
    clearTimeout(to);
  }
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${text}`);
  try { if (ct.includes("json")) return JSON.parse(text); } catch {}
  return text;
}

/* --------------------------- tool registrations ------------------------- */

export function registerAmelloTools(server: McpServer) {
  // --- booking_search (GET /booking/search)
  server.registerTool(
    "booking_search",
    {
      title: "Booking search",
      description: "GET /booking/search — Find a booking by reference, email, and locale.",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        query: z.object({
          bookingReferenceNumber: z.string().describe("Itinerary/booking reference (e.g., 45666CK000940)."),
          email: z.string().describe("Booking email."),
          locale: z.string().describe("Locale like de_DE or en_DE.")
        }).strict()
      },
      outputSchema: { data: z.any() }
    },
    async (args: any) => {
      try {
        const res = await callApi("GET", "booking/search", { headers: args?.headers, query: args?.query });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Booking search failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- booking_cancel (POST /booking/cancel)
  server.registerTool(
    "booking_cancel",
    {
      title: "Booking cancellation",
      description: "POST /booking/cancel — Cancel a booking.",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        body: z.object({
          itineraryNumber: z.string().optional(),
          bookingNumber: z.string().optional(),
          email: z.string(),
          locale: z.string().optional()
        }).passthrough()
      },
      outputSchema: {
        itineraryNumber: z.string().optional(),
        bookingNumber: z.string().optional(),
        email: z.string().optional(),
        status: z.string().describe("Expected CNCLD on success.")
      }
    },
    async (args: any) => {
      try {
        const res = await callApi("POST", "booking/cancel", { headers: args?.headers, body: args?.body });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Cancellation failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- find_hotels (POST /find-hotels)
  server.registerTool(
    "find_hotels",
    {
      title: "Find hotels",
      description: "POST /find-hotels — Multiroom hotel search.",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        body: z.object({
          destination: z.object({ id: z.string(), type: z.string() }),
          departureDate: z.string(),
          returnDate: z.string(),
          currency: z.string(),
          roomConfigurations: z.array(z.object({
            travellers: z.object({
              adultCount: z.number(),
              childrenAges: z.array(z.number()).optional()
            })
          }).passthrough()),
          locale: z.string()
        }).strict()
      },
      outputSchema: {
        data: z.object({
          currency: z.string().optional(),
          request: z.any().optional(),
          results: z.array(z.any()).optional()
        }).passthrough(),
        filter: z.array(z.any()).optional()
      }
    },
    async (args: any) => {
      try {
        const res = await callApi("POST", "find-hotels", { headers: args?.headers, body: args?.body });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Find hotels failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- currency_list (GET /currencies)
  server.registerTool(
    "currency_list",
    {
      title: "List currencies",
      description: "GET /currencies — All currencies for a locale.",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        query: z.object({ locale: z.string() }).strict()
      },
      outputSchema: { result: z.any() }
    },
    async (args: any) => {
      try {
        const res = await callApi("GET", "currencies", { headers: args?.headers, query: args?.query });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Currencies failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- hotel_offers (POST /hotel/offer)
  server.registerTool(
    "hotel_offers",
    {
      title: "Hotel offers (multiroom)",
      description: "POST /hotel/offer — Get offers; empty roomConfigurations → proposal.",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        body: z.object({
          hotelId: z.string(),
          departureDate: z.string(),
          returnDate: z.string(),
          currency: z.string(),
          roomConfigurations: z.array(z.object({
            travellers: z.object({
              adultCount: z.number(),
              childrenAges: z.array(z.number()).optional()
            }),
            roomCode: z.string().optional(),
            boardTypeOpCode: z.string().optional(),
            bookingCode: z.string().optional()
          }).passthrough()),
          locale: z.string()
        }).strict()
      },
      outputSchema: {
        data: z.any(),
        filter: z.any().optional(),
        roomConfigurations: z.any().optional(),
        departureDate: z.any().optional(),
        returnDate: z.any().optional(),
        roomConfiguration: z.any().optional()
      }
    },
    async (args: any) => {
      try {
        const res = await callApi("POST", "hotel/offer", { headers: args?.headers, body: args?.body });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Hotel offers failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- hotel_reference_list (GET /hotel-reference)
  server.registerTool(
    "hotel_reference_list",
    {
      title: "Hotel reference list",
      description: "GET /hotel-reference — Reference codes/names/rooms.",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        query: z.object({ locale: z.string() }).strict()
      },
      outputSchema: { result: z.any() }
    },
    async (args: any) => {
      try {
        const res = await callApi("GET", "hotel-reference", { headers: args?.headers, query: args?.query });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Hotel reference failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- hotels_list (GET /hotels)
  server.registerTool(
    "hotels_list",
    {
      title: "Hotels list",
      description: "GET /hotels — Paginated hotel collection.",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        query: z.object({
          locale: z.string(),
          page: z.number().int().min(1).optional()
        }).strict()
      },
      outputSchema: { result: z.array(z.any()) }
    },
    async (args: any) => {
      try {
        const res = await callApi("GET", "hotels", { headers: args?.headers, query: args?.query });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Hotels list failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- crapi_hotel_contact (GET /crapi/hotel/contact)
  server.registerTool(
    "crapi_hotel_contact",
    {
      title: "CRAPI hotel contacts",
      description: "GET /crapi/hotel/contact — Contact info for hotels.",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        query: z.object({ locale: z.string() }).strict()
      },
      outputSchema: { result: z.any() }
    },
    async (args: any) => {
      try {
        const res = await callApi("GET", "crapi/hotel/contact", { headers: args?.headers, query: args?.query });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `CRAPI contact failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- package_offer (POST /offer/package)
  server.registerTool(
    "package_offer",
    {
      title: "Create package offer",
      description: "POST /offer/package — Create a packaged offer (returns offerId).",
      inputSchema: {
        headers: z.record(z.string()).optional(),
        body: z.object({
          hotelId: z.string(),
          departureDate: z.string(),
          returnDate: z.string(),
          currency: z.string(),
          roomConfigurations: z.array(z.object({
            roomCode: z.string().optional(),
            boardTypeOpCode: z.string().optional(),
            bookingCode: z.string().optional(),
            travellers: z.object({
              adultCount: z.number(),
              childrenAges: z.array(z.number()).optional()
            })
          }).passthrough()),
          locale: z.string()
        }).strict()
      },
      outputSchema: { offerId: z.string() }
    },
    async (args: any) => {
      try {
        const res = await callApi("POST", "offer/package", { headers: args?.headers, body: args?.body });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res } as any;
      } catch (e: any) {
        return { isError: true, content: [{ type: "text", text: `Package offer failed: ${e.message || String(e)}` }] } as any;
      }
    }
  );

  // --- diagnostics
  server.registerTool(
    "amello_status",
    {
      title: "Server status",
      description: "Environment/runtime info.",
      inputSchema: {},
      outputSchema: {
        apiBase: z.string(),
        tokenPresent: z.boolean(),
        node: z.string()
      }
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({
        apiBase: API_BASE,
        tokenPresent: Boolean(process.env.AMELLO_API_TOKEN),
        node: process.version
      }, null, 2) }],
      structuredContent: {
        apiBase: API_BASE,
        tokenPresent: Boolean(process.env.AMELLO_API_TOKEN),
        node: process.version
      }
    }) as any
  );
}
