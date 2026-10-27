"use strict";

const vscode = require("vscode");
const { fetchSubscription, loginWithPassword, KrillApiError } = require("./api");
const { withRecoveryLock } = require("./recoveryLock");
const {
  SECRET_KEY, AUTH_SECRET_KEY, EMAIL_SECRET_KEY, PASSWORD_SECRET_KEY,
  DEFAULT_REFRESH_MINUTES, UI_TICK_MS
} = require("./constants");
const { sanitizeJwt } = require("./jwt");

const ERROR_CODES = new Set([
  "NETWORK", "TIMEOUT", "HTTP", "RATE_LIMIT", "UNAUTHORIZED", "LOGIN_FAILED",
  "INTERACTIVE_LOGIN", "CF_CHALLENGE", "INVALID_JSON", "INVALID_RESPONSE",
  "INVALID_LOGIN_RESPONSE", "INVALID_CREDENTIALS", "SECRET_STORAGE", "NO_JWT",
  "RECOVERY_BUSY", "TOO_LARGE", "UNTRUSTED_ENDPOINT", "AUTO_LOGIN_PAUSED"
]);
const NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EPROTO",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"
]);
const MESSAGES = {
  NETWORK: "网络连接失败", TIMEOUT: "请求超时", HTTP: "Krill 服务异常",
  RATE_LIMIT: "Krill 请求频率受限", UNAUTHORIZED: "JWT 已失效，请重新登录 Krill",
  LOGIN_FAILED: "Krill 登录失败，请检查账号密码或验证要求",
  INTERACTIVE_LOGIN: "Krill 需要人工身份验证，请通过官网登录",
  CF_CHALLENGE: "Krill 要求 Cloudflare 验证，请先在浏览器处理",
  INVALID_JSON: "Krill 返回非 JSON 数据", INVALID_RESPONSE: "Krill API 返回结构无法识别",
  INVALID_LOGIN_RESPONSE: "登录响应未提供有效 JWT", INVALID_CREDENTIALS: "账号或密码格式不正确",
  SECRET_STORAGE: "本地凭据保存或清理失败", NO_JWT: "尚未登录 Krill",
  RECOVERY_BUSY: "另一窗口正在恢复登录，请稍后重试", TOO_LARGE: "响应过大",
  UNTRUSTED_ENDPOINT: "不支持的网络地址", AUTO_LOGIN_PAUSED: "账号验证失败，自动重登已暂停，请手动登录"
};
function safeFailure(error, { source = "auto", elapsedMs = 0, attempts = 1 } = {}) {
  const code = ERROR_CODES.has(error?.code) ? error.code : "ERROR";
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
    ? error.status : null;
  const phase = ["login", "subscription", "storage", "recovery"].includes(error?.phase)
    ? error.phase : "subscription";
  const networkCode = NETWORK_CODES.has(error?.networkCode) ? error.networkCode : null;
  const retryAfterMs = Number.isFinite(error?.retryAfterMs)
    ? Math.max(0, Math.min(60 * 60_000, error.retryAfterMs)) : null;
  return { code, message: MESSAGES[code] ?? "刷新失败", status, phase, networkCode,
    retryAfterMs, source: ["auto", "focus", "manual", "startup", "set-jwt", "login", "external"].includes(source) ? source : "auto",
    attempts: Math.max(1, Math.min(2, Number(error?.attempts ?? attempts) || 1)),
    elapsedMs: Math.max(0, Math.floor(elapsedMs)), at: Date.now() };
}
function isRetryableGet(error) {
  return error?.code === "NETWORK" || error?.code === "TIMEOUT" ||
    (error?.code === "HTTP" && [500, 502, 503, 504].includes(error.status) &&
      !(Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0));
}
function manualInterventionRequired(error) {
  return ["LOGIN_FAILED", "INTERACTIVE_LOGIN", "INVALID_LOGIN_RESPONSE", "INVALID_CREDENTIALS"].includes(error?.code);
}

