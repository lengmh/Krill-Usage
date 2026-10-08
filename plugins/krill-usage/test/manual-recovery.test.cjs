"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");
const { createCredentialStore, LOCK_FILE, REVISION_FILE } = require("../src/credentials.cjs");
const { runCredentialCli } = require("../src/credential-cli.cjs");

const TOKEN = "synthetic-recovery-credential";
const CONFIRM = "STOPPED UNTIL DONE";
const PRESERVED_FILES = ["synthetic-vault", REVISION_FILE, "preferences.json", "preferences.lock"];

function fixture(t, lockText = "") {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "krill-manual-recovery-test-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const lock = path.join(stateDir, LOCK_FILE);
  const calls = [];
  class FakeEntry {
    constructor() { calls.push("construct"); }
    getPassword() { calls.push("read"); return fs.readFileSync(path.join(stateDir, "synthetic-vault"), "utf8"); }
    setPassword(value) { calls.push("set"); fs.writeFileSync(path.join(stateDir, "synthetic-vault"), value); }
    deletePassword() { calls.push("clear"); fs.writeFileSync(path.join(stateDir, "synthetic-vault"), ""); return true; }
  }
  for (const name of PRESERVED_FILES) fs.writeFileSync(path.join(stateDir, name), name === "synthetic-vault" ? TOKEN : `synthetic unchanged ${name}\n`, { mode: 0o600 });
  if (lockText !== null) fs.writeFileSync(lock, lockText, { mode: 0o600 });
  const store = createCredentialStore({ Entry: FakeEntry, stateDir });
  const snapshot = () => PRESERVED_FILES.map(name => fs.readFileSync(path.join(stateDir, name)));
  return { stateDir, lock, calls, store, snapshot };
}

function terminal({ inputTTY = true, outputTTY = true } = {}) {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: inputTTY, isRaw: false, readableFlowing: false, setRawMode(value) { this.isRaw = value; }, resume() {}, pause() {} });
  let written = "";
  return { input, output: { isTTY: outputTTY, write(value) { written += value; } }, signals: new EventEmitter(), written: () => written, send: value => input.emit("data", Buffer.from(value)) };
}

async function runRecovery(store, args = ["recover", "--manual"], answer = CONFIRM) {
  const tty = terminal();
  const result = runCredentialCli(args, { ...tty, storeFactory: () => store });
  tty.send(`${answer}\r`);
  return { code: await result, written: tty.written() };
}

test("default recovery leaves unknown owners locked and points to manual recovery", async (t) => {
  for (const contents of ["", "not-a-pid", "0", "99999999999999999999999999999999"]) {
    const f = fixture(t, contents);
    const before = f.snapshot();
    const result = await runRecovery(f.store, ["recover"], "RECOVER");
    assert.equal(result.code, 1);
    assert.match(result.written, /recover --manual/u);
    assert.equal(fs.readFileSync(f.lock, "utf8"), contents);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.calls, []);
  }
});

test("confirmed manual recovery removes only empty or malformed locks, then set or clear works", async (t) => {
  for (const contents of ["", "not-a-pid", "0", "99999999999999999999999999999999"]) {
    for (const operation of ["set", "clear"]) {
      const f = fixture(t, contents);
      const before = f.snapshot();
      const result = await runRecovery(f.store);
      assert.equal(result.code, 0);
      assert.match(result.written, /Keep them stopped until this command finishes/u);
      assert.equal(fs.existsSync(f.lock), false);
      assert.deepEqual(f.snapshot(), before, "recovery must preserve vault, marker, and preferences bytes");
      assert.deepEqual(f.calls, [], "recovery must not initialize or access the vault");
      assert.ok(!result.written.includes(TOKEN));
      if (contents.length > 1) assert.ok(!result.written.includes(contents));
      const tty = terminal();
      const resultAfter = runCredentialCli([operation], { ...tty, prompt: async () => "synthetic-new-credential", storeFactory: () => f.store });
      if (operation === "clear") tty.send("CLEAR\r");
      assert.equal(await resultAfter, 0);
      assert.deepEqual(f.calls, ["construct", operation]);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, REVISION_FILE), "utf8")).phase, "ready");
      assert.deepEqual(f.snapshot().slice(2), before.slice(2));
    }
  }
});

