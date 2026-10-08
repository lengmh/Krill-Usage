import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JSDOM } from 'jsdom';
import { createPreferences, defaults } from '../src/preferences.mjs';
import { UsageService } from '../src/service.mjs';
import { createServer } from '../src/register.mjs';
import { mountKrillApp } from '../src/app.mjs';
import { usageModel } from '../src/view.mjs';

const changed = { refreshIntervalMinutes: 7, showBalance: false, lowQuotaWarningPercent: 35, lowQuotaCriticalPercent: 20 };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

async function fixture(t, initial = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'krill-preference-ordering-'));
  const preferences = createPreferences(dir);
  if (Object.keys(initial).length) preferences.update(initial);
  let now = Date.UTC(2026, 9, 8, 13), fetches = 0, fetchError = null;
  t.mock.method(Date, 'now', () => now);
  const account = { revision: 'fixture-account-a', credential: 'synthetic-only' };
  const service = new UsageService({ preferences, now: () => now,
    credentials: { readRevision: async () => account.revision, read: async () => account.credential },
    fetchUsage: async () => {
      fetches++;
      if (fetchError) throw fetchError;
      return { creditBalance: String(23 + fetches), subscriptions: [
        { id: 'fixture-plan', name: 'Fixture plan', status: 'active', type: 'monthly', remaining: 13 - fetches, limit: 100 }
      ] };
    }
  });
  const server = createServer({ service, preferences, html: '<!doctype html><html></html>' });
  const client = new Client({ name: 'Preference ordering fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let mounted, dom;
  const heldReads = [];
  t.after(async () => {
    for (const held of heldReads) held.release();
    await Promise.allSettled(heldReads.map(held => held.response));
    mounted?.dispose();
    dom?.window.close();
    service.dispose();
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await server.connect(b);
  await client.connect(a);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  // The host has completed its entry request but has not yet delivered it.
  const opening = await call('krill.usage');
  dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
  const timers = new Map();
  let timerId = 0;
  dom.window.setTimeout = (callback, ms) => {
    const id = ++timerId;
    timers.set(id, { callback, ms });
    return id;
  };
  dom.window.clearTimeout = id => timers.delete(id);
  const appCalls = [];
  const app = { connect: async () => {}, getHostContext: () => ({ theme: 'light' }),
    callServerTool: (params, options) => {
      appCalls.push(params);
      return client.callTool(params, undefined, options);
    }
  };
  const doc = dom.window.document;
  mounted = mountKrillApp({ app, root: doc.getElementById('app'), doc, win: dom.window });
  await mounted.connected;
  const form = () => Object.fromEntries(Object.keys(defaults).map(key => {
    const input = doc.getElementById(key);
    return [key, input.type === 'checkbox' ? input.checked : Number(input.value)];
  }));
  async function idle() {
    await flush();
    for (let i = 0; mounted.controller.state.pending && i < 100; i++) await flush();
    await flush();
    assert.equal(mounted.controller.state.pending, null, 'app request settled');
  }
  async function save(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const input = doc.getElementById(key);
      if (input.type === 'checkbox') input.checked = value;
      else input.value = String(value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    doc.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await idle();
    assert.equal(doc.querySelector('.form-status').textContent, '设置已保存');
  }
  function refreshTimer() {
    // The production scheduler installs the minute display tick, then refresh.
    assert.equal(timers.size, 2, 'one display tick and one automatic refresh');
    const [id, timer] = [...timers.entries()].at(-1);
    return { id, ...timer };
  }
  async function fireRefresh() {
    const timer = refreshTimer();
    timers.delete(timer.id);
    now += timer.ms;
    const callsBefore = appCalls.length;
    timer.callback();
    await idle();
    assert.equal(appCalls.length, callsBefore + 1);
    assert.equal(appCalls.at(-1).name, 'krill.refresh', 'actual scheduled callback queried quota');
  }
  async function holdRead() {
    // Pause only scheduling: the production service captures a real view, then
    // register.mjs attaches current disk preferences after the pause is released.
    const captured = deferred(), release = deferred();
    const read = service.read.bind(service);
    service.read = async () => {
      service.read = read;
      const view = await read();
      captured.resolve(view);
      await release.promise;
      return view;
    };
    const response = call('krill.read');
    heldReads.push({ response, release: release.resolve });
    const view = await captured.promise;
    return { view, finish: async () => { release.resolve(); return response; } };
  }
  return { preferences, account, opening, app, doc, mounted, appCalls, timers, call, form, save, idle,
    refreshTimer, fireRefresh, holdRead, advance: ms => { now += ms; }, now: () => now, fetches: () => fetches,
    failFetch: () => { fetchError = Object.assign(new Error('synthetic network failure'), { code: 'NETWORK' }); },
    disk: () => readFileSync(path.join(dir, 'preferences.json'), 'utf8') };
}

function assertPreferences(f, expected, delayMs = expected.refreshIntervalMinutes * 60_000) {
  const payload = f.mounted.controller.state.payload;
  assert.deepEqual(payload.preferences, expected);
  assert.deepEqual(f.form(), expected, 'form shows accepted preferences');
  assert.equal(f.doc.querySelector('.balance-aside').hidden, !expected.showBalance);
  assert.equal(f.doc.querySelector('.hero-card').dataset.tone, 'critical');
  assert.equal(f.doc.querySelector('.plan-card').dataset.tone, 'critical');
  assert.match(f.doc.querySelector('.app-footer').textContent, new RegExp(`每 ${expected.refreshIntervalMinutes} 分钟刷新`));
  assert.equal(f.refreshTimer().ms, delayMs, 'actual timer uses accepted cadence');
}

for (const mode of ['app save', 'native settings.update then krill.read']) {
  test(`delayed initial result cannot undo ${mode} or poison a later partial edit`, async t => {
    const f = await fixture(t, mode === 'app save' ? { refreshIntervalMinutes: 60 } : {});
    const saved = { ...changed, refreshIntervalMinutes: mode === 'app save' ? 1 : 7 };
    if (mode === 'app save') await f.save(saved);
    else {
      const native = await f.call('settings.update', { set: saved });
      assert.deepEqual(native.structuredContent.values, saved, 'native settings expose only four public values');
      assert.equal(f.mounted.controller.receive(native), false, 'native settings results are not app payloads');
      const before = f.fetches();
      assert.equal(await f.mounted.controller.request('krill.read'), true);
      assert.equal(f.fetches(), before, 'reading native settings needs no quota GET');
    }
    const current = f.mounted.controller.state.payload;
    assert.equal(current.view.stateRevision, f.opening.structuredContent.view.stateRevision);
    assert.equal(current.view.lastSuccessAt, f.opening.structuredContent.view.lastSuccessAt);
    assert.ok(current.preferencesRevision > f.opening.structuredContent.preferencesRevision);
    const revision = current.preferencesRevision, disk = f.disk();
    assertPreferences(f, saved);
    f.app.ontoolresult(f.opening);
    assertPreferences(f, saved);
    assert.equal(f.mounted.controller.state.payload.preferencesRevision, revision);
    assert.equal(f.disk(), disk, 'delivery does not write preferences');
    assert.deepEqual(f.preferences.read(), saved);
    await f.save({ lowQuotaWarningPercent: 25 });
    const edited = { ...saved, lowQuotaWarningPercent: 25 };
    assert.deepEqual(f.appCalls.at(-1).arguments.set, edited, 'unchanged form fields retain saved values');
    assert.deepEqual(f.preferences.read(), edited, 'later deliberate save cannot restore obsolete values');
    f.app.ontoolresult(f.opening);
    assertPreferences(f, edited);
  });
}

for (const trigger of ['manual', 'scheduled']) {
  test(`${trigger} quota refresh observes a native settings update`, async t => {
    const f = await fixture(t);
    f.app.ontoolresult(f.opening);
    await f.call('settings.update', { set: changed });
    assert.deepEqual(f.form(), defaults, 'no invented push notification from native settings');
    const before = f.fetches();
    if (trigger === 'manual') {
      f.advance(1);
      f.doc.querySelector('.refresh-button').click();
      await f.idle();
    } else await f.fireRefresh();
    assert.equal(f.fetches(), before + 1);
    assertPreferences(f, changed);
    f.app.ontoolresult(f.opening);
    assertPreferences(f, changed);
  });
}

for (const delivery of ['quota first', 'preferences first']) {
  test(`newer same-account quota and newer preferences merge independently: ${delivery}`, async t => {
    const f = await fixture(t);
    const delayed = await f.holdRead();
    f.advance(1000);
    const quota = await f.call('krill.refresh');
    await f.call('settings.update', { set: changed });
    const prefs = await delayed.finish();
    assert.equal(quota.structuredContent.view.stateRevision, prefs.structuredContent.view.stateRevision);
    assert.ok(quota.structuredContent.view.lastSuccessAt > prefs.structuredContent.view.lastSuccessAt);
    assert.ok(quota.structuredContent.preferencesRevision < prefs.structuredContent.preferencesRevision);
    for (const response of delivery === 'quota first' ? [quota, prefs] : [prefs, quota]) f.app.ontoolresult(response);
    assert.deepEqual(f.mounted.controller.state.payload.view, quota.structuredContent.view,
      'a newer preference snapshot cannot replace newer successful quota');
    assert.equal(f.mounted.controller.state.payload.preferencesRevision, prefs.structuredContent.preferencesRevision);
    assertPreferences(f, changed, changed.refreshIntervalMinutes * 60_000 - 1000);
    assert.equal(f.doc.querySelector('.hero-amount').textContent, '$11.00');
  });

  test(`account reset survives an old-account result carrying newer preferences: ${delivery}`, async t => {
    const f = await fixture(t);
    const delayed = await f.holdRead();
    f.account.revision = 'fixture-account-b';
    f.account.credential = null;
    const reset = await f.call('krill.read');
    await f.call('settings.update', { set: changed });
    const oldAccount = await delayed.finish();
    assert.ok(reset.structuredContent.view.stateRevision > oldAccount.structuredContent.view.stateRevision);
    assert.ok(reset.structuredContent.preferencesRevision < oldAccount.structuredContent.preferencesRevision);
    for (const response of delivery === 'quota first' ? [reset, oldAccount] : [oldAccount, reset]) f.app.ontoolresult(response);
    const payload = f.mounted.controller.state.payload;
    assert.deepEqual(payload.view, reset.structuredContent.view);
    assert.equal(payload.view.snapshot, null);
    assert.equal(payload.view.authenticated, false);
    assert.equal(payload.view.lastSuccessAt, 0);
    assert.deepEqual(payload.preferences, changed, 'settings remain global across account resets');
    assert.equal(payload.preferencesRevision, oldAccount.structuredContent.preferencesRevision);
    assert.deepEqual(f.form(), changed);
    assert.equal(f.doc.querySelector('.hero-card').hidden, true, 'old account data never reappears');
    assert.equal(f.doc.querySelectorAll('.plan-card').length, 0);
    assert.equal(f.timers.size, 1, 'unauthenticated panel has no quota refresh timer');
  });
}

test('freshness and actual scheduled callback use accepted cadence despite a stale server flag', async t => {
  const f = await fixture(t, { refreshIntervalMinutes: 1 });
  f.advance(120_000);
  const shortCadence = await f.holdRead();
  assert.equal(shortCadence.view.stale, true);
  await f.call('settings.update', { set: { refreshIntervalMinutes: 10 } });
  const lengthened = await shortCadence.finish();
  assert.equal(lengthened.structuredContent.view.stale, true, 'view was captured using previous cadence');
  f.app.ontoolresult(lengthened);
  assert.equal(f.form().refreshIntervalMinutes, 10);
  assert.equal(usageModel(f.mounted.controller.state.payload).freshness.stale, false);
  assert.equal(f.doc.querySelector('.sync-label').textContent, '额度已同步');
  assert.equal(f.refreshTimer().ms, 480_000);
  const longCadence = await f.holdRead();
  assert.equal(longCadence.view.stale, false);
  await f.call('settings.update', { set: { refreshIntervalMinutes: 1 } });
  const shortened = await longCadence.finish();
  assert.equal(shortened.structuredContent.view.stale, false);
  f.app.ontoolresult(shortened);
  f.app.ontoolresult(lengthened);
  assert.equal(f.form().refreshIntervalMinutes, 1);
  assert.equal(usageModel(f.mounted.controller.state.payload).freshness.stale, true);
  assert.equal(f.doc.querySelector('.sync-label').textContent, '数据已过时 · 请刷新');
  assert.equal(f.refreshTimer().ms, 1000, 'shortened overdue cadence schedules the callback promptly');
  const before = f.fetches();
  await f.fireRefresh();
  assert.equal(f.fetches(), before + 1);
  assert.equal(f.mounted.controller.state.payload.view.lastSuccessAt, f.now());
  assert.equal(f.doc.querySelector('.sync-label').textContent, '额度已同步');
  assert.equal(f.refreshTimer().ms, 60_000);
  f.app.ontoolresult(f.opening);
  assert.equal(f.form().refreshIntervalMinutes, 1);
  assert.equal(f.refreshTimer().ms, 60_000);
});

test('lengthening cadence never hides a failed quota refresh', async t => {
  const f = await fixture(t, { refreshIntervalMinutes: 1 });
  f.failFetch();
  f.doc.querySelector('.refresh-button').click();
  await f.idle();
  await f.call('settings.update', { set: { refreshIntervalMinutes: 60 } });
  assert.equal(await f.mounted.controller.request('krill.read'), true);
  const payload = f.mounted.controller.state.payload;
  assert.equal(payload.preferences.refreshIntervalMinutes, 60);
  assert.equal(payload.view.error.code, 'NETWORK');
  assert.deepEqual(payload.view.snapshot, f.opening.structuredContent.view.snapshot);
  assert.equal(usageModel(payload).freshness.stale, true);
  assert.equal(f.doc.querySelector('.sync-label').textContent, '刷新失败 · 保留上次数据');
  assert.equal(f.refreshTimer().ms, 3_600_000);
});
