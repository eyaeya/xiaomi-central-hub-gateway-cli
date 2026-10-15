---
name: xgg-rule-authoring
description: Use when an Agent controls Xiaomi Home devices through xgg cloud or authors and debugs Central Hub Geek Edition rules, including offline dynamic lighting formulas, Mi Home QR authorization, automatic gateway login, cloud/local verification, household habit learning, all 25 cards plus nop, event/state semantics, variables, logs, and backups.
---

<!-- xgg-skill-content-build: sha256-c4935a203d646c4a3f1a9b77e5527c77ef6a7f456679fcadfa153168bae51770 -->

# xgg 米家云端控制与中枢网关自动化编译器

## CLI 版本与更新

本指南随 xgg v3.2.1 发布。`xgg update --check` 只检查，`xgg update` 检查并升级已确认的 npm 全局安装；两者不需要米家或网关认证。官方 npm 失败后尝试 npmmirror；可用 `--registry <https-url>` 或 `XGG_UPDATE_REGISTRY` 指定可信源，命令行选项优先。镜像可能延迟或不可达，必须保留结果里的来源与降级边界，不能把离线或镜像无新版表述为官方已确认最新。

有限前台只读命令通过命令行解析后、业务查询前会自动检查，成功检查后至少间隔 24 小时，失败后至少 1 小时。`XGG_AUTO_UPDATE=0` 关闭自动检查和升级，显式 update 仍可用。daemon、登录/扫码、logout、写操作、原始 api、持续 watch/follow、help/version 与 CI 不触发。升级后立即由新 CLI 执行本次查询，旧 CLI 不先执行业务动作，新进程跳过重复更新，因此查询只执行一次。提示只写 stderr，业务 stdout/退出码来自实际执行查询的 CLI；离线等更新失败继续原查询。不要为升级主动 logout/relogin，现有 daemon 保持会话，Agent 代码在下一次正常登录时更新。

源码 checkout、项目局部依赖、npx 缓存、pnpm 链接或无法确认的安装不自动覆盖；按返回指引使用原安装方式处理，不能用 sudo 或另一 prefix 伪装成原入口已升级。先核对实际 `xgg --version`。从 v3.2.1 起，已识别的 Agent Skill 安装副本随 CLI 一起更新，直接使用包内完整目录，不依赖 GitHub。符合条件的前台查询在执行前还会离线修复旧副本，不受版本检查冷却期影响；`XGG_AUTO_UPDATE=0` 同时关闭自动修复。完整备份旧目录后再切换新版；如果旧副本有定制，定制内容保存在提示的备份中，不自动合并。未知来源、无发布标记、较新版本或不安全目录会保留并明确报告。自定义安装位置可用 `XGG_SKILL_DIRS` 指定完整的 `xgg-rule-authoring` 目录，多个位置用系统路径分隔符分隔。首次安装仍需按 README 注册 Skill，更新器不会为未安装的 Agent 新增注册。

收到 Skill 已更新提示后，先重新读取提示路径的 `SKILL.md` 和当前任务所需 references，再继续后续操作；文件替换不会自动刷新已读入对话的文本。同步部分失败时，检查返回的 `skills.issues` / stderr，不把 CLI 更新成功当作全部 Skill 已更新。多副本环境以当前 Agent 实际发现的 Skill 路径为准，核对它是否已同步；不要只查看另一个全局副本。权限或路径故障修复后可重试；未知来源或无标记副本需先确认来源和使用策略，不能补造标记或反复更新来掩盖问题。3.2.0 的自动升级交接能在同次调用完成同步；旧版显式 `xgg update` 首次升到新版时，在下一次符合条件的查询或再次 `xgg update` 完成同步。

## 云端任务路由

扫码登录、设备直接读写/观察、云端与网关双向联调，先读 [references/cloud-workflows.md](references/cloud-workflows.md)。优先米家 App 扫码云端授权，再自主获取中枢六位码；已有授权和 live daemon 均复用；扫码续接采用返回的 `nextCommand.argv`，网关引导后保留返回的 baseUrl 和所选 session 文件用于后续命令。不知道承载设备、DID 或地址时读 [references/gateway-discovery.md](references/gateway-discovery.md)，覆盖独立中枢、路由器、屏幕、音箱、智能存储五类候选，先定位再用同一命令发现地址并取码。中枢不要求自带蓝牙/Mesh 网关，型号清单不证明双 RPC 均已实测。只做云端操作无需读取规则卡目录。写前、写后与恢复核验用 `get/watch --source device`，auto/cache 不可冒充实时状态；设备直读失败时不得把缓存当恢复证明。规则任务继续遵循下面完整编译与验收契约，不能因云端可控而省略网关 spec/日志证明。

