"use strict";

const fs = require("node:fs");

// Synthetic native-binding replacement. This fixture never loads a real vault.
module.exports = function keyringFixture(controlPath, eventsPath) {
  const record = event => fs.appendFileSync(eventsPath, JSON.stringify({ ...event, pid: process.pid }) + "\n");
  const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  return {
    Entry: class { constructor() { throw new Error("Synchronous Entry selected for a read"); } },
    AsyncEntry: class {
      constructor(...args) {
        this.control = JSON.parse(fs.readFileSync(controlPath, "utf8"));
        record({ event: "construct", args, mode: this.control.mode });
        if (this.control.mode === "constructor-block") block();
      }
      getPassword() {
        const { mode, value = "synthetic-account-a" } = this.control;
        record({ event: "read", mode });
        if (mode === "exit") process.exit(1);
        if (mode === "invalid-ipc") process.send({ ok: true, value: 42 });
        if (mode === "read-block") block();
        if (mode === "never") return new Promise(() => {});
        if (mode === "reject") {
          process.stdout.write("synthetic-private-native-output");
          process.stderr.write("synthetic-private-native-error");
          return Promise.reject(new Error("synthetic-private-native-rejection"));
        }
        if (mode === "late") return new Promise(resolve => setTimeout(() => {
          record({ event: "late-result" }); resolve(value);
        }, 60_000));
        if (mode === "exit-block") process.exit = () => {};
        if (mode === "controlled") return new Promise(resolve => {
          const poll = setInterval(() => {
            if (JSON.parse(fs.readFileSync(controlPath, "utf8")).release) {
              clearInterval(poll); resolve(value);
            }
          }, 10);
        });
        return Promise.resolve(value);
      }
    }
  };
};
