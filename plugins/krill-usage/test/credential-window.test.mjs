import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { promptCredential } = createRequire(import.meta.url)('../src/credential-prompt.cjs');
import { compileCredentialHelper } from '../scripts/build-credential-helper.mjs';

const windows = process.platform === 'win32';
test('Windows production PasswordBox handles whole paste, explicit Save, cancellation, and protocol pipes', { skip: windows ? false : 'Requires Windows WPF; actual GUI coverage runs on Windows CI.', timeout: 90_000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'krill-window-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const harness = path.join(temporary, 'CredentialPromptHarness.exe');
  await compileCredentialHelper({ output: harness, sources: ['native/CredentialPrompt.cs', 'test/fixtures/CredentialPromptHarness.cs'], main: 'CredentialPromptHarness', target: 'winexe' });
  const run = (args, options = {}) => spawnSync(harness, args, { encoding: 'utf8', timeout: 45_000, windowsHide: false, ...options });
  const suite = run([]);
  assert.equal(suite.error, undefined, 'Windows GUI harness must launch and finish, not silently skip.');
  assert.equal(suite.status, 0, suite.stderr);
  assert.match(suite.stdout, /Synthetic PasswordBox checks passed:/u);

  for (const mode of ['flow-save', 'flow-cancel']) {
    let flowChild;
    const timer = setTimeout(() => flowChild?.kill(), 10_000);
    try {
      const result = promptCredential({ spawnHelper(_file, _args, options) {
        flowChild = spawn(harness, [mode], options);
        return flowChild;
      } });
      if (mode === 'flow-save') assert.equal(await result, 'synthetic-window-tokené');
      else await assert.rejects(result, { code: 'CANCELLED' });
    } finally { clearTimeout(timer); flowChild?.kill(); }
  }

  assert.equal(run(['guard']).status, 0, 'Anonymous input/output pipes are required.');
  const output = await open(path.join(temporary, 'guard-output'), 'w');
  try {
    assert.equal(run(['guard'], { stdio: ['pipe', output.fd, 'pipe'] }).status, 3, 'File output cannot collect a credential.');
    const direct = spawnSync(path.resolve('dist/CredentialPrompt.exe'), [], { timeout: 5000, windowsHide: false, stdio: ['pipe', output.fd, 'pipe'] });
    assert.equal(direct.error, undefined);
    assert.equal(direct.status, 1, 'Production helper must reject a non-pipe stdout before displaying UI.');
  } finally { await output.close(); }
  assert.equal(run(['guard'], { stdio: ['ignore', 'pipe', 'pipe'] }).status, 3, 'A missing parent pipe cannot open the credential UI.');
  const parentEOF = run(['parent-eof']);
  assert.equal(parentEOF.error, undefined);
  assert.equal(parentEOF.status, 0, parentEOF.stderr);
  assert.equal(parentEOF.stdout, '');

  // Exercise the shipped EXE as well: EOF cancels an open dialog and emits no JWT.
  const child = spawn(path.resolve('dist/CredentialPrompt.exe'), [], { windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = setTimeout(() => child.kill(), 10_000);
  child.stdin.end();
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  clearTimeout(timer);
  assert.equal(code, 130, 'Production helper cancels when parent stdin closes.');
  assert.equal(stdout, ''); assert.equal(stderr, '');
});
