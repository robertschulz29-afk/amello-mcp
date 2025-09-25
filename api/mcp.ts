// api/mcp.ts
// Minimal, tolerant JSON-RPC router for MCP tools on Vercel (no SDK transport).
// - Implements: tools/list, tools/call
// - Accepts: strict JSON-RPC 2.0 *and* tolerant envelopes (method-only, missing jsonrpc/id)
// - Robust body parsing (object/string/Buffer/Uint8Array) with BOM stripping
// - Always returns JSON bodies (even on 4xx)

import { registerAmelloTools } from "./_lib/amelloTools.js";

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
