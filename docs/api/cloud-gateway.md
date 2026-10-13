# 米家云端中枢登录

发现于 2026-10-13。实机对象为路由器集成中枢，已完成云端取码 → 网关握手 → 设备与规则读取。不得将此单机证据扩大为所有网关固件都支持。

## POST /home/rpc/<did>

Base: `https://api.mijia.tech/app`。Auth: 与 [cloud.md](cloud.md) 相同的米家账号 Cookie + RC4 签名协议。DID 必须显式选择；集成中枢可能属于路由器、家庭屏，不能只筛独立 gateway 型号。

| 方法 | body | result | schema | fixture |
|---|---|---|---|---|
| 地址 | `{method:"miIO.get_autowebconfig_url",params:[]}` | `{url:"http://gateway.example:8086"}` | `schemas/cloud-gateway.ts` → CloudGatewayUrl | `fixtures/responses/cloud-gateway/url.json` |
| 登录码 | `{method:"miIO.get_central_link_passcode",params:[]}` | `{passcode:"<six digits>"}` | `schemas/cloud-gateway.ts` → CloudGatewayPasscode | `fixtures/responses/cloud-gateway/passcode.json` |

Fixture 保留真实响应结构，地址和验证码已替换；全零验证码为合成占位符，非真实凭据。contract 检查通过 `pnpm test:contract` 执行。

`xgg cloud gateway login --did <DID>` 先发现地址、复用仍存活的 daemon，必要时获取新码并直接调用现有 login。`--base-url` 可以覆盖发现地址。CLI 成功结果包含 host/reused/source、明确的 `baseUrl` 以及下一步 `nextCommand.argv` / POSIX 安全 `nextAction`，不含登录码。未知响应结构报 SchemaError，错误中不保留凭据或原始响应。

登录成功不会为其他本地命令隐式选择默认网关。后续 `status`、`rule list`、`rule logs`
等命令仍须携带返回的 `--base-url`，或明确设置 `XGG_BASE_URL`。使用自定义
`--session-file` / `XGG_SESSION_FILE` 登录时，返回的 status 命令同时携带该文件的绝对路径；
后续本地命令也应保留对应 session-file。`nextCommand.argv` 第一项是 `xgg`，Agent
可以按实际安装方式调整命令入口，其余参数保持原样。不会扫描 session 并选择第一个网关。

这是显式 bootstrap：不会在任意控制命令失败后自动重发写入。米家授权有效或可刷新时，无需用户手抄码；米家账号授权本身失效仍需重新扫码。本地网关仍须网络可达，云端授权并不使局域网 WebSocket 获得远程访问能力。

来源线索：[公开方法识别代码](https://github.com/609293964/mijia-geek-assistant-fnnas/blob/f33189c357d75dcd1f29a4e00efd7ce2810132a1/src/lib/mijiaPasscode.ts)。请求协议基于 [Do1e/mijia-api](https://github.com/Do1e/mijia-api)。
