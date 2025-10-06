// CommonJS serverless chat endpoint that:
// 1) fetches MCP tools from /api/mcp
// 2) exposes them to OpenAI's function-calling
// 3) executes tool calls via MCP, loops until final answer

const OPENAI_API_URL = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || "gpt-4o-mini"; // set to your preferred model
const OPENAI_KEY     = process.env.OPENAI_API_KEY;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}
function sendJson(res, status, obj) {
  const str = JSON.stringify(obj);
  res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(str);
}
async function readStreamUtf8(req) {
  const chunks = [];
  return await new Promise((resolve) => {
    req.on?.("data", (c) => chunks.push(Buffer.from(c)));
    req.on?.("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on?.("error", () => resolve(""));
  });
}
async function readJson(req) {
  let raw = "";
  try { raw = await readStreamUtf8(req); } catch { return { err: "Body read error" }; }
  if (!raw) return { err: "Missing body" };
  try { return { obj: JSON.parse(raw) }; } catch { return { err: "Invalid JSON" }; }
}

async function mcpListTools(mcpUrl) {
  const payload = { jsonrpc: "2.0", id: Date.now(), method: "tools/list" };
  const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`MCP tools/list failed: ${json?.error?.message || res.statusText}`);
  return json.result.tools || [];
}
async function mcpCallTool(mcpUrl, name, args) {
  const payload = { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args || {} } };
  const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`MCP tools/call failed: ${json?.error?.message || res.statusText}`);
  return json.result; // { content:[{type:"text",text}], structuredContent?:any, ... }
}

function toOpenAITools(mcpTools) {
  // Map MCP JSON Schemas to OpenAI "function" tools
  return (mcpTools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object" }
    }
  }));
}

async function callOpenAI(tools, messages) {
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
  const body = {
    model: OPENAI_MODEL,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.2
  };
  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${res.statusText} – ${JSON.stringify(json)}`);
  return json;
}

module.exports = async function handler(req, res) {
  try {
    setCors(res);
    if (req.method === "OPTIONS") return res.end();
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });

    const { obj, err } = await readJson(req);
    if (!obj) return sendJson(res, 400, { error: err || "Invalid JSON" });

    const userMessages = Array.isArray(obj?.messages) ? obj.messages : [];
    const systemPrompt = obj?.system || "You are a helpful assistant. Use available tools when helpful.";
    const mcpUrl = process.env.MCP_URL || `https://${req.headers.host}/api/mcp`;

    // 1) load tools from MCP
    const mcpTools = await mcpListTools(mcpUrl);
    const oaTools  = toOpenAITools(mcpTools);

    // 2) run tool loop
    const messages = [{ role: "system", content: systemPrompt }, ...userMessages];
    for (let i = 0; i < 4; i++) {
      const ai = await callOpenAI(oaTools, messages);
      const choice = ai?.choices?.[0];
      const msg = choice?.message;
      if (!msg) break;

      messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });

      const calls = msg.tool_calls || msg.tool_calls?.length ? msg.tool_calls : msg?.tool_calls;
      if (!calls || !calls.length) {
        // final answer
        return sendJson(res, 200, { messages, reply: msg.content || "" });
      }

      // Execute tool calls via MCP
      for (const c of calls) {
        const tname = c.function?.name;
        const targs = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
        let toolResult;
        try {
          toolResult = await mcpCallTool(mcpUrl, tname, targs);
        } catch (e) {
          toolResult = { content: [{ type: "text", text: `Tool error: ${e.message}` }], isError: true };
        }
        // feed back to model as a "tool" message
        messages.push({
          role: "tool",
          tool_call_id: c.id || undefined,
          name: tname,
          content: JSON.stringify(toolResult)
        });
      }
    }

    return sendJson(res, 200, { messages, reply: "(stopped after 4 tool iterations)" });
  } catch (e) {
    console.error("[chat] crash:", e);
    return sendJson(res, 500, { error: e.message || String(e) });
  }
};

