"use strict";

// Diagnostic preload for synthetic tests only. Never print arguments, messages,
// credential values, environment variables, or native exception text.
const { beforeEach, afterEach } = require("node:test");
const { subscribe } = require("node:diagnostics_channel");
const log = (event, details = {}) => process.stderr.write(JSON.stringify({
  diagnostic: "credential-read", pid: process.pid, event, ...details
}) + "\n");

log("process-start", { node: process.version, platform: process.platform });
subscribe("child_process", ({ process: child }) => {
  let messages = 0;
  child.once("spawn", () => log("child-spawn", { childPid: child.pid }));
  child.on("message", () => log("child-message", { childPid: child.pid, count: ++messages }));
  child.on("error", error => log("child-error", { childPid: child.pid, code: error.code }));
  child.once("exit", (code, signal) => log("child-exit", { childPid: child.pid, code, signal }));
  child.once("disconnect", () => log("child-disconnect", { childPid: child.pid }));
  child.once("close", (code, signal) => log("child-close", { childPid: child.pid, code, signal }));
  const kill = child.kill;
  child.kill = function (signal) {
    log("child-kill", { childPid: child.pid, signal });
    const result = kill.call(this, signal);
    log("child-kill-result", { childPid: child.pid, result });
    return result;
  };
});
beforeEach(t => {
  log("test-start", { name: t.name });
  for (const method of ["enable", "tick", "reset"]) {
    const timers = t.mock.timers, original = timers[method];
    timers[method] = function (...args) {
      log("mock-timers", { method, ...(method === "tick" ? { milliseconds: args[0] } : {}) });
      return original.apply(this, args);
    };
  }
});
afterEach(t => log("test-end", { name: t.name, resources: process.getActiveResourcesInfo() }));
setInterval(() => log("heartbeat", { resources: process.getActiveResourcesInfo() }), 10_000).unref();
process.once("beforeExit", () => log("before-exit", { resources: process.getActiveResourcesInfo() }));
process.once("exit", code => log("process-exit", { code }));
