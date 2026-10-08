/** Pure presentation helpers and a bounded, host-independent request controller. */
export const DEFAULT_PREFERENCES = Object.freeze({
  refreshIntervalMinutes: 3,
  showBalance: true,
  lowQuotaWarningPercent: 15,
  lowQuotaCriticalPercent: 5
});

export function numberOrNull(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function money(value) {
  const number = numberOrNull(value);
  if (number === null) return '未知';
  if (number > 0 && number < 0.01) return '<$0.01';
  if (number < 0 && number > -0.01) return '−<$0.01';
  return `${number < 0 ? '−' : ''}$${Math.abs(number).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  })}`;
}

export function remainingPercent(remaining, limit) {
  const amount = numberOrNull(remaining);
  const total = numberOrNull(limit);
  return amount === null || total === null || total <= 0 ? null : Math.max(0, Math.min(100, amount / total * 100));
}

export function percentText(value) {
  if (value === null || !Number.isFinite(value)) return '未知';
  return value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
}

export function quotaTone(percent, preferences = DEFAULT_PREFERENCES) {
  if (percent === null) return 'unknown';
  if (percent <= preferences.lowQuotaCriticalPercent) return 'critical';
  if (percent <= preferences.lowQuotaWarningPercent) return 'warning';
  return 'good';
}

export function primarySubscription(subscriptions = []) {
  return subscriptions.find((plan) => plan?.status === 'active' && numberOrNull(plan.remaining) > 0) ?? null;
}

export function statusText(status) {
  return ({ active: '使用中', frozen: '已冻结', expired: '已到期', cancelled: '已取消', canceled: '已取消', unknown: '状态未知' })[status] || '状态未知';
}

export function planTypeText(type) {
  return ({ monthly: '月卡', weekly: '周卡', daily: '天卡' })[type] || '套餐';
}

export function dateText(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return '未知';
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

export function countdown(value, now = Date.now()) {
  const target = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(target)) return '时间未知';
  const minutes = Math.ceil((target - now) / 60_000);
  if (minutes <= 0) return '时间已到';
  if (minutes < 60) return `${minutes} 分钟后`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后`;
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时后`;
}

export function normalizePreferences(value = {}) {
  const bounded = (key, min, max) => {
    const number = numberOrNull(value[key]);
    return number !== null && number >= min && number <= max ? number : DEFAULT_PREFERENCES[key];
  };
  const warning = bounded('lowQuotaWarningPercent', 0, 100);
  const interval = bounded('refreshIntervalMinutes', 1, 60);
  return {
    refreshIntervalMinutes: Number.isInteger(interval) ? interval : DEFAULT_PREFERENCES.refreshIntervalMinutes,
    showBalance: typeof value.showBalance === 'boolean' ? value.showBalance : true,
    lowQuotaWarningPercent: warning,
    lowQuotaCriticalPercent: Math.min(warning, bounded('lowQuotaCriticalPercent', 0, 100))
  };
}

export function validatePreferences(values) {
  const set = {};
  for (const [key, min, max, title] of [
    ['refreshIntervalMinutes', 1, 60, '刷新间隔'],
    ['lowQuotaWarningPercent', 0, 100, '低额度提醒'],
    ['lowQuotaCriticalPercent', 0, 100, '紧急提醒']
  ]) {
    const value = numberOrNull(values[key]);
    if (value === null || value < min || value > max) return { error: `${title}需在 ${min}–${max} 之间。` };
    if (key === 'refreshIntervalMinutes' && !Number.isInteger(value)) return { error: '刷新间隔需为 1–60 之间的整数。' };
    set[key] = value;
  }
  if (set.lowQuotaCriticalPercent > set.lowQuotaWarningPercent) return { error: '紧急提醒不能高于低额度提醒。' };
  set.showBalance = Boolean(values.showBalance);
  return { set };
}

export function normalizePayload(payload = {}) {
  const view = payload.view ?? {};
  return {
    page: payload.page === 'settings' ? 'settings' : 'usage',
    preferences: normalizePreferences(payload.preferences),
    preferencesRevision: Number.isSafeInteger(payload.preferencesRevision) && payload.preferencesRevision >= 0 ? payload.preferencesRevision : 0,
    view: {
      snapshot: view.snapshot && Array.isArray(view.snapshot.subscriptions) ? {
        creditBalance: view.snapshot.creditBalance ?? null,
        subscriptions: view.snapshot.subscriptions.filter((plan) => plan && typeof plan === 'object')
      } : null,
      error: view.error && typeof view.error.code === 'string' ? { code: view.error.code, message: typeof view.error.message === 'string' ? view.error.message : '查询失败，请稍后重试。' } : null,
      refreshing: view.refreshing === true,
      lastSuccessAt: numberOrNull(view.lastSuccessAt) ?? 0,
      stateRevision: Number.isSafeInteger(view.stateRevision) && view.stateRevision >= 0 ? view.stateRevision : 0,
      snapshotRevision: Number.isSafeInteger(view.snapshotRevision) && view.snapshotRevision >= 0 ? view.snapshotRevision : 0,
      authenticated: view.authenticated === true,
      stale: view.stale === true,
      refreshMinutes: numberOrNull(view.refreshMinutes) ?? 3
    }
  };
}

export function freshness(view, now = Date.now(), refreshMinutes = 3) {
  const age = view.lastSuccessAt > 0 ? Math.max(0, now - view.lastSuccessAt) : null;
  // The server's stale flag may have used an older preference interval. Derive
  // freshness from the accepted preferences even when quota and settings arrived
  // in different results; a failed refresh still marks cached data as stale.
  const stale = Boolean(view.snapshot && (view.error || (age !== null && age >= refreshMinutes * 60_000)));
  const ageText = age === null ? '尚未成功同步' : age < 60_000 ? '刚刚同步' : `${Math.floor(age / 60_000)} 分钟前同步`;
  const timestamp = age === null ? '尚未成功同步' : new Date(view.lastSuccessAt).toLocaleString('zh-CN', { hour12: false });
  if (view.error) return { tone: 'warning', label: view.snapshot ? '刷新失败 · 保留上次数据' : '暂时无法查询', ageText, timestamp, stale };
  if (!view.authenticated) return { tone: 'muted', label: '本机凭证待验证 · 点击刷新', ageText, timestamp, stale };
  if (view.refreshing) return { tone: 'muted', label: '正在同步额度', ageText, timestamp, stale };
  if (stale) return { tone: 'warning', label: '数据已过时 · 请刷新', ageText, timestamp, stale };
  return { tone: 'good', label: view.snapshot ? '额度已同步' : '等待首次同步', ageText, timestamp, stale };
}

export function usageModel(payload, now = Date.now()) {
  const { view, preferences } = normalizePayload(payload);
  const plans = view.snapshot?.subscriptions ?? [];
  const primary = primarySubscription(plans);
  const balance = preferences.showBalance ? money(view.snapshot?.creditBalance) : '已隐藏';
  return {
    view, preferences, plans, primary, balance,
    primaryLabel: primary ? '当前套餐剩余' : '账户余额',
    primaryValue: primary ? money(primary.remaining) : balance,
    primaryPercent: primary ? remainingPercent(primary.remaining, primary.limit) : null,
    freshness: freshness(view, now, preferences.refreshIntervalMinutes)
  };
}

/** One in-flight request; explicit abort and generation checks guard late replies. */
export function createController({ callTool, onChange = () => {}, initialPage = 'usage' }) {
  const state = { payload: normalizePayload(), page: initialPage, connected: false, pending: null, notice: '', disposed: false };
  let inFlight = null;
  let aborter = null;
  let generation = 0;
  let entryReceived = false;
  const emit = () => { if (!state.disposed) onChange(state); };
  function receive(result, { entry = false } = {}) {
    if (state.disposed || !result?.structuredContent?.view) return false;
    const payload = normalizePayload(result.structuredContent);
    // Account resets take precedence. Within an account, order every captured
    // view, including loading and failures, independently of success timestamps.
    // Equal captures are replays and must not replace already accepted state.
    const incomingRevision = payload.view.stateRevision;
    const currentRevision = state.payload.view.stateRevision;
    if (incomingRevision > currentRevision || (incomingRevision === currentRevision &&
        payload.view.snapshotRevision > state.payload.view.snapshotRevision)) {
      state.payload.view = payload.view;
      state.payload.page = payload.page;
    }
    // Settings are global to the local plugin, not to an account or quota GET.
    // An older quota result can carry newer settings, and vice versa.
    if (payload.preferencesRevision >= state.payload.preferencesRevision) {
      state.payload.preferences = payload.preferences;
      state.payload.preferencesRevision = payload.preferencesRevision;
    }
    if (entry && !entryReceived) {
      state.page = payload.page;
      entryReceived = true;
    }
    emit();
    return true;
  }
  function request(name, args = {}) {
    if (state.disposed || !state.connected) return Promise.resolve(false);
    if (inFlight) return inFlight;
    const token = ++generation;
    const requestAborter = new AbortController();
    aborter = requestAborter;
    state.pending = name;
    state.notice = '';
    emit();
    inFlight = Promise.resolve().then(() => {
      if (state.disposed || token !== generation) return null;
      return callTool({ name, arguments: args }, { signal: requestAborter.signal, timeout: 20000 });
    }).then((result) => {
      if (state.disposed || token !== generation) return false;
      const accepted = receive(result);
      if (!accepted || result.isError) {
        state.notice = name === 'krill.updateSettings' ? '设置未保存，请检查输入后重试。' : '暂时无法完成请求，请重试。';
        return false;
      }
      if (name === 'krill.updateSettings') state.notice = '设置已保存';
      return true;
    }).catch(() => {
      if (state.disposed || token !== generation) return false;
      state.notice = name === 'krill.updateSettings' ? '连接中断，设置未确认保存。请重新加载后检查。' : '连接中断或请求超时，请重试。';
      if (name === 'krill.refresh') {
        state.payload.view.error = { code: 'TRANSPORT_ERROR', message: '连接中断或请求超时，请重试。' };
      }
      return false;
    }).finally(() => {
      if (token === generation) {
        inFlight = null;
        aborter = null;
        state.pending = null;
        emit();
      }
    });
    return inFlight;
  }
  return {
    state,
    receive,
    request,
    connect() { if (!state.disposed) { state.connected = true; emit(); } },
    navigate(page) { state.page = page === 'settings' ? 'settings' : 'usage'; state.notice = ''; emit(); },
    notify(message) { state.notice = message; emit(); },
    abort() { generation += 1; aborter?.abort(); aborter = null; inFlight = null; state.pending = null; emit(); },
    dispose() { state.disposed = true; state.connected = false; generation += 1; aborter?.abort(); aborter = null; inFlight = null; state.pending = null; }
  };
}
