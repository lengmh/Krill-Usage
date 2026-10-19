// Explicit workflow_dispatch only. Create a distinct corrective release; never retag or overwrite.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const repo='lengmh/Krill-Usage', version='0.1.6', tag=`v${version}`;
const previousTag='v0.1.5', previousTagCommit='c74467518c35eaacba1ac5d7c588af1e97fac22d';
assert.equal(process.env.GITHUB_REPOSITORY,repo);
assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
assert.equal(process.env.GITHUB_REF,'refs/heads/main');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(sourceCommit,process.env.GITHUB_SHA);
assert.match(sourceCommit,/^[0-9a-f]{40}$/);
const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8'});
const get=(resource)=>JSON.parse(gh('api',`repos/${repo}/${resource}`));
const previous=get(`releases/tags/${previousTag}`);
assert.equal(get(`git/ref/tags/${previousTag}`).object.sha,previousTagCommit);
assert.ok(!get(`git/matching-refs/tags/${tag}`).some(ref=>ref.ref===`refs/tags/${tag}`),'Target tag already exists; inspect instead of overwriting.');
assert.ok(!get('releases?per_page=100').some(release=>release.tag_name===tag),'Target release already exists; inspect instead of overwriting.');

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
  assert.equal(JSON.parse(member('plugins/krill-usage/.codex-plugin/plugin.json')).version,version);
  assert.equal(JSON.parse(member('plugins/krill-usage/package.json')).version,version);
  assert.equal(JSON.parse(member('.agents/plugins/marketplace.json')).plugins[0].source.path,'./plugins/krill-usage');
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
const manifestName=`CODEX-RELEASE-${version}.json`;
writeFileSync(`${output}/${manifestName}`,JSON.stringify({version,sourceCommit,tag,previousTag,previousTagCommit,workflowRun:`https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,assets},null,2)+'\n');
assets.push({filename:manifestName,sha256:createHash('sha256').update(readFileSync(`${output}/${manifestName}`)).digest('hex')});
const checksums=`SHA256SUMS-codex-${version}`;
writeFileSync(`${output}/${checksums}`,assets.map(a=>`${a.sha256}  ${a.filename}\n`).join(''));
const names=[...assets.map(a=>a.filename),checksums];
const notes=`# Krill Usage Codex ${version}\n\n`+
`Corrects the JWT-only privacy choice in Codex 0.1.5: unchecking Remember password now stores neither email nor password. Version 0.1.5 omitted the password but retained the email in the encrypted OS vault, contrary to the native dialog's token-only promise. No plaintext-password or model/log exposure was found.\n\n`+
`After upgrading, refresh the quota once to remove a retained email from an older password-absent record while preserving its JWT. Cleanup uses the existing write lock and credential revision checks; failures before writing can be retried after unlocking. A failure after the changing marker was written requires owner recovery with the JWT-only set command or clear --confirm-clear; unlock alone does not complete that interrupted write. Remembered accounts retain their password-based recovery. Pure state reads do not mutate the vault.\n\n`+
`Download the matching win32-x64, darwin-arm64 or linux-x64 Codex archive. Extract it, enter the krill-usage-codex directory and run \`codex plugin marketplace add .\`. Restart Codex and update/reinstall Krill Usage from Krill Usage Local, then open a new session. Node.js 22+ is required. Account/password and new JWT entry remain Windows 10/11 + .NET Framework 4.8+ only. Never put credentials in chat, terminal input, arguments or ordinary settings. [Installation and credential instructions](https://github.com/${repo}/blob/${sourceCommit}/plugins/krill-usage/README.md).\n\n`+
`All packages, the separate \`${sourceName}\`, and tag \`${tag}\` correspond to [${sourceCommit}](https://github.com/${repo}/commit/${sourceCommit}); [platform build/test run](https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}). \`${checksums}\` and \`${manifestName}\` record hashes and provenance. Tests use synthetic credentials and API responses; real Krill login, native-vault behavior and target Codex desktop acceptance still need verification on the user's computer.\n\n`+
`This is a Codex-only corrective release. VS Code remains 0.1.5. Every existing v0.1.5 asset and its tag at ${previousTagCommit} remain unchanged; no Visual Studio Marketplace publication is changed.\n`;
writeFileSync('release-notes.md',notes);
// Creates a fresh tag at the exact verified source commit. No --clobber or asset replacement.
gh('release','create',tag,...names.map(name=>`${output}/${name}`),'--target',sourceCommit,'--title',`Krill Usage Codex ${version}`,'--notes-file','release-notes.md','--repo',repo);
const after=get(`releases/tags/${tag}`);
assert.equal(after.draft,false); assert.equal(after.prerelease,false);
assert.equal(get(`git/ref/tags/${tag}`).object.sha,sourceCommit);
assert.equal(get(`git/ref/tags/${previousTag}`).object.sha,previousTagCommit);
const previousAfter=get(`releases/tags/${previousTag}`);
assert.equal(previousAfter.body,previous.body); assert.equal(previousAfter.name,previous.name);
for(const old of previous.assets) {
  const current=previousAfter.assets.find(a=>a.id===old.id);
  assert.ok(current); assert.equal(current.name,old.name); assert.equal(current.digest,old.digest); assert.equal(current.size,old.size);
}
mkdirSync('release-verify',{recursive:true});
for(const name of names) gh('release','download',tag,'--pattern',name,'--dir','release-verify','--repo',repo);
for(const name of names) assert.deepEqual(readFileSync(`release-verify/${name}`),readFileSync(`${output}/${name}`));
assert.equal(after.body,notes);
console.log(`Verified ${names.length} new release assets at ${sourceCommit}; v0.1.5 assets and tag preserved.`);
