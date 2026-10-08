"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { createCredentialStore, defaultStateDir, SERVICE, ACCOUNT, REVISION_FILE, LOCK_FILE, MAX_CREDENTIAL_LENGTH } = require("../src/credentials.cjs");
const { hiddenInput, runCredentialCli } = require("../src/credential-cli.cjs");

const TOKEN_A = "synthetic-account-a";
const TOKEN_B = "synthetic-account-b";
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

function fixture(t, overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "krill-credential-test-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let secret = null;
  const calls = [];
  const entry = {
    getPassword() { calls.push("read"); return secret; },
    setPassword(value) { calls.push("replace"); secret = value; },
    deletePassword() { calls.push("clear"); const existed = secret !== null; secret = null; return existed; },
    ...overrides
  };
  const factoryArgs = [];
  const entryFactory = (...args) => { factoryArgs.push(args); return entry; };
  return { stateDir, entry, calls, factoryArgs, store: createCredentialStore({ entryFactory, stateDir }), another: () => createCredentialStore({ entryFactory, stateDir }), secret: () => secret };
}

function terminal({ isTTY = true } = {}) {
  const input = new EventEmitter();
  Object.assign(input, { isTTY, isRaw: false, readableFlowing: false, rawModes: [], setRawMode(value) { this.isRaw = value; this.rawModes.push(value); }, resume() { this.readableFlowing = true; }, pause() { this.readableFlowing = false; } });
  let written = "";
  const output = { isTTY, write(value) { written += value; } };
  const signals = new EventEmitter();
  return { input, output, signals, written: () => written, send: (value) => input.emit("data", Buffer.from(value)) };
}

function noSecret(error) {
  assert.equal(error.code, "SECRET_STORAGE");
  assert.ok(!JSON.stringify(error).includes(TOKEN_A));
  assert.ok(!String(error.stack).includes(TOKEN_A));
  assert.equal(error.cause, undefined);
  return true;
}

test("store creation and revision checks never initialize the vault", async (t) => {
  const f = fixture(t);
  assert.equal(await f.store.readRevision(), "absent");
  assert.deepEqual(f.calls, []);
  assert.equal(f.factoryArgs.length, 0);
  assert.equal(f.store.revision, f.store.readRevision);
  assert.equal(f.store.onChange, f.store.onDidChange);
});

test("read, replace, and clear use a fixed OS vault entry, preserving JWT sanitization", async (t) => {
  const f = fixture(t);
  assert.equal(await f.store.read(), null);
  await f.store.replace(`  Bearer '${TOKEN_A}'  `);
  assert.equal(await f.store.read(), TOKEN_A);
  assert.deepEqual(f.factoryArgs, [[SERVICE, ACCOUNT, { linux: { store: "secret-service" } }]]);
  const first = await f.store.readRevision();
  await f.store.replace(TOKEN_B);
  assert.notEqual(await f.store.readRevision(), first);
  await f.store.clear();
  assert.equal(await f.store.read(), null);
  await f.store.clear();
  assert.equal(await f.store.read(), null);
});

test("Entry constructor injection also forces durable Secret Service on Linux", async (t) => {
  const f = fixture(t);
  let received;
  class FakeEntry { constructor(...args) { received = args; } getPassword() { return null; } setPassword() {} deletePassword() { return false; } }
  const store = createCredentialStore({ Entry: FakeEntry, stateDir: f.stateDir });
  assert.equal(await store.read(), null);
  assert.deepEqual(received, [SERVICE, ACCOUNT, { linux: { store: "secret-service" } }]);
});

test("no JWT, account, or token hash is written to the nonsecret revision file", async (t) => {
  const f = fixture(t);
  await f.store.replace(TOKEN_A);
  assert.deepEqual(fs.readdirSync(f.stateDir), [REVISION_FILE]);
  const contents = fs.readFileSync(path.join(f.stateDir, REVISION_FILE), "utf8");
  assert.ok(!contents.includes(TOKEN_A));
  assert.deepEqual(Object.keys(JSON.parse(contents)).sort(), ["phase", "revision", "version"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.stateDir, REVISION_FILE)).mode & 0o777, 0o600);
});

