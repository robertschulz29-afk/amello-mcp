// api/mcp.js
// Full Amello MCP endpoint for Vercel
// All tools registered individually for easy editing.

const API_BASE = process.env.API_BASE || "https://prod-api.amello.plusline.net/api/v1";
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

/* ---------- helpers ---------- */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
}
function sendJson(res, status, obj) {
  let s;
  try { s = JSON.stringify(obj); }
  catch (e) {
    console.error("[mcp] JSON stringify failed:", e);
    s = JSON.stringify({ error: "stringify_failed", message: e.message });
    status = 500;
  }
  if (Buffer.byteLength(s) > 5_000_000) {
    s = JSON.stringify({ error: "response_trimmed", size: Buffer.byteLength(s) });
    status = 502;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(s);
}
const rpcResult = (id, r) => ({ jsonrpc: "2.0", id: id ?? null, result: r });
const rpcError  = (id, c, m, d) => ({ jsonrpc: "2.0", id: id ?? null, error: { code: c, message: m, data: d } });

async function readStreamUtf8(req){
  const chunks=[];return await new Promise(r=>{
    req.on?.("data",c=>chunks.push(Buffer.from(c)));
    req.on?.("end",()=>r(Buffer.concat(chunks).toString("utf8")));
    req.on?.("error",()=>r(""));
  });
}
async function getJsonBody(req){
  if(req.method!=="POST")return{obj:undefined};
  if(req.body&&typeof req.body==="object"&&!Buffer.isBuffer(req.body))
    return{obj:req.body};
  try{const s=await readStreamUtf8(req);return{obj:JSON.parse(s)};}
  catch{return{err:"Invalid JSON"};}
}
function normalizeReq(x){
  if(!x||typeof x!=="object")return null;
  if(typeof x.method==="string")return x;
  if(x.name)
    return{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:x.name,arguments:x.arguments||{}}};
  if(x.params?.name&&!x.method)
    return{jsonrpc:"2.0",id:1,method:"tools/call",params:x.params};
  return null;
}

/* ---------- outbound ---------- */
function buildUrl(route){
  const routePath=route?.startsWith("/")?route:`/${route||""}`;
  try{
    const parsed=new URL(API_BASE);
    return parsed.origin+parsed.pathname.replace(/\/$/,"")+routePath;
  }catch{return(API_BASE.replace(/\/$/,"")+routePath);}
}
function bearerHeaders(){
  const t=process.env.AMELLO_API_TOKEN;
  return t?{Authorization:`Bearer ${t}`}:{};
}
async function callApi(method,route,args={}){
  const url=buildUrl(route);
  const query=args.query||{};
  const headers={Accept:"application/json","Content-Type":"application/json",...bearerHeaders(),...(args.headers||{})};
  const urlObj=new URL(url);
  Object.entries(query).forEach(([k,v])=>{if(v!=null)urlObj.searchParams.set(k,String(v));});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  const init={method:String(method||"GET").toUpperCase(),headers,signal:controller.signal};
  if(init.method!=="GET"&&args.body!==undefined) init.body=JSON.stringify(args.body);
  try{
    const res=await fetch(urlObj.toString(),init);
    const text=await res.text();
    if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
    try{return JSON.parse(text);}catch{return text;}
  }finally{clearTimeout(timer);}
}

/* ---------- registry ---------- */
function makeRegistry(){
  const tools=[];
  const register=(meta,handler)=>{
    if(!meta?.name||typeof handler!=="function") throw new Error("registerTool requires meta.name + handler");
    tools.push({...meta,handler});
  };
  return{tools,registerTool:register};
}
function okText(text,data){return{content:[{type:"text",text}],structuredContent:data};}
function errText(m){return{content:[{type:"text",text:m}],isError:true};}

const server = makeRegistry();

/* ---------- TOOLS ---------- */

// 1. ping
server.registerTool(
  { name: "ping", description: "Health check" },
  async () => okText("pong", { ok: true })
);

// 2. currencies_list
server.registerTool(
  { name: "currencies_list", description: "GET /currencies" },
  async (args) => {
    try {
      const data = await callApi("GET", "/currencies", { query: args?.query ?? {} });
      const list = Array.isArray(data) ? data : (data?.data || []);
      const compact = list.map(({ code, name, symbol }) => ({ code, name, symbol }));
      return okText(`Currencies OK (${compact.length})`, { data: compact });
    } catch (e) {
      return errText(`currencies_list failed: ${e.message}`);
    }
  }
);

