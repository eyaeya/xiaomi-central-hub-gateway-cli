---
name: xgg-rule-authoring
description: Use when an LLM Agent must understand, design, inspect, validate, or operate Xiaomi Central Hub Geek Edition automation rule graphs through the xgg CLI, including the complete 25 executable cards plus nop, event/state pins, MIoT enums and value semantics, complex temporal/state patterns, variables, safe live verification, logs, and backups.
---

<!-- xgg-skill-content-build: sha256-60cb0ad58fa6233a515577fa540f072510c7c514f3f14cce6a504a4643c50beb -->

# xgg 中枢网关自动化编译器

## 目标

把用户自然语言编译成小米中枢网关极客版的**有向规则图**，而不是仅拼出一串返回 `ok` 的命令。完成意味着：

1. event、state、时间、内部状态、reset/stop 与副作用被正确拆开；
2. 选中准确卡片、pin 与参数，设备枚举来自目标 spec；
3. 写入保持安全、可回滚，并通过 schema、spec、拓扑和 truth-aware reachability；
4. 若用户授权运行，用日志、trace、变量 readback 或设备结果证明行为。

规则 JSON 不是 LLM 通识。不要凭字段名、米家普通自动化经验或 `GUIDE.md` 旧示例猜 wire。

## 证据边界

始终区分三层：

- **固定 Xiaomi Bundle：** 证明网页卡片、canonical wire、pin 类型、save validator 和日志 projector；它不包含固件 executor。
- **当前 xgg：** 证明 CLI flags、typed synthesis、schema、静态 lint/reachability、export/import 与测试契约。
- **目标网关：** 证明具体设备 spec、push、固件运行时序、状态持久性、动作成败与日志保留。

Bundle 中没有 executor 的行为，必须写成“卡片意图/待实机验证”，不能冒充真实运行结论。尤其是 counter 的精确阈值 tick、loop 首 tick、delay 并发、statusLast reset、eventSequence 并发、register/modeSwitch 生命周期及 action output 成功时序。

## 必读路由

第一次在一个会话中设计或改写规则，先读：

- [references/graph-model.md](references/graph-model.md)：自然语言→E/S 图、wire、truth-aware reachability、控制卡与运行探针。
- [references/node-catalog.md](references/node-catalog.md)：25 种执行卡+nop 的完整 pin、per-type flags/defaults、canonical JSON 和 GUIDE 旧例禁区。

按任务再读：

- 有任意设备 property/event/action：读 [references/device-semantics.md](references/device-semantics.md)。
- 有 sequence/condition/hold/counter/limit/register/loop/modeSwitch/dynamic action：读 [references/recipes.md](references/recipes.md)。
- 要登录、实机写入、变量/表达式、日志/trace、备份或恢复：读 [references/operations.md](references/operations.md)。

这些 reference 都直接从本入口链接；不要只读 SKILL 摘要后猜细节。

## 自然语言编译流程

### 1. 先复述可判定需求

在写命令前列出：

```text
触发 event：谁在何时发出一次事件？
持续 state：触发瞬间哪些条件必须为真/假？
主动 query：是否要在 event 到来后读取设备/变量再分支？
时间关系：延迟、保持、有序窗口、循环、次数、轮换是哪一种？
内部状态：是否需要 latch/counter/持久变量？何时 reset/stop/初始化？
副作用：哪些设备写/action/变量写必须被 event 路径驱动？
运行状态：保持 disabled，还是获授权 enable 并实测？
```

若 reset、跨午夜、掉电/重启后的状态、动作失败后的后续链等会改变业务结果，而用户没说明，指出歧义；可以先构造 disabled 草案，但不能擅自选高风险运行语义。

图中含设备卡时，`--spec-aware` 是常规业务规则启用前和重放后的硬验收项。普通 validate 不读取当前 MIoT spec/live 设备，无法证明 notify/read/write access、pushAvailable、原生类型/值域、action 索引，或 output ref 是否落入 boolean/value-list literal-only 路径。常规规则的 errors 必须为零；warning 必须逐条审计、解释并明确接受。唯一允许 spec-aware error 的情况，是下述获明确授权的隔离 no-push 运行探针；它仍必须执行 spec-aware 并记录该预期诊断。