test("empty, control-containing, multiline, and oversized inputs never reach the vault", async (t) => {
  const f = fixture(t);
  for (const value of ["", "  ", null, "Bearer   ", "abc\ndef", "abc def", "abc\u00a0def", "abc\u2028def", "abc\u0000def", "a".repeat(MAX_CREDENTIAL_LENGTH + 1)]) {
    await assert.rejects(f.store.replace(value), { code: "INVALID_JWT" });
  }
  assert.equal(f.factoryArgs.length, 0);
  assert.equal(await f.store.readRevision(), "absent");
});

test("a missing or inaccessible vault is sanitized without plaintext fallback", async (t) => {
  const f = fixture(t);
  const store = createCredentialStore({ stateDir: f.stateDir, entryFactory() { throw new Error(`native backend: ${TOKEN_A}`); } });
  await assert.rejects(store.read(), noSecret);
  await assert.rejects(store.replace(TOKEN_A), noSecret);
  await assert.rejects(store.readRevision(), noSecret);
  assert.equal(fs.readdirSync(f.stateDir).length, 1);
});

test("native read, write, and clear failures never expose raw messages", async (t) => {
  for (const operation of ["read", "replace", "clear"]) {
    const f = fixture(t, { [({ read: "getPassword", replace: "setPassword", clear: "deletePassword" })[operation]]() { throw Object.assign(new Error(TOKEN_A), { code: TOKEN_A }); } });
    await assert.rejects(f.store[operation](TOKEN_A), noSecret);
  }
});

test("invalid contents returned by a vault fail closed", async (t) => {
  for (const value of ["", "abc\ndef", 42, { jwt: TOKEN_A }]) {
    const f = fixture(t, { getPassword: () => value });
    await assert.rejects(f.store.read(), noSecret);
  }
});

test("a credential change invalidates a pending vault read", async (t) => {
  const pending = deferred();
  const f = fixture(t, { getPassword: () => pending.promise });
  const read = f.store.read();
  await turn();
  await f.another().replace(TOKEN_B);
  pending.resolve(TOKEN_A);
  await assert.rejects(read, noSecret);
});

test("marker is changing before vault mutation and ready only after success", async (t) => {
  const mutation = deferred();
  const f = fixture(t, { setPassword: () => mutation.promise });
  const write = f.store.replace(TOKEN_A);
  await turn();
  await assert.rejects(f.another().readRevision(), noSecret);
  await assert.rejects(f.another().read(), noSecret);
  assert.deepEqual(f.calls, []);
  mutation.resolve();
  await write;
  assert.match(await f.store.readRevision(), /^[a-f0-9-]{36}$/u);
});

test("failed mutation stays fail-closed and a successful owner retry recovers", async (t) => {
  let fail = true;
  const f = fixture(t, { setPassword() { if (fail) throw new Error(TOKEN_A); } });
  await assert.rejects(f.store.replace(TOKEN_A), noSecret);
  await assert.rejects(f.store.read(), noSecret);
  assert.ok(!fs.existsSync(path.join(f.stateDir, LOCK_FILE)));
  fail = false;
  await f.store.replace(TOKEN_B);
  assert.match(await f.store.readRevision(), /^[a-f0-9-]{36}$/u);
});

test("queued set then clear preserves order while cross-process concurrent writes fail closed", async (t) => {
  const pending = deferred();
  const called = [];
  const f = fixture(t, { async setPassword() { called.push("set-start"); await pending.promise; called.push("set-end"); }, deletePassword() { called.push("clear"); return true; } });
  const set = f.store.replace(TOKEN_A);
  const clear = f.store.clear();
  await turn();
  await assert.rejects(f.another().clear(), noSecret);
  assert.deepEqual(called, ["set-start"]);
  pending.resolve();
  await Promise.all([set, clear]);
  assert.deepEqual(called, ["set-start", "set-end", "clear"]);
});

