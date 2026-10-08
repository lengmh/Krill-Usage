import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {fetchSubscription,API_URL} from '../src/api.cjs';
const body=JSON.stringify({success:true,code:0,data:{credit_balance_usd:null,subscriptions:[{subscription_id:'a',plan:{name:'synthetic month',duration_days:30},status:'active',quota:{remaining_usd:null,daily_limit_usd:'100'}}]}});
function transport({status=200,headers={},text=body,network=false,timeout=false,oversized=false}={}) {
 return (url,options,callback)=>{
  assert.equal(url,API_URL);assert.equal(url,'https://www.krill-code.com/api/subscription');assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer synthetic-only');
  assert.equal(options.headers['User-Agent'],'Krill-Usage-Codex/0.1.0');
  const req=new EventEmitter();req.setTimeout=(ms,fn)=>{assert.equal(ms,12000);req.timeout=fn;};req.destroy=(err)=>req.emit('error',err);
  req.end=()=>queueMicrotask(()=>{
   if(network){req.emit('error',new Error('private network internals'));return;}
   if(timeout){req.timeout();return;}
   const res=new EventEmitter();res.statusCode=status;res.headers=headers;callback(res);
   res.emit('data',oversized?Buffer.alloc(2*1024*1024+1):Buffer.from(text));res.emit('end');
  });return req;
 };
}
test('fixed GET normalizes server values and preserves nulls',async()=>{const result=await fetchSubscription('synthetic-only',transport());assert.equal(result.creditBalance,null);assert.equal(result.subscriptions[0].remaining,null);});
test('request distinguishes bounded failures without redirects or sensitive diagnostics',async()=>{
 for(const [options,code] of [[{status:302},'HTTP'],[{status:401},'UNAUTHORIZED'],[{headers:{'cf-mitigated':'challenge'}},'CF_CHALLENGE'],[{text:'broken'},'INVALID_JSON'],[{text:'{}'},'INVALID_RESPONSE'],[{network:true},'NETWORK'],[{timeout:true},'TIMEOUT'],[{oversized:true},'TOO_LARGE']]){
 await assert.rejects(fetchSubscription('synthetic-only',transport(options)),error=>error.code===code&&!error.message.includes('private'));
 }
});

function controlledTransport({responseErrorsOnDestroy=false,requestErrorOnDestroy=true}={}) {
 const req=new EventEmitter(),res=new EventEmitter();let callback;
 res.statusCode=200;res.headers={};req.destroyedErrors=[];
 req.setTimeout=(ms,fn)=>{assert.equal(ms,12000);req.timeout=fn;return req;};
 req.end=()=>{};
 req.destroy=(err)=>{
  req.destroyedErrors.push(err);
  if(responseErrorsOnDestroy){res.emit('aborted');res.emit('error',new Error('private response details'));}
  if(requestErrorOnDestroy)req.emit('error',err);
  return req;
 };
 return {req,res,request:(_url,_options,onResponse)=>{callback=onResponse;return req;},respond:()=>callback(res)};
}

test('absolute deadline expires even when a request never connects or emits an error',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {request,req}=controlledTransport({requestErrorOnDestroy:false});
 const rejected=assert.rejects(fetchSubscription('synthetic-only',request),{code:'TIMEOUT'});
 t.mock.timers.tick(11999);assert.equal(req.destroyedErrors.length,0);
 t.mock.timers.tick(1);await rejected;
 assert.equal(req.destroyedErrors.length,1);assert.equal(req.destroyedErrors[0].code,'TIMEOUT');
 t.mock.timers.tick(12000);assert.equal(req.destroyedErrors.length,1);
});

test('continuous response chunks cannot extend the deadline or replace TIMEOUT during destroy',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {request,req,res,respond}=controlledTransport({responseErrorsOnDestroy:true});
 const rejected=assert.rejects(fetchSubscription('synthetic-only',request),{code:'TIMEOUT'});
 respond();
 for(let elapsed=1000;elapsed<12000;elapsed+=1000){
  t.mock.timers.tick(1000);res.emit('data',Buffer.from(' '));
  assert.equal(req.destroyedErrors.length,0);
 }
 t.mock.timers.tick(999);res.emit('data',Buffer.from(' '));
 assert.equal(req.destroyedErrors.length,0);
 t.mock.timers.tick(1);await rejected;
 assert.equal(req.destroyedErrors.length,1);assert.equal(req.destroyedErrors[0].code,'TIMEOUT');
 req.timeout();res.emit('data',Buffer.from(body));res.emit('end');
 t.mock.timers.tick(12000);assert.equal(req.destroyedErrors.length,1);
});

test('every settlement clears the absolute timer and prevents late destruction',async t=>{
 const cases=[
  ['success',null,({res})=>{res.emit('data',Buffer.from(body));res.emit('end');}],
  ['request error','NETWORK',({req})=>req.emit('error',new Error('private request details'))],
  ['response error','NETWORK',({res})=>res.emit('error',new Error('private response details'))],
  ['response abort','NETWORK',({res})=>res.emit('aborted')],
  ['oversized response','TOO_LARGE',({res})=>res.emit('data',Buffer.alloc(2*1024*1024+1))],
  ['socket timeout','TIMEOUT',({req})=>req.timeout()],
  ['absolute timeout','TIMEOUT',()=>{}]
 ];
 for(const [name,code,finish] of cases)await t.test(name,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const schedules=t.mock.method(globalThis,'setTimeout'),clears=t.mock.method(globalThis,'clearTimeout');
  const control=controlledTransport({responseErrorsOnDestroy:true});
  const pending=fetchSubscription('synthetic-only',control.request);
  const settled=code?assert.rejects(pending,err=>err.code===code&&!err.message.includes('private')):pending;
  control.respond();finish(control);
  if(name==='absolute timeout')t.mock.timers.tick(12000);
  await settled;
  assert.equal(schedules.mock.calls.length,1);assert.equal(schedules.mock.calls[0].arguments[1],12000);
  assert.equal(clears.mock.calls.length,1);assert.equal(clears.mock.calls[0].arguments[0],schedules.mock.calls[0].result);
  const destroys=control.req.destroyedErrors.length;
  t.mock.timers.tick(24000);control.req.timeout();control.res.emit('end');
  assert.equal(control.req.destroyedErrors.length,destroys);assert.equal(clears.mock.calls.length,1);
 });
 for(const stage of ['request','setTimeout','end'])await t.test(`synchronous ${stage} failure`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const schedules=t.mock.method(globalThis,'setTimeout'),clears=t.mock.method(globalThis,'clearTimeout');
  const control=controlledTransport();
  const fail=()=>{throw new Error('private synchronous details');};
  if(stage!=='request')control.req[stage]=fail;
  await assert.rejects(fetchSubscription('synthetic-only',stage==='request'?fail:control.request),{code:'NETWORK',message:'NETWORK'});
  assert.equal(schedules.mock.calls.length,1);assert.equal(clears.mock.calls.length,1);
  assert.equal(clears.mock.calls[0].arguments[0],schedules.mock.calls[0].result);
  t.mock.timers.tick(24000);assert.equal(control.req.destroyedErrors.length,0);
 });
});
