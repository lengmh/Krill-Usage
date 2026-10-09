import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fetchSubscription } from '../src/api.cjs';
import { UsageService } from '../src/service.mjs';
const defer = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject}; };
const a={creditBalance:'100',subscriptions:[]}, b={creditBalance:'200',subscriptions:[]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(fetchUsage=async()=>a) {
  const state={revision:'a',jwt:'synthetic-account-a',now:1000000};
  const credentials={readRevision:async()=>state.revision, read:async()=>state.jwt};
  const preferences={read:()=>({refreshIntervalMinutes:3})};
  const service=new UsageService({credentials,preferences,fetchUsage,now:()=>state.now});
  return {state,credentials,service};
}
test('deduplicates while reading credentials and preserves freshness',async()=>{
  const pending=defer();let calls=0;const {service,credentials,state}=setup(async()=>{calls++;return a;});
  credentials.read=()=>pending.promise;
  const first=service.refresh(); assert.equal(first,service.refresh());pending.resolve('synthetic-account-a');
  const view=await first;assert.equal(calls,1);assert.equal(view.snapshot,a);assert.equal(view.stale,false);assert.equal(view.refreshing,false);
  state.now+=180000;assert.equal((await service.read()).stale,true);service.dispose();
});
test('failed refresh explicitly retains stale data and sanitizes errors',async()=>{
  let fail=false;const {service}=setup(async()=>{if(fail)throw Object.assign(new Error('secret-token-details'),{code:'NETWORK'});return a;});
  await service.refresh();fail=true;const view=await service.refresh();
  assert.equal(view.snapshot,a);assert.equal(view.stale,true);assert.equal(view.error.code,'NETWORK');assert.ok(!JSON.stringify(view).includes('secret-token'));
});
test('credential switch discards in-flight old success',async()=>{
  const pending=defer();const {service,state}=setup(async jwt=>jwt==='synthetic-account-a'?pending.promise:b);
  const first=service.refresh();await tick();state.revision='b';state.jwt='synthetic-account-b';
  assert.equal((await service.read()).snapshot,null);const next=await service.refresh();assert.equal(next.snapshot,b);
  pending.resolve(a);await first;assert.equal((await service.read()).snapshot,b);
});
test('credential switch discards old error and finally ownership',async()=>{
  const pending=defer();const next=defer();const {service,state}=setup(jwt=>jwt==='synthetic-account-a'?pending.promise:next.promise);
  const first=service.refresh();await tick();state.revision='b';state.jwt='synthetic-account-b';await service.read();
  const second=service.refresh();await tick();pending.reject(Object.assign(new Error('old'),{code:'UNAUTHORIZED'}));await first;
  assert.equal(service.view().refreshing,true);assert.equal(service.view().error,null);next.resolve(b);assert.equal((await second).snapshot,b);
});
test('revision change before request completion never exposes old data',async()=>{
  const pending=defer();const {service,state}=setup(()=>pending.promise);const first=service.refresh();await tick();state.revision='b';pending.resolve(a);
  const view=await first;assert.equal(view.snapshot,null);assert.equal(view.authenticated,false);
});
test('clear credential removes previous snapshot and displays setup state',async()=>{
  const {service,state}=setup();await service.refresh();state.revision='b';state.jwt=null;
  const view=await service.refresh();assert.equal(view.snapshot,null);assert.equal(view.error.code,'NO_JWT');assert.equal(view.lastSuccessAt,0);
});
test('vault failure fails closed and does not return old account data',async()=>{
  const {service,credentials}=setup();await service.refresh();credentials.readRevision=async()=>{throw Error('vault secret internals');};
  const view=await service.read();assert.equal(view.snapshot,null);assert.equal(view.error.code,'SECRET_STORAGE');assert.ok(!JSON.stringify(view).includes('internals'));
});
test('dispose invalidates in-flight request',async()=>{
  const pending=defer();const {service}=setup(()=>pending.promise);const first=service.refresh();await tick();service.dispose();pending.resolve(a);
  assert.equal((await first).snapshot,null);assert.equal((await service.refresh()).snapshot,null);
});
test('vault read failure with readable revision discards retained data',async()=>{
  const {service,credentials}=setup();await service.refresh();credentials.read=async()=>{throw Object.assign(new Error('private vault error'),{code:'SECRET_STORAGE'});};
  const view=await service.refresh();assert.equal(view.snapshot,null);assert.equal(view.authenticated,false);assert.equal(view.error.code,'SECRET_STORAGE');
});

test('HTTP deadline releases refreshing, retains stale cache, and permits a successful retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;const destroyed=[];
  const request=(_url,options,callback)=>{
    assert.equal(options.headers.Authorization,'Bearer synthetic-account-a');
    const attempt=++calls,req=new EventEmitter(),res=new EventEmitter();
    res.statusCode=200;res.headers={};
    req.setTimeout=()=>req;
    req.destroy=err=>{
      destroyed.push(err);res.emit('aborted');res.emit('error',new Error('private response details'));req.emit('error',err);
      return req;
    };
    req.end=()=>queueMicrotask(()=>{
      callback(res);
      if(attempt===2){res.emit('data',Buffer.from(' '));return;}
      res.emit('data',Buffer.from(JSON.stringify({success:true,code:0,data:{
        credit_balance_usd:attempt===1?'100':'200',subscriptions:[]
      }})));
      res.emit('end');
    });
    return req;
  };
  const {service,state}=setup(jwt=>fetchSubscription(jwt,request));
  t.after(()=>service.dispose());
  const initial=await service.refresh();
  assert.deepEqual(initial.snapshot,a);assert.equal(initial.stale,false);
  const pending=service.refresh();assert.equal(pending,service.refresh());
  await tick();assert.equal(calls,2);assert.equal(service.view().refreshing,true);
  t.mock.timers.tick(11999);assert.equal(service.view().refreshing,true);assert.equal(destroyed.length,0);
  state.now+=12000;t.mock.timers.tick(1);
  const timedOut=await pending;
  assert.equal(timedOut.refreshing,false);assert.equal(timedOut.error.code,'TIMEOUT');
  assert.equal(timedOut.snapshot,initial.snapshot);assert.equal(timedOut.stale,true);
  assert.equal(timedOut.lastSuccessAt,initial.lastSuccessAt);assert.equal(timedOut.authenticated,true);
  assert.equal((await service.read()).stale,true);
  const retry=service.refresh();assert.notEqual(retry,pending);assert.equal(retry,service.refresh());
  assert.equal(service.view().refreshing,true);assert.equal(service.view().snapshot,initial.snapshot);assert.equal(service.view().stale,true);
  const recovered=await retry;
  assert.equal(calls,3);assert.deepEqual(recovered.snapshot,b);assert.equal(recovered.refreshing,false);
  assert.equal(recovered.error,null);assert.equal(recovered.stale,false);assert.equal(recovered.lastSuccessAt,state.now);
  t.mock.timers.tick(24000);assert.equal(destroyed.length,1);assert.equal(destroyed[0].code,'TIMEOUT');
});
