// api/mcp.ts
// Minimal, tolerant JSON-RPC router for MCP tools on Vercel (no SDK transport).
// - Implements: tools/list, tools/call
// - Robust body parsing (object/string/Buffer/Uint8Array) with BOM stripping
// - Always returns JSON bodies (even on 4xx/5xx)
// - IMPORTANT: dynamically imports amelloTools *inside* the handler to avoid top-level crashes.

type ToolOptions = {
  name: string;
  description?: string;
  inputSchema?: any;
  outputSchema?: any;
};
type ToolHandler = (args: any) => Promise<any> | any;
type ToolEntry = ToolOptions & { handler: ToolHandler };

/* -------------------- CORS & response helpers -------------------- */
function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
}
function sendJson(res: any, status: number, obj: any) {
  const str = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(str).toString());
  res.end(str);
}

/* -------------------- request body helpers -------------------- */
const isTypedArray = (x: any): x is Uint8Array =>
  x && typeof x === "object" && typeof (x as any).byteLength === "number" && typeof (x as any).BYTES_PER_ELEMENT === "number";

const stripBOM = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

async function readStreamUtf8(req: any): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  return await new Promise<string | undefined>((resolve) => {
    req.on?.("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on?.("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      resolve(s.length ? s : undefined);
    });
    req.on?.("error", () => resolve(undefined));
  });
}

async function getJsonBody(req: any): Promise<{ obj?: any; err?: string; preview?: string }> {
  if (req.method !== "POST") return {};
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  // 1) Already-parsed JSON from Vercel
  if (ct.includes("application/json") && req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !isTypedArray(req.body)) {
    try { return { obj: req.body, preview: JSON.stringify(req.body).slice(0, 160) }; }
    catch { return { err: "Could not serialize parsed JSON body" }; }
  }

  // 2) String / Buffer / Uint8Array in req.body
  if (req.body != null) {
    try {
      let s: string | undefined;
      if (typeof req.body === "string") s = req.body;
      else if (Buffer.isBuffer(req.body)) s = req.body.toString("utf8");
      else if (isTypedArray(req.body)) s = Buffer.from(req.body).toString("utf8");
      if (s != null) {
        s = stripBOM(s);
        const obj = JSON.parse(s);
        return { obj, preview: s.slice(0, 160) };
      }
    } catch { return { err: "Invalid JSON in req.body" }; }
  }

  // 3) Fallback: read stream
  const fromStream = await readStreamUtf8(req);
  if (fromStream != null) {
    try {
      const s = stripBOM(fromStream);
      const obj = JSON.parse(s);
      return { obj, preview: s.slice(0, 160) };
    } catch { return { err: "Invalid JSON in request stream" }; }
  }

  return { err: "Missing request body" };
}

/* -------------------- Tool registry shim -------------------- */
function captureTools(registerFn: (serverLike: any) => void): ToolEntry[] {
  const tools: ToolEntry[] = [];
  const register = (opts: ToolOptions, handler: ToolHandler) => {
    if (!opts?.name || typeof handler !== "function") throw new Error("registerTool requires {name,...} and a handler(args)=>result");
    tools.push({ ...opts, handler });
  };
  const serverLike = {
    registerTool: register,
    tool: register, // alias (covers both styles)
    onNotification: () =
