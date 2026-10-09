import { App, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import {
  createController, usageModel, money, remainingPercent, percentText,
  quotaTone, statusText, planTypeText, dateText, countdown, validatePreferences
} from './view.mjs';

const CREDENTIAL_COMMAND = 'node dist/credential-cli.cjs set';

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountKrillApp({ app, root, doc = document, win = window }) {
  const el = (tag, cls, text) => element(doc, tag, cls, text);
  const button = (text, cls = 'button') => {
    const node = el('button', cls, text);
    node.type = 'button';
    return node;
  };
  const shell = el('main', 'krill-shell');
  const header = el('header', 'app-header');
  const identity = el('div', 'identity');
  const mark = el('span', 'brand-mark', 'K');
  mark.setAttribute('aria-hidden', 'true');
  const titles = el('div');
  titles.append(el('h1', 'app-title', 'Krill Usage'), el('p', 'eyebrow', '额度概览 · 非官方工具'));
  identity.append(mark, titles);
  const refresh = button('刷新', 'button refresh-button');
  refresh.setAttribute('aria-label', '立即刷新 Krill 额度');
  header.append(identity, refresh);
  const nav = el('nav', 'page-nav');
  nav.setAttribute('aria-label', '面板页面');
  const usageNav = button('额度', 'nav-button');
  const settingsNav = button('设置', 'nav-button');
  nav.append(usageNav, settingsNav);
  const notice = el('p', 'notice');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.hidden = true;
  const usage = el('section', 'usage-page');
  usage.setAttribute('aria-label', '额度概览');
  const status = el('div', 'sync-status');
  const statusLabel = el('span', 'sync-label');
  const statusAge = el('span', 'sync-age');
  status.setAttribute('role', 'status');
  status.append(statusLabel, statusAge);
  const error = el('p', 'error-detail');
  const hero = el('section', 'hero-card');
  const heroBody = el('div', 'hero-body');
  const heroLabel = el('p', 'field-label');
  const heroAmount = el('p', 'hero-amount');
  const heroDetail = el('p', 'hero-detail');
  heroBody.append(heroLabel, heroAmount, heroDetail);
  const balanceAside = el('div', 'balance-aside');
  const balanceAmount = el('p', 'balance-amount');
  balanceAside.append(el('p', 'field-label', '账户余额'), balanceAmount, el('p', 'muted tiny', 'USD'));
  hero.append(heroBody, balanceAside);
  const planHeader = el('div', 'section-heading');
  const planCount = el('span', 'count-badge');
  planHeader.append(el('h2', '', '全部套餐'), planCount);
  const planList = el('div', 'plan-list');
  const setupUsage = createSetup();
  const empty = el('div', 'empty-card');
  usage.append(status, error, hero, planHeader, planList, empty, setupUsage);

  const settings = el('section', 'settings-page');
  settings.hidden = true;
  settings.setAttribute('aria-label', '面板设置');
  const settingsHeading = el('div', 'settings-heading');
  settingsHeading.append(el('h2', '', '面板设置'), el('p', 'muted', '保存在本机，重新打开后仍然生效。'));
  const form = el('form', 'settings-form');
  const inputs = {};
  const intervalRow = field('refreshIntervalMinutes', '刷新间隔', '面板可见时自动查询；关闭后停止。', 1, 60, '分钟');
  const showRow = el('div', 'setting-row');
  const showLabel = el('label', 'setting-copy');
  showLabel.htmlFor = 'showBalance';
  showLabel.append(el('span', 'setting-name', '显示账户余额'), el('span', 'muted setting-description', '隐藏后仍会显示套餐额度。'));
  const showInput = el('input', 'toggle');
  showInput.type = 'checkbox';
  showInput.id = 'showBalance';
  inputs.showBalance = showInput;
  showRow.append(showLabel, showInput);
  const warningRow = field('lowQuotaWarningPercent', '低额度提醒', '剩余额度达到此比例时标为橙色。', 0, 100, '%');
  const criticalRow = field('lowQuotaCriticalPercent', '紧急提醒', '需小于或等于低额度提醒比例。', 0, 100, '%');
  const actions = el('div', 'form-actions');
  const save = button('保存设置', 'button primary-button');
  save.type = 'submit';
  const reload = button('重新加载', 'button quiet-button');
  actions.append(save, reload);
  const formStatus = el('p', 'form-status');
  formStatus.setAttribute('role', 'status');
  formStatus.setAttribute('aria-live', 'polite');
  form.append(intervalRow, showRow, warningRow, criticalRow, actions, formStatus);
  const setupSettings = createSetup();
  settings.append(settingsHeading, form, setupSettings);
  const footer = el('footer', 'app-footer');
  const footerText = el('span');
  const lastSuccess = el('span', 'last-success');
  footer.append(footerText, el('span', '', '金额单位 USD · 以 Krill 为准'), lastSuccess);
  shell.append(header, nav, notice, usage, settings, footer);
  root.replaceChildren(shell);

  const dirtyFields = new Map();
  let disposed = false;
  let suspended = false;
  let refreshTimer = null;
  let armedRefreshDeadline = null;
  let tickTimer = null;
  let settingsEditVersion = 0;
  let settingsRequestVersion = 0;
  // Activation supplies the initial baseline. Only a dispatched quota attempt
  // advances it; reads, saves, result delivery, and pre-dispatch aborts do not.
  let lastQuotaAttemptAt = Date.now();
  let refreshInterval = null;
  let refreshDeadline = null;
  const controller = createController({ callTool: (params, options) => {
    if (params.name === 'krill.refresh') {
      lastQuotaAttemptAt = Date.now();
      refreshDeadline = lastQuotaAttemptAt + refreshInterval;
    }
    return app.callServerTool(params, options);
  }, onChange: render, isActive: () => !suspended && doc.visibilityState !== 'hidden' });

  function createSetup() {
    const box = el('aside', 'setup-card');
    box.append(el('h2', '', '本机凭证'), el('p', 'muted', '在你自己的终端中，进入插件目录并运行以下命令，打开 Windows 原生凭据窗口：'), el('code', 'setup-command', CREDENTIAL_COMMAND), el('p', 'setup-warning', '只在原生窗口中输入 JWT，不要粘贴到终端、聊天或面板设置中。'));
    box.append(el('p', 'muted tiny', '新增或替换凭证暂仅支持 Windows。更新后，点击刷新或关闭并重新打开面板。'));
    return box;
  }

  function field(name, title, description, min, max, suffix) {
    const row = el('div', 'setting-row');
    const label = el('label', 'setting-copy');
    label.htmlFor = name;
    const descriptionNode = el('span', 'muted setting-description', description);
    descriptionNode.id = `${name}-hint`;
    label.append(el('span', 'setting-name', title), descriptionNode);
    const control = el('div', 'number-control');
    const input = el('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = String(min);
    input.max = String(max);
    input.step = name === 'refreshIntervalMinutes' ? '1' : 'any';
    input.required = true;
    input.id = name;
    input.setAttribute('aria-describedby', descriptionNode.id);
    inputs[name] = input;
    control.append(input, el('span', 'muted', suffix));
    row.append(label, control);
    return row;
  }

  function render() {
    if (disposed) return;
    const state = controller.state;
    const model = usageModel(state.payload);
    // Another panel may be refreshing. A click can join that server-side request.
    const busy = Boolean(state.pending);
    refresh.disabled = !state.connected || busy;
    refresh.textContent = busy ? '同步中…' : '刷新';
    refresh.setAttribute('aria-busy', String(busy));
    usage.hidden = state.page !== 'usage';
    settings.hidden = state.page !== 'settings';
    usageNav.setAttribute('aria-current', state.page === 'usage' ? 'page' : 'false');
    settingsNav.setAttribute('aria-current', state.page === 'settings' ? 'page' : 'false');
    notice.textContent = state.notice;
    notice.hidden = !state.notice;
    const fresh = model.freshness;
    status.dataset.tone = fresh.tone;
    statusLabel.textContent = !state.connected ? '正在连接面板' : state.pending === 'krill.refresh' ? '正在同步额度' : fresh.label;
    statusAge.textContent = fresh.ageText;
    statusAge.title = `上次成功同步：${fresh.timestamp}`;
    error.hidden = !model.view.error;
    error.textContent = model.view.error?.message ?? '';
    hero.hidden = !model.view.snapshot;
    heroLabel.textContent = model.primaryLabel;
    heroAmount.textContent = model.primaryValue;
    hero.dataset.tone = quotaTone(model.primaryPercent, model.preferences);
    heroDetail.textContent = model.primary ? `${model.primary.name || '未命名套餐'} · ${percentText(model.primaryPercent)} 可用` : '当前没有可用的套餐额度';
    balanceAside.hidden = !model.primary || !model.preferences.showBalance;
    balanceAmount.textContent = model.balance;
    planHeader.hidden = !model.view.snapshot;
    planCount.textContent = String(model.plans.length);
    const cards = model.plans.map((plan, index) => planCard(plan, model, index));
    planList.replaceChildren(...cards);
    planList.hidden = !cards.length;
    empty.hidden = !model.view.authenticated || cards.length > 0;
    empty.replaceChildren(el('h2', '', model.view.snapshot ? '暂无套餐' : '还没有额度数据'), el('p', 'muted', model.view.snapshot ? '账户余额已显示在上方。' : model.view.error ? '请检查本机凭证和网络，然后重试。' : '点击刷新，查询套餐额度和账户余额。'));
    setupUsage.hidden = model.view.authenticated;
    setupSettings.querySelector('h2').textContent = model.view.authenticated ? '本机凭证 · 已配置' : model.view.error?.code === 'NO_JWT' ? '本机凭证 · 未配置' : '本机凭证 · 待验证';
    for (const [name, input] of Object.entries(inputs)) {
      if (dirtyFields.has(name)) continue;
      if (input.type === 'checkbox') input.checked = model.preferences[name];
      else input.value = String(model.preferences[name]);
    }
    save.disabled = !state.connected || busy || dirtyFields.size === 0;
    reload.disabled = !state.connected || busy;
    save.textContent = state.pending === 'krill.updateSettings' ? '保存中…' : '保存设置';
    footerText.textContent = doc.visibilityState === 'hidden' ? '自动刷新已暂停' : `每 ${model.preferences.refreshIntervalMinutes} 分钟刷新 · 仅面板可见时`;
    lastSuccess.textContent = `上次成功同步：${fresh.timestamp}`;
    schedule();
  }

  function planCard(plan, model, index) {
    const card = el('article', 'plan-card');
    const percent = remainingPercent(plan.remaining, plan.limit);
    const tone = plan.status === 'active' ? quotaTone(percent, model.preferences) : 'muted';
    card.dataset.tone = tone;
    const top = el('div', 'plan-topline');
    const type = el('span', 'plan-type', planTypeText(plan.type));
    const statusBadge = el('span', 'status-badge', statusText(plan.status));
    top.append(type, statusBadge);
    const title = el('h3', 'plan-title', typeof plan.name === 'string' && plan.name ? plan.name : `套餐 ${index + 1}`);
    const amountRow = el('div', 'plan-amount-row');
    amountRow.append(el('strong', 'plan-amount', money(plan.remaining)), el('span', 'muted tiny', `剩余 / ${money(plan.limit)}`));
    const meter = el('div', 'quota-meter');
    if (percent !== null) {
      meter.setAttribute('role', 'meter');
      meter.setAttribute('aria-label', `${title.textContent}剩余额度`);
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      meter.setAttribute('aria-valuenow', String(percent));
      meter.setAttribute('aria-valuetext', `${percentText(percent)} 可用`);
      const fill = el('span', 'quota-fill');
      fill.style.width = `${percent}%`;
      meter.append(fill);
    } else {
      meter.classList.add('unknown-meter');
      meter.setAttribute('aria-label', '额度比例未知');
    }
    const ratio = el('p', 'quota-caption', percent === null ? '额度比例未知' : `${percentText(percent)} 可用${tone === 'critical' ? ' · 额度紧张' : tone === 'warning' ? ' · 额度较低' : ''}`);
    const dates = el('dl', 'plan-dates');
    for (const [label, value] of [['额度重置', plan.resetAt], ['套餐到期', plan.endAt]]) {
      const row = el('div');
      const date = el('dd', '', dateText(value));
      date.title = `${label}：${value ?? '未知'}（${countdown(value)}）`;
      row.append(el('dt', '', label), date);
      dates.append(row);
    }
    card.append(top, title, amountRow, meter, ratio, dates);
    return card;
  }

  function clearRefreshTimer() {
    if (refreshTimer !== null) win.clearTimeout(refreshTimer);
    refreshTimer = null;
    armedRefreshDeadline = null;
  }

  function clearTimers() {
    clearRefreshTimer();
    if (tickTimer !== null) win.clearTimeout(tickTimer);
    tickTimer = null;
  }

  function schedule() {
    const interval = controller.state.payload.preferences.refreshIntervalMinutes * 60_000;
    if (interval !== refreshInterval) {
      refreshInterval = interval;
      refreshDeadline = lastQuotaAttemptAt + interval;
    }
    if (disposed || suspended || doc.visibilityState === 'hidden' || !controller.state.connected) {
      clearTimers();
      return;
    }
    if (tickTimer === null) tickTimer = win.setTimeout(() => {
      tickTimer = null;
      render();
    }, 60_000);
    if (controller.state.pending || !controller.state.payload.view.authenticated) {
      clearRefreshTimer();
      return;
    }
    // Preserve a live timer for this absolute deadline, even if a display tick
    // runs at the same instant. Pausing requests keeps the deadline for catch-up.
    if (refreshTimer !== null && armedRefreshDeadline === refreshDeadline) return;
    clearRefreshTimer();
    armedRefreshDeadline = refreshDeadline;
    refreshTimer = win.setTimeout(() => {
      refreshTimer = null;
      armedRefreshDeadline = null;
      void request('krill.refresh');
    }, Math.max(1000, refreshDeadline - Date.now()));
  }

  async function request(name, args) {
    if (controller.state.pending || disposed) return false;
    return controller.request(name, args);
  }

  refresh.addEventListener('click', () => void request('krill.refresh'));
  usageNav.addEventListener('click', () => controller.navigate('usage'));
  settingsNav.addEventListener('click', () => controller.navigate('settings'));
  // Keep raw edits per field. Unedited controls can follow newer accepted
  // preferences without silently becoming part of a stale panel's next save.
  function clearUnchangedEdits(submitted) {
    for (const [name, version] of submitted) {
      if (dirtyFields.get(name) === version) dirtyFields.delete(name);
    }
  }
  form.addEventListener('input', (event) => {
    const name = event.target?.id;
    if (!Object.hasOwn(inputs, name) || inputs[name] !== event.target) return;
    dirtyFields.set(name, ++settingsEditVersion);
    formStatus.textContent = '尚未保存';
    save.disabled = !controller.state.connected || Boolean(controller.state.pending);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (controller.state.pending || disposed || dirtyFields.size === 0) return;
    const submitted = new Map(dirtyFields);
    const values = Object.fromEntries([...submitted.keys()].map(name => {
      const input = inputs[name];
      return [name, input.type === 'checkbox' ? input.checked : input.value];
    }));
    const result = validatePreferences(values);
    if (result.error) { formStatus.textContent = result.error; return; }
    const requestVersion = ++settingsRequestVersion;
    const saved = await request('krill.updateSettings', { set: result.set });
    // An aborted request may settle after a newer save/reload has completed.
    if (disposed || requestVersion !== settingsRequestVersion) return;
    if (saved) {
      clearUnchangedEdits(submitted);
      formStatus.textContent = dirtyFields.size ? '已保存；还有新的修改待保存。' : '设置已保存';
      render();
    } else formStatus.textContent = controller.state.notice || '保存结果尚未确认，请重新加载后检查。';
  });
  reload.addEventListener('click', async () => {
    if (controller.state.pending || disposed) return;
    const previousEdits = new Map(dirtyFields);
    const requestVersion = ++settingsRequestVersion;
    const loaded = await request('krill.read');
    if (disposed || requestVersion !== settingsRequestVersion) return;
    if (loaded) {
      clearUnchangedEdits(previousEdits);
      formStatus.textContent = dirtyFields.size ? '保留了刚刚输入的修改。' : '已重新加载本机设置';
      render();
    }
  });

  function visibilityChanged() {
    clearTimers();
    if (doc.visibilityState === 'hidden') {
      // Cancel app requests on hide. The local service may finish its bounded GET.
      controller.abort();
      return;
    }
    render();
    if (controller.state.connected) void request('krill.read');
  }
  doc.addEventListener('visibilitychange', visibilityChanged);
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimers();
    controller.dispose();
    doc.removeEventListener('visibilitychange', visibilityChanged);
    win.removeEventListener('pagehide', pagehide);
    win.removeEventListener('unload', dispose);
    win.removeEventListener('pageshow', pageshow);
    app.ontoolresult = undefined;
    app.onhostcontextchanged = undefined;
  }
  function pagehide(event) {
    if (event.persisted) { suspended = true; clearTimers(); controller.abort(); }
    else dispose();
  }
  function pageshow(event) { if (event.persisted && !disposed) { suspended = false; visibilityChanged(); } }
  win.addEventListener('pagehide', pagehide);
  win.addEventListener('unload', dispose);
  win.addEventListener('pageshow', pageshow);
  app.ontoolresult = (result) => controller.receive(result, { entry: true });
  const applyTheme = (context = {}) => {
    if (context.theme === 'light' || context.theme === 'dark') doc.documentElement.dataset.theme = context.theme;
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables, doc.documentElement);
  };
  app.onhostcontextchanged = applyTheme;
  app.onteardown = async () => { dispose(); return {}; };
  render();
  const connected = app.connect().then(async () => {
    if (disposed) return;
    applyTheme(app.getHostContext?.());
    controller.connect();
    await request('krill.read');
  }).catch(() => {
    if (!disposed) controller.notify('无法连接宿主。请关闭后重新打开 Krill 面板。');
  });
  return { controller, connected, dispose, render };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const root = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
  root.id = 'app';
  // A component fixture may mount an explicit bridge instead of connecting to a host.
  if (!root.hasAttribute('data-manual-mount')) mountKrillApp({ app: new App({ name: 'Krill Usage', version: '0.1.0' }, {}, { autoResize: true }), root });
}
