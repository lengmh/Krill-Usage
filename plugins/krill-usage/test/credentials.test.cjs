"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createCredentialStore, defaultStateDir, SERVICE, ACCOUNT, REVISION_FILE, LOCK_FILE, MAX_CREDENTIAL_LENGTH } = require("../src/credentials.cjs");
const { runCredentialCli } = require("../src/credential-cli.cjs");

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

function cliOutput() {
  let written = "";
  const accesses = [];
  const trap = operation => property => { accesses.push([operation, property]); throw new Error("Terminal input must not be accessed"); };
  const input = new Proxy({}, { get: trap("get"), set: trap("set"), has: trap("has"), ownKeys: trap("ownKeys"), getOwnPropertyDescriptor: trap("getOwnPropertyDescriptor") });
  return { input, output: { write(value) { written += value; } }, written: () => written, accesses };
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
  for (const value of ["", "  ", null, "Bearer   ", "abc\ndef", "abc def", "abc\u00a0def", "abc\u2028def", "abc\u0000def", TOKEN_A + "\r\n", "\n" + TOKEN_A, "\u0085" + TOKEN_A, "\u2028" + TOKEN_A, "a".repeat(MAX_CREDENTIAL_LENGTH + 1)]) {
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
  await t.test("symlinked revision file is rejected", async (symlinkTest) => {
    try { fs.symlinkSync(path.join(f.stateDir, "missing"), marker, "file"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
        symlinkTest.skip("Windows runner does not permit creating symbolic links");
        return;
      }
      throw error;
    }
    try { await assert.rejects(f.store.read(), noSecret); }
    finally { fs.unlinkSync(marker); }
  });
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
  await t.test("symlinked state directory is rejected", async (symlinkTest) => {
    const linked = path.join(f.stateDir, "link");
    try { fs.symlinkSync(f.stateDir, linked, "dir"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
        symlinkTest.skip("Windows runner does not permit creating symbolic links");
        return;
      }
      throw error;
    }
    try {
      const store = createCredentialStore({ stateDir: linked, entryFactory: () => f.entry });
      await assert.rejects(store.read(), noSecret);
    } finally { fs.unlinkSync(linked); }
  });
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
  assert.throws(() => f.store.recoverInterruptedWrite(), { code: "RECOVERY_LIVE_LOCK" });
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(child.status, 0);
  fs.writeFileSync(lock, `${child.pid}\n`);
  assert.equal(f.store.recoverInterruptedWrite(), true);
  assert.equal(f.store.recoverInterruptedWrite(), false);
  assert.equal(f.factoryArgs.length, 0);
});

test("state directory choices contain no credential and respect absolute XDG state paths", () => {
  assert.equal(defaultStateDir({ platform: "linux", home: "/home/synthetic", env: {} }), path.join("/home/synthetic", ".local", "state", "krill-usage-codex"));
  assert.equal(defaultStateDir({ platform: "linux", home: "/home/synthetic", env: { XDG_STATE_HOME: "/tmp/synthetic-state" } }), path.join("/tmp/synthetic-state", "krill-usage-codex"));
  assert.equal(defaultStateDir({ platform: "linux", home: "/home/synthetic", env: { XDG_STATE_HOME: "relative" } }), path.join("/home/synthetic", ".local", "state", "krill-usage-codex"));
  assert.equal(defaultStateDir({ platform: "darwin", home: "/Users/synthetic", env: {} }), path.join("/Users/synthetic", "Library", "Application Support", "krill-usage-codex"));
  assert.equal(defaultStateDir({ platform: "win32", home: "/synthetic", env: { LOCALAPPDATA: "/local" } }), path.join("/local", "krill-usage-codex"));
  assert.equal(defaultStateDir({ platform: "win32", home: "/synthetic", env: {} }), path.join("/synthetic", "AppData", "Local", "krill-usage-codex"));
});

test("CLI help and missing confirmations never initialize the store or touch stdin", async () => {
  for (const [args, expectedCode, instruction] of [
    [[], 0, /clear --confirm-clear/u],
    [["--help"], 0, /recover --manual --confirm-stopped/u],
    [["clear"], 2, /clear --confirm-clear/u],
    [["recover"], 2, /recover --confirm-stopped/u],
    [["recover", "--manual"], 2, /recover --manual --confirm-stopped/u]
  ]) {
    const io = cliOutput();
    let created = 0;
    const code = await runCredentialCli(args, { ...io, storeFactory() { created++; throw new Error("must not reach"); } });
    assert.equal(code, expectedCode);
    assert.equal(created, 0);
    assert.deepEqual(io.accesses, []);
    assert.match(io.written(), instruction);
    if (args[0] === "clear") assert.match(io.written(), /remove the saved JWT.*invalidate previous account data/u);
    if (args[0] === "recover") assert.match(io.written(), /Keep them stopped until the recovery command finishes/u);
  }
});

