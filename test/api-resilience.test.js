"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const http=require("node:http");
const Module=require("node:module");
const path=require("node:path");
function fixture(transport){
  const filename=path.resolve(__dirname,"../src/api.js");
  delete require.cache[filename];
  const original=Module._load;
  Module._load=function(name,parent,isMain){
    if(name==="node:https"&&parent?.filename===filename)return transport;
    return original.apply(this,arguments);
  };
  try{return require(filename);}finally{Module._load=original;}
}
function fake(reply){return {request(_url,_opts,cb){
  const req=new EventEmitter();req.write=()=>{};
  req.end=()=>queueMicrotask(()=>{
    if(reply.network){req.emit("error",Object.assign(new Error("private body"),{code:reply.network}));return;}
    const res=new EventEmitter();res.statusCode=reply.status??200;res.headers=reply.headers??{};
    cb(res);res.emit("data",Buffer.from(reply.body??"{}"));res.emit("end");
  });
  req.destroy=()=>{};
  return req;
}};}

for(const status of [429,502,503,403,302])test(`non-JSON HTTP ${status} preserves status and avoids invalid JSON`,async()=>{
  const api=fixture(fake({status,body:"<html>edge</html>",headers:{"retry-after":"62"}}));
  await assert.rejects(api.fetchSubscription("dummy"),e=>{
    assert.equal(e.status,status);
    assert.notEqual(e.code,"INVALID_JSON");
    if(status===429){assert.equal(e.code,"RATE_LIMIT");assert.equal(e.retryAfterMs,62000);}
    return true;
  });
});

test("real 401 triggers recovery, 403 challenge doesn't",async()=>{
  const a=fixture(fake({status:401,body:"Unauthorized"}));
  await assert.rejects(a.fetchSubscription("dummy"),e=>e.code==="UNAUTHORIZED");
  const b=fixture(fake({status:403,headers:{"cf-mitigated":"challenge"},body:"<html>challenge</html>"}));
  await assert.rejects(b.fetchSubscription("dummy"),e=>e.code==="CF_CHALLENGE");
});

test("network diagnostics allowlist includes ECONNRESET but never exception message",async()=>{
  const api=fixture(fake({network:"ECONNRESET"}));
  await assert.rejects(api.fetchSubscription("dummy"),e=>e.code==="NETWORK"&&e.networkCode==="ECONNRESET"&&
    !e.message.includes("private body"));
});

test("request deadline is absolute even if server keeps sending data",async()=>{
  const server=http.createServer((_req,res)=>{
    res.writeHead(200);res.write("{");
    const ticker=setInterval(()=>res.write(" "),15);
    res.on("close",()=>clearInterval(ticker));
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const api=fixture({request:(url,options,callback)=>http.request({host:"127.0.0.1",port:server.address().port,
    path:"/",method:options.method,headers:options.headers},callback)});
  try {
    const start=Date.now();
    await assert.rejects(api.requestText("https://www.krill-code.com/api/subscription",{jwt:"dummy",timeoutMs:90}),
      e=>e.code==="TIMEOUT"&&e.phase==="subscription");
    assert.ok(Date.now()-start<230);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test("Retry-After date and malformed values are safe and capped",()=>{
  const api=fixture(fake({}));
  assert.equal(api.retryAfterMs({"retry-after":"not-a-date"}),null);
  assert.equal(api.retryAfterMs({"retry-after":"9999999999"}),3600000);
  assert.equal(api.retryAfterMs({"retry-after":"Thu, 01 Jan 1970 00:00:00 GMT"}),0);
});
