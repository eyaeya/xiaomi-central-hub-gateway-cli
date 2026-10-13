# mijia-api 能力覆盖与联调审查

日期：2026-10-13。此报告为只读源代码审查，不代表再次执行设备操作。后续修复及真机结论应记录在本轮实施/验收记录中。

## 固定基线与方法

- 上游：[Do1e/mijia-api](https://github.com/Do1e/mijia-api)，本次通过 `git ls-remote origin HEAD` 核验远端仍为 `2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1`（v5.0.0）。审查全部已跟踪 Python 模块、CLI 参数、14 个 MCP 工具、Skill、文档与解密辅助脚本。
- 本项目审查起点：`1653a3e`。以下本地路径/行号指这个固定版本；本轮改动可能移动行号，不应把基线缺口当作修复后的状态。
- [官方文档站](https://mijia-api.do1e.com)通过本次浏览器检索工具无法读取，使用同一上游 SHA 内 `docs/` 的原始文档核验，而非搜索摘要或第三方教程。仓库临时下载的未跟踪文件不属于上游能力证据。
- 未读取/输出凭据，未调用任何真实家庭/设备 API。运行时效果以独立真机验收为准。

## 结论

**基线不能称为“mijia-api 全部能力已集成”。** 主要设备业务端点已迁移为原生 TypeScript，覆盖代码调用与 CLI 两个入口；MCP 服务、批量便利接口、规格缓存和部分 Agent 体验尚不完整。上游没有实现的本地 miio、推送订阅或通用设备历史不能当作迁移遗漏。自动获取中枢登录码是本项目新增能力，不能归因于上游已提供完整网关登录功能。

## 逐项证据矩阵

上游文件链接固定到已核验 SHA。`已覆盖` 表示代码路径存在且语义对应，不等于所有设备均真机验收。`差异` 不一定是缺陷。

| 能力 | 上游证据 | 本项目基线与判断 |
| --- | --- | --- |
| 代码 SDK | [apis.py](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L24)、[devices.py](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/devices.py#L73) | 已覆盖 TS `CloudClient`/transport/auth；Python 动态属性语法不是必须照搬的能力。`core/src/index.ts:3-7` 导出。 |
| CLI | [__main__.py:32-308](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/__main__.py#L32) | 已覆盖主要业务命令；参数形态按 xgg JSON/Commander 约定重做。 |
| MCP 服务器 | [mcp_server.py:45-434](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/mcp_server.py#L45) | **缺失入口**。上游 14 tools，基线没有 MCP 子命令或 server。CLI 可供 Agent 调用不等价于已实现 MCP。 |
| 云端 QR 登录、复用、刷新 | [apis.py:182-309](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L182) | 已覆盖；`cloud/auth.ts:314-439` 两段式有界流程，兼容 auth.json。 |
| 终端二维码显示 | [apis.py:136-146,229-234](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L136) | **部分**。CLI 基线只返回 `qrUrl/loginUrl`，没有 ASCII 图、图像附件或明确中文引导。协议完成不等于 Agent 已展示二维码。 |
| Agent 登录等待 | [mcp_server.py:356-434](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/mcp_server.py#L356) | 上游 MCP 后台等待并查询 status；xgg `login` + `login --complete` 是可行替代，但基线 Skill 没有教 Agent 完成该流程。 |
| 授权状态检查 | [apis.py:72-93,399-402](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L72) | 已覆盖 `cloud status` 和写前认证；上游有 60 秒结果缓存，xgg 没有对应缓存。消息 API 只作内部探活，未暴露 `check_new_msg(begin_at)` 业务返回。 |
| 家庭与房间列表 | [apis.py:404-426](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L404) | 已覆盖家庭、房间名称/ID；基线 `schemas/cloud.ts:11` 丢弃房间 `dids` 关联，见下一项。 |
| 设备发现与共享设备 | [apis.py:428-485](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L428) | 已覆盖且增加分页循环/不前进保护。DID 去重；`homeId=shared` 支持单独共享列表。 |
| 设备家庭/房间富化 | [mcp_server.py:95-110](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/mcp_server.py#L95) | **缺失**。`CloudDevice` 只保留 home_id；Agent 难以可靠解析“书房中的某设备”。应保留房间关联而继续剔除 token/地址。 |
| 按 DID/唯一名称选设备 | [devices.py:83-108](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/devices.py#L83) | 已覆盖，xgg 还允许家庭限定。冲突拒绝操作，避免误控。 |
| 公共 MIoT URN 规格查询 | [devices.py:256-319](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/devices.py#L256) | **部分**。transport.getSpec 可直接按 URN 不登录；高层/CLI 仅 `device spec --did/name`，会先枚举授权设备。缺独立 `--spec-type` 入口。 |
| 规格磁盘缓存 | [devices.py:301-309,385-389](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/devices.py#L301) | **缺失**。每个 get/set/action 重新发现设备、HTTP 拉规格。应先实现操作实例内缓存/准备对象，后续按完整 URN+格式版本安全持久缓存。 |
| 规格中文说明与去重 | [devices.py:26-35,347-383](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/devices.py#L347) | **部分**。xgg 用 service.property 或 SIID.PIID 消歧合理；但丢弃属性/动作 `comment`、枚举 comment，少了中文说明。 |
| 单属性读取/写入 | [apis.py:576-704](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L576) | 已覆盖数字或名称选择，并验证 spec 权限、类型、范围、枚举。CLI 写前快照/原值保护比上游更严格。 |
| 批量属性 get/set | [apis.py:628-636,691-704](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L628) | **缺失高层接口**。xgg 单个请求固定 params 数组长度 1；通用 transport 可手工请求不等价于受验证的批量能力。 |
| 全部/多个可读属性 | [mcp_server.py:159-187](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/mcp_server.py#L159) | **缺失便利接口**。上游 MCP 可省略 prop_names 获取全部可读属性，xgg get 必须指定单属性。 |
| 读取值的新鲜度 | [apis.py:595-607](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L595) | **信息丢失**。上游原始 API 保留可选 updateTime；xgg schema:67-73 剔除它。双向联调应保留服务时间+本地观测时间，不把云缓存值直接称实时。 |
| MIoT 动作与输入 | [apis.py:706-780](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L706) | 单动作已覆盖，输入按 spec 验证。**缺批量串行动作**。上游允许额外 kwargs，xgg 只允许声明输入是审慎差异。 |
| 无 spec 的原始 MIoT | [apis.py:628-633,691-696](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L628) | **部分**。上游原始 API 可仅凭 DID/SIID/PIID；xgg 高层即使给数字也必须有 spec。不要声称无规格旧设备均可控；若增加逃生入口须明确验证边界。 |
| 场景列出与运行 | [apis.py:487-537](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L487) | 已覆盖；xgg 限定家庭并检查场景归属。 |
| 场景按名称/多个运行 | [__main__.py:413-435,530-532](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/__main__.py#L413) | **缺失便利接口**。xgg 仅显式 scene-id + home-id。显式定位更安全；未来名称选择需唯一性校验，不能复刻上游 CLI 首个同名匹配。 |
| 耗材 | [apis.py:539-574](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L539) | 已覆盖；输出经过白名单 schema，未保证保留任意原始附加字段。 |
| 统计 | [apis.py:782-868](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L782) | 已覆盖小时/日/周/月及 v3/旧类型；xgg 时间范围必填，上游可默认最近 30 天。这不是任意传感器历史或推送流。 |
| 小爱指令/朗读 | [mcp_server.py:308-353](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/mcp_server.py#L308) | 已覆盖两个 action；xgg 要明确设备，避免随机选第一音箱。**quiet 默认未对齐**：上游 true，xgg false。 |
| 协议 RC4/GZIP/签名 | [miutils.py](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/miutils.py) | 已覆盖原生实现和固定向量；已保留许可说明。 |
| 地区/locale | [apis.py:26-31,63-69](https://github.com/Do1e/mijia-api/blob/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/mijiaAPI/apis.py#L26) | 差异：上游跟随进程 locale，xgg 固定 CN/zh_CN；双方都使用同一 API 域，没有完整地区服务器切换实现，不能宣称全球地区全覆盖。 |
| 解密诊断脚本 | [decrypt/](https://github.com/Do1e/mijia-api/tree/2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1/decrypt) | **未迁移开发者工具**。协议内部可解密不等于已提供 HAR 解密命令。非设备直控核心；避免复制把秘密放 argv 的接口。 |
| 本地 miio LAN / UDP | 已跟踪模块、依赖及公开方法完整检索 | **上游没有**。云端 `/home/rpc/...` 与 UDP miio 不是一回事；xgg 原有 WS 网关属于独立能力。 |
| 云端订阅/监听 | 已跟踪模块、公开方法完整检索 | **上游没有设备推送订阅或 watch**。check_new_msg 是消息检查/认证探活。xgg 可新增有界轮询，但必须标明“轮询”，不能称原生云端事件订阅。 |
| 通用设备历史/场景编辑/固件升级 | 公开 API/CLI/MCP 清单完整检索 | **上游没有通用封装**。统计端点、运行已有场景不等于上述能力。 |
| 中枢自动取码与本地会话 | 上游无公开方法；本项目 `cloud/gateway.ts:48-91` | **本项目新增**。显式目标 DID、内存取码、live daemon 复用。不能推断所有网关/路由器/屏幕均兼容。 |

## 从上游得到的具体改进建议

1. **把状态观察做成正式能力。** 上游批量 get 与 xgg 既有 variable watch 可以组成 `cloud device get-all` / `watch`：先固定设备身份/规格，再分批读取、逐项输出错误，标记 poll 时间与可选 updateTime；有最大轮数/时长、最低间隔、认证/协议错误立即退出。不要在每轮重新发现全家所有设备，也不要把无变化输出当作“设备未响应”。
2. **修复既有日志 follow 的错误吞没。** 基线 `packages/cli/src/commands/rule/logs.ts:208-215` 对所有错误无限重试，包括 AuthRequired/AuthExpired/SchemaError，违反 AGENTS §6/§7，可能令云端刺激后的网关观察永不返回。认证/协议错误应传播至结构化退出码；临时网络失败可有界退避。增加有界观察与终止清理，便于 Agent 不丢失任务。
3. **复用规格，保留身份。** 上游把设备对象和 spec 缓存复用；xgg CLI set 先 getProperty 再 setProperty，基线各自重新按名称解析和拉 spec。准备操作后绑定 DID/SIID/PIID，避免同名设备在读原值与写入之间变更导致审计对象错配；缓存公开规格不缓存实时值。
4. **补齐家庭/房间与中文语义。** 保留 roomlist.dids 和 MIoT comment。它们对 Agent 正确找设备/解释枚举有直接价值，不需放开 token、地址、网络标识等敏感字段。数字 ID 仍是最终操作身份。
5. **统一二维码与登录优先级。** 上游 Skill 因 CLI login 阻塞而禁止 Agent 调用（`skills/SKILL.md:17-35`）；上游 MCP 则有 QR+后台等待。xgg 两阶段设计能改善这一点：Agent 输出二维码图与米家 App 引导，用户扫码后有界完成，随后优先 cloud gateway login，不向用户额外索码。不要照搬上游 Skill 的“禁止 login”。
6. **更新本项目 Skill 的事实来源。** 基线 `.claude/skills/xgg-rule-authoring/SKILL.md:66-72` 仍是“会话失效就停手要码”，与新的 AGENTS 云端优先规则矛盾。必须同步源 Skill、公开分发副本及已安装副本，加入两向联调的读基线→刺激→观察→恢复→再确认流程。
7. **控制播报与结果语义。** speaker run 默认静默更适合 Agent；显式选择音箱应保留。上游部分 CLI/MCP 文案将 code=1 描述为成功，xgg 已区分 accepted/confirmed，不能为追求“完全一致”倒退。回读和时间关联才是效果证据。
8. **如需宣称三种入口全部覆盖，补 MCP 或明确范围。** MCP 应作为薄适配复用同一 usecase、schema、授权、snapshot guard；不另起一套不受保护的设备写入，也不把 daemon 私有 IPC 误称 MCP。是否发布 MCP 应在设计/ADR 中显式决定。

## 应保留的安全与语义差异

- 明确家庭/DID/音箱目标，同名拒绝；不会默认选第一设备或第一同名场景。
- 写前记录可恢复原值；没有可确认原值时不能悄悄继续。动作、场景和语音文本只有审计，没有普遍逆操作。
- 网络超时后的物理写入不自动重放；明确 code=1 只表示接收。
- 持久凭据与待扫码状态使用私有文件权限；不复刻上游 debug 输出认证对象和原始响应的做法。
- 不把完整设备原始信息（token、位置/网络等）暴露为默认 JSON；只补对操作定位和时间判断必需的字段。

## 覆盖声明建议

基线适合表述为：“基于 mijia-api v5 协议，原生提供米家主要云端设备操作，并与中枢本地规则/日志形成联调流程；提供显式云端取码登录。”

不适合表述为：“全部能力无遗漏”“所有米家设备均可控制”“云端实时订阅已完成”“扫码一次永久免登录”。本轮修复完成后应逐项更新验收记录，仍保留未实现的 MCP/开发辅助工具及实机覆盖边界。

## 审查后补充：属性来源并非总是设备实时值

本轮联调发现“写入已确认而回读值暂未一致”后，重新核验[小米官方 Wi-Fi 设备控制文档](https://iot.mi.com/v2/new/doc/plugin/other/connection-wifi)：`datasource=1` 优先服务器缓存，无缓存才下发 RPC；`2` 直接下发设备 RPC；`3` 只读缓存。`0` 不在该文档定义中。上游与本项目基线都固定使用 `1`，因此 `get` 每次发 HTTP 请求也不代表设备最新值。

这项事实应进入 API/Skill 和恢复流程：区分自动来源、设备读取与仅缓存，写前恢复基线和写后效果验证优先明确设备读取。设备或连接类型不支持直接读取时，应报告限制，不以过期缓存宣称恢复成功；也不能仅由缓存未更新推断设备未恢复。具体设备结论归属当次真机验收，不能从此文档反推。

## 本轮 Core 修复落实

上述矩阵继续保留固定基线，不因修复而覆写审查证据。本轮已补单设备批量/全部可读属性、逐项失败、家庭房间关联、公开 URN 规格查询、中文 comment、updateTime、实例元数据缓存与 TTL/clearCache、静默音箱默认以及三种读取来源。资源侧 54 项单元测试、26 项云端契约和 core typecheck 通过；独立审查未发现新增问题。MCP、批量物理写、磁盘规格缓存等未在本轮 Core 变更中引入。

CLI、Skill、公开分发树、打包与全部设备的最终验收由本轮主实施记录汇总，不能用这组 Core 测试代替其完成证据。