class KrillUsageService {
  constructor(context) {
    this.context = context;
    this.snapshot = null;
    this.error = null;
    this.refreshing = false;
    this.lastSuccessAt = 0;
    this.lastAttemptAt = 0;
    this.nextAllowedAt = 0;
    this.rateLimitCooldown = false;
    this.failureStreak = 0;
    this.listeners = new Set();
    this.apiTimer = null;
    this.uiTimer = null;
    this.disposed = false;
    this.generation = 0;
    this.activeRefresh = null;
    this.activeLogin = null;
    this.credentialWrites = Promise.resolve();
    this._hasJwt = false;
    this.autoLoginBlocked = false;
    this.observedAuth = null;
    this.secretEpoch = 0;
    this.output = typeof vscode.window?.createOutputChannel === "function"
      ? vscode.window.createOutputChannel("Krill Usage") : null;
    this.secretSubscription = context.secrets.onDidChange?.((event) => {
      if (event?.key === AUTH_SECRET_KEY || (this.observedAuth === null && event?.key === SECRET_KEY)) {
        void this.reconcileSharedCredentials(++this.secretEpoch);
      }
    });
  }

  logEvent(phase, source, status, details = {}) {
    // All fields are allowlisted by safeFailure; never log the exception itself.
    if (!this.output) return;
    const parts = [new Date().toISOString(), String(phase).replace(/[^a-z-]/g, ""),
      String(source).replace(/[^a-z-]/g, ""), String(status).replace(/[^a-z-]/g, "")];
    for (const [key, value] of Object.entries(details)) {
      if (["code", "http", "network", "attempts", "durationMs", "cached"].includes(key) && value != null &&
          /^(?:[A-Za-z_\-0-9]+|true|false)$/.test(String(value))) parts.push(`${key}=${value}`);
    }
    this.output.appendLine(parts.join(" "));
  }

  async initialize() {
    // A SecretStorage cleanup failure must not silently disable the timers.
    this.startTimers();
    if (!this.rememberPassword()) {
      await this.onRememberPasswordChanged();
      if (this.error?.code === "SECRET_STORAGE") return;
    }
    await this.refresh("startup", { silent: true });
  }

