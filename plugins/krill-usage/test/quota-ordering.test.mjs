import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageService } from '../src/service.mjs';
import { createController, DEFAULT_PREFERENCES, normalizePayload, usageModel } from '../src/view.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const snapshot = balance => ({ creditBalance: balance, subscriptions: [] });
const networkError = () => Object.assign(new Error('synthetic network failure'), { code: 'NETWORK' });
function fixture(t) {
  const account = { revision: 'fixture-account-a', jwt: 'synthetic-only' };
  const clock = { now: 1_000_000 };
  const service = new UsageService({
    credentials: { readRevision: async () => account.revision, read: async () => account.jwt },
    preferences: { read: () => ({ ...DEFAULT_PREFERENCES }) },
    fetchUsage: async () => snapshot('100'), now: () => clock.now
  });
  t.after(() => service.dispose());
  return { service, account, clock };
}
const result = (view, entry = false) => ({ content: [], structuredContent: {
  view, page: entry ? 'settings' : 'usage', preferences: { ...DEFAULT_PREFERENCES }, preferencesRevision: 0
} });

// App responses go through request(), not merely through the entry callback.
async function deliverPair(t, older, newer, newerIsEntry, newerFirst) {
  let appResponse = result({ ...older, stateRevision: 0, snapshotRevision: 0 });
  const controller = createController({ callTool: async () => appResponse });
  controller.connect();
  t.after(() => controller.dispose());
  await controller.request('krill.read');
  const responses = [{ view: older, entry: !newerIsEntry }, { view: newer, entry: newerIsEntry }];
  if (newerFirst) responses.reverse();
  for (const { view, entry } of responses) {
    const response = result(view, entry);
    if (entry) controller.receive(response, { entry: true });
    else {
      appResponse = response;
      assert.equal(await controller.request('krill.read'), true);
    }
  }
  assert.deepEqual(controller.state.payload.view, normalizePayload({ view: newer }).view);
  assert.equal(controller.state.page, 'settings', 'initial entry navigation remains independent');
  assert.equal(controller.state.pending, null);
  return controller;
}

const scenarios = [
  'success then failure',
  'refreshing then failure',
  'refreshing then success',
  'failure then success in the same millisecond',
  'success then refreshing',
  'failure then refreshing',
  'two successes in the same millisecond',
  'success after the clock moves backward'
];
for (const scenario of scenarios) {
  for (const newerIsEntry of [false, true]) {
    for (const newerFirst of [false, true]) {
      test(`${scenario}: newer ${newerIsEntry ? 'entry' : 'app'} arrives ${newerFirst ? 'first' : 'last'}`, async t => {
        const { service, clock } = fixture(t);
        let older = await service.refresh(), newer;
        const successTime = older.lastSuccessAt;
        if (scenario === 'success then failure') {
          service.fetchUsage = async () => { throw networkError(); };
          newer = await service.refresh();
        } else if (scenario.startsWith('refreshing then')) {
          const pending = deferred();
          service.fetchUsage = () => pending.promise;
          const refresh = service.refresh();
          older = await service.read();
          assert.equal(older.refreshing, true);
          if (scenario.endsWith('failure')) pending.reject(networkError());
          else pending.resolve(snapshot('200'));
          newer = await refresh;
          assert.equal(newer.refreshing, false);
        } else if (scenario.endsWith('then refreshing')) {
          if (scenario.startsWith('failure')) {
            service.fetchUsage = async () => { throw networkError(); };
            older = await service.refresh();
          }
          const pending = deferred();
          service.fetchUsage = () => pending.promise;
          const refresh = service.refresh();
          newer = await service.read();
          assert.equal(newer.refreshing, true);
          pending.resolve(snapshot('200'));
          await refresh;
        } else {
          if (scenario.startsWith('failure')) {
            service.fetchUsage = async () => { throw networkError(); };
            older = await service.refresh();
          }
          if (scenario.endsWith('backward')) clock.now -= 1000;
          service.fetchUsage = async () => snapshot('200');
          newer = await service.refresh();
        }
        assert.equal(older.stateRevision, newer.stateRevision);
        assert.ok(newer.snapshotRevision > older.snapshotRevision, 'capture order has its own revision');
        assert.equal(older.lastSuccessAt, successTime);
        assert.equal(newer.lastSuccessAt, scenario.endsWith('backward') ? clock.now : successTime,
          'success time stays factual, even when quota status changes');
        const controller = await deliverPair(t, older, newer, newerIsEntry, newerFirst);
        const model = usageModel(controller.state.payload, clock.now);
        if (scenario.endsWith('then failure')) {
          assert.equal(model.view.error.code, 'NETWORK');
          assert.equal(model.freshness.stale, true);
          assert.equal(model.freshness.label, '刷新失败 · 保留上次数据');
        }
        if (scenario.includes('then success') || scenario.startsWith('two successes') || scenario.endsWith('backward')) {
          assert.equal(model.view.error, null);
          assert.equal(model.view.snapshot.creditBalance, '200');
          assert.equal(model.freshness.label, '额度已同步');
        }
      });
    }
  }
}

