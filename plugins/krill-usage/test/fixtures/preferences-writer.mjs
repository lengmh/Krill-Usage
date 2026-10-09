import fs from 'node:fs';
import path from 'node:path';
import { createPreferences } from '../../src/preferences.mjs';

const [stateDir,barriers,label,patchJson,optionsJson]=process.argv.slice(2);
const options=JSON.parse(optionsJson),readFileSync=fs.readFileSync;
const sleeper=new Int32Array(new SharedArrayBuffer(4));
const mark=name=>fs.writeFileSync(path.join(barriers,name),'ready');
function wait(name) {
 const deadline=Date.now()+20000;
 while(!fs.existsSync(path.join(barriers,name))) {
  if(Date.now()>=deadline) throw new Error(`Timed out waiting for ${name}`);
  Atomics.wait(sleeper,0,0,10);
 }
}

if(options.stalePid) {
 // Only the synthetic stale PID's probe is stubbed. Do not rely on real dead
 // PIDs, reuse timing, or platform-specific process.kill behavior in this test.
 const kill=process.kill;
 process.kill=function(pid,signal) {
  if(pid===options.stalePid && signal===0) throw Object.assign(new Error('Synthetic exited owner'),{code:'ESRCH'});
  return kill.call(process,pid,signal);
 };
}
if(options.holdRead) {
 fs.readFileSync=function(file,...args) {
  const contents=readFileSync(file,...args);
  if(file===path.join(stateDir,'preferences.json')) {
   mark(`${label}.holding`);
   wait(`${label}.release`);
  }
  return contents;
 };
}

mark(`${label}.ready`);
wait('start');
try {
 const value=createPreferences(stateDir).update(JSON.parse(patchJson));
 process.stdout.write(`${JSON.stringify({ok:true,value})}\n`);
} catch(error) {
 process.stdout.write(`${JSON.stringify({ok:false,error:error.message})}\n`);
}