test("corrupt, symlinked, or public revision files are rejected without touching the vault", async (t) => {
  const f = fixture(t);
  const marker = path.join(f.stateDir, REVISION_FILE);
  for (const contents of ["not json", "{}", JSON.stringify({ version: 1, revision: TOKEN_A, phase: "ready" }), "x".repeat(257)]) {
    fs.writeFileSync(marker, contents, { mode: 0o600 });
    await assert.rejects(f.store.read(), noSecret);
  }
  fs.unlinkSync(marker);
  fs.symlinkSync(path.join(f.stateDir, "missing"), marker);
  await assert.rejects(f.store.read(), noSecret);
  fs.unlinkSync(marker);
  await f.store.replace(TOKEN_A);
  if (process.platform !== "win32") {
    fs.chmodSync(marker, 0o644);
    await assert.rejects(f.store.read(), noSecret);
  }
  assert.ok(!f.calls.includes("read"));
});

test("public or symlinked state directories are not used", async (t) => {
  const f = fixture(t);
  if (process.platform !== "win32") {
    fs.chmodSync(f.stateDir, 0o755);
    await assert.rejects(f.store.replace(TOKEN_A), noSecret);
    fs.chmodSync(f.stateDir, 0o700);
  }
  const linked = path.join(f.stateDir, "link");
  fs.symlinkSync(f.stateDir, linked, "dir");
  const store = createCredentialStore({ stateDir: linked, entryFactory: () => f.entry });
  await assert.rejects(store.read(), noSecret);
});

test("onDidChange observes nonsecret marker changes without reading the vault", async (t) => {
  const f = fixture(t);
  await f.store.replace(TOKEN_A);
  const changed = deferred();
  const watching = f.store.onDidChange(changed.resolve);
  t.after(() => watching.dispose());
  // Give watchFile's asynchronous initial stat a baseline before replacing it.
  await new Promise(resolve => setTimeout(resolve, 250));
  await f.another().replace(TOKEN_B);
  let timer;
  try {
    await Promise.race([changed.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("watch timeout")), 10_000); })]);
  } finally { clearTimeout(timer); }
  assert.ok(!f.calls.includes("read"));
  watching.dispose();
});

test("explicit recovery refuses a live lock and removes only a dead lock", async (t) => {
  const f = fixture(t);
  const lock = path.join(f.stateDir, LOCK_FILE);
  fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  assert.throws(() => f.store.recoverInterruptedWrite(), noSecret);
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(child.status, 0);
  fs.writeFileSync(lock, `${child.pid}\n`);
  assert.equal(f.store.recoverInterruptedWrite(), true);
  assert.equal(f.store.recoverInterruptedWrite(), false);
  assert.equal(f.factoryArgs.length, 0);
});

test("state directory choices contain no credential and respect absolute XDG state paths", () => {
  assert.equal(defaultStateDir({ platform: "linux", home: "/home/synthetic", env: {} }), "/home/synthetic/.local/state/krill-usage-codex");
  assert.equal(defaultStateDir({ platform: "linux", home: "/home/synthetic", env: { XDG_STATE_HOME: "/tmp/synthetic-state" } }), "/tmp/synthetic-state/krill-usage-codex");
  assert.equal(defaultStateDir({ platform: "linux", home: "/home/synthetic", env: { XDG_STATE_HOME: "relative" } }), "/home/synthetic/.local/state/krill-usage-codex");
  assert.match(defaultStateDir({ platform: "darwin", home: "/Users/synthetic", env: {} }), /Library\/Application Support/u);
  assert.match(defaultStateDir({ platform: "win32", home: "/synthetic", env: { LOCALAPPDATA: "/local" } }), /local\/krill-usage-codex$/u);
});

test("hidden input emits no token or asterisks and restores terminal state", async () => {
  const tty = terminal();
  const promise = hiddenInput(tty);
  tty.send(`${TOKEN_A}\r`);
  assert.equal(await promise, TOKEN_A);
  assert.ok(!tty.written().includes(TOKEN_A));
  assert.ok(!tty.written().includes("*"));
  assert.deepEqual(tty.input.rawModes, [true, false]);
  assert.equal(tty.input.readableFlowing, false);
  assert.equal(tty.input.listenerCount("data"), 0);
  assert.equal(tty.signals.listenerCount("SIGTERM"), 0);
});

