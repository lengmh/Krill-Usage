'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {runCredentialCli}=require('../src/credential-cli.cjs');
function fixture(rememberPassword=true){
 const calls=[];let output='';
 const store={readRevision:async()=>{calls.push('revision');return 'revision-one';},replaceSession:async(...args)=>{calls.push(['save',...args]);}};
 const options={output:{write:s=>output+=s},storeFactory:()=>store,
 loginPrompt:async()=>{calls.push('prompt');return {account:'fake@example.invalid',password:'synthetic-secret',rememberPassword};},
 login:async(account,password)=>{calls.push(['login',account,password]);return 'synthetic-token';},
 fetchUsage:async jwt=>{calls.push(['quota',jwt]);return {};}};
 return {calls,store,options,output:()=>output};
}
for(const remember of [true,false])test(`login stores atomic session with remember=${remember}`,async()=>{
 const f=fixture(remember);assert.equal(await runCredentialCli(['login'],f.options),0);
 assert.deepEqual(f.calls.slice(0,2),['revision','prompt']);
 assert.deepEqual(f.calls.at(-1),['save',{jwt:'synthetic-token',account:'fake@example.invalid',...(remember?{password:'synthetic-secret'}:{})},{expectedRevision:'revision-one'}]);
 assert.equal(f.calls.at(-2)[0],'quota');assert.doesNotMatch(f.output(),/synthetic-secret|synthetic-token|fake@example/);
});
for(const stage of ['loginPrompt','login','fetchUsage'])test(`${stage} failure does not change vault or echo secrets`,async()=>{
 const f=fixture();f.options[stage]=async()=>{throw Object.assign(new Error('synthetic-secret'),{code:'LOGIN_FAILED'});};
 assert.equal(await runCredentialCli(['login'],f.options),1);assert.ok(!f.calls.some(c=>c[0]==='save'));assert.doesNotMatch(f.output(),/synthetic-secret/);
});
test('cancel and changed revision fail safely',async()=>{
 const f=fixture();f.options.loginPrompt=async()=>{throw {code:'CANCELLED'};};assert.equal(await runCredentialCli(['login'],f.options),130);
 const g=fixture();g.store.replaceSession=async()=>{throw {code:'CREDENTIAL_CHANGED'};};assert.equal(await runCredentialCli(['login'],g.options),1);assert.match(g.output(),/changed in another process/);
});
test('login accepts no secret arguments or flags',async()=>{
 const f=fixture();assert.equal(await runCredentialCli(['login','synthetic-secret'],f.options),2);assert.deepEqual(f.calls,[]);assert.doesNotMatch(f.output(),/synthetic-secret/);
});

for(const code of ['UNAUTHORIZED','HTTP','INVALID_RESPONSE'])test(`quota verification ${code} has accurate safe guidance`,async()=>{
 const f=fixture();f.options.fetchUsage=async()=>{throw Object.assign(Error('synthetic-secret'),{code});};
 assert.equal(await runCredentialCli(['login'],f.options),1);assert.ok(!f.calls.some(c=>c[0]==='save'));
 assert.doesNotMatch(f.output(),/Unlock your OS vault|recover --confirm-stopped|synthetic-secret/);
});
