import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startupFixture } from './fixtures/startup-service.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(t, revisionChecksOnly = false) {
  const f = startupFixture();
  // Account-mutation tests isolate mandatory revision checks from watch timing.
  if (revisionChecksOnly) f.service.subscription.dispose();
  t.after(() => f.close());
  return f;
}

for (const readFirst of [true, false]) {
  test(`real adapter cold start: ${readFirst ? 'read' : 'refresh'} first keeps one coalesced refresh`, async t => {
    const { service, calls } = fixture(t);
    let read, first;
    if (readFirst) { read = service.read(); first = service.refresh(); }
    else { first = service.refresh(); read = service.read(); }
    const second = service.refresh();
    assert.equal(first, second);
    const [observed, result, coalesced] = await Promise.all([read, first, second]);
    assert.equal(calls.vaultReads, 1);
    assert.deepEqual(calls.requests, ['synthetic-account-a']);
    assert.equal(observed.refreshing, true);
    assert.equal(result.snapshot.creditBalance, '100');
    assert.equal(result.authenticated, true);
    assert.equal(result.refreshing, false);
    assert.equal(result.error, null);
    assert.equal(result, coalesced);
    assert.ok(result.snapshotRevision > observed.snapshotRevision);
    assert.equal((await service.read()).snapshot, result.snapshot);
    assert.equal(calls.requests.length, 1, 'a successful first refresh needs no recovery request');
  });
}

test('first discovery does not conceal a newer revision captured by the initial refresh', async t => {
  const { service, calls, setAccount } = fixture(t, true);
  const read = service.read();
  setAccount('synthetic-account-b');
  const refresh = service.refresh();
  const [initial, current] = await Promise.all([read, refresh]);
  assert.equal(initial.snapshot, null);
  assert.equal(current.snapshot.creditBalance, '200');
  assert.ok(current.stateRevision > initial.stateRevision);
  assert.deepEqual(calls.requests, ['synthetic-account-b']);
});

test('different markers at startup reject a refresh captured before the account switch', async t => {
  const { service, calls, setAccount } = fixture(t, true);
  const refresh = service.refresh();
  setAccount('synthetic-account-b');
  const read = service.read();
  const [discarded] = await Promise.all([refresh, read]);
  assert.equal(discarded.snapshot, null);
  assert.equal(discarded.authenticated, false);
  assert.deepEqual(calls.requests, []);
  const recovered = await service.refresh();
  assert.equal(recovered.snapshot.creditBalance, '200');
  assert.deepEqual(calls.requests, ['synthetic-account-b']);
});

for (const lateFailure of [false, true]) {
  test(`known revision change still invalidates a pending ${lateFailure ? 'failure' : 'success'}`, async t => {
    const { service, setAccount } = fixture(t, true);
    await service.refresh();
    const old = deferred(), newer = deferred();
    service.fetchUsage = jwt => jwt === 'synthetic-account-a' ? old.promise : newer.promise;
    const first = service.refresh();
    await tick();
    const before = service.view();
    setAccount('synthetic-account-b');
    const reset = await service.read();
    assert.equal(reset.snapshot, null);
    assert.equal(reset.authenticated, false);
    assert.equal(reset.refreshing, false);
    assert.ok(reset.stateRevision > before.stateRevision);
    const second = service.refresh();
    await tick();
    if (lateFailure) old.reject(Object.assign(new Error('synthetic stale failure'), { code: 'NETWORK' }));
    else old.resolve({ creditBalance: '100', subscriptions: [] });
    const discarded = await first;
    assert.equal(discarded.snapshot, null);
    assert.equal(discarded.error, null);
    assert.equal(discarded.refreshing, true, 'old finally must not clear newer ownership');
    newer.resolve({ creditBalance: '200', subscriptions: [] });
    assert.equal((await second).snapshot.creditBalance, '200');
  });
}

test('actual marker changes during the vault read fail closed before any GET', async t => {
  const { service, credentials, calls, setAccount } = fixture(t, true);
  const read = credentials.read;
  credentials.read = async () => {
    const jwt = await read();
    setAccount('synthetic-account-b');
    return jwt;
  };
  const result = await service.refresh();
  assert.equal(calls.vaultReads, 1);
  assert.deepEqual(calls.requests, []);
  assert.equal(result.snapshot, null);
  assert.equal(result.authenticated, false);
});

