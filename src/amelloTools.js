// src/amelloTools.ts

const API_BASE = process.env.API_BASE ?? "https://prod-api.amello.plusline.net/api/v1";
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS ?? 30000);

type PathParams = Record<string, string | number>;
type AnyRecord = Record<string, unknown>;

function bearerHeaders(): Record<string, string> {
  const t = process.env.AMELLO_API_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function applyPathParams(route: string, pathParams: PathParams = {}) {
  return route.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(String(pathParams[key])));
}

async function callApi(
  method: string,
  route: string,
  args: { pathParams?: PathParams; query?: AnyRecord; headers?: Record<string, string>; body?: unknown } = {}
): Promise<any> {
  const url = new URL(applyPathParams(route, args.pathParams || {}), API_BASE);
  const query = args.query || {};
  Object.entries(query).forEach(([k, v]) => {
    if (v == null) return;
    url.searchParams.set(k, String(v));
  });

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...bearerHeaders(),
    ...(args.headers || {})
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const init: RequestInit = { method: method.toUpperCase(), headers, signal: controller.signal };
  if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD" && args.body !== undefined) {
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  try {
    const res = await fetch(url.toString(), init);
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
    if (ct.includes("application/json")) return JSON.parse(text || "{}");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Helper to wrap success */
function okText(text: string, data?: any) {
  const blocks = [{ type: "text", text }];
  return data !== undefined
    ? { content: blocks, structuredContent: data }
    : { content: blocks };
}

/** Helper to wrap error */
function errText(message: string) {
  return { content: [{ type: "text", text: message }], isError: true as any };
}

export function registerAmelloTools(server: any) {
  // 0) Health
  server.registerTool(
    {
      name: "ping",
      description: "Health check",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" }, message: { type: "string" } },
        required: ["ok", "message"]
      }
    },
    async () => ({ content: [{ type: "text", text: "pong" }], structuredContent: { ok: true, message: "pong" } })
  );

  // 1) Booking search (GET /booking/search)
  server.registerTool(
    {
      name: "booking_search",
      description: "GET /booking/search — find booking by bookingReferenceNumber + email + locale",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: {
            type: "object",
            additionalProperties: false,
            required: ["bookingReferenceNumber", "email", "locale"],
            properties: {
              bookingReferenceNumber: { type: "string", description: "Itinerary/booking reference, e.g. 45666CK000940" },
              email: { type: "string" },
              locale: { type: "string", enum: ["de_DE", "en_DE"] }
            }
          }
        }
      },
      outputSchema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              itineraryNumber: { type: "string" },
              user: { type: "object", properties: { email: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" } } },
              hotel: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
              currency: { type: "string" },
              status: { type: "string" }
            }
          }
        }
      }
    },
    async ({ headers, query }: { headers?: Record<string, string>; query: AnyRecord }) => {
      try {
        const data = await callApi("GET", "/booking/search", { headers, query });
        return okText("BookingSearch OK", data);
      } catch (e: any) {
        return errText(`booking_search failed: ${e.message || String(e)}`);
      }
    }
  );

  // 2) Booking cancel (POST /booking/cancel)
  server.registerTool(
    {
      name: "booking_cancel",
      description: "POST /booking/cancel — cancel booking with itineraryNumber, bookingNumber, email, locale",
      inputSchema: {
        type: "object",
        required: ["body"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: {
            type: "object",
            additionalProperties: false,
            required: ["itineraryNumber", "bookingNumber", "email", "locale"],
            properties: {
              itineraryNumber: { type: "string" },
              bookingNumber: { type: "string" },
              email: { type: "string" },
              locale: { type: "string", enum: ["de_DE", "en_DE"] }
            }
          }
        }
      },
      outputSchema: {
        type: "object",
        properties: {
          itineraryNumber: { type: "string" },
          bookingNumber: { type: "string" },
          email: { type: "string" },
          status: { type: "string", enum: ["CNCLD", "ERROR", "OK"] }
        }
      }
    },
    async ({ headers, body }: { headers?: Record<string, string>; body: AnyRecord }) => {
      try {
        const data = await callApi("POST", "/booking/cancel", { headers, body });
        return okText("BookingCancel OK", data);
      } catch (e: any) {
        return errText(`booking_cancel failed: ${e.message || String(e)}`);
      }
    }
  );

  // 3) Find hotels (POST /find-hotels)
  server.registerTool(
    {
      name: "find_hotels",
      description: "POST /find-hotels — find hotels by destination, dates, currency, roomConfigurations, locale",
      inputSchema: {
        type: "object",
        required: ["body"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: {
            type: "object",
            required: ["destination", "departureDate", "returnDate", "currency", "roomConfigurations", "locale"],
            additionalProperties: true,
            properties: {
              destination: {
                type: "object",
                required: ["id", "type"],
                properties: { id: { type: "string" }, type: { type: "string", enum: ["country-code", "city-code", "region-code"] }, label: { type: "string" } }
              },
              hotelId: { type: "string" },
              departureDate: { type: "string" },
              returnDate: { type: "string" },
              currency: { type: "string" },
              roomConfigurations: { type: "array", items: { type: "object" } },
              locale: { type: "string", enum: ["de_DE", "en_DE"] }
            }
          }
        }
      },
      outputSchema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              results: { type: "array", items: { type: "object" } },
              currency: { type: "string" }
            }
          }
        }
      }
    },
    async ({ headers, body }: { headers?: Record<string, string>; body: AnyRecord }) => {
      try {
        const data = await callApi("POST", "/find-hotels", { headers, body });
        return okText(`FindHotels OK (${Array.isArray(data?.data?.results) ? data.data.results.length : 0} results)`, data);
      } catch (e: any) {
        return errText(`find_hotels failed: ${e.message || String(e)}`);
      }
    }
  );

  // 4) Currencies (GET /currencies)
  server.registerTool(
    {
      name: "currencies_list",
      description: "GET /currencies — list supported currencies (requires locale)",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: {
            type: "object",
            required: ["locale"],
            additionalProperties: false,
            properties: { locale: { type: "string", enum: ["de_DE", "en_DE"] } }
          }
        }
      },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }: { headers?: Record<string, string>; query: AnyRecord }) => {
      try {
        const data = await callApi("GET", "/currencies", { headers, query });
        return okText("Currencies OK", data);
      } catch (e: any) {
        return errText(`currencies_list failed: ${e.message || String(e)}`);
      }
    }
  );

  // 5) Hotels list (GET /hotels)
  server.registerTool(
    {
      name: "hotels_list",
      description: "GET /hotels — paginated hotel list (requires locale; page default 1)",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: {
            type: "object",
            required: ["locale"],
            additionalProperties: false,
            properties: {
              locale: { type: "string", enum: ["de_DE", "en_DE"] },
              page: { type: "integer", minimum: 1 }
            }
          }
        }
      },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }: { headers?: Record<string, string>; query: AnyRecord }) => {
      try {
        const data = await callApi("GET", "/hotels", { headers, query });
        return okText("Hotels OK", data);
      } catch (e: any) {
        return errText(`hotels_list failed: ${e.message || String(e)}`);
      }
    }
  );

  // 6) Hotel offers (POST /hotel/offer)
  server.registerTool(
    {
      name: "hotel_offers",
      description: "POST /hotel/offer — get hotel offers for multiple rooms",
      inputSchema: {
        type: "object",
        required: ["body"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: {
            type: "object",
            required: ["hotelId", "departureDate", "returnDate", "currency", "roomConfigurations", "locale"],
            additionalProperties: true,
            properties: {
              hotelId: { type: "string" },
              departureDate: { type: "string" },
              returnDate: { type: "string" },
              currency: { type: "string" },
              roomConfigurations: { type: "array", items: { type: "object" } },
              locale: { type: "string", enum: ["de_DE", "en_DE"] }
            }
          }
        }
      },
      outputSchema: { type: "object", properties: { data: { type: "object" } } }
    },
    async ({ headers, body }: { headers?: Record<string, string>; body: AnyRecord }) => {
      try {
        const data = await callApi("POST", "/hotel/offer", { headers, body });
        return okText("HotelOffers OK", data);
      } catch (e: any) {
        return errText(`hotel_offers failed: ${e.message || String(e)}`);
      }
    }
  );

  // 7) Hotel reference (GET /hotel-reference)
  server.registerTool(
    {
      name: "hotel_reference",
      description: "GET /hotel-reference — codes, names, rooms",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: {
            type: "object",
            required: ["locale"],
            additionalProperties: false,
            properties: { locale: { type: "string", enum: ["de_DE", "en_DE"] } }
          }
        }
      },
      outputSchema: { type: "array", items: { type: "object" } }
    },
    async ({ headers, query }: { headers?: Record<string, string>; query: AnyRecord }) => {
      try {
        const data = await callApi("GET", "/hotel-reference", { headers, query });
        return okText("HotelReference OK", data);
      } catch (e: any) {
        return errText(`hotel_reference failed: ${e.message || String(e)}`);
      }
    }
  );

  // 8) CRAPI hotel contact (GET /crapi/hotel/contact)
  server.registerTool(
    {
      name: "crapi_hotel_contact",
      description: "GET /crapi/hotel/contact — all hotel contact info",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          query: {
            type: "object",
            required: ["locale"],
            additionalProperties: false,
            properties: { locale: { type: "string", enum: ["de_DE", "en_DE"] } }
          }
        }
      },
      outputSchema: { type: "object", properties: { code: { type: "string" }, contact: { type: "object" } } }
    },
    async ({ headers, query }: { headers?: Record<string, string>; query: AnyRecord }) => {
      try {
        const data = await callApi("GET", "/crapi/hotel/contact", { headers, query });
        return okText("CRAPI HotelContact OK", data);
      } catch (e: any) {
        return errText(`crapi_hotel_contact failed: ${e.message || String(e)}`);
      }
    }
  );

  // 9) Package offer (POST /offer/package)
  server.registerTool(
    {
      name: "package_offer",
      description: "POST /offer/package — create a packaged offer",
      inputSchema: {
        type: "object",
        required: ["body"],
        additionalProperties: false,
        properties: {
          headers: { type: "object", additionalProperties: true },
          body: {
            type: "object",
            required: ["hotelId", "departureDate", "returnDate", "currency", "roomConfigurations", "locale"],
            additionalProperties: true,
            properties: {
              hotelId: { type: "string" },
              departureDate: { type: "string" },
              returnDate: { type: "string" },
              currency: { type: "string" },
              roomConfigurations: { type: "array", items: { type: "object" } },
              locale: { type: "string", enum: ["de_DE", "en_DE"] }
            }
          }
        }
      },
      outputSchema: { type: "object", properties: { offerId: { type: "string" } }, required: ["offerId"] }
    },
    async ({ headers, body }: { headers?: Record<string, string>; body: AnyRecord }) => {
      try {
        const data = await callApi("POST", "/offer/package", { headers, body });
        return okText("PackageOffer OK", data);
      } catch (e: any) {
        return errText(`package_offer failed: ${e.message || String(e)}`);
      }
    }
  );
}
