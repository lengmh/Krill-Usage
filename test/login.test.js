"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { SECRET_KEY, AUTH_SECRET_KEY, EMAIL_SECRET_KEY, PASSWORD_SECRET_KEY } = require("../src/constants");

function setup({ remember = true, jwt = null, email = null, password = null, login, fetch } = {}) {
  const stored = new Map();
  if (jwt !== null) stored.set(SECRET_KEY, jwt);
  if (email !== null || password !== null) {
    stored.delete(SECRET_KEY);
    stored.set(AUTH_SECRET_KEY, JSON.stringify({ version: 1, jwt, email, password }));
  }
  const calls = [];
  let rememberValue = remember;
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (key, fallback) =>
      key === "rememberPassword" ? rememberValue : key === "refreshIntervalMinutes" ? 3 : fallback }) },
    window: { showErrorMessage: (message) => { calls.push(["popup-error", message]); } }
  };
  const defaultSnapshot = { creditBalance: "25", subscriptions: [] };
  const api = {
    fetchSubscription: async (value) => {
      calls.push(["fetch", value]);
      return fetch ? fetch(value) : defaultSnapshot;
    },
    loginWithPassword: async (e, p) => {
      calls.push(["login", e]);
      return login ? login(e, p) : "new-jwt";
    },
    KrillApiError: class KrillApiError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    }
  };
  const base = path.resolve(__dirname, "../src/service.js");
  delete require.cache[base];
  const original = Module._load;
  Module._load = function (name, parent, isMain) {
    if (name === "vscode") return vscode;
    if (name === "./api" && parent?.filename === base) return api;
    return original.apply(this, arguments);
  };
  let Service;
  try { Service = require(base).KrillUsageService; } finally { Module._load = original; }
  const secrets = {
    async get(key) { calls.push(["get", key]); return stored.get(key) ?? undefined; },
    async store(key, value) { calls.push(["store", key]); stored.set(key, value); },
    async delete(key) { calls.push(["delete", key]); stored.delete(key); }
  };
  const service = new Service({ secrets });
  return { service, stored, calls, auth: () => JSON.parse(stored.get(AUTH_SECRET_KEY) ?? "null"), setRemember: (value) => { rememberValue = value; }, snapshot: defaultSnapshot };
}

test("new interactive login remembers email, password and verified JWT by default", async () => {
  const x = setup();
  assert.deepEqual(await x.service.logIn(" a@example.com ", "do-not-log-this"), x.snapshot);
  assert.equal((x.auth()?.jwt ?? x.stored.get(SECRET_KEY)), "new-jwt");
  assert.equal(x.auth()?.email, "a@example.com");
  assert.equal(x.auth()?.password, "do-not-log-this");
  assert.equal(x.service.getView().authenticated, true);
  assert.deepEqual(x.calls.filter(([name]) => name === "login"), [["login", " a@example.com "]]);
  x.service.dispose();
});

test("JWT-only login stores token but removes previously saved credentials", async () => {
  const x = setup({ remember: false, email: "old@example.com", password: "old-password" });
  assert.ok(await x.service.logIn("a@example.com", "new-password"));
  assert.equal((x.auth()?.jwt ?? x.stored.get(SECRET_KEY)), "new-jwt");
  assert.equal(x.stored.has(EMAIL_SECRET_KEY), false);
  assert.equal(x.stored.has(PASSWORD_SECRET_KEY), false);
  x.service.dispose();
});

test("failed explicit login does not overwrite previously connected account", async () => {
  const x = setup({ jwt: "old-jwt", email: "old@example.com", password: "old-secret", login: async () => {
    const e = new Error("login failed"); e.code = "LOGIN_FAILED"; throw e;
  } });
  assert.equal(await x.service.logIn("new@example.com", "wrong"), null);
  assert.equal((x.auth()?.jwt ?? x.stored.get(SECRET_KEY)), "old-jwt");
  assert.equal(x.auth()?.email, "old@example.com");
  assert.equal(x.auth()?.password, "old-secret");
  x.service.dispose();
});