test("CLI rejects unknown, duplicate, extra, and wrong-command flags without echoing any argument", async () => {
  const cases = [
    [TOKEN_A], ["set", TOKEN_A], ["set", "--confirm-clear"],
    ["clear", "--yes"], ["clear", "--confirm-stopped"], ["clear", "--manual"],
    ["clear", "--confirm-clear", "--confirm-clear"], ["clear", "--confirm-clear", TOKEN_A],
    ["recover", "--confirm-clear"], ["recover", "--confirm-stopped", "--confirm-stopped"],
    ["recover", "--confirm-stopped", TOKEN_A], ["recover", "--manual=true"],
    ["recover", "--manual", "--yes"], ["recover", "--manual", "--confirm-clear"],
    ["recover", "--manual", "--manual", "--confirm-stopped"],
    ["recover", "--manual", "--confirm-stopped", TOKEN_A]
  ];
  for (const args of cases) {
    const io = cliOutput();
    let created = 0;
    assert.equal(await runCredentialCli(args, { ...io, storeFactory() { created++; } }), 2);
    assert.equal(created, 0);
    assert.deepEqual(io.accesses, []);
    assert.equal(io.written(), "Invalid command or flags. Run --help and use exactly one documented command. JWT command arguments are not accepted.\n");
    assert.ok(!io.written().includes(TOKEN_A));
  }
});

test("source and bundled CLI use exact confirmed operations with no terminal access", async () => {
  const bundledCli = require("../dist/credential-cli.cjs").runCredentialCli;
  for (const run of [runCredentialCli, bundledCli]) {
    for (const [args, expected] of [
      [["set"], [["prompt"], ["store"], ["replace", TOKEN_A]]],
      [["clear", "--confirm-clear"], [["store"], ["clear"]]],
      [["recover", "--confirm-stopped"], [["store"], ["recover"]]],
      [["recover", "--manual", "--confirm-stopped"], [["store"], ["recover", { manual: true }]]]
    ]) {
      const io = cliOutput();
      const calls = [];
      const options = { ...io, prompt: async () => { calls.push(["prompt"]); return TOKEN_A; }, storeFactory() {
        calls.push(["store"]);
        return {
          replace: async value => calls.push(["replace", value]),
          clear: async () => calls.push(["clear"]),
          recoverInterruptedWrite: (...values) => calls.push(["recover", ...values])
        };
      } };
      assert.equal(await run(args, options), 0);
      assert.deepEqual(calls, expected);
      assert.deepEqual(io.accesses, []);
      assert.ok(!io.written().includes(TOKEN_A));
    }
  }
});

test("CLI never constructs a store for cancelled or invalid window input", async () => {
  for (const answer of [TOKEN_A + "\r", TOKEN_A + "\n", "\u0000" + TOKEN_A, "\u0085" + TOKEN_A, "\u2028" + TOKEN_A, "x".repeat(MAX_CREDENTIAL_LENGTH + 1), null]) {
    const io = cliOutput();
    let created = false;
    const result = await runCredentialCli(["set"], { ...io, prompt: async () => answer, storeFactory: () => { created = true; } });
    assert.equal(result, 1);
    assert.equal(created, false);
    assert.ok(!io.written().includes(TOKEN_A));
  }
  const io = cliOutput();
  const result = await runCredentialCli(["set"], { ...io, prompt: async () => { throw Object.assign(new Error(TOKEN_A), { code: "CANCELLED" }); }, storeFactory() { throw new Error("must not reach"); } });
  assert.equal(result, 130);
  assert.ok(!io.written().includes(TOKEN_A));
});

test("CLI sanitizes even adversarial raw storage error details", async () => {
  const io = cliOutput();
  const result = runCredentialCli(["set"], { ...io, prompt: async () => TOKEN_A, storeFactory: () => ({ replace: async () => { throw Object.assign(new Error(TOKEN_A), { code: TOKEN_A }); } }) });
  assert.equal(await result, 1);
  assert.ok(!io.written().includes(TOKEN_A));
  assert.match(io.written(), /No plaintext fallback/u);
});

test("actual CLI subprocess refuses unsupported-platform setup without a native vault read", { skip: process.platform === "win32" }, () => {
  const cliPath = path.join(__dirname, "../src/credential-cli.cjs");
  const result = spawnSync(process.execPath, [cliPath, "set"], { input: `${TOKEN_A}\n`, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unavailable on this platform/u);
  assert.ok(!result.stderr.includes(TOKEN_A));
});

test("built CLI refuses missing confirmation flags with multiline stdin and no store initialization", () => {
  const cliPath = path.join(__dirname, "../dist/credential-cli.cjs");
  const guardPath = path.join(__dirname, "fixtures/credential-cli-guard.cjs");
  for (const args of [["clear"], ["recover"], ["recover", "--manual"]]) {
    const result = spawnSync(process.execPath, ["--require", guardPath, cliPath, ...args], {
      input: `${TOKEN_A}\nsynthetic-paste-tail\n`, encoding: "utf8", timeout: 5_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--confirm-(?:clear|stopped)/u);
    assert.ok(!result.stderr.includes(TOKEN_A));
    assert.ok(!result.stderr.includes("synthetic-paste-tail"));
    assert.ok(!result.stderr.includes("guard violation"));
  }
});
