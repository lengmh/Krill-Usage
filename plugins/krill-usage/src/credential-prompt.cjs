"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");

const MAX_CREDENTIAL_LENGTH = 16_384;
const MAX_OUTPUT_BYTES = MAX_CREDENTIAL_LENGTH * 4;
const MAX_ACCOUNT_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 4096;
const MAX_LOGIN_OUTPUT_BYTES = (MAX_PASSWORD_LENGTH + MAX_ACCOUNT_LENGTH) * 6 + 128;
const MESSAGES = {
  INVALID_LOGIN: "Enter a nonempty account (up to 320 characters) and password (up to 4,096 characters), without line breaks or control characters.",
  INVALID_JWT: "Enter one nonempty JWT without line breaks or control characters in the secure window.",
  CANCELLED: "Cancelled. Your saved credential was not changed.",
  PROMPT_UNSUPPORTED: "Secure credential entry currently supports Windows 10/11 with .NET Framework 4.8 or later. Setup is unavailable on this platform; there is no terminal or stdin fallback.",
  PROMPT_UNAVAILABLE: "The secure credential window could not start or finish safely. On Windows 10/11, rebuild the plugin with .NET Framework 4.8 or later installed, then retry. No credential was saved."
};
function promptError(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }

// Check the ORIGINAL value before sanitizeJwt can trim away invalid input.
function validateRawCredential(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CREDENTIAL_LENGTH ||
      !value.isWellFormed() || !value.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw promptError("INVALID_JWT");
  }
  return value;
}

function validateLogin(value) {
  const validText = (text, maximum) => typeof text === "string" && text.length > 0 &&
    text.length <= maximum && text.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 3 || !validText(value.account, MAX_ACCOUNT_LENGTH) ||
      !value.account.trim() || !validText(value.password, MAX_PASSWORD_LENGTH) ||
      typeof value.rememberPassword !== "boolean") throw promptError("INVALID_LOGIN");
  return { account: value.account.trim(), password: value.password, rememberPassword: value.rememberPassword };
}
function promptCredential(options = {}) { return promptHelper(options, false); }
function promptLogin(options = {}) { return promptHelper(options, true); }

/** The helper receives no secret arguments, environment, stdin, or files.
 * Its empty stdin pipe stays open solely to detect parent-process termination. */
function promptHelper({ platform = process.platform, spawnHelper = spawn, signals = process } = {}, login) {
  const invalidCode = login ? "INVALID_LOGIN" : "INVALID_JWT";
  const maximumOutput = login ? MAX_LOGIN_OUTPUT_BYTES : MAX_OUTPUT_BYTES;
  if (platform !== "win32") return Promise.reject(promptError("PROMPT_UNSUPPORTED"));
  return new Promise((resolve, reject) => {
    let child;
    try {
      // The helper is a GUI-subsystem EXE, so it creates no console. Do not
      // request SW_HIDE: Windows must be allowed to show its PasswordBox window.
      child = spawnHelper(path.join(__dirname, "CredentialPrompt.exe"), login ? ["--login"] : [], {
        shell: false, windowsHide: false, stdio: ["pipe", "pipe", "pipe"]
      });
    } catch { reject(promptError("PROMPT_UNAVAILABLE")); return; }
    let chunks = [];
    let size = 0;
    let stdoutEnded = false;
    let stderrEnded = false;
    let rejectedCode;
    let settled = false;
    const signalNames = ["SIGINT", "SIGTERM", "SIGHUP"];
    const discard = () => { for (const chunk of chunks) chunk.fill(0); chunks = []; size = 0; };
    const fail = (code) => {
      if (!rejectedCode) rejectedCode = code;
      discard();
      try { child.kill(); } catch {}
    };
    const cancel = () => fail("CANCELLED");
    const streamError = () => fail("PROMPT_UNAVAILABLE");
    const childError = () => fail("PROMPT_UNAVAILABLE");
    function finish(code, signal) {
      if (settled) return;
      settled = true;
      for (const name of signalNames) signals.removeListener(name, cancel);
      child.removeListener("error", childError);
      child.stdin?.removeListener("error", streamError);
      child.stdout?.removeListener("error", streamError);
      child.stderr?.removeListener("error", streamError);
      let bytes;
      try {
        if (rejectedCode) throw promptError(rejectedCode);
        if (code === 130) throw promptError("CANCELLED");
        if (code !== 0 || signal || !stdoutEnded || !stderrEnded) throw promptError("PROMPT_UNAVAILABLE");
        bytes = Buffer.concat(chunks, size);
        let value;
        try { value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw promptError(invalidCode); }
        if (login) {
          let parsed;
          try { parsed = JSON.parse(value); } catch { throw promptError(invalidCode); }
          resolve(validateLogin(parsed));
        } else resolve(validateRawCredential(value));
      } catch (error) { reject(promptError(Object.prototype.hasOwnProperty.call(MESSAGES, error?.code) ? error.code : "PROMPT_UNAVAILABLE")); }
      finally {
        bytes?.fill(0);
        discard();
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    }
    child.once("error", childError);
    child.once("close", finish); // close occurs after child exit AND its stdio closes.
    if (!child.stdin || !child.stdout || !child.stderr) { fail("PROMPT_UNAVAILABLE"); return; }
    child.stdout.on("data", chunk => {
      if (rejectedCode) { if (Buffer.isBuffer(chunk)) chunk.fill(0); return; }
      if (!Buffer.isBuffer(chunk) || size + chunk.length > maximumOutput) {
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
        fail(invalidCode); return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    // The helper never emits diagnostics. Refuse any stderr without decoding or logging it.
    child.stderr.on("data", chunk => { if (Buffer.isBuffer(chunk)) chunk.fill(0); fail("PROMPT_UNAVAILABLE"); });
    child.stdout.once("end", () => { stdoutEnded = true; });
    child.stderr.once("end", () => { stderrEnded = true; });
    child.stdin.on("error", streamError);
    child.stdout.on("error", streamError);
    child.stderr.on("error", streamError);
    for (const name of signalNames) signals.once(name, cancel);
  });
}

module.exports = { validateLoginCredentials: validateLogin, MAX_PASSWORD_LENGTH, promptLogin, validateLogin, MAX_ACCOUNT_LENGTH, MAX_LOGIN_OUTPUT_BYTES, promptCredential, validateRawCredential, MAX_CREDENTIAL_LENGTH, MAX_OUTPUT_BYTES, MESSAGES };