### 2. 画 node/pin 计划

```text
需求事实 | E/S | node.type/mode | source pin | consumer:input pin | 参数证据 | reset/stop
```

核心选择：

| 需求 | 选择 |
|---|---|
| 物理/设备事件 | `deviceInput` event |
| 持续属性状态 | `deviceInput` property；设备不 push 时优先改成 event→`deviceGet` |
| 触发时主动查询并真假分支 | `deviceGet` / `varGet`; `output`=满足，`output2`=不满足 |
| 触发时按状态分支 | `condition`: event→trigger，state→condition |
| 合并 events / states | `signalOr` / `logicOr|logicAnd`; 反相 `logicNot` |
| 延迟 / 保持 / 有序两事件 / 循环 | `delay` / `statusLast` / `eventSequence` / `loop` |
| 前 N 次 / 累计阈值 / latch / 轮换 | `onlyNTimes` / `counter` / `register` / `modeSwitch` |
| 捕获设备值 | push/event→`deviceInputSetVar`; triggered query→`deviceGetSetVar` |
| 持久计算或文案 | `varSetNumber` / `varSetString` |
| 定时事件 / 时间窗状态 | `alarmClock` / `timeRange` |

不要把 `timeRange` 当 `alarmClock`，不要把 `counter` 当 `onlyNTimes`，不要把 state 直接接 event input，也不要把多条线堆到同一 input。

### 3. 查当前事实，不猜参数

```bash
xgg status
xgg device list --pretty
xgg device spec <did> --pretty
xgg rule list --pretty
xgg rule view <rid> --pretty
xgg rule node add --help
```

默认 machine spec 在 `.spec.services`。记录 short-name、SIID/PIID/EIID/AIID、format/access、value-list/range、event arguments、action.in/out。中文 label 用于解释，wire 仍用 spec value。

任何设备卡都先 spec；同 short-name 跨 service 用 `--device-siid`。property source/capture 要 notify，query 要 read，property output 要 write；两类 push source 还要目标设备 `pushAvailable=true`。value-list 是闭集，range 是 `[min,max,step]`。action `--params` 必须精确覆盖 `action.in` 对应 short-name，并保持 native JSON type。

网关变量实际类型只有 `number|string`。在线图写、validate、strict export 会按每个**可发现的 modeled** 引用路径核对实际类型；opaque/future `--cfg` 内引用无法由这些门证明，边界见下文。`varSetString` target 必须 string，但 operand 可拼 number|string。boolean capture 用 number + canonical dtype number（0/1）。boolean 或任何带 `value-list` 字段（含 `[]`）的 device output 是 literal-only；动态 boolean 先按 number 0/1 分支，再写 literal false/true。

新 typed 节点省略 `--id` 时生成 `n` + 32 位十六进制；显式 ID 只能是非空 ASCII 字母数字 `[A-Za-z0-9]+`，不能含 `- _ . :`、空白或 Unicode。旧图 ID 必须保真：只有从既有 export 重放 modeled typed 节点时才使用 `--allow-legacy-id`；它不适用于新建、raw `--cfg`、opaque type 或本来已 canonical 的 ID。CLI 无法证明非 canonical ID 的 provenance，所以“只重放、不新建”也是 Agent 必须遵守的安全契约。

### 4. 先 disabled 编写

```bash
xgg rule new --name "<规则名>"
xgg rule node add --rule-id <rid> --type <type> --id <stable-id> ...
xgg rule edge add --rule-id <rid> --from <source:pin> --to <target:pin>
xgg rule layout <rid>
```

每张卡只使用 node catalog 该 type/mode 允许的 authoring flags。一个命令中任何业务 flag 被忽略都不可接受；CLI 应在 session/RPC 前拒绝无关或互斥 flag。

