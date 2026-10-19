import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCredentialStore} from '../src/credentials.cjs';
import {UsageService} from '../src/service.mjs';
const bundle={jwt:'synthetic-old',account:'synthetic@example.invalid',password:'synthetic-password'};
const snapshot={creditBalance:'20',subscriptions:[]};
const denied=()=>Object.assign(new Error('synthetic-private-detail'),{code:'UNAUTHORIZED'});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(t,{login=async()=> 'synthetic-new',fetchUsage=async jwt=>{if(jwt===bundle.jwt) throw denied(); return snapshot;},remember=true}={}) {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'krill-recovery-'));
  let stored=null;const writes=[];
  const entry={getPassword:()=>stored,setPassword:value=>{stored=value;writes.push(value);},deletePassword:()=>{stored=null;}};
  const credentials=createCredentialStore({stateDir,entryFactory:()=>entry});
  await credentials.replaceSession({...bundle,password:remember?bundle.password:undefined});
  const service=new UsageService({credentials,preferences:{read:()=>({refreshIntervalMinutes:3})},login,fetchUsage});
  t.after(()=>{service.dispose();fs.rmSync(stateDir,{recursive:true,force:true});});
  return{credentials,service,writes,entry};
}
test('expired JWT recovers once through password login, persists and retries quota without exposing credentials',async t=>{
  let logins=0;const requested=[];
  const f=await setup(t,{login:async(account,password)=>{logins++;assert.equal(account,bundle.account);assert.equal(password,bundle.password);return 'synthetic-new';},
    fetchUsage:async jwt=>{requested.push(jwt);if(jwt===bundle.jwt)throw denied();return snapshot;}});
  const first=f.service.refresh(); assert.equal(first,f.service.refresh());
  const view=await first;
  assert.equal(logins,1);assert.deepEqual(requested,['synthetic-old','synthetic-new']);
  assert.deepEqual(view.snapshot,snapshot);assert.equal(view.error,null);assert.equal(view.refreshing,false);
  assert.deepEqual(await f.credentials.readSession(),{...bundle,jwt:'synthetic-new'});
  for(const secret of [...Object.values(bundle),'synthetic-new']) assert.ok(!JSON.stringify(view).includes(secret));
  await new Promise(resolve=>setTimeout(resolve,160));
  assert.deepEqual(f.service.view().snapshot,snapshot,'own delayed marker event must not erase fresh result');
});
test('JWT-only and remember-disabled sessions request reauthentication without password login',async t=>{
  let logins=0;const f=await setup(t,{remember:false,login:async()=>{logins++;throw Error('must not run');}});
  assert.equal((await f.service.refresh()).error.code,'UNAUTHORIZED');
  await f.credentials.replace('synthetic-old');
  assert.equal((await f.service.refresh()).error.code,'UNAUTHORIZED');assert.equal(logins,0);
});
test('failed password recovery is bounded across polling refreshes until an owner changes credentials',async t=>{
  let logins=0;const f=await setup(t,{login:async()=>{logins++;throw Object.assign(Error(bundle.password),{code:'LOGIN_FAILED'});}});
  const view=await f.service.refresh(); assert.equal(view.error.code,'LOGIN_FAILED');assert.ok(!JSON.stringify(view).includes(bundle.password));
  await f.service.refresh();await f.service.refresh();assert.equal(logins,1);
  await f.credentials.replaceSession(bundle);await f.service.refresh();assert.equal(logins,2);
});
test('a rejected retry is never a password-login loop, including later panel refreshes',async t=>{
  let logins=0,calls=0;const f=await setup(t,{login:async()=>{logins++;return 'synthetic-new';},fetchUsage:async()=>{calls++;throw denied();}});
  assert.equal((await f.service.refresh()).error.code,'UNAUTHORIZED');assert.equal(logins,1);assert.equal(calls,2);
  await f.service.refresh();assert.equal(logins,1);assert.equal(calls,3);
});
test('clear or switch while password login is pending never resurrects the old account',async t=>{
  for(const clear of [true,false]) {
    const pending=defer();const f=await setup(t,{login:()=>pending.promise});
    const refresh=f.service.refresh();await tick();
    if(clear)await f.credentials.clear();else await f.credentials.replace('synthetic-other');
    pending.resolve('synthetic-new');await refresh;
    assert.equal(await f.credentials.read(),clear?null:'synthetic-other');
    assert.equal(f.service.view().snapshot,null);
  }
});
test('clear queued immediately before renewal CAS prevents the renewal write',async t=>{
  const f=await setup(t);const original=f.credentials.replaceSession;
  f.credentials.replaceSession=(session,options)=>{void f.credentials.clear();return original(session,options);};
  const view=await f.service.refresh();assert.equal(await f.credentials.read(),null);assert.equal(view.snapshot,null);
});
test('late password login failure cannot overwrite new-account result',async t=>{
  const pending=defer();const f=await setup(t,{login:()=>pending.promise});
  const old=f.service.refresh();await tick();
  await f.credentials.replace('synthetic-other');await f.service.read();
  const next=await f.service.refresh();assert.deepEqual(next.snapshot,snapshot);
  pending.reject(Object.assign(Error(bundle.password),{code:'LOGIN_FAILED'}));await old;
  assert.deepEqual(f.service.view().snapshot,snapshot);assert.equal(f.service.view().error,null);
});
test('credential switch while renewed quota is pending discards the old result',async t=>{
  const pending=defer();const f=await setup(t,{fetchUsage:async jwt=>{if(jwt===bundle.jwt)throw denied();return pending.promise;}});
  const old=f.service.refresh();await tick();await f.credentials.clear();pending.resolve(snapshot);
  assert.equal((await old).snapshot,null);assert.equal(await f.credentials.read(),null);
});
test('vault failure during renewal is sanitized and fails closed',async t=>{
  const f=await setup(t);f.entry.setPassword=()=>{throw Error(bundle.password);};
  const view=await f.service.refresh();assert.equal(view.snapshot,null);assert.equal(view.error.code,'SECRET_STORAGE');
  assert.ok(!JSON.stringify(view).includes(bundle.password));assert.equal(view.authenticated,false);
});
test('account change between current() resolution and caller continuation never publishes or uses old credentials',async t=>{
  for(const scenario of [
    {name:'post-session guard',pause:2,recover:false,fetches:0,logins:0,writes:0},
    {name:'final success guard (exact same-turn A/B revision race)',pause:3,recover:false,fetches:1,logins:0,writes:0},
    {name:'unauthorized guard',pause:3,recover:true,fetches:1,logins:0,writes:0},
    {name:'post-login guard',pause:4,recover:true,fetches:1,logins:1,writes:0},
    {name:'post-persist guard',pause:5,recover:true,fetches:1,logins:1,writes:1},
    {name:'final recovered quota guard',pause:6,recover:true,fetches:2,logins:1,writes:1},
    {name:'late failure guard',pause:4,recover:false,fail:true,fetches:1,logins:0,writes:0}
  ]) await t.test(scenario.name,async()=>{
    let calls=0,fetches=0,logins=0,writes=0,revision='account-a';
    const entered=defer(),currentRead=defer(),monitorRead=defer();
    const credentials={
      readRevision:()=>{
        calls++;
        if(calls===scenario.pause){entered.resolve();return currentRead.promise;}
        if(calls===scenario.pause+1)return monitorRead.promise;
        return Promise.resolve(revision);
      },
      readSession:async()=>({...bundle}),
      replaceSession:async()=>{writes++;revision='renewed-account-a';return revision;}
    };
    const service=new UsageService({
      credentials,preferences:{read:()=>({refreshIntervalMinutes:3})},
      login:async()=>{logins++;return 'synthetic-new';},
      fetchUsage:async()=>{fetches++;if(scenario.fail)throw Object.assign(Error('synthetic-failure'),{code:'NETWORK'});if(scenario.recover&&fetches===1)throw denied();return snapshot;}
    });
    const refresh=service.refresh();await entered.promise;
    const monitor=service.read();
    // Both read promises resolve in one turn. current() validates A first,
    // monitor observes B next, before run() resumes from awaiting current().
    currentRead.resolve(revision);monitorRead.resolve('account-b');
    await Promise.all([refresh,monitor]);
    const view=service.view();
    assert.equal(view.snapshot,null);assert.equal(view.authenticated,false);assert.equal(view.error,null);
    assert.equal(fetches,scenario.fetches);assert.equal(logins,scenario.logins);assert.equal(writes,scenario.writes);
    service.dispose();
  });
});
test('concurrent same-account renewal cannot overwrite a winner and can reuse its committed JWT',async t=>{
  const firstLogin=defer(),secondLogin=defer();
  let loginCalls=0;
  const f=await setup(t,{login:()=>{loginCalls++;return firstLogin.promise;}});
  const second=new UsageService({
    credentials:f.credentials,preferences:{read:()=>({refreshIntervalMinutes:3})},
    login:()=>{loginCalls++;return secondLogin.promise;},
    fetchUsage:async jwt=>{if(jwt===bundle.jwt)throw denied();return snapshot;}
  });
  t.after(()=>second.dispose());
  const a=f.service.refresh(),b=second.refresh();await tick();assert.equal(loginCalls,2);
  firstLogin.resolve('synthetic-first-renewal');secondLogin.resolve('synthetic-second-renewal');
  await Promise.all([a,b]);
  const saved=await f.credentials.read();
  assert.equal(saved,'synthetic-first-renewal');
  assert.equal(f.writes.length,2,'one initial record and only one winning renewal');
  const recovered=await second.refresh();assert.deepEqual(recovered.snapshot,snapshot);assert.equal(loginCalls,2);
});
