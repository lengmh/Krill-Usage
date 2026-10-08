"use strict";

const vscode = require("vscode");
const { fetchSubscription } = require("./api");
const { SECRET_KEY, DEFAULT_REFRESH_MINUTES, UI_TICK_MS } = require("./constants");
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
    this.credentialWrites = Promise.resolve();
  }

  async initialize() {
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

  async getJwt(generation = this.generation) {
    const jwt = await this.context.secrets.get(SECRET_KEY);
    if (this.disposed || generation !== this.generation) return null;
    this._hasJwt = Boolean(jwt);
    return jwt ?? null;
  }

  async setJwt(rawJwt) {
    const jwt = sanitizeJwt(rawJwt);
    if (!jwt) throw new Error("EMPTY_JWT");
    const generation = this.generation + 1;
    if (!await this.changeCredentials(jwt)) return null;
    if (this.disposed || generation !== this.generation) return null;
    return this.refresh("set-jwt");
  }

  async clearJwt() {
    return this.changeCredentials(null);
  }

  async changeCredentials(jwt) {
    if (this.disposed) return false;
    // Invalidate reads and requests before awaiting SecretStorage. Old requests
    // may finish, but no longer own any state or notifications in this window.
    const generation = ++this.generation;
    this.activeRefresh = null;
    this.refreshing = false;
    this._hasJwt = false;
    this.snapshot = null;
    this.error = null;
    this.lastSuccessAt = 0;
    this.emit();
    // Preserve the user's set/clear order even if storage writes finish slowly.
    const write = this.credentialWrites.catch(() => {}).then(() => {
      if (jwt === null) return this.context.secrets.delete(SECRET_KEY);
      return this.context.secrets.store(SECRET_KEY, jwt);
    });
    this.credentialWrites = write.catch(() => {});
    try {
      await write;
    } catch {
      if (this.disposed || generation !== this.generation) return false;
      this.error = { code: "SECRET_STORAGE", message: "凭据保存或清除失败，请重试" };
      this.emit();
      return false;
    }
    if (this.disposed || generation !== this.generation) return false;
    this._hasJwt = Boolean(jwt);
    this.emit();
    return true;
  }

  refresh(source = "manual", { silent = false } = {}) {
    if (this.disposed) return Promise.resolve(null);
    if (this.activeRefresh) return this.activeRefresh.promise;
    // Reserve ownership synchronously, including the pending SecretStorage read.
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
      const jwt = await this.getJwt(operation.generation);
      if (!isCurrent()) return null;
      if (!jwt) {
        this.snapshot = null;
        this.lastSuccessAt = 0;
        this.error = { code: "NO_JWT", message: "尚未设置 krill_jwt" };
        return null;
      }
      const snapshot = await fetchSubscription(jwt);
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

  getRefreshMinutes() {
    const configured = vscode.workspace
      .getConfiguration("krillUsage")
      .get("refreshIntervalMinutes", DEFAULT_REFRESH_MINUTES);
    const n = Number(configured);
    return Number.isFinite(n) ? Math.max(1, Math.min(60, n)) : DEFAULT_REFRESH_MINUTES;
  }

  startTimers() {
    this.stopTimers();
    if (this.disposed) return;
    const minutes = this.getRefreshMinutes();
    this.apiTimer = setInterval(() => this.refresh("auto", { silent: true }), minutes * 60_000);
    this.uiTimer = setInterval(() => this.emit(), UI_TICK_MS);
  }

  restartTimers() {
    this.startTimers();
    this.emit();
  }

  async refreshIfStale() {
    if (!this._hasJwt || this.disposed) return;
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
    this.generation++;
    this.activeRefresh = null;
    this.refreshing = false;
    this.stopTimers();
    this.listeners.clear();
  }
}

module.exports = { KrillUsageService };
