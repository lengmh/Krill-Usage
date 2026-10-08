import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {setTimeout as delay} from 'node:timers/promises';
import {createPreferences,defaults} from '../src/preferences.mjs';
test('persists only allowlisted nonsecret settings with numeric bounds',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const prefs=createPreferences(dir);assert.deepEqual(prefs.read(),defaults);
 assert.deepEqual(prefs.readSnapshot(),{revision:0,values:defaults});
 prefs.update({refreshIntervalMinutes:5,showBalance:false});assert.equal(createPreferences(dir).read().showBalance,false);
 assert.throws(()=>prefs.update({jwt:'synthetic'}));assert.throws(()=>prefs.update({refreshIntervalMinutes:0}));assert.throws(()=>prefs.update({refreshIntervalMinutes:1.2}));
 assert.throws(()=>prefs.update({revision:50}));assert.throws(()=>prefs.update({preferencesRevision:50}));
 assert.ok(!readFileSync(path.join(dir,'preferences.json'),'utf8').includes('synthetic'));
 assert.equal(prefs.read().lowQuotaWarningPercent,15);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('legacy flat preferences migrate on save without changing public values',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const file=path.join(dir,'preferences.json'),legacy=JSON.stringify({showBalance:false,refreshIntervalMinutes:7});
 writeFileSync(file,legacy);
 const prefs=createPreferences(dir),values={...defaults,showBalance:false,refreshIntervalMinutes:7};
 assert.deepEqual(prefs.readSnapshot(),{revision:0,values});assert.equal(readFileSync(file,'utf8'),legacy);
 assert.deepEqual(prefs.read(),values);
 const updated=prefs.update({lowQuotaWarningPercent:30});
 assert.deepEqual(updated,{...values,lowQuotaWarningPercent:30});
 assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{revision:1,values:updated});
 const restarted=createPreferences(dir);
 assert.deepEqual(restarted.readSnapshot(),{revision:1,values:updated});
 assert.deepEqual(restarted.update({showBalance:true}),{...updated,showBalance:true});
 assert.equal(prefs.readSnapshot().revision,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('preference snapshots pair revision and values from the same file read',t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const prefs=createPreferences(dir),file=path.join(dir,'preferences.json');
 prefs.update({showBalance:false});const first=prefs.readSnapshot();
 const second={revision:2,values:{...first.values,refreshIntervalMinutes:7}};
 const original=fs.readFileSync;let reads=0;
 t.mock.method(fs,'readFileSync',function(target,...args){
  const contents=original(target,...args);
  if(target===file){reads++;writeFileSync(file,JSON.stringify(second));}
  return contents;
 });
 assert.deepEqual(prefs.readSnapshot(),first);assert.equal(reads,1);
 assert.deepEqual(prefs.readSnapshot(),second);
 }finally{t.mock.restoreAll();rmSync(dir,{recursive:true,force:true});}
});
test('invalid or exhausted stored revisions fail closed without overwriting settings',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const prefs=createPreferences(dir),file=path.join(dir,'preferences.json');
 for(const revision of [-1,1.5,'2',Number.MAX_SAFE_INTEGER+1]){
  const contents=JSON.stringify({revision,values:defaults});writeFileSync(file,contents);
  assert.throws(()=>prefs.readSnapshot(),/Unable to load/);
  assert.throws(()=>prefs.update({showBalance:false}),/Unable to save/);
  assert.equal(readFileSync(file,'utf8'),contents);
 }
 const contents=JSON.stringify({revision:Number.MAX_SAFE_INTEGER,values:defaults});writeFileSync(file,contents);
 assert.equal(prefs.readSnapshot().revision,Number.MAX_SAFE_INTEGER);
 assert.throws(()=>prefs.update({showBalance:false}),/Unable to save/);
 assert.equal(readFileSync(file,'utf8'),contents);
 assert.deepEqual(readdirSync(dir),['preferences.json']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('malformed legacy files and snapshot envelopes fail closed',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const prefs=createPreferences(dir),file=path.join(dir,'preferences.json');
 for(const saved of [false,0,[],null,'settings',{revision:1},{values:defaults},
  {revision:1,values:{showBalance:false}},{revision:1,values:defaults,jwt:'synthetic'},
  {revision:1,values:{...defaults,refreshIntervalMinutes:0}}]){
  const contents=JSON.stringify(saved);writeFileSync(file,contents);
  assert.throws(()=>prefs.readSnapshot(),/Unable to load/);
  assert.throws(()=>prefs.update({showBalance:false}),/Unable to save/);
  assert.equal(readFileSync(file,'utf8'),contents);
 }
 assert.deepEqual(readdirSync(dir),['preferences.json']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('native settings cannot persist critical threshold above warning',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const prefs=createPreferences(dir);assert.throws(()=>prefs.update({lowQuotaCriticalPercent:50}));
 assert.deepEqual(prefs.read(),defaults);
 prefs.update({lowQuotaWarningPercent:60,lowQuotaCriticalPercent:50});assert.equal(prefs.read().lowQuotaCriticalPercent,50);
 const before=prefs.readSnapshot();assert.throws(()=>prefs.update({lowQuotaWarningPercent:10}));
 assert.deepEqual(prefs.readSnapshot(),before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('separate preference instances preserve omitted fields and observe saved changes',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-'));try{
 const first=createPreferences(dir),second=createPreferences(dir);first.update({showBalance:false});
 assert.equal(second.read().showBalance,false);second.update({refreshIntervalMinutes:7});
 assert.equal(first.read().showBalance,false);assert.equal(first.read().refreshIntervalMinutes,7);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

function processFixture(t) {
 const dir=mkdtempSync(path.join(tmpdir(),'krill-prefs-process-'));
 const stateDir=path.join(dir,'state'),barriers=path.join(dir,'barriers'),writers=[];
 mkdirSync(barriers);
 t.after(async()=>{
  for(const writer of writers) if(!writer.result) writer.child.kill();
  await Promise.all(writers.map(writer=>writer.closed));
  rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 });
 function start(label,patch,options={}) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/preferences-writer.mjs',import.meta.url)),stateDir,barriers,label,JSON.stringify(patch),JSON.stringify(options)],{stdio:['ignore','pipe','pipe']});
  const writer={child,stdout:'',stderr:'',result:null};writers.push(writer);
  child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{writer.stdout+=data;});
  child.stderr.setEncoding('utf8');child.stderr.on('data',data=>{writer.stderr+=data;});
  child.on('error',error=>{writer.stderr+=error.message;});
  const timeout=setTimeout(()=>child.kill(),30000);
  writer.closed=new Promise(resolve=>child.once('close',(code,signal)=>{
   clearTimeout(timeout);writer.result={code,signal};resolve(writer.result);
  }));
  return writer;
 }
 async function wait(label,writer) {
  const file=path.join(barriers,label),deadline=Date.now()+20000;
  while(!existsSync(file)) {
   assert.ok(!writer.result,`Writer exited before ${label}: ${writer.stdout} ${writer.stderr}`);
   assert.ok(Date.now()<deadline,`Timed out waiting for ${label}`);
   await delay(10);
  }
 }
 async function result(writer) {
  assert.deepEqual(await writer.closed,{code:0,signal:null},writer.stderr);
  return JSON.parse(writer.stdout);
 }
 return {stateDir,start,wait,result,release:label=>writeFileSync(path.join(barriers,label),'go')};
}

const existingLockError=/^Preferences lock already exists\..*stop all Krill MCP processes.*preferences\.lock/;

test('two child processes leave a stale preferences lock and saved settings untouched',async(t)=>{
 const f=processFixture(t),prefs=createPreferences(f.stateDir);
 prefs.update({showBalance:false,lowQuotaWarningPercent:25});
 const file=path.join(f.stateDir,'preferences.json'),lockFile=path.join(f.stateDir,'preferences.lock');
 const before=readFileSync(file,'utf8'),stalePid=2147483647;
 writeFileSync(lockFile,String(stalePid));
 const first=f.start('first',{showBalance:true},{stalePid});
 const second=f.start('second',{refreshIntervalMinutes:7},{stalePid});
 await Promise.all([f.wait('first.ready',first),f.wait('second.ready',second)]);
 f.release('start');
 for(const outcome of await Promise.all([f.result(first),f.result(second)])) {
  assert.equal(outcome.ok,false);assert.match(outcome.error,existingLockError);
 }
 assert.equal(readFileSync(lockFile,'utf8'),String(stalePid));
 assert.equal(readFileSync(file,'utf8'),before);
 assert.deepEqual(readdirSync(f.stateDir).sort(),['preferences.json','preferences.lock']);
});

test('a child contender preserves the live owner lock and retry retains omitted fields',async(t)=>{
 const f=processFixture(t),prefs=createPreferences(f.stateDir);
 prefs.update({lowQuotaWarningPercent:25});
 const lockFile=path.join(f.stateDir,'preferences.lock');
 const owner=f.start('owner',{showBalance:false},{holdRead:true});
 await f.wait('owner.ready',owner);f.release('start');
 await f.wait('owner.holding',owner);
 const ownerLock=readFileSync(lockFile,'utf8');assert.equal(ownerLock,String(owner.child.pid));
 const contender=f.start('contender',{refreshIntervalMinutes:7});
 const blocked=await f.result(contender);
 assert.equal(blocked.ok,false);assert.match(blocked.error,existingLockError);
 assert.equal(readFileSync(lockFile,'utf8'),ownerLock);
 assert.equal(prefs.read().showBalance,true);
 assert.equal(prefs.readSnapshot().revision,1);
 f.release('owner.release');
 const saved=await f.result(owner);assert.equal(saved.ok,true);assert.equal(saved.value.showBalance,false);
 assert.equal(prefs.readSnapshot().revision,2);
 assert.equal(existsSync(lockFile),false);
 const retried=await f.result(f.start('retry',{refreshIntervalMinutes:7}));
 assert.equal(retried.ok,true);
 assert.deepEqual(retried.value,{...defaults,showBalance:false,refreshIntervalMinutes:7,lowQuotaWarningPercent:25});
 assert.deepEqual(prefs.read(),retried.value);
 assert.deepEqual(createPreferences(f.stateDir).readSnapshot(),{revision:3,values:retried.value});
 assert.deepEqual(readdirSync(f.stateDir),['preferences.json']);
});
