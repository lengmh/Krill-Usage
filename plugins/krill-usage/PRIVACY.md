# Codex 插件隐私与凭据说明

Krill Usage 是独立维护的非官方工具，与 Krill 运营方无隶属或授权背书关系。

## 数据流

- 本地服务只向 `https://www.krill-code.com/api/subscription` 发起 HTTPS GET，通过 Authorization Bearer 发送本人保存的 JWT。
- 不跟随重定向；响应大小上限为 2 MiB，连接空闲超时为 12 秒。Cloudflare 验证不会被自动绕过。
- JWT 保存在操作系统凭据库，不出现在 manifest、非敏感设置、MCP 参数或结果、日志、工作区文件中。
- 套餐和余额通过 MCP 返回给宿主。用户或模型调用额度工具时，该用量信息可能进入会话上下文；JWT 不会随结果返回。
- 内嵌界面使用 MCP App bridge，无外部网络连接或外部资源依赖。
- 不自动读取浏览器 Local Storage、Cookie、剪贴板、其他应用凭据或工作区文件。
- 无遥测、远程托管账户服务或云端凭据代理。

## 本地保存内容

普通文件只保存显示偏好、随机凭据修订号、变更状态和短期写入锁的进程号。额度结果只在服务内存中缓存，退出后丢弃。凭据变更使旧请求失效；已显示的旧窗口需刷新或重新打开。

操作系统凭据库提供加密保存能力，但同一用户账户下的恶意软件或高权限进程仍可能访问数据。本插件不能保证 JWT 为只读凭据。删除本地 JWT 不会撤销其服务端有效性。

状态目录：
- macOS：`~/Library/Application Support/krill-usage-codex`
- Windows：`%LOCALAPPDATA%/krill-usage-codex`
- Linux：`$XDG_STATE_HOME/krill-usage-codex`，未设置时为 `~/.local/state/krill-usage-codex`

不支持明文回退。Linux 强制使用 Secret Service；凭据库不可用、锁定或正在变更时拒绝查询。凭据由本人通过本地终端隐藏输入，不要粘贴到聊天、配置文件、命令参数或环境变量。

## 验证范围

开发与 CI 仅使用合成值、模拟 API 和注入式凭据库，未使用真实账户。操作系统凭据库与目标 Codex 桌面的完整验收需在对应电脑上完成。
