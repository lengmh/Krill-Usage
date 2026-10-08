"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWithMocks, deferred, tick } = require("./helpers");

async function fixture() {
  const commands = new Map();
  const messages = [];
  const pendingSet = deferred();
  let service, changeSettings;
  const { activate } = loadWithMocks("../src/extension", {
    vscode: {
      commands: { registerCommand: (name, callback) => { commands.set(name, callback); return {}; } },
      workspace: { onDidChangeConfiguration: (callback) => { changeSettings = callback; return {}; } },
      window: {
        showInputBox: async () => "synthetic-token",
        showWarningMessage: async () => "清除",
        showInformationMessage: (message) => messages.push(message),
        showErrorMessage: (message) => messages.push(message),
        onDidChangeWindowState: () => ({})
      }
    },
    "./service": { KrillUsageService: class {
      constructor() { service = this; this.emits = 0; this.restarts = 0; }
      async initialize() {}
      emit() { this.emits++; }
      restartTimers() { this.restarts++; }
      getView() { return {}; }
      setJwt() { return pendingSet.promise; }
      async clearJwt() { return true; }
    } },
    "./statusBar": { StatusBarController: class {} }
  });
  await activate({ subscriptions: [] });
  return { service, commands, messages, pendingSet, changeSettings };
}

test("each presentation setting emits immediately without restarting polling", async () => {
  const { service, changeSettings } = await fixture();
  for (const key of ["showBalanceInStatusBar", "statusBarIcon", "lowQuotaWarningPercent", "lowQuotaCriticalPercent"]) {
    const before = service.emits;
    changeSettings({ affectsConfiguration: (name) => name === `krillUsage.${key}` });
    assert.equal(service.emits, before + 1);
    assert.equal(service.restarts, 0);
  }
  changeSettings({ affectsConfiguration: (name) => name === "krillUsage.refreshIntervalMinutes" });
  assert.equal(service.restarts, 1);
});

test("a superseded set command cannot announce success after clear", async () => {
  const { commands, messages, pendingSet } = await fixture();
  const set = commands.get("krillUsage.setJwt")();
  await tick();
  await commands.get("krillUsage.clearJwt")();
  pendingSet.resolve({ creditBalance: "10", subscriptions: [] });
  await set;
  assert.equal(messages.length, 1);
  assert.match(messages[0], /已清除/);
});

test("disposed service cannot announce a late set result", async () => {
  const { service, commands, messages, pendingSet } = await fixture();
  const set = commands.get("krillUsage.setJwt")();
  await tick();
  service.disposed = true;
  pendingSet.resolve({ creditBalance: "10", subscriptions: [] });
  await set;
  assert.deepEqual(messages, []);
});
