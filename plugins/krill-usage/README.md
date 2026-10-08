# Krill Usage for Codex

非官方 Krill 额度面板。本地 Node.js stdio MCP 服务提供打包的 HTML/JavaScript 界面、侧栏入口、会话面板和设置入口。JWT 由账户本人通过本地隐藏输入写入操作系统凭据库，不通过聊天、MCP 参数或普通设置传入。

这是 `0.1.0` 安装验证版。协议、组件和打包测试不代表已经通过 Codex 桌面宿主验收。目标桌面版本的入口呈现、安装缓存行为和真实系统凭据库操作尚待验证。

同仓库根目录仍是 VS Code `0.1.4` 扩展；本目录不会更改其版本、状态栏行为或发布流程。

## 功能与边界

- 显示全部套餐、剩余额度、账户余额、额度重置时间和套餐到期时间。
- 按服务端顺序选择第一个 active 且剩余额度大于 0 的套餐；否则以余额为主信息。未知金额不会当作 0。
- 查询失败后保留的结果明确标为旧数据；超过刷新间隔时标为过期。
- 「刷新」按钮通过 MCP App 直接调用本地服务，无需模型生成一轮回复。
- 面板可见时按设置查询；隐藏或关闭后停止界面定时查询。不提供常驻状态栏或无限期后台轮询。
- 非敏感设置：刷新间隔（整数 1–60 分钟，默认 3）、显示余额、警告阈值（默认 15%）、严重阈值（默认 5%）。严重阈值不能高于警告阈值。
- 不自动读取浏览器、剪贴板、VS Code SecretStorage 或工作区内容。

## 环境要求

- 支持插件和 MCP App 扩展入口的 ChatGPT 桌面应用（Codex）。具体构建需完成下方宿主验收。
- Node.js 22+ 在桌面应用启动环境的 PATH 中可用。
- macOS Keychain、Windows Credential Manager，或 Linux Secret Service。Linux 必须有可用且解锁的 Secret Service；不回退到明文或临时内核存储。
- 打包产物必须与操作系统、CPU 架构匹配；原生凭据库模块不能跨平台复制使用。

## 从源码构建并安装

由使用者在目标电脑执行。安装插件不会自动保存 JWT。

1. 检出包含本目录的仓库分支，在仓库根目录运行：

   ```sh
   cd plugins/krill-usage
   npm ci --ignore-scripts
   npm run check
   npm run build
   npm test
   cd ../..
   ```

2. 仓库包含 `.agents/plugins/marketplace.json`。在仓库根目录注册本地目录：

   ```sh
   codex plugin marketplace add .
   ```

3. 重启桌面应用。在 Plugins Directory 中选择「Krill Usage Local」，安装 `krill-usage`，然后在新会话中测试。
4. 从侧栏或会话面板入口打开 Krill Usage。若未显示扩展入口，可执行 `Open Krill Usage` 打开关联的 MCP App，再记录桌面版本进行验收；这不等同于侧栏功能已验证。

宿主可能使用 `~/.codex/plugins/cache/<marketplace>/<plugin>/local` 中的缓存副本。更新源码后重新构建、重启，并按宿主界面更新或重新安装；不要仅修改缓存文件。

格式与流程参考 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)。采用官方样例中的兼容布局 `.codex-plugin/plugin.json` 与 `.mcp.json`，没有自定义未公开的 manifest 入口字段。

## 本地账户设置

`krill_jwt` 是账户登录凭据，不保证只读权限。先阅读 [PRIVACY.md](PRIVACY.md)。本步骤必须由账户本人操作，不要让助手输入、查看或代存真实 JWT。

1. 在自己的浏览器中登录 `https://www.krill-code.com`。
2. 在开发者工具的 Application → Local Storage 中找到该站点的 `krill_jwt`。不要发送到聊天或截图。
3. 在自己的交互式终端中进入已构建的 `plugins/krill-usage` 目录，运行：

   ```sh
   node dist/credential-cli.cjs set
   ```

4. 在隐藏输入提示中粘贴 JWT 并按 Enter。输入不回显，Ctrl+C 取消；不能通过参数、环境变量或管道传入。
5. 回到面板点击「刷新」。设置入口只提供说明，没有 JWT 输入框。

凭据库使用 service `com.krill-usage.codex`、account `krill_jwt`，与 VS Code SecretStorage 分离。凭据变更前后会更新仅含随机修订号和状态的本地标记，服务丢弃旧账户的迟到请求。其他界面中已经显示的数据需刷新或重新打开。

删除本地凭据：

```sh
node dist/credential-cli.cjs clear
```

按提示输入 `CLEAR` 确认。此操作不撤销服务端 JWT，也不注销浏览器。

如果设置进程异常退出，系统会保持失败关闭状态。先关闭所有账户设置进程，再运行 `node dist/credential-cli.cjs recover` 并输入 `RECOVER`；该命令只移除已退出进程的无敏感信息锁文件。之后重新执行 `set` 或 `clear`。仍在运行的进程锁不会被移除。

## 打包与测试

```sh
npm run check
npm run build
npm test
npm run package
```

`artifacts/krill-usage-codex-0.1.0-<platform>-<arch>.tar.gz` 包含服务器、界面、当前平台凭据库二进制和许可证。解压后的 `krill-usage` 是完整插件目录，无需安装 npm 依赖，但仍需 Node.js 22+。把它放到本地目录的 `plugins/krill-usage`，按前述 marketplace 流程安装。`.tar.gz.sha256` 提供校验值。

开发测试只使用合成数据和注入式凭据库替身，不读取或保存真实凭据，也不访问真实 Krill API。新增 CI 在 Linux、Windows、macOS 构建检查插件；原有 VS Code CI 保持不变。

### 桌面宿主验收清单（尚待执行）

- 记录操作系统、CPU、桌面版本和 Node.js 版本，从本地 marketplace 安装。
- 检查侧栏、会话面板、设置入口与 HTML 界面。
- 验证点击刷新不会发起模型轮次，检查深浅主题和窄面板。
- 验证设置重开后仍生效；隐藏或关闭面板后无后续界面定时调用。
- 使用合成凭据验证系统凭据库写入、读取、删除。真实 JWT 仅由本人输入，并需单独明确授权。
- 验证账户切换、失败后的旧数据标记、未知额度和套餐耗尽后的余额回退。

## 来源与许可证

新代码采用 GPL-3.0-only。构建复用同仓库 `src/model.js`、`src/jwt.js`；根目录保留 0.1.3 的 MIT 历史声明。MCP 入口、设置和打包方式参考 [OpenAI MCP Extensions / Bits & Bolts](https://github.com/openai/mcp-extensions/tree/7e1be49daea03d7ec46ed2472f410099db2743d6/plugins/bits-and-bolts)，Apache-2.0 许可证及修改说明见 `NOTICE`、`LICENSES/`。未复制 Data Analytics 的专有代码。