test("hidden input supports backspace, erase-line, and bracketed paste without echo", async () => {
  const tty = terminal();
  const promise = hiddenInput(tty);
  tty.send("discard\u0015abcX\u007f\u001b[200~def\u001b[201~\r");
  assert.equal(await promise, "abcdef");
  assert.ok(!tty.written().includes("abcdef"));
});

test("cancellation and end-of-input restore raw mode and drop secret input", async () => {
  for (const cancel of [tty => tty.send("\u0003"), tty => tty.send("\u0004"), tty => tty.send("\u001a"), tty => tty.input.emit("end"), tty => tty.signals.emit("SIGTERM")]) {
    const tty = terminal();
    const promise = hiddenInput(tty);
    tty.send(TOKEN_A);
    cancel(tty);
    await assert.rejects(promise, { code: "CANCELLED" });
    assert.equal(tty.input.isRaw, false);
    assert.ok(!tty.written().includes(TOKEN_A));
  }
});

test("hidden input rejects redirection, invalid controls, and oversized input", async () => {
  await assert.rejects(hiddenInput(terminal({ isTTY: false })), { code: "TTY_REQUIRED" });
  for (const value of ["\u0000", "x".repeat(MAX_CREDENTIAL_LENGTH + 1)]) {
    const tty = terminal();
    const promise = hiddenInput(tty);
    tty.send(value);
    assert.equal(tty.input.isRaw, true, "invalid input must remain hidden until a boundary");
    tty.send("\r");
    await assert.rejects(promise, { code: "INVALID_JWT" });
    assert.equal(tty.input.isRaw, false);
  }
});

test("CLI help and rejected token arguments never initialize the store or echo args", async () => {
  for (const args of [[], ["--help"], ["set", TOKEN_A], ["clear", "--yes"], [TOKEN_A]]) {
    const tty = terminal({ isTTY: false });
    let created = 0;
    const code = await runCredentialCli(args, { ...tty, storeFactory() { created++; throw new Error("must not reach"); } });
    assert.equal(created, 0);
    assert.equal(code, args.length === 0 || args[0] === "--help" ? 0 : 2);
    assert.ok(!tty.written().includes(TOKEN_A));
  }
});

test("CLI set requires a TTY and passes only hidden input to vault adapter", async () => {
  const nonTTY = terminal({ isTTY: false });
  assert.equal(await runCredentialCli(["set"], { ...nonTTY, storeFactory() { throw new Error("must not reach"); } }), 1);
  const tty = terminal();
  let saved;
  const result = runCredentialCli(["set"], { ...tty, storeFactory: () => ({ replace: async value => { saved = value; } }) });
  tty.send(`${TOKEN_A}\r`);
  assert.equal(await result, 0);
  assert.equal(saved, TOKEN_A);
  assert.ok(!tty.written().includes(TOKEN_A));
});

test("CLI clear requires explicit CLEAR; cancellation makes no store calls", async () => {
  for (const answer of ["no", "yes", "", "CLEAR"]) {
    const tty = terminal();
    let cleared = false;
    const result = runCredentialCli(["clear"], { ...tty, storeFactory: () => ({ clear: async () => { cleared = true; } }) });
    tty.send(`${answer}\r`);
    assert.equal(await result, answer === "CLEAR" ? 0 : 130);
    assert.equal(cleared, answer === "CLEAR");
  }
});

test("CLI recovery requires its own confirmation and never calls credential operations", async () => {
  for (const answer of ["", "CLEAR", "RECOVER"]) {
    const tty = terminal();
    let recovered = false;
    const result = runCredentialCli(["recover"], { ...tty, storeFactory: () => ({ recoverInterruptedWrite: () => { recovered = true; } }) });
    tty.send(`${answer}\r`);
    assert.equal(await result, answer === "RECOVER" ? 0 : 130);
    assert.equal(recovered, answer === "RECOVER");
  }
});

test("CLI sanitizes even adversarial raw storage error details", async () => {
  const tty = terminal();
  const result = runCredentialCli(["set"], { ...tty, storeFactory: () => ({ replace: async () => { throw Object.assign(new Error(TOKEN_A), { code: TOKEN_A }); } }) });
  tty.send(`${TOKEN_A}\r`);
  assert.equal(await result, 1);
  assert.ok(!tty.written().includes(TOKEN_A));
  assert.match(tty.written(), /No plaintext fallback/u);
});

