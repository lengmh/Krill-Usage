"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const { AUTH_SECRET_KEY } = require("../src/constants");

function err(code, status, extras = {}) {
  return Object.assign(new Error(`sensitive:should-not-log`), { code, status, phase: "subscription", ...extras });
}
function snapshot() { return { creditBalance: "31", subscriptions: [] }; }
function setup({ auth = { version: 1, jwt: "old", email: "test@example.invalid", password: "synthetic" },
    shared = new Map(), apiGet, apiLogin, dir, remember = true, timerEvents = false } = {}) {
  if (!shared.has(AUTH_SECRET_KEY)) shared.set(AUTH_SECRET_KEY, JSON.stringify(auth));
  const emitter = new EventEmitter();
  const events = [];
  let remembers = remember;
  const secrets = {
    async get(k) { return shared.get(k); },
    async store(k, v) { shared.set(k, v); emitter.emit("change", { key: k }); },
    async delete(k) { shared.delete(k); emitter.emit("change", { key: k }); },
    onDidChange(listener) { emitter.on("change", listener); return { dispose: () => emitter.off("change", listener) }; }
  };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (k, d) => k === "rememberPassword" ? remembers : k === "refreshIntervalMinutes" ? 3 : d }) },
    window: {
      showErrorMessage() {},
      createOutputChannel() { return { appendLine: line => events.push(line), dispose() {} }; }
    }
  };
  const network = [];
  const api = {
    KrillApiError: class KrillApiError extends Error {
      constructor(code, message, status, info = {}) { super(message); Object.assign(this, { code, status }, info); }
    },
    async fetchSubscription(jwt) { network.push(["get", jwt]); return apiGet ? apiGet(jwt) : snapshot(); },
    async loginWithPassword(e, p) { network.push(["login", e]); return apiLogin ? apiLogin(e, p) : "renewed"; }
  };
  const filename = path.resolve(__dirname, "../src/service.js");
  delete require.cache[filename];
  const realLoad = Module._load;
  Module._load = function(id, parent, main) {
    if (id === "vscode") return vscode;
    if (id === "./api" && parent?.filename === filename) return api;
    return realLoad.apply(this, arguments);
  };
  let Service;
  try { Service = require(filename).KrillUsageService; } finally { Module._load = realLoad; }
  const service = new Service({ secrets, globalStorageUri: dir ? { fsPath: dir } : undefined });
  return { service, shared, events, network, secrets, setRemember: v => remembers = v };
}
const saved = x => JSON.parse(x.shared.get(AUTH_SECRET_KEY));

// A successful login is retained even when the following quota GET fails.
test("auto login succeeds but GET fails twice: retain new JWT and no permanent login block", async () => {
  let allowGet = false;
  const x = setup({ apiGet: async jwt => {
    if (jwt === "old") throw err("UNAUTHORIZED", 401);
    if (!allowGet) throw err("TIMEOUT");
    return snapshot();
  } });
  try {
    assert.equal(await x.service.refresh("auto"), null);
    assert.equal(saved(x).jwt, "renewed");
    assert.equal(x.service.autoLoginBlocked, false);
    assert.equal(x.service.error.code, "TIMEOUT");
    assert.equal(x.service.error.phase, "subscription");
    assert.equal(x.service.error.attempts, 2);
    allowGet = true;
    assert.ok(await x.service.refresh("manual"));
    assert.equal(x.network.filter(e => e[0] === "login").length, 1);
    assert.equal(x.service.error, null);
  } finally { x.service.dispose(); }
});

test("temporary login network fault doesn't block; genuine credential failure does", async () => {
  let attempts = 0;
  const x = setup({ apiGet: async()=> { throw err("UNAUTHORIZED",401); }, apiLogin: async()=> {
    if (++attempts === 1) throw err("NETWORK");
    throw err("LOGIN_FAILED",401,{phase:"login"});
  } });
  try {
    await x.service.refresh("auto");
    assert.equal(x.service.autoLoginBlocked,false);
    assert.equal(x.service.error.code,"NETWORK");
    await x.service.refresh("manual");
    assert.equal(x.service.autoLoginBlocked,true);
    assert.equal(x.service.error.code,"LOGIN_FAILED");
    await x.service.refresh("manual");
    assert.equal(attempts, 2);
  } finally {x.service.dispose();}
});

test("normal GET network error retries once; 429 waits without retry", async () => {
  let gets=0;
  const x=setup({apiGet: async()=> { if(++gets === 1) throw err("NETWORK",null,{networkCode:"ECONNRESET"}); return snapshot(); }});
  try {
    assert.ok(await x.service.refresh("auto"));
    assert.equal(gets,2);
    assert.equal(x.service.error,null);
  } finally{x.service.dispose();}
  const y=setup({apiGet: async()=>{throw err("RATE_LIMIT",429,{retryAfterMs:60000});}});
  try {
    await y.service.refresh("auto");
    assert.equal(y.service.error.code,"RATE_LIMIT");
    assert.equal(y.service.error.status,429);
    assert.ok(y.service.error.nextRetryAt>Date.now());
    await y.service.refresh("focus");
    await y.service.refresh("manual");
    assert.equal(y.network.filter(e=>e[0]==="get").length,1);
  } finally{y.service.dispose();}
});

