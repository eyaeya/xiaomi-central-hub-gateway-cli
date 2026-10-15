# @eyaeya/xgg-core

`@eyaeya/xgg-core` 是 `xgg` 的协议、会话、schema、资源和用例层。它面向需要在 Node.js 程序中复用米家云端设备控制与小米中枢网关极客版能力的开发者。

大多数用户应该直接安装 CLI：

```bash
npm install -g @eyaeya/xgg-cli
```

`@eyaeya/xgg-cli` 会自动安装匹配版本的 `@eyaeya/xgg-core`。只有在 Node.js 程序里直接复用协议、schema 或 usecase 层时，才需要单独安装：

```bash
npm install @eyaeya/xgg-core
```

GitHub 仓库：[eyaeya/xiaomi-central-hub-gateway-cli](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli)。

## 包内容

npm tarball 只包含：

- `dist/`
- `LICENSE`
- `README.md`
- `THIRD_PARTY_NOTICES.md`

npm 包只包含运行 core 所需的 `dist`、许可证、第三方通知与本 README；它不依赖仓外参考文件、开发文档、探测记录或快照。

## 说明

网关本地通过 WebSocket 承载的加密二进制协议通信，新增云端 transport 独立使用 HTTPS。除低层逃生口外，core 层使用 schema 校验返回，避免调用方直接依赖未建模响应。

## v3.2.0：离线灯光公式 SDK

从 v3.2.0 起导出 `generateLightingFormula` 与 `LightingFormulaOptions`。函数同步执行纯计算，不创建 transport、不读凭据、不请求网络或写文件，也不修改设备/规则：

```ts
import { generateLightingFormula } from '@eyaeya/xgg-core';

const result = generateLightingFormula({
  mode: 'temperature',
  latitude: 23.129,
  min: 3200,
  max: 5400,
  date: '2026-10-15',
  sampleMinutes: 60,
});
// result.expression：通过现有网关表达式语法检查的字符串
// result.preview?.samples：指定日期当地钟表时间的整数样本
// result.warnings：近似模型和数值修正边界
```

支持 `temperature`（K）与 `brightness`（百分比），纬度与上下限必须显式提供。亮度可传 `speed`（默认 1，允许 0.1–20）、`offsetMinutes`（默认 0，允许 −180 至 180）与 `invert`（默认 false），并在归一化参数中返回默认值；色温拒绝这些控制。亮度斜率为 `4.5*speed/M`，速度小于 1 更缓、大于 1 更陡，代表无量纲倍率而非时长。`date` 仅控制预览，生成表达式仍读取网关运行时日期；无效参数抛出 `ConfigError`。

