"use strict";

const vscode = require("vscode");
const { KrillUsageService } = require("./service");
const { StatusBarController } = require("./statusBar");

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const service = new KrillUsageService(context);
  const statusBar = new StatusBarController(service);
  let credentialIntent = 0;
  context.subscriptions.push(service, statusBar);

  context.subscriptions.push(vscode.commands.registerCommand("krillUsage.login", async () => {
    const email = await vscode.window.showInputBox({
      title: "Krill Usage · 登录账号 (1/2)",
      prompt: "请输入 Krill 官方网站的登录邮箱。密码和 JWT 只发送到 Krill 官方 HTTPS 接口。",
      placeHolder: "you@example.com",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() && value.trim().length <= 320 ? null : "请输入有效邮箱"
    });
    if (email === undefined) return;
    const save = service.rememberPassword();
    const password = await vscode.window.showInputBox({
      title: "Krill Usage · 登录账号 (2/2)",
      prompt: save
        ? "默认安全保存账号密码供 JWT 过期后自动续期。可在 Settings → Krill Usage: Remember Password 关闭。"
        : "当前为仅保存 JWT 模式，不保留邮箱或密码。",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.length > 0 ? null : "密码不能为空"
    });
    if (password === undefined) return;

    const intent = ++credentialIntent;
    const snapshot = await service.logIn(email, password);
    if (intent !== credentialIntent || service.disposed) return;
    if (snapshot) {
      vscode.window.showInformationMessage(service.rememberPassword()
        ? "Krill Usage: 登录成功，账号密码已保存到 SecretStorage。"
        : "Krill Usage: 登录成功，仅保存 JWT。");
    } else if (service.getView().error) {
      vscode.window.showErrorMessage(`Krill Usage: ${service.getView().error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("krillUsage.setJwt", async () => {
    const jwt = await vscode.window.showInputBox({
      title: "Krill Usage · 手动设置 JWT",
      prompt: "粘贴已登录 Krill 的 krill_jwt。使用手动 JWT 会删除之前保存的账号密码。",
      placeHolder: "eyJ...",
      password: true,
      ignoreFocusOut: true
    });
    if (jwt === undefined) return;
    if (!jwt.trim() || jwt.length > 16_400) {
      vscode.window.showWarningMessage("Krill Usage: 请输入有效长度的 krill_jwt。");
      return;
    }
    const intent = ++credentialIntent;
    let snapshot;
    try { snapshot = await service.setJwt(jwt); } catch {
      if (intent === credentialIntent && !service.disposed) {
        vscode.window.showErrorMessage("Krill Usage: JWT 格式无效，请重新复制完整凭据。");
      }
      return;
    }
    if (intent !== credentialIntent || service.disposed) return;
    if (snapshot) {
      vscode.window.showInformationMessage("Krill Usage: JWT 已保存，额度查询成功。");
    } else if (service.getView().error) {
      vscode.window.showErrorMessage(`Krill Usage: ${service.getView().error.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("krillUsage.refresh", async () => {
    await service.refresh("manual");
  }));

  context.subscriptions.push(vscode.commands.registerCommand("krillUsage.clearJwt", async () => {
    const choice = await vscode.window.showWarningMessage(
      "清除 Krill Usage 保存的 JWT、邮箱与密码？此操作不影响官网登录状态。",
      { modal: true }, "全部清除"
    );
    if (choice !== "全部清除") return;
    const intent = ++credentialIntent;
    const cleared = await service.clearCredentials();
    if (intent !== credentialIntent || service.disposed) return;
    if (cleared) vscode.window.showInformationMessage("Krill Usage: 本地登录凭据已清除。");
    else if (service.getView().error) {
      vscode.window.showErrorMessage(`Krill Usage: ${service.getView().error.message}`);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    const refreshIntervalChanged = event.affectsConfiguration("krillUsage.refreshIntervalMinutes");
    const presentationChanged = [
      "showBalanceInStatusBar", "statusBarIcon", "lowQuotaWarningPercent", "lowQuotaCriticalPercent"
    ].some((key) => event.affectsConfiguration(`krillUsage.${key}`));
    if (event.affectsConfiguration("krillUsage.rememberPassword")) {
      void service.onRememberPasswordChanged();
    }
    if (refreshIntervalChanged) service.restartTimers();
    else if (presentationChanged) service.emit();
  }));

  context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) void service.refreshIfStale();
  }));

  await service.initialize();
}

function deactivate() {}
module.exports = { activate, deactivate };
