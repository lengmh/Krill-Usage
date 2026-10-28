import { cp, lstat, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
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
const privateNames = new Set(['.private','.ai-toolbox','.git','.codex','.vscode','logs',
  'agents.md','context.md','status.md','backlog.json','test_report.md']);
async function copyProduct(source, target, native = false) {
  await cp(source,target,{recursive:true,filter:async file => {
    const parts = path.relative(process.cwd(),file).split(path.sep).map(p=>p.toLowerCase());
    if (parts.some(p=>privateNames.has(p)||p.startsWith('.env')) || /\.(log|map|tmp)$/i.test(file)) return false;
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('Linked package inputs are not allowed.');
    return !native || info.isDirectory() || /\.(node|[cm]?js|ts)$/i.test(file)
      || /^(package\.json|licen[cs]e(?:\..*)?|notice(?:\..*)?|copying(?:\..*)?|readme(?:\..*)?)$/i.test(path.basename(file));
  }});
}
const runtimeFiles = ['dist/server.js','dist/app.html','dist/credential-cli.cjs',
  'dist/LICENSE','dist/KRILL-NOTICE','.codex-plugin/plugin.json','.mcp.json',
  'assets/icon.svg','README.md','PRIVACY.md','NOTICE','LICENSES'];
if (process.platform === 'win32') runtimeFiles.push('dist/CredentialPrompt.exe');
for (const file of runtimeFiles) {
  await mkdir(path.dirname(path.join(output,file)),{recursive:true});
  await copyProduct(file,path.join(output,file));
}
await cp('../../LICENSE',path.join(output,'LICENSE'));
// Native keyring cannot be embedded by esbuild; include only installed platform packages.
await mkdir(path.join(output,'node_modules/@napi-rs'),{recursive:true});
const nativePackages=(await readdir('node_modules/@napi-rs')).filter(name=>name==='keyring'||name.startsWith('keyring-'));
if (nativePackages.length<2) throw new Error('Native keyring platform package is missing. Reinstall dependencies on the target platform.');
for(const name of nativePackages) await copyProduct(`node_modules/@napi-rs/${name}`,`${output}/node_modules/@napi-rs/${name}`,true);
await writeFile(path.join(output,'package.json'),JSON.stringify({name:'krill-usage-codex-plugin',version,private:true,type:'module',license:'GPL-3.0-only',engines:{node:'>=22'}},null,2)+'\n');
// Preserve license texts for bundled runtime dependencies, including transitive packages.
const notices=path.join(output,'THIRD_PARTY_NOTICES'); await mkdir(notices,{recursive:true});
async function collect(dir, prefix='') {
 for(const ent of await readdir(dir,{withFileTypes:true})) {
  if(!ent.isDirectory()||ent.name.startsWith('.'))continue;
  const full=path.join(dir,ent.name);if(ent.name.startsWith('@')) {await collect(full,ent.name+'/');continue;}
  const names=await readdir(full);const target=path.join(notices,(prefix+ent.name).replaceAll('/','__'));
  for(const name of names.filter(n=>/^(licen[cs]e|notice|copying)(\.|$)/i.test(n))) {
   await mkdir(target,{recursive:true}); await copyProduct(path.join(full,name),path.join(target,name));
  }
 }
}
await collect('node_modules');
await mkdir(path.join(root,'.agents/plugins'),{recursive:true});
await cp('../../.agents/plugins/marketplace.json',path.join(root,'.agents/plugins/marketplace.json'));
await writeFile(path.join(root,'README.md'),'# Krill Usage for Codex\n\nRequires Node.js 22+. From this directory run `codex plugin marketplace add .`, restart Codex, then install Krill Usage from Krill Usage Local.\n\nSee [installation, platform requirements and credential setup](plugins/krill-usage/README.md). Account/password login and new JWT entry are Windows-only.\n');
// CI supplies the exact checkout commit. A local/source-ZIP build may have no Git metadata.
const sourceCommit=process.env.GITHUB_SHA || null;
await writeFile(path.join(root,'BUILD-INFO.json'),JSON.stringify({version,sourceCommit,platform:process.platform,arch:process.arch},null,2)+'\n');
const tag=`${process.platform}-${process.arch}`;
const filename=`krill-usage-codex-${version}-${tag}.tar.gz`;
// Windows/macOS ship bsdtar; Linux generally ships GNU tar.
const tarVersion=execFileSync('tar',['--version'],{encoding:'utf8'});
const ownerArgs=/bsdtar/i.test(tarVersion)
  ? ['--uid','0','--gid','0','--uname','root','--gname','root']
  : ['--owner=0','--group=0','--numeric-owner'];
execFileSync('tar',[...ownerArgs,'-czf',path.resolve('artifacts',filename),'-C','artifacts','krill-usage-codex']);
const bytes=await readFile(path.join('artifacts',filename));
await writeFile(path.join('artifacts',filename+'.sha256'),`${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`);
console.log(`Packaged artifacts/${filename}; includes native bindings for ${tag}.`);