test("focus after GET failure obeys cooldown rather than sending a flood", async()=>{
  const x=setup({apiGet:async()=>{throw err("HTTP",502);}});
  try {
    await x.service.refresh("auto");
    for(let i=0;i<5;i++) await x.service.refreshIfStale();
    assert.equal(x.network.filter(e=>e[0]==="get").length,2, "one GET plus bounded retry");
  } finally{x.service.dispose();}
});

test("diagnostic Output and view are sanitized with stage, status, retry and safe network code", async()=>{
  const x=setup({apiGet:async()=>{throw err("NETWORK",null,{networkCode:"ECONNRESET"});}});
  try{
    await x.service.refresh("auto");
    assert.equal(x.service.error.networkCode,"ECONNRESET");
    assert.equal(x.service.error.attempts,2);
    assert.ok(x.events.some(x=>x.includes("code=NETWORK")&&x.includes("network=ECONNRESET")));
    assert.ok(x.events.every(x=>!x.includes("sensitive:should-not-log")&&!x.includes("synthetic")));
  }finally{x.service.dispose();}
});

test("external shared-auth clear during GET never publishes old snapshot", async()=>{
  let release, requested;
  const started=new Promise(r=>requested=r);
  const done=new Promise(r=>release=r);
  const shared=new Map();
  const x=setup({shared,apiGet:async()=>{requested();await done;return snapshot();}});
  try{
    const pending=x.service.refresh("auto");await started;
    shared.set(AUTH_SECRET_KEY, JSON.stringify({version:1,jwt:null}));
    release();await pending;
    assert.equal(x.service.snapshot,null);
    assert.equal(x.service.getView().authenticated,false);
  }finally{x.service.dispose();}
});

test("JWT-only startup cleanup failure still starts both refresh timers",async()=>{
  const x=setup({remember:false});
  try {
    x.secrets.delete=async()=>{throw Error("synthetic delete fail");};
    await x.service.initialize();
    assert.ok(x.service.apiTimer);
    assert.ok(x.service.uiTimer);
  }finally{x.service.dispose();}
});

test("cross-window recovery file lock reuses first JWT without second password login",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"krill-lock-test-"));
  const shared=new Map([[AUTH_SECRET_KEY,JSON.stringify({version:1,jwt:"old",email:"a@invalid",password:"fake"})]]);
  let calls=0;
  const arg={shared,dir,apiGet: async jwt=> {if(jwt==="old")throw err("UNAUTHORIZED",401);return snapshot();},
    apiLogin:async()=>{calls++;await new Promise(r=>setTimeout(r,80));return "new-jwt";}};
  const a=setup(arg), b=setup(arg);
  try{
    assert.deepEqual(await Promise.all([a.service.refresh("auto"),b.service.refresh("auto")]),[snapshot(),snapshot()]);
    assert.equal(calls,1);
  }finally{a.service.dispose();b.service.dispose();await fs.rm(dir,{recursive:true,force:true});}
});

test("hover diagnosis includes phase, code, retry and cooldown but not secret",()=>{
  const filename = path.resolve(__dirname, "../src/statusBar.js");
  delete require.cache[filename];
  const realLoad = Module._load;
  Module._load = function(id, parent, main) {
    if (id === "vscode") return {};
    return realLoad.apply(this, arguments);
  };
  let formatFailureDiagnostic;
  try { ({formatFailureDiagnostic} = require(filename)); } finally { Module._load = realLoad; }
  const line=formatFailureDiagnostic({phase:"subscription",code:"RATE_LIMIT",status:429,attempts:1,
    at:Date.now(),elapsedMs:1200,nextRetryAt:Date.now()+60000, jwt:"do-not-show"});
  assert.match(line,/额度 GET.*RATE_LIMIT.*HTTP 429.*下次自动尝试/);
  assert.doesNotMatch(line,/do-not-show/);
});

test("Cloudflare challenge during auto-login requires manual action and never repeats password POST",async()=>{
  let logins=0;
  const x=setup({apiGet: async()=>{throw err("UNAUTHORIZED",401);},
    apiLogin:async()=>{ logins++; throw err("CF_CHALLENGE",403,{phase:"login"}); }});
  try{
    await x.service.refresh("auto");
    assert.equal(x.service.error.code,"CF_CHALLENGE");
    assert.equal(x.service.autoLoginBlocked,true);
    await x.service.refresh("manual");
    await x.service.refresh("auto");
    assert.equal(logins,1);
  }finally{x.service.dispose();}
});
