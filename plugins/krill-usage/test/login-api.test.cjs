'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {loginWithPassword,LOGIN_URL,fetchSubscription}=require('../src/api.cjs');
function transport({status=200,headers={},json={success:true,code:0,data:{token:'synthetic-jwt'}},text}={}) {
 return (url,options,callback)=>{
  assert.equal(url,LOGIN_URL);assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,undefined);
  assert.equal(options.headers['Content-Type'],'application/json');
  const req=new EventEmitter();let sent;
  req.setTimeout=()=>{};req.destroy=err=>req.emit('error',err);req.write=body=>{sent=Buffer.from(body);};
  req.end=()=>queueMicrotask(()=>{assert.deepEqual(JSON.parse(sent),{email:'fake@example.invalid',password:'synthetic-password'});assert.equal(Number(options.headers['Content-Length']),sent.length);
   const res=new EventEmitter();res.statusCode=status;res.headers=headers;callback(res);res.emit('data',Buffer.from(text??JSON.stringify(json)));res.emit('end');});return req;
 };
}
test('login sends bounded first-party POST without bearer and normalizes JWT',async()=>{
 assert.equal(await loginWithPassword(' fake@example.invalid ','synthetic-password',transport()),'synthetic-jwt');
});
test('login rejects invalid inputs before transport',async()=>{
 for(const [account,password] of [['','x'],['a',''],['a','x'.repeat(4097)],['a\n','x'],['a','x\u0000'],['a','\ud800']])
  await assert.rejects(loginWithPassword(account,password,()=>assert.fail('transport must not run')),{code:'INVALID_CREDENTIALS'});
});
test('login has safe error codes and no response-secret diagnostics',async()=>{
 for(const [options,code] of [[{status:302},'LOGIN_FAILED'],[{status:401},'LOGIN_FAILED'],[{headers:{'cf-mitigated':'challenge'}},'CF_CHALLENGE'],[{text:'private-secret'},'INVALID_JSON'],[{json:{success:false,code:401,message:'private-secret'}},'LOGIN_FAILED'],[{json:{requires_totp:true}},'INTERACTIVE_LOGIN'],[{json:{success:true,code:0,data:{token:'bad\nsecret'}}},'INVALID_LOGIN_RESPONSE'],[{json:{success:true,code:0,data:{}}},'INVALID_LOGIN_RESPONSE']])
  await assert.rejects(loginWithPassword('fake@example.invalid','synthetic-password',transport(options)),e=>e.code===code&&!e.message.includes('private-secret'));
});
test('subscription business 401 triggers the same expiry path',async()=>{
 const request=(_url,_options,callback)=>{const req=new EventEmitter();req.setTimeout=()=>{};req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};callback(res);res.emit('data',Buffer.from('{"code":401}'));res.emit('end');});return req;};
 await assert.rejects(fetchSubscription('synthetic',request),{code:'UNAUTHORIZED'});
});