test('every service view capture advances through reads, loading, failures, resets, and disposal', async t => {
  const { service, account } = fixture(t);
  const views = [service.view(), await service.read(), await service.refresh(), await service.read()];
  const pending = deferred();
  service.fetchUsage = () => pending.promise;
  const refresh = service.refresh();
  views.push(service.view(), await service.read());
  pending.reject(networkError());
  views.push(await refresh, await service.read());
  account.revision = 'fixture-account-b';
  account.jwt = null;
  views.push(await service.read(), await service.refresh());
  service.dispose();
  views.push(service.view(), await service.read(), await service.refresh());
  for (let i = 0; i < views.length; i++) {
    assert.ok(Number.isSafeInteger(views[i].snapshotRevision));
    assert.ok(views[i].snapshotRevision > (views[i - 1]?.snapshotRevision ?? 0));
  }
  assert.equal(views[4].refreshing, true);
  assert.equal(views[6].error.code, 'NETWORK');
  assert.equal(views[8].snapshot, null);
  assert.ok(views[8].stateRevision > views[7].stateRevision);
  assert.equal(views[9].error.code, 'NO_JWT');
});

test('coalesced refresh replies reuse one captured revision; later reads issue a new one', async t => {
  const { service } = fixture(t);
  const pending = deferred();
  service.fetchUsage = () => pending.promise;
  const first = service.refresh(), second = service.refresh();
  assert.equal(first, second);
  pending.resolve(snapshot('100'));
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  assert.equal(one.snapshotRevision, two.snapshotRevision);
  const next = await service.read();
  assert.ok(next.snapshotRevision > one.snapshotRevision);
});

for (const entry of [false, true]) {
  test(`missing snapshot revision cannot use timestamps to replace versioned ${entry ? 'entry' : 'app'} state`, async t => {
    const { service } = fixture(t);
    const current = await service.refresh();
    const unversioned = structuredClone(current);
    delete unversioned.snapshotRevision;
    unversioned.snapshot.creditBalance = '999';
    unversioned.lastSuccessAt += 10000;
    await deliverPair(t, unversioned, current, entry, true);
  });

  test(`equal snapshot replay is idempotent through ${entry ? 'entry' : 'app'} delivery`, async t => {
    const { service } = fixture(t);
    const current = await service.refresh();
    let response = result(current);
    const controller = createController({ callTool: async () => response });
    controller.connect();
    t.after(() => controller.dispose());
    await controller.request('krill.read');
    const accepted = controller.state.payload.view;
    // A replay cannot replace quota data (or a local transport-error overlay),
    // even if it claims a later wall-clock success time or newer preferences.
    accepted.error = { code: 'TRANSPORT_ERROR', message: '连接中断' };
    const replay = structuredClone(response);
    replay.structuredContent.view.snapshot.creditBalance = '999';
    replay.structuredContent.view.lastSuccessAt += 10000;
    replay.structuredContent.preferences.showBalance = false;
    replay.structuredContent.preferencesRevision = 1;
    response = replay;
    if (entry) controller.receive(replay, { entry: true });
    else assert.equal(await controller.request('krill.read'), true);
    assert.equal(controller.state.payload.view, accepted);
    assert.equal(accepted.snapshot.creditBalance, '100');
    assert.equal(accepted.error.code, 'TRANSPORT_ERROR');
    assert.equal(controller.state.payload.preferences.showBalance, false);
    assert.equal(controller.state.payload.preferencesRevision, 1);
  });
}

for (const resetFirst of [false, true]) {
  test(`account reset outranks an older account's higher snapshot revision: reset ${resetFirst ? 'first' : 'last'}`, async t => {
    const { service, account } = fixture(t);
    const cached = await service.refresh();
    account.revision = 'fixture-account-b';
    const reset = await service.read();
    // Explicitly prove account precedence rather than relying on both counters
    // increasing together in this service instance.
    cached.snapshotRevision = reset.snapshotRevision + 100;
    await deliverPair(t, cached, reset, resetFirst, resetFirst);
  });
}