数学行为参考 [MIoT Geek 工具](https://lzj.ac.cn/tools/iot/miot-geek)，xgg 独立实现，修复正午除零、极区非有限值并统一公式/预览取整。它仍是固定正午与近似月份的曲线，不是天文日出日落计算；亮度时间偏移不回绕午夜，极区数值延伸也不等于真实光照模型。返回的单位、警告和归一化参数应保留给调用者。SDK 不替用户选择灯具范围或把百分比换成原始亮度值；应用前需检查实际 spec、步进、写入权限与用户授权，并由现有规则工作流实施和验证。

## v3.1.0 与 CLI 更新

v3.1.0 引入 CLI 更新功能。`xgg update --check`、`xgg update` 和前台自动更新均由 CLI 层负责，直接导入 Core SDK 不会执行版本检查、启动更新进程或修改安装。CLI 升级会校验配套 Core；SDK 使用者仍由项目的包管理器和锁文件管理依赖版本。完整行为见 [v3.1.0 发布说明](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli/blob/v3.1.0/RELEASE_NOTES.md)。

## 云端 SDK 与中枢引导

v3.0.1 补齐五类中枢候选指引，沿用 v3.0.0 的中枢定位流程与 v2.2.0 的原生 TypeScript 云端实现，不要求 Python 或网关 daemon。公共导出包括 `CloudClient`、`createCloudTransport`、`cloudLoginStart` / `cloudLoginComplete`、`cloudStatus` / `cloudLogout` 与 `loginGatewayViaCloud`，以及独立的云端快照工具。支持设备与家庭发现、MIoT spec、属性读写、动作、场景、耗材、统计和音箱；已有网关 SDK、workflow 租约、规则与习惯学习能力继续保留。

已有云端授权时，可直接创建客户端读取设备报告值：

```ts
import { CloudClient, createCloudTransport } from '@eyaeya/xgg-core';

const cloud = new CloudClient(createCloudTransport());
const devices = await cloud.listDevices();
const reading = await cloud.getProperty(
  { did: '<DID>' },
  { property: 'light.on' },
  { source: 'device' },
);
```

默认授权文件兼容 `~/.config/mijia-api/auth.json`；`createCloudTransport({ authFile, timeoutMs })` 可指定独立文件和有界超时。认证函数支持可注入 fetch/store 便于测试。`cloudLoginStart` 与 `cloudLoginComplete` 提供有界两阶段扫码流程；二维码 PNG 生成与对话展示由 CLI 层提供。凭据可复用/刷新，失效仍需重新授权，不能记录 token 或扫码秘密。

`getProperty` / `getProperties` 的 `source` 为 `auto | device | cache`，默认 `auto`。验证刚执行的操作或恢复原值时显式用 `device`；它请求设备 RPC，不降级为缓存，但并非所有设备都支持。`cache`、自动来源的缓存及 `updateTime` 不能证明即时状态。元数据缓存只缓存家庭/设备/spec，不能把它当作设备状态订阅；CLI 的 watch 也是轮询，并非服务端推送。

`loginGatewayViaCloud` 根据明确 DID 取地址与验证码，并在内存内交给网关登录流程，优先复用 live daemon。调用方可以省略 `baseUrl`，由云端发现地址；只有已知且确认有效时才传覆盖地址。候选涵盖独立中枢、路由器、屏幕、音箱与智能存储；明确 DID 后沿用同一双 RPC 路径，没有类别白名单，仍须核对型号、固件与 RPC 支持。SDK 调用者必须向它提供 `agentBinary`，并将返回的 `host` 作为后续本地调用的 `baseUrl`，同时复用相同的 session 文件；不会隐式选择默认网关。CLI 另提供 `baseUrl`、`nextCommand.argv` 和 `nextAction` 来引导后续操作，六位码不进入结果。仍须能够从当前主机访问中枢局域网地址。纯网络故障先由交互层检查地址、端口、是否同网及路由，不立即索取新码。地址发现/取码不支持或确实需要补充地址/认证信息时，保留具体错误并引导用户只补充缺失信息；不能猜测 IP 或反复尝试旧码。

本次候选目录包括小米中枢网关；BE10000 Pro、BE7200 Pro、BE6500 Pro、BE3600 Pro 套装主路由及网线版主路由；家庭屏 11、中控屏 Max；Sound 2 Max、Sound 2 Pro；小米智能存储，共五类 11 款。智能存储仅有中枢、无网关能力；候选收录不等于已验证极客接口或全型号真机认证。逐款依据见 [中枢定位指南](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli/blob/v3.0.1/skills/xgg-rule-authoring/references/gateway-discovery.md)。

云端物理写入不使用网关 workflow 租约，也不会自动套用 CLI 的 Agent guard 或写前快照。直接调用 SDK 的程序负责授权范围、设备直读原值、快照、写后回读及恢复；可使用导出的云端快照工具。云端 mutation 不自动重发，结果未知时抛出 `NotConfirmedError`；动作、场景和音箱审计不是可逆备份。逐属性错误及 `accepted` 必须分别处理，不能仅凭 API ACK 宣称设备已经执行。

云端协议参考 [Do1e/mijia-api](https://github.com/Do1e/mijia-api)，来源与保留的许可见随包 `THIRD_PARTY_NOTICES.md`。本次未包含上游所有 MCP、批量物理写入及开发辅助入口，完整范围见 [v3.1.0 发布说明](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli/blob/v3.1.0/RELEASE_NOTES.md)。

## 写操作与 workflow 租约

公开的 typed mutator（规则、变量和备份资源写 API）会自动取得对应网关的 workflow 租约，并在同一个 daemon 连接上完成整段 live pre-read、校验、read-modify-write、写入和必要的 readback。复合 mutator 内部继续调用其他 typed mutator 时会复用同一个租约，不会重复获取。

低层 `agentCall({ kind: 'write' })` 在没有外层 workflow 时也会自动取得一个仅覆盖该 RPC 的租约，以兼容既有 Node.js 调用。单 RPC 租约不能保护调用方自己拼接的复合读改写；此类流程必须显式包在 `withMutationWorkflow` 中：

```ts
await withMutationWorkflow(
  { baseUrl, store, operation: 'my-rule-update' },
  async () => {
    const before = await agentCall({ baseUrl, store, method: '/api/getGraph', params: { id } });
    await agentCall({
      baseUrl,
      store,
      method: '/api/setGraph',
      params: update(before),
      kind: 'write',
    });
    return agentCall({ baseUrl, store, method: '/api/getGraph', params: { id } });
  },
);
```

`loadBackup()` 是异步 restore 的安全复合 API：它在同一租约中先调用 `downloadBackup` 并确认缓存进度到 100，再调用 `loadBackup` 并确认恢复进度到 100。下载 ACK/进度含糊时不会进入 load；load ACK 缺少进度句柄、任一阶段超时或确认丢失都会抛出 `NotConfirmedError` 并 fence 当前 mutation。调用方应 logout、重新登录并检查 live state，不能盲目重试。可用第三个参数配置 `pollIntervalMs` 和 `pollTimeoutMs`，每个阶段获得独立超时预算；需要真实 terminal 明细时传 `includeProgress: true`，返回 `{ downloadResult, downloadProgress, result, progress }`。高层 API 不接受进度查询注入，不能跳过真实 terminal 确认。

standalone raw `agentCall()` 调用 `/api/loadBackup` 时也执行同样的 terminal wait。若 raw restore 已处于显式 `withMutationWorkflow` 中，调用方仍必须在该 callback 返回前完成 `/api/getBackupProgress` 的 terminal 确认。

## Typed 节点 ID

`addNode({ shortcut })` 新建 typed 节点时，显式 `shortcut.id` 必须符合小米网页编辑器的 `[A-Za-z0-9]+`；省略则由 core 生成兼容 ID。校验发生在 workflow 租约、session 与任何 RPC 之前。只有 export/import 重放已存在的 modeled typed 节点时，才可同时传 `legacyNodeIdReplay: true` 和明确的非 canonical `shortcut.id`；该 intent 对 raw node、缺少 ID 或已兼容 ID 都会拒绝，不能用来放宽普通新建语法。持久化旧图和 opaque node 的读取 schema 仍保持宽松，不会静默改名。

## 规则校验的 I/O 契约

`validateGraph({ graph })` 默认只执行本地、确定性的 schema/字段/表达式检查，不会隐式访问 daemon、网关或公网 MIoT spec 服务。需要设备 spec-aware 检查时，调用方必须显式注入 `getDeviceSpec`，并自行决定使用网络、缓存还是本地 fixture：

```ts
const localIssues = await validateGraph({ graph });

const specAwareIssues = await validateGraph({
  graph,
  getDeviceSpec: (urn) => getDeviceSpec(urn, { timeoutMs: 5000 }),
});
```

在线变量校验通过 `listAvailVars` 显式注入清单；每项必须保留完整的 `{ scope, id, type: 'number' | 'string' }`。校验器按精确 scope/id 判断存在性，并在所有可判定的引用点核对实际类型。省略 callback 时仍执行合法 scope 和本地图结构检查，但不会假装知道变量是否存在或是什么类型。`exportRuleFromView(..., strictRoundtrip=true)` 会读取源网关规则内与 global 变量的实际类型，在生成任何 staging 脚本前拒绝路径化 mismatch 或缺失 global；permissive export 保留 warning。

`createRule()` 若由 SDK 调用方直接携带初始变量卡，也会在首笔 `/api/setGraph` 前执行同一在线类型门禁；CLI 的空图 `rule new` 不增加这次预读取。只有明确的 raw/restore 流程才应传 `CreateRuleOptions.varCheck: false`。

`getDeviceSpec` 会复核 property 卡的 notify/read/write access、dtype/domain 与 action input 契约。若调用方还有目标网关设备清单，可同时注入 `getDevice(did)`，对 `deviceInput` / `deviceInputSetVar` property/event push source 追加实例级 `pushAvailable` 诊断；没有该回调时不得把离线结果表述成已证明 push 可用。`AddNodeShortcut.allowNoPush: true` 仅是本次 typed add 的 transient runtime-probe intent，不持久化、不绕过任何 property access；后续带 `getDevice` 的 `validateGraph` 会继续如实报告 no-push。preload 也只控制启用时首次查询/评估，不改变 notify/read 资格。

spec registry 的 404 会返回 warning，表示该 URN 的外部检查被跳过；网络/超时/5xx 或 schema 失败会返回独立 error issue。两者都不会中止图遍历，因此同一次结果仍包含已经发现的本地问题。`validateGraphOrThrow` 会在收集完整 issue 列表后，按既有契约对第一个 error 抛出 `ConfigError`。

注入 spec 后，`deviceOutput` property-write 会核对属性存在性与 write access、literal 的 MIoT 原生类型和 value-list/value-range/step，以及 variable ref 的实际类型、dtype 与有效 range metadata；action input 继续使用同一 literal/变量基础契约，并额外检查 `action.in` 与 `props.ins` 的完整逐索引映射。

`deviceOutput` typed variable ref 只支持不含 `value-list` 字段的 string 目标，或不含该字段且带有效 value-range 的 number 目标。当前 xgg 对 boolean 与任何存在 `value-list` 字段的目标（包括空数组）采用 literal-only 契约；spec-aware validation 会诊断 persisted legacy ref，strict export 与 `enableRule` 会 fail closed。默认 enable 只对实际存在的 output ref 做聚焦 spec 证明，404、网络/超时或无效 spec 都阻止 enable，且不会查询或扩大校验到无关旧设备节点；显式传入 `EnableRuleOptions.getDeviceSpec` 时仍保留全图 spec-aware 行为。

## DATA 响应大小限制

core 在解密 DATA frame 后、同步解压前执行两层上限检查：压缩数据默认最多 16 MiB，声明及实际解压后的 UTF-8 JSON 默认最多 64 MiB。长度声明必须为正数，zlib 的 `maxOutputLength` 还会阻止实际输出越过声明值。超限或损坏的响应会作为网络/协议失败结束当前 session。

默认值由 `DEFAULT_MAX_INNER_COMPRESSED_BYTES` 和 `DEFAULT_MAX_INNER_JSON_BYTES` 导出。确实需要处理更大备份响应的库调用方可以显式配置 `SessionChannel`，但应使用部署中测得的有限值，不要取消上限：

```ts
const channel = new SessionChannel({
  send,
  recv,
  receiveLimits: {
    maxCompressedBytes: 32 * 1024 * 1024,
    maxJsonBytes: 96 * 1024 * 1024,
  },
});
```
