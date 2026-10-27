# Krill Usage v0.1.7 凭据与隐私说明

该扩展为非官方客户端。用户通过本扩展登录时输入的**账号邮箱和密码**，可能与登录官网使用的长期凭据相同，并非独立只读 API Key；JWT 同样属于具备账号权限的认证凭据。

## 默认存储策略

- 默认 `krillUsage.rememberPassword = true`。**成功通过官网登录取得 JWT 后**，JWT、邮箱和密码作为单一凭据记录存入 VS Code `SecretStorage`，避免部分写入混用不同账号。
- 密码使用 VS Code 原生 `showInputBox({password:true})` 输入，不写入 `settings.json`、工作区代码、插件日志、额度快照、错误报告或遥测。
- 将 `krillUsage.rememberPassword` 关闭会立即尝试删除保存的邮箱、密码，保留 JWT。该选项在 Settings 中属于 `application` 范围，不接受工作区仓库配置来替用户切换。
- 手动设置新 JWT 会删除旧账号邮箱及密码，避免 JWT 到期时自动登录回旧账户。
- `Krill: Clear Credentials` 清除所有认证字段，保留不含凭据的清除标记以防旧版本存储恢复。清除本地凭据不等于在 Krill 官网注销登录或吊销 Token。
- `SecretStorage` 的加密/保护能力取决于 VS Code 和本机环境，不保证阻止具有同一用户权限的恶意程序读取。

## 网络

- 邮箱与密码只发送至 `POST https://www.krill-code.com/api/auth/login`。
- JWT 只通过 `Authorization: Bearer` 发送至 `GET https://www.krill-code.com/api/subscription`。
- 固定 HTTPS 域名、禁用自动重定向、设置绝对请求超时与响应体长度上限；不会将账号凭据传给开发者服务或其他网站。429/503 冷却尊重服务端 `Retry-After`。
- JWT 明确失效时，使用已记住的账号密码受控重登。新 JWT 在登录成功后先写入 SecretStorage，再查询额度；查询 GET 失败不会丢弃已获得的 JWT。只有确定密码错误或需要人工验证时暂停自动登录，网络与服务器临时失败走有限冷却；绝不无限重试 POST。
- 网络、Cloudflare Challenge 和服务器错误不会自动触发密码重登，不会绕过 CAPTCHA、TOTP 或邮箱验证。

插件查询返回的套餐与余额仅保留在运行进程内存，不记录完整个人资料或请求流水。本插件无遥测和工作区内容收集功能。Krill 网站、服务商及 VS Code 自身的隐私政策独立适用。

多个 VS Code 窗口共享凭据，SecretStorage 不提供跨窗口比较并交换事务。自动恢复写入前检查账号身份可阻止网络等待期间的旧账号恢复，但不能完全排除同时写入的极短竞态；切换或清除账号前请关闭其他运行本扩展的窗口，完成后再打开。清除不能撤回已发送请求，迟到的结果不会覆盖当前窗口。

## 刷新诊断

状态栏 Hover 仅显示失败阶段、已知错误码、HTTP 状态、允许列表内的网络错误码、耗时、重试次数与冷却时间；Output 面板 `Krill Usage` 仅记录这些受限字段。**不保存或输出账号邮箱、密码、JWT、Authorization 请求头、完整 URL、响应正文或异常堆栈**。诊断随 VS Code 当前窗口进程结束而失效，扩展本身无遥测或独立上传。
