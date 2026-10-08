import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { JSDOM } from 'jsdom';
import { UsageService } from '../src/service.mjs';
import { createPreferences } from '../src/preferences.mjs';
import { createController } from '../src/view.mjs';
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
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'krill-backend-instance-'));
  const preferences = createPreferences(dir);
  const services = [];
  function service(balance) {
    const value = new UsageService({ preferences,
      credentials: { readRevision: async () => 'fixture-account', read: async () => 'synthetic-only' },
      fetchUsage: async () => ({ creditBalance: balance, subscriptions: [] })
    });
    services.push(value);
    return value;
  }
  t.after(() => { services.forEach(value => value.dispose()); rmSync(dir, { recursive: true, force: true }); });
  const result = (view, page = 'usage') => {
    const { values, revision } = preferences.readSnapshot();
    return { content: [], structuredContent: { view, page, preferences: values, preferencesRevision: revision } };
  };
  return { preferences, result, a: service('11'), b: service('22'), c: service('33') };
}

test('fresh owned responses adopt restarted low counters; delayed old entries retain independent preferences', async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) f.a.invalidate();
  for (let i = 0; i < 30; i++) f.a.view();
  await f.a.refresh();
  let routed = f.a, failRead = false;
  const calls = [];
  const controller = createController({ callTool: async params => {
    calls.push(params.name);
    if (failRead) throw new Error('Synthetic transport failure');
    return f.result(await routed.read());
  } });
  t.after(() => controller.dispose());
  controller.connect();
  await controller.request('krill.read');
  const old = controller.state.payload.view;
  assert.match(old.instanceId, /^[0-9a-f-]{36}$/);
  await f.b.refresh();
  routed = f.b;
  await controller.request('krill.read');
  const current = controller.state.payload.view;
  assert.notEqual(current.instanceId, old.instanceId);
  assert.ok(current.stateRevision < old.stateRevision);
  assert.ok(current.snapshotRevision < old.snapshotRevision);
  assert.equal(current.snapshot.creditBalance, '22');

  // register.mjs can attach newer disk preferences to an older captured view.
  f.preferences.update({ showBalance: false });
  const delayed = f.result(old);
  controller.receive(delayed, { entry: true });
  controller.receive(delayed, { entry: true });
  assert.equal(controller.state.payload.view, current, 'a different UUID is not authority');
  assert.equal(controller.state.payload.preferences.showBalance, false);
  assert.equal(controller.state.payload.preferencesRevision, 1);
  await flush();
  assert.equal(controller.state.payload.view.instanceId, f.b.instanceId);
  assert.deepEqual(calls, ['krill.read', 'krill.read', 'krill.read'], 'old notifications coalesce one current-backend read');
  await flush();
  assert.equal(calls.length, 3, 'the confirming read cannot schedule itself');
  failRead = true;
  controller.receive(delayed, { entry: true });
  await flush();
  assert.equal(calls.length, 4);
  assert.equal(controller.state.pending, null);
  assert.equal(controller.state.payload.view.instanceId, f.b.instanceId);
  await flush();
  assert.equal(calls.length, 4, 'a failed probe does not retry itself');
  failRead = false;
  assert.equal(await controller.request('krill.read'), true, 'a later explicit read can recover');
  f.b.invalidate();
  assert.equal(f.b.view().instanceId, current.instanceId, 'account invalidation does not change backend identity');
});

test('an aborted A request cannot replace B after its delayed response settles', async t => {
  const f = fixture(t), held = deferred(), captured = deferred();
  let routed = f.a, signal;
  const controller = createController({ callTool: async (params, options) => {
    if (params.name === 'krill.refresh') {
      signal = options.signal;
      const response = f.result(await routed.refresh());
      captured.resolve();
      await held.promise;
      return response;
    }
    return f.result(await routed.read());
  } });
  t.after(() => { held.resolve(); controller.dispose(); });
  controller.connect();
  await controller.request('krill.read');
  const old = controller.request('krill.refresh');
  await captured.promise;
  controller.abort();
  assert.equal(signal.aborted, true);
  routed = f.b;
  await f.b.refresh();
  assert.equal(await controller.request('krill.read'), true);
  const current = controller.state.payload.view;
  held.resolve();
  assert.equal(await old, false);
  assert.equal(controller.state.payload.view, current);
  assert.equal(current.instanceId, f.b.instanceId);
  assert.equal(controller.state.pending, null);
});

test('a pending save is preserved and foreign entries queue one read of the currently routed backend', async t => {
  const f = fixture(t), held = deferred(), captured = deferred();
  let routed = f.a, saveSignal;
  const calls = [];
  const controller = createController({ callTool: async (params, options) => {
    calls.push(params.name);
    if (params.name === 'krill.updateSettings') {
      saveSignal = options.signal;
      f.preferences.update(params.arguments.set);
      const response = f.result(await routed.read());
      captured.resolve();
      await held.promise;
      return response;
    }
    return f.result(await routed.read());
  } });
  t.after(() => { held.resolve(); controller.dispose(); });
  controller.connect();
  await controller.request('krill.read');
  const save = controller.request('krill.updateSettings', { set: { showBalance: false } });
  await captured.promise;
  const advertised = f.result(await f.b.refresh());
  controller.receive(advertised, { entry: true });
  controller.receive(advertised, { entry: true });
  await flush();
  assert.equal(saveSignal.aborted, false);
  assert.equal(controller.state.payload.view.instanceId, f.a.instanceId);
  assert.deepEqual(calls, ['krill.read', 'krill.updateSettings']);
  // B's entry may itself be delayed. The direct read, not that notification,
  // identifies the current backend C when the save finishes.
  routed = f.c;
  await f.c.refresh();
  held.resolve();
  assert.equal(await save, true);
  await flush();
  assert.equal(controller.state.payload.view.instanceId, f.c.instanceId);
  assert.equal(controller.state.payload.view.snapshot.creditBalance, '33');
  assert.equal(controller.state.payload.preferences.showBalance, false);
  assert.equal(controller.state.payload.preferencesRevision, 1);
  assert.deepEqual(calls, ['krill.read', 'krill.updateSettings', 'krill.read']);
});

