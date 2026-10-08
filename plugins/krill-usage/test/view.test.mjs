import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_PREFERENCES, numberOrNull, money, primarySubscription, remainingPercent,
  percentText, quotaTone, dateText, countdown, freshness, usageModel,
  validatePreferences, normalizePreferences, createController
} from '../src/view.mjs';
import { mountKrillApp } from '../src/app.mjs';

const now = Date.now();
const plans = [
  { id: 'frozen', name: '冻结卡', type: 'monthly', status: 'frozen', remaining: '100', limit: '100', resetAt: '2026-10-09T00:00:00Z', endAt: '2026-11-09T00:00:00Z' },
  { id: 'empty', name: '已用完', type: 'weekly', status: 'active', remaining: '0', limit: '100', resetAt: null, endAt: null },
  { id: 'primary', name: '月卡', type: 'monthly', status: 'active', remaining: '12.50', limit: '100', resetAt: '2026-10-09T00:00:00Z', endAt: '2026-11-09T00:00:00Z' },
  { id: 'next', name: '天卡', type: 'daily', status: 'active', remaining: '70', limit: '100', resetAt: null, endAt: '2026-10-09T00:00:00Z' }
];
const payload = (overrides = {}) => ({
  page: 'usage',
  preferences: { ...DEFAULT_PREFERENCES },
  view: { snapshot: { creditBalance: '23.95', subscriptions: plans }, authenticated: true, refreshing: false, stale: false, lastSuccessAt: now, error: null, refreshMinutes: 3 },
  ...overrides
});
const result = (data = payload()) => ({ content: [], structuredContent: data });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('amounts preserve zero and unknown distinctions', () => {
  for (const value of [null, undefined, '', ' ', false, {}, 'NaN', Infinity]) assert.equal(numberOrNull(value), null);
  assert.equal(money(null), '未知');
  assert.equal(money('0'), '$0.00');
  assert.equal(money('0.0002'), '<$0.01');
  assert.equal(money('-1.2'), '−$1.20');
  assert.equal(money('1234.50'), '$1,234.50');
});

test('primary is first active positive plan, preserving server order', () => {
  assert.equal(primarySubscription(plans).id, 'primary');
  assert.equal(primarySubscription([{ status: 'active', remaining: null }, { status: 'active', remaining: '-1' }]), null);
  assert.deepEqual(usageModel(payload()).plans.map((plan) => plan.id), ['frozen', 'empty', 'primary', 'next']);
  assert.equal(usageModel(payload()).primaryValue, '$12.50');
});

test('balance fallback and privacy setting never turn unknown into zero', () => {
  const data = payload();
  data.view.snapshot.subscriptions = plans.slice(0, 2);
  assert.equal(usageModel(data).primaryValue, '$23.95');
  data.preferences.showBalance = false;
  assert.equal(usageModel(data).primaryValue, '已隐藏');
  data.preferences.showBalance = true;
  data.view.snapshot.creditBalance = null;
  assert.equal(usageModel(data).primaryValue, '未知');
});

test('percentages clamp and quota thresholds are explicit', () => {
  assert.equal(remainingPercent('200', '100'), 100);
  assert.equal(remainingPercent('-2', '100'), 0);
  assert.equal(remainingPercent('2', '0'), null);
  assert.equal(remainingPercent(null, '100'), null);
  assert.equal(percentText(0.2), '<1%');
  assert.equal(quotaTone(null), 'unknown');
  assert.equal(quotaTone(5), 'critical');
  assert.equal(quotaTone(15), 'warning');
  assert.equal(quotaTone(16), 'good');
});

test('dates are distinct and unknown or past times are explicit', () => {
  assert.equal(dateText(null), '未知');
  assert.equal(dateText('not a date'), '未知');
  assert.equal(countdown('2026-10-08T00:30:00Z', Date.parse('2026-10-08T00:00:00Z')), '30 分钟后');
  assert.equal(countdown('2026-10-07T00:00:00Z', Date.parse('2026-10-08T00:00:00Z')), '时间已到');
});

test('stale boundary is one refresh interval and failed refresh retains timestamp', () => {
  const data = payload();
  assert.equal(freshness(data.view, now + 179999, 3).stale, false);
  assert.equal(freshness(data.view, now + 180000, 3).stale, true);
  data.view.error = { code: 'TIMEOUT', message: '请求超时' };
  const failed = freshness(data.view, now + 60000, 3);
  assert.match(failed.label, /保留上次数据/);
  assert.equal(failed.ageText, '1 分钟前同步');
  assert.notEqual(failed.timestamp, '尚未成功同步');
});

