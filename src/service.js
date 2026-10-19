"use strict";

const vscode = require("vscode");
const { fetchSubscription, loginWithPassword, KrillApiError } = require("./api");
const {
  SECRET_KEY, AUTH_SECRET_KEY, EMAIL_SECRET_KEY, PASSWORD_SECRET_KEY,
  DEFAULT_REFRESH_MINUTES, UI_TICK_MS
} = require("./constants");
const { sanitizeJwt } = require("./jwt");

class KrillUsageService {
  constructor(context) {
    this.context = context;
    this.snapshot = null;
    this.error = null;
    this.refreshing = false;
    this.lastSuccessAt = 0;
    this.listeners = new Set();
    this.apiTimer = null;
    this.uiTimer = null;
    this.disposed = false;
    this.generation = 0;
    this.activeRefresh = null;
    this.activeLogin = null;
    this.credentialWrites = Promise.resolve();
    this._hasJwt = false;
    // Failed automated sign-in never retries on the next 3-minute tick.
    // A new explicit login or JWT setting can unblock it.
    this.autoLoginBlocked = false;
  }

  async initialize() {
    if (!this.rememberPassword()) {
      await this.onRememberPasswordChanged();
      if (this.error?.code === "SECRET_STORAGE") return;
    }
    this.startTimers();
    await this.refresh("startup", { silent: true });
  }

  getView() {
    return {
      snapshot: this.snapshot,
      error: this.error,
      refreshing: this.refreshing,
      lastSuccessAt: this.lastSuccessAt,
      authenticated: Boolean(this._hasJwt),
      refreshMinutes: this.getRefreshMinutes()
    };
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    listener(this.getView());
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit() {
    if (this.disposed) return;
    const view = this.getView();
    for (const listener of [...this.listeners]) {
      try { listener(view); } catch (error) { console.error("[Krill Usage] listener", error); }
    }
  }

  async readAuth() {
    const raw = await this.context.secrets.get(AUTH_SECRET_KEY);
    if (raw !== undefined && raw !== null) {
      let auth;
      try { auth = JSON.parse(raw); } catch { throw new Error("Invalid stored credentials"); }
      if (auth?.version !== 1 || !(auth.jwt === null || typeof auth.jwt === "string")) {
        throw new Error("Invalid stored credentials");
      }
      return auth;
    }
    // Upgrade old JWT-only installs. Separate candidate email/password keys are
    // never trusted as a pair because a partial write may have mixed accounts.
    return { version: 1, jwt: await this.context.secrets.get(SECRET_KEY) ?? null };
  }

  async writeAuth(auth) {
    // One atomic SecretStorage value binds all credentials to the same account.
    // A null JWT is a tombstone: legacy cleanup failure must not revive a login.
    await this.context.secrets.store(AUTH_SECRET_KEY, JSON.stringify(auth));
    const cleanup = await Promise.allSettled([
      this.context.secrets.delete(SECRET_KEY),
      this.context.secrets.delete(EMAIL_SECRET_KEY),
      this.context.secrets.delete(PASSWORD_SECRET_KEY)
    ]);
    if (cleanup.some(result => result.status === "rejected")) {
      throw new Error("Legacy credential cleanup failed");
    }
  }

  async getJwt(generation = this.generation) {
    const { jwt } = await this.readAuth();
    if (this.disposed || generation !== this.generation) return null;
    this._hasJwt = Boolean(jwt);
    return jwt ?? null;
  }

  rememberPassword() {
    return vscode.workspace.getConfiguration("krillUsage").get("rememberPassword", true) === true;
  }

  async readLoginCredentials(generation = this.generation) {
    if (!this.rememberPassword()) return null;
    const { email, password } = await this.readAuth();
    if (this.disposed || this.generation !== generation || !this.rememberPassword()) return null;
    return typeof email === "string" && email && typeof password === "string" && password
      ? { email, password } : null;
  }

  async setJwt(rawJwt) {
    const jwt = sanitizeJwt(rawJwt);
    if (!jwt || jwt.length > 16_384 || /\s/.test(jwt)) throw new Error("EMPTY_JWT");
    const generation = this.generation + 1;
    // A manually supplied token must not resurrect a previous account when it expires.
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

  async changeCredentials(jwt, credentials = null) {
    if (this.disposed) return false;
    const generation = this.invalidateInFlight();
    this._hasJwt = false;
    this.snapshot = null;
    this.error = null;
    this.lastSuccessAt = 0;
    this.autoLoginBlocked = false;
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
        this.error = { code: "SECRET_STORAGE", message: "凭据保存或清除失败，请重试" };
        this.emit();
      }
      return false;
    }
    if (this.disposed || generation !== this.generation) return false;
    this._hasJwt = Boolean(jwt);
    this.emit();
    return true;
  }

  /** Direct interactive sign-in. Authenticate and check quota before retaining credentials. */
  logIn(email, password) {
    if (this.disposed) return Promise.resolve(null);
    const generation = this.invalidateInFlight();
    const operation = { generation, promise: null };
    this.activeLogin = operation;
    operation.promise = this.runLogIn(operation, email, password);
    return operation.promise;
  }