test("missing JWT automatically logs in from remembered credentials", async () => {
  const x = setup({ email: "a@example.com", password: "password" });
  assert.deepEqual(await x.service.refresh("startup"), x.snapshot);
  assert.equal(x.calls.filter(([name]) => name === "login").length, 1);
  assert.equal((x.auth()?.jwt ?? x.stored.get(SECRET_KEY)), "new-jwt");
  x.service.dispose();
});

test("401 with remembered credentials logs in once then retries subscription once", async () => {
  const x = setup({ jwt: "expired", email: "a@example.com", password: "password",
    fetch: async (jwt) => {
      if (jwt === "expired") { const e = new Error("expired"); e.code = "UNAUTHORIZED"; throw e; }
      return { creditBalance: "100", subscriptions: [] };
    }
  });
  assert.equal((await x.service.refresh()).creditBalance, "100");
  assert.deepEqual(x.calls.filter(([op]) => op === "fetch"), [["fetch", "expired"], ["fetch", "new-jwt"]]);
  assert.equal(x.calls.filter(([name]) => name === "login").length, 1);
  assert.equal((x.auth()?.jwt ?? x.stored.get(SECRET_KEY)), "new-jwt");
  x.service.dispose();
});

test("failed auto login is blocked across subsequent three-minute refreshes", async () => {
  const x = setup({ jwt: "expired", email: "a@example.com", password: "wrong",
    fetch: async () => { const e = new Error("expired"); e.code = "UNAUTHORIZED"; throw e; },
    login: async () => { throw Object.assign(new Error("incorrect password"), { code: "LOGIN_FAILED", phase: "login" }); }
  });
  await x.service.refresh("auto");
  assert.equal(x.service.autoLoginBlocked, true);
  await x.service.refresh("auto");
  await x.service.refresh("manual");
  assert.equal(x.calls.filter(([op]) => op === "login").length, 1);
  assert.match(x.service.getView().error.message, /暂停/);
  x.service.dispose();
});

test("network failure does not trigger password login", async () => {
  const x = setup({ jwt: "jwt", email: "a@example.com", password: "password",
    fetch: async () => { const e = new Error("network"); e.code = "NETWORK"; throw e; }
  });
  await x.service.refresh("auto");
  assert.equal(x.calls.filter(([op]) => op === "login").length, 0);
  x.service.dispose();
});

test("disabling remember-password immediately deletes saved password and email, retaining JWT", async () => {
  const x = setup({ jwt: "jwt", email: "a@example.com", password: "password" });
  x.setRemember(false);
  await x.service.onRememberPasswordChanged();
  assert.equal((x.auth()?.jwt ?? x.stored.get(SECRET_KEY)), "jwt");
  assert.equal(x.stored.has(EMAIL_SECRET_KEY), false);
  assert.equal(x.stored.has(PASSWORD_SECRET_KEY), false);
  x.setRemember(true);
  await x.service.onRememberPasswordChanged();
  assert.equal(x.stored.has(PASSWORD_SECRET_KEY), false);
  x.service.dispose();
});

test("manually setting JWT removes old account credentials to prevent accidental account rollback", async () => {
  const x = setup({ jwt: "old", email: "old@example.com", password: "old-secret" });
  await x.service.setJwt("Bearer new-manual-jwt");
  assert.equal((x.auth()?.jwt ?? x.stored.get(SECRET_KEY)), "new-manual-jwt");
  assert.equal(x.stored.has(EMAIL_SECRET_KEY), false);
  assert.equal(x.stored.has(PASSWORD_SECRET_KEY), false);
  x.service.dispose();
});

test("clearing credentials deletes all secrets and snapshots", async () => {
  const x = setup({ jwt: "jwt", email: "a@example.com", password: "password" });
  await x.service.refresh();
  assert.equal(await x.service.clearCredentials(), true);
  assert.deepEqual(x.auth(), { version: 1, jwt: null });
  assert.equal(x.stored.size, 1);
  assert.equal(x.service.getView().snapshot, null);
  x.service.dispose();
});