  getView() {
    return { snapshot: this.snapshot, error: this.error, refreshing: this.refreshing,
      lastSuccessAt: this.lastSuccessAt, nextAllowedAt: this.nextAllowedAt,
      authenticated: Boolean(this._hasJwt), refreshMinutes: this.getRefreshMinutes() };
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    listener(this.getView());
    return { dispose: () => this.listeners.delete(listener) };
  }
  emit() {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try { listener(this.getView()); } catch { /* UI failures must not interrupt a refresh */ }
    }
  }

  async readAuth() {
    const raw = await this.context.secrets.get(AUTH_SECRET_KEY);
    if (raw !== undefined && raw !== null) {
      let auth;
      try { auth = JSON.parse(raw); } catch { throw new KrillApiError("SECRET_STORAGE", "凭据读取失败"); }
      if (auth?.version !== 1 || !(auth.jwt === null || typeof auth.jwt === "string")) {
        throw new KrillApiError("SECRET_STORAGE", "凭据格式无法识别");
      }
      return auth;
    }
    // Migrate older JWT-only installs without mixing independently stored identities.
    return { version: 1, jwt: await this.context.secrets.get(SECRET_KEY) ?? null };
  }

  async writeAuth(auth) {
    const record = JSON.stringify(auth);
    await this.context.secrets.store(AUTH_SECRET_KEY, record);
    this.observedAuth = record;
    // A null JWT is a tombstone; failing to delete legacy keys must not revive it.
    const results = await Promise.allSettled([
      this.context.secrets.delete(SECRET_KEY),
      this.context.secrets.delete(EMAIL_SECRET_KEY),
      this.context.secrets.delete(PASSWORD_SECRET_KEY)
    ]);
    if (results.some(result => result.status === "rejected")) {
      const error = new KrillApiError("SECRET_STORAGE", "旧版凭据清理失败", null, { phase: "storage" });
      throw error;
    }
  }

  async getJwt(generation = this.generation) {
    const auth = await this.readAuth();
    if (this.disposed || generation !== this.generation) return null;
    const record = JSON.stringify(auth);
    if (this.observedAuth !== null && this.observedAuth !== record) {
      this.snapshot = null;
      this.lastSuccessAt = 0;
      this.autoLoginBlocked = false;
      this.resetCooldown();
    }
    this.observedAuth = record;
    this._hasJwt = Boolean(auth.jwt);
    return auth.jwt ?? null;
  }

  rememberPassword() {
    return vscode.workspace.getConfiguration("krillUsage").get("rememberPassword", true) === true;
  }
  async readLoginCredentials(generation = this.generation) {
    if (!this.rememberPassword()) return null;
    const auth = await this.readAuth();
    if (this.disposed || generation !== this.generation || !this.rememberPassword()) return null;
    return typeof auth.email === "string" && auth.email && typeof auth.password === "string" && auth.password
      ? { email: auth.email, password: auth.password, expectedRecord: JSON.stringify(auth) } : null;
  }

  async setJwt(rawJwt) {
    const jwt = sanitizeJwt(rawJwt);
    if (!jwt || jwt.length > 16_384 || /\s/.test(jwt)) throw new Error("EMPTY_JWT");
    const generation = this.generation + 1;
    if (!await this.changeCredentials(jwt, null)) return null;
    if (this.disposed || generation !== this.generation) return null;
    return this.refresh("set-jwt");
  }
  async clearJwt() { return this.clearCredentials(); }
  async clearCredentials() { return this.changeCredentials(null, null); }

  queueSecretWrite(action) {
    const write = this.credentialWrites.catch(() => {}).then(action);
    this.credentialWrites = write.catch(() => {});
    return write;
  }
  invalidateInFlight() {
    const generation = ++this.generation;
    this.activeRefresh = null;
    this.activeLogin = null;
    this.refreshing = false;
    return generation;
  }
  resetCooldown() {
    this.lastAttemptAt = 0;
    this.nextAllowedAt = 0;
    this.rateLimitCooldown = false;
    this.failureStreak = 0;
  }

  async changeCredentials(jwt, credentials = null) {
    if (this.disposed) return false;
    const generation = this.invalidateInFlight();
    this._hasJwt = false;
    this.snapshot = null;
    this.error = null;
    this.lastSuccessAt = 0;
    this.autoLoginBlocked = false;
    this.resetCooldown();
    this.emit();
    try {
      await this.queueSecretWrite(async () => {
        const auth = { version: 1, jwt };
        if (credentials && this.rememberPassword()) {
          auth.email = credentials.email;
          auth.password = credentials.password;
        }
        await this.writeAuth(auth);
      });
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.error = safeFailure({ code: "SECRET_STORAGE", phase: "storage" }, { source: "manual" });
        this.emit();
      }
      return false;
    }
    if (this.disposed || generation !== this.generation) return false;
    this._hasJwt = Boolean(jwt);
    this.emit();
    return true;
  }

  logIn(email, password) {
    if (this.disposed) return Promise.resolve(null);
    const generation = this.invalidateInFlight();
    const operation = { generation, promise: null };
    this.activeLogin = operation;
    operation.promise = this.runLogIn(operation, email, password);
    return operation.promise;
  }
  async runLogIn(operation, email, password) {
    const start = Date.now();
    this.refreshing = true;
    this.error = null;
    this.emit();
    try {
      const jwt = await loginWithPassword(email, password);
      if (this.disposed || operation.generation !== this.generation) return null;
      // Persist an authenticated JWT before quota GET. Temporary GET failure
      // must not erase a successful sign-in or ask for the password again.
      const credentials = this.rememberPassword() ? { email: email.trim(), password } : null;
      if (!await this.changeCredentials(jwt, credentials)) return null;
      return this.refresh("login", { silent: true });
    } catch (error) {
      if (!this.disposed && operation.generation === this.generation) {
        this.error = safeFailure(error, { source: "login", elapsedMs: Date.now() - start });
        this.logFailure(this.error);
        this.emit();
      }
      return null;
    } finally {
      if (this.activeLogin === operation) this.activeLogin = null;
      if (!this.disposed && operation.generation === this.generation) {
        this.refreshing = false;
        this.emit();
      }
    }
  }

  async onRememberPasswordChanged() {
    if (this.disposed) return;
    if (this.rememberPassword()) { this.emit(); return; }
    const generation = this.invalidateInFlight();
    try {
      await this.queueSecretWrite(async () => {
        const { jwt } = await this.readAuth();
        await this.writeAuth({ version: 1, jwt });
        this._hasJwt = Boolean(jwt);
      });
    } catch {
      if (generation === this.generation && !this.disposed) {
        this.error = safeFailure({ code: "SECRET_STORAGE", phase: "storage" }, { source: "manual" });
        this.logFailure(this.error);
      }
    }
    if (generation === this.generation && !this.disposed) this.emit();
  }

  async reconcileSharedCredentials(epoch) {
    try {
      await this.credentialWrites;
      if (this.disposed || epoch !== this.secretEpoch) return;
      const auth = await this.readAuth();
      if (this.disposed || epoch !== this.secretEpoch) return;
      const record = JSON.stringify(auth);
      if (this.observedAuth === null) { this.observedAuth = record; return; }
      if (record === this.observedAuth) return;
      this.observedAuth = record;
      this.invalidateInFlight();
      this._hasJwt = Boolean(auth.jwt);
      this.snapshot = null;
      this.error = null;
      this.lastSuccessAt = 0;
      this.autoLoginBlocked = false;
      this.resetCooldown();
      this.emit();
      this.logEvent("storage", "external", "changed");
      if (auth.jwt) void this.refresh("external", { silent: true });
    } catch {
      if (!this.disposed) {
        this.error = safeFailure({ code: "SECRET_STORAGE", phase: "storage" });
        this.emit();
      }
    }
  }

  // One retried GET for transport/temporary server faults. Never retry auth,
  // Cloudflare challenges or 429 immediately.
  async fetchWithRetry(jwt, isCurrent = () => true) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!isCurrent()) return null;
      try { return await fetchSubscription(jwt); }
      catch (error) {
        error.attempts = attempt;
        if (attempt >= 2 || !isRetryableGet(error) || !isCurrent()) throw error;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    return null;
  }

  refresh(source = "manual", { silent = false } = {}) {
    if (this.disposed) return Promise.resolve(null);
    if (this.activeLogin) return this.activeLogin.promise;
    if (this.activeRefresh) return this.activeRefresh.promise;
    if (Date.now() < this.nextAllowedAt && source !== "login" && source !== "set-jwt" && source !== "external" &&
        (source !== "manual" || this.rateLimitCooldown)) {
      // A manual refresh may bypass a short network backoff, but never a 429 or
      // server-provided Retry-After. The hover shows the next allowed time.
      this.emit();
      return Promise.resolve(null);
    }
    const operation = { generation: this.generation, promise: null };
    this.activeRefresh = operation;
    operation.promise = this.runRefresh(operation, source, silent);
    return operation.promise;
  }

  async runRefresh(operation, source, silent) {
    const start = Date.now();
    const isCurrent = () => !this.disposed &&
      operation.generation === this.generation && this.activeRefresh === operation;
    this.lastAttemptAt = start;
    this.refreshing = true;
    this.emit();
    try {
      await this.credentialWrites;
      if (!isCurrent()) return null;
      const jwt = await this.getJwt(operation.generation);
      if (!isCurrent()) return null;
      let result;
      if (!jwt) {
        result = await this.recoverLogin(operation, isCurrent, null);
        if (!isCurrent()) return null;
        if (!result) throw new KrillApiError(this.autoLoginBlocked ? "AUTO_LOGIN_PAUSED" : "NO_JWT",
          "无法自动恢复登录", null, { phase: "recovery" });
      } else {
        try {
          result = { snapshot: await this.fetchWithRetry(jwt, isCurrent), jwt };
        } catch (error) {
          if (error?.code !== "UNAUTHORIZED") throw error;
          result = await this.recoverLogin(operation, isCurrent, jwt);
          if (!result && isCurrent()) {
            throw new KrillApiError(this.autoLoginBlocked ? "AUTO_LOGIN_PAUSED" : "UNAUTHORIZED",
              "JWT 已失效", 401, { phase: "recovery" });
          }
        }
      }
      if (!isCurrent() || !result) return null;
      // Verify the shared identity once more: an older GET cannot publish a
      // snapshot after a different VS Code window has cleared/switched accounts.
      const latest = await this.readAuth();
      if (!isCurrent()) return null;
      if (latest.jwt !== result.jwt) {
        const record = JSON.stringify(latest);
        this.observedAuth = record;
        this.invalidateInFlight();
        this.snapshot = null;
        this.lastSuccessAt = 0;
        this._hasJwt = Boolean(latest.jwt);
        this.autoLoginBlocked = false;
        this.resetCooldown();
        this.emit();
        return null;
      }
      this.observedAuth = JSON.stringify(latest);
      this.snapshot = result.snapshot;
      this.lastSuccessAt = Date.now();
      this.error = null;
      this.autoLoginBlocked = false;
      this.resetCooldown();
      this.logEvent("subscription", source, "ok", { durationMs: Date.now() - start, cached: false });
      return result.snapshot;
    } catch (error) {
      if (!isCurrent()) return null;
      this.error = safeFailure(error, { source, elapsedMs: Date.now() - start });
      this.scheduleCooldown(this.error);
      this.error.nextRetryAt = this.nextAllowedAt || null;
      this.logFailure(this.error);
      if (!silent && source === "manual") {
        vscode.window.showErrorMessage(`Krill Usage: ${this.error.message}`);
      }
      return null;
    } finally {
      if (isCurrent()) {
        this.activeRefresh = null;
        this.refreshing = false;
        this.emit();
      }
    }
  }

  async recoverLogin(operation, isCurrent, staleJwt = null) {
    if (!this.rememberPassword() || this.autoLoginBlocked) return null;
    const directory = this.context.globalStorageUri?.fsPath;
    return withRecoveryLock(directory, async () => {
      if (!isCurrent()) return null;
      const auth = await this.readAuth();
      if (!isCurrent()) return null;
      // The lock holder may already have renewed the JWT. Reuse it instead of
      // logging in again. This also covers an external credential update.
      if (auth.jwt && auth.jwt !== staleJwt && typeof auth.jwt === "string" &&
          auth.jwt.length <= 16_384 && !/\s/.test(auth.jwt)) {
        this.autoLoginBlocked = false;
        return { jwt: auth.jwt, snapshot: await this.fetchWithRetry(auth.jwt, isCurrent) };
      }
      const credentials = await this.readLoginCredentials(operation.generation);
      if (!isCurrent() || !credentials) return null;
      let newJwt;
      try { newJwt = await loginWithPassword(credentials.email, credentials.password); }
      catch (error) {
        if (error && !error.phase) error.phase = "login";
        if (isCurrent() && manualInterventionRequired(error)) this.autoLoginBlocked = true;
        throw error; // Preserve NETWORK/HTTP/CF/RATE_LIMIT; do not mislabel as password failure.
      }
      if (!isCurrent() || !this.rememberPassword()) return null;
      let jwtToUse = null;
      await this.queueSecretWrite(async () => {
        if (!isCurrent() || !this.rememberPassword()) return;
        const latest = await this.readAuth();
        if (!isCurrent() || !this.rememberPassword()) return;
        if (JSON.stringify(latest) !== credentials.expectedRecord) {
          if (latest.email === credentials.email && latest.password === credentials.password &&
              typeof latest.jwt === "string" && latest.jwt.length > 0 &&
              latest.jwt.length <= 16_384 && !/\s/.test(latest.jwt)) {
            jwtToUse = latest.jwt; // Another window already renewed this account.
          } else {
            this.observedAuth = JSON.stringify(latest);
            this.invalidateInFlight();
            this.snapshot = null;
            this.lastSuccessAt = 0;
            this._hasJwt = Boolean(latest.jwt);
            this.emit();
          }
          return;
        }
        const updated = { version: 1, jwt: newJwt, email: credentials.email, password: credentials.password };
        // Save the new JWT BEFORE GET. A GET timeout no longer discards it.
        await this.writeAuth(updated);
        jwtToUse = newJwt;
      });
      if (!isCurrent() || !jwtToUse) return null;
      this._hasJwt = true;
      this.autoLoginBlocked = false;
      return { jwt: jwtToUse, snapshot: await this.fetchWithRetry(jwtToUse, isCurrent) };
    }).catch((error) => {
      if (error?.code === "SECRET_STORAGE" || error?.code === "RECOVERY_BUSY") throw error;
      if (error?.code) throw error;
      throw new KrillApiError("SECRET_STORAGE", "登录恢复过程失败", null, { phase: "recovery" });
    });
  }

  scheduleCooldown(error) {
    this.failureStreak = Math.min(this.failureStreak + 1, 6);
    const temporary = ["NETWORK", "TIMEOUT", "HTTP", "RATE_LIMIT", "RECOVERY_BUSY", "CF_CHALLENGE", "SECRET_STORAGE"].includes(error.code);
    this.rateLimitCooldown = error.code === "RATE_LIMIT" || (error.retryAfterMs != null && error.retryAfterMs > 0);
    const base = error.code === "RATE_LIMIT" ? 60_000 : temporary
      ? Math.min(3 * 60_000, 15_000 * (2 ** (this.failureStreak - 1))) : 0;
    this.nextAllowedAt = Date.now() + Math.max(base, error.retryAfterMs || 0);
  }
  logFailure(error) {
    this.logEvent(error.phase, error.source, "failed", {
      code: error.code, http: error.status, network: error.networkCode,
      attempts: error.attempts, durationMs: error.elapsedMs, cached: Boolean(this.snapshot)
    });
  }

  getRefreshMinutes() {
    const n = Number(vscode.workspace.getConfiguration("krillUsage")
      .get("refreshIntervalMinutes", DEFAULT_REFRESH_MINUTES));
    return Number.isFinite(n) ? Math.max(1, Math.min(60, n)) : DEFAULT_REFRESH_MINUTES;
  }
  startTimers() {
    this.stopTimers();
    if (this.disposed) return;
    this.apiTimer = setInterval(() => this.refresh("auto", { silent: true }), this.getRefreshMinutes() * 60_000);
    this.uiTimer = setInterval(() => this.emit(), UI_TICK_MS);
  }
  restartTimers() { this.startTimers(); this.emit(); }
  async refreshIfStale() {
    if (this.disposed) return;
    const maxAge = this.getRefreshMinutes() * 60_000;
    if (!this.lastSuccessAt || Date.now() - this.lastSuccessAt >= maxAge) {
      await this.refresh("focus", { silent: true });
    }
  }
  stopTimers() {
    if (this.apiTimer) clearInterval(this.apiTimer);
    if (this.uiTimer) clearInterval(this.uiTimer);
    this.apiTimer = null;
    this.uiTimer = null;
  }
  dispose() {
    this.disposed = true;
    this.invalidateInFlight();
    this.stopTimers();
    this.secretSubscription?.dispose();
    this.output?.dispose();
    this.listeners.clear();
  }
}

module.exports = { KrillUsageService, safeFailure, isRetryableGet };