test('actual marker changes after GET discard the old result', async t => {
  const { service, setAccount } = fixture(t, true);
  service.fetchUsage = async () => {
    setAccount('synthetic-account-b');
    return { creditBalance: '100', subscriptions: [] };
  };
  const result = await service.refresh();
  assert.equal(result.snapshot, null);
  assert.equal(result.authenticated, false);
});

test('clear and unreadable markers still reset cached data and permit recovery', async t => {
  const { service, setAccount, calls } = fixture(t, true);
  await service.refresh();
  setAccount(null);
  const cleared = await service.refresh();
  assert.equal(cleared.snapshot, null);
  assert.equal(cleared.authenticated, false);
  assert.equal(cleared.error.code, 'NO_JWT');
  setAccount('synthetic-account-b');
  assert.equal((await service.refresh()).snapshot.creditBalance, '200');
  setAccount('synthetic-account-b', 'changing');
  const [read, refresh] = await Promise.all([service.read(), service.refresh()]);
  for (const result of [read, refresh]) {
    assert.equal(result.snapshot, null);
    assert.equal(result.authenticated, false);
    assert.equal(result.error.code, 'SECRET_STORAGE');
  }
  assert.deepEqual(calls.requests, ['synthetic-account-a', 'synthetic-account-b']);
  setAccount('synthetic-account-b');
  assert.equal((await service.refresh()).snapshot.creditBalance, '200');
});

test('disposal between startup calls and revision continuations cannot resurrect state', async t => {
  const { service, calls } = fixture(t);
  const read = service.read(), refresh = service.refresh();
  service.dispose();
  for (const result of await Promise.all([read, refresh, service.refresh()])) {
    assert.equal(result.snapshot, null);
    assert.equal(result.authenticated, false);
    assert.equal(result.refreshing, false);
  }
  assert.equal(calls.vaultReads, 0);
  assert.deepEqual(calls.requests, []);
});

async function stdioFixture(t) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/startup-server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const replies = new Map();
  let buffered = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    buffered += data;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      const pending = replies.get(message.id);
      if (pending) { replies.delete(message.id); pending.resolve(message); }
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      for (const pending of replies.values()) pending.reject(new Error(`fixture exited: ${code}/${signal}: ${stderr}`));
      resolve({ code, signal });
    });
  });
  function batch(messages) {
    const responses = messages.filter(message => message.id !== undefined).map(message => {
      const pending = deferred(); replies.set(message.id, pending); return pending.promise;
    });
    // One write makes the production transport dispatch both requests in the
    // same turn, rather than awaiting the first through the client API.
    child.stdin.write(messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
    return Promise.all(responses);
  }
  const [initialized] = await batch([{ id: 0, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Synthetic startup test', version: '1' }
  } }]);
  assert.ok(initialized.result);
  await batch([{ method: 'notifications/initialized' }]);
  return { batch, async close() {
    child.stdin.end();
    assert.deepEqual(await exited, { code: 0, signal: null });
    return JSON.parse(stderr.trim());
  } };
}

for (const names of [
  ['krill.read', 'krill.usage'],
  ['krill.usage', 'krill.read'],
  ['krill.usage', 'krill.refresh'],
  ['krill.read', 'krill.usage', 'krill.refresh']
]) {
  test(`production stdio cold-start batch: ${names.join(' → ')}`, { timeout: 10_000 }, async t => {
    const transport = await stdioFixture(t);
    const responses = await transport.batch(names.map((name, index) => ({
      id: index + 1, method: 'tools/call', params: { name, arguments: {} }
    })));
    const views = responses.map(response => {
      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, undefined);
      return response.result.structuredContent.view;
    });
    const refreshed = views.filter((_, index) => names[index] !== 'krill.read');
    for (const result of refreshed) {
      assert.equal(result.snapshot?.creditBalance, '100');
      assert.equal(result.authenticated, true);
      assert.equal(result.refreshing, false);
      assert.equal(result.error, null);
      assert.equal(result.snapshotRevision, refreshed[0].snapshotRevision);
    }
    const [read] = await transport.batch([{ id: 10, method: 'tools/call', params: { name: 'krill.read', arguments: {} } }]);
    assert.equal(read.result.structuredContent.view.snapshot.creditBalance, '100');
    assert.ok(read.result.structuredContent.view.snapshotRevision > refreshed[0].snapshotRevision);
    assert.deepEqual(await transport.close(), { vaultReads: 1, requests: 1 });
  });
}
