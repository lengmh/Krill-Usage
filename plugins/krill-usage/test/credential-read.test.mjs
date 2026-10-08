import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCredentialStore, SERVICE, ACCOUNT, REVISION_FILE, READ_TIMEOUT_MS } from '../src/credentials.cjs';
import { UsageService } from '../src/service.mjs';
import { createPreferences } from '../src/preferences.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realSetTimeout = globalThis.setTimeout;
const delay = ms => new Promise(resolve => realSetTimeout(resolve, ms));
const fixtureModule = require.resolve('./fixtures/credential-read-keyring.cjs');
const noSecret = error => {
  assert.equal(error.code, 'SECRET_STORAGE');
  assert.ok(!String(error.stack).includes('synthetic-'));
  assert.equal(error.cause, undefined);
  return true;
};
async function until(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'synthetic child did not reach the expected state');
    await delay(10);
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function fixture(t, { mockResolve = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'krill-read-'));
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(path.join(stateDir, REVISION_FILE), JSON.stringify({ version: 1, revision: randomUUID(), phase: 'ready' }), { mode: 0o600 });
  const controlPath = path.join(dir, 'control.json');
  const eventsPath = path.join(dir, 'events.jsonl');
  const modulePath = path.join(dir, 'keyring.cjs');
  writeFileSync(modulePath, `module.exports = require(${JSON.stringify(fixtureModule)})(${JSON.stringify(controlPath)}, ${JSON.stringify(eventsPath)});\n`);
  const control = values => writeFileSync(controlPath, JSON.stringify(values));
  control({ mode: 'success' });
  const events = () => { try { return readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  let resolutions = 0;
  if (mockResolve) {
    const resolve = Module._resolveFilename;
    t.mock.method(Module, '_resolveFilename', function (request, ...args) {
      if (request === '@napi-rs/keyring') { resolutions++; return modulePath; }
      return resolve.call(this, request, ...args);
    });
  }
  const store = createCredentialStore({ stateDir });
  t.after(() => { store.dispose(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, stateDir, modulePath, store, control, events, resolutions: () => resolutions,
    async exited() { await until(() => events().every(event => !alive(event.pid))); }
  };
}

test('default binding lazily selects isolated AsyncEntry with durable fixed entry and cleans its deadline', async t => {
  const f = fixture(t);
  const pending = new Set();
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, timeout, ...args) => {
    const timer = realSetTimeout(callback, timeout, ...args);
    if (timeout === READ_TIMEOUT_MS) pending.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { pending.delete(timer); return clear(timer); });
  assert.match(await f.store.readRevision(), /^[a-f0-9-]{36}$/u);
  assert.equal(f.resolutions(), 0);
  assert.equal(await f.store.read(), 'synthetic-account-a');
  assert.equal(f.resolutions(), 1);
  assert.deepEqual(f.events()[0].args, [SERVICE, ACCOUNT, { linux: { store: 'secret-service' } }]);
  assert.notEqual(f.events()[0].pid, process.pid);
  assert.equal(pending.size, 0);
  assert.ok(f.events().every(event => !alive(event.pid)), 'success waits for child close');
  f.control({ mode: 'success', value: null });
  assert.equal(await f.store.read(), null);
  assert.equal(pending.size, 0);
});

for (const mode of ['constructor-block', 'read-block', 'never', 'late', 'exit-block']) {
  test(`${mode} is bounded, coalesced, sanitized, terminated, and permits another refresh`, { timeout: 10_000 }, async t => {
    const f = fixture(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const preferences = createPreferences(f.stateDir);
    const requests = [];
    const service = new UsageService({ credentials: f.store, preferences,
      fetchUsage: async jwt => { requests.push(jwt); return { creditBalance: '200', subscriptions: [] }; }
    });
    t.after(() => service.dispose());
    f.control({ mode });
    const first = service.refresh();
    assert.equal(service.refresh(), first);
    await until(() => f.events().some(event => event.event === (mode === 'constructor-block' ? 'construct' : 'read')));
    const observed = await service.read();
    assert.equal(observed.refreshing, true, 'parent event loop remains responsive');
    assert.equal(f.events().filter(event => event.event === 'construct').length, 1);
    t.mock.timers.tick(READ_TIMEOUT_MS);
    const failed = await first;
    assert.equal(failed.error.code, 'SECRET_STORAGE');
    assert.equal(failed.refreshing, false);
    assert.equal(failed.snapshot, null);
    assert.equal(failed.authenticated, false);
    assert.deepEqual(requests, []);
    assert.ok(!JSON.stringify(failed).includes('synthetic-'));
    await f.exited();
    f.control({ mode: 'success', value: 'synthetic-account-b' });
    const recovered = await service.refresh();
    assert.equal(recovered.error, null);
    assert.equal(recovered.snapshot.creditBalance, '200');
    assert.deepEqual(requests, ['synthetic-account-b']);
    t.mock.timers.tick(READ_TIMEOUT_MS * 2);
    assert.equal(service.view().error, null);
    assert.equal(f.events().filter(event => event.event === 'late-result').length, 0);
  });
}

test('native Promise rejection and private diagnostics are sanitized, then retry succeeds', async t => {
  const f = fixture(t);
  f.control({ mode: 'reject' });
  await assert.rejects(f.store.read(), noSecret);
  await f.exited();
  f.control({ mode: 'success' });
  assert.equal(await f.store.read(), 'synthetic-account-a');
});

test('invalid or oversized child results and abrupt exits fail closed without poisoning another read', async t => {
  const f = fixture(t);
  for (const control of [
    { mode: 'success', value: 'x'.repeat(16_385) },
    { mode: 'success', value: { credential: 'synthetic-invalid-value' } },
    { mode: 'invalid-ipc' },
    { mode: 'exit' }
  ]) {
    f.control(control);
    await assert.rejects(f.store.read(), noSecret);
    await f.exited();
  }
  f.control({ mode: 'success' });
  assert.equal(await f.store.read(), 'synthetic-account-a');
});

test('revision guards reject old-account result and never coalesce a new-account read into it', async t => {
  const f = fixture(t);
  const marker = phase => writeFileSync(path.join(f.stateDir, REVISION_FILE), JSON.stringify({ version: 1, revision: randomUUID(), phase }), { mode: 0o600 });
  marker('ready');
  f.control({ mode: 'controlled', value: 'synthetic-account-a' });
  const first = f.store.read();
  const rejected = assert.rejects(first, noSecret);
  await until(() => f.events().some(event => event.event === 'read'));
  marker('changing');
  await assert.rejects(f.store.read(), noSecret);
  marker('ready');
  await assert.rejects(f.store.read(), noSecret);
  assert.equal(f.events().filter(event => event.event === 'construct').length, 1);
  f.control({ mode: 'controlled', release: true });
  await rejected;
  f.control({ mode: 'success', value: 'synthetic-account-b' });
  assert.equal(await f.store.read(), 'synthetic-account-b');
});

test('service disposal terminates a blocked child and releases its pending read', async t => {
  const f = fixture(t);
  f.control({ mode: 'constructor-block' });
  const service = new UsageService({ credentials: f.store, preferences: createPreferences(f.stateDir),
    fetchUsage: async () => { throw new Error('must not request usage'); }
  });
  const pending = service.refresh();
  await until(() => f.events().length > 0);
  service.dispose();
  assert.equal((await pending).refreshing, false);
  await f.exited();
  await assert.rejects(f.store.read(), noSecret);
});

test('packaged MCP stays responsive during a blocked default vault read and recovers after its deadline', { timeout: 15_000 }, async t => {
  const f = fixture(t, { mockResolve: false });
  f.control({ mode: 'constructor-block' });
  // Stage the real bundle with only a fake native package. This exercises Node's
  // actual package resolution from dist/server.js while launched from another cwd.
  const packaged = path.join(f.dir, 'package');
  const native = path.join(packaged, 'node_modules', '@napi-rs', 'keyring');
  mkdirSync(path.join(packaged, 'dist'), { recursive: true });
  mkdirSync(native, { recursive: true });
  writeFileSync(path.join(packaged, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(path.join(native, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  copyFileSync(f.modulePath, path.join(native, 'index.cjs'));
  for (const file of ['server.js', 'app.html']) copyFileSync(path.resolve('dist', file), path.join(packaged, 'dist', file));
  const client = new Client({ name: 'Synthetic vault timeout client', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(packaged, 'dist', 'server.js')],
    cwd: f.dir,
    env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, LOCALAPPDATA: f.dir, XDG_STATE_HOME: f.dir }, stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data; });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const first = client.callTool({ name: 'krill.usage', arguments: {} });
  await until(() => f.events().length > 0);
  const [tools, settings, read] = await Promise.all([
    client.listTools(), client.callTool({ name: 'settings.read', arguments: {} }),
    client.callTool({ name: 'krill.read', arguments: {} })
  ]);
  assert.ok(tools.tools.some(tool => tool.name === 'krill.usage'));
  assert.equal(settings.structuredContent.values.refreshIntervalMinutes, 3);
  assert.equal(read.structuredContent.view.refreshing, true);
  const failed = await first;
  assert.equal(failed.structuredContent.view.error.code, 'SECRET_STORAGE');
  assert.equal(failed.structuredContent.view.refreshing, false);
  await f.exited();
  // An absent synthetic credential proves the retry reaches the next default
  // child without ever making a real Krill network request.
  f.control({ mode: 'success', value: null });
  const recovered = await client.callTool({ name: 'krill.refresh', arguments: {} });
  assert.equal(recovered.structuredContent.view.error.code, 'NO_JWT');
  assert.equal(f.events().filter(event => event.event === 'construct').length, 2);
  assert.equal(stderr, '');
  assert.ok(!JSON.stringify([failed, recovered]).includes('synthetic-'));
  f.control({ mode: 'constructor-block' });
  const interrupted = client.callTool({ name: 'krill.refresh', arguments: {} }).catch(() => undefined);
  await until(() => f.events().filter(event => event.event === 'construct').length === 3);
  await client.close();
  await transport.close();
  await interrupted;
  await f.exited();
});
