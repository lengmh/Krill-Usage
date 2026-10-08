#!/usr/bin/env node
"use strict";

const { createCredentialStore, MAX_CREDENTIAL_LENGTH } = require("./credentials.cjs");

const HELP = "Krill Usage: owner-only credential setup\n\n  node dist/credential-cli.cjs set              Save or replace your JWT using hidden terminal input\n  node dist/credential-cli.cjs clear            Confirm removal from your OS vault\n  node dist/credential-cli.cjs recover          Confirm removal of a dead setup lock\n  node dist/credential-cli.cjs recover --manual Confirm stopped writers before removing an empty or malformed lock\n\nRun this yourself in a local interactive terminal. Never give a JWT to Codex, chat,\ncommand arguments, environment variables, pipes, or a configuration file.\n";
const SAFE_MESSAGES = {
  SECRET_STORAGE: "Secure credential storage is unavailable, locked, or changing. Unlock your OS vault and retry. After interrupted setup, close other credential commands and use recover, then set or clear. No plaintext fallback is used.",
  INVALID_JWT: "Enter one nonempty JWT in the hidden terminal prompt.",
  TTY_REQUIRED: "Run this owner-only command yourself in an interactive terminal; redirected input/output is refused.",
  CANCELLED: "Cancelled. Your saved credential was not changed.",
  RECOVERY_MANUAL_REQUIRED: "The lock has no valid process ID, so its owner is unknown. Stop all other credential commands and related Krill MCP services, then run recover --manual yourself and confirm they will stay stopped until it finishes.",
  RECOVERY_LIVE_LOCK: "The lock's process is running or cannot be verified as stopped. Close the related processes before trying again. Manual recovery cannot override this check.",
  RECOVERY_FAILED: "Lock recovery was refused because the state directory or lock is unsafe, inaccessible, or changed during the check. Keep related processes stopped and inspect the state directory's ownership, permissions, and lock file type, size, and links before retrying. No vault credential was read or changed."
};

function cliError(code) { return Object.assign(new Error(SAFE_MESSAGES[code]), { code }); }

/** Hidden raw-mode input. No secret is echoed, masked, logged, or put in argv. */
function hiddenInput({ input = process.stdin, output = process.stderr, signals = process, prompt = "JWT (hidden; Ctrl+C cancels): " } = {}) {
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== "function") {
    return Promise.reject(cliError("TTY_REQUIRED"));
  }
  return new Promise((resolve, reject) => {
    const pasteStart = "\u001b[200~";
    const pasteEnd = "\u001b[201~";
    let value = "";
    let settled = false;
    let escape = "";
    let inPaste = false;
    let pasteEscape = "";
    let pendingError;
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing;
    const signalNames = ["SIGINT", "SIGTERM", "SIGHUP"];
    const fail = (code) => {
      if (!pendingError || code === "CANCELLED") pendingError = cliError(code);
      value = "";
    };
    const cancel = () => {
      // A cancellation byte or signal inside a paste must not re-enable echo
      // while subsequent chunks can still contain the pasted credential.
      if (inPaste || escape) fail("CANCELLED");
      else finish(cliError("CANCELLED"));
    };
    const ended = () => finish(cliError("CANCELLED"));
    function finish(error) {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", ended);
      input.removeListener("close", ended);
      input.removeListener("error", ended);
      for (const signal of signalNames) signals.removeListener(signal, cancel);
      try { output.write("\u001b[?2004l"); } catch { error = cliError("CANCELLED"); }
      try { input.setRawMode(wasRaw); } catch { error = cliError("CANCELLED"); }
      if (wasFlowing !== true) input.pause();
      try { output.write("\n"); } catch { error = cliError("CANCELLED"); }
      const answer = value;
      value = "";
      if (error) reject(error);
      else resolve(answer);
    }
    function append(character) {
      if (pendingError) return;
      value += character;
      if (value.length > MAX_CREDENTIAL_LENGTH) fail("INVALID_JWT");
    }
    function onData(chunk) {
      let complete = false;
      for (const character of chunk.toString("utf8")) {
        if (complete) continue; // Discard all remaining bytes already received.
        if (inPaste) {
          if (pasteEscape || character === "\u001b") {
            const candidate = pasteEscape + character;
            if (pasteEnd.startsWith(candidate)) {
              pasteEscape = candidate;
              if (candidate === pasteEnd) {
                pasteEscape = "";
                inPaste = false;
                if (pendingError) complete = true;
              }
            } else {
              fail("INVALID_JWT");
              pasteEscape = character === "\u001b" ? character : "";
            }
          } else if (["\u0003", "\u0004", "\u001a"].includes(character)) {
            fail("CANCELLED");
          } else if (/[\u0000-\u001f\u007f]/u.test(character)) {
            fail("INVALID_JWT");
          } else {
            append(character);
          }
          continue;
        }
        if (escape || character === "\u001b") {
          const candidate = escape + character;
          if (pasteStart.startsWith(candidate) || pasteEnd.startsWith(candidate)) {
            escape = candidate;
            if (candidate === pasteStart) { escape = ""; inPaste = true; }
            else if (candidate === pasteEnd) { escape = ""; fail("INVALID_JWT"); }
            continue;
          }
          // Unknown or interrupted controls are rejected only at a safe input
          // boundary. Never interpret a split Escape prefix as immediate exit.
          escape = character === "\u001b" ? character : "";
          fail("INVALID_JWT");
        }
        if (character === "\r" || character === "\n") { complete = true; continue; }
        if (["\u0003", "\u0004", "\u001a"].includes(character)) { fail("CANCELLED"); complete = true; continue; }
        if (character === "\u001b") continue;
        if (character === "\u007f" || character === "\b") { value = value.slice(0, -1); continue; }
        if (character === "\u0015") { value = ""; continue; }
        if (/[\u0000-\u001f]/u.test(character)) { fail("INVALID_JWT"); continue; }
        append(character);
      }
      if (complete) finish(pendingError);
    }
    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.once("end", ended);
      input.once("close", ended);
      input.once("error", ended);
      for (const signal of signalNames) signals.once(signal, cancel);
      // Supported terminals now frame a paste; the parser below handles frames
      // split at any byte boundary and rejects controls without leaking tails.
      output.write("\u001b[?2004h" + prompt);
      input.resume();
    } catch { finish(cliError("TTY_REQUIRED")); }
  });
}

