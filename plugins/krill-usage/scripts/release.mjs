// Explicit workflow_dispatch only. Add to the existing release; never retag or overwrite.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const repo='lengmh/Krill-Usage', version='0.1.4', tag=`v${version}`;
const originalTag='606567f6110e4bff1020d089d4a30807802bffb5';
assert.equal(process.env.GITHUB_REPOSITORY,repo);
assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
assert.equal(process.env.GITHUB_REF,'refs/heads/main');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(sourceCommit,process.env.GITHUB_SHA);
assert.match(sourceCommit,/^[0-9a-f]{40}$/);
const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8'});
const get=(resource)=>JSON.parse(gh('api',`repos/${repo}/${resource}`));
const release=get(`releases/tags/${tag}`);
assert.equal(release.draft,false); assert.equal(release.immutable,false);
assert.equal(get(`git/ref/tags/${tag}`).object.sha,originalTag);
const marker='<!-- krill-codex-v0.1.4 -->';
assert.ok(!release.body?.includes(marker),'Codex release notes already exist; inspect before retrying.');

const output='release-assets'; mkdirSync(output,{recursive:true});
const platforms=['win32-x64','darwin-arm64','linux-x64'];
const assets=[];
for(const platform of platforms) {
  const filename=`krill-usage-codex-${version}-${platform}.tar.gz`;
  const matches=readdirSync('release-downloads',{recursive:true}).filter(file=>path.basename(file)===filename);
  assert.equal(matches.length,1,`Expected one ${filename}`);
  const source=path.join('release-downloads',matches[0]);
  const sha=createHash('sha256').update(readFileSync(source)).digest('hex');
  assert.equal(readFileSync(source+'.sha256','utf8').trim(),`${sha}  ${filename}`);
  const member=(name)=>execFileSync('tar',['-xOf',source,`krill-usage-codex/${name}`],{encoding:'utf8'});
  const build=JSON.parse(member('BUILD-INFO.json'));
  assert.equal(build.sourceCommit,sourceCommit); assert.equal(build.version,version);
  assert.equal(`${build.platform}-${build.arch}`,platform);
  const manifest=JSON.parse(member('plugins/krill-usage/.codex-plugin/plugin.json'));
  assert.equal(manifest.version,version);
  const marketplace=JSON.parse(member('.agents/plugins/marketplace.json'));
  assert.equal(marketplace.plugins[0].source.path,'./plugins/krill-usage');
  const entries=execFileSync('tar',['-tzf',source],{encoding:'utf8'});
  for(const entry of ['dist/server.js','dist/app.html','dist/credential-cli.cjs','LICENSE','PRIVACY.md','THIRD_PARTY_NOTICES/']) {
    assert.ok(entries.includes(`krill-usage-codex/plugins/krill-usage/${entry}`),`Missing ${entry}`);
  }
  assert.ok(entries.includes(`node_modules/@napi-rs/keyring-${platform}/`) || entries.includes(`node_modules/@napi-rs/keyring-${platform}-`));
  if(platform==='win32-x64') assert.ok(entries.includes('/dist/CredentialPrompt.exe'));
  cpSync(source,path.join(output,filename)); assets.push({filename,sha256:sha});
}
const sourceName=`krill-usage-codex-${version}-source.zip`;
execFileSync('git',['archive','--format=zip',`--prefix=krill-usage-codex-${version}-source/`,`--output=${output}/${sourceName}`,sourceCommit]);
assets.push({filename:sourceName,sha256:createHash('sha256').update(readFileSync(`${output}/${sourceName}`)).digest('hex')});
const manifestName='CODEX-RELEASE.json';
writeFileSync(`${output}/${manifestName}`,JSON.stringify({version,sourceCommit,tag,originalTagCommit:originalTag,workflowRun:`https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,assets},null,2)+'\n');
assets.push({filename:manifestName,sha256:createHash('sha256').update(readFileSync(`${output}/${manifestName}`)).digest('hex')});
const checksums=`SHA256SUMS-codex-${version}`;
writeFileSync(`${output}/${checksums}`,assets.map(a=>`${a.sha256}  ${a.filename}\n`).join(''));
const names=[...assets.map(a=>a.filename),checksums];
for(const name of names) assert.ok(!release.assets.some(a=>a.name===name),`Asset ${name} exists; no overwrite allowed.`);

const notes=`\n\n${marker}\n## Codex plugin 0.1.4 (added 2026-10-09)\n\n`+
`Local MCP App dashboard with manual refresh, quota/balance/reset information and nonsecret settings. Installation acceptance was reported as passed by the user; OS, desktop build and individual acceptance checks were not recorded. This does not assert all-platform desktop or native-vault certification.\n\n`+
`Download the matching win32-x64, darwin-arm64 or linux-x64 Codex archive. Extract it, enter the krill-usage-codex directory and run \`codex plugin marketplace add .\`. Restart Codex and install Krill Usage from Krill Usage Local. Node.js 22+ is required. New/replacement JWT entry is supported only on Windows 10/11 with .NET Framework 4.8+ through a native password window; macOS/Linux cannot add new credentials. Never put JWT in chat, terminal input, arguments or ordinary settings. [Installation and credential instructions](https://github.com/${repo}/blob/${sourceCommit}/plugins/krill-usage/README.md).\n\n`+
`Codex packages and the separate \`${sourceName}\` were built from [${sourceCommit}](https://github.com/${repo}/commit/${sourceCommit}); [platform build/test run](https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}). \`${checksums}\` covers these new files and \`${manifestName}\` records their provenance.\n\n`+
`The existing v0.1.4 tag, VS Code VSIX, original source ZIP and SHA256SUMS are unchanged at ${originalTag}. GitHub's automatic “Source code” links still refer to that original tag and do not contain the Codex plugin. Use the separate Codex source ZIP for corresponding source. No Visual Studio Marketplace publication is changed.\n`;
writeFileSync('release-notes.md',(release.body||'')+notes);
// No --clobber: even a concurrent upload cannot replace an existing asset.
gh('release','upload',tag,...names.map(name=>`${output}/${name}`),'--repo',repo);
gh('release','edit',tag,'--notes-file','release-notes.md','--repo',repo);
const after=get(`releases/tags/${tag}`);
assert.equal(get(`git/ref/tags/${tag}`).object.sha,originalTag);
for(const old of release.assets) {
  const current=after.assets.find(a=>a.id===old.id);
  assert.ok(current); assert.equal(current.name,old.name); assert.equal(current.digest,old.digest); assert.equal(current.size,old.size);
}
mkdirSync('release-verify',{recursive:true});
for(const name of names) gh('release','download',tag,'--pattern',name,'--dir','release-verify','--repo',repo);
for(const name of names) assert.deepEqual(readFileSync(`release-verify/${name}`),readFileSync(`${output}/${name}`));
assert.ok(after.body.endsWith(notes));
console.log(`Verified ${names.length} new release assets at ${sourceCommit}; original assets and tag preserved.`);
