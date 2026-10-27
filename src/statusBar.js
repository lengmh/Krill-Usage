"use strict";

const vscode = require("vscode");
const { activeSubscriptionWithRemaining, remainingPercent } = require("./model");
const { money, percentText, timeText, statusText, updateAge } = require("./format");

const DEFAULT_WARNING_PERCENT = 15;
const DEFAULT_CRITICAL_PERCENT = 5;
const DEFAULT_STATUS_BAR_ICON = "pulse";

const STATUS_BAR_ICONS = new Set([
  "pulse",
  "dashboard",
  "graph",
  "symbol-numeric",
  "database",
  "credit-card",
  "zap",
  "chip",
  "flame",
  "rocket",
  "code",
  "circuit-board"
]);

class StatusBarController {
  constructor(service) {
    this.service = service;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
    this.item.name = "Krill Usage";
    this.item.command = "krillUsage.refresh";
    this.subscription = service.onDidChange((view) => this.render(view));
    this.item.show();
  }

  render(view) {
    const snapshot = view.snapshot;
    const active = activeSubscriptionWithRemaining(snapshot?.subscriptions ?? []);
    const config = vscode.workspace.getConfiguration("krillUsage");
    const showBalance = config.get("showBalanceInStatusBar", false);
    const thresholds = getLowQuotaThresholds(config);
    const configuredIcon = getStatusBarIcon(config);

    if (!view.authenticated) {
      this.item.text = "$(key) Krill: 登录";
      this.item.tooltip = view.error
        ? `Krill Usage · ${view.error.message}；诊断：${formatFailureDiagnostic(view.error)}；详情见输出面板 Krill Usage`
        : "点击使用邮箱、密码登录 Krill（亦可在命令面板手动设置 JWT）";
      this.item.command = "krillUsage.login";
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
      return;
    }

    // Authenticated status-bar clicks always refresh immediately.
    this.item.command = "krillUsage.refresh";

    if (!snapshot) {
      this.item.text = view.refreshing
        ? "$(sync~spin) Krill"
        : `$(warning) Krill ${view.error ? "刷新失败" : "--"}`;
      if (view.error) {
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = false;
        md.appendMarkdown(`**Krill Usage · 刷新失败**  \n`);
        md.appendMarkdown(`${escapeMarkdown(view.error.message)}  \n`);
        md.appendMarkdown(`诊断：${escapeMarkdown(formatFailureDiagnostic(view.error))}  \n`);
        md.appendMarkdown(`详情：输出面板 → Krill Usage（不记录密码或 JWT）`);
        this.item.tooltip = md;
      } else {
        this.item.tooltip = "等待额度数据";
      }
      this.item.color = undefined;
      this.item.backgroundColor = view.error
        ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      return;
    }

    const stale = Boolean(view.lastSuccessAt &&
      Date.now() - view.lastSuccessAt >= view.refreshMinutes * 60_000);
    const dataWarning = Boolean(view.error) || stale;
    const activePct = active ? remainingPercent(active.remaining, active.limit) : null;
    const severity = quotaSeverity(activePct, thresholds);

    // Use the dedicated warning/error status-bar background colors.
    // Foreground-only warning colors can be nearly indistinguishable from
    // normal text in some VS Code themes. VS Code may choose the foreground
    // automatically to preserve contrast when a warning/error background is set.
    this.item.color = undefined;
    this.item.backgroundColor = statusBarBackground(activePct, view.refreshing, thresholds);
    if (dataWarning && !this.item.backgroundColor) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }

    const icon = view.refreshing ? "$(sync~spin)" : dataWarning ? "$(warning)" : `$(${configuredIcon})`;
    const dataLabel = view.error ? " · 刷新失败 · 旧数据" : stale ? " · 数据已过期" : "";

