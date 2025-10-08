// api/mcp.js
// Compatible JSON-RPC + plain JSON bridge for Amello MCP on Vercel.

const API_BASE   = process.env.API_BASE   || "https://prod-api.amello.plusline.net/api/v1";
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, HEAD, OPTIONS");
}
function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(s).toString());
  res.end(s);
}
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError  = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, data } });

function isTypedArray(x){return x&&typeof x==="object"&&typeof x.byteLength==="number"&&typeof x.BYTES_PER_ELEMENT==="number";}
function stripBOM(s){return s&&s.charCodeAt(0)===0xFEFF?s.slice(1):s;}

async function readStreamUtf8(req){
  const chunks=[];
  return await new Promise(r=>{
    req.on?.("data",c=>chunks.push(Buffer.from(c)));
    req.on?.("end",()=>r(Buffer.concat(chunks).toString("utf8")));
    req.on?.("error",()=>r(""));
  });
}
async function getJsonBody(req){
  if(req.method!=="POST")return{obj:undefined};
  if(req.body&&typeof req.body==="object"&&!Buffer.isBuffer(req.body)&&!isTypedArray(req.body)){
    return{obj:req.body,preview:JSON.stringify(req.body).slice(0,160)};
  }
  try{
    const s=stripBOM(await readStreamUtf8(req));
    return{obj:JSON.parse(s),preview:s.slice(0,160)};
  }catch{return{err:"Invalid JSON"};}
}

function normalizeReq(x){
  if(!x||typeof x!=="object")return null;
  if(typeof x.method==="string"){return{x};}
  // 👇 allow plain {name,arguments} or {jsonrpc:'2.0',params:{...}}
  if(x.name){
    return{
      jsonrpc:"2.0",
      id:1,
      method:"tools/call",
      params:{name:x.name,arguments:x.arguments||{}}
    };
  }
  if(x.params?.name && !x.method){
    return{
      jsonrpc:"2.0",
      id:1,
      method:"tools/call",
      params:x.params
    };
  }
  return null;
}

/* ---------- existing helper + registry + tool definitions (unchanged) ---------- */
function buildUrl(route){
  const routePath=route?.startsWith("/")?route:`/${route||""}`;
  try{
    const parsed=new URL(API_BASE);
    const origin=parsed.origin;
    const basePath=parsed.pathname.replace(/\/$/,"");
    return origin+basePath+routePath;
  }catch{return(API_BASE.replace(/\/$/,"")+routePath);}
}
function bearerHeaders(){
  const t=process.env.AMELLO_API_TOKEN;
  return t?{Authorization:`Bearer ${t}`}:{};
}
async function callApi(method,route,args={}){
  const url=buildUrl(route);
  const query=args.query||{};
  const headers={
    Accept:"application/json",
    "Content-Type":"application/json",
    ...bearerHeaders(),
    ...(args.headers||{})
  };
  const urlObj=new URL(url);
  Object.entries(query).forEach(([k,v])=>{
    if(v===undefined||v===null)return;
    urlObj.searchParams.set(k,String(v));
  });
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  const init={method:String(method||"GET").toUpperCase(),headers,signal:controller.signal};
  if(init.method!=="GET"&&init.method!=="HEAD"&&args.body!==undefined){
    init.body=(typeof args.body==="string")?args.body:JSON.stringify(args.body);
  }
  console.log("[mcp:debug] OUTBOUND",{url:urlObj.toString(),method:init.method});
  try{
    const res=await fetch(urlObj.toString(),init);
    const text=await res.text();
    if(!res.ok)throw new Error(`HTTP ${res.status} ${res.statusText} – ${text}`);
    try{return JSON.parse(text);}catch{return text;}
  }finally{clearTimeout(timer);}
}
function makeRegistry(){const tools=[];const register=(m,h)=>{tools.push({...m,handler:h});};return{tools,registerTool:register,tool:register};}
function okText(text,data){const blocks=[{type:"text",text}];return data!==undefined?{content:blocks,structuredContent:data}:{content:blocks};}
fun
