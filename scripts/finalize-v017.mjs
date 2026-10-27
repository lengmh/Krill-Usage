// One-time finalization of the already-built and already-uploaded draft v0.1.7.
// This script never creates/replaces a tag, Release or asset. It checks original
// verified build outputs and the server-side SHA256 digests before publication.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'lengmh/Krill-Usage';
const version = '0.1.7';
const tag = 'v0.1.7';
const sourceCommit = 'd30d59a0c5b2d16ef1c93011705a477529432f32';
const originalBuildRun = '40507261208';
const expectedDraftId = 425457464;
const priorTags = {
  'v0.1.5':'c74467518c35eaacba1ac5d7c588af1e97fac22d',
  'v0.1.6':'6702a777c13407046109f8427af434210fb07c55'
};
assert.equal(process.env.GITHUB_REPOSITORY, repo);
assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
assert.equal(process.env.GITHUB_SHA && /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA), true);
const exec = (command,args) => execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const gh = (...args) => exec('gh',args);
const api = (route) => JSON.parse(gh('api',`repos/${repo}/${route}`));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(exec('git',['rev-parse','HEAD']), sourceCommit,
  'Checkout must be the original v0.1.7 source commit, not the later finalize workflow commit.');
const srcPkg = JSON.parse(readFileSync('package.json','utf8'));
const appPkg = JSON.parse(readFileSync('plugins/krill-usage/package.json','utf8'));
assert.equal(srcPkg.version,version);
assert.equal(appPkg.version,version);
assert.equal(JSON.parse(readFileSync('plugins/krill-usage/.codex-plugin/plugin.json','utf8')).version,version);

const releases = api('releases?per_page=100');
const draft = releases.find(r => r.tag_name===tag && r.draft===true);
assert.ok(draft,'The existing draft v0.1.7 release must be present; refuse any unrelated release.');
assert.equal(draft.id,expectedDraftId);
const detailed = api(`releases/${expectedDraftId}`);
assert.equal(detailed.id,draft.id);
assert.equal(detailed.draft,true);
assert.equal(detailed.tag_name,tag);
assert.equal(detailed.target_commitish,sourceCommit);
assert.equal(detailed.name,'Krill Usage v0.1.7 (VS Code + Codex)');
assert.ok(detailed.body?.includes('Source commit: https://github.com/'+repo+'/commit/'+sourceCommit));
assert.ok(detailed.body?.includes('https://github.com/'+repo+'/actions/runs/'+originalBuildRun));
// GitHub does not necessarily create a tag ref for a draft release.
assert.ok(!api('git/matching-refs/tags/'+tag).some(x=>x.ref==='refs/tags/'+tag),
  'Publication tag already exists unexpectedly. Refuse to overwrite it.');
const earlier={};
for(const [oldTag,sha] of Object.entries(priorTags)) {
  assert.equal(api('git/ref/tags/'+oldTag).object.sha,sha);
  const x=api('releases/tags/'+oldTag);
  earlier[oldTag]={id:x.id,name:x.name,body:x.body,
    assets:x.assets.map(a=>({id:a.id,name:a.name,size:a.size,digest:a.digest}))};
}
function findInput(name){
  const paths=readdirSync('release-input',{recursive:true}).filter(x=>path.basename(x)===name);
  assert.equal(paths.length,1,`Missing or duplicate original verified build: ${name}`);
  return path.join('release-input',paths[0]);
}
const assets=[];
function addOriginalAsset(name){
  const file=findInput(name);
  const info={name,size:statSync(file).size,sha256:sha256(file)};
  assets.push(info);return file;
}
const vsix=addOriginalAsset('krill-usage-0.1.7.vsix');
const embedded=JSON.parse(exec('unzip',['-p',vsix,'extension/package.json']));
assert.equal(embedded.name,'krill-usage');
assert.equal(embedded.publisher,'lengmh');
assert.equal(embedded.version,version);
for(const member of ['extension/src/api.js','extension/src/service.js',
  'extension/src/statusBar.js','extension/src/recoveryLock.js','extension/PRIVACY.md']) {
  assert.ok(exec('unzip',['-Z','-1',vsix]).includes(member),`VSIX missing ${member}`);
}
for(const platform of ['win32-x64','darwin-arm64','linux-x64']) {
  const filename=`krill-usage-codex-${version}-${platform}.tar.gz`;
  const file=findInput(filename);
  assert.equal(readFileSync(findInput(filename+'.sha256'),'utf8').trim(),
    `${sha256(file)}  ${filename}`, `Build checksum mismatch: ${filename}`);
  const member=name=>exec('tar',['-xOf',file,`krill-usage-codex/${name}`]);
  const build=JSON.parse(member('BUILD-INFO.json'));
  assert.equal(build.version,version);
  assert.equal(build.sourceCommit,sourceCommit);
  assert.equal(`${build.platform}-${build.arch}`,platform);
  assert.equal(JSON.parse(member('plugins/krill-usage/package.json')).version,version);
  assert.equal(JSON.parse(member('plugins/krill-usage/.codex-plugin/plugin.json')).version,version);
  assert.equal(JSON.parse(member('.agents/plugins/marketplace.json')).plugins[0].source.path,'./plugins/krill-usage');
  const entries=exec('tar',['-tzf',file]);
  for(const m of ['dist/server.js','dist/app.html','dist/credential-cli.cjs',
    'PRIVACY.md','LICENSE','THIRD_PARTY_NOTICES/']) {
    assert.ok(entries.includes(`krill-usage-codex/plugins/krill-usage/${m}`),`Missing ${m} in ${filename}`);
  }
  assert.ok(entries.includes(`node_modules/@napi-rs/keyring-${platform}`),
    `Native keyring not found for ${platform}`);
  if(platform==='win32-x64')assert.ok(entries.includes('krill-usage-codex/plugins/krill-usage/dist/CredentialPrompt.exe'));
  addOriginalAsset(filename);
}
mkdirSync('release-recreate',{recursive:true});
const sourceName=`krill-usage-${version}-source.zip`;
exec('git',['archive','--format=zip',`--prefix=krill-usage-${version}-source/`,
  `--output=${path.resolve('release-recreate',sourceName)}`,sourceCommit]);
