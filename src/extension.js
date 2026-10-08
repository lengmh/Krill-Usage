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

  context.subscriptions.push(
    vscode.commands.registerCommand("krillUsage.setJwt", async () => {
      const jwt = await vscode.window.showInputBox({
        title: "Krill Usage · 设置 krill_jwt",
        prompt: "粘贴 Krill 网页中的 krill_jwt（账号登录凭据，不能保证只读）。保存至 SecretStorage，仅发送至 www.krill-code.com 查询额度。",
        placeHolder: "eyJ...",
        password: true,
        ignoreFocusOut: true
      });

      if (jwt === undefined) return;
      if (!jwt.trim()) {
        vscode.window.showWarningMessage("Krill Usage: krill_jwt 不能为空。");
        return;
      }

      const intent = ++credentialIntent;
      const snapshot = await service.setJwt(jwt);
      if (intent !== credentialIntent || service.disposed) return;
      if (snapshot) {
        vscode.window.showInformationMessage("Krill Usage: JWT 已保存，额度查询成功。");
      } else if (service.getView().error) {
        vscode.window.showErrorMessage(`Krill Usage: ${service.getView().error.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("krillUsage.refresh", async () => {
      await service.refresh("manual");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("krillUsage.clearJwt", async () => {
      const choice = await vscode.window.showWarningMessage(
        "清除 Krill Usage 保存的 krill_jwt？",
        { modal: true },
        "清除"
      );
      if (choice !== "清除") return;
      const intent = ++credentialIntent;
      const cleared = await service.clearJwt();
      if (intent !== credentialIntent || service.disposed) return;
      if (cleared) vscode.window.showInformationMessage("Krill Usage: krill_jwt 已清除。");
      else if (service.getView().error) {
        vscode.window.showErrorMessage(`Krill Usage: ${service.getView().error.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      const refreshIntervalChanged =
        event.affectsConfiguration("krillUsage.refreshIntervalMinutes");

      const presentationChanged =
        event.affectsConfiguration("krillUsage.showBalanceInStatusBar") ||
        event.affectsConfiguration("krillUsage.statusBarIcon") ||
        event.affectsConfiguration("krillUsage.lowQuotaWarningPercent") ||
        event.affectsConfiguration("krillUsage.lowQuotaCriticalPercent");

      if (refreshIntervalChanged) {
        service.restartTimers();
      } else if (presentationChanged) {
        // Re-render immediately without touching the API refresh timers.
        service.emit();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) service.refreshIfStale();
    })
  );

  await service.initialize();
}

function deactivate() {}

module.exports = { activate, deactivate };