test("late login response after account clear never restores the older account", async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const x = setup({ jwt: "old", login: async () => pending });
  const login = x.service.logIn("a@example.com", "password");
  await Promise.resolve();
  assert.equal(await x.service.clearCredentials(), true);
  resolve("late-jwt");
  assert.equal(await login, null);
  assert.equal(x.stored.has(SECRET_KEY), false);
  assert.equal(x.service.getView().snapshot, null);
  x.service.dispose();
});

test("JWT-only mode cannot auto-relogin even if old credentials remain temporarily", async () => {
  const x = setup({ remember: false, jwt: "expired", email: "a@example.com", password: "password",
    fetch: async () => { const e = new Error("expired"); e.code = "UNAUTHORIZED"; throw e; }
  });
  await x.service.refresh();
  assert.equal(x.calls.filter(([op]) => op === "login").length, 0);
  x.service.dispose();
});

test("failed atomic account switch preserves the entire previous account", async () => {
  const x = setup({ jwt: "token-a", email: "a@example.test", password: "password-a" });
  const before = x.stored.get(AUTH_SECRET_KEY);
  x.service.context.secrets.store = async () => { throw new Error("synthetic failure"); };
  assert.equal(await x.service.logIn("b@example.test", "password-b"), null);
  assert.equal(x.stored.get(AUTH_SECRET_KEY), before);
  assert.equal(x.service.getView().error.code, "SECRET_STORAGE");
  x.service.dispose();
});

test("startup JWT-only mode removes stored passwords even without a configuration event", async () => {
  const x = setup({ remember: false, jwt: "token-a", email: "a@example.test", password: "password-a" });
  await x.service.initialize();
  assert.deepEqual(x.auth(), { version: 1, jwt: "token-a" });
  assert.equal(x.service.getView().authenticated, true);
  x.service.dispose();
});

test("startup password cleanup failure remains visible and does not start requests", async () => {
  const x = setup({ remember: false, jwt: "token-a", email: "a@example.test", password: "password-a" });
  x.service.context.secrets.store = async () => { throw new Error("synthetic failure"); };
  await x.service.initialize();
  assert.equal(x.service.getView().error.code, "SECRET_STORAGE");
  assert.equal(x.calls.filter(([op]) => op === "fetch" || op === "login").length, 0);
  x.service.dispose();
});

test("focus and timer refresh join interactive login instead of publishing the old account", async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const x = setup({ jwt: "token-a", login: () => pending });
  const signingIn = x.service.logIn("b@example.test", "password-b");
  const focus = x.service.refresh("focus");
  const auto = x.service.refresh("auto");
  assert.equal(focus, signingIn);
  assert.equal(auto, signingIn);
  assert.equal(x.service.getView().refreshing, true);
  assert.equal(x.calls.filter(([op]) => op === "fetch").length, 0);
  resolve("token-b");
  await Promise.all([signingIn, focus, auto]);
  assert.deepEqual(x.calls.filter(([op]) => op === "fetch"), [["fetch", "token-b"]]);
  x.service.dispose();
});

test("clear tombstone prevents legacy resurrection even when legacy deletion fails", async () => {
  const x = setup({ jwt: "legacy-token" });
  x.service.context.secrets.delete = async () => { throw new Error("synthetic delete failure"); };
  assert.equal(await x.service.clearCredentials(), false);
  assert.equal(x.service.getView().error.code, "SECRET_STORAGE");
  assert.equal(x.stored.get(SECRET_KEY), "legacy-token");
  assert.deepEqual(x.auth(), { version: 1, jwt: null });
  assert.equal(await x.service.getJwt(), null);
  await x.service.refresh();
  assert.equal(x.calls.filter(([op]) => op === "fetch" || op === "login").length, 0);
  x.service.dispose();
});

