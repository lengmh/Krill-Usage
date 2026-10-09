# Krill Usage

非官方 Krill 额度查看工具，提供 VS Code 状态栏扩展和 Codex 桌面插件，用于查看套餐剩余额度与账户余额。

本项目由独立开发者维护，与 Krill 运营方无隶属、授权背书或官方支持关系。Krill 名称仅用于说明适配的服务。

## 选择客户端

- **VS Code**：在状态栏查看额度，悬停查看详情，点击立即刷新。需要桌面版 VS Code 1.95+；安装与设置见下文。
- **Codex**：通过本地 MCP 服务显示额度面板、刷新按钮和设置入口。需要支持插件与 MCP App 扩展入口的桌面应用，以及 Node.js 22+。新增或替换 JWT 仅支持 Windows 10/11 与 .NET Framework 4.8 或更高的 4.x 版本；macOS/Linux 仅能使用已存凭据，不能完成首次 JWT 设置。详见 [Codex 插件说明](plugins/krill-usage/README.md)。

两个客户端分别保存凭据，Codex 不会读取 VS Code SecretStorage 或浏览器凭据。`krill_jwt` 是账户登录凭据，不保证只读权限；不要发送到聊天、写入命令参数或提交到仓库。

## VS Code 扩展

### 功能

- 手动输入 `krill_jwt`，使用 VS Code `SecretStorage` 保存。
- 默认每 3 分钟查询一次，支持 1–60 分钟刷新间隔。
- 按 API 返回顺序，显示第一个状态为 active 且仍有额度的套餐。
- 没有可用 active 套餐时显示账户余额，包括所有 active 套餐额度为 0 的情况。
- 悬停查看全部套餐、余额、状态、百分比和时间信息，不创建 Webview 或编辑器标签页。
- 支持状态栏图标、余额显示和低额度阈值设置；修改显示设置立即生效。
- 查询失败时直接标注「刷新失败 · 旧数据」；数据超过刷新间隔时标注「数据已过期」。请勿将旧数据视为当前可用额度。
- 切换或清除凭据后，丢弃旧账号的迟到请求结果。

### 安装

需要桌面版 VS Code 1.95 或更新版本。此扩展使用 Node.js API，不支持纯浏览器版 VS Code。

1. 下载 [krill-usage-0.1.4.vsix](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-0.1.4.vsix)。
2. 打开 Extensions，选择右上角 `...` → **Install from VSIX...**，选择下载的 VSIX。
3. 执行 **Developer: Reload Window**。

也可从命令行安装：

```powershell
code --install-extension .\krill-usage-0.1.4.vsix --force
```

发布者标识为 `lengmh`。此前手动安装的 `krill-ai.krill-usage` 属于不同扩展标识，请先卸载旧版本，避免两个实例同时轮询。新标识不会自动继承旧标识的 SecretStorage 凭据，需要重新设置 JWT。

### 首次使用

`krill_jwt` 是账号登录凭据，不能保证只读权限。请先阅读随包提供的 [PRIVACY.md](PRIVACY.md)，不要公开、截图分享或提交到仓库。

1. 在浏览器中登录 Krill。
2. 打开开发者工具 → Application → Local Storage → `https://www.krill-code.com`。
3. 复制 `krill_jwt` 的值。
4. 在 VS Code 命令面板执行 **Krill: Set JWT**。
5. 将 JWT 粘贴到密码输入框。
6. 查询成功后，状态栏显示额度；悬停查看详情，点击立即刷新。

插件只向 `https://www.krill-code.com/api/subscription` 发送 JWT。它不会自动读取浏览器凭据，也不会上传工作区内容。

### 命令

- `Krill: Set JWT`：设置或切换账号凭据并查询。
- `Krill: Refresh Usage`：立即刷新。
- `Krill: Clear JWT`：确认后删除保存的凭据并清空本窗口数据。此操作不撤销服务端 JWT，也不注销浏览器登录。

### 设置

在 Settings 中搜索 `Krill Usage`：

- `krillUsage.refreshIntervalMinutes`：刷新间隔，默认 `3` 分钟，范围 `1–60`。
- `krillUsage.showBalanceInStatusBar`：显示套餐时附带账户余额，默认关闭。
- `krillUsage.statusBarIcon`：状态栏 Codicon，默认 `pulse`。
- `krillUsage.lowQuotaWarningPercent`：低额度警告阈值，默认 `15`。
- `krillUsage.lowQuotaCriticalPercent`：严重低额度阈值，默认 `5`。

阈值依据当前套餐的 `remaining_usd / daily_limit_usd × 100`。小于或等于严重阈值时使用错误背景色，否则小于或等于警告阈值时使用警告背景色。严重阈值高于警告阈值时，按警告阈值限制严重区间。

例如，剩余 `$230`、上限 `$600` 时约为 `38%`，将警告阈值设为 `50` 会显示警告背景色。没有可用 active 套餐时显示余额，不应用套餐低额度颜色。错误和旧数据标记仍会显示。

### 已知限制与排查

