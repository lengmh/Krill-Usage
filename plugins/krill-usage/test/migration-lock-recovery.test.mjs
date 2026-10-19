import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createCredentialStore,LOCK_FILE} from '../src/credentials.cjs';
const require=createRequire(import.meta.url),source=require.resolve('../src/credentials.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+5000;while(!fn()){assert.ok(Date.now()<end,'process did not reach expected state');await delay(10);}}
function fixture(t,text){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'krill-lock-owner-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const lock=path.join(dir,LOCK_FILE);fs.writeFileSync(lock,text,{mode:0o600});return {lock,store:createCredentialStore({stateDir:dir})};}
test('tagged migration recovery requires every recorded owner to be proven dead',t=>{
  for(const text of ['!2 123 456\n','!2 123 -\n'])for(const manual of [false,true]){
    const f=fixture(t,text),probes=[];
    const mock=t.mock.method(process,'kill',pid=>{probes.push(pid);throw Object.assign(Error(),{code:'ESRCH'});});
    assert.equal(f.store.recoverInterruptedWrite({manual}),true);mock.mock.restore();
    assert.deepEqual(probes,text.includes('456')?[123,456]:[123]);assert.equal(fs.existsSync(f.lock),false);
  }
  for(const live of [123,456])for(const manual of [false,true]){
    const f=fixture(t,'!2 123 456\n');
    const mock=t.mock.method(process,'kill',pid=>{if(pid!==live)throw Object.assign(Error(),{code:'ESRCH'});});
    assert.throws(()=>f.store.recoverInterruptedWrite({manual}),{code:'RECOVERY_LIVE_LOCK'});mock.mock.restore();
    assert.equal(fs.readFileSync(f.lock,'utf8'),'!2 123 456\n');
  }
});
test('partial, unsupported, oversized and malformed tagged locks never permit manual override',t=>{
  for(const text of ['!','!2','!2 123','!2 123 ','!2 123 456','!2 123 45x\n','!2 123 456\nextra','!2 123 -','!2 0 456\n','!2 123 0\n','!3 123 456\n','!2 123 99999999999999999999\n','!2 '+'1'.repeat(100)]){
    const f=fixture(t,text);
    for(const manual of [false,true])assert.throws(()=>f.store.recoverInterruptedWrite({manual}),{code:'RECOVERY_FAILED'});
    assert.equal(fs.readFileSync(f.lock,'utf8'),text);
  }
});
test('unverifiable writer-child PID cannot be overridden manually',t=>{
  const f=fixture(t,'!2 123 456\n');
  t.mock.method(process,'kill',pid=>{throw Object.assign(Error('synthetic-secret'),{code:pid===123?'ESRCH':'EPERM'});});
  for(const manual of [false,true])assert.throws(()=>f.store.recoverInterruptedWrite({manual}),e=>e.code==='RECOVERY_LIVE_LOCK'&&!e.message.includes('synthetic'));
});
test('hard parent death cannot unlock a surviving native writer or allow clear then resurrection',{timeout:15000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'krill-orphan-regression-')),stateDir=path.join(dir,'state');
  const vault=path.join(dir,'synthetic-vault'),started=path.join(dir,'started'),release=path.join(dir,'release'),done=path.join(dir,'done'),modulePath=path.join(dir,'keyring.cjs');
  const legacy={version:1,type:'krill-session',jwt:'synthetic-old',account:'synthetic@example.invalid'};
  fs.writeFileSync(vault,JSON.stringify(legacy));
  fs.writeFileSync(modulePath,`const fs=require('node:fs');const vault=${JSON.stringify(vault)};module.exports={AsyncEntry:class{getPassword(){return Promise.resolve(fs.readFileSync(vault,'utf8'));}},Entry:class{setPassword(value){fs.writeFileSync(${JSON.stringify(started)},String(process.pid));while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);fs.writeFileSync(vault,value);fs.writeFileSync(${JSON.stringify(done)},'done');}}};`);
  const parent=spawn(process.execPath,['-e',`const Module=require('node:module'),original=Module._resolveFilename;Module._resolveFilename=function(name,...args){return name==='@napi-rs/keyring'?${JSON.stringify(modulePath)}:original.call(this,name,...args);};require(${JSON.stringify(source)}).createCredentialStore({stateDir:${JSON.stringify(stateDir)}}).migrateJwtOnly({expectedRevision:'absent'}).catch(()=>{});`],{stdio:'ignore'});
  let writerPid;
  t.after(()=>{try{parent.kill('SIGKILL');}catch{}if(writerPid)try{process.kill(writerPid,'SIGKILL');}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  await until(()=>fs.existsSync(started));writerPid=Number(fs.readFileSync(started,'utf8'));
  assert.equal(fs.readFileSync(path.join(stateDir,LOCK_FILE),'utf8'),`!2 ${parent.pid} ${writerPid}\n`);
  const closed=new Promise(resolve=>parent.once('close',resolve));parent.kill('SIGKILL');await closed;
  const store=createCredentialStore({stateDir,entryFactory:()=>({getPassword:()=>fs.readFileSync(vault,'utf8'),setPassword:v=>fs.writeFileSync(vault,v),deletePassword:()=>fs.rmSync(vault,{force:true})})});
  const writerStopped=()=>{try{process.kill(writerPid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}};
  let recovered=false;
  for(const manual of [false,true]){
    const stoppedBefore=writerStopped();
    let error;try{recovered=store.recoverInterruptedWrite({manual});}catch(failure){error=failure;}
    if(recovered){
      // Some platforms terminate descendants with their parent. Independently
      // prove writer death rather than requiring an orphan to survive everywhere.
      assert.equal(writerStopped(),true,'recovery must never unlock a surviving native writer');
      break;
    }
    assert.equal(stoppedBefore,false,'a proven-dead writer should allow recovery');
    assert.equal(error?.code,'RECOVERY_LIVE_LOCK');
  }
  assert.equal(fs.readFileSync(vault,'utf8'),JSON.stringify(legacy));
  if(recovered){
    await store.clear();assert.equal(fs.existsSync(vault),false);
    fs.writeFileSync(release,'release');await delay(100);
    assert.equal(fs.existsSync(done),false);assert.equal(fs.existsSync(vault),false,'terminated child cannot resurrect owner-cleared credentials');
  }else{
    await assert.rejects(store.clear(),{code:'SECRET_STORAGE'});
    fs.writeFileSync(release,'release');await until(()=>fs.existsSync(done)||writerStopped());
    if(fs.existsSync(done))assert.deepEqual(JSON.parse(fs.readFileSync(vault,'utf8')),{version:1,type:'krill-session',jwt:legacy.jwt});
    else assert.equal(fs.readFileSync(vault,'utf8'),JSON.stringify(legacy));
    // A zombie/reused PID remains conservatively locked. Recovery and clear are
    // permitted only after the OS independently proves the writer has exited.
    let finalRecovered=false,finalError;
    try{finalRecovered=store.recoverInterruptedWrite({manual:true});}catch(error){finalError=error;}
    if(finalRecovered){assert.equal(writerStopped(),true);await store.clear();assert.equal(fs.existsSync(vault),false);}
    else assert.equal(finalError?.code,'RECOVERY_LIVE_LOCK');
  }
  store.dispose();
});
