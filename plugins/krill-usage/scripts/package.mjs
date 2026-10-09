import { cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const { version } = JSON.parse(await readFile('package.json','utf8'));
const root = 'artifacts/krill-usage-codex';
const output = path.join(root,'plugins/krill-usage');
await rm(root,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for (const file of ['dist','.codex-plugin','.mcp.json','assets','README.md','PRIVACY.md','NOTICE','LICENSES']) {
  await cp(file,path.join(output,file),{recursive:true});
}
await cp('../../LICENSE',path.join(output,'LICENSE'));
// Native keyring cannot be embedded by esbuild; include only installed platform packages.
await mkdir(path.join(output,'node_modules/@napi-rs'),{recursive:true});
const nativePackages=(await readdir('node_modules/@napi-rs')).filter(name=>name==='keyring'||name.startsWith('keyring-'));
if (nativePackages.length<2) throw new Error('Native keyring platform package is missing. Reinstall dependencies on the target platform.');
for(const name of nativePackages) await cp(`node_modules/@napi-rs/${name}`,`${output}/node_modules/@napi-rs/${name}`,{recursive:true});
await writeFile(path.join(output,'package.json'),JSON.stringify({name:'krill-usage-codex-plugin',version,private:true,type:'module',license:'GPL-3.0-only',engines:{node:'>=22'}},null,2)+'\n');
// Preserve license texts for bundled runtime dependencies, including transitive packages.
const notices=path.join(output,'THIRD_PARTY_NOTICES'); await mkdir(notices,{recursive:true});
async function collect(dir, prefix='') {
 for(const ent of await readdir(dir,{withFileTypes:true})) {
  if(!ent.isDirectory()||ent.name.startsWith('.'))continue;
  const full=path.join(dir,ent.name);if(ent.name.startsWith('@')) {await collect(full,ent.name+'/');continue;}
  const names=await readdir(full);const target=path.join(notices,(prefix+ent.name).replaceAll('/','__'));
  for(const name of names.filter(n=>/^(licen[cs]e|notice|copying)(\.|$)/i.test(n))) {
   await mkdir(target,{recursive:true}); await cp(path.join(full,name),path.join(target,name),{recursive:true});
  }
 }
}
await collect('node_modules');
await mkdir(path.join(root,'.agents/plugins'),{recursive:true});
await cp('../../.agents/plugins/marketplace.json',path.join(root,'.agents/plugins/marketplace.json'));
await writeFile(path.join(root,'README.md'),'# Krill Usage for Codex\n\nRequires Node.js 22+. From this directory run `codex plugin marketplace add .`, restart Codex, then install Krill Usage from Krill Usage Local.\n\nSee [installation, platform requirements and credential setup](plugins/krill-usage/README.md). New JWT entry is Windows-only.\n');
// CI supplies the exact checkout commit. A local/source-ZIP build may have no Git metadata.
const sourceCommit=process.env.GITHUB_SHA || null;
await writeFile(path.join(root,'BUILD-INFO.json'),JSON.stringify({version,sourceCommit,platform:process.platform,arch:process.arch},null,2)+'\n');
const tag=`${process.platform}-${process.arch}`;
const filename=`krill-usage-codex-${version}-${tag}.tar.gz`;
execFileSync('tar',['-czf',path.resolve('artifacts',filename),'-C','artifacts','krill-usage-codex']);
const bytes=await readFile(path.join('artifacts',filename));
await writeFile(path.join('artifacts',filename+'.sha256'),`${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`);
console.log(`Packaged artifacts/${filename}; includes native bindings for ${tag}.`);
