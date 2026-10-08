"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWithMocks } = require("./helpers");

function fixture() {
  const settings = {};
  const item = { show() {}, dispose() {} };
  const { StatusBarController } = loadWithMocks("../src/statusBar", {
    vscode: {
      StatusBarAlignment: { Right: 2 },
      ThemeColor: class { constructor(id) { this.id = id; } },
      MarkdownString: class {
        constructor() { this.value = ""; }
        appendMarkdown(value) { this.value += value; }
      },
      workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
      window: { createStatusBarItem: () => item }
    }
  });
  const controller = new StatusBarController({ onDidChange: () => ({ dispose() {} }) });
  const view = {
    authenticated: true, refreshing: false, error: null,
    lastSuccessAt: Date.now(), refreshMinutes: 3,
    snapshot: { creditBalance: "123.45", subscriptions: [
      { id: "synthetic-plan", name: "Synthetic monthly", status: "active", remaining: "230", limit: "600" }
    ] }
  };
  return { controller, item, settings, view };
}

test("230/600 at warning 50 uses warning background and current-plan hover", () => {
  const { controller, item, settings, view } = fixture();
  settings.lowQuotaWarningPercent = 50;
  controller.render(view);
  assert.equal(item.backgroundColor.id, "statusBarItem.warningBackground");
  assert.equal(item.text, "$(pulse) Krill $230/$600");
  assert.match(item.tooltip.value, /额度较低：38%/);
  assert.equal(item.tooltip.isTrusted, false);
  settings.lowQuotaWarningPercent = 15;
  settings.statusBarIcon = "rocket";
  settings.showBalanceInStatusBar = true;
  controller.render(view);
  assert.equal(item.backgroundColor, undefined);
  assert.equal(item.text, "$(rocket) Krill $230/$600 · $123.45");
});

test("all active plans at zero fall back to balance, ignoring frozen quota", () => {
  const { controller, item, view } = fixture();
  view.snapshot.subscriptions[0].remaining = "0";
  view.snapshot.subscriptions.push({ id: "frozen", status: "frozen", remaining: "10", limit: "20" });
  controller.render(view);
  assert.equal(item.text, "$(pulse) Krill $123.45");
  assert.equal(item.backgroundColor, undefined);
});

test("failed and overdue data are visible without hover, including during retries", () => {
  const { controller, item, view } = fixture();
  for (const code of ["UNAUTHORIZED", "NETWORK", "CF_CHALLENGE"]) {
    view.error = { code, message: `Synthetic ${code}` };
    controller.render(view);
    assert.match(item.text, /刷新失败 · 旧数据/);
    assert.equal(item.backgroundColor.id, "statusBarItem.warningBackground");
    view.refreshing = true;
    controller.render(view);
    assert.match(item.text, /sync~spin.*刷新失败 · 旧数据/);
    view.refreshing = false;
  }
  view.error = null;
  view.lastSuccessAt = Date.now() - 181_000;
  controller.render(view);
  assert.match(item.text, /数据已过期/);
  view.lastSuccessAt = Date.now();
  controller.render(view);
  assert.doesNotMatch(item.text, /失败|过期|旧数据/);
});

test("first-load failure and cleared credentials show distinct actionable states", () => {
  const { controller, item, view } = fixture();
  view.snapshot = null;
  view.error = { code: "UNAUTHORIZED", message: "JWT expired" };
  controller.render(view);
  assert.match(item.text, /刷新失败/);
  assert.equal(item.command, "krillUsage.refresh");
  view.authenticated = false;
  view.error = null;
  controller.render(view);
  assert.equal(item.text, "$(key) Krill: 设置 JWT");
  assert.equal(item.command, "krillUsage.setJwt");
  assert.equal(item.backgroundColor, undefined);
});
