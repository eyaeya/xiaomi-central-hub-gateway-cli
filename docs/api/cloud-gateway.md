# 米家云端中枢登录

发现于 2026-10-13。实机对象为路由器集成中枢，已完成云端取码 → 网关握手 → 设备与规则读取。不得将此单机证据扩大为所有网关固件都支持。

## POST /home/rpc/<did>

Base: `https://api.mijia.tech/app`。Auth: 与 [cloud.md](cloud.md) 相同的米家账号 Cookie + RC4 签名协议。DID 必须显式选择；集成中枢可能属于路由器、家庭屏，不能只筛独立 gateway 型号。

| 方法 | body | result | schema | fixture |
|---|---|---|---|---|
| 地址 | `{method:"miIO.get_autowebconfig_url",params:[]}` | `{url:"http://gateway.example:8086"}` | `schemas/cloud-gateway.ts` → CloudGatewayUrl | `fixtures/responses/cloud-gateway/url.json` |
| 登录码 | `{method:"miIO.get_central_link_passcode",params:[]}` | `{passcode:"<six digits>"}` | `schemas/cloud-gateway.ts` → CloudGatewayPasscode | `fixtures/responses/cloud-gateway/passcode.json` |

Fixture 保留真实响应结构，地址和验证码已替换；全零验证码为合成占位符，非真实凭据。云端 contract 检查包含在 `pnpm test:cloud` 中，也随 `pnpm check` 执行。

`xgg cloud gateway login --did <DID>` 在不提供 IP 或登录码时即可先发现地址、复用仍存活的 daemon，必要时获取新码并直接调用现有 login。`--base-url` 或 `XGG_BASE_URL` 会覆盖地址发现；未知目标地址时不传该参数，也不得沿用其他家庭的旧环境变量。CLI 成功结果包含 host/reused/source、明确的 `baseUrl` 以及下一步 `nextCommand.argv` / POSIX 安全 `nextAction`，不含登录码。未知响应结构报 SchemaError，错误中不保留凭据或原始响应。

地址与码都是来自所选 DID 的云端 RPC：地址返回完整 HTTP(S) 管理 origin（含端口），不是网络默认网关；登录码只能在内存交给网关登录。真实验收已清除地址/会话/登录码环境变量、不传 base-url、使用全新 session，确认地址发现、非复用登录与返回地址上的 status.live=true。该证据只覆盖本次支持对应 RPC 的路由器集成中枢，不代表所有蓝牙/Mesh 网关、屏幕或中枢固件都支持极客接口。

登录成功不会为其他本地命令隐式选择默认网关。后续 `status`、`rule list`、`rule logs`
等命令仍须携带返回的 `--base-url`，或明确设置 `XGG_BASE_URL`。使用自定义
`--session-file` / `XGG_SESSION_FILE` 登录时，返回的 status 命令同时携带该文件的绝对路径；
后续本地命令也应保留对应 session-file。`nextCommand.argv` 第一项是 `xgg`，Agent
可以按实际安装方式调整命令入口，其余参数保持原样。不会扫描 session 并选择第一个网关。

这是显式 bootstrap：不会在任意控制命令失败后自动重发写入。米家授权有效或可刷新时，无需用户手抄码；米家账号授权本身失效仍需重新扫码。本地网关仍须网络可达，云端授权并不使局域网 WebSocket 获得远程访问能力。

## 定位失败与手动回退

先在用户选定的家庭列出设备，结合实际 name、model、spec_type、房间及在线状态识别独立中枢、明确内置中枢的路由器/屏幕等候选。不要只按 gateway 名称过滤；昵称、Pro 后缀、主/子路由角色与极客功能支持都需核对。面向用户的定位流程与官方型号来源随完整 Skill 分发。

云端因权限、离线、不支持方法或目标无法确定而不能取得信息，且用户也不知道设备时，不反复要求其提供 DID。引导其在米家 App 的网关设备/中枢相关页面或候选设备页寻找极客版入口；菜单随版本而异。若仍需手动连接，一次询问缺失的 **极客版完整 URL（或局域网 IP 与端口）及当次六位登录码**。地址也可从路由器客户端列表核对候选设备后获取，但路由器后台管理 URL 不能直接代替极客版 URL。

```bash
xgg login --code <CODE> --base-url <BASE_URL>
xgg status --base-url <SAME_BASE_URL>
```

自定义 session 时两条命令保留同一 --session-file。知道地址但没有码时只补码；反之补地址。云端账号失效走扫码，局域网不可达先排查同网/VPN和设备在线状态；不要把这两类问题误报成验证码错误。既无法自动取得、用户也无法提供这两项时，明确未建立本地连接，保留可用的云端设备能力，不猜地址、不扫描或重置设备。

来源线索：[公开方法识别代码](https://github.com/609293964/mijia-geek-assistant-fnnas/blob/f33189c357d75dcd1f29a4e00efd7ce2810132a1/src/lib/mijiaPasscode.ts)。请求协议基于 [Do1e/mijia-api](https://github.com/Do1e/mijia-api)。