test('preferences validate bounds, integer cadence, threshold ordering, and exact allowlist', () => {
  assert.ok(validatePreferences({ ...DEFAULT_PREFERENCES, refreshIntervalMinutes: 0 }).error);
  assert.ok(validatePreferences({ ...DEFAULT_PREFERENCES, refreshIntervalMinutes: 61 }).error);
  assert.ok(validatePreferences({ ...DEFAULT_PREFERENCES, refreshIntervalMinutes: 1.5 }).error);
  assert.ok(validatePreferences({ ...DEFAULT_PREFERENCES, lowQuotaWarningPercent: 4 }).error);
  const valid = validatePreferences({ ...DEFAULT_PREFERENCES, refreshIntervalMinutes: '1', lowQuotaCriticalPercent: 2.5, token: 'must not travel' });
  assert.equal(valid.set.refreshIntervalMinutes, 1);
  assert.equal(valid.set.lowQuotaCriticalPercent, 2.5);
  assert.equal(Object.hasOwn(valid.set, 'token'), false);
  assert.equal(normalizePreferences({ refreshIntervalMinutes: 600 }).refreshIntervalMinutes, 3);
});

test('controller coalesces repeated refresh and does not navigate on app calls', async () => {
  const pending = deferred();
  const calls = [];
  const controller = createController({ callTool: (...args) => { calls.push(args); return pending.promise; } });
  controller.connect();
  controller.receive(result(payload({ page: 'settings' })), { entry: true });
  const one = controller.request('krill.refresh');
  const two = controller.request('krill.refresh');
  assert.equal(one, two);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].name, 'krill.refresh');
  assert.equal(calls[0][1].timeout, 20000);
  pending.resolve(result());
  assert.equal(await one, true);
  assert.equal(controller.state.page, 'settings');
  assert.equal(controller.state.pending, null);
  controller.dispose();
});

test('controller retains cached values on transport failure and rejects tool errors', async () => {
  const controller = createController({ callTool: async () => { throw new Error('secret must never render'); } });
  controller.connect();
  controller.receive(result());
  assert.equal(await controller.request('krill.refresh'), false);
  assert.equal(controller.state.payload.view.snapshot.creditBalance, '23.95');
  assert.equal(controller.state.payload.view.error.code, 'TRANSPORT_ERROR');
  assert.doesNotMatch(controller.state.notice, /secret/);
  controller.dispose();
  const rejected = createController({ callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'internal details' }] }) });
  rejected.connect();
  assert.equal(await rejected.request('krill.updateSettings'), false);
  assert.match(rejected.state.notice, /未保存/);
  rejected.dispose();
});

test('late entry results preserve newer cache but accept newer initial GET', () => {
  const controller = createController({ callTool: async () => result() });
  controller.receive(result());
  const older = payload({ page: 'settings' });
  older.view.lastSuccessAt = now - 10000;
  older.view.snapshot.creditBalance = '1';
  controller.receive(result(older), { entry: true });
  assert.equal(controller.state.page, 'settings');
  assert.equal(controller.state.payload.view.snapshot.creditBalance, '23.95');
  const newer = payload();
  newer.view.lastSuccessAt = now + 1000;
  newer.view.snapshot.creditBalance = '9';
  controller.receive(result(newer), { entry: true });
  assert.equal(controller.state.payload.view.snapshot.creditBalance, '9');
  controller.dispose();
});

test('abort before dispatch cancels old request without stealing a newer signal', async () => {
  const calls = [];
  const controller = createController({ callTool: async (...args) => { calls.push(args); return result(); } });
  controller.connect();
  const old = controller.request('krill.refresh');
  controller.abort();
  const next = controller.request('krill.read');
  assert.equal(await old, false);
  assert.equal(await next, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].name, 'krill.read');
  assert.equal(calls[0][1].signal.aborted, false);
  controller.dispose();
});

test('dispose aborts an active request and ignores its eventual response', async () => {
  const pending = deferred();
  let signal;
  let paints = 0;
  const controller = createController({ callTool: (_, options) => { signal = options.signal; return pending.promise; }, onChange: () => { paints += 1; } });
  controller.connect();
  const request = controller.request('krill.refresh');
  await flush();
  controller.dispose();
  const previous = paints;
  assert.equal(signal.aborted, true);
  pending.resolve(result());
  assert.equal(await request, false);
  assert.equal(paints, previous);
  assert.equal(controller.state.payload.view.snapshot, null);
});

function fixture(handler = async () => result()) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
  const timers = new Map();
  let timerId = 0;
  dom.window.setTimeout = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; };
  dom.window.clearTimeout = (id) => timers.delete(id);
  const calls = [];
  const app = {
    connect: async () => {},
    callServerTool: (params, options) => { calls.push({ params, options }); return handler(params, options); },
    getHostContext: () => ({ theme: 'light', styles: { variables: { '--color-text-primary': '#123456' } } })
  };
  const mounted = mountKrillApp({ app, root: dom.window.document.getElementById('app'), doc: dom.window.document, win: dom.window });
  return { dom, doc: dom.window.document, app, calls, timers, mounted,
    close() { mounted.dispose(); dom.window.close(); } };
}

