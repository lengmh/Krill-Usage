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