test("unassociated legacy email/password are never used for automatic login", async () => {
  const x = setup();
  x.stored.set(EMAIL_SECRET_KEY, "b@example.test");
  x.stored.set(PASSWORD_SECRET_KEY, "password-a");
  await x.service.refresh();
  assert.equal(x.calls.filter(([op]) => op === "login").length, 0);
  x.service.dispose();
});

test("clear during pending automatic recovery cannot restore credentials or quota", async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const x = setup({ jwt: null, email: "a@example.test", password: "password-a", login: () => pending });
  const recovering = x.service.refresh();
  while (!x.calls.some(([op]) => op === "login")) await Promise.resolve();
  await x.service.clearCredentials();
  resolve("late-token");
  assert.equal(await recovering, null);
  assert.deepEqual(x.auth(), { version: 1, jwt: null });
  assert.equal(x.service.getView().snapshot, null);
  x.service.dispose();
});

test("disable remember-password during pending recovery keeps JWT without restoring password", async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const x = setup({ jwt: "expired", email: "a@example.test", password: "password-a", login: () => pending,
    fetch: async () => { throw Object.assign(new Error("expired"), { code: "UNAUTHORIZED" }); } });
  const recovering = x.service.refresh();
  while (!x.calls.some(([op]) => op === "login")) await Promise.resolve();
  x.setRemember(false);
  await x.service.onRememberPasswordChanged();
  resolve("late-token");
  assert.equal(await recovering, null);
  assert.deepEqual(x.auth(), { version: 1, jwt: "expired" });
  x.setRemember(true);
  await x.service.onRememberPasswordChanged();
  assert.deepEqual(x.auth(), { version: 1, jwt: "expired" });
  x.service.dispose();
});

test("clear waits behind an in-progress credential commit and wins persisted ordering", async () => {
  const x = setup({ jwt: "token-a", email: "a@example.test", password: "password-a" });
  let release;
  const barrier = new Promise(r => { release = r; });
  let started;
  const entered = new Promise(r => { started = r; });
  const store = x.service.context.secrets.store;
  let first = true;
  x.service.context.secrets.store = async (key, value) => {
    if (key === AUTH_SECRET_KEY && first) { first = false; started(); await barrier; }
    await store(key, value);
  };
  const signingIn = x.service.logIn("b@example.test", "password-b");
  await entered;
  const clearing = x.service.clearCredentials();
  release();
  assert.equal(await signingIn, null);
  assert.equal(await clearing, true);
  assert.deepEqual(x.auth(), { version: 1, jwt: null });
  assert.equal(x.service.getView().snapshot, null);
  x.service.dispose();
});

test("disabling password memory wins over an in-progress account commit", async () => {
  const x = setup();
  let release;
  const barrier = new Promise(r => { release = r; });
  let started;
  const entered = new Promise(r => { started = r; });
  const store = x.service.context.secrets.store;
  let first = true;
  x.service.context.secrets.store = async (key, value) => {
    if (key === AUTH_SECRET_KEY && first) { first = false; started(); await barrier; }
    await store(key, value);
  };
  const signingIn = x.service.logIn("a@example.test", "password-a");
  await entered;
  x.setRemember(false);
  const disabling = x.service.onRememberPasswordChanged();
  release();
  await Promise.all([signingIn, disabling]);
  assert.deepEqual(x.auth(), { version: 1, jwt: "new-jwt" });
  x.service.dispose();
});

test("another window clearing during automatic login cannot be undone by its late response", async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const a = setup({ jwt: null, email: "a@example.test", password: "password-a" });
  const b = setup({ login: () => pending });
  b.service.context.secrets = a.service.context.secrets;
  const recovering = b.service.refresh();
  while (!b.calls.some(([op]) => op === "login")) await Promise.resolve();
  await a.service.clearCredentials();
  resolve("late-token-a");
  assert.equal(await recovering, null);
  assert.deepEqual(a.auth(), { version: 1, jwt: null });
  assert.equal(b.service.getView().snapshot, null);
  assert.equal(b.service.getView().authenticated, false);
  a.service.dispose(); b.service.dispose();
});

