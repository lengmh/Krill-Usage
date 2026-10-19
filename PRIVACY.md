# Krill Usage v0.1.5 凭据与隐私说明

该扩展为非官方客户端。用户通过本扩展登录时输入的**账号邮箱和密码**，可能与登录官网使用的长期凭据相同，并非独立只读 API Key；JWT 同样属于具备账号权限的认证凭据。

## 默认存储策略

- 默认 `krillUsage.rememberPassword = true`。**成功登录且完成套餐接口验证后**，JWT、邮箱和密码作为单一凭据记录存入 VS Code `SecretStorage`，避免部分写入混用不同账号。
- 密码使用 VS Code 原生 `showInputBox({password:true})` 输入，不写入 `settings.json`、工作区代码、插件日志、额度快照、错误报告或遥测。
- 将 `krillUsage.rememberPassword` 关闭会立即尝试删除保存的邮箱、密码，保留 JWT。该选项在 Settings 中属于 `application` 范围，不接受工作区仓库配置来替用户切换。
- 手动设置新 JWT 会删除旧账号邮箱及密码，避免 JWT 到期时自动登录回旧账户。
- `Krill: Clear Credentials` 清除所有认证字段，保留不含凭据的清除标记以防旧版本存储恢复。清除本地凭据不等于在 Krill 官网注销登录或吊销 Token。
- `SecretStorage` 的加密/保护能力取决于 VS Code 和本机环境，不保证阻止具有同一用户权限的恶意程序读取。

## 网络

- 邮箱与密码只发送至 `POST https://www.krill-code.com/api/auth/login`。
- JWT 只通过 `Authorization: Bearer` 发送至 `GET https://www.krill-code.com/api/subscription`。
- 固定 HTTPS 域名、禁用自动重定向、设置超时与响应体长度上限；不会将账号凭据传给开发者服务或其他网站。
- JWT 明确失效时，仅使用已记住的账号密码进行一次恢复登录和一次额度重试；认证恢复失败即在当前扩展会话内暂停后续自动登录；主动重新登录、更换凭据或重载扩展后可再次尝试。
- 网络、Cloudflare Challenge 和服务器错误不会自动触发密码重登，不会绕过 CAPTCHA、TOTP 或邮箱验证。

插件查询返回的套餐与余额仅保留在运行进程内存，不记录完整个人资料或请求流水。本插件无遥测和工作区内容收集功能。Krill 网站、服务商及 VS Code 自身的隐私政策独立适用。

多个 VS Code 窗口共享凭据，SecretStorage 不提供跨窗口比较并交换事务。自动恢复写入前检查账号身份可阻止网络等待期间的旧账号恢复，但不能完全排除同时写入的极短竞态；切换或清除账号前请关闭其他运行本扩展的窗口，完成后再打开。清除不能撤回已发送请求，迟到的结果不会覆盖当前窗口。