test('initial navigation survives validation while hidden, aborted, and disposed probes stay stopped', async t => {
  const f = fixture(t), captured = deferred(), held = deferred();
  let routed = f.b, active = true, calls = 0;
  const controller = createController({ isActive: () => active, callTool: async () => {
    calls++;
    const response = f.result(await routed.read());
    if (calls === 1) { captured.resolve(); await held.promise; }
    return response;
  } });
  t.after(() => { held.resolve(); controller.dispose(); });
  const opening = f.result(await f.a.refresh(), 'settings');
  controller.receive(opening, { entry: true });
  assert.equal(controller.state.page, 'settings');
  assert.equal(controller.state.payload.view.instanceId, null, 'entry alone cannot establish a backend');
  const unversioned = structuredClone(opening);
  delete unversioned.structuredContent.view.instanceId;
  assert.equal(controller.receive(unversioned), false);
  controller.connect();
  const initial = controller.request('krill.read');
  await captured.promise;
  const newerEntry = f.result(await f.b.refresh());
  controller.receive(newerEntry, { entry: true });
  assert.equal(controller.state.payload.view.instanceId, null);
  held.resolve();
  await initial;
  await flush();
  assert.equal(calls, 2, 'adopting the advertised backend does not discard its queued fresh read');
  assert.equal(controller.state.payload.view.instanceId, f.b.instanceId);
  assert.ok(controller.state.payload.view.snapshotRevision > newerEntry.structuredContent.view.snapshotRevision);
  assert.equal(controller.state.payload.view.snapshot.creditBalance, '22');
  assert.equal(controller.state.page, 'settings');
  active = false;
  controller.abort();
  routed = f.c;
  controller.receive(f.result(await f.c.refresh()), { entry: true });
  await flush();
  assert.equal(calls, 2, 'hidden entries cannot issue reads');
  controller.abort();
  active = true;
  await flush();
  assert.equal(calls, 2, 'abort cancels queued work');
  await controller.request('krill.read');
  assert.equal(controller.state.payload.view.instanceId, f.c.instanceId);
  controller.dispose();
  controller.receive(opening, { entry: true });
  await flush();
  assert.equal(calls, 3);
});

test('one official App/AppBridge and mounted UI accept a replacement MCP backend', async t => {
  const f = fixture(t), connections = [];
  for (const service of [f.a, f.b]) {
    const server = createServer({ service, preferences: f.preferences, html: '<!doctype html>' });
    const client = new Client({ name: 'Backend restart fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ server, client });
  }
  const [backendA, backendB] = connections;
  for (let i = 0; i < 8; i++) f.a.invalidate();
  const opening = await backendA.client.callTool({ name: 'krill.usage', arguments: {} });
  let routed = backendA.client, calls = 0;
  const bridge = new AppBridge(null, { name: 'Retained host fixture', version: '1' }, { serverTools: {} });
  bridge.oncalltool = (params, extra) => {
    calls++;
    return routed.callTool(params, undefined, { signal: extra.signal });
  };
  const app = new App({ name: 'Retained UI fixture', version: '1' }, {}, { autoResize: false });
  const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair();
  await bridge.connect(hostTransport);
  const connect = app.connect.bind(app);
  app.connect = () => connect(appTransport);
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const mounted = mountKrillApp({ app, root: doc.getElementById('app'), doc, win: dom.window });
  t.after(async () => {
    mounted.dispose();
    dom.window.close();
    await app.close();
    await bridge.close();
    for (const { client, server } of connections) { await client.close(); await server.close(); }
  });
  await mounted.connected;
  await bridge.sendToolInput({ arguments: {} });
  await bridge.sendToolResult(opening);
  await flush();
  assert.equal(mounted.controller.state.payload.view.instanceId, f.a.instanceId);
  assert.equal(doc.querySelector('.hero-amount').textContent, '$11.00');
  routed = backendB.client;
  const replacement = await routed.callTool({ name: 'krill.usage', arguments: {} });
  await bridge.sendToolResult(replacement);
  await flush();
  assert.equal(mounted.controller.state.payload.view.instanceId, f.b.instanceId);
  assert.ok(mounted.controller.state.payload.view.stateRevision < opening.structuredContent.view.stateRevision);
  assert.equal(doc.querySelector('.hero-amount').textContent, '$22.00');
  await bridge.sendToolResult(opening);
  await flush();
  assert.equal(mounted.controller.state.payload.view.instanceId, f.b.instanceId);
  assert.equal(doc.querySelector('.hero-amount').textContent, '$22.00');
  assert.equal(mounted.controller.state.pending, null);
  Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
  doc.dispatchEvent(new dom.window.Event('visibilitychange'));
  const beforeHiddenEntry = calls;
  await bridge.sendToolResult(opening);
  await flush();
  assert.equal(calls, beforeHiddenEntry, 'the retained hidden UI does not probe');
  Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
  doc.dispatchEvent(new dom.window.Event('visibilitychange'));
  await flush();
  assert.equal(calls, beforeHiddenEntry + 1, 'visibility restoration supplies one current read');
  assert.equal(mounted.controller.state.payload.view.instanceId, f.b.instanceId);
});