test("manual recovery requires its exact separate confirmation; cancellation makes no store calls", async () => {
  for (const answer of ["", "RECOVER", "CLEAR", "yes", "stopped until done", "STOPPED UNTIL DONE ", "\u0003", "\u0004"]) {
    const tty = terminal();
    let calls = 0;
    const result = runCredentialCli(["recover", "--manual"], { ...tty, storeFactory() { calls++; throw new Error(TOKEN); } });
    tty.send(`${answer}\r`);
    assert.equal(await result, 130);
    assert.equal(calls, 0);
    assert.equal(tty.input.isRaw, false);
    assert.ok(!tty.written().includes(TOKEN));
  }
  for (const cancel of [tty => tty.input.emit("end"), tty => tty.signals.emit("SIGTERM")]) {
    const tty = terminal();
    let calls = 0;
    const result = runCredentialCli(["recover", "--manual"], { ...tty, storeFactory() { calls++; } });
    cancel(tty);
    assert.equal(await result, 130);
    assert.equal(calls, 0);
  }
});

test("manual recovery rejects either redirected stream, missing raw mode, and extra arguments", async () => {
  for (const options of [{ inputTTY: false }, { outputTTY: false }, { inputTTY: false, outputTTY: false }, { missingRaw: true }]) {
    const tty = terminal(options);
    if (options.missingRaw) delete tty.input.setRawMode;
    let calls = 0;
    assert.equal(await runCredentialCli(["recover", "--manual"], { ...tty, storeFactory() { calls++; } }), 1);
    assert.equal(calls, 0);
    assert.match(tty.written(), /interactive terminal/u);
  }
  for (const args of [["recover", "--manual", TOKEN], ["recover", "--manual", "--yes"], ["recover", "--manual", CONFIRM], ["recover", "--manual", "/tmp/arbitrary"], ["recover", "--manual", "123"], ["recover", "--manual=true"], ["recover", TOKEN], ["set", "--manual"], ["clear", "--manual"]]) {
    const tty = terminal();
    let calls = 0;
    assert.equal(await runCredentialCli(args, { ...tty, storeFactory() { calls++; } }), 2);
    assert.equal(calls, 0);
    assert.ok(!tty.written().includes(TOKEN));
    assert.ok(!tty.written().includes("/tmp/arbitrary"));
    assert.ok(!tty.written().includes("123"));
  }
});

test("known live PID and unverifiable PID refuse even with manual confirmation", async (t) => {
  const f = fixture(t, `${process.pid}\n`);
  const before = f.snapshot();
  for (const args of [["recover"], ["recover", "--manual"]]) {
    const result = await runRecovery(f.store, args, args.length === 1 ? "RECOVER" : CONFIRM);
    assert.equal(result.code, 1);
    assert.match(result.written, /Manual recovery cannot override/u);
    assert.equal(fs.readFileSync(f.lock, "utf8"), `${process.pid}\n`);
    assert.deepEqual(f.snapshot(), before);
  }
  const kill = t.mock.method(process, "kill", () => { throw Object.assign(new Error(TOKEN), { code: "EPERM" }); });
  const result = await runRecovery(f.store);
  kill.mock.restore();
  assert.equal(result.code, 1);
  assert.match(result.written, /cannot be verified as stopped/u);
  assert.ok(!result.written.includes(TOKEN));
  assert.equal(fs.existsSync(f.lock), true);
  assert.deepEqual(f.calls, []);
});