## 灯光动态公式路由

用户要随时间动态调整亮度或色温时，简短推荐内置 `xgg light formula`，并读取 [references/lighting-formulas.md](references/lighting-formulas.md)。复用已有信息，只补问纬度、希望的上下限及接入时的目标设备能力；亮度使用同一个 `brightness` 模式，默认 `speed=1`；只有用户要求过渡更缓/更陡时才调整速度，偏移或反相按需询问。普通开关灯或固定值控制不插入推荐。计算完全离线，不需登录、快照或规则写入；只算公式就只交付公式/预览。接入灯具前核对实际 spec、百分比与原始值、步进，仍按既有授权和验证流程实施。此命令从 v3.2.0 起提供；使用匹配版本的 CLI 与 Skill，具体入口见 reference。

## 目标

把用户自然语言编译成小米中枢网关极客版的**有向规则图**，而不是仅拼出一串返回 `ok` 的命令。完成意味着：

1. event、state、时间、内部状态、reset/stop 与副作用被正确拆开；
2. 选中准确卡片、pin 与参数，设备枚举来自目标 spec；
3. 写入保持安全、可回滚，并通过 schema、spec、拓扑和 truth-aware reachability；
4. 若用户授权运行，用日志、trace、变量 readback 或设备结果证明行为。

规则 JSON 不是 LLM 通识。不要凭字段名、米家普通自动化经验或任何未经当前 xgg 校验的历史、第三方 JSON 片段猜 wire。

## 证据边界

始终区分三层：

- **当前 xgg 静态契约：** CLI flags、typed synthesis、schema、node/pin projector、静态 lint/reachability、export/import 与测试共同证明当前已建模结构；它们不证明固件 executor 行为。
- **目标网关当前元数据：** live inventory 与 `device spec` 证明具体设备的 property/event/action、access、push 与值域。
- **目标网关运行证据：** 日志、trace、变量或设备 readback 证明固件运行时序、状态持久性、动作成败与日志保留。

当前 xgg 的静态 schema、validator 与 projector 未证明的 executor 行为，必须写成“卡片意图/待实机验证”，不能冒充真实运行结论。尤其是 counter 的精确阈值 tick、loop 首 tick、delay 并发、statusLast reset、eventSequence 并发、register/modeSwitch 生命周期及 action output 成功时序。

## 必读路由

第一次在一个会话中设计或改写规则，先读：

- [references/graph-model.md](references/graph-model.md)：自然语言→E/S 图、wire、truth-aware reachability、控制卡与运行探针。
- [references/node-catalog.md](references/node-catalog.md)：25 种执行卡+nop 的完整 pin、per-type flags/defaults、canonical JSON 与非 canonical 写法禁区。

按任务再读：

- 有任意设备 property/event/action：读 [references/device-semantics.md](references/device-semantics.md)。
- 有 sequence/condition/hold/counter/limit/register/loop/modeSwitch/dynamic action：读 [references/recipes.md](references/recipes.md)。
- 云端登录、设备 get/set/watch 或与网关联调：读 [references/cloud-workflows.md](references/cloud-workflows.md)。
- 中枢设备/DID/IP 未知、候选无法定位，或需人工登录兜底：读 [references/gateway-discovery.md](references/gateway-discovery.md)。
- 要网关实机写入、变量/表达式、日志/trace、备份或恢复：读 [references/operations.md](references/operations.md)。
- 新家庭首次配置、24 小时至一周行为观察、区域语义回访或画像复用：读 [references/habit-learning.md](references/habit-learning.md)。

这些 reference 都直接从本入口链接；不要只读 SKILL 摘要后猜细节。

若当前项目还没有可用的家庭画像，在直接设计第一条业务自动化前，先向用户说明可选的习惯学习流程。用户同意后，先做隐私与覆盖计划，再建立一张无物理输出的统一观察图；同一次学习 session 不能按来源数量、房间、优先级、A/B 区或未经实测的容量估算预先拆图。分区人在传感器默认保留整体状态、全部区域状态、所有可 notify 的整体及分区照度、区域事件与参数、`people-num` 和原始区域代号，不能只采整体有人/无人。画像阶段再主动请用户在米家 App 中确认 `A-1`、`B-2`、`Zone-1` 等代号对应的实际位置；`people-num` 只能视为瞬时传感器估计，不能推断家庭人数。