test("another window switching accounts during recovery keeps its new credential record", async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const a = setup({ jwt: null, email: "a@example.test", password: "password-a" });
  const b = setup({ login: () => pending });
  b.service.context.secrets = a.service.context.secrets;
  const recovering = b.service.refresh();
  while (!b.calls.some(([op]) => op === "login")) await Promise.resolve();
  await a.service.setJwt("token-b");
  resolve("late-token-a");
  assert.equal(await recovering, null);
  assert.deepEqual(a.auth(), { version: 1, jwt: "token-b" });
  assert.equal(b.service.getView().snapshot, null);
  a.service.dispose(); b.service.dispose();
});

test("concurrent same-account recovery preserves the first committed JWT and both quota results", async () => {
  let finishA, finishB;
  const pendingA = new Promise(resolve => { finishA = resolve; });
  const pendingB = new Promise(resolve => { finishB = resolve; });
  const a = setup({ jwt: null, email: "a@example.test", password: "password-a", login: () => pendingA });
  const b = setup({ login: () => pendingB });
  b.service.context.secrets = a.service.context.secrets;
  const recoveryA = a.service.refresh();
  const recoveryB = b.service.refresh();
  while (![a, b].every(x => x.calls.some(([op]) => op === "login"))) await Promise.resolve();
  finishA("first-committed-token");
  assert.deepEqual(await recoveryA, a.snapshot);
  const committed = a.stored.get(AUTH_SECRET_KEY);
  const storesBeforeB = a.calls.filter(([op]) => op === "store").length;
  finishB("late-response-token");
  assert.deepEqual(await recoveryB, b.snapshot);
  assert.equal(a.stored.get(AUTH_SECRET_KEY), committed, "late recovery must not overwrite another window's token");
  assert.equal(a.calls.filter(([op]) => op === "store").length, storesBeforeB);
  assert.deepEqual(b.service.getView().snapshot, b.snapshot);
  assert.equal(b.service.getView().authenticated, true);
  assert.equal(b.service.getView().refreshing, false);
  assert.equal(b.service.getView().error, null);
  a.service.dispose(); b.service.dispose();
});

test("changed credentials or unusable JWT cannot bypass the cross-window recovery guard", async (t) => {
  for (const replacement of [
    { jwt: "other-token", email: "b@example.test", password: "password-a" },
    { jwt: "other-token", email: "a@example.test", password: "changed-password" },
    { jwt: "other-token" },
    { jwt: null, email: "a@example.test", password: "password-a" },
    { jwt: "", email: "a@example.test", password: "password-a" },
    { jwt: "invalid token", email: "a@example.test", password: "password-a" }
  ]) {
    await t.test(JSON.stringify(replacement), async () => {
      let resolve;
      const pending = new Promise(r => { resolve = r; });
      const x = setup({ jwt: "expired-token", email: "a@example.test", password: "password-a", login: () => pending,
        fetch: async jwt => {
          if (jwt === "expired-token") throw Object.assign(new Error("expired"), { code: "UNAUTHORIZED" });
          return { creditBalance: "25", subscriptions: [] };
        }
      });
      const recovery = x.service.refresh();
      while (!x.calls.some(([op]) => op === "login")) await Promise.resolve();
      const newerRecord = JSON.stringify({ version: 1, ...replacement });
      x.stored.set(AUTH_SECRET_KEY, newerRecord);
      resolve("late-token");
      const currentRecord = x.stored.get(AUTH_SECRET_KEY);
      assert.equal(await recovery, null);
      assert.equal(x.stored.get(AUTH_SECRET_KEY), currentRecord);
      assert.equal(x.service.getView().snapshot, null);
      x.service.dispose();
    });
  }
});