// 3. hotels_list
server.registerTool(
  { name: "hotels_list", description: "GET /hotels — paginated" },
  async (args) => {
    try {
      const query = args?.query ?? { locale: "en_DE", page: 1 };
      const headers = args?.headers ?? {};
      const data = await callApi("GET", "/hotels", { headers, query });
      const list = Array.isArray(data) ? data : (data?.data || []);
      const sample = list.slice(0, 50).map(h => ({
        code: h.code,
        name: h.name || h.hotelName || h.id,
        city: h.city || h.location || "",
        country: h.country || ""
      }));
      return okText(`Hotels OK (${sample.length}/${list.length})`, { data: sample });
    } catch (e) {
      return errText(`hotels_list failed: ${e.message}`);
    }
  }
);

// 4. list_hotel_collection
server.registerTool(
  { name: "list_hotel_collection", description: "GET /hotels — hotel collection by locale + page" },
  async (args) => {
    try {
      const query = {
        locale: args?.locale || "en_DE",
        page: args?.page || 1
      };
      const headers = args?.headers ?? {};
      const data = await callApi("GET", "/hotels", { headers, query });
      const list = Array.isArray(data) ? data : (data?.data || []);
      const sample = list.slice(0, 50).map(h => ({
        id: h.id || h.code,
        name: h.name || h.hotelName || "",
        city: h.city || h.location || "",
        country: h.country || "",
        brand: h.brand?.name || null,
        category: h.hotelCategory || h.starRating || null
      }));
      return okText(`Hotel collection OK (${sample.length}/${list.length})`, { data: sample });
    } catch (e) {
      return errText(`list_hotel_collection failed: ${e.message}`);
    }
  }
);

// 5. booking_search
server.registerTool(
  { name: "booking_search", description: "placeholder for booking_search" },
  async () => okText("booking_search stub")
);

// 6. booking_cancel
server.registerTool(
  { name: "booking_cancel", description: "placeholder for booking_cancel" },
  async () => okText("booking_cancel stub")
);

// 7. find_hotels
server.registerTool(
  { name: "find_hotels", description: "placeholder for find_hotels" },
  async () => okText("find_hotels stub")
);

// 8. hotel_offers
server.registerTool(
  { name: "hotel_offers", description: "placeholder for hotel_offers" },
  async () => okText("hotel_offers stub")
);

// 9. hotel_reference
server.registerTool(
  { name: "hotel_reference", description: "placeholder for hotel_reference" },
  async () => okText("hotel_reference stub")
);

// 10. crapi_hotel_contact
server.registerTool(
  { name: "crapi_hotel_contact", description: "placeholder for crapi_hotel_contact" },
  async () => okText("crapi_hotel_contact stub")
);

// 11. package_offer
server.registerTool(
  { name: "package_offer", description: "placeholder for package_offer" },
  async () => okText("package_offer stub")
);

/* ---------- RPC ---------- */
async function handleRpcSingle(reqObj){
  const {id,method,params}=reqObj;
  if(method==="tools/list"){
    const list=server.tools.map(t=>({name:t.name,description:t.description}));
    return rpcResult(id,{tools:list});
  }
  if(method==="tools/call"){
    const name=params?.name;const args=params?.arguments||{};
    const tool=server.tools.find(t=>t.name===name);
    if(!tool) return rpcError(id,-32601,`Tool not found: ${name}`);
    try{return rpcResult(id,await tool.handler(args));}
    catch(e){return rpcError(id,-32603,"Tool execution error",e.message);}
  }
  return rpcError(id,-32601,`Unknown method: ${method}`);
}

/* ---------- MAIN ---------- */
module.exports = async function handler(req,res){
  try{
    setCors(res);
    if(req.method==="OPTIONS"||req.method==="HEAD"){res.statusCode=204;return res.end();}
    if(req.method==="GET")return sendJson(res,200,{ok:true,tools:server.tools.map(t=>({name:t.name,description:t.description}))});
    if(req.method!=="POST")return sendJson(res,405,rpcError(null,-32601,"Method not allowed"));
    const {obj,err}=await getJsonBody(req);
    if(err)return sendJson(res,400,rpcError(null,-32700,"Parse error",err));
    const normalized=normalizeReq(obj);
    if(!normalized)return sendJson(res,400,rpcError(null,-32600,"Invalid Request"));
    const out=await handleRpcSingle(normalized);
    return sendJson(res,200,out);
  }catch(e){
    console.error("[mcp] crash",e);
    return sendJson(res,500,rpcError(null,-32603,"Internal error",e.message));
  }
};
