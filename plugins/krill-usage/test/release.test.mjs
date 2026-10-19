import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const releaseScript=readFileSync(new URL('../scripts/release.mjs',import.meta.url),'utf8');
const oldSha='c74467518c35eaacba1ac5d7c588af1e97fac22d';
function fixture(t,mode='success') {
 const dir=mkdtempSync(path.join(tmpdir(),'krill-release-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const run=(...args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe'}).toString().trim();
 writeFileSync(path.join(dir,'source.txt'),'synthetic source');run('init','--quiet');run('add','source.txt');run('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture');
 const sha=run('rev-parse','HEAD');writeFileSync(path.join(dir,'release.mjs'),releaseScript);
 for(const platform of ['win32-x64','darwin-arm64','linux-x64']) {
  const stage=path.join(dir,'stage-'+platform),root=path.join(stage,'krill-usage-codex'),plugin=path.join(root,'plugins/krill-usage');
  const write=(file,value)=>{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,value);};
  const [os,arch]=platform.split('-');
  write(path.join(root,'BUILD-INFO.json'),JSON.stringify({version:'0.1.6',sourceCommit:mode==='bad-build'?'wrong':sha,platform:os,arch}));
  for(const file of ['.codex-plugin/plugin.json','package.json'])write(path.join(plugin,file),'{"version":"0.1.6"}');
  write(path.join(root,'.agents/plugins/marketplace.json'),'{"plugins":[{"source":{"path":"./plugins/krill-usage"}}]}');
  for(const file of ['dist/server.js','dist/app.html','dist/credential-cli.cjs','LICENSE','PRIVACY.md','THIRD_PARTY_NOTICES/fixture','node_modules/@napi-rs/keyring-'+platform+'/fixture'])write(path.join(plugin,file),'synthetic');
  if(os==='win32')write(path.join(plugin,'dist/CredentialPrompt.exe'),'synthetic');
  const downloads=path.join(dir,'release-downloads',platform);mkdirSync(downloads,{recursive:true});const filename=`krill-usage-codex-0.1.6-${platform}.tar.gz`,archive=path.join(downloads,filename);
  execFileSync('tar',['-czf',archive,'-C',stage,'krill-usage-codex']);
  writeFileSync(archive+'.sha256',`${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${filename}\n`);
 }
 const bin=path.join(dir,'bin');mkdirSync(bin);
 writeFileSync(path.join(bin,'gh'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),stateFile='fake-release.json';
const previous={name:'Existing release',body:'Existing notes',assets:[{id:1,name:'old.vsix',size:7,digest:'sha256:old'}]};
const send=x=>process.stdout.write(JSON.stringify(x));
if(a[0]==='api'){
 const route=a[1].replace('repos/lengmh/Krill-Usage/','');
 if(route==='releases/tags/v0.1.5')send(previous);
 else if(route==='git/ref/tags/v0.1.5')send({object:{sha:${JSON.stringify(oldSha)}}});
 else if(route==='git/matching-refs/tags/v0.1.6')send(${mode==='existing-tag'?'[{ref:"refs/tags/v0.1.6"}]':'[]'});
 else if(route==='releases?per_page=100')send([previous]);
 else if(route==='releases/tags/v0.1.6')send(JSON.parse(fs.readFileSync(stateFile)));
 else if(route==='git/ref/tags/v0.1.6')send({object:{sha:${JSON.stringify(sha)}}});
 else throw Error('Unexpected API '+route);
}else if(a[0]==='release'&&a[1]==='create'){
 if(a[2]!=='v0.1.6'||a[a.indexOf('--target')+1]!==${JSON.stringify(sha)}||a.includes('--clobber'))throw Error('Unsafe publication');
 fs.writeFileSync('created.json',JSON.stringify(a));fs.writeFileSync(stateFile,JSON.stringify({draft:false,prerelease:false,body:fs.readFileSync(a[a.indexOf('--notes-file')+1],'utf8')}));
}else if(a[0]==='release'&&a[1]==='download'){
 const name=a[a.indexOf('--pattern')+1];fs.copyFileSync(path.join('release-assets',name),path.join(a[a.indexOf('--dir')+1],name));
}else throw Error('Unexpected command');
`,{mode:0o755});
 return{dir,sha,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,GITHUB_REPOSITORY:'lengmh/Krill-Usage',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_RUN_ID:'synthetic-run'}};
}
test('new corrective release verifies exact-source assets and preserves previous release', {skip:process.platform==='win32'},t=>{
 const f=fixture(t);const result=spawnSync(process.execPath,['release.mjs'],{cwd:f.dir,env:f.env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Verified 6 new release assets/);
 const args=JSON.parse(readFileSync(path.join(f.dir,'created.json')));assert.equal(args.filter(x=>x.startsWith('release-assets/')).length,6);
 const manifest=JSON.parse(readFileSync(path.join(f.dir,'release-verify/CODEX-RELEASE-0.1.6.json')));assert.equal(manifest.sourceCommit,f.sha);assert.equal(manifest.previousTag,'v0.1.5');
});
for(const mode of ['existing-tag','bad-build'])test(`release refuses ${mode} before publication`,{skip:process.platform==='win32'},t=>{
 const f=fixture(t,mode),result=spawnSync(process.execPath,['release.mjs'],{cwd:f.dir,env:f.env,encoding:'utf8'});
 assert.notEqual(result.status,0);assert.equal(existsSync(path.join(f.dir,'created.json')),false);
});