node/edge/layout/set 写入默认保留 live `enable`；已启用规则的多步编辑可能立即生效，不能把末尾 enable 当生效边界。先 readback；需要隔离时按授权先 disable，或离线构造后单次原子 set。默认图写路径会在线检查可发现的 modeled 变量引用是否存在及其实际类型；opaque/future payload 不在该证明内。`--no-var-check` 只供明确 raw probe/修复，不关闭 scope/schema/spec/enable gates。

`--allow-no-push` 只允许本次 typed `deviceInput` / `deviceInputSetVar` property/event 做目标网关运行探针；不持久化、不绕过 notify/read/write，也不证明设备会发出。在线 spec-aware 会保留路径化 no-push error，strict lint 也会保留同一 source 的 no-push warning/exit 1，因此该图不能冒充通过常规 error gate。只有用户明确授权验证固件扩展时，才可在无物理副作用的专用临时规则中，把 spec-aware 的这一条 error 作为唯一允许的 error，并显式接受 strict lint 的同源 warning：其他 errors 为零，其他 warnings 仍须逐项审计，enable 后立即取 logs/readback，随后 disable/delete。strict export 仍拒绝 no-push，permissive export 才会 warning 并补回 transient flag；此例外不能作为生产规则验收。

优先 typed shortcut。只有以下场景使用 raw：

- 未建模未来卡片的完整保真；
- shortcut 无法保留的扩展字段；
- 需要一次原子写入整图。

raw 必须来自默认 JSON `rule view`/export，不能来自 pretty 或 GUIDE 片段。完整节点是 `{id,type,cfg,inputs,outputs,props}`；JSON wire 只存 source `outputs`，endpoint 用 `node.pin`。

CLI 的普通 edge endpoint 是 `node:pin`。若旧 node ID 自身含 `:`，必须改用四个无损参数 `--from-node-id/--from-pin/--to-node-id/--to-pin`；当前 export/import 会自动采用这种结构化重放，不能靠第一个冒号猜边界。

导出/重放必须先落盘审阅。npm 尚未同步时先构建当前 checkout，并用 `XGG_NODE_ENTRY=<绝对 dist/cli.js>`（可配独立 `NODE_BIN`）让生成脚本以 Bash argv array 执行源码，不能把多词命令塞进 `XGG`。replay 先只读断言全部可发现的 modeled `global` 依赖存在且类型为 `number|string`，再预检已捕获的本地变量，之后才允许首笔变量/规则写入；global 从不创建、改值或改名。旧 JSON 若含未声明或无 `expectedType` 的可发现 global 引用会在渲染前 fail closed。opaque `--cfg` 不会被解析，其内部 local/global 引用既不在 preflight 证明内也不能安全改写；same-ID 保真重放须独立审阅并另行证明，clone 会拒绝。预检不是跨命令事务，执行期间仍须隔离其他 writer。完整命令与 clone/same-ID 顺序见 [operations.md](references/operations.md)。

### 5. 每批修改后过四道门

```bash
xgg rule layout <rid>
xgg rule validate --rule-id <rid> --spec-aware
xgg rule lint --rule-id <rid> --strict
xgg rule view <rid>
```

- validate：节点/schema、合法 scope、在线变量存在/实际类型；`--spec-aware` 再核 access、push、原生 literal/值域、action input 与 output-ref canonical 边界。
- lint：edge、pin color、fan-in、required input、保存键；strict 再查 sink reachability。
- enable：最终硬拦不可达 sink，并对 persisted output ref 聚焦 fail-closed spec 证明，但不替代完整 spec-aware；成功也不证明运行。
- readback：证明实际保存的节点、wire 与 enable 状态。

`rule lint` 顶层 `ok:true` 只表示命令执行完成。必须检查退出码及 `summary.errors/warnings`；exit 1=warning，2=error。含设备卡的规则绝不省略 `--spec-aware`。

### 6. 只按授权启用并证明

用户要求 disabled 草案：确认 `enable=false` 后停止。用户授权运行：

```bash
xgg rule enable <rid>
# 执行安全、可控触发；物理 source 请用户触发或等待真实条件
xgg rule logs <rid> --tail 50 --json
xgg rule trace <rid> --pretty
```