test("actual CLI subprocess rejects piped setup without a native vault read", () => {
  const cliPath = path.join(__dirname, "../src/credential-cli.cjs");
  const result = spawnSync(process.execPath, [cliPath, "set"], { input: `${TOKEN_A}\n`, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /interactive terminal/u);
  assert.ok(!result.stderr.includes(TOKEN_A));
});


test("bracketed paste wrappers and data are parsed safely at every split point", async () => {
  const framed = `\u001b[200~${TOKEN_A}\u001b[201~`;
  for (let split = 1; split < framed.length; split++) {
    const tty = terminal();
    const promise = hiddenInput(tty);
    tty.send(framed.slice(0, split));
    assert.equal(tty.input.isRaw, true, `raw mode after split ${split}`);
    tty.send(framed.slice(split));
    assert.equal(tty.input.isRaw, true, "valid paste waits for owner Enter");
    tty.send("\r");
    assert.equal(await promise, TOKEN_A);
    assert.ok(!tty.written().includes(TOKEN_A));
  }
  const tty = terminal();
  const promise = hiddenInput(tty);
  for (const character of framed) {
    tty.send(character);
    assert.equal(tty.input.isRaw, true);
  }
  tty.send("\r");
  assert.equal(await promise, TOKEN_A);
});

test("oversized, control, multiline, and cancelled pastes drain their entire closing wrapper", async () => {
  for (const [contents, code] of [
    ["x".repeat(MAX_CREDENTIAL_LENGTH + 1), "INVALID_JWT"],
    [`${TOKEN_A}\u0000${TOKEN_B}`, "INVALID_JWT"],
    [`${TOKEN_A}\n${TOKEN_B}`, "INVALID_JWT"],
    [`${TOKEN_A}\u0003${TOKEN_B}`, "CANCELLED"],
    [`${TOKEN_A}\u0004${TOKEN_B}`, "CANCELLED"],
    [`${TOKEN_A}\u001a${TOKEN_B}`, "CANCELLED"],
    [`${TOKEN_A}\u001b[AX${TOKEN_B}`, "INVALID_JWT"]
  ]) {
    for (let split = 1; split < "\u001b[201~".length; split++) {
      const tty = terminal();
      const promise = hiddenInput(tty);
      const rejection = assert.rejects(promise, { code });
      tty.send("\u001b[200~");
      tty.send(contents);
      assert.equal(tty.input.isRaw, true, "paste failure must not re-enable terminal echo");
      tty.send("\u001b[201~".slice(0, split));
      assert.equal(tty.input.isRaw, true, "partial closing wrapper must remain hidden");
      tty.send("\u001b[201~".slice(split));
      await rejection;
      assert.equal(tty.input.isRaw, false);
      assert.ok(!tty.written().includes(TOKEN_A));
      assert.ok(!tty.written().includes(TOKEN_B));
    }
  }
});

test("incomplete Escape and signals during a paste never prematurely restore echo", async () => {
  const tty = terminal();
  const promise = hiddenInput(tty);
  const rejection = assert.rejects(promise, { code: "CANCELLED" });
  tty.send("\u001b[20");
  assert.equal(tty.input.isRaw, true);
  tty.signals.emit("SIGINT");
  assert.equal(tty.input.isRaw, true);
  tty.send(`0~${TOKEN_A}`);
  assert.equal(tty.input.isRaw, true);
  tty.signals.emit("SIGTERM");
  assert.equal(tty.input.isRaw, true);
  tty.send("\u001b[201~");
  await rejection;
  assert.equal(tty.input.isRaw, false);
  assert.ok(!tty.written().includes(TOKEN_A));
});

test("unknown split escape controls remain hidden until the owner submits or cancels", async () => {
  const tty = terminal();
  const promise = hiddenInput(tty);
  tty.send("\u001b");
  assert.equal(tty.input.isRaw, true);
  tty.send(`[9bad${TOKEN_A}`);
  assert.equal(tty.input.isRaw, true);
  tty.send("\r");
  await assert.rejects(promise, { code: "INVALID_JWT" });
  assert.ok(!tty.written().includes(TOKEN_A));
});
