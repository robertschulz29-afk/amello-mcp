// api/mcp.js
// Full Amello MCP endpoint for Vercel
// Handles JSON-RPC 2.0 and plain {name,arguments} requests.

const API_BASE = process.env.API_BASE || "https://prod-api.amello.plusline.net/api/v1";
const TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 30000);

/* ---------- helpers ---------- */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
}
function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(s));
  res.end(s);
}
const rpcResult = (id, r) => ({ jsonrpc: "2.0", id: id ?? null, result: r });
const rpcError  = (id, c, m, d) => ({ jsonrpc: "2.0", id: id ?? null, error: { code: c, message: m, data: d } });

function stripBOM(s){return s&&s.charCodeAt(0)===0xFEFF?s.slice(1):s;}
async function readStreamUtf8(req){
  const chunks=[]; return await new Promise(r=>{
    req.on?.("data",c=>chunks.push(Buffer.from(c)));
    req.on?.("end",()=>r(Buffer.concat(chunks).toString("utf8")));
    req.on?.("error",()=>r("");
  ));
}
async function getJsonBody(req){
  if(req.method!=="POST")return{obj:undefined};
  if(req.body&&typeof req.body==="object"&&!Buffer.isBuffer(req.body))
    return{obj:req.body};
  try{const s=stripBOM(await readStreamUtf8(req));return{obj:JSON.parse(s)};}
  catch{return{err:"Invalid JSON"};}
}

/* ---------- request normalization ---------- */
function normalizeReq(x){
  if(!x||typeof x!=="object")return null;
  if(typeof x.method==="string")return x; // already JSON-RPC
  if(x.name)
    return{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:x.name,arguments:x.arguments||{}}};
  if(x.params?.name&&!x.method)
    return{jsonrpc:"2.0",id:1,method:"tools/call",params:x.params};
  return null;
}

/* ---------- outbound API helpers ---------- */
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
    meta.inputSchema=meta.inputSchema??{type:"object"};
    meta.outputSchema=meta.outputSchema??{type:"object"};
    tools.push({...meta,handler});
  };
  return{tools,registerTool:register,tool:register};
}
function okText(text,data){const blocks=[{type:"text",text}];return data!==undefined?{content:blocks,structuredContent:data}:{content:blocks};}
function errText(m){return{content:[{type:"text",text:m}],isError:true};}

const registry=makeRegistry();
const server=registry;

/* ---------- TOOL DEFINITIONS (Part 1) ---------- */

// ping
server.registerTool(
  { name:"ping", description:"Health check: returns pong" },
  async()=>okText("pong",{ok:true,message:"pong"})
);

// booking_search
server.registerTool(
  {
    name:"booking_search",
    description:"GET /booking/search — bookingReferenceNumber + email + locale",
    inputSchema:{
      type:"object",required:["query"],
      properties:{
        headers:{type:"object",additionalProperties:true},
        query:{
          type:"object",
          required:["bookingReferenceNumber","email","locale"],
          properties:{
            bookingReferenceNumber:{type:"string"},
            email:{type:"string"},
            locale:{type:"string",enum:["de_DE","en_DE"]}
          }
        }
      }
    }
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const query=args?.query??{};
      const data=await callApi("GET","/booking/search",{headers,query});
      return okText("BookingSearch OK",data);
    }catch(e){return errText(`booking_search failed: ${e.message}`);}
  }
);

// booking_cancel
server.registerTool(
  {
    name:"booking_cancel",
    description:"POST /booking/cancel — cancel booking",
    inputSchema:{
      type:"object",required:["body"],
      properties:{
        headers:{type:"object",additionalProperties:true},
        body:{
          type:"object",
          required:["itineraryNumber","bookingNumber","email","locale"],
          properties:{
            itineraryNumber:{type:"string"},
            bookingNumber:{type:"string"},
            email:{type:"string"},
            locale:{type:"string",enum:["de_DE","en_DE"]}
          }
        }
      }
    }
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const body=args?.body??{};
      const data=await callApi("POST","/booking/cancel",{headers,body});
      return okText("BookingCancel OK",data);
    }catch(e){return errText(`booking_cancel failed: ${e.message}`);}
  }
);

// find_hotels
server.registerTool(
  {
    name:"find_hotels",
    description:"POST /find-hotels — find hotels by destination/dates/locale",
    inputSchema:{type:"object",required:["body"],properties:{headers:{type:"object"},body:{type:"object"}}}
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const body=args?.body??{};
      const data=await callApi("POST","/find-hotels",{headers,body});
      return okText("FindHotels OK",data);
    }catch(e){return errText(`find_hotels failed: ${e.message}`);}
  }
);
// currencies_list  (fixed output schema)
server.registerTool(
  {
    name:"currencies_list",
    description:"GET /currencies — list currencies for locale",
    inputSchema:{
      type:"object",
      required:["query"],
      properties:{
        query:{
          type:"object",
          required:["locale"],
          properties:{locale:{type:"string"}}
        }
      }
    },
    outputSchema:{
      type:"object",
      required:["data"],
      properties:{
        data:{
          type:"array",
          items:{
            type:"object",
            required:["code","name","symbol"],
            properties:{
              code:{type:"string"},
              name:{type:"string"},
              symbol:{type:"string"},
              favorite:{type:"boolean"},
              decimalPlaces:{type:"integer"}
            }
          }
        }
      }
    }
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const query=args?.query??{};
      const data=await callApi("GET","/currencies",{headers,query});
      const list=Array.isArray(data)?data:(data?.data||[]);
      return okText(`Currencies OK (${list.length})`,{data:list});
    }catch(e){return errText(`currencies_list failed: ${e.message}`);}
  }
);

