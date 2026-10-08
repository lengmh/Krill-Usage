"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function readStatusBar() {
  return fs.readFileSync(path.join(root, "src", "statusBar.js"), "utf8");
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

test("authenticated status bar click refreshes", () => {
  const source = readStatusBar();
  const refreshAssignments = source.match(/this\.item\.command\s*=\s*"krillUsage\.refresh"/g) ?? [];
  assert.ok(refreshAssignments.length >= 2, "constructor and authenticated render should both use refresh");
  assert.doesNotMatch(source, /krillUsage\.showDetails/);
});

test("webview detail path is completely removed", () => {
  assert.equal(fs.existsSync(path.join(root, "src", "webview.js")), false);

  const pkg = readPackage();
  assert.equal(pkg.activationEvents.includes("onCommand:krillUsage.showDetails"), false);
  assert.equal(pkg.contributes.commands.some((command) => command.command === "krillUsage.showDetails"), false);

  const extension = fs.readFileSync(path.join(root, "src", "extension.js"), "utf8");
  assert.doesNotMatch(extension, /DetailsPanel|webview|showDetails/);
});

test("status bar tooltip is the details surface", () => {
  const source = readStatusBar();
  assert.match(source, /new vscode\.MarkdownString/);
  assert.match(source, /余额：/);
  assert.match(source, /timeText\(sub\)/);
  assert.match(source, /点击状态栏立即刷新/);
});

test("setting JWT does not open another view", () => {
  const source = fs.readFileSync(path.join(root, "src", "extension.js"), "utf8");
  const setJwtBlock = source.slice(
    source.indexOf('registerCommand("krillUsage.setJwt"'),
    source.indexOf('registerCommand("krillUsage.refresh"')
  );
  assert.doesNotMatch(setJwtBlock, /show\(|createWebviewPanel|executeCommand\([^)]*showDetails/);
});

test("status bar falls back to balance when all active quota is zero", () => {
  const source = readStatusBar();
  assert.match(source, /activeSubscriptionWithRemaining/);
  assert.match(source, /Krill \${money\(snapshot\.creditBalance, true\)}/);
});

test("status-bar icon is configurable with supported Codicons", () => {
  const pkg = readPackage();
  const icon = pkg.contributes.configuration.properties["krillUsage.statusBarIcon"];
  assert.equal(icon.default, "pulse");
  for (const expected of ["pulse", "dashboard", "graph", "credit-card", "zap", "chip", "flame", "rocket", "code"]) {
    assert.ok(icon.enum.includes(expected), `missing icon ${expected}`);
  }

  const source = readStatusBar();
  assert.match(source, /getStatusBarIcon\(config\)/);
  assert.match(source, /`\$\(\$\{configuredIcon\}\)`/);
});

test("low-quota warning and critical thresholds are configurable", () => {
  const pkg = readPackage();
  const props = pkg.contributes.configuration.properties;
  assert.equal(props["krillUsage.lowQuotaWarningPercent"].default, 15);
  assert.equal(props["krillUsage.lowQuotaCriticalPercent"].default, 5);

  const source = readStatusBar();
  assert.match(source, /lowQuotaWarningPercent/);
  assert.match(source, /lowQuotaCriticalPercent/);
  assert.match(source, /statusBarItem\.warningBackground/);
  assert.match(source, /statusBarItem\.errorBackground/);
  assert.match(source, /this\.item\.backgroundColor/);
});

test("tooltip highlights the current primary plan and low-quota state", () => {
  const source = readStatusBar();
  assert.match(source, /当前主套餐/);
  assert.match(source, /额度较低/);
  assert.match(source, /额度很低/);
  assert.match(source, /\$\(star-full\)/);
  assert.match(source, /\$\(warning\)/);
  assert.match(source, /\$\(error\)/);
});

test("presentation setting changes re-render without restarting API timers", () => {
  const source = fs.readFileSync(path.join(root, "src", "extension.js"), "utf8");
  assert.match(source, /statusBarIcon/);
  assert.match(source, /lowQuotaWarningPercent/);
  assert.match(source, /lowQuotaCriticalPercent/);
  assert.match(source, /service\.emit\(\)/);
});