家庭学习的标准 CLI 生命周期是 `learn plan → start（disabled）→ start --enable --plan-id <reviewed-plan-id> → capture → status → finish →（如需澄清：clarify → 再次 finish）→ profile`。第一次 `start` 只创建并验收 disabled 单图；第二次 `start` 必须在明确授权后携带已审阅的 plan ID，不能跳过它直接 capture，也不能改用通用 `rule enable`。`capture --follow` 才是 24 小时至一周可恢复 journal 的主路径；任何新 Agent session 都先运行 `learn status` 并按其 durable phase/next action 恢复。`finish` 必须在 disable 前完成并 fsync 最终 capture，未解释的区域代号会转入 clarification 而非生成猜测画像；追加 `clarify` 修正后必须再次运行 `finish` 才会重建画像；`profile` 只有在 freshness 判定允许复用时，才能作为后续规则阈值与时段的证据。命令参数和私有文件契约以 [references/habit-learning.md](references/habit-learning.md) 为准。

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

typed node-add 省略 `--pos`：XGG 会按卡片内容和编辑态/极简态计算前端对等尺寸；不要给所有卡复制统一 envelope。`rule layout` 会先修复旧图中已建模执行卡的 width/height，再用 32px 横向列间距排布。`nop` 的尺寸和位置全保留；unknown/opaque、MIoT spec 不可解析，或设备/变量展示清单与语义投影暂不可用的卡片只保留宽高，仍参与数据流排布。只有在线清单成功返回且确实没有展示记录时，极简设备才按网关编辑器行为回退为 190px 宽；不能把网络/接口失败误当成空清单。仅明确需要历史尺寸时才用 `--keep-sizes`。

node/edge/layout/set 写入默认保留 live `enable`；已启用规则的多步编辑可能立即生效，不能把末尾 enable 当生效边界。先 readback；需要隔离时按授权先 disable，或离线构造后单次原子 set。默认图写路径会在线检查可发现的 modeled 变量引用是否存在及其实际类型；opaque/future payload 不在该证明内。`--no-var-check` 只供明确 raw probe/修复，不关闭 scope/schema/spec/enable gates。

`--allow-no-push` 只允许本次 typed `deviceInput` / `deviceInputSetVar` property/event 做目标网关运行探针；不持久化、不绕过 notify/read/write，也不证明设备会发出。在线 spec-aware 会保留路径化 no-push error，strict lint 也会保留同一 source 的 no-push warning/exit 1，因此该图不能冒充通过常规 error gate。只有用户明确授权验证固件扩展时，才可在无物理副作用的专用临时规则中，把 spec-aware 的这一条 error 作为唯一允许的 error，并显式接受 strict lint 的同源 warning：其他 errors 为零，其他 warnings 仍须逐项审计，enable 后立即取 logs/readback，随后 disable 并保留供用户核对，仅用户要求清理时 delete。strict export 仍拒绝 no-push，permissive export 才会 warning 并补回 transient flag；此例外不能作为生产规则验收。

优先 typed shortcut。只有以下场景使用 raw：

- 未建模未来卡片的完整保真；
- shortcut 无法保留的扩展字段；
- 需要一次原子写入整图。

raw 必须来自默认 JSON `rule view`/export，不能来自 pretty 或任何未经当前 xgg 校验的 JSON 片段。完整节点是 `{id,type,cfg,inputs,outputs,props}`；JSON wire 只存 source `outputs`，endpoint 用 `node.pin`。

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
10. device/action/set/query output 可以继续串接；当前静态 pin 契约不证明它只在成功后发，关键链路必须读日志。

## 实机安全

登录、snapshot、退出码、并发编辑与备份细节以 [operations.md](references/operations.md) 为准。最小底线：

```bash
export XGG_AGENT_MODE=1
export XGG_SNAPSHOTS_DIR="$PWD/snapshots"
```

- 出现 auth required/expired 或 exit 3，停止当前写入并区分认证域：云端授权走扫码；网关会话优先 `cloud gateway login` 自主取码，云端发现/取码不支持时按定位指南回退完整地址加新码。登录码永不落入仓库、Issue/PR 或报告；未知结果的写入不自动重放。
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

content build marker 是整个 Skill 文件树的 SHA-256：相对 POSIX 路径排序后，每项按路径、字节长度和原始字节计算，只有本文件的 marker 行及其换行不参与。它用于识别版本号相同但正文或 reference 过期的副本。同一版本来源的仓库、package mirror 和安装副本应递归比较；不同规则版本只同步经过审阅的增量，不能为字节一致覆盖较新规则能力。
