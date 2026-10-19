import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {channel} from 'node:diagnostics_channel';
import {createCredentialStore,READ_TIMEOUT_MS,REVISION_FILE,LOCK_FILE} from '../src/credentials.cjs';
const require=createRequire(import.meta.url),Module=require('node:module');
const realSetTimeout=globalThis.setTimeout;
const delay=ms=>new Promise(resolve=>realSetTimeout(resolve,ms));
async function until(fn){const end=Date.now()+5000;while(!fn()){assert.ok(Date.now()<end,'helper did not reach expected state');await delay(5);}}
function setup(t,mode){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'krill-migrate-helper-')),stateDir=path.join(dir,'state');
  const control=path.join(dir,'control.json'),eventsFile=path.join(dir,'events.jsonl'),modulePath=path.join(dir,'keyring.cjs');
  fs.writeFileSync(control,JSON.stringify({mode,written:false}));
  fs.writeFileSync(modulePath,`
    const fs=require('node:fs');
    const file=${JSON.stringify(control)},events=${JSON.stringify(eventsFile)};
    const record=event=>fs.appendFileSync(events,JSON.stringify({event,pid:process.pid})+'\\n');
    const get=()=>JSON.parse(fs.readFileSync(file,'utf8'));
    const block=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
    const legacy={version:1,type:'krill-session',jwt:'synthetic-jwt',account:'synthetic@example.invalid'};
    module.exports={AsyncEntry:class {
      constructor(){const c=get();record(c.written?'post-construct':'pre-construct');if(c.mode===(c.written?'post-constructor':'pre-constructor'))block();}
      getPassword(){const c=get(),stage=c.written?'post':'pre';record(stage+'-read');
        if(c.mode===stage+'-read')block();
        if(c.mode===stage+'-late')return new Promise(resolve=>setTimeout(()=>{record('late-result');resolve(JSON.stringify(legacy));},60000));
        if(c.mode===stage+'-reject'){process.stdout.write('synthetic-private-output');process.stderr.write('synthetic-private-error');return Promise.reject(Error('synthetic-private-error'));}
        return Promise.resolve(JSON.stringify(c.written?{version:1,type:'krill-session',jwt:legacy.jwt}:legacy));
      }
    },Entry:class {
      constructor(){record('write-construct');if(get().mode==='write-constructor')block();}
      getPassword(){throw Error('synchronous read forbidden');}
      setPassword(value){record('write-start');const c=get();
        if(c.mode==='write-block')block();
        if(c.mode==='write-late')return new Promise(resolve=>setTimeout(()=>{record('late-write');resolve();},60000));
        if(c.mode==='write-reject'){process.stdout.write('synthetic-private-output');process.stderr.write('synthetic-private-error');throw Error('synthetic-private-error');}
        if(value!==JSON.stringify({version:1,type:'krill-session',jwt:legacy.jwt}))throw Error('wrong write');
        fs.writeFileSync(file,JSON.stringify({...c,written:true}));record('write-done');
      }
    }};
  `);
  const original=Module._resolveFilename;
  t.mock.method(Module,'_resolveFilename',function(request,...args){if(request==='@napi-rs/keyring')return modulePath;return original.call(this,request,...args);});
  const children=[],processes=channel('child_process');
  const observe=({process:child})=>{const item={child,closed:false};children.push(item);child.once('close',()=>{item.closed=true;});};processes.subscribe(observe);
  const store=createCredentialStore({stateDir});
  t.after(async()=>{store.dispose();for(const item of children)if(!item.closed)item.child.kill('SIGKILL');await until(()=>children.every(item=>item.closed));processes.unsubscribe(observe);fs.rmSync(dir,{recursive:true,force:true});});
  const events=()=>{try{const s=fs.readFileSync(eventsFile,'utf8');return s.slice(0,s.lastIndexOf('\n')+1).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  return {store,stateDir,children,events,control:()=>JSON.parse(fs.readFileSync(control,'utf8'))};
}
for(const mode of ['pre-constructor','pre-read','pre-late','post-constructor','post-read','post-late','write-constructor','write-block','write-late']) {
  test(`production migration ${mode} is bounded and responsive with no late mutations`,{timeout:10000},async t=>{
    const f=setup(t,mode);t.mock.timers.enable({apis:['setTimeout']});
    const pending=f.store.migrateJwtOnly({expectedRevision:'absent'});
    const rejected=assert.rejects(pending,e=>e.code==='SECRET_STORAGE'&&!String(e.stack).includes('synthetic-')&&e.cause===undefined);
    const expected=mode==='write-constructor'?'write-construct':mode.startsWith('write-')?'write-start':mode.replace(/-late$/,'-read').replace(/-constructor$/,'-construct');
    await until(()=>f.events().some(e=>e.event===expected));
    assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),true);
    let responsive=false;await new Promise(resolve=>setImmediate(()=>{responsive=true;resolve();}));assert.ok(responsive);
    assert.ok(f.events().every(e=>e.pid!==process.pid),'all native operations stay in disposable children');
    t.mock.timers.tick(READ_TIMEOUT_MS);
    if(mode.startsWith('write-'))assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),true,'timeout cannot release writer lock before child close');
    await rejected;
    assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),false);
    if(mode.startsWith('write-'))assert.ok(f.children.every(c=>c.closed),'write timeout waits for close');
    await until(()=>f.children.every(c=>c.closed));
    if(mode.startsWith('pre-')){assert.equal(await f.store.readRevision(),'absent');assert.equal(f.control().written,false);}
    else {await assert.rejects(f.store.readRevision(),{code:'SECRET_STORAGE'});assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,REVISION_FILE),'utf8')).phase,'changing');}
    for(const name of fs.readdirSync(f.stateDir))assert.ok(!fs.readFileSync(path.join(f.stateDir,name),'utf8').includes('synthetic-'));
    assert.ok(!JSON.stringify(f.events()).includes('synthetic-'));
    for(const {child} of f.children){assert.equal(child.stdout,null);assert.equal(child.stderr,null);assert.ok(!JSON.stringify(child.spawnargs).includes('synthetic-'));}
    t.mock.timers.tick(READ_TIMEOUT_MS*3);await delay(10);
    assert.ok(!f.events().some(e=>e.event==='late-write'||e.event==='late-result'));
  });
}
test('production migration uses isolated read/write/read and verifies physical result',async t=>{
  const f=setup(t,'success');const revision=await f.store.migrateJwtOnly({expectedRevision:'absent'});
  assert.equal(await f.store.readRevision(),revision);assert.equal(f.control().written,true);
  assert.equal(f.children.length,3);assert.ok(f.children.every(c=>c.closed));
  assert.deepEqual(f.events().map(e=>e.event),['pre-construct','pre-read','write-construct','write-start','write-done','post-construct','post-read']);
  assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),false);
});
for(const mode of ['pre-reject','write-reject','post-reject'])test(`production ${mode} hides child diagnostics and releases lock`,async t=>{
  const f=setup(t,mode);
  await assert.rejects(f.store.migrateJwtOnly({expectedRevision:'absent'}),e=>e.code==='SECRET_STORAGE'&&!String(e.stack).includes('synthetic-'));
  assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),false);
  await until(()=>f.children.every(c=>c.closed));
  for(const {child} of f.children){assert.equal(child.stdout,null);assert.equal(child.stderr,null);}
});
test('dispose kills a pending migration writer and waits for close before unlocking',async t=>{
  const f=setup(t,'write-late');const pending=f.store.migrateJwtOnly({expectedRevision:'absent'});
  const rejected=assert.rejects(pending,{code:'SECRET_STORAGE'});
  await until(()=>f.events().some(e=>e.event==='write-start'));
  f.store.dispose();assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),true);
  await rejected;assert.ok(f.children.every(c=>c.closed));assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),false);
  assert.equal(f.control().written,false);assert.ok(!f.events().some(e=>e.event==='late-write'));
});
test('failed durable writer registration never sends the write instruction and waits for child exit',async t=>{
  const f=setup(t,'success'),sync=fs.fsyncSync;let calls=0;
  t.mock.method(fs,'fsyncSync',(...args)=>{if(++calls===3)throw Error('synthetic-private-registration');return sync(...args);});
  await assert.rejects(f.store.migrateJwtOnly({expectedRevision:'absent'}),e=>e.code==='SECRET_STORAGE'&&!e.message.includes('synthetic-'));
  assert.ok(f.children.every(c=>c.closed));assert.equal(f.events().some(e=>e.event==='write-start'||e.event==='write-construct'),false);
  assert.equal(f.control().written,false);assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),false);
});
for(const failure of ['partial-registration','registration-readback'])test(`${failure} cannot authorize a child vault write`,async t=>{
  const f=setup(t,'success');
  if(failure==='partial-registration'){
    const write=fs.writeSync;
    t.mock.method(fs,'writeSync',function(fd,buffer,offset,length,position){
      if(Buffer.isBuffer(buffer)&&/^!2 [0-9]+ [0-9]+\n$/u.test(buffer.toString()))return write.call(this,fd,buffer,offset,3,position);
      return write.apply(this,arguments);
    });
  }else{
    const read=fs.readSync;
    t.mock.method(fs,'readSync',function(fd,buffer,...args){const bytes=read.call(this,fd,buffer,...args);if(buffer.toString().startsWith('!2 '))buffer[0]=32;return bytes;});
  }
  await assert.rejects(f.store.migrateJwtOnly({expectedRevision:'absent'}),{code:'SECRET_STORAGE'});
  assert.ok(f.children.every(c=>c.closed));assert.equal(f.control().written,false);
  assert.equal(f.events().some(e=>e.event==='write-start'||e.event==='write-construct'),false);
  assert.equal(fs.existsSync(path.join(f.stateDir,LOCK_FILE)),false);
});
