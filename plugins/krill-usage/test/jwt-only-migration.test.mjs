import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCredentialStore, REVISION_FILE} from '../src/credentials.cjs';
import {UsageService} from '../src/service.mjs';
const legacy={version:1,type:'krill-session',jwt:'synthetic-old',account:'synthetic@example.invalid'};
const remembered={...legacy,password:'synthetic-password'};
const snapshot={creditBalance:'20',subscriptions:[]};
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t, initial=JSON.stringify(legacy)) {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'krill-jwt-only-'));
  let value=initial, calls=0;
  const writes=[];
  const entry={getPassword:()=>value,setPassword:v=>{value=v;writes.push(v);},deletePassword:()=>{value=null;}};
  const credentials=createCredentialStore({stateDir,entryFactory:()=>entry});
  const service=new UsageService({credentials,preferences:{read:()=>({refreshIntervalMinutes:3})},fetchUsage:async()=>{calls++;return snapshot;}});
  t.after(()=>{service.dispose();fs.rmSync(stateDir,{recursive:true,force:true});});
  return {credentials,service,entry,writes,stateDir,value:()=>value,calls:()=>calls,inject:v=>{value=v;}};
}
test('new JWT-only records physically omit both fields while invalid supplied account remains rejected',async t=>{
  const f=setup(t);
  await f.credentials.replaceSession({jwt:legacy.jwt,account:legacy.account});
  assert.deepEqual(JSON.parse(f.value()),{version:1,type:'krill-session',jwt:legacy.jwt});
  await assert.rejects(f.credentials.replaceSession({jwt:legacy.jwt,account:'bad\naccount'}),{code:'INVALID_CREDENTIALS'});
  assert.equal(f.writes.length,1);
});
test('pure reads do not migrate; refresh physically deletes account once and preserves own watcher result',async t=>{
  const f=setup(t);
  assert.deepEqual(await f.credentials.readSession(),{jwt:legacy.jwt,account:legacy.account});
  await f.credentials.read();await f.service.read();
  assert.equal(f.writes.length,0);assert.equal(fs.existsSync(path.join(f.stateDir,REVISION_FILE)),false);
  const result=await f.service.refresh();
  assert.deepEqual(result.snapshot,snapshot);assert.equal(result.error,null);
  assert.deepEqual(JSON.parse(f.value()),{version:1,type:'krill-session',jwt:legacy.jwt});
  assert.ok(!f.value().includes(legacy.account));
  const revision=await f.credentials.readRevision();
  await f.credentials.migrateJwtOnly({expectedRevision:revision});await f.service.refresh();
  assert.equal(f.writes.length,1);assert.equal(await f.credentials.readRevision(),revision);
  await new Promise(resolve=>setTimeout(resolve,160));
  assert.deepEqual(f.service.view().snapshot,snapshot);
});
test('raw JWT and remembered sessions remain physically unchanged',async t=>{
  for(const raw of [legacy.jwt,JSON.stringify(remembered),null]) {
    const f=setup(t,raw);await f.service.refresh();
    await f.credentials.migrateJwtOnly({expectedRevision:await f.credentials.readRevision()});
    assert.equal(f.value(),raw);assert.equal(f.writes.length,0);
  }
});
test('queued clear, switch, or remembered login wins before migration CAS',async t=>{
  for(const mutate of [f=>f.credentials.clear(),f=>f.credentials.replace('synthetic-switched'),f=>f.credentials.replaceSession(remembered)]) {
    const f=setup(t),revision=await f.credentials.readRevision();
    const winner=mutate(f),stale=f.credentials.migrateJwtOnly({expectedRevision:revision});
    await winner;const value=f.value(),marker=await f.credentials.readRevision();
    await assert.rejects(stale,{code:'CREDENTIAL_CHANGED'});
    assert.equal(f.value(),value);assert.equal(await f.credentials.readRevision(),marker);
  }
});
test('migration rechecks actual vault record inside lock rather than trusting prior session',async t=>{
  const f=setup(t);await f.credentials.readSession();f.inject(JSON.stringify(remembered));
  await f.credentials.migrateJwtOnly({expectedRevision:'absent'});
  assert.equal(f.writes.length,0);assert.equal(f.value(),JSON.stringify(remembered));
});
test('revision changed during asynchronous locked read aborts without touching vault',async t=>{
  const f=setup(t),pending=defer();f.entry.getPassword=()=>pending.promise;
  const migration=f.credentials.migrateJwtOnly({expectedRevision:'absent'});await tick();
  fs.writeFileSync(path.join(f.stateDir,REVISION_FILE),JSON.stringify({version:1,revision:'11111111-1111-4111-8111-111111111111',phase:'ready'}),{mode:0o600});
  pending.resolve(JSON.stringify(legacy));
  await assert.rejects(migration,{code:'CREDENTIAL_CHANGED'});assert.equal(f.writes.length,0);
});
test('migration lock excludes concurrent stores and permits subsequent owner clear',async t=>{
  const f=setup(t),pending=defer(),get=f.entry.getPassword;
  f.entry.getPassword=()=>pending.promise;
  const migration=f.credentials.migrateJwtOnly({expectedRevision:'absent'});await tick();
  const second=createCredentialStore({stateDir:f.stateDir,entryFactory:()=>f.entry});
  await assert.rejects(second.clear(),{code:'SECRET_STORAGE'});
  f.entry.getPassword=get;pending.resolve(JSON.stringify(legacy));await migration;
  await second.clear();assert.equal(f.value(),null);second.dispose();
});
test('failed, partial, and silently ignored vault writes never publish clean snapshot or ready marker',async t=>{
  for(const failure of ['throw','partial','ignore']) {
    const f=setup(t);
    f.entry.setPassword=v=>{if(failure==='partial')f.inject(v.slice(0,10));if(failure!=='ignore')throw Error(legacy.account);};
    const result=await f.service.refresh();
    assert.equal(result.snapshot,null);assert.equal(result.error.code,'SECRET_STORAGE');assert.equal(result.authenticated,false);
    assert.equal(f.calls(),0);assert.ok(!JSON.stringify(result).includes(legacy.account));
    await assert.rejects(f.credentials.readRevision(),{code:'SECRET_STORAGE'});
  }
});
test('read-back or ready-marker failure leaves migration fail-closed and sanitized',async t=>{
  for(const failure of ['readback','marker']) {
    const f=setup(t),set=f.entry.setPassword;
    f.entry.setPassword=v=>{set(v);if(failure==='readback')f.entry.getPassword=()=>{throw Error(legacy.account);};else {fs.unlinkSync(path.join(f.stateDir,REVISION_FILE));fs.mkdirSync(path.join(f.stateDir,REVISION_FILE),{mode:0o700});}};
    const result=await f.service.refresh();
    assert.equal(result.error.code,'SECRET_STORAGE');assert.equal(result.snapshot,null);assert.equal(f.calls(),0);
    assert.ok(!JSON.stringify(result).includes(legacy.account));
  }
});
test('dispose during locked read prevents migration and late completion cannot publish',async t=>{
  const f=setup(t),pending=defer(),get=f.entry.getPassword;let reads=0;
  f.entry.getPassword=()=>++reads===2?pending.promise:get();
  const refresh=f.service.refresh();await tick();f.service.dispose();pending.resolve(JSON.stringify(legacy));await refresh;
  assert.equal(f.writes.length,0);assert.equal(f.calls(),0);assert.equal(f.service.view().snapshot,null);
});
test('late migration resolution cannot overwrite a newer operation or start an old quota call',async t=>{
  const f=setup(t),pending=defer();
  f.credentials.migrateJwtOnly=()=>pending.promise;
  const old=f.service.refresh();await tick();
  await f.credentials.replace('synthetic-new');f.service.invalidate();
  const next=await f.service.refresh();assert.deepEqual(next.snapshot,snapshot);
  pending.resolve('absent');await old;
  assert.equal(f.calls(),1);assert.deepEqual(f.service.view().snapshot,snapshot);assert.equal(f.service.view().error,null);
});
test('ownership lost between post-migration current resolution and continuation suppresses old quota',async t=>{
  let reads=0,fetches=0;const checked=defer(),monitor=defer(),entered=defer();
  const credentials={readSession:async()=>({...legacy}),migrateJwtOnly:async()=> 'migrated',readRevision:()=>{
    reads++;if(reads===3){entered.resolve();return checked.promise;}if(reads===4)return monitor.promise;
    return Promise.resolve('absent');
  }};
  const service=new UsageService({credentials,preferences:{read:()=>({refreshIntervalMinutes:3})},fetchUsage:async()=>{fetches++;return snapshot;}});
  t.after(()=>service.dispose());
  const refresh=service.refresh();await entered.promise;const read=service.read();
  checked.resolve('migrated');monitor.resolve('switched');await Promise.all([refresh,read]);
  assert.equal(fetches,0);assert.equal(service.view().snapshot,null);assert.equal(service.view().authenticated,false);
});
test('final ready-marker rename failure keeps changing marker despite successful physical cleanup',async t=>{
  const f=setup(t),rename=fs.renameSync;let renames=0;
  t.mock.method(fs,'renameSync',(...args)=>{if(++renames===2)throw Error(legacy.account);return rename(...args);});
  const result=await f.service.refresh();
  assert.equal(result.error.code,'SECRET_STORAGE');assert.equal(result.snapshot,null);assert.equal(result.authenticated,false);
  assert.equal(f.calls(),0);assert.ok(!f.value().includes(legacy.account));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,REVISION_FILE),'utf8')).phase,'changing');
  assert.ok(!JSON.stringify(result).includes(legacy.account));
});
test('clear, switch, or remembered login queued during migration wins without old quota publication',async t=>{
  for(const mutate of [f=>f.credentials.clear(),f=>f.credentials.replace('synthetic-switched'),f=>f.credentials.replaceSession(remembered)]) {
    const f=setup(t),pending=defer(),set=f.entry.setPassword;let first=true;
    f.entry.setPassword=async v=>{if(first){first=false;await pending.promise;}set(v);};
    const refresh=f.service.refresh();await tick();const winner=mutate(f);pending.resolve();
    await Promise.all([refresh,winner]);
    assert.equal(f.service.view().snapshot,null);assert.ok(f.calls()<=1);
    assert.notEqual(f.value(),JSON.stringify({version:1,type:'krill-session',jwt:legacy.jwt}));
  }
});