test("numeric PIDs outside the runtime range still require proof of exit", (t) => {
  const f = fixture(t, "2147483648\n");
  const probed = [];
  const kill = t.mock.method(process, "kill", pid => { probed.push(pid); throw Object.assign(new Error(TOKEN), { code: "ERR_OUT_OF_RANGE" }); });
  for (const manual of [false, true]) assert.throws(() => f.store.recoverInterruptedWrite({ manual }), { code: "RECOVERY_LIVE_LOCK" });
  kill.mock.restore();
  assert.deepEqual(probed, [2147483648, 2147483648]);
  assert.equal(fs.existsSync(f.lock), true);
  assert.deepEqual(f.calls, []);
});

test("normal and manual recovery preserve dead-PID and no-lock behavior", async (t) => {
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(child.status, 0);
  for (const manual of [false, true]) {
    const f = fixture(t, `${child.pid}\n`);
    const before = f.snapshot();
    assert.equal(f.store.recoverInterruptedWrite({ manual }), true);
    assert.equal(f.store.recoverInterruptedWrite({ manual }), false);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.calls, []);
    const missingState = path.join(f.stateDir, "missing-state");
    assert.equal(createCredentialStore({ stateDir: missingState }).recoverInterruptedWrite({ manual }), false);
    assert.equal(fs.existsSync(missingState), false);
  }
});

test("recovery refuses oversized, nonregular, linked, and nonprivate lock paths", async (t) => {
  const cases = [
    ["oversized", f => fs.writeFileSync(f.lock, "x".repeat(33))],
    ["directory", f => { fs.unlinkSync(f.lock); fs.mkdirSync(f.lock, { mode: 0o700 }); }],
    ["hardlink", f => { fs.unlinkSync(f.lock); fs.linkSync(path.join(f.stateDir, "synthetic-vault"), f.lock); }],
    ["symlink", f => { fs.unlinkSync(f.lock); fs.symlinkSync(path.join(f.stateDir, "synthetic-vault"), f.lock, "file"); }]
  ];
  if (process.platform !== "win32") cases.push(["public lock", f => fs.chmodSync(f.lock, 0o644)], ["public directory", f => fs.chmodSync(f.stateDir, 0o755)]);
  for (const [name, prepare] of cases) await t.test(name, async (subtest) => {
    const f = fixture(subtest);
    const before = f.snapshot();
    try { prepare(f); }
    catch (error) {
      if (process.platform === "win32" && name === "symlink" && ["EPERM", "EACCES"].includes(error?.code)) { subtest.skip("Windows runner does not permit creating symbolic links"); return; }
      throw error;
    }
    for (const manual of [false, true]) assert.throws(() => f.store.recoverInterruptedWrite({ manual }), { code: "RECOVERY_FAILED" });
    assert.equal(fs.existsSync(f.lock), true);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.calls, []);
  });
});

test("recovery rejects a symlinked state directory without following it", async (t) => {
  const f = fixture(t);
  const linked = path.join(f.stateDir, "linked-state");
  try { fs.symlinkSync(f.stateDir, linked, "dir"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) { t.skip("Windows runner does not permit creating symbolic links"); return; }
    throw error;
  }
  const store = createCredentialStore({ stateDir: linked });
  assert.throws(() => store.recoverInterruptedWrite({ manual: true }), { code: "RECOVERY_FAILED" });
  assert.equal(fs.existsSync(f.lock), true);
});

test("recovery rejects foreign-owned locks and directories on POSIX", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const lstat = fs.lstatSync;
  for (const target of [f.lock, f.stateDir]) {
    const mock = t.mock.method(fs, "lstatSync", function(file, ...args) {
      const stat = lstat.call(this, file, ...args);
      if (file === target) stat.uid = process.getuid() + 1;
      return stat;
    });
    assert.throws(() => f.store.recoverInterruptedWrite({ manual: true }), { code: "RECOVERY_FAILED" });
    mock.mock.restore();
  }
  assert.equal(fs.existsSync(f.lock), true);
  assert.deepEqual(f.calls, []);
});