证明链：source/node 日志 → edge 日志 → 分支值 → action success/failed → variable/device readback。空日志不证明未触发；trace 必须检查 `completeness`，不是只看 frames。

复杂运行时至少验证正例和会改变结论的负例，例如 sequence 正序/逆序/超时、condition 真/假、onlyNTimes N+1/reset、loop stop、modeSwitch 多次轮换。

## 规则图不可违反的约束

1. `E→E`、`S→S`；只有 source `B` 可接 E 或 S。
2. 同一 target input 最多一条边；多事件先 `signalOr`，多状态先 `logicOr/logicAnd`。
3. 每个动作/写变量节点必须有可满足的 upstream event path；辅助 pin `stop/zero/setFalse` 不是主触发。
4. `condition.trigger` 必须 event 可达；condition 是 state。未接 state 时 XGG static model 只允许 unmet。
5. `eventSequence` 两个输入都必须可达；`logicAnd` 每个声明 input 都必须有 state。
6. `statusLast` 需要可能为 true 的 state；反相需求用 `logicNot`。
7. `onlyNTimes` 与 `counter` 的 `zero` 是可选控制 pin；只有业务需要开启新计数窗口/允许清零时才接。按日重置用 alarmClock→zero；生命周期累计或一次性前 N 次门可以省略 zero。
8. `loop` 必须有 start；有界或可取消业务要设计 stop。若明确要永久轮询，可省略 stop，并说明终止依赖 disable/delete、使用正 interval、评估事件风暴风险。此前目标网关已验证 `output→同节点 stop` 的有限反馈，其他反馈与固件仍要实测。
9. `modeSwitch` outputs 从 0 连续，动态逻辑/事件输入至少 2。
10. device/action/set/query output 可以继续串接，但 Bundle 不证明它只在成功后发；关键链路读日志。

## 实机安全

登录、snapshot、退出码、并发编辑与备份细节以 [operations.md](references/operations.md) 为准。最小底线：

```bash
export XGG_AGENT_MODE=1
export XGG_SNAPSHOTS_DIR="$PWD/snapshots"
```

- 出现 auth required/expired 或 exit 3，停止写入并索取新的一次性码；码永不落入仓库、Issue/PR 或报告。
- 已启用规则的 node/edge/layout/set 修改可能立即生效。写前读 enable；需要隔离时按授权先 disable，或离线构造后单次 set。
- mutation lease 只串行 xgg，不是网页 CAS；写期间停止网页编辑。
- 不用 `--no-snapshot/--no-validate/--no-var-check` 绕过正常失败。
- CLI 写后网页可能缓存旧图/变量：先 CLI readback，再请用户 F5。
- restore/delete/config-set 与真实设备动作不是能力探针；只在用户明确授权和可回滚条件下执行。

## 诊断顺序

自动化“不工作”时：

```text
1. rule view：节点、pins、enable 是否是预期
2. device spec / variable readback：参数和值域是否漂移
3. validate --spec-aware：卡片、变量、access/push、action.in/output ref
4. lint --strict：拓扑、颜色、required、truth-aware reachability
5. logs/trace completeness：source 是否出现、哪条 edge/branch 停止
6. 可控重放：仅在完整下游已审查且获授权
7. 最小目标化修复，再重复 1-6
```

不要因为“没有日志”就重写图；也不要因网页显示变量丢失先重建变量。先 `variable get-value`、`rule view`、F5，再判断。

## 完成标准

交付至少包含：

- 自然语言→node/pin 计划及关键语义选择；
- device spec/变量证据与所有枚举 label→wire value 映射；
- 最终 `rule view`、validate/lint exit + summary、enable 状态；
- 若获授权运行，正/负触发的 logs/trace/readback 与 evidence limits；
- reset/stop、内部状态生命周期、action failure 的未证实项；
- snapshot/backup 和临时规则/变量清理状态；
- 网页 F5 提醒。

content build marker 是除 marker 行及其换行外本文件 UTF-8 bytes 的 SHA-256，用于识别 npm 版本号相同但内容过期的副本。仓库、package mirror、实际安装 Skill 仍必须递归字节一致。
