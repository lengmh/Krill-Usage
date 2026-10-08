"use strict";

const assert = require("node:assert/strict");
const vscode = require("vscode");

const ACCOUNT_A = "synthetic-host-account-a";
const ACCOUNT_B = "synthetic-host-account-b";
const COMMANDS = ["krillUsage.setJwt", "krillUsage.refresh", "krillUsage.clearJwt"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function subscription(id, remaining, { status = "active", limit = "600" } = {}) {
  return {
    subscription_id: id,
    status,
    plan: { name: `Synthetic plan ${id}`, duration_days: 30 },
    quota: { remaining_usd: remaining, daily_limit_usd: limit,
      window_reset_at: "2099-01-01T00:00:00Z" },
    subscription_end_at: "2099-12-31T00:00:00Z"
  };
}

function account(remaining = "230", balance = "9.87", subscriptions) {
  return { json: { success: true, code: 0, data: {
    credit_balance_usd: balance,
    subscriptions: subscriptions ?? [subscription("primary", remaining)]
  } } };
}

async function until(predicate, description) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

async function bounded(promise, description) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 20_000);
    })]);
  } finally { clearTimeout(timeout); }
}

async function run() {
  assert.equal(process.env.KRILL_HOST_TEST, "1");
  const extension = vscode.extensions.getExtension(process.env.KRILL_HOST_EXTENSION_ID);
  assert.ok(extension, "VS Code must discover the staged Krill extension manifest");
  const h = await bounded(extension.activate(), "host-managed activation");
  const item = () => h.controller.item;
  const view = () => h.service.getView();
  let passed = 0;
  const cases = [];
  const test = (name, action) => cases.push({ name, action });
  const execute = (name) => vscode.commands.executeCommand(`krillUsage.${name}`);

  async function setAccount(token, response) {
    const exchange = h.transport.expect(token, response);
    h.prompts.inputs.push(token);
    await execute("setJwt");
    await exchange.started;
  }

  async function configuration(key, value, ready) {
    const changes = [];
    const listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`krillUsage.${key}`)) changes.push(event);
    });
    try {
      await vscode.workspace.getConfiguration("krillUsage")
        .update(key, value, vscode.ConfigurationTarget.Workspace);
      await until(() => changes.length > 0 && ready(), `${key} configuration event and render`);
      assert.equal(vscode.workspace.getConfiguration("krillUsage").get(key), value);
    } finally { listener.dispose(); }
  }

  test("real host activates production and registers all three commands", async () => {
    assert.equal(extension.isActive, true);
    assert.equal(extension.exports, h);
    const commands = await vscode.commands.getCommands(true);
    for (const command of COMMANDS) assert.ok(commands.includes(command), `${command} is registered`);
    assert.equal(h.service.context, h.context, "Service receives the real ExtensionContext");
    assert.ok(h.service.apiTimer);
    assert.ok(h.service.uiTimer);
    assert.equal(item().name, "Krill Usage");
    assert.equal(item().alignment, vscode.StatusBarAlignment.Right);
    assert.equal(item().command, "krillUsage.setJwt");
    assert.equal(item().text, "$(key) Krill: 设置 JWT");
    assert.equal(h.transport.requests.length, 0, "No HTTP without a credential");
  });

  test("230/600 at warning threshold 50 writes a real warning ThemeColor", async () => {
    await configuration("lowQuotaWarningPercent", 50, () => true);
    await setAccount(ACCOUNT_A, account());
    assert.equal(await h.context.secrets.get(h.secretKey), ACCOUNT_A,
      "The synthetic credential round-trips through real SecretStorage");
    assert.equal(item().text, "$(pulse) Krill $230/$600");
    assert.equal(item().command, "krillUsage.refresh");
    assert.ok(item().backgroundColor instanceof vscode.ThemeColor);
    assert.equal(item().backgroundColor.id, "statusBarItem.warningBackground");
    assert.ok(item().tooltip instanceof vscode.MarkdownString);
    assert.match(item().tooltip.value, /38%/);
    assert.match(item().tooltip.value, /额度较低/);
    assert.equal(item().tooltip.isTrusted, false);
  });

  test("real presentation configuration events rerender without HTTP or timer restart", async () => {
    const requestCount = h.transport.requests.length;
    const apiTimer = h.service.apiTimer;
    const uiTimer = h.service.uiTimer;
    await configuration("statusBarIcon", "rocket", () => item().text.startsWith("$(rocket)"));
    await configuration("showBalanceInStatusBar", true, () => item().text.includes(" · $9.87"));
    await configuration("lowQuotaWarningPercent", 30, () => item().backgroundColor === undefined);
    assert.equal(item().text, "$(rocket) Krill $230/$600 · $9.87");
    assert.equal(h.transport.requests.length, requestCount);
    assert.equal(h.service.apiTimer, apiTimer);
    assert.equal(h.service.uiTimer, uiTimer);
  });

  test("all active plans at zero show balance and never a frozen/expired quota", async () => {
    h.transport.expect(ACCOUNT_A, account("0", "9.87", [
      subscription("active-one", "0"), subscription("active-two", "0"),
      subscription("frozen", "500", { status: "frozen", limit: "560" }),
      subscription("expired", "900", { status: "expired", limit: "999" })
    ]));
    await execute("refresh");
    assert.equal(item().text, "$(rocket) Krill $9.87");
    assert.equal(item().backgroundColor, undefined);
    assert.doesNotMatch(item().text, /\//);
    assert.match(item().tooltip.value, /冻结/);
    assert.match(item().tooltip.value, /已结束/);
  });

  for (const [label, failure, code] of [
    ["401", { status: 401, text: "Unauthorized" }, "UNAUTHORIZED"],
    ["network", { networkError: "Synthetic offline" }, "NETWORK"],
    ["Cloudflare", { status: 403, headers: { "cf-mitigated": "challenge" },
      text: "<html>Synthetic challenge</html>" }, "CF_CHALLENGE"]
  ]) {
    test(`${label} failure preserves quota with a visible old-data label`, async () => {
      h.transport.expect(ACCOUNT_A, account());
      await execute("refresh");
      const snapshot = view().snapshot;
      const lastSuccessAt = view().lastSuccessAt;
      assert.equal(item().backgroundColor, undefined, "Healthy 38% exceeds the configured 30%");
      h.transport.expect(ACCOUNT_A, failure);
      await execute("refresh");
      assert.equal(view().error.code, code);
      assert.equal(view().snapshot, snapshot);
      assert.equal(view().lastSuccessAt, lastSuccessAt);
      assert.equal(item().text, "$(warning) Krill $230/$600 · $9.87 · 刷新失败 · 旧数据");
      assert.equal(item().backgroundColor.id, "statusBarItem.warningBackground");
      assert.equal(item().command, "krillUsage.refresh");
      assert.match(item().tooltip.value, /显示上次数据/);

      const retry = h.transport.expect(ACCOUNT_A, account(), { hold: true });
      const refreshing = execute("refresh");
      await retry.started;
      assert.match(item().text, /刷新失败 · 旧数据$/, "Stale warning stays on the label during retry");
      retry.reply();
      await refreshing;
      assert.equal(view().error, null);
      assert.doesNotMatch(item().text, /旧数据|刷新失败/);
    });
  }

  test("switching credentials ignores an older success while the new request is pending", async () => {
    const messagesBefore = h.prompts.messages.length;
    const old = h.transport.expect(ACCOUNT_A, account("111", "1.11"), { hold: true });
    h.prompts.inputs.push(ACCOUNT_A);
    const oldCommand = execute("setJwt");
    await old.started;
    const fresh = h.transport.expect(ACCOUNT_B, account("444", "4.44"), { hold: true });
    h.prompts.inputs.push(ACCOUNT_B);
    const newCommand = execute("setJwt");
    await fresh.started;
    old.reply();
    await oldCommand;
    assert.equal(view().snapshot, null);
    assert.equal(view().refreshing, true, "Old completion must not finish the new request");
    assert.equal(h.prompts.messages.length, messagesBefore, "Old set command must not send a success toast");
    assert.doesNotMatch(item().text, /111|1\.11|230/);
    fresh.reply();
    await newCommand;
    assert.equal(await h.context.secrets.get(h.secretKey), ACCOUNT_B);
    assert.equal(item().text, "$(rocket) Krill $444/$600 · $4.44");
  });

  test("switching credentials ignores an older failure after the new request succeeds", async () => {
    const old = h.transport.expect(ACCOUNT_A, { status: 401, text: "Unauthorized" }, { hold: true });
    h.prompts.inputs.push(ACCOUNT_A);
    const oldCommand = execute("setJwt");
    await old.started;
    await setAccount(ACCOUNT_B, account("444", "4.44"));
    const snapshot = view().snapshot;
    const messagesBefore = h.prompts.messages.length;
    const lastSuccessAt = view().lastSuccessAt;
    old.reply();
    await oldCommand;
    assert.equal(view().snapshot, snapshot);
    assert.equal(view().lastSuccessAt, lastSuccessAt);
    assert.equal(view().error, null);
    assert.equal(view().refreshing, false);
    assert.equal(h.prompts.messages.length, messagesBefore, "No stale error or success toast");
    assert.equal(item().text, "$(rocket) Krill $444/$600 · $4.44");
  });

  for (const [label, response] of [
    ["success", account("111", "1.11")],
    ["failure", { networkError: "Synthetic old account offline" }]
  ]) {
    test(`clearing credentials ignores an in-flight ${label}`, async () => {
      const old = h.transport.expect(ACCOUNT_A, response, { hold: true });
      h.prompts.inputs.push(ACCOUNT_A);
      const oldCommand = execute("setJwt");
      await old.started;
      h.prompts.confirmations.push("清除");
      await execute("clearJwt");
      assert.equal(await h.context.secrets.get(h.secretKey), undefined);
      const messagesBefore = h.prompts.messages.length;
      old.reply();
      await oldCommand;
      assert.equal(view().authenticated, false);
      assert.equal(view().snapshot, null);
      assert.equal(view().error, null);
      assert.equal(view().lastSuccessAt, 0);
      assert.equal(view().refreshing, false);
      assert.equal(h.prompts.messages.length, messagesBefore, "Cleared request must not send any notification");
      assert.equal(item().text, "$(key) Krill: 设置 JWT");
      assert.equal(item().command, "krillUsage.setJwt");
      assert.equal(item().backgroundColor, undefined);
    });
  }

  console.log(`Krill host integration: VS Code ${vscode.version}, ${cases.length} scenarios`);
  try {
    for (const { name, action } of cases) {
      await bounded(action(), name);
      h.transport.assertIdle();
      h.prompts.assertIdle();
      console.log(`PASS ${++passed}/${cases.length}: ${name}`);
    }
  } finally {
    // Dispose production listeners and timers before canceling remaining mock
    // exchanges. The synthetic secret/profile is removed even after a failure.
    for (const disposable of [...h.context.subscriptions].reverse()) disposable.dispose();
    h.transport.dispose();
    await h.context.secrets.delete(h.secretKey);
  }
  assert.equal(passed, cases.length);
  console.log("Host API assertions passed. No screenshot/pixel-contrast claims are made.");
}

module.exports = { run };
