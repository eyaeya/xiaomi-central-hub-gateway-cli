# 云端扫码授权与 Agent 工作流

实现：`packages/core/src/cloud/auth.ts`；CLI：`packages/cli/src/commands/cloud-login.ts`。
本次审查改进已有认证流程，没有新增云端 HTTP 接口。HTTP JSON 仍经过
`accountSchema`、`CredentialSchema`、`pendingSchema` 校验；fake HTTP/store 单测覆盖
扫码开始、回调、刷新、域名限制、到期与等待，不把实际登录凭据保存到 fixtures。
二维码依赖决策见 [ADR 0015](../adr/0015-agent-cloud-qr-login.md)。

## 开始、展示、继续

```bash
xgg cloud login
# Agent 在会话中展示返回的 qrMarkdown 或 qrImagePath，然后提示用米家 App 扫码并确认。
xgg cloud login --complete --wait-ms 20000
```

有效的现有授权直接返回 `authenticated:true`。需要扫码时返回：

- `authenticated:false,status:'pending'`：等待扫码，不是失败。
- `qrImagePath`：由 `loginUrl` 在本机编码的 PNG 绝对路径。
- `qrMarkdown`：可直接展示给用户的 Markdown 图片。
- `qrUrl` / `loginUrl`：保留原有兼容字段，链接同样含短期登录上下文，不提交、不转发。
- `expiresAt`：本次尝试的 ISO 到期时间，默认从获取二维码起两分钟。
- `nextCommand.argv`：包含可执行文件名及参数的数组，可直接用于不经过 shell 的执行。
- `nextAction`：等价的 POSIX shell 命令，路径正确引用；与 `instructions` 一起提供继续操作和扫码说明。
- `reused`：本次是否复用了原来的 pending 二维码。

JSON stdout 中只有一条 JSON，不夹杂 ASCII 二维码。`--pretty` 仅缩进 JSON。
Agent 应先展示图片并说明“请在到期前用米家 App 扫码并确认”，再开始等待；不能
把认证 URL 当成已经登录成功。调用使用独立认证文件时，后续 `--complete` 也须使用
相同的认证文件。CLI 返回的 `nextCommand.argv` / `nextAction` 会保留当前自定义认证文件
的绝对路径（包括环境变量选择）、非默认 HTTP/扫码等待时间与 pretty 设置，避免完成时
误用默认账户。默认路径且无自定义选项时仍是 `xgg cloud login --complete`。
Agent 可按当前安装方式替换 argv 中的 `xgg` 入口，其余参数保持原样。

`--complete` 默认等待 20 秒，`--wait-ms` 接受 1–60000 毫秒，与普通 HTTP 的
`--timeout` 独立。等待窗口结束但二维码仍有效时返回相同 pending 结果，并保留原图；
Agent 可以再次调用 complete。实际网络失败仍报 NETWORK，取消信号仍报 cancelled，
不会误报为正常等待。complete 发现二维码到期时清理 pending 和 PNG，报 `AUTH_REQUIRED`、
`details.reason:'qr-expired'`，需要重新开始。

重复 `cloud login` 默认复用尚未到期的二维码，避免用户扫描旧图时 CLI 已换成新的 lp。
`cloud login --restart` 显式替换 pending；若本地凭据 JSON/结构损坏，也允许清理坏文件
重新扫码。正常有效授权仍复用；切换账户应先显式 logout。读取权限或 I/O 错误不会被
当作坏凭据自动删除。日常设备命令始终不会修改坏凭据来触发隐式登录。

## 私有工件与云端取码

默认凭据兼容 `~/.config/mijia-api/auth.json`。待扫码上下文保存为相邻 `.pending`，
二维码目录为 `<auth-file>.qr/`，图片名为 `login-<pending-identity-hash>.png`：
同一个 pending 复用相同路径，新 pending 使用新路径，避免聊天图片缓存显示旧二维码。
文件名只含不可逆摘要，不含原始授权 URL。PNG 是本地生成，
不访问第三方二维码网站。目录权限 0700、原子写入的 PNG 和凭据权限 0600；不同
auth-file 使用不同二维码目录。完成授权或 logout 仅清理本 CLI 的 `login-<24位hex>.png`
及旧版 `login.png`，再尝试移除空目录；展示 pending 时保留当前图并清理其他已知旧图。
其他文件与子目录不会被删除，不递归清理。

云端授权和网关会话是两个状态。网关认证错误优先执行 `cloud login`，再对已确定的
实际承载中枢的设备 DID（独立中枢、路由器、屏幕、音箱或智能存储等）执行 `cloud gateway login --did <DID>`。后者在内存中
取得并使用六位码，参见 [cloud-gateway.md](cloud-gateway.md)。只有不支持云端取码、
无法明确目标或用户选择手动路径时才询问缺失的完整管理 URL（或 IP 与端口）及当前六位码；网络不通先排查连接。云端授权可以刷新，但不保证永久有效。

## 验证边界

新增单测用 fake HTTP/内存 store 验证 pending 复用、显式恢复、等待与过期，CLI 单测
用 fake 文件操作验证实际 PNG 编码、权限、原子改名、账号隔离、清理及 JSON 输出。
新的真实扫码确认与图像展示应由当次集成验收记录证明，不能用这些单测代替。