async function runCredentialCli(args = process.argv.slice(2), { input = process.stdin, output = process.stderr, signals = process, storeFactory = createCredentialStore } = {}) {
  // Invalid arguments are deliberately never echoed: one may contain a secret.
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    output.write(HELP);
    return 0;
  }
  const manualRecovery = args.length === 2 && args[0] === "recover" && args[1] === "--manual";
  if (!manualRecovery && (args.length !== 1 || !["set", "clear", "recover"].includes(args[0]))) {
    output.write("Use only set, clear, recover, or recover --manual. JWT command arguments are not accepted. Run --help for owner-only setup.\n");
    return 2;
  }
  try {
    if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== "function") throw cliError("TTY_REQUIRED");
    if (args[0] === "set") {
      output.write("This is an account login credential and is not guaranteed read-only. It will be stored in your OS vault and used only for the plugin's Krill usage request.\n");
      let value = await hiddenInput({ input, output, signals });
      try { await storeFactory().replace(value); }
      finally { value = ""; }
      output.write("JWT saved in your OS vault. Previous account data has been invalidated.\n");
    } else if (args[0] === "clear") {
      const confirmation = await hiddenInput({ input, output, signals, prompt: "Remove the saved JWT? Type CLEAR and press Enter (hidden; Ctrl+C cancels): " });
      if (confirmation !== "CLEAR") throw cliError("CANCELLED");
      await storeFactory().clear();
      output.write("JWT cleared from your OS vault. Previous account data has been invalidated.\n");
    } else {
      if (manualRecovery) {
        output.write("An empty or malformed lock does not prove its owner has exited. Stop all other Krill credential set, clear, and recover processes and related Krill MCP services. Keep them stopped until this command finishes. Only the credential-write.lock file can be removed.\n");
      }
      const confirmation = await hiddenInput({ input, output, signals, prompt: manualRecovery
        ? "Confirm all other writers are stopped and will stay stopped: type STOPPED UNTIL DONE and press Enter (hidden; Ctrl+C cancels): "
        : "Close every other credential command first. Type RECOVER to remove a dead setup lock (hidden; Ctrl+C cancels): " });
      if (confirmation !== (manualRecovery ? "STOPPED UNTIL DONE" : "RECOVER")) throw cliError("CANCELLED");
      if (manualRecovery) await storeFactory().recoverInterruptedWrite({ manual: true });
      else await storeFactory().recoverInterruptedWrite();
      output.write("Interrupted lock checked. Run set or clear to complete credential setup. No vault credential was read or changed.\n");
    }
    return 0;
  } catch (error) {
    const code = Object.prototype.hasOwnProperty.call(SAFE_MESSAGES, error?.code) ? error.code : args[0] === "recover" ? "RECOVERY_FAILED" : "SECRET_STORAGE";
    output.write(SAFE_MESSAGES[code] + "\n");
    return code === "CANCELLED" ? 130 : 1;
  }
}

if (require.main === module) {
  runCredentialCli().then((code) => { process.exitCode = code; }, () => {
    process.stderr.write("Credential setup failed. No secret details are printed.\n");
    process.exitCode = 1;
  });
}

module.exports = { runCredentialCli, hiddenInput, HELP };
