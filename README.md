# Krill Usage for VS Code

非官方 Krill 额度查看工具。在 VS Code 状态栏查看套餐剩余额度和账户余额，悬停查看详情，点击立即刷新。

本扩展由独立开发者维护，与 Krill 运营方无隶属、授权背书或官方支持关系。Krill 名称仅用于说明适配的服务。

## 功能

- 手动输入 `krill_jwt`，使用 VS Code `SecretStorage` 保存。
- 默认每 3 分钟查询一次，支持 1–60 分钟刷新间隔。
- 按 API 返回顺序，显示第一个状态为 active 且仍有额度的套餐。
- 没有可用 active 套餐时显示账户余额，包括所有 active 套餐额度为 0 的情况。
- 悬停查看全部套餐、余额、状态、百分比和时间信息，不创建 Webview 或编辑器标签页。
- 支持状态栏图标、余额显示和低额度阈值设置；修改显示设置立即生效。
- 查询失败时直接标注「刷新失败 · 旧数据」；数据超过刷新间隔时标注「数据已过期」。请勿将旧数据视为当前可用额度。
- 切换或清除凭据后，丢弃旧账号的迟到请求结果。

## 安装

需要桌面版 VS Code 1.95 或更新版本。此扩展使用 Node.js API，不支持纯浏览器版 VS Code。

1. 打开 Extensions，选择右上角 `...` → **Install from VSIX...**。
2. 选择 `krill-usage-0.1.4.vsix`。
3. 执行 **Developer: Reload Window**。

也可从命令行安装：

```powershell
code --install-extension .\krill-usage-0.1.4.vsix --force
```

发布者标识为 `lengmh`。此前手动安装的 `krill-ai.krill-usage` 属于不同扩展标识，请先卸载旧版本，避免两个实例同时轮询。新标识不会自动继承旧标识的 SecretStorage 凭据，需要重新设置 JWT。

## 首次使用

`krill_jwt` 是账号登录凭据，不能保证只读权限。请先阅读随包提供的 `PRIVACY.md`，不要公开、截图分享或提交到仓库。

1. 在浏览器中登录 Krill。
2. 打开开发者工具 → Application → Local Storage → `https://www.krill-code.com`。
3. 复制 `krill_jwt` 的值。
4. 在 VS Code 命令面板执行 **Krill: Set JWT**。
5. 将 JWT 粘贴到密码输入框。
6. 查询成功后，状态栏显示额度；悬停查看详情，点击立即刷新。

插件只向 `https://www.krill-code.com/api/subscription` 发送 JWT。它不会自动读取浏览器凭据，也不会上传工作区内容。

## 命令

- `Krill: Set JWT`：设置或切换账号凭据并查询。
- `Krill: Refresh Usage`：立即刷新。
- `Krill: Clear JWT`：确认后删除保存的凭据并清空本窗口数据。此操作不撤销服务端 JWT，也不注销浏览器登录。

## 设置

在 Settings 中搜索 `Krill Usage`：

- `krillUsage.refreshIntervalMinutes`：刷新间隔，默认 `3` 分钟，范围 `1–60`。
- `krillUsage.showBalanceInStatusBar`：显示套餐时附带账户余额，默认关闭。
- `krillUsage.statusBarIcon`：状态栏 Codicon，默认 `pulse`。
- `krillUsage.lowQuotaWarningPercent`：低额度警告阈值，默认 `15`。
- `krillUsage.lowQuotaCriticalPercent`：严重低额度阈值，默认 `5`。

阈值依据当前套餐的 `remaining_usd / daily_limit_usd × 100`。小于或等于严重阈值时使用错误背景色，否则小于或等于警告阈值时使用警告背景色。严重阈值高于警告阈值时，按警告阈值限制严重区间。

例如，剩余 `$230`、上限 `$600` 时约为 `38%`，将警告阈值设为 `50` 会显示警告背景色。没有可用 active 套餐时显示余额，不应用套餐低额度颜色。错误和旧数据标记仍会显示。

## 已知限制与排查

- JWT 过期或无效：重新登录 Krill 并执行 `Krill: Set JWT`。
- 网络错误：恢复连接后点击状态栏重试。
- Cloudflare 验证：插件会报告验证错误，不自动完成或绕过验证。
- 查询失败后可能保留上次成功结果，会明确标为旧数据；成功刷新后恢复正常显示。
- 超过刷新间隔的数据会标为过期。时间显示每分钟更新一次，因此纯时间触发的标记最多有约 1 分钟显示延迟。
- 多个 VS Code 窗口不会即时同步账号显示。切换或清除凭据后，请刷新或重载其他窗口。
- 额度和计费以 Krill 服务端为准；接口或登录方式变化可能导致扩展失效。
- `extensionKind: ["ui"]`：使用 Remote SSH、WSL 或 Dev Container 时优先在本地 UI Extension Host 运行。

## 开发与验证

开发工具需要 Node.js 22 或更新版本。安装依赖并运行检查：

```sh
npm ci --ignore-scripts
npm run check
npm test
```

运行真实 VS Code 扩展宿主测试（Linux 无桌面环境时需要 Xvfb）：

```sh
xvfb-run -a npm run test:host
```

有桌面的 macOS 或 Windows 可直接运行 `npm run test:host`。测试会下载 VS Code，在隔离配置和临时扩展副本中运行。HTTP 返回值和交互输入使用合成数据；生产代码、宿主命令、设置与状态栏 API 参与执行。不需要 JWT，也不访问真实 Krill API。

[GitHub Actions](https://github.com/lengmh/Krill-Usage/actions) 对每次主分支提交和 Pull Request 运行 38 项单元/行为回归测试、VSIX 打包检查，以及 VS Code 1.95.0 和 stable 两个版本的扩展宿主测试。宿主 API 断言不等同于深浅色或高对比度主题的像素可读性验收。验证范围见 `TEST_REPORT.md`。

构建 VSIX：

```sh
npm run package
```

输出为 `krill-usage-0.1.4.vsix`。CI 不创建 Release，不发布到 Marketplace。

## 许可证与署名

Copyright (c) 2026 MAOHENG LENG (lengmh) and Krill Usage contributors.

0.1.4 使用 GNU GPL v3.0（仅该版本，全文见 `LICENSE`），标识为 `GPL-3.0-only`。允许商业使用；分发本扩展或其修改版本时，应按 GPL 提供相应源码并保留适用的版权、许可证及修改说明。许可证不要求未分发的内部修改向公众公开，也不要求将作者姓名用作衍生产品名称。

`NOTICE` 保留原始版权及 0.1.3 的 MIT 许可声明。已经按 MIT 提供的 0.1.3 不会被追溯改为 GPL。
