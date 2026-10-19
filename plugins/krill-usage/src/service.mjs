import { fetchSubscription, loginWithPassword } from './api.cjs';
import { randomUUID } from 'node:crypto';

const messages = {
  NO_JWT: '尚未设置凭据，请启动本机账户设置，在 Windows 原生窗口中输入凭据。',
  UNAUTHORIZED: '凭据无效或已过期，请重新登录或设置 JWT。',
  LOGIN_FAILED: '自动登录失败，请重新登录。', INTERACTIVE_LOGIN: '账户需要额外验证，请在浏览器中完成登录并重新设置 JWT。',
  INVALID_LOGIN_RESPONSE: '登录响应无效，请重新登录。', INVALID_CREDENTIALS: '登录信息无效，请重新登录。',
  CREDENTIAL_CHANGED: '账户凭据已变更，请刷新后重试。',
  CF_CHALLENGE: 'Krill 要求 Cloudflare 验证，请在浏览器中检查账户。',
  HTTP: 'Krill 请求失败，请稍后重试。', INVALID_JSON: 'Krill 返回了无法解析的数据。',
  INVALID_RESPONSE: 'Krill API 返回结构无法识别。', NETWORK: '网络连接失败，请重试。',
  TIMEOUT: '请求超时，请重试。', TOO_LARGE: 'Krill 响应超出大小限制。',
  SECRET_STORAGE: '无法安全读取系统凭据库。请检查本地账户设置。',
  ERROR: '额度查询失败，请重试。'
};
export class UsageService {
  constructor({credentials, preferences, fetchUsage = fetchSubscription, login = loginWithPassword, now = Date.now}) {
    this.credentials = credentials; this.preferences = preferences; this.fetchUsage = fetchUsage; this.login = login; this.now = now;
    this.instanceId = randomUUID();
    this.generation = 0; this.stateRevision = 0; this.snapshotRevision = 0;
    this.active = null; this.disposed = false; this.revision = undefined;
    this.renewalAttemptRevision = undefined;
    this.reset();
    this.subscription = credentials.onDidChange?.(() => { void this.read(); });
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
    if (this.disposed || this.active?.renewing) return this.view();
    const generation = this.generation;
    try {
      const revision = await this.credentials.readRevision();
      if (generation !== this.generation || this.active?.renewing) return this.view();
      if (revision !== this.revision) {
        // Learning the first marker is not an account change. A refresh may
        // already own this generation while both initial reads are pending.
        if (this.revision !== undefined) this.invalidate();
        this.revision = revision;
      }
    } catch {
      if (generation === this.generation && !this.active?.renewing) { this.invalidate(); this.error = this.safeError({code:'SECRET_STORAGE'}); }
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
    const current = async () => {
      const actual = await this.credentials.readRevision();
      // Never let an old completion invalidate a newer operation.
      if (!owns()) return false;
      if (actual !== revision) { this.invalidate(); return false; }
      return true;
    };
    try {
      revision = await this.credentials.readRevision();
      if (!owns()) return this.view();
      if (revision !== this.revision) {
        this.reset(); this.revision = revision; operation.generation = ++this.generation;
      }
      const session = this.credentials.readSession
        ? await this.credentials.readSession()
        : { jwt: await this.credentials.read() };
      if (!owns() || !await current() || !owns()) return this.view();
      if (session?.account && session.password === undefined && this.credentials.migrateJwtOnly) {
        // Only refresh can clean legacy account-only records. Suppress own
        // marker notifications exactly as for a remembered-session renewal.
        operation.renewing = true;
        try {
          revision = await this.credentials.migrateJwtOnly({ expectedRevision: revision, isCurrent: owns });
          if (!owns()) return this.view();
          this.revision = revision;
        } finally { operation.renewing = false; }
        if (!owns() || !await current() || !owns()) return this.view();
      }
      this.authenticated = Boolean(session?.jwt);
      if (!session?.jwt) { this.reset(); this.error = this.safeError({code:'NO_JWT'}); }
      else {
        let snapshot;
        try { snapshot = await this.fetchUsage(session.jwt); }
        catch (error) {
          if (!owns() || !await current() || !owns()) return this.view();
          if (error?.code !== 'UNAUTHORIZED' || !session.account || !session.password ||
              !this.credentials.replaceSession || this.renewalAttemptRevision === revision) throw error;
          // One recovery and one quota retry per explicit refresh, never a loop.
          this.renewalAttemptRevision = revision;
          const jwt = await this.login(session.account, session.password);
          if (!owns() || !await current() || !owns()) return this.view();
          // Own writes briefly expose a "changing" marker. Watchers and read()
          // defer during this window; the returned committed revision is checked
          // before using the new JWT, including concurrent clear/account switches.
          operation.renewing = true;
          try {
            revision = await this.credentials.replaceSession({
              jwt, account: session.account, password: session.password
            }, { expectedRevision: revision });
            if (!owns()) return this.view();
            this.revision = revision;
          } finally { operation.renewing = false; }
          if (!owns() || !await current() || !owns()) return this.view();
          try { snapshot = await this.fetchUsage(jwt); }
          catch (retryError) {
            // Panel refreshes must not repeatedly POST a saved password after a
            // failed recovery. A new owner-written revision enables it again.
            if (owns()) this.renewalAttemptRevision = revision;
            throw retryError;
          }
        }
        if (!owns() || !await current() || !owns()) return this.view();
        this.snapshot = snapshot; this.error = null; this.lastSuccessAt = this.now();
      }
    } catch (error) {
      if (owns()) {
        // Even a late failure must not retain the previous account's data.
        try {
          if (revision !== undefined && (!await current() || !owns())) return this.view();
        } catch { if (owns()) { this.reset(); error = {code:'SECRET_STORAGE'}; } }
        if (owns()) {
          if (error?.code === 'SECRET_STORAGE') this.reset();
          this.error = this.safeError(error);
        }
      }
    } finally { if (owns()) this.active = null; }
    return this.view();
  }
  dispose() { this.disposed = true; this.invalidate(); this.subscription?.dispose?.(); this.credentials.dispose?.(); }
}