const sourcePath=path.join('release-recreate',sourceName);
assets.push({name:sourceName,size:statSync(sourcePath).size,sha256:sha256(sourcePath)});
// Rebuild the exact manifest and SHA256SUMS bytes as the previous publication job.
const manifestName=`RELEASE-${version}.json`;
const manifest={version,tag,sourceCommit,
  workflowRun:`https://github.com/${repo}/actions/runs/${originalBuildRun}`,
  previousTags:priorTags,platforms:['win32-x64','darwin-arm64','linux-x64'],assets};
const manifestPath=path.join('release-recreate',manifestName);
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
assets.push({name:manifestName,size:statSync(manifestPath).size,sha256:sha256(manifestPath)});
const checksumsName=`SHA256SUMS-${tag}`;
const checksumsPath=path.join('release-recreate',checksumsName);
writeFileSync(checksumsPath,assets.map(a=>`${a.sha256}  ${a.name}\n`).join(''));
const expected=[...assets,{name:checksumsName,size:statSync(checksumsPath).size,sha256:sha256(checksumsPath)}];
assert.equal(expected.length,7);
assert.equal(detailed.assets.length,7);
for(const item of expected){
  const matching=detailed.assets.filter(x=>x.name===item.name);
  assert.equal(matching.length,1,`Missing/duplicate draft asset: ${item.name}`);
  const remote=matching[0];
  assert.equal(remote.state,'uploaded');
  assert.equal(remote.size,item.size,`Size mismatch on ${item.name}`);
  assert.equal(remote.digest,`sha256:${item.sha256}`,`SHA256 mismatch on ${item.name}`);
}
console.log(`Verified ${expected.length} existing draft assets against original CI build run ${originalBuildRun}, source archive and exact hashes.`);
// Re-check draft identity just before the only mutating action.
const before=api(`releases/${expectedDraftId}`);
assert.equal(before.id,expectedDraftId);
assert.equal(before.draft,true);
assert.equal(before.target_commitish,sourceCommit);
assert.deepEqual(before.assets.map(x=>[x.id,x.name,x.size,x.digest]).sort(),
  detailed.assets.map(x=>[x.id,x.name,x.size,x.digest]).sort());
// Existing GH draft has no tag ref yet: publishing creates the tag at target_commitish.
api(`releases/${expectedDraftId}`);
const update=JSON.parse(gh('api','-X','PATCH',`repos/${repo}/releases/${expectedDraftId}`,'-F','draft=false'));
assert.equal(update.id,expectedDraftId);
assert.equal(update.draft,false);
const publicRelease=api(`releases/${expectedDraftId}`);
assert.equal(publicRelease.draft,false);
assert.equal(publicRelease.prerelease,false);
assert.equal(publicRelease.target_commitish,sourceCommit);
assert.equal(publicRelease.assets.length,expected.length);
assert.equal(api('git/ref/tags/'+tag).object.sha,sourceCommit);
assert.equal(api('releases/tags/'+tag).id,expectedDraftId);
for(const [oldTag,sha] of Object.entries(priorTags)){
  assert.equal(api('git/ref/tags/'+oldTag).object.sha,sha);
  const release=api('releases/tags/'+oldTag);
  assert.deepEqual({id:release.id,name:release.name,body:release.body,
    assets:release.assets.map(a=>({id:a.id,name:a.name,size:a.size,digest:a.digest}))},earlier[oldTag],
    `Historical release modified: ${oldTag}`);
}
console.log(`Published verified ${tag} from ${sourceCommit}, previous releases unchanged.`);
