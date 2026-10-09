import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JSDOM } from 'jsdom';
import { createPreferences } from '../src/preferences.mjs';
import { UsageService } from '../src/service.mjs';
import { createServer } from '../src/register.mjs';
import { mountKrillApp } from '../src/app.mjs';

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

async function fixture(t, interval = 1) {
  const dir = mkdtempSync(path.join(tmpdir(), 'krill-refresh-scheduling-'));
  const preferences = createPreferences(dir);
  preferences.update({ refreshIntervalMinutes: interval });
  const baseline = Date.UTC(2026, 9, 8, 13);
  let now = baseline, timerId = 0, fetchGate = null, fetchFailure = false;
  t.mock.method(Date, 'now', () => now);
  const timers = new Map(), panels = [], gates = [], fetches = [];
  const account = { revision: 'synthetic-account', credential: 'synthetic-only' };
  const service = new UsageService({ preferences, now: () => now,
    credentials: { readRevision: async () => account.revision, read: async () => account.credential },
    fetchUsage: async () => {
      fetches.push(now - baseline);
      if (fetchGate) await fetchGate.promise;
      if (fetchFailure) throw Object.assign(new Error('Synthetic network failure'), { code: 'NETWORK' });
      return { creditBalance: String(fetches.length * 10), subscriptions: [] };
    }
  });
  const server = createServer({ service, preferences, html: '<!doctype html>' });
  const client = new Client({ name: 'Refresh scheduling fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    panels.forEach(panel => { panel.mounted.dispose(); panel.dom.window.close(); });
    gates.forEach(gate => gate.resolve());
    service.dispose();
    await flush();
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await server.connect(b);
  await client.connect(a);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const gate = () => { const value = deferred(); gates.push(value); return value; };
  // Run every due callback in chronological order, including display ticks. Do
  // not advance by an implementation-selected refresh delay or skip rival timers.
  async function advance(ms) {
    const target = now + ms;
    for (let count = 0; ; count++) {
      const next = [...timers.values()].filter(timer => timer.due <= target)
        .sort((one, two) => one.due - two.due || one.id - two.id)[0];
      if (!next) break;
      assert.ok(count < 10000, 'no unbounded timer loop');
      now = next.due;
      timers.delete(next.id);
      next.callback();
      await flush();
    }
    now = target;
    await flush();
  }
  async function panel(entry) {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document, calls = [];
    let transportFailure = null;
    dom.window.setTimeout = (callback, ms) => {
      const id = ++timerId;
      timers.set(id, { id, callback, due: now + ms, doc });
      return id;
    };
    dom.window.clearTimeout = id => timers.delete(id);
    const app = { connect: async () => {}, getHostContext: () => ({ theme: 'light' }),
      callServerTool: (params, options) => {
        calls.push({ name: params.name, at: now - baseline, signal: options.signal });
        if (params.name === 'krill.refresh' && transportFailure) {
          const error = new Error('Synthetic transport failure');
          if (transportFailure === 'sync') throw error;
          return Promise.reject(error);
        }
        return client.callTool(params, undefined, options);
      }
    };
    const mounted = mountKrillApp({ app, root: doc.getElementById('app'), doc, win: dom.window });
    async function idle() {
      await flush();
      for (let i = 0; mounted.controller.state.pending && i < 100; i++) await flush();
      assert.equal(mounted.controller.state.pending, null, 'panel request settled');
    }
    const value = { dom, doc, app, mounted, calls, idle,
      refresh: () => doc.querySelector('.refresh-button').click(),
      reload: () => doc.querySelector('.quiet-button').click(),
      navigate: () => doc.querySelectorAll('.nav-button')[1].click(),
      refreshes: () => calls.filter(call => call.name === 'krill.refresh').map(call => call.at),
      timerCount: () => [...timers.values()].filter(timer => timer.doc === doc).length,
      transportFailure: mode => { transportFailure = mode; },
      visibility: state => {
        Object.defineProperty(doc, 'visibilityState', { value: state, configurable: true });
        doc.dispatchEvent(new dom.window.Event('visibilitychange'));
      },
      page: (name, persisted) => dom.window.dispatchEvent(new dom.window.PageTransitionEvent(name, { persisted })),
      save: async patch => {
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
    };
    panels.push(value);
    await mounted.connected;
    if (entry) app.ontoolresult(entry);
    await idle();
    return value;
  }
  return { call, panel, advance, fetches, account, service,
    failFetch: () => { fetchFailure = true; },
    holdFetch: () => { fetchGate = gate(); return () => { fetchGate.resolve(); fetchGate = null; }; },
    holdRead: () => {
      const held = gate(), captured = deferred(), read = service.read.bind(service);
      service.read = async () => {
        service.read = read;
        const view = await read();
        captured.resolve();
        await held.promise;
        return view;
      };
      return { captured: captured.promise, release: held.resolve };
    }
  };
}

test('elapsed reads and saves cannot postpone quota; equal-deadline display ticks run too', async t => {
  const f = await fixture(t, 3), p = await f.panel(await f.call('krill.usage'));
  for (let cycle = 0; cycle < 2; cycle++) {
    await f.advance(60_000);
    p.reload();
    await p.idle();
    await f.advance(60_000);
    await p.save({ showBalance: cycle === 1 });
    await f.advance(59_999);
    assert.equal(f.fetches.length, cycle + 1);
    await f.advance(1);
    assert.equal(f.fetches.length, cycle + 2, 'quota dispatches at its deadline despite the minute tick');
  }
  assert.deepEqual(f.fetches, [0, 180_000, 360_000]);
  assert.deepEqual(p.refreshes(), [180_000, 360_000]);
});

test('accepted interval changes use the quota anchor and overdue renders preserve the armed deadline', async t => {
  const f = await fixture(t, 3), p = await f.panel(await f.call('krill.usage'));
  await f.advance(120_000);
  await p.save({ refreshIntervalMinutes: 5 });
  await f.advance(179_999);
  assert.deepEqual(f.fetches, [0]);
  await f.advance(1);
  assert.deepEqual(f.fetches, [0, 300_000], 'lengthening keeps the original anchor');
  await f.advance(120_000);
  await p.save({ refreshIntervalMinutes: 1 });
  for (let i = 0; i < 3; i++) {
    await f.advance(250);
    p.navigate();
  }
  assert.deepEqual(f.fetches, [0, 300_000]);
  await f.advance(250);
  assert.deepEqual(f.fetches, [0, 300_000, 421_000], 'shortened overdue interval gets one bounded catch-up');
  await f.advance(60_000);
  assert.deepEqual(p.refreshes(), [300_000, 421_000, 481_000]);
});

test('overdue visibility and BFCache restores read state then promptly resume quota', async t => {
  const f = await fixture(t), p = await f.panel(await f.call('krill.usage'));
  await f.advance(59_000);
  p.visibility('hidden');
  assert.equal(p.timerCount(), 0);
  await f.advance(120_000);
  p.visibility('visible');
  await p.idle();
  assert.equal(p.calls.at(-1).name, 'krill.read');
  await f.advance(500);
  p.navigate();
  await f.advance(500);
  assert.deepEqual(f.fetches, [0, 180_000]);
  await f.advance(59_000);
  p.page('pagehide', true);
  assert.equal(p.timerCount(), 0);
  await f.advance(120_000);
  p.page('pageshow', true);
  await p.idle();
  assert.equal(p.calls.at(-1).name, 'krill.read');
  await f.advance(999);
  assert.deepEqual(f.fetches, [0, 180_000]);
  await f.advance(1);
  assert.deepEqual(f.fetches, [0, 180_000, 360_000]);
  assert.equal(p.mounted.controller.state.disposed, false);
});

test('a slow read crossing the quota deadline pauses one request without renewing the interval', async t => {
  const f = await fixture(t), p = await f.panel(await f.call('krill.usage'));
  await f.advance(59_000);
  const read = f.holdRead();
  p.reload();
  await read.captured;
  await f.advance(10_000);
  assert.equal(p.mounted.controller.state.pending, 'krill.read');
  assert.deepEqual(p.refreshes(), []);
  read.release();
  await p.idle();
  await f.advance(500);
  p.navigate();
  await f.advance(500);
  assert.deepEqual(f.fetches, [0, 70_000]);
  assert.deepEqual(p.refreshes(), [70_000]);
});

test('dispatch start paces successful, server-failed, and sync/async transport-failed refreshes', async t => {
  for (const mode of ['success', 'server', 'sync', 'async']) await t.test(mode, async t => {
    const f = await fixture(t), p = await f.panel(await f.call('krill.usage'));
    await f.advance(30_000);
    const release = ['success', 'server'].includes(mode) ? f.holdFetch() : null;
    if (mode === 'server') f.failFetch();
    if (mode === 'sync' || mode === 'async') p.transportFailure(mode);
    p.refresh();
    p.refresh();
    await flush();
    await f.advance(10_000);
    release?.();
    await p.idle();
    assert.equal(p.mounted.controller.state.payload.view.error?.code ?? null,
      mode === 'success' ? null : mode === 'server' ? 'NETWORK' : 'TRANSPORT_ERROR');
    await f.advance(49_999);
    assert.deepEqual(p.refreshes(), [30_000], 'no early retry or duplicate in-flight dispatch');
    await f.advance(1);
    assert.deepEqual(p.refreshes(), [30_000, 90_000], 'completion and failure do not renew cadence');
    await f.advance(60_000);
    assert.deepEqual(p.refreshes(), [30_000, 90_000, 150_000]);
    assert.deepEqual(f.fetches, release ? [0, 30_000, 90_000, 150_000] : [0]);
  });
});

test('pre-dispatch hide does not count as refresh; hidden completion and permanent cleanup cannot rearm', async t => {
  const f = await fixture(t), p = await f.panel(await f.call('krill.usage'));
  await f.advance(59_000);
  p.refresh();
  p.visibility('hidden');
  await flush();
  assert.deepEqual(p.refreshes(), [], 'abort happened before the bridge was called');
  p.visibility('visible');
  await p.idle();
  await f.advance(1_000);
  assert.deepEqual(f.fetches, [0, 60_000], 'cancelled request did not change the prior deadline');
  await f.advance(10_000);
  const release = f.holdFetch();
  p.refresh();
  await flush();
  assert.deepEqual(f.fetches, [0, 60_000, 70_000]);
  p.visibility('hidden');
  assert.equal(p.calls.at(-1).signal.aborted, true);
  await f.advance(20_000);
  release();
  await flush();
  assert.equal(p.timerCount(), 0);
  await f.advance(10_000);
  p.visibility('visible');
  await p.idle();
  await f.advance(29_999);
  assert.deepEqual(p.refreshes(), [60_000, 70_000]);
  await f.advance(1);
  assert.deepEqual(p.refreshes(), [60_000, 70_000, 130_000], 'dispatched attempt still owns its cadence');
  p.page('pagehide', false);
  p.page('pageshow', true);
  p.visibility('visible');
  p.mounted.render();
  await p.app.onteardown();
  await f.advance(120_000);
  assert.equal(p.mounted.controller.state.disposed, true);
  assert.equal(p.timerCount(), 0);
  assert.deepEqual(f.fetches, [0, 60_000, 70_000, 130_000]);
});

test('settings entry stays read-only; delayed usage entry and shared-service joins keep panel cadence', async t => {
  const f = await fixture(t);
  const settings = await f.call('krill.settings');
  const a = await f.panel(settings);
  assert.deepEqual(f.fetches, []);
  assert.equal(a.mounted.controller.state.page, 'settings');
  const releaseEntry = f.holdFetch();
  const opening = f.call('krill.usage');
  await flush();
  await f.advance(20_000);
  releaseEntry();
  const entry = await opening;
  await f.advance(39_000);
  a.app.ontoolresult(entry);
  assert.equal(a.mounted.controller.state.page, 'settings');
  const b = await f.panel(entry);
  const releaseShared = f.holdFetch();
  b.refresh();
  await flush();
  await f.advance(1_000);
  assert.deepEqual(a.refreshes(), [60_000], 'entry receipt and lastSuccessAt do not move activation baseline');
  assert.deepEqual(b.refreshes(), [59_000]);
  assert.deepEqual(f.fetches, [0, 59_000], 'the due panel joins the real service request');
  await f.advance(1_000);
  releaseShared();
  await a.idle();
  await b.idle();
  b.mounted.dispose();
  await f.advance(29_000);
  a.reload();
  await a.idle();
  a.app.ontoolresult(entry);
  await f.advance(29_999);
  assert.deepEqual(a.refreshes(), [60_000]);
  await f.advance(1);
  assert.deepEqual(a.refreshes(), [60_000, 120_000]);
  assert.deepEqual(f.fetches, [0, 59_000, 120_000]);
  // Removing credentials still disables quota scheduling after a local read.
  f.account.revision = 'synthetic-account-removed';
  f.account.credential = null;
  a.reload();
  await a.idle();
  await f.advance(120_000);
  assert.equal(a.mounted.controller.state.payload.view.authenticated, false);
  assert.deepEqual(f.fetches, [0, 59_000, 120_000]);
});
