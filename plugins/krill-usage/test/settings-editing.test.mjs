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

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

async function fixture(t, initial = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'krill-settings-editing-'));
  const preferences = createPreferences(dir);
  if (Object.keys(initial).length) preferences.update(initial);
  let now = Date.UTC(2026, 9, 8, 16), fetches = 0;
  t.mock.method(Date, 'now', () => now);
  const service = new UsageService({ preferences, now: () => now,
    credentials: { readRevision: async () => 'synthetic-revision', read: async () => 'synthetic-only' },
    fetchUsage: async () => { fetches++; return { creditBalance: '23', subscriptions: [] }; }
  });
  const server = createServer({ service, preferences, html: '<!doctype html>' });
  const client = new Client({ name: 'Settings editing fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const panels = [], gates = [];
  t.after(async () => {
    gates.forEach(gate => gate.resolve());
    panels.forEach(panel => { panel.mounted.dispose(); panel.dom.window.close(); });
    service.dispose();
    await flush();
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await server.connect(b);
  await client.connect(a);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const opening = await call('krill.usage');
  async function panel() {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document, calls = [], timers = new Map();
    let timerId = 0, nextHold = null, failNext = false;
    dom.window.setTimeout = (callback, ms) => {
      const id = ++timerId;
      timers.set(id, { callback, due: now + ms });
      return id;
    };
    dom.window.clearTimeout = id => timers.delete(id);
    const app = { connect: async () => {}, getHostContext: () => ({ theme: 'light' }),
      callServerTool: async (params, options) => {
        calls.push(params);
        if (failNext) { failNext = false; throw new Error('Synthetic transport failure'); }
        const held = nextHold;
        nextHold = null;
        const result = await client.callTool(params, undefined, options);
        if (held) { held.captured.resolve(result); await held.release.promise; }
        return result;
      }
    };
    const mounted = mountKrillApp({ app, root: doc.getElementById('app'), doc, win: dom.window });
    const input = key => doc.getElementById(key);
    async function idle() {
      await flush();
      for (let i = 0; mounted.controller.state.pending && i < 100; i++) await flush();
      await flush();
      assert.equal(mounted.controller.state.pending, null, 'panel request settled');
    }
    const p = { dom, doc, app, calls, mounted, idle, input,
      status: () => doc.querySelector('.form-status').textContent,
      edit(patch) {
        for (const [key, value] of Object.entries(patch)) {
          const control = input(key);
          if (control.type === 'checkbox') control.checked = value;
          else control.value = String(value);
          control.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        }
      },
      submit: () => doc.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
      reload: () => doc.querySelector('.quiet-button').click(),
      save: async patch => { p.edit(patch); p.submit(); await idle(); assert.equal(p.status(), '设置已保存'); },
      patch: () => calls.filter(call => call.name === 'krill.updateSettings').at(-1)?.arguments.set,
      form: () => Object.fromEntries(Object.keys(defaults).map(key => [key, input(key).type === 'checkbox' ? input(key).checked : Number(input(key).value)])),
      hold() {
        const captured = deferred(), release = deferred();
        gates.push(release);
        nextHold = { captured, release };
        return { captured: captured.promise, release: release.resolve };
      },
      fail: () => { failNext = true; },
      visibility: state => {
        Object.defineProperty(doc, 'visibilityState', { value: state, configurable: true });
        doc.dispatchEvent(new dom.window.Event('visibilitychange'));
      },
      deadline: () => { assert.equal(timers.size, 2); return [...timers.values()].at(-1).due; }
    };
    panels.push(p);
    await mounted.connected;
    app.ontoolresult(opening);
    return p;
  }
  return { preferences, call, panel, opening, advance: ms => { now += ms; }, fetches: () => fetches,
    disk: () => readFileSync(path.join(dir, 'preferences.json'), 'utf8') };
}

for (const source of ['native settings', 'second panel']) {
  test(`unseen ${source} update survives a stale single-field save`, async t => {
    const f = await fixture(t), stale = await f.panel();
    if (source === 'native settings') await f.call('settings.update', { set: { refreshIntervalMinutes: 7 } });
    else await (await f.panel()).save({ refreshIntervalMinutes: 7 });
    assert.equal(stale.input('refreshIntervalMinutes').value, '3', 'no invented external notification');
    const priorRevision = f.preferences.readSnapshot().revision;
    f.advance(60_000);
    await stale.save({ showBalance: false });
    assert.deepEqual(f.preferences.readSnapshot(), { revision: priorRevision + 1, values: { ...defaults, refreshIntervalMinutes: 7, showBalance: false } }, 'stale save preserves the unseen persisted interval');
    assert.deepEqual(stale.patch(), { showBalance: false }, 'only the edited field travels');
    assert.deepEqual(stale.form(), f.preferences.read());
    assert.equal(stale.deadline() - Date.now(), 360_000, 'accepted cadence keeps the original quota clock');
    assert.equal(f.fetches(), 1, 'partial saves never query quota');
  });
}

for (const { label, initial, external, patch } of [
  { label: 'critical above stale warning', initial: {}, external: { lowQuotaWarningPercent: 30 }, patch: { lowQuotaCriticalPercent: 20 } },
  { label: 'warning below stale critical', initial: { lowQuotaWarningPercent: 50, lowQuotaCriticalPercent: 40 }, external: { lowQuotaCriticalPercent: 10 }, patch: { lowQuotaWarningPercent: 20 } }
]) {
  test(`partial threshold validation uses the latest disk counterpart: ${label}`, async t => {
    const f = await fixture(t, initial), p = await f.panel();
    await f.call('settings.update', { set: external });
    const before = f.preferences.readSnapshot();
    await p.save(patch);
    assert.deepEqual(p.patch(), patch);
    assert.deepEqual(f.preferences.readSnapshot(), { revision: before.revision + 1, values: { ...before.values, ...patch } });
    assert.deepEqual(p.form(), f.preferences.read());
  });
}

test('invalid merged threshold patch fails without changing disk or clearing edits', async t => {
  const f = await fixture(t), p = await f.panel();
  await f.call('settings.update', { set: { lowQuotaWarningPercent: 10 } });
  const disk = f.disk();
  p.edit({ lowQuotaCriticalPercent: 12 });
  p.submit();
  await p.idle();
  assert.deepEqual(p.patch(), { lowQuotaCriticalPercent: 12 });
  assert.equal(f.disk(), disk, 'rejected merged pair does not write or increment revision');
  assert.match(p.status(), /未保存/);
  assert.equal(p.input('lowQuotaCriticalPercent').value, '12');
  assert.equal(p.doc.querySelector('.primary-button').disabled, false);
  await f.call('settings.update', { set: { lowQuotaWarningPercent: 20 } });
  p.submit();
  await p.idle();
  assert.equal(p.status(), '设置已保存');
  assert.deepEqual(p.patch(), { lowQuotaCriticalPercent: 12 }, 'failed patch remains dirty for retry');
});

test('new preferences update clean controls while dirty raw input and ordering remain intact', async t => {
  const f = await fixture(t), p = await f.panel();
  p.edit({ lowQuotaWarningPercent: '' });
  await f.call('settings.update', { set: { refreshIntervalMinutes: 7, showBalance: false } });
  const newer = await f.call('krill.read');
  p.app.ontoolresult(newer);
  p.app.ontoolresult(f.opening);
  assert.equal(p.input('lowQuotaWarningPercent').value, '', 'render does not normalize an unfinished input');
  assert.equal(p.input('refreshIntervalMinutes').value, '7');
  assert.equal(p.input('showBalance').checked, false);
  assert.equal(p.mounted.controller.state.payload.preferencesRevision, newer.structuredContent.preferencesRevision);
  const count = p.calls.length, disk = f.disk();
  p.submit();
  await p.idle();
  assert.equal(p.calls.length, count, 'only dirty invalid input blocks locally');
  assert.equal(f.disk(), disk);
  await p.save({ lowQuotaWarningPercent: 20 });
  assert.deepEqual(p.patch(), { lowQuotaWarningPercent: 20 });
  assert.deepEqual(p.form(), { ...defaults, refreshIntervalMinutes: 7, showBalance: false, lowQuotaWarningPercent: 20 });
});

test('pending save clears only unchanged submitted edits and keeps newer accepted preferences', async t => {
  const f = await fixture(t), p = await f.panel(), held = p.hold();
  p.edit({ refreshIntervalMinutes: 4, lowQuotaWarningPercent: 20 });
  p.submit();
  const delayedSave = await held.captured;
  assert.deepEqual(p.patch(), { refreshIntervalMinutes: 4, lowQuotaWarningPercent: 20 });
  p.edit({ refreshIntervalMinutes: 5, lowQuotaCriticalPercent: 6 });
  await f.call('settings.update', { set: { lowQuotaWarningPercent: 25, showBalance: false } });
  const newer = await f.call('krill.read');
  p.app.ontoolresult(newer);
  assert.equal(p.input('showBalance').checked, false, 'clean field updates even while saving');
  assert.equal(p.input('lowQuotaWarningPercent').value, '20', 'submitted dirty field waits for save acknowledgement');
  held.release();
  await p.idle();
  assert.match(p.status(), /还有新的修改/);
  assert.deepEqual(p.form(), { ...defaults, refreshIntervalMinutes: 5, lowQuotaWarningPercent: 25, lowQuotaCriticalPercent: 6, showBalance: false });
  assert.equal(p.mounted.controller.state.payload.preferencesRevision, newer.structuredContent.preferencesRevision);
  p.submit();
  await p.idle();
  assert.deepEqual(p.patch(), { refreshIntervalMinutes: 5, lowQuotaCriticalPercent: 6 }, 'acknowledged fields cannot leak into the next patch');
  assert.equal(f.preferences.readSnapshot().revision, 3);
  assert.deepEqual(p.form(), f.preferences.read());
  p.app.ontoolresult(delayedSave);
  assert.deepEqual(p.form(), f.preferences.read(), 'delayed old save cannot replace later saved preferences');
});

test('pending reload discards only prior edits and preserves same-field and new-field input', async t => {
  const f = await fixture(t), p = await f.panel();
  p.edit({ refreshIntervalMinutes: 8, lowQuotaWarningPercent: 30 });
  const held = p.hold();
  p.reload();
  await held.captured;
  p.edit({ refreshIntervalMinutes: 9, showBalance: false });
  held.release();
  await p.idle();
  assert.match(p.status(), /保留/);
  assert.deepEqual(p.form(), { ...defaults, refreshIntervalMinutes: 9, showBalance: false });
  p.submit();
  await p.idle();
  assert.deepEqual(p.patch(), { refreshIntervalMinutes: 9, showBalance: false });
  assert.deepEqual(p.form(), f.preferences.read());
});

for (const action of ['save', 'reload']) {
  for (const outcome of ['failure', 'abort']) {
    test(`${action} ${outcome} retains edits for the next partial save`, async t => {
      const f = await fixture(t), p = await f.panel();
      p.edit({ showBalance: false });
      const held = outcome === 'abort' ? p.hold() : null;
      if (outcome === 'failure') p.fail();
      if (action === 'save') p.submit();
      else p.reload();
      if (held) {
        await held.captured;
        p.edit({ lowQuotaWarningPercent: 25 });
        p.visibility('hidden');
        held.release();
      }
      await p.idle();
      if (held) { p.visibility('visible'); await p.idle(); }
      assert.equal(p.input('showBalance').checked, false);
      assert.equal(p.doc.querySelector('.primary-button').disabled, false);
      p.submit();
      await p.idle();
      assert.deepEqual(p.patch(), held ? { showBalance: false, lowQuotaWarningPercent: 25 } : { showBalance: false });
      assert.equal(p.status(), '设置已保存');
      assert.deepEqual(p.form(), f.preferences.read());
    });
  }
}

test('empty form submissions cannot increment disk revision or call settings', async t => {
  const f = await fixture(t), p = await f.panel();
  await f.call('settings.update', { set: { refreshIntervalMinutes: 7 } });
  const disk = f.disk(), count = p.calls.length;
  p.submit();
  await p.idle();
  assert.equal(p.calls.length, count);
  assert.equal(f.disk(), disk);
  assert.equal(p.doc.querySelector('.primary-button').disabled, true);
});

for (const nextAction of ['save', 'reload']) {
  test(`an aborted old save cannot overwrite a newer ${nextAction} or edits`, async t => {
    const f = await fixture(t), p = await f.panel(), held = p.hold();
    p.edit({ showBalance: false });
    p.submit();
    const oldResult = await held.captured;
    p.visibility('hidden');
    p.visibility('visible');
    await p.idle();
    p.edit({ showBalance: true });
    if (nextAction === 'save') p.submit();
    else p.reload();
    await p.idle();
    assert.equal(p.status(), nextAction === 'save' ? '设置已保存' : '已重新加载本机设置');
    p.edit({ lowQuotaWarningPercent: 25 });
    const disk = f.disk();
    held.release();
    await p.idle();
    assert.equal(p.status(), '尚未保存', 'old continuation cannot replace the current edit status');
    assert.equal(p.input('lowQuotaWarningPercent').value, '25');
    assert.equal(f.disk(), disk);
    p.submit();
    await p.idle();
    assert.deepEqual(p.patch(), { lowQuotaWarningPercent: 25 }, 'only the remaining edit is submitted');
    p.app.ontoolresult(oldResult);
    assert.deepEqual(p.form(), f.preferences.read());
    assert.equal(p.input('showBalance').checked, nextAction === 'save');
  });
}
