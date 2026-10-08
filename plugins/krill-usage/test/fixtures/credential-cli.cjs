"use strict";

// Manual PTY smoke fixture: this never imports a native keyring or touches a vault.
const { runCredentialCli } = require("../../src/credential-cli.cjs");
const store = {
  async replace(value) {
    if (value !== "synthetic-pty-test") throw new Error("Unexpected fixture input");
    process.stderr.write("Synthetic store replaced.\n");
  },
  async clear() { process.stderr.write("Synthetic store cleared.\n"); },
  recoverInterruptedWrite() { process.stderr.write("Synthetic dead lock recovered.\n"); }
};
runCredentialCli(process.argv.slice(2), { storeFactory: () => store })
  .then((code) => { process.exitCode = code; });
