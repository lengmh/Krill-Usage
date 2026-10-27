// One-shot unified GitHub Release for the exact verified v0.1.7 source.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = 'lengmh/Krill-Usage';
const version = '0.1.7';
const tag = 'v0.1.7';
const sourceCommit = process.env.GITHUB_SHA;
assert.equal(process.env.GITHUB_REPOSITORY, repo);
assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
assert.match(sourceCommit ?? '', /^[0-9a-f]{40}$/);
const exec = (cmd, args) => execFileSync(cmd, args, {encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
assert.equal(exec('git', ['rev-parse','HEAD']), sourceCommit);
assert.equal(JSON.parse(readFileSync('package.json','utf8')).version, version);
assert.equal(JSON.parse(readFileSync('plugins/krill-usage/package.json','utf8')).version, version);
assert.equal(JSON.parse(readFileSync('plugins/krill-usage/.codex-plugin/plugin.json','utf8')).version, version);
const gh = (...args) => exec('gh', args);
const api = uri => JSON.parse(gh('api','repos/'+repo+'/'+uri));
const releases = api('releases?per_page=100');
assert.ok(!releases.some(r => r.tag_name === tag), 'Refuse to replace an existing v0.1.7 release.');
assert.ok(!api('git/matching-refs/tags/'+tag).some(r => r.ref === 'refs/tags/'+tag),
  'Refuse to reuse or move an existing v0.1.7 tag.');
const previousTagShas = {
  'v0.1.5':'c74467518c35eaacba1ac5d7c588af1e97fac22d',
  'v0.1.6':'6702a777c13407046109f8427af434210fb07c55'
};
const preserved = {};
for (const [prior, sha] of Object.entries(previousTagShas)) {
  assert.equal(api('git/ref/tags/'+prior).object.sha, sha, 'Historical tag changed: '+prior);
  const release = api('releases/tags/'+prior);
  preserved[prior] = {
    id: release.id, body: release.body, name: release.name,
    assets: release.assets.map(a => ({id:a.id, name:a.name, digest:a.digest, size:a.size}))
  };
}
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function findInput(fileName) {
  const items = readdirSync('release-input',{recursive:true});
  const matches = items.filter(item => path.basename(item) === fileName);
  assert.equal(matches.length, 1, 'Expected one release-input/'+fileName);
  const full = path.join('release-input', matches[0]);
  assert.ok(existsSync(full), 'Missing '+fileName);
  return full;
}
const output = 'release-assets';
mkdirSync(output,{recursive:true});
const assets = [];
function retain(name, source = findInput(name)) {
  const target = path.join(output,name);
  cpSync(source,target);
  assets.push({name,size:readFileSync(target).length,sha256:sha256(target)});
  return target;
}
const vsixName = 'krill-usage-'+version+'.vsix';
const vsix = retain(vsixName);
const vscodePkg = JSON.parse(exec('unzip',['-p',vsix,'extension/package.json']));
assert.equal(vscodePkg.version,version);
assert.equal(vscodePkg.publisher,'lengmh');
assert.equal(vscodePkg.name,'krill-usage');
const vsixEntries = exec('unzip',['-Z','-1',vsix]);
for (const asset of ['extension/src/api.js','extension/src/service.js',
   'extension/src/statusBar.js','extension/src/recoveryLock.js','extension/PRIVACY.md']) {
  assert.ok(vsixEntries.includes(asset), 'VSIX missing '+asset);
}
for (const platform of ['win32-x64','darwin-arm64','linux-x64']) {
  const fileName = 'krill-usage-codex-'+version+'-'+platform+'.tar.gz';
  const source = findInput(fileName);
  const actual = sha256(source);
  assert.equal(readFileSync(findInput(fileName+'.sha256'),'utf8').trim(),actual+'  '+fileName,
    'Mismatched platform checksum: '+fileName);
  const member = memberPath => exec('tar',['-xOf',source,'krill-usage-codex/'+memberPath]);
  const build = JSON.parse(member('BUILD-INFO.json'));
  assert.equal(build.version, version);
  assert.equal(build.sourceCommit, sourceCommit);
  assert.equal(build.platform+'-'+build.arch,platform);
  assert.equal(JSON.parse(member('plugins/krill-usage/package.json')).version, version);
  assert.equal(JSON.parse(member('plugins/krill-usage/.codex-plugin/plugin.json')).version, version);
  assert.equal(JSON.parse(member('.agents/plugins/marketplace.json')).plugins[0].source.path,
    './plugins/krill-usage');
  const entries = exec('tar',['-tzf',source]);
  for (const f of ['dist/server.js','dist/app.html','dist/credential-cli.cjs',
    'PRIVACY.md','LICENSE','THIRD_PARTY_NOTICES/']) {
    assert.ok(entries.includes('krill-usage-codex/plugins/krill-usage/'+f),
      'Missing '+f+' in '+fileName);
  }
  assert.ok(entries.includes('node_modules/@napi-rs/keyring-'+platform),
    'Wrong or absent native keyring package in '+fileName);
  if (platform === 'win32-x64') {
    assert.ok(entries.includes('krill-usage-codex/plugins/krill-usage/dist/CredentialPrompt.exe'));
  }
  retain(fileName,source);
}
const sourceName='krill-usage-'+version+'-source.zip';
exec('git',['archive','--format=zip','--prefix=krill-usage-'+version+'-source/',
  '--output='+path.resolve(output,sourceName),sourceCommit]);
assets.push({name:sourceName, size:readFileSync(path.join(output,sourceName)).length,
  sha256:sha256(path.join(output,sourceName))});
const manifestName = 'RELEASE-'+version+'.json';
const manifest = {
  version, tag, sourceCommit,
  workflowRun:'https://github.com/'+repo+'/actions/runs/'+process.env.GITHUB_RUN_ID,
  previousTags:previousTagShas,
  platforms:['win32-x64','darwin-arm64','linux-x64'], assets
};
writeFileSync(path.join(output,manifestName),JSON.stringify(manifest,null,2)+'\n');
assets.push({name:manifestName,size:readFileSync(path.join(output,manifestName)).length,
  sha256:sha256(path.join(output,manifestName))});
const hashesName = 'SHA256SUMS-'+tag;
writeFileSync(path.join(output,hashesName),assets.map(a=>a.sha256+'  '+a.name+'\n').join(''));
const names=[...assets.map(a=>a.name),hashesName];
assert.equal(names.length,7);
const notes = [
  '# Krill Usage v0.1.7 — VS Code + Codex App',
  '',
  'Unified release from one source commit: safe quota-refresh diagnostics and resilient requests.',
  '',
  'VS Code: one bounded retry of transient GET failures, HTTP 429/5xx and Cloudflare classification, absolute timeout, focus/cooldown pacing, safe Hover/Output diagnostics and JWT recovery across windows. Cloudflare manual verification never replays saved passwords.',
  '',
  'Codex App: one bounded retry of eligible GET failures, Retry-After-aware cooldown, temporary sign-in transport recovery, preserved credential-vault protections and concise diagnostics in the quota panel.',
  '',
  'All account/password/JWT values stay out of diagnostics, logs and GitHub assets. No telemetry. Fixed first-party HTTPS endpoints. Historical v0.1.5 and v0.1.6 tags/assets remain unchanged.',
  '',
  'Downloads: '+vsixName+' (VS Code); krill-usage-codex-'+version+'-{win32-x64,darwin-arm64,linux-x64}.tar.gz (Codex); '+sourceName+' (complete source).',
  '',
  'Provenance: '+manifestName+' and '+hashesName+'. For Codex, extract the matching platform tarball, run codex plugin marketplace add . from krill-usage-codex, restart Codex and update the plugin. Requires Node.js 22+. Account/password and new JWT entry remain Windows-only.',
  '',
  'See PR #5 (VS Code), PR #6 (Codex) and bundled privacy notices.',
  'Source commit: https://github.com/'+repo+'/commit/'+sourceCommit,
  'Verified workflow: https://github.com/'+repo+'/actions/runs/'+process.env.GITHUB_RUN_ID,
  '',
  'Tests use synthetic credentials and mock networks. Real Krill/Cloudflare and target desktop account-side acceptance remain unverified. VS Code Marketplace publication is not part of this GitHub release.',
  ''
].join('\n');
writeFileSync('release-notes-v017.md',notes);
gh('release','create',tag,...names.map(name=>output+'/'+name),'--draft',
  '--target',sourceCommit,'--title','Krill Usage '+tag+' (VS Code + Codex)',
  '--notes-file','release-notes-v017.md','--repo',repo);
const draft=api('releases/tags/'+tag);
assert.equal(draft.draft,true);
assert.equal(api('git/ref/tags/'+tag).object.sha,sourceCommit);
assert.equal(draft.assets.length,names.length);
mkdirSync('release-verify',{recursive:true});
for (const name of names) {
  const remote=draft.assets.find(a=>a.name===name);
  assert.ok(remote,'Missing uploaded '+name);
  const digest='sha256:'+sha256(path.join(output,name));
  if (remote.digest) assert.equal(remote.digest,digest);
  gh('release','download',tag,'--pattern',name,'--dir','release-verify','--repo',repo);
  assert.deepEqual(readFileSync(path.join('release-verify',name)),readFileSync(path.join(output,name)),
    'Hosted asset mismatch: '+name);
}
assert.equal(draft.body,notes);
for (const [prior, original] of Object.entries(preserved)) {
  const release=api('releases/tags/'+prior);
  assert.equal(api('git/ref/tags/'+prior).object.sha,previousTagShas[prior]);
  assert.deepEqual({
    id:release.id, body:release.body, name:release.name,
    assets:release.assets.map(a=>({id:a.id,name:a.name,digest:a.digest,size:a.size}))
  },original,'Historical release '+prior+' has changed');
}
gh('release','edit',tag,'--draft=false','--repo',repo);
const published=api('releases/tags/'+tag);
assert.equal(published.draft,false);
assert.equal(published.prerelease,false);
assert.equal(published.assets.length,names.length);
console.log('Published '+tag+' at '+sourceCommit+': '+names.length+' byte-verified assets; preserved historical tags/releases.');
