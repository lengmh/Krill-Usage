import { fetchSubscription } from './api.cjs';
import { randomUUID } from 'node:crypto';

const messages = {
  NO_JWT: '尚未设置凭据，请启动本机账户设置，在 Windows 原生窗口中输入凭据。',
  UNAUTHORIZED: '凭据无效或已过期，请重新设置。',
  CF_CHALLENGE: 'Krill 要求 Cloudflare 验证，请在浏览器中检查账户。',
  HTTP: 'Krill 请求失败，请稍后重试。', INVALID_JSON: 'Krill 返回了无法解析的数据。',
  INVALID_RESPONSE: 'Krill API 返回结构无法识别。', NETWORK: '网络连接失败，请重试。',
  TIMEOUT: '请求超时，请重试。', TOO_LARGE: 'Krill 响应超出大小限制。',
  SECRET_STORAGE: '无法安全读取系统凭据库。请检查本地账户设置。',
  ERROR: '额度查询失败，请重试。'
};
export class UsageService {
  constructor({credentials, preferences, fetchUsage = fetchSubscription, now = Date.now}) {
    this.credentials = credentials; this.preferences = preferences; this.fetchUsage = fetchUsage; this.now = now;
    this.instanceId = randomUUID();
    this.generation = 0; this.stateRevision = 0; this.snapshotRevision = 0;
    this.active = null; this.disposed = false; this.revision = undefined;
    this.reset();
    this.subscription = credentials.onDidChange?.(() => this.invalidate());
  }
  // Order account resets independently of request ownership or success timestamps.
  reset() { this.stateRevision++; this.snapshot = null; this.error = null; this.lastSuccessAt = 0; this.authenticated = false; }
  invalidate() { this.generation++; this.active = null; this.revision = undefined; this.reset(); }
  safeError(error) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'ERROR';
    return {code, message: messages[code]};
  }
  view() {
    const refreshMinutes = this.preferences.read().refreshIntervalMinutes;
    // Stamp the capture here, before an async caller can delay delivery. Reads,
    // loading states and failures need ordering even without a new success time.
    return { instanceId: this.instanceId, snapshot: this.snapshot, error: this.error, refreshing: Boolean(this.active),
      snapshotRevision: ++this.snapshotRevision,
      lastSuccessAt: this.lastSuccessAt, stateRevision: this.stateRevision, authenticated: this.authenticated, refreshMinutes,
      stale: Boolean(this.snapshot && (this.error || this.now() - this.lastSuccessAt >= refreshMinutes * 60000)) };
  }
  async read() {
    if (this.disposed) return this.view();
    const generation = this.generation;
    try {
      const revision = await this.credentials.readRevision();
      if (generation !== this.generation) return this.view();
      if (revision !== this.revision) {
        // Learning the first marker is not an account change. A refresh may
        // already own this generation while both initial reads are pending.
        if (this.revision !== undefined) this.invalidate();
        this.revision = revision;
      }
    } catch {
      if (generation === this.generation) { this.invalidate(); this.error = this.safeError({code:'SECRET_STORAGE'}); }
    }
    return this.view();
  }
  refresh() {
    if (this.disposed) return Promise.resolve(this.view());
    if (this.active) return this.active.promise;
    const operation = {generation:this.generation, promise:null};
    this.active = operation;
    operation.promise = this.run(operation);
    return operation.promise;
  }
  async run(operation) {
    const owns = () => !this.disposed && this.active === operation && operation.generation === this.generation;
    let revision;
    try {
      revision = await this.credentials.readRevision();
      if (!owns()) return this.view();
      if (revision !== this.revision) {
        this.reset(); this.revision = revision; operation.generation = ++this.generation;
      }
      const jwt = await this.credentials.read();
      if (!owns()) return this.view();
      if (await this.credentials.readRevision() !== revision) { this.invalidate(); return this.view(); }
      if (!owns()) return this.view();
      this.authenticated = Boolean(jwt);
      if (!jwt) { this.reset(); this.error = this.safeError({code:'NO_JWT'}); }
      else {
        const snapshot = await this.fetchUsage(jwt);
        if (!owns()) return this.view();
        if (await this.credentials.readRevision() !== revision) { this.invalidate(); return this.view(); }
        if (!owns()) return this.view();
        this.snapshot = snapshot; this.error = null; this.lastSuccessAt = this.now();
      }
    } catch (error) {
      if (owns()) {
        // Even a late failure must not retain the previous account's data.
        try {
          if (revision !== undefined && await this.credentials.readRevision() !== revision) {
            this.invalidate(); return this.view();
          }
        } catch { this.reset(); error = {code:'SECRET_STORAGE'}; }
        if (owns()) {
          if (error?.code === 'SECRET_STORAGE') this.reset();
          this.error = this.safeError(error);
        }
      }
    } finally { if (owns()) this.active = null; }
    return this.view();
  }
  dispose() { this.disposed = true; this.invalidate(); this.subscription?.dispose?.(); }
}
