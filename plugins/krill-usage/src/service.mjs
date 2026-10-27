import { fetchSubscriptionWithRetry, loginWithPassword } from './api.cjs';
import { randomUUID } from 'node:crypto';

const messages = {
  NO_JWT: '尚未设置凭据，请启动本机账户设置，在 Windows 原生窗口中输入凭据。',
  UNAUTHORIZED: '凭据无效或已过期，请重新登录或设置 JWT。',
  LOGIN_FAILED: '自动登录失败，请重新登录。', INTERACTIVE_LOGIN: '账户需要额外验证，请在浏览器中完成登录并重新设置 JWT。',
  INVALID_LOGIN_RESPONSE: '登录响应无效，请重新登录。', INVALID_CREDENTIALS: '登录信息无效，请重新登录。',
  CREDENTIAL_CHANGED: '账户凭据已变更，请刷新后重试。',
  CF_CHALLENGE: 'Krill 要求 Cloudflare 验证，请在浏览器中检查账户。',
  RATE_LIMIT: 'Krill 请求被限流，请在冷却时间结束后刷新。',
  LOGIN_COOLDOWN: '登录服务暂时不可用，短暂冷却后可重新尝试。',
  HTTP: 'Krill 请求失败，请稍后重试。', INVALID_JSON: 'Krill 返回了无法解析的数据。',
  INVALID_RESPONSE: 'Krill API 返回结构无法识别。', NETWORK: '网络连接失败，请重试。',
  TIMEOUT: '请求超时，请重试。', TOO_LARGE: 'Krill 响应超出大小限制。',
  SECRET_STORAGE: '无法安全读取系统凭据库。请检查本地账户设置。',
  ERROR: '额度查询失败，请重试。'
};
export class UsageService {
  constructor({credentials, preferences, fetchUsage = fetchSubscriptionWithRetry, login = loginWithPassword, now = Date.now}) {
    this.credentials = credentials; this.preferences = preferences; this.fetchUsage = fetchUsage; this.login = login; this.now = now;
    this.instanceId = randomUUID();
    this.generation = 0; this.stateRevision = 0; this.snapshotRevision = 0;
    this.active = null; this.disposed = false; this.revision = undefined;
    this.renewalAttemptRevision = undefined;
    this.cooldownUntil = 0;
    this.loginRetryAfter = 0;
    this.reset();
    this.subscription = credentials.onDidChange?.(() => { void this.read(); });
  }
  // Order account resets independently of request ownership or success timestamps.
  reset() {
    this.stateRevision++; this.snapshot = null; this.error = null; this.lastSuccessAt = 0;
    this.authenticated = false; this.cooldownUntil = 0; this.loginRetryAfter = 0;
  }
  invalidate() { this.generation++; this.active = null; this.revision = undefined; this.reset(); }
  safeError(error, phase = 'quota', startedAt = this.now()) {
    const code = Object.hasOwn(messages, error?.code) ? error.code : 'ERROR';
    const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
      ? error.status : null;
    const networkCode = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
      'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(error?.networkCode)
      ? error.networkCode : null;
    const attempts = Number.isInteger(error?.attempts) && error.attempts >= 1 && error.attempts <= 2
      ? error.attempts : 1;
    const retryAfterMs = Number.isFinite(error?.retryAfterMs)
      ? Math.max(0, Math.min(300000, error.retryAfterMs)) : null;
    return {code, message: messages[code], diagnostic: {
      phase: ['quota', 'login', 'storage'].includes(phase) ? phase : 'quota',
      status, networkCode, attempts, elapsedMs: Math.max(0, Math.min(120000, this.now() - startedAt)),
      at: this.now(), retryAfterMs
    }};
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
    const startedAt = this.now();
    let phase = 'storage';
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
      if (this.cooldownUntil > this.now()) {
        this.error = this.safeError({code:'RATE_LIMIT',status:429,
          retryAfterMs:this.cooldownUntil - this.now()}, 'quota', startedAt);
        return this.view();
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
      phase = 'quota';
      if (!session?.jwt) { this.reset(); this.error = this.safeError({code:'NO_JWT'}); }
      else {
        let snapshot;
        try { snapshot = await this.fetchUsage(session.jwt); }
        catch (error) {
          if (!owns() || !await current() || !owns()) return this.view();
          if (error?.code !== 'UNAUTHORIZED' || !session.account || !session.password ||
              !this.credentials.replaceSession || this.renewalAttemptRevision === revision) throw error;
          // One password POST per explicit recovery; transient login transport failures
          // are eligible for a later attempt, but never an immediate password loop.
          if (this.loginRetryAfter > this.now()) {
            throw Object.assign(new Error('LOGIN_COOLDOWN'), {code:'LOGIN_COOLDOWN',
              retryAfterMs:this.loginRetryAfter - this.now()});
          }
          this.renewalAttemptRevision = revision;
          phase = 'login';
          let jwt;
          try { jwt = await this.login(session.account, session.password); }
          catch (loginError) {
            if (owns() && ['NETWORK', 'TIMEOUT', 'HTTP', 'RATE_LIMIT', 'CF_CHALLENGE'].includes(loginError?.code)) {
              this.renewalAttemptRevision = undefined;
              this.loginRetryAfter = this.now() + Math.max(15000,
                Math.min(300000, loginError?.retryAfterMs ?? 15000));
            }
            throw loginError;
          }
          phase = 'storage';
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
          phase = 'quota';
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
        this.cooldownUntil = 0; this.loginRetryAfter = 0;
      }
    } catch (error) {
      if (owns()) {
        // Even a late failure must not retain the previous account's data.
        try {
          if (revision !== undefined && (!await current() || !owns())) return this.view();
        } catch { if (owns()) { this.reset(); error = {code:'SECRET_STORAGE'}; } }
        if (owns()) {
          if (error?.code === 'SECRET_STORAGE') this.reset();
          if (error?.code === 'RATE_LIMIT') {
            this.cooldownUntil = Math.max(this.cooldownUntil,
              this.now() + Math.max(1000, Math.min(300000, error?.retryAfterMs ?? 60000)));
          }
          this.error = this.safeError(error, phase, startedAt);
        }
      }
    } finally { if (owns()) this.active = null; }
    return this.view();
  }
  dispose() { this.disposed = true; this.invalidate(); this.subscription?.dispose?.(); this.credentials.dispose?.(); }
}
