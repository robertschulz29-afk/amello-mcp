import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MCP_URL =
  process.env.MCP_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/mcp` : "");

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!MCP_URL) throw new Error("Missing MCP_URL or VERCEL_URL");

type JsonRpcId = string | number;
interface JsonRpcRequest { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: any }
interface JsonRpcResponse { jsonrpc: "2.0"; id: JsonRpcId; result?: any; error?: { code: number; message: string; data?: any } }

async function rpc(method: string, params?: any, timeoutMs = 30000) {
  const body: JsonRpcRequest = { jsonrpc: "2.0", id: Date.now(), method, params };
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Spec requires client to list both
      "Accept": "application/json, text/event-stream",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body),
    signal: ac.signal
  }).catch((e) => { clearTimeout(to); throw e; });
  clearTimeout(to);
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as JsonRpcResponse;
  if (json.error) throw new Error(`MCP ${json.error.code}: ${json.error.message}`);
  return json.result;
}

function toOpenAITools(mcpTools: any[]) {
  return mcpTools.map((t) => {
    const params = (t.inputSchema && typeof t.inputSchema === "object")
      ? { type: "object", properties: (t.inputSchema.properties ?? {}), required: t.inputSchema.required ?? [] }
      : { type: "object", properties: {} };
    if (params.properties?.headers) delete params.properties.headers;
    return { type: "function", function: { name: t.name, description: t.description ?? "", parameters: params } };
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { message, history = [] } = (req.body ?? {}) as {
    message: string; history?: Array<{ role: "user" | "assistant"; content: string }>
  };
  if (!message || typeof message !== "string") return res.status(400).json({ error: "Message is required" });

  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Try to load tools; if it fails, fall back to no tools.
    let oaTools: any[] = [];
    try {
      const list = await rpc("tools/list");
      const tools = Array.isArray(list?.tools) ? list.tools : [];
      oaTools = toOpenAITools(tools);
    } catch (e: any) {
      console.warn("[chat] MCP tools unavailable:", e?.message || e);
      oaTools = []; // fallback
    }

    // First pass (LLM may or may not request tools)
    const pass1 = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You can call tools via MCP when available. Be concise and precise." },
        ...history,
        { role: "user", content: message }
      ],
      tools: oaTools.length ? oaTools : undefined,
      tool_choice: oaTools.length ? "auto" : undefined,
      temperature: 0.2
    });

    let msg = pass1.choices[0].message;

    // If tools available and requested, execute them and do a second pass.
    if (oaTools.length && msg.tool_calls?.length) {
      const toolResults: any[] = [];
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args: any = {};
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch {}
        try {
          const result = await rpc("tools/call", { name, arguments: args });
          toolResults.push({ tool_call_id: call.id, role: "tool", name, content: JSON.stringify(result?.structuredContent ?? result, null, 2) });
        } catch (e: any) {
          toolResults.push({ tool_call_id: call.id, role: "tool", name, content: `Tool call failed: ${e?.message || e}` });
        }
      }
      const pass2 = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: "You can call tools via MCP when available. Be concise and precise." },
          ...history,
          { role: "user", content: message },
          msg as any,
          ...toolResults as any
        ],
        temperature: 0.1
      });
      msg = pass2.choices[0].message;
    }

    res.json({ reply: msg.content, raw: msg });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
