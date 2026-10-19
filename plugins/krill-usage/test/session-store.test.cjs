'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCredentialStore, REVISION_FILE, MAX_SESSION_LENGTH} = require('../src/credentials.cjs');
const session = {jwt:'synthetic-jwt',account:'synthetic@example.invalid',password:'synthetic-password'};
function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(),'krill-session-'));
  t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  let value = null; const writes=[];
  const entry = {getPassword:()=>value,setPassword:v=>{writes.push(v);value=v;},deletePassword:()=>{value=null;}};
  const store = createCredentialStore({stateDir,entryFactory:()=>entry});
  return {store,entry,writes,stateDir,value:()=>value};
}
test('one vault record holds the session; marker has no secrets and legacy read returns JWT',async t=>{
  const f=fixture(t);
  const revision=await f.store.replaceSession(session,{expectedRevision:'absent'});
  assert.equal(await f.store.readRevision(),revision);
  assert.equal(f.writes.length,1);
  assert.deepEqual(await f.store.readSession(),session);
  assert.equal(await f.store.read(),session.jwt);
  assert.deepEqual(JSON.parse(f.value()),{version:1,type:'krill-session',...session});
  const marker=fs.readFileSync(path.join(f.stateDir,REVISION_FILE),'utf8');
  for(const secret of Object.values(session)) assert.ok(!marker.includes(secret));
});
test('legacy JWT migration, nonremembered login, raw JWT replacement and clear erase passwords',async t=>{
  const f=fixture(t);
  await f.store.replace('synthetic-legacy');
  assert.deepEqual(await f.store.readSession(),{jwt:'synthetic-legacy'});
  await f.store.replaceSession(session);
  await f.store.replaceSession({jwt:'synthetic-new',account:session.account});
  assert.deepEqual(await f.store.readSession(),{jwt:'synthetic-new'});
  assert.ok(!f.value().includes(session.account));
  assert.ok(!f.value().includes(session.password));
  await f.store.replaceSession(session); await f.store.replace('synthetic-raw');
  assert.deepEqual(await f.store.readSession(),{jwt:'synthetic-raw'});
  assert.ok(!f.value().includes(session.account)); assert.ok(!f.value().includes(session.password));
  await f.store.replaceSession(session); await f.store.clear();
  assert.equal(await f.store.readSession(),null);
});
test('CAS is checked inside queued writer lock and stale renewal cannot undo clear or switch',async t=>{
  const f=fixture(t);
  for(const mutation of [()=>f.store.clear(),()=>f.store.replace('synthetic-other')]){
    await f.store.replaceSession(session); const revision=await f.store.readRevision();
    const changed=mutation();
    const stale=f.store.replaceSession({...session,jwt:'synthetic-renewed'},{expectedRevision:revision});
    await changed; const marker=await f.store.readRevision(); const value=f.value();
    await assert.rejects(stale,{code:'CREDENTIAL_CHANGED'});
    assert.equal(await f.store.readRevision(),marker); assert.equal(f.value(),value);
  }
});
test('malformed, oversized or unsupported session records fail closed',async t=>{
  const f=fixture(t);
  for(const value of [
    JSON.stringify({version:2,type:'krill-session',...session}),
    JSON.stringify({version:1,type:'krill-session',...session,unexpected:'secret'}),
    JSON.stringify({version:1,type:'krill-session',jwt:session.jwt,password:session.password}),
    '{invalid', 'a'.repeat(MAX_SESSION_LENGTH+1)
  ]) {
    f.entry.getPassword=()=>value;
    await assert.rejects(f.store.readSession(),error=>error.code==='SECRET_STORAGE'&&!error.message.includes(session.password));
  }
});
test('invalid login bundles cannot touch vault or marker',async t=>{
  const f=fixture(t);
  for(const value of [{jwt:session.jwt,password:'x'},{...session,account:''},{...session,password:'x\n'},{...session,account:42},null]){
    await assert.rejects(f.store.replaceSession(value));
    assert.equal(await f.store.readRevision(),'absent'); assert.equal(f.writes.length,0);
  }
});
test('native errors cannot spoof revision-conflict codes to leak vault details',async t=>{
  const f=fixture(t);
  f.entry.setPassword=()=>{throw Object.assign(new Error(session.password),{code:'CREDENTIAL_CHANGED'});};
  await assert.rejects(f.store.replaceSession(session),error=>error.code==='SECRET_STORAGE'&&!error.message.includes(session.password));
});
