## VS Code 0.1.7 (unreleased)

- Fix transient GET failures: one bounded retry, HTTP status/Retry-After classification, and absolute deadlines.
- Keep renewed JWT after login even if the following quota GET fails; block automatic sign-in only for definite credential/verification failures.
- Add short refresh diagnostics to status-bar Hover and a sanitized Krill Usage Output Channel.
- Bound focus/automatic refresh after failures and coordinate recovery across VS Code windows; discard stale results after account changes.
- Preserve the 0.1.6 Codex-only release and existing v0.1.5 VS Code release.

## Codex 0.1.6 (2026-10-19)

- 修复未勾选「记住密码」时仍在加密系统凭据库保留邮箱的问题；新保存现在只包含 JWT。
- 刷新时安全清理旧版无密码记录中的邮箱，保留 JWT；纯状态读取不写入凭据库。
- 覆盖迁移与清除、账户切换、重新记住密码之间的竞争，以及写入失败情况。
- 单独发布 Codex 修复版本，VS Code 保持 0.1.5，所有已有发布文件与标签不变。

## Codex 0.1.5 (2026-10-19)

- Windows 原生窗口新增邮箱密码登录，默认提示在系统凭据库记住密码；取消勾选只保存 JWT 与邮箱，保留 JWT-only 设置方式。
- 凭据使用单条系统凭据库记录，明确到期时尝试一次恢复；跨进程切换、清除与迟到结果通过现有修订号和写锁隔离。
- 新发布文件使用独立 Codex 源码包、校验文件与来源清单，不更改既有 v0.1.5 标签或 VS Code 产物。
- 测试仅使用合成数据；真实账户及目标 Codex 桌面仍需现场验收。

# Changelog

## 0.1.5 (VS Code)
- Add native email/password sign-in with default SecretStorage retention and optional JWT-only mode.
- Retry explicit JWT expiration once; pause automatic sign-in after failure.
- Store each account as one atomic secret record; preserve existing JWT upgrade compatibility.
- Reconcile password-retention settings on startup and serialize sign-in/refresh ownership.
- Handle interrupted responses safely and retain all existing lifecycle/host regressions.
- Codex plugin remains 0.1.4; this release changes only the VS Code extension.

## 0.1.4
- Fix account-switch and clear-credential races, including late reads, errors and refresh completion.
- Join concurrent refreshes and preserve credential-write order.
- Show refresh failures and stale data directly in the status bar.
- Add behavior regression tests and replace account fixtures with synthetic data.
- Clarify unofficial identity and credential/privacy handling; use publisher `lengmh`.

## 0.1.3
- Status-bar icon is configurable.
- Low quota warning and critical thresholds are configurable.
- Current primary plan is highlighted in the hover details.
- Low quota now uses VS Code warning/error status-bar **background** colors for reliable visual feedback across themes.
- No active quota, or all active quotas at zero, still falls back to account balance.