// hotels_list
server.registerTool(
  {
    name:"hotels_list",
    description:"GET /hotels — paginated hotel list (locale required)",
    inputSchema:{type:"object",required:["query"],properties:{query:{type:"object",required:["locale"],properties:{locale:{type:"string"},page:{type:"integer"}}}}}
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const query=args?.query??{};
      const data=await callApi("GET","/hotels",{headers,query});
      return okText("Hotels OK",data);
    }catch(e){return errText(`hotels_list failed: ${e.message}`);}
  }
);

// hotel_offers
server.registerTool(
  {
    name:"hotel_offers",
    description:"POST /hotel/offer — get hotel offers for multiple rooms",
    inputSchema:{type:"object",required:["body"],properties:{body:{type:"object",additionalProperties:true}}}
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const body=args?.body??{};
      const data=await callApi("POST","/hotel/offer",{headers,body});
      return okText("HotelOffers OK",data);
    }catch(e){return errText(`hotel_offers failed: ${e.message}`);}
  }
);

// hotel_reference
server.registerTool(
  {
    name:"hotel_reference",
    description:"GET /hotel-reference — hotel codes, names, rooms",
    inputSchema:{type:"object",required:["query"],properties:{query:{type:"object",required:["locale"],properties:{locale:{type:"string"}}}}}
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const query=args?.query??{};
      const data=await callApi("GET","/hotel-reference",{headers,query});
      return okText("HotelReference OK",data);
    }catch(e){return errText(`hotel_reference failed: ${e.message}`);}
  }
);

// crapi_hotel_contact
server.registerTool(
  {
    name:"crapi_hotel_contact",
    description:"GET /crapi/hotel/contact — all hotel contact info",
    inputSchema:{type:"object",required:["query"],properties:{query:{type:"object",required:["locale"],properties:{locale:{type:"string"}}}}}
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const query=args?.query??{};
      const data=await callApi("GET","/crapi/hotel/contact",{headers,query});
      return okText("CRAPI HotelContact OK",data);
    }catch(e){return errText(`crapi_hotel_contact failed: ${e.message}`);}
  }
);

// package_offer
server.registerTool(
  {
    name:"package_offer",
    description:"POST /offer/package — create packaged offer",
    inputSchema:{type:"object",required:["body"],properties:{body:{type:"object",additionalProperties:true}}}
  },
  async(args)=>{
    try{
      const headers=args?.headers??{};
      const body=args?.body??{};
      const data=await callApi("POST","/offer/package",{headers,body});
      return okText("PackageOffer OK",data);
    }catch(e){return errText(`package_offer failed: ${e.message}`);}
  }
);

/* ---------- RPC core ---------- */
async function handleRpcSingle(reqObj){
  const {id,method,params}=reqObj;
  if(method==="tools/list"){
    const list=server.tools.map(t=>({name:t.name,description:t.description}));
    return rpcResult(id,{tools:list});
  }
  if(method==="tools/call"){
    const name=params?.name;
    const args=params?.arguments||{};
    const tool=server.tools.find(t=>t.name===name);
    if(!tool) return rpcError(id,-32601,`Tool not found: ${name}`);
    try{
      const out=await tool.handler(args);
      return rpcResult(id,out);
    }catch(e){
      console.error("[mcp] tool error",e);
      return rpcError(id,-32603,"Tool execution error",e.message||String(e));
    }
  }
  return rpcError(id,-32601,`Unknown method: ${method}`);
}
/* ---------- MAIN HANDLER ---------- */
module.exports=async function handler(req,res){
  try{
    setCors(res);
    if(req.method==="OPTIONS"||req.method==="HEAD"){res.statusCode=204;return res.end();}
    if(req.method==="GET"){
      return sendJson(
        res,
        200,
        {ok:true,message:"MCP endpoint ready",tools:server.tools.map(t=>({name:t.name,description:t.description}))}
      );
    }
    if(req.method!=="POST")
      return sendJson(res,405,rpcError(null,-32601,"Method not allowed"));

    const {obj,err}=await getJsonBody(req);
    if(err) return sendJson(res,400,rpcError(null,-32700,"Parse error",err));

    const normalized=normalizeReq(obj);
    if(!normalized) return sendJson(res,400,rpcError(null,-32600,"Invalid Request"));

    const out=await handleRpcSingle(normalized);
    return sendJson(res,200,out);
  }catch(e){
    console.error("[mcp] crash",e);
    return sendJson(res,500,rpcError(null,-32603,"Internal error",e.message||String(e)));
  }
};
