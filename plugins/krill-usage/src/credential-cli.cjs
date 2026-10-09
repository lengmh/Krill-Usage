#!/usr/bin/env node
"use strict";

const { createCredentialStore } = require("./credentials.cjs");
const { promptCredential, validateRawCredential, MESSAGES } = require("./credential-prompt.cjs");
const CLEAR_COMMAND = "node dist/credential-cli.cjs clear --confirm-clear";
const RECOVER_COMMAND = "node dist/credential-cli.cjs recover --confirm-stopped";
const MANUAL_RECOVER_COMMAND = "node dist/credential-cli.cjs recover --manual --confirm-stopped";
const STOPPED_WRITERS = "Stop all other Krill credential set, clear, and recover processes and related Krill MCP services. Keep them stopped until the recovery command finishes.";
const CLEAR_ACKNOWLEDGMENT = `To remove the saved JWT from your OS vault and invalidate previous account data, run ${CLEAR_COMMAND}. This does not revoke the server-side JWT or log out your browser.`;
const RECOVERY_ACKNOWLEDGMENT = `${STOPPED_WRITERS} Then run ${RECOVER_COMMAND} to remove only a lock whose valid process ID is confirmed stopped.`;
const MANUAL_PRECONDITIONS = `An empty or malformed lock does not prove its owner has exited. ${STOPPED_WRITERS} Only the credential-write.lock file can be removed.`;
const MANUAL_ACKNOWLEDGMENT = `${MANUAL_PRECONDITIONS} Then run ${MANUAL_RECOVER_COMMAND} to allow removal of that unknown-owner lock.`;
const HELP = `Krill Usage: owner-only credential setup

  node dist/credential-cli.cjs set                         Save or replace your JWT in the Windows secure window
  ${CLEAR_COMMAND}
    Remove the saved JWT from your OS vault and invalidate previous account data.
    This does not revoke the server-side JWT or log out your browser.
  ${RECOVER_COMMAND}
    Remove only a lock whose valid process ID is confirmed stopped.
  ${MANUAL_RECOVER_COMMAND}
    Also allow removal of an empty or malformed lock whose owner is unknown.

Before either recovery command: ${STOPPED_WRITERS}
Run these commands yourself locally. The flags acknowledge these consequences and
preconditions; they are not secrets. No command reads terminal input or prompts there.
Paste the JWT only into the Windows secure window. Never give a JWT to Codex, chat,
command arguments, environment variables, terminal input, or a configuration file.
`;
const SAFE_MESSAGES = {
  ...MESSAGES,
  SECRET_STORAGE: "Secure credential storage is unavailable, locked, or changing. Unlock your OS vault and retry. After interrupted setup, close other credential commands and run recover --confirm-stopped, then set or clear --confirm-clear. No plaintext fallback is used.",
  CANCELLED: "Cancelled. Your saved credential was not changed.",
  RECOVERY_MANUAL_REQUIRED: "The lock has no valid process ID, so its owner is unknown. Stop all other credential commands and related Krill MCP services, then run recover --manual --confirm-stopped yourself while keeping them stopped until the recovery command finishes.",
  RECOVERY_LIVE_LOCK: "The lock's process is running or cannot be verified as stopped. Close the related processes before trying again. Manual recovery cannot override this check.",
  RECOVERY_FAILED: "Lock recovery was refused because the state directory or lock is unsafe, inaccessible, or changed during the check. Keep related processes stopped and inspect the state directory's ownership, permissions, and lock file type, size, and links before retrying. No vault credential was read or changed."
};

async function runCredentialCli(args = process.argv.slice(2), { output = process.stderr, signals = process, storeFactory = createCredentialStore, prompt = promptCredential } = {}) {
  // Invalid arguments are deliberately never echoed: one may contain a secret.
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    output.write(HELP);
    return 0;
  }
  const command = args[0];
  const manualRecovery = command === "recover" && args[1] === "--manual";
  if (args.length === 1 && command === "clear") {
    output.write(CLEAR_ACKNOWLEDGMENT + "\n");
    return 2;
  }
  if (command === "recover" && (args.length === 1 || (manualRecovery && args.length === 2))) {
    output.write((manualRecovery ? MANUAL_ACKNOWLEDGMENT : RECOVERY_ACKNOWLEDGMENT) + "\n");
    return 2;
  }
  const valid = (command === "set" && args.length === 1) ||
    (command === "clear" && args.length === 2 && args[1] === "--confirm-clear") ||
    (command === "recover" && args.length === 2 && args[1] === "--confirm-stopped") ||
    (manualRecovery && args.length === 3 && args[2] === "--confirm-stopped");
  if (!valid) {
    output.write("Invalid command or flags. Run --help and use exactly one documented command. JWT command arguments are not accepted.\n");
    return 2;
  }
  try {
    if (args[0] === "set") {
      output.write("This is an account login credential and is not guaranteed read-only. It will be stored in your OS vault and used only for the plugin's Krill usage request.\n");
      let value = validateRawCredential(await prompt({ signals }));
      try { await storeFactory().replace(value); }
      finally { value = ""; }
      output.write("JWT saved in your OS vault. Previous account data has been invalidated.\n");
    } else if (args[0] === "clear") {
      await storeFactory().clear();
      output.write("JWT cleared from your OS vault. Previous account data has been invalidated.\n");
    } else {
      output.write((manualRecovery ? MANUAL_PRECONDITIONS : STOPPED_WRITERS) + "\n");
      if (manualRecovery) await storeFactory().recoverInterruptedWrite({ manual: true });
      else await storeFactory().recoverInterruptedWrite();
      output.write("Interrupted lock checked. Run set or clear --confirm-clear to complete credential setup. No vault credential was read or changed.\n");
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

module.exports = { runCredentialCli, HELP };
