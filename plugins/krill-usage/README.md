# Krill Usage for Codex

非官方 Krill 额度面板。本地 Node.js stdio MCP 服务提供打包的 HTML/JavaScript 界面、侧栏入口、会话面板和设置入口。JWT 由账户本人通过 Windows 原生密码窗口写入操作系统凭据库，不通过终端、聊天、MCP 参数或普通设置传入。

Codex 插件版本为 `0.1.4`，作为现有 `v0.1.4` Release 的新增发布文件提供。安装验收情况见[桌面宿主验收与复核](#桌面宿主验收与复核)。

同仓库还提供 VS Code `0.1.4` 扩展，安装与状态栏设置见[仓库首页](https://github.com/lengmh/Krill-Usage#readme)。两个客户端分别保存凭据。

## 功能与边界

- 显示全部套餐、剩余额度、账户余额、额度重置时间和套餐到期时间。
- 按服务端顺序选择第一个 active 且剩余额度大于 0 的套餐；否则以余额为主信息。未知金额不会当作 0。
- 查询失败后保留的结果明确标为旧数据；超过刷新间隔时标为过期。
- 「刷新」按钮通过 MCP App 直接调用本地服务，无需模型生成一轮回复。
- 面板可见时按设置查询；隐藏或关闭后停止界面定时查询。不提供常驻状态栏或无限期后台轮询。
- 非敏感设置：刷新间隔（整数 1–60 分钟，默认 3）、显示余额、警告阈值（默认 15%）、严重阈值（默认 5%）。严重阈值不能高于警告阈值。
- 不自动读取浏览器、剪贴板、VS Code SecretStorage 或工作区内容。

## 环境要求

- 支持插件和 MCP App 扩展入口的 ChatGPT 桌面应用（Codex）。
- Node.js 22+ 在桌面应用启动环境的 PATH 中可用。
- 支持 `codex plugin marketplace add` 的 Codex CLI，且终端中可以运行 `codex` 命令。Node.js 本身不包含 Codex CLI。
- macOS Keychain、Windows Credential Manager，或 Linux Secret Service。Linux 必须有可用且解锁的 Secret Service；不回退到明文或临时内核存储。
- 新增或替换 JWT 暂只支持 Windows 10/11 与 .NET Framework 4.8 或更高的 4.x 版本。macOS/Linux 仍可使用已存凭据、清除凭据和恢复锁，但 `set` 会拒绝操作；旧终端 JWT 输入已停用。
- 打包产物必须与操作系统、CPU 架构匹配；原生凭据库模块不能跨平台复制使用。

Windows 运行条件参考 Microsoft 的 [.NET Framework 安装与系统版本说明](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)。密码窗口使用 WPF 的 [粘贴前检查事件](https://learn.microsoft.com/en-us/dotnet/api/system.windows.dataobject.pasting?view=netframework-4.8.1)，不启动 PowerShell 脚本。

## 从平台包安装

从本仓库的 [v0.1.4 Release](https://github.com/lengmh/Krill-Usage/releases/tag/v0.1.4) 下载目标系统与 CPU 架构对应的平台包，以及 [SHA256SUMS-codex-0.1.4](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/SHA256SUMS-codex-0.1.4) 校验文件：

- Windows x64：[krill-usage-codex-0.1.4-win32-x64.tar.gz](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-codex-0.1.4-win32-x64.tar.gz)
- macOS Apple Silicon：[krill-usage-codex-0.1.4-darwin-arm64.tar.gz](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-codex-0.1.4-darwin-arm64.tar.gz)
- Linux x64：[krill-usage-codex-0.1.4-linux-x64.tar.gz](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-codex-0.1.4-linux-x64.tar.gz)

平台包包含运行所需的 JavaScript 和对应平台的原生凭据库模块，无需安装 npm 依赖；仍需满足前述 Node.js、系统凭据库及 Windows 密码窗口运行条件。macOS/Linux 包仅支持使用已存凭据，不提供首次设置或替换 JWT 的回退方式。

1. 在下载目录校验平台包。Windows PowerShell 示例：

   ```powershell
   Get-FileHash .\krill-usage-codex-0.1.4-win32-x64.tar.gz -Algorithm SHA256
   ```

   将输出的完整 SHA256 值与 `SHA256SUMS-codex-0.1.4` 中同名文件的校验值比较，忽略字母大小写。不一致时停止安装并重新下载。
2. 校验一致后解压。Windows 示例：

   ```powershell
   tar -xzf krill-usage-codex-0.1.4-win32-x64.tar.gz
   ```

   其他平台将文件名替换为下载的对应平台包。保留解压后的完整 `krill-usage-codex` 目录，其结构包括：

   ```text
   krill-usage-codex/
     .agents/plugins/marketplace.json
     plugins/krill-usage/
   ```

3. 进入解压后的根目录，用 Codex CLI 注册随包提供的本地 marketplace：

   ```sh
   cd krill-usage-codex
   codex plugin marketplace add .
   ```

4. 重启桌面应用。在 Plugins Directory 中选择「Krill Usage Local」，安装 `krill-usage`，然后打开新会话。
5. 从侧栏或会话面板入口打开 Krill Usage。如果没有显示扩展入口，可执行 `Open Krill Usage` 打开关联的 MCP App，并记录桌面版本进行复核。
6. Windows 用户继续执行下方[本地账户设置](#本地账户设置)，在原生密码窗口输入 JWT，然后回到面板刷新。

不要只取出 `plugins/krill-usage` 后在其中注册 marketplace；注册位置必须包含 `.agents/plugins/marketplace.json`。宿主可能使用安装缓存，更新方法见下方说明。

## 从源码构建并安装

由使用者在目标电脑执行。安装插件不会自动保存 JWT。Windows 构建会使用系统 .NET Framework 的 C# 编译器编译随包提供的密码窗口源码；缺少编译器或 WPF 组件时会停止构建并提示原因。无需修改 PowerShell 执行策略、提权或安装后台服务。

1. 使用本次 Codex 平台包对应的源码包，或检出发布说明注明的 Codex 源码提交，在仓库根目录运行：

   ```sh
   cd plugins/krill-usage
   npm ci --ignore-scripts
   npm run check
   npm run build
   npm test
   cd ../..
   ```

2. 仓库包含 `.agents/plugins/marketplace.json`。在仓库根目录用 Codex CLI 注册本地目录：

   ```sh
   codex plugin marketplace add .
   ```

3. 重启桌面应用。在 Plugins Directory 中选择「Krill Usage Local」，安装 `krill-usage`，然后在新会话中测试。
4. 从侧栏或会话面板入口打开 Krill Usage。若未显示扩展入口，可执行 `Open Krill Usage` 打开关联的 MCP App，再记录桌面版本进行复核。

宿主可能使用 `~/.codex/plugins/cache/<marketplace>/<plugin>/local` 中的缓存副本。更新源码后重新构建、重启，并按宿主界面更新或重新安装；不要仅修改缓存文件。

格式与流程参考 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)。采用官方样例中的兼容布局 `.codex-plugin/plugin.json` 与 `.mcp.json`，没有自定义未公开的 manifest 入口字段。

## 本地账户设置

`krill_jwt` 是账户登录凭据，不保证只读权限。先阅读 [PRIVACY.md](PRIVACY.md)。本步骤必须由账户本人操作，不要让助手输入、查看或代存真实 JWT。

本节的 `set` 仅支持 Windows。其他系统没有终端、文件或环境变量回退；不要手工修改凭据库条目来绕过修订标记。

1. 在自己的浏览器中登录 `https://www.krill-code.com`。
2. 在开发者工具的 Application → Local Storage 中找到该站点的 `krill_jwt`。不要发送到聊天或截图。
3. 在自己的交互式终端中进入已解压或已构建的 `plugins/krill-usage` 目录，运行：

   ```sh
   node dist/credential-cli.cjs set
   ```

4. 等待「Krill Usage」本地密码窗口出现并取得焦点，在窗口的密码框中粘贴 JWT，然后点击保存。不要粘贴到终端。多行、控制字符和超长粘贴会整段拒绝；粘贴或按 Enter 不会自动保存。按取消、Escape 或关闭窗口会放弃输入。
5. 回到面板点击「刷新」。设置入口只提供说明，没有 JWT 输入框。

窗口与 Node.js 进程仅通过本地子进程管道传递完整输入，随后交给现有系统凭据库适配器。窗口程序缺失、运行条件不满足、取消、异常退出或输出格式错误时，不会保存凭据，也不会回退到终端输入。不要直接运行密码窗口程序；它要求由凭据命令创建的输出管道。系统安全提示或企业应用策略阻止运行时，应停止并由设备管理员确认，不能绕过。

粘贴校验针对 Windows 剪贴板返回的完整文本，在密码控件插入或截断之前执行。Windows 的 [CF_UNICODETEXT 格式](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats) 在第一个 NUL 处结束；程序无法从已转换的文本中判断该终止符后是否还存在原始数据，因此不承诺检测格式外的字节。窗口输入不会成为终端或 shell 输入。

凭据库使用 service `com.krill-usage.codex`、account `krill_jwt`，与 VS Code SecretStorage 分离。凭据变更前后会更新仅含随机修订号和状态的本地标记，服务丢弃旧账户的迟到请求。其他界面中已经显示的数据需刷新或重新打开。

MCP 服务在短期本地子进程中初始化并读取系统凭据库，读取总时限为 5 秒。凭据库锁定或无响应时，查询失败并结束该读取进程，MCP 仍可处理其他请求；解锁凭据库后可再次刷新。写入与清除仍按原有锁和修订标记流程完成，不对写入使用提前释放锁的超时处理。

删除本地凭据：

```sh
node dist/credential-cli.cjs clear --confirm-clear
```

`--confirm-clear` 表示确认删除本地 JWT，并使旧账户数据失效；此操作不撤销服务端 JWT，也不注销浏览器。命令不再等待终端输入，缺少确认参数时会提示完整命令并退出，不访问凭据库。确认参数不含秘密；不要在任何参数中附加 JWT。

### 凭据写入锁恢复

设置进程异常退出后，可能遗留 `credential-write.lock`，阻止后续 `set` 或 `clear`。恢复操作必须由账户本人在本地执行。两种模式均须使用 `--confirm-stopped` 确认停写条件，不读取终端输入：

1. 停止其他所有凭据 `set`、`clear`、`recover` 进程及相关 Krill MCP 服务。从确认停写开始，到恢复命令结束前，不要启动这些进程。
2. 运行 `node dist/credential-cli.cjs recover --confirm-stopped`。普通恢复只移除记录了有效 PID、且已确认对应进程不存在的锁。
3. 如果提示锁为空或 PID 格式无效，可运行：

   ```sh
   node dist/credential-cli.cjs recover --manual --confirm-stopped
   ```

   `--manual` 允许恢复归属未知的锁；`--confirm-stopped` 确认其他写入进程及相关 Krill MCP 服务已停止，并将保持停止直到本命令结束。缺少确认参数时会提示完整命令并退出，不检查或移除锁。
4. 恢复成功后，重新执行 `set` 或 `clear --confirm-clear` 完成账户设置，再启动相关服务。

空锁或无效 PID 表示锁的归属未知，不能证明原进程已退出。手动恢复依赖上述停写条件；路径检查与删除不是原子操作，不能在其他写入进程仍运行时使用。有效 PID 对应的进程仍存活或无法确认已退出时，两种模式都会拒绝删除。锁文件过大、不是普通文件、带链接、权限不安全或检查期间发生变化时，也会拒绝操作；不要反复重试，应先检查状态目录和锁文件。

两种模式都只处理固定状态目录中的 `credential-write.lock`，不接受自定义路径或 PID 参数，不读取或修改系统凭据库、`credential-revision.json`、`preferences.json` 或 `preferences.lock`。命令不会自动接管锁，也不会输出锁内容。仅接受上方列出的完整命令；未知、重复、多余或用于错误命令的参数会被拒绝，不会回显参数内容，也没有 `--yes` 或标准输入确认回退。

## 偏好设置锁恢复

刷新间隔、余额显示和阈值保存在 `preferences.json` 中，更新时使用同目录下的 `preferences.lock`。只要锁文件存在，其他更新就会失败且不会移除该锁；即使原进程已退出，也不会自动接管。

设置文件同时保存递增的 `revision` 和四项设置 `values`；每次成功保存会在同一把锁内递增修订号，并原子替换文件。旧版扁平设置文件仍可读取，在下次保存时自动迁移。修订号只用于面板结果排序，不属于原生设置字段；迟到结果不会覆盖已接收的较新设置。

出现 `Preferences lock already exists` 时，先等正在进行的设置更新结束，再重试。若进程异常退出后仍无法保存，按以下步骤恢复：

1. 关闭所有会话中的 Krill MCP 服务，并确认所有 Krill MCP 进程均已退出。在任何写入进程仍运行时，不能手动删除锁文件。
2. 根据操作系统找到状态目录：
   - macOS：`~/Library/Application Support/krill-usage-codex/`。
   - Windows：`%LOCALAPPDATA%\krill-usage-codex\`；未设置 `LOCALAPPDATA` 时，使用用户主目录下的 `AppData\Local\krill-usage-codex\`。
   - Linux：若 `XDG_STATE_HOME` 是绝对路径，使用 `$XDG_STATE_HOME/krill-usage-codex/`；否则使用 `~/.local/state/krill-usage-codex/`。
3. 只删除该目录中的 `preferences.lock`，保留 `preferences.json` 及其他文件。
4. 重新启动 Krill MCP 服务，再次保存设置。

这是非敏感偏好设置的恢复流程。`credential-cli.cjs recover --confirm-stopped` 只处理账户凭据锁，不能恢复 `preferences.lock`。

## 打包与测试

```sh
npm run check
npm run build
npm test
npm run package
```

`artifacts/krill-usage-codex-0.1.4-<platform>-<arch>.tar.gz` 包含本地 marketplace、服务器、界面、当前平台凭据库二进制和许可证；Windows 产物另含从本仓库源码编译的密码窗口程序。解压根目录为 `krill-usage-codex`，其中包含 `.agents/plugins/marketplace.json` 和完整的 `plugins/krill-usage` 插件目录，可直接按前述平台包流程注册。无需安装 npm 依赖，但仍需 Node.js 22+，Windows 密码窗口还需前述 .NET Framework。本地构建和 Actions 产物附带 `.tar.gz.sha256`；GitHub Release 使用汇总校验文件 `SHA256SUMS-codex-0.1.4`。

开发测试只使用合成数据和注入式凭据库替身，不读取或保存真实凭据，也不访问真实 Krill API。新增 CI 在 Linux、Windows、macOS 构建检查插件；Windows 专项测试使用实际密码控件和模拟剪贴板内容检查整段粘贴、确认及取消。CI 中的控件测试不等于使用者电脑或 Codex 桌面宿主验收。原有 VS Code CI 保持不变。

### 桌面宿主验收与复核

使用者已报告安装验收通过，但未提供操作系统、CPU 架构、桌面版本或逐项结果；这不代表全平台与以下场景均已通过。下面的清单用于补充记录，以及在新平台或桌面版本上复核。

- 记录操作系统、CPU、桌面版本和 Node.js 版本，从本地 marketplace 安装。
- 检查侧栏、会话面板、设置入口与 HTML 界面。
- 验证点击刷新不会发起模型轮次，检查深浅主题和窄面板。
- 验证设置重开后仍生效；隐藏或关闭面板后无后续界面定时调用。
- Windows 使用合成凭据验证系统凭据库写入、读取、删除；macOS/Linux 验证已存凭据的读取与清除，并确认 `set` 拒绝操作且没有输入回退。真实 JWT 仅由本人输入，并需单独明确授权。
- Windows 上先用合成值验证密码窗口焦点、多行粘贴整段拒绝、取消与关闭、凭据库不可用时的错误处理；确认终端没有收到输入。
- 验证账户切换、失败后的旧数据标记、未知额度和套餐耗尽后的余额回退。
- 保留面板并重启本地 MCP 服务，验证下一次直接读取或刷新能接收新实例结果，迟到的旧实例通知不会恢复旧账户显示。实际宿主是否保留面板需现场确认。

## 发布文件与对应源码

现有 `v0.1.4` 标签及 VS Code VSIX 保持原样，标签仍指向 `606567f`。GitHub 自动附带的「Source code (zip)」和「Source code (tar.gz)」来自该标签，是原有 VS Code 源码，不包含本次 Codex 实现，不能用于复现这些 Codex 平台包。

本次 Codex 平台包的完整对应源码通过同一 Release 中单独的 [krill-usage-codex-0.1.4-source.zip](https://github.com/lengmh/Krill-Usage/releases/download/v0.1.4/krill-usage-codex-0.1.4-source.zip) 提供，包含新增 Codex 发布提交的完整仓库。准确提交记录在发布说明和 `CODEX-RELEASE.json` 中。`SHA256SUMS-codex-0.1.4` 汇总 Codex 发布文件的校验值；原有源码 ZIP 和 `SHA256SUMS` 保持原样。

构建需要仓库内共享的 `src/model.js`、`src/jwt.js` 和根目录许可证文件，应保留完整源码结构，不要只下载插件子目录。

## 来源与许可证

新代码采用 GPL-3.0-only。构建复用同仓库 `src/model.js`、`src/jwt.js`；根目录保留 0.1.3 的 MIT 历史声明。MCP 入口、设置和打包方式参考 [OpenAI MCP Extensions / Bits & Bolts](https://github.com/openai/mcp-extensions/tree/7e1be49daea03d7ec46ed2472f410099db2743d6/plugins/bits-and-bolts)，Apache-2.0 许可证及修改说明见 `NOTICE`、`LICENSES/`。未复制 Data Analytics 的专有代码。