test("recovery refuses a lock changed between lstat, open, read, or unlink checks", async (t) => {
  for (const stage of ["open-replacement", "read-replacement", "read-growth", "permission-change", "directory-replacement"]) await t.test(stage, (subtest) => {
    const f = fixture(subtest);
    const before = f.snapshot();
    let changed = false;
    const realOpen = fs.openSync;
    const realRead = fs.readSync;
    function change() {
      changed = true;
      if (stage === "read-growth") fs.appendFileSync(f.lock, "x".repeat(33));
      else if (stage === "permission-change") {
        // Portable metadata change; Windows does not enforce POSIX private bits.
        fs.utimesSync(f.lock, new Date(0), new Date(0));
      } else if (stage === "directory-replacement") {
        const old = `${f.stateDir}-old`;
        fs.renameSync(f.stateDir, old);
        subtest.after(() => fs.rmSync(old, { recursive: true, force: true }));
        fs.mkdirSync(f.stateDir, { mode: 0o700 });
        for (const name of [...PRESERVED_FILES, LOCK_FILE]) fs.renameSync(path.join(old, name), path.join(f.stateDir, name));
      } else {
        fs.renameSync(f.lock, path.join(f.stateDir, "old-lock"));
        fs.writeFileSync(f.lock, `${process.pid}\n`, { mode: 0o600 });
      }
    }
    const mock = stage === "open-replacement"
      ? subtest.mock.method(fs, "openSync", function(file, ...args) { if (file === f.lock && !changed) change(); return realOpen.call(this, file, ...args); })
      : subtest.mock.method(fs, "readSync", function(...args) { const bytes = realRead.apply(this, args); if (!changed) change(); return bytes; });
    assert.throws(() => f.store.recoverInterruptedWrite({ manual: true }), { code: "RECOVERY_FAILED" });
    mock.mock.restore();
    assert.equal(changed, true);
    assert.equal(fs.existsSync(f.lock), true);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.calls, []);
  });
});

test("manual recovery reads only its bounded lock and never loads a native module", async (t) => {
  const f = fixture(t, TOKEN);
  const before = f.snapshot();
  const load = Module._load;
  let nativeLoads = 0;
  const loadMock = t.mock.method(Module, "_load", function(request, ...args) {
    if (request.includes("@napi-rs/keyring") || request.endsWith(".node")) { nativeLoads++; throw new Error(TOKEN); }
    return load.call(this, request, ...args);
  });
  const opened = [];
  const open = fs.openSync;
  const openMock = t.mock.method(fs, "openSync", function(file, ...args) { opened.push(file); return open.call(this, file, ...args); });
  const store = createCredentialStore({ stateDir: f.stateDir });
  const result = await runRecovery(store);
  openMock.mock.restore();
  loadMock.mock.restore();
  assert.equal(result.code, 0);
  assert.deepEqual(opened, [f.lock]);
  assert.equal(nativeLoads, 0);
  assert.equal(fs.existsSync(f.lock), false);
  assert.deepEqual(f.snapshot(), before);
  assert.ok(!result.written.includes(TOKEN));
});

test("manual recovery errors are static and do not loop back to generic recover", async () => {
  const result = await runRecovery({ recoverInterruptedWrite() { throw Object.assign(new Error(TOKEN), { code: TOKEN }); } });
  assert.equal(result.code, 1);
  assert.match(result.written, /ownership, permissions, and lock file type/u);
  assert.ok(!result.written.includes(TOKEN));
  assert.ok(!result.written.includes("use recover, then"));
});

test("actual CLI subprocess rejects piped manual confirmation without changing a fixture", (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  const cli = path.join(__dirname, "../src/credential-cli.cjs");
  const result = spawnSync(process.execPath, [cli, "recover", "--manual"], { input: `${CONFIRM}\n`, encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: f.stateDir } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /interactive terminal/u);
  assert.ok(!result.stderr.includes(TOKEN));
  assert.equal(fs.existsSync(f.lock), true);
  assert.deepEqual(f.snapshot(), before);
});