  async runLogIn(operation, email, password) {
    const { generation } = operation;
    this.refreshing = true;
    this.error = null;
    this.emit();
    try {
      const jwt = await loginWithPassword(email, password);
      if (this.disposed || generation !== this.generation) return null;
      const snapshot = await fetchSubscription(jwt);
      if (this.disposed || generation !== this.generation) return null;
      const credentials = this.rememberPassword() ? { email: email.trim(), password } : null;
      if (!await this.changeCredentials(jwt, credentials)) return null;
      // changeCredentials increments generation; no awaited work between check and publish.
      this.snapshot = snapshot;
      this.lastSuccessAt = Date.now();
      this.error = null;
      this.emit();
      return snapshot;
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.error = {
          code: error?.code ?? "LOGIN_FAILED",
          message: error?.message ?? "Krill 登录失败"
        };
        this.emit();
      }
      return null;
    } finally {
      if (this.activeLogin === operation) this.activeLogin = null;
      if (!this.disposed && generation === this.generation) {
        this.refreshing = false;
        this.emit();
      }
    }
  }

  /** Setting to JWT-only must immediately delete persisted email/password. */
  async onRememberPasswordChanged() {
    if (this.disposed) return;
    if (this.rememberPassword()) {
      // Re-enabling does not magically restore deleted credentials.
      this.emit();
      return;
    }
    const generation = this.invalidateInFlight();
    try {
      await this.queueSecretWrite(async () => {
        const { jwt } = await this.readAuth();
        await this.writeAuth({ version: 1, jwt });
      });
    } catch {
      if (generation === this.generation && !this.disposed) {
        this.error = { code: "SECRET_STORAGE", message: "删除保存的账号密码失败，请重试" };
      }
    }
    if (generation === this.generation && !this.disposed) this.emit();
  }

  refresh(source = "manual", { silent = false } = {}) {
    if (this.disposed) return Promise.resolve(null);
    if (this.activeLogin) return this.activeLogin.promise;
    if (this.activeRefresh) return this.activeRefresh.promise;
    const operation = { generation: this.generation, promise: null };
    this.activeRefresh = operation;
    operation.promise = this.runRefresh(operation, source, silent);
    return operation.promise;
  }

  async runRefresh(operation, source, silent) {
    const isCurrent = () => !this.disposed &&
      operation.generation === this.generation && this.activeRefresh === operation;
    this.refreshing = true;
    this.emit();
    try {
      await this.credentialWrites;
      if (!isCurrent()) return null;
      let jwt = await this.getJwt(operation.generation);
      if (!isCurrent()) return null;
      let snapshot;

      if (!jwt) {
        snapshot = await this.recoverLogin(operation, isCurrent);
        if (!isCurrent()) return null;
        if (!snapshot) {
          this.error = { code: "NO_JWT", message: this.autoLoginBlocked
            ? "自动登录已暂停，请手动登录 Krill"
            : "尚未登录，请使用 Krill: Log In 或手动设置 JWT" };
          return null;
        }
      } else {
        try {
          snapshot = await fetchSubscription(jwt);
        } catch (error) {
          if (error?.code !== "UNAUTHORIZED") throw error;
          // Recover only for explicit 401 / business 401, never for network/CF/5xx.
          snapshot = await this.recoverLogin(operation, isCurrent);
          if (!snapshot) throw new KrillApiError("UNAUTHORIZED", this.autoLoginBlocked
            ? "自动重新登录已暂停，请手动登录 Krill" : "JWT 已失效，请重新登录 Krill");
        }
      }
      if (!isCurrent()) return null;
      this.snapshot = snapshot;
      this.lastSuccessAt = Date.now();
      this.error = null;
      return snapshot;
    } catch (error) {
      if (!isCurrent()) return null;
      this.error = {
        code: error?.code ?? "ERROR",
        message: error?.message ?? "额度查询失败"
      };
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

  /** Only one automatic re-login per refresh; any failure disables future auto-attempts. */
  async recoverLogin(operation, isCurrent) {
    if (!this.rememberPassword() || this.autoLoginBlocked) return null;
    const credentials = await this.readLoginCredentials(operation.generation);
    if (!isCurrent() || !credentials) return null;
    try {
      const jwt = await loginWithPassword(credentials.email, credentials.password);
      if (!isCurrent() || !this.rememberPassword()) return null;
      const snapshot = await fetchSubscription(jwt);
      if (!isCurrent() || !this.rememberPassword()) return null;
      await this.queueSecretWrite(async () => {
        if (!isCurrent() || !this.rememberPassword()) return;
        await this.writeAuth({ version: 1, jwt, ...credentials });
      });
      if (!isCurrent()) return null;
      this._hasJwt = true;
      this.autoLoginBlocked = false;
      return snapshot;
    } catch {
      if (isCurrent()) this.autoLoginBlocked = true;
      // Do not echo server messages or secrets in the background retry path.
      throw new KrillApiError("AUTO_LOGIN_FAILED", "自动重新登录失败并已暂停，请手动登录 Krill");
    }
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
    this.listeners.clear();
  }
}

module.exports = { KrillUsageService };
