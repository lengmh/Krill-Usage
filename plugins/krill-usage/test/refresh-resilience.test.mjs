import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fetchSubscriptionWithRetry, loginWithPassword, retryAfterMs } from '../src/api.cjs';
import { UsageService } from '../src/service.mjs';
import { normalizePayload, diagnosticText } from '../src/view.mjs';

const responseBody = JSON.stringify({success:true,code:0,data:{credit_balance_usd:'23',subscriptions:[]}});
const snapshot = {creditBalance:'23',subscriptions:[]};
function network(scenarios) {
  const calls = [];
  const request = (url, options, callback) => {
    const scenario = scenarios[calls.length] ?? scenarios.at(-1);
    calls.push({url,method:options.method});
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = error => {req.emit('error',error);return req;};
    req.write = () => {};
    req.end = () => queueMicrotask(() => {
      if (scenario.networkCode) {
        req.emit('error',Object.assign(new Error('PRIVATE NETWORK BODY'),{code:scenario.networkCode}));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = scenario.status ?? 200;
      res.headers = scenario.headers ?? {};
      callback(res);
      res.emit('data',Buffer.from(scenario.body ?? responseBody));
      res.emit('end');
    });
    return req;
  };
  return {request,calls};
}
test('quota GET retries one transient network failure, never retries auth, and sanitizes errors',async()=>{
  const a=network([{networkCode:'ECONNRESET'},{}]);
  const delays=[];
  const result=await fetchSubscriptionWithRetry('private-token',a.request,{delay:async ms=>{delays.push(ms);}});
  assert.equal(result.creditBalance,'23');
  assert.equal(a.calls.length,2);
  assert.deepEqual(a.calls.map(call=>call.method),['GET','GET']);
  assert.deepEqual(delays,[200]);

  const denied=network([{status:401,body:'not json'}]);
  await assert.rejects(fetchSubscriptionWithRetry('private-token',denied.request,{delay:async()=>assert.fail('must not retry')}),
    error=>error.code==='UNAUTHORIZED'&&error.attempts===1);
  assert.equal(denied.calls.length,1);

  const broken=network([{networkCode:'ECONNRESET'},{networkCode:'ECONNRESET'}]);
  await assert.rejects(fetchSubscriptionWithRetry('secret-jwt',broken.request,{delay:async()=>{}}),
    error=>error.code==='NETWORK'&&error.networkCode==='ECONNRESET'&&error.attempts===2&&
      !JSON.stringify(error).includes('PRIVATE NETWORK BODY')&&!JSON.stringify(error).includes('secret-jwt'));
  assert.equal(broken.calls.length,2);
});
test('GET returns accurate HTTP classification, retries 503 HTML only once, and honors 429',async()=>{
  const upstream=network([{status:502,body:'<html>gateway down</html>'},{status:503,body:'<html>unavailable</html>'}]);
  await assert.rejects(fetchSubscriptionWithRetry('synthetic',upstream.request,{delay:async()=>{}}),
    error=>error.code==='HTTP'&&error.status===503&&error.attempts===2);
  assert.equal(upstream.calls.length,2);

  const limited=network([{status:429,body:'<html>rate limited</html>',headers:{'retry-after':'17'}}]);
  await assert.rejects(fetchSubscriptionWithRetry('synthetic',limited.request,{delay:async()=>assert.fail('429 must not retry')}),
    error=>error.code==='RATE_LIMIT'&&error.status===429&&error.retryAfterMs===17000&&error.attempts===1);
  assert.equal(limited.calls.length,1);
  assert.equal(retryAfterMs('600'),300000);
  assert.equal(retryAfterMs('not-a-time'),null);
});
test('password POST is never a retry; 5xx login errors remain transient and classified',async()=>{
  const login=network([{status:503,body:'<html>offline</html>'}]);
  await assert.rejects(loginWithPassword('fake@example.invalid','redacted',login.request),
    error=>error.code==='HTTP'&&error.status===503);
  assert.deepEqual(login.calls.map(call=>call.method),['POST']);
});
test('rate-limit cooldown retains the last good snapshot and does not send another GET early',async()=>{
  let now=1000000, calls=0;
  const service=new UsageService({
    credentials:{readRevision:async()=> 'one',readSession:async()=>({jwt:'synthetic'})},
    preferences:{read:()=>({refreshIntervalMinutes:3})},
    now:()=>now,
    fetchUsage:async()=>{
      calls++;
      if(calls===2)throw Object.assign(new Error('private response'),{code:'RATE_LIMIT',status:429,retryAfterMs:30000});
      return snapshot;
    }
  });
  assert.deepEqual((await service.refresh()).snapshot,snapshot);
  now+=1000;
  const failed=await service.refresh();
  assert.equal(failed.error.code,'RATE_LIMIT');
  assert.equal(failed.error.diagnostic.status,429);
  assert.equal(failed.snapshot,snapshot);
  now+=1000;
  const skipped=await service.refresh();
  assert.equal(calls,2);
  assert.equal(skipped.error.code,'RATE_LIMIT');
  assert.ok(skipped.error.diagnostic.retryAfterMs>0);
  now+=30000;
  const recovered=await service.refresh();
  assert.equal(calls,3);
  assert.equal(recovered.error,null);
  service.dispose();
});
test('transient password login fault can recover after bounded pause without looping',async()=>{
  let now=1000000, loginCalls=0, revision='old', jwt='expired';
  const service=new UsageService({
    credentials:{
      readRevision:async()=>revision,
      readSession:async()=>({jwt,account:'fake@example.invalid',password:'private-secret'}),
      replaceSession:async(next,{expectedRevision})=>{
        assert.equal(expectedRevision,revision);
        jwt=next.jwt;revision='renewed';return revision;
      }
    },
    preferences:{read:()=>({refreshIntervalMinutes:3})},
    now:()=>now,
    fetchUsage:async token=>{
      if(token==='expired')throw Object.assign(new Error('expired'),{code:'UNAUTHORIZED'});
      return snapshot;
    },
    login:async()=>{
      loginCalls++;
      if(loginCalls===1)throw Object.assign(new Error('private-secret'),{code:'NETWORK'});
      return 'renewed-token';
    }
  });
  const first=await service.refresh();
  assert.equal(first.error.code,'NETWORK');
  assert.equal(first.error.diagnostic.phase,'login');
  assert.ok(!JSON.stringify(first).includes('private-secret'));
  now+=1000;
  assert.equal((await service.refresh()).error.code,'LOGIN_COOLDOWN');
  assert.equal(loginCalls,1);
  now+=15000;
  const recovered=await service.refresh();
  assert.equal(loginCalls,2);
  assert.deepEqual(recovered.snapshot,snapshot);
  assert.equal(recovered.error,null);
  service.dispose();
});
test('the displayed failure diagnostic is allowlisted and excludes credentials',()=>{
  const raw={error:{code:'NETWORK',message:'网络连接失败',diagnostic:{
    phase:'quota',status:503,networkCode:'ECONNRESET',attempts:2,
    elapsedMs:1250,at:1760000000000,password:'private-secret',jwt:'private-token'
  }}};
  const safe=normalizePayload({view:raw}).view.error;
  const line=diagnosticText(safe);
  assert.match(line,/额度 GET/);assert.match(line,/HTTP 503/);
  assert.match(line,/ECONNRESET/);assert.match(line,/2 次尝试/);
  assert.ok(!JSON.stringify(safe).includes('private-secret'));
  assert.ok(!JSON.stringify(safe).includes('private-token'));
  assert.equal(normalizePayload({view:{error:{code:'HTTP',message:'retry'}}}).view.error.diagnostic,null);
});

test('Cloudflare verification pauses automatic password replay until owner changes credentials', async()=>{
  let revision='initial', loginCalls=0;
  const service=new UsageService({
    credentials:{
      readRevision:async()=>revision,
      readSession:async()=>({jwt:'expired',account:'fake@example.invalid',password:'private-secret'}),
      replaceSession:async()=>{throw new Error('Cloudflare sign-in never reaches persistence');}
    },
    preferences:{read:()=>({refreshIntervalMinutes:3})},
    fetchUsage:async()=>{throw Object.assign(new Error('expired'),{code:'UNAUTHORIZED'});},
    login:async()=>{
      loginCalls++;
      throw Object.assign(new Error('private challenge details'),{code:'CF_CHALLENGE'});
    }
  });
  const first=await service.refresh();
  assert.equal(first.error.code,'CF_CHALLENGE');
  await service.refresh();
  assert.equal(loginCalls,1,'challenge must not cause repeated password POSTs');
  revision='new-authorized-identity';
  await service.refresh();
  assert.equal(loginCalls,2,'explicit credential revision permits a new attempt');
  service.dispose();
});