    if (active) {
      const quota = `${money(active.remaining)}/${money(active.limit)}`;
      const balance = showBalance ? ` · ${money(snapshot.creditBalance, true)}` : "";
      this.item.text = `${icon} Krill ${quota}${balance}${dataLabel}`;
    } else {
      // No active subscription with remaining quota: show account balance.
      // This covers both no-active-plan and all-active-plans-at-$0 cases,
      // and never falls back to frozen/expired plans such as $0/$560.
      this.item.text = `${icon} Krill ${money(snapshot.creditBalance, true)}${dataLabel}`;
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown(`**Krill Usage**  \n`);
    md.appendMarkdown(`余额：**${money(snapshot.creditBalance, true)}**  \n\n`);

    if (active) {
      if (severity === "critical") {
        md.appendMarkdown(`$(error) **当前主套餐额度很低：${percentText(activePct)}**  \n\n`);
      } else if (severity === "warning") {
        md.appendMarkdown(`$(warning) **当前主套餐额度较低：${percentText(activePct)}**  \n\n`);
      } else {
        md.appendMarkdown(`$(star-full) 当前主套餐：**${escapeMarkdown(active.name)}**  \n\n`);
      }
    }

    for (const sub of snapshot.subscriptions) {
      const pct = remainingPercent(sub.remaining, sub.limit);
      const status = statusText(sub.status);
      const isPrimary = Boolean(active && sub.id === active.id);

      if (isPrimary) {
        const marker = severity === "critical"
          ? "$(error)"
          : severity === "warning"
            ? "$(warning)"
            : "$(star-full)";
        const label = severity === "critical"
          ? "当前主套餐 · 额度很低"
          : severity === "warning"
            ? "当前主套餐 · 额度较低"
            : "当前主套餐";

        md.appendMarkdown(`${marker} **${escapeMarkdown(sub.name)}** · **${label}**  \n`);
        md.appendMarkdown(`**${money(sub.remaining)}** / ${money(sub.limit)} · **${percentText(pct)}**`);
      } else {
        md.appendMarkdown(`**${escapeMarkdown(sub.name)}**  \n`);
        md.appendMarkdown(`${money(sub.remaining)} / ${money(sub.limit)} · ${percentText(pct)}`);
      }

      if (status) md.appendMarkdown(` · ${escapeMarkdown(status)}`);
      md.appendMarkdown(`  \n${escapeMarkdown(timeText(sub))}  \n\n`);
    }

    md.appendMarkdown(
      `${escapeMarkdown(updateAge(view.lastSuccessAt))} · 每 ${view.refreshMinutes} 分钟自动刷新  \n` +
      `$(refresh) **点击状态栏立即刷新**`
    );

    if (view.error?.message) {
      md.appendMarkdown(`  \n$(warning) ${escapeMarkdown(view.error.message)} · 显示上次数据`);
      md.appendMarkdown(`  \n诊断：${escapeMarkdown(formatFailureDiagnostic(view.error))}`);
      md.appendMarkdown(`  \n详情：输出面板 → Krill Usage`);
    } else if (stale) {
      md.appendMarkdown(`  \n$(warning) 数据已超过刷新间隔，请刷新后再确认额度`);
    }

    this.item.tooltip = md;
  }

  dispose() {
    this.subscription?.dispose();
    this.item.dispose();
  }
}

function getStatusBarIcon(config) {
  const icon = String(config.get("statusBarIcon", DEFAULT_STATUS_BAR_ICON) ?? "").trim();
  return STATUS_BAR_ICONS.has(icon) ? icon : DEFAULT_STATUS_BAR_ICON;
}

function getLowQuotaThresholds(config) {
  const warning = clampPercentSetting(
    config.get("lowQuotaWarningPercent", DEFAULT_WARNING_PERCENT),
    DEFAULT_WARNING_PERCENT
  );
  const rawCritical = clampPercentSetting(
    config.get("lowQuotaCriticalPercent", DEFAULT_CRITICAL_PERCENT),
    DEFAULT_CRITICAL_PERCENT
  );

  // Keep the critical band inside the warning band even if settings.json
  // is edited manually into an inverted combination.
  const critical = Math.min(rawCritical, warning);
  return { warning, critical };
}

function clampPercentSetting(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function quotaSeverity(percent, thresholds) {
  if (percent === null || !Number.isFinite(percent)) return "normal";
  if (percent <= thresholds.critical) return "critical";
  if (percent <= thresholds.warning) return "warning";
  return "normal";
}

function statusBarBackground(percent, refreshing, thresholds = {
  warning: DEFAULT_WARNING_PERCENT,
  critical: DEFAULT_CRITICAL_PERCENT
}) {
  if (refreshing) return undefined;
  const severity = quotaSeverity(percent, thresholds);
  if (severity === "critical") {
    return new vscode.ThemeColor("statusBarItem.errorBackground");
  }
  if (severity === "warning") {
    return new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  return undefined;
}

// Backward-compatible helper name for existing tests/imports.
function statusBarColor(percent, refreshing, thresholds) {
  return statusBarBackground(percent, refreshing, thresholds);
}


// Concise, allowlisted technical context; never put URLs, headers, response
// bodies or any authentication material in a hover or an Output Channel.
function formatFailureDiagnostic(error) {
  const phase = { subscription: "额度 GET", login: "登录 POST", storage: "凭据存储", recovery: "登录恢复" }[error?.phase] ?? "额度 GET";
  const code = /^[A-Z_]{2,32}$/.test(error?.code ?? "") ? error.code : "ERROR";
  const info = [`${phase} · ${code}`];
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) info.push(`HTTP ${error.status}`);
  if (/^[A-Z_]{3,48}$/.test(error?.networkCode ?? "")) info.push(error.networkCode);
  if (error?.attempts === 2) info.push("已尝试 2 次");
  if (Number.isFinite(error?.elapsedMs) && error.elapsedMs >= 0) info.push(`耗时 ${(error.elapsedMs / 1000).toFixed(1)}s`);
  if (Number.isFinite(error?.at)) info.push(new Date(error.at).toLocaleTimeString("zh-CN", { hour12: false }));
  if (Number.isFinite(error?.nextRetryAt) && error.nextRetryAt > Date.now()) {
    info.push(`下次自动尝试不早于 ${new Date(error.nextRetryAt).toLocaleTimeString("zh-CN", { hour12: false })}`);
  }
  return info.join(" · ");
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, "\\$&");
}

module.exports = {
  StatusBarController,
  statusBarColor,
  statusBarBackground,
  quotaSeverity,
  getStatusBarIcon,
  getLowQuotaThresholds,
  STATUS_BAR_ICONS,
  DEFAULT_WARNING_PERCENT,
  DEFAULT_CRITICAL_PERCENT,
  DEFAULT_STATUS_BAR_ICON,
  formatFailureDiagnostic
};
