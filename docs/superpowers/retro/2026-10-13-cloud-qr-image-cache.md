# 扫码立即过期：二维码图片路径必须随授权尝试变化

日期：2026-10-13。

## 现象与对照

真实新扫码验收中，多次生成 pending 后把 PNG 原子覆盖到同一个 `login.png` 路径。
用户在新码的本地有效窗口内立即扫描，手机仍提示过期。图片文件的内容已经更新，
但聊天中的图片 URL 没有改变。

随后保持相同的二维码生成机制和云端协议，仅把最新 PNG 复制到全新文件路径后展示，
用户立即扫码成功，complete 返回 `authenticated:true`。该对照强支持图片展示缓存了
旧路径内容；没有直接抓取图片渲染器内部缓存，因此不把具体缓存层实现当成已证实事实。

## 协议核对与修复

上游的扫码负载同样是服务返回的 `loginUrl`，不是 `qr` 图片地址。serviceLogin 的
`sid=mijia`、locale、location 查询参数以及二维码请求的 theme、bizDeviceType、
_hasLogo、_qrsize、_dc 均与上游一致。本次无需修改账户协议或延长后台等待。

CLI 改用 `login-<pending-identity-hash>.png`。摘要包含该 pending 的 loginUrl、qrUrl
和 expiresAt，不输出原始内容；同 pending 续接得到同一路径，新 pending 得到新路径。
生成时保留当前图并清理其他本 CLI 的旧图；完成、过期或 logout 时清理本工具固定命名
规则的图片及旧 `login.png`。绝不递归删除目录，也不删除不匹配的文件。

## 回归边界

fake CLI 测试验证同 pending 续接路径稳定、新 pending 路径变化、保留当前图、清理
旧版与 hash 图片、保留无关文件。真实用户扫码成功来自上述独立路径对照；回归单测
不使用真实账号、不生成额外云端二维码，避免打断用户当前授权。
