/** Synthetic component preview only. No network, credentials, or MCP host. */
import { mountKrillApp } from '../../src/app.mjs';
const initialTime = Date.now();
let preferences = { refreshIntervalMinutes: 3, showBalance: true, lowQuotaWarningPercent: 15, lowQuotaCriticalPercent: 5 };
let preferencesRevision = 0;
const sample = {
  creditBalance: '23.95',
  subscriptions: [
    { id: 'demo-1', name: 'Krill Pro 月卡', type: 'monthly', status: 'active', remaining: '78.40', limit: '120', resetAt: new Date(initialTime + 5 * 3600000).toISOString(), endAt: new Date(initialTime + 28 * 86400000).toISOString() },
    { id: 'demo-2', name: '加量周卡', type: 'weekly', status: 'active', remaining: '4.25', limit: '40', resetAt: new Date(initialTime + 5 * 3600000).toISOString(), endAt: new Date(initialTime + 4 * 86400000).toISOString() },
    { id: 'demo-3', name: '体验天卡', type: 'daily', status: 'expired', remaining: '0', limit: '10', resetAt: null, endAt: new Date(initialTime - 86400000).toISOString() }
  ]
};
let view = { snapshot: sample, authenticated: true, refreshing: false, stale: false, error: null, lastSuccessAt: initialTime, refreshMinutes: 3 };
const query = new URLSearchParams(location.search);
const initialPage = query.get('page') === 'settings' ? 'settings' : 'usage';
const theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const calls = [];
const response = () => ({ content: [], structuredContent: { page: initialPage, view: structuredClone(view), preferences: { ...preferences }, preferencesRevision } });
const app = {
  connect: async () => {},
  getHostContext: () => ({ theme }),
  async callServerTool(params, { signal } = {}) {
    calls.push({ name: params.name, time: Date.now() });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (params.name === 'krill.updateSettings') {
      preferences = { ...preferences, ...params.arguments.set };
      preferencesRevision++;
      view.refreshMinutes = preferences.refreshIntervalMinutes;
    }
    if (params.name === 'krill.refresh') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 450);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
      view = { ...view, error: null, stale: false, authenticated: true, snapshot: sample, lastSuccessAt: Date.now() };
    }
    return response();
  }
};
const mounted = mountKrillApp({ app, root: document.getElementById('app') });
await mounted.connected;
app.ontoolresult(response());
// Explicit preview controls only: production bundles never import this fixture.
window.krillPreview = {
  calls, mounted,
  setTheme(value) { app.onhostcontextchanged({ theme: value }); },
  setState(value) { view = { ...view, ...value }; mounted.controller.receive(response()); },
  showPage(value) { mounted.controller.navigate(value); }
};
