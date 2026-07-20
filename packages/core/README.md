# @eyaeya/xgg-core

`@eyaeya/xgg-core` 是 `xgg` 的协议、会话、schema、资源和用例层。它面向需要在 Node.js 程序中复用小米中枢网关极客版能力的开发者。

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

GitHub 仓库中的参考 bundle、fixtures、开发文档、探测记录和快照不会进入 npm 包。

## 说明

网关通信不是普通 HTTP API，而是加密 WebSocket 二进制协议。除低层逃生口外，core 层会用 schema 校验网关返回，避免调用方直接依赖未建模响应。

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

`deviceOutput` typed variable ref 只支持不含 `value-list` 字段的 string 目标，或不含该字段且带有效 value-range 的 number 目标。boolean 与任何存在 `value-list` 字段的目标（包括空数组）按固定 UI 的 literal-only 路径处理；spec-aware validation 会诊断 persisted legacy ref，strict export 与 `enableRule` 会 fail closed。默认 enable 只对实际存在的 output ref 做聚焦 spec 证明，404、网络/超时或无效 spec 都阻止 enable，且不会查询或扩大校验到无关旧设备节点；显式传入 `EnableRuleOptions.getDeviceSpec` 时仍保留全图 spec-aware 行为。

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
