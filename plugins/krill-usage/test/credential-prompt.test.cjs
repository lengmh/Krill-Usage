"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const path = require("node:path");
const { promptLogin, validateLoginCredentials, MAX_PASSWORD_LENGTH, MAX_ACCOUNT_LENGTH, MAX_LOGIN_OUTPUT_BYTES, promptCredential, validateRawCredential, MAX_OUTPUT_BYTES, MAX_CREDENTIAL_LENGTH } = require("../src/credential-prompt.cjs");

const TOKEN = "synthetic-window-token";
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(prompt = promptCredential) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
  child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", null, "SIGTERM")); };
  const signals = new EventEmitter();
  let request;
  const result = prompt({ platform: "win32", signals, spawnHelper(...args) { request = args; return child; } });
  async function complete(code = 0) {
    child.stdout.end(); child.stderr.end();
    await turn();
    child.emit("close", code, null);
  }
  return { child, signals, result, request, complete };
}

function sanitized(error, code) {
  assert.equal(error.code, code);
  assert.ok(!String(error.stack).includes(TOKEN));
  assert.equal(error.cause, undefined);
  return true;
}

test("adapter launches only fixed local helper, with no shell, arguments, or secret channel to stdin", async () => {
  const f = fixture();
  assert.equal(f.request[0], path.join(__dirname, "../src/CredentialPrompt.exe"));
  assert.deepEqual(f.request[1], []);
  assert.deepEqual(f.request[2], { shell: false, windowsHide: false, stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(f.child.stdin.readableLength, 0);
  f.child.stdout.write(Buffer.from(TOKEN));
  await f.complete();
  assert.equal(await f.result, TOKEN);
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
  assert.equal(f.child.stdin.destroyed, true);
});

test("adapter waits for complete UTF-8, EOF, and successful exit, even when output is split", async () => {
  const bytes = Buffer.from(TOKEN + "é");
  for (let split = 1; split < bytes.length; split++) {
    const f = fixture();
    let completed = false;
    f.result.then(() => { completed = true; });
    f.child.stdout.write(Buffer.from(bytes.subarray(0, split)));
    f.child.emit("exit", 0, null);
    await turn();
    assert.equal(completed, false);
    f.child.stdout.write(Buffer.from(bytes.subarray(split)));
    await f.complete();
    assert.equal(await f.result, TOKEN + "é");
  }
});

test("raw validation rejects controls and line separators before trimming, including trailing newlines", () => {
  for (const value of [null, "", "  ", "\ud800", ...["\r", "\n", "\0", "\t", "\u007f", "\u0085", "\u2028", "\u2029"].map(c => TOKEN + c), "x".repeat(MAX_CREDENTIAL_LENGTH + 1)]) {
    assert.throws(() => validateRawCredential(value), { code: "INVALID_JWT" });
  }
  assert.equal(validateRawCredential(`  Bearer '${TOKEN}'  `), `  Bearer '${TOKEN}'  `);
});

test("malformed UTF-8, oversized output, empty and control-containing payloads fail without returning a prefix", async () => {
  for (const bytes of [Buffer.from([0xc3]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.alloc(MAX_OUTPUT_BYTES + 1, 97), Buffer.from("x".repeat(MAX_CREDENTIAL_LENGTH + 1)), Buffer.alloc(0), ...["\r\n", "\0", "\u0085", "\u2028"].map(c => Buffer.from(TOKEN + c))]) {
    const f = fixture();
    const rejected = assert.rejects(f.result, error => sanitized(error, "INVALID_JWT"));
    f.child.stdout.write(bytes);
    await f.complete();
    await rejected;
  }
});

test("cancel, nonzero exit, stderr, and incomplete streams never expose child output", async () => {
  for (const mode of ["cancel", "nonzero", "stderr", "missing-eof", "signal"]) {
    const f = fixture();
    const code = mode === "cancel" || mode === "signal" ? "CANCELLED" : "PROMPT_UNAVAILABLE";
    const rejected = assert.rejects(f.result, error => sanitized(error, code));
    f.child.stdout.write(Buffer.from(TOKEN));
    if (mode === "stderr") f.child.stderr.write(Buffer.from(TOKEN));
    if (mode === "signal") f.signals.emit("SIGTERM");
    if (mode === "missing-eof") f.child.emit("close", 0, null);
    else await f.complete(mode === "cancel" ? 130 : mode === "nonzero" ? 1 : 0);
    await rejected;
  }
});

test("helper launch errors and unavailable platforms fail closed without reading a TTY", async () => {
  const f = fixture();
  const rejected = assert.rejects(f.result, error => sanitized(error, "PROMPT_UNAVAILABLE"));
  f.child.emit("error", Object.assign(new Error(TOKEN), { code: "ENOENT" }));
  await rejected;
  await assert.rejects(promptCredential({ platform: "win32", spawnHelper() { throw new Error(TOKEN); } }), error => sanitized(error, "PROMPT_UNAVAILABLE"));
  for (const platform of ["linux", "darwin"]) {
    await assert.rejects(promptCredential({ platform, spawnHelper() { assert.fail("must not launch"); } }), { code: "PROMPT_UNSUPPORTED" });
  }
});

const LOGIN = { account: "synthetic@example.invalid", password: 'synthetic-\\-"-passwordé', rememberPassword: true };
test("login adapter uses only a fixed mode argument and returns a validated login object", async () => {
  const f = fixture(promptLogin);
  assert.deepEqual(f.request[1], ["--login"]);
  assert.deepEqual(f.request[2], { shell: false, windowsHide: false, stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(f.child.stdin.readableLength, 0);
  const bytes = Buffer.from(JSON.stringify(LOGIN));
  for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
  await f.complete();
  assert.deepEqual(await f.result, LOGIN);
});
test("login validation preserves password, trims account, and rejects invalid bounds and fields", () => {
  assert.deepEqual(validateLoginCredentials({ ...LOGIN, account: " synthetic@example.invalid ", password: "  ", rememberPassword: false }), { ...LOGIN, password: "  ", rememberPassword: false });
  assert.equal(validateLoginCredentials({ ...LOGIN, password: "x".repeat(MAX_PASSWORD_LENGTH) }).password.length, MAX_PASSWORD_LENGTH);
  assert.equal(validateLoginCredentials({ ...LOGIN, account: "x".repeat(MAX_ACCOUNT_LENGTH) }).account.length, MAX_ACCOUNT_LENGTH);
  for (const value of [null, [], {}, { ...LOGIN, extra: true }, { ...LOGIN, rememberPassword: 1 },
    ...["", " ", "x".repeat(MAX_ACCOUNT_LENGTH + 1), "x\n", "x\0", "x\u0085", "x\ud800"].map(account => ({ ...LOGIN, account })),
    ...["", "x".repeat(MAX_PASSWORD_LENGTH + 1), "x\r", "x\t", "x\u2028", "x\u2029", "x\ud800"].map(password => ({ ...LOGIN, password }))]) {
    assert.throws(() => validateLoginCredentials(value), { code: "INVALID_LOGIN" });
  }
});
test("malformed login output fails closed with sanitized errors", async () => {
  for (const bytes of [Buffer.from("not JSON"), Buffer.from(JSON.stringify({ ...LOGIN, password: "bad\n" })), Buffer.from([0xc3]), Buffer.alloc(MAX_LOGIN_OUTPUT_BYTES + 1, 97)]) {
    const f = fixture(promptLogin);
    const rejected = assert.rejects(f.result, { code: "INVALID_LOGIN" });
    f.child.stdout.write(bytes); await f.complete(); await rejected;
  }
});
test("login cancellation, stderr and signal handling keep the same secure lifecycle", async () => {
  for (const mode of ["cancel", "stderr", "signal", "nonzero", "missing-eof"]) {
    const f = fixture(promptLogin);
    const rejected = assert.rejects(f.result, { code: ["cancel", "signal"].includes(mode) ? "CANCELLED" : "PROMPT_UNAVAILABLE" });
    f.child.stdout.write(Buffer.from(JSON.stringify(LOGIN)));
    if (mode === "stderr") f.child.stderr.write(Buffer.from("synthetic diagnostic"));
    if (mode === "signal") f.signals.emit("SIGINT");
    if (mode === "missing-eof") f.child.emit("close", 0, null);
    else await f.complete(mode === "cancel" ? 130 : mode === "nonzero" ? 1 : 0);
    await rejected;
    assert.equal(f.signals.listenerCount("SIGINT"), 0);
  }
});