test('DOM mount renders all plans, dates, theme variables, and no credential input', async () => {
  const ui = fixture();
  try {
    await ui.mounted.connected;
    assert.equal(ui.doc.querySelectorAll('.plan-card').length, 4);
    assert.equal(ui.doc.querySelector('.hero-amount').textContent, '$12.50');
    assert.equal(ui.doc.querySelectorAll('.plan-dates dt')[0].textContent, '额度重置');
    assert.equal(ui.doc.querySelectorAll('.plan-dates dt')[1].textContent, '套餐到期');
    assert.match(ui.doc.querySelector('.last-success').textContent, /上次成功同步/);
    assert.equal(ui.doc.documentElement.dataset.theme, 'light');
    assert.equal(ui.doc.documentElement.style.getPropertyValue('--color-text-primary'), '#123456');
    assert.equal(ui.doc.querySelectorAll('input[type="password"],input[type="text"],textarea').length, 0);
    assert.match(ui.doc.querySelector('.setup-command').textContent, /node dist\/credential-cli.cjs set/);
    assert.equal(ui.calls[0].params.name, 'krill.read');
    assert.equal(ui.timers.size, 2);
  } finally { ui.close(); }
});

test('DOM uses textContent for untrusted names and preserves reset versus expiry', async () => {
  const data = payload();
  data.view.snapshot.subscriptions = [{ ...plans[2], name: '<img src=x onerror=alert(1)>' }];
  const ui = fixture(async () => result(data));
  try {
    await ui.mounted.connected;
    assert.equal(ui.doc.querySelectorAll('img').length, 0);
    assert.match(ui.doc.querySelector('.plan-title').textContent, /<img/);
    assert.notEqual(ui.doc.querySelectorAll('.plan-dates dd')[0].textContent, ui.doc.querySelectorAll('.plan-dates dd')[1].textContent);
  } finally { ui.close(); }
});

test('DOM repeated refresh clicks coalesce and hidden panel stops timers and cancels calls', async () => {
  const pending = deferred();
  const ui = fixture((params) => params.name === 'krill.refresh' ? pending.promise : Promise.resolve(result()));
  try {
    await ui.mounted.connected;
    const refresh = ui.doc.querySelector('.refresh-button');
    refresh.click();
    refresh.click();
    await flush();
    assert.equal(ui.calls.filter((call) => call.params.name === 'krill.refresh').length, 1);
    assert.equal(refresh.disabled, true);
    Object.defineProperty(ui.doc, 'visibilityState', { value: 'hidden', configurable: true });
    ui.doc.dispatchEvent(new ui.dom.window.Event('visibilitychange'));
    assert.equal(ui.timers.size, 0);
    assert.equal(ui.calls.at(-1).options.signal.aborted, true);
    pending.resolve(result());
    await flush();
    assert.equal(ui.timers.size, 0);
    Object.defineProperty(ui.doc, 'visibilityState', { value: 'visible', configurable: true });
    ui.doc.dispatchEvent(new ui.dom.window.Event('visibilitychange'));
    await flush();
    assert.equal(ui.calls.at(-1).params.name, 'krill.read');
    assert.equal(ui.timers.size, 2);
    await ui.app.onteardown();
    assert.equal(ui.timers.size, 0);
    assert.equal(ui.mounted.controller.state.disposed, true);
  } finally { ui.close(); }
});

test('settings save uses exact allowlist and reload preserves current page', async () => {
  const ui = fixture(async (params) => {
    const data = payload();
    if (params.name === 'krill.updateSettings') data.preferences = params.arguments.set;
    return result(data);
  });
  try {
    await ui.mounted.connected;
    ui.doc.querySelectorAll('.nav-button')[1].click();
    const input = ui.doc.getElementById('refreshIntervalMinutes');
    input.value = '5';
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    ui.doc.querySelector('form').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const saved = ui.calls.find((call) => call.params.name === 'krill.updateSettings');
    assert.deepEqual(Object.keys(saved.params.arguments), ['set']);
    assert.deepEqual(Object.keys(saved.params.arguments.set).sort(), Object.keys(DEFAULT_PREFERENCES).sort());
    assert.equal(saved.params.arguments.set.refreshIntervalMinutes, 5);
    assert.equal(ui.doc.querySelector('.form-status').textContent, '设置已保存');
    ui.doc.querySelector('.quiet-button').click();
    await flush();
    assert.equal(ui.mounted.controller.state.page, 'settings');
    assert.equal(input.value, '3');
    assert.equal(ui.doc.querySelector('.settings-page').hidden, false);
  } finally { ui.close(); }
});

test('pagehide and unload clear timers including bfcache suspension', async () => {
  const ui = fixture();
  try {
    await ui.mounted.connected;
    ui.dom.window.dispatchEvent(new ui.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    assert.equal(ui.timers.size, 0);
    assert.equal(ui.mounted.controller.state.disposed, false);
    ui.dom.window.dispatchEvent(new ui.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await flush();
    assert.equal(ui.timers.size, 2);
    ui.dom.window.dispatchEvent(new ui.dom.window.Event('unload'));
    assert.equal(ui.timers.size, 0);
    assert.equal(ui.mounted.controller.state.disposed, true);
  } finally { ui.close(); }
});