- JWT 过期或无效：重新登录 Krill 并执行 `Krill: Set JWT`。
- 网络错误：恢复连接后点击状态栏重试。
- Cloudflare 验证：插件会报告验证错误，不自动完成或绕过验证。
- 查询失败后可能保留上次成功结果，会明确标为旧数据；成功刷新后恢复正常显示。
- 超过刷新间隔的数据会标为过期。时间显示每分钟更新一次，因此纯时间触发的标记最多有约 1 分钟显示延迟。
- 多个 VS Code 窗口不会即时同步账号显示。切换或清除凭据后，请刷新或重载其他窗口。
- 额度和计费以 Krill 服务端为准；接口或登录方式变化可能导致扩展失效。
- `extensionKind: ["ui"]`：使用 Remote SSH、WSL 或 Dev Container 时优先在本地 UI Extension Host 运行。

## Codex 插件

Codex 插件版本为 `0.1.4`。面板显示全部套餐、账户余额、额度重置时间和套餐到期时间；点击刷新直接调用本地服务。面板可见时按设置查询，隐藏或关闭后停止界面定时查询，不提供常驻状态栏或无限期后台轮询。

### 下载与安装

从本仓库的 [v0.1.4 Release](https://github.com/lengmh/Krill-Usage/releases/tag/v0.1.4) 下载与目标系统和 CPU 架构匹配的平台包，以及 [SHA256SUMS-codex-0.1.4](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/SHA256SUMS-codex-0.1.4) 校验文件：

- Windows x64：[krill-usage-codex-0.1.4-win32-x64.tar.gz](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-codex-0.1.4-win32-x64.tar.gz)
- macOS Apple Silicon：[krill-usage-codex-0.1.4-darwin-arm64.tar.gz](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-codex-0.1.4-darwin-arm64.tar.gz)
- Linux x64：[krill-usage-codex-0.1.4-linux-x64.tar.gz](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-codex-0.1.4-linux-x64.tar.gz)

平台包包含对应平台的原生凭据库模块，不能跨平台复制使用。macOS/Linux 包不提供新 JWT 输入方式；没有已存凭据时，无法完成账户设置。其他平台或架构可参考[源码构建说明](plugins/krill-usage/README.md#从源码构建并安装)，构建成功不等同于宿主验收通过。

安装前确认 Node.js 22+ 在桌面应用启动环境的 PATH 中可用，并且终端能运行支持插件命令的 Codex CLI。安装 Node.js 不会自动提供 `codex` 命令。

1. 在下载目录校验平台包。Windows PowerShell 示例：

   ```powershell
   Get-FileHash .\krill-usage-codex-0.1.4-win32-x64.tar.gz -Algorithm SHA256
   ```

   将输出的完整 SHA256 值与 `SHA256SUMS-codex-0.1.4` 中同名文件的校验值比较，忽略字母大小写。不一致时停止安装并重新下载。
2. 校验一致后解压。Windows 示例：

   ```powershell
   tar -xzf krill-usage-codex-0.1.4-win32-x64.tar.gz
   ```

   其他平台将文件名替换为下载的对应平台包。解压后的 `krill-usage-codex` 根目录包含 `.agents/plugins/marketplace.json` 和 `plugins/krill-usage`。
3. 进入解压后的根目录，用 Codex CLI 注册：

   ```sh
   cd krill-usage-codex
   codex plugin marketplace add .
   ```

4. 重启桌面应用，在 Plugins Directory 中选择「Krill Usage Local」，安装 `krill-usage`，然后打开新会话。
5. Windows 用户按 [Codex 本地账户设置](plugins/krill-usage/README.md#本地账户设置)操作，在本地原生密码窗口输入 JWT，再回到面板刷新。不要在终端、聊天、MCP 参数或普通设置中输入 JWT。

使用者已反馈安装验收通过；环境信息与逐项结果尚未提供，验收范围与复核项目见 [Codex 宿主验收说明](plugins/krill-usage/README.md#桌面宿主验收与复核)。

### 发布文件与源码对应关系

`v0.1.4` Release 保留原有 VS Code VSIX 和标签，并补充 Codex 平台包。原有标签仍指向 `606567f`；GitHub 自动生成的「Source code (zip)」和「Source code (tar.gz)」对应原有 VS Code 源码，不包含本次 Codex 新增实现。

构建或审阅 Codex 平台包时，应使用同一 Release 中单独提供的 [krill-usage-codex-0.1.4-source.zip](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-codex-0.1.4-source.zip)。该源码包包含发布提交的完整仓库，准确提交记录在发布说明和 `CODEX-RELEASE.json` 中；它与本次 Codex 平台包配套，不替代原有 VS Code 源码。`SHA256SUMS-codex-0.1.4` 汇总 Codex 发布文件的校验值，原有源码 ZIP 和 `SHA256SUMS` 保持原样。

## 开发与验证

### VS Code

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

### Codex

Codex 的依赖、构建与平台打包流程独立于 VS Code 扩展。请在 `plugins/krill-usage` 中按 [Codex 开发说明](plugins/krill-usage/README.md#打包与测试)运行检查、构建和测试。

## 许可证与署名

Copyright (c) 2026 MAOHENG LENG (lengmh) and Krill Usage contributors.

0.1.4 使用 GNU GPL v3.0（仅该版本，全文见 `LICENSE`），标识为 `GPL-3.0-only`。允许商业使用；分发本扩展或其修改版本时，应按 GPL 提供相应源码并保留适用的版权、许可证及修改说明。许可证不要求未分发的内部修改向公众公开，也不要求将作者姓名用作衍生产品名称。

`NOTICE` 保留原始版权及 0.1.3 的 MIT 许可声明。已经按 MIT 提供的 0.1.3 不会被追溯改为 GPL。
