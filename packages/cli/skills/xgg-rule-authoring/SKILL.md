---
name: xgg-rule-authoring
description: Use when an LLM Agent needs to operate a Xiaomi Gateway Geek Edition (中枢网关极客版) through the xgg CLI — login, device discovery/partitions/replacement, authoring/validating/enabling automation rule graphs, the 25 executable cards plus the nop canvas note, variables, expressions, snapshots, logs, and cloud/local backups.
---

<!-- xgg-skill-content-build: sha256-f818f33e6f81856546397d079c706af0005e29a5f21c0bbd14cac191f48b7846 -->

# xgg 自动化编写 Skill

## 目标

用 `xgg` CLI 把用户的自然语言需求变成小米中枢网关极客版的自动化。网关里的每个自动化是一张**有向图**：节点是卡片，边是「某节点的输出 pin → 另一节点的输入 pin」。Agent 的任务不是「把命令跑到返回 ok」，而是「按需求选对卡片、查清参数、连对 pin、静态校验、启用，并用日志或变量读数证明它真的运行」。

把 `xgg --help` / 子命令 `--help` 作为参数名的当前事实来源，把目标网关的 spec、日志与 readback 作为设备行为的最终事实来源。本 Skill 的证据分三层：

1. **离线确定性检查：** bundle 对照、CLI schema、unit/integration test、`rule validate --body/--stdin`，证明命令形状、序列化与静态约束。
2. **安全实机探针：** 已验证未接状态的 `condition` 走 `unmet`、同节点 `loop.output → loop.stop` 有限反馈，以及 `timeRange` 在窗口进入时发出事件并提供独立状态；探针只使用临时规则/变量，不驱动物理设备。
3. **目标网关验收：** property/event/action、物理触发、分区型号、设备替换和备份恢复依赖具体设备与固件，必须按 `spec → validate --spec-aware → lint → trigger/log/readback` 重新验证。不要把离线测试或单一网关探针表述成“全部实机验证”。

正文 build 标记内嵌除该标记行及其换行外完整 `SKILL.md` UTF-8 字节的 SHA-256，测试会校验正文与摘要绑定；它可用于识别 npm 版本号相同但内容过期的安装副本：`grep '^<!-- xgg-skill-content-build:' <SKILL.md>`。仓库与 npm 包内镜像还应做字节级对比，`references/` 则必须依赖完整目录递归比较。

## 使用场景（Agent 可承担的任务）

本 Skill 让你（Agent）独立承担下面三类任务，覆盖自动化的完整生命周期。三类与 README 的三类场景一一呼应，但写成给你的操作指引——每类点出关键命令与验收标准。获授权运行的规则要用日志或变量读数证明行为，命令返回 ok 不算完成；刻意保持禁用时则用 validate、strict lint 与 `rule view` 的 `enable=false` 完成静态验收。

### 1. 设计并创建自动化

把用户的自然语言需求变成一张可用的规则图。固定路径：

```bash
xgg rule new --name "<规则名>"            # 拿到 rule-id
xgg rule node add --rule-id <rule-id> ... # 每张卡片一条；设备卡先 device spec 查参数
xgg rule edge add --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule layout <rule-id>                  # 连完线跑一次；执行卡按数据流布局，保留 nop 位置
xgg rule validate --rule-id <rule-id> --spec-aware # 设备 spec + action input 契约
xgg rule lint --rule-id <rule-id> --strict # 拓扑、必需输入、可达性与保存键
```

图中含 `deviceOutput` action 时，`--spec-aware` 是启用前和重放后的硬验收项；普通 `rule validate` 不读取当前 MIoT action spec，无法发现索引、short-name 或数值域漂移。

只有用户授权运行时才继续 `xgg rule enable <rule-id>`；授权运行后，若 `xgg rule logs <rule-id> --tail 20` 观察到对应项，可作为运行的正向证据。未获运行授权时，则用 `rule view` 确认保持 `enable=false`。设备相关卡片务必先 `xgg device spec <did>` 查清属性 / 事件 / 动作名，不猜字段。`onLoad` 是目前已有证据、可立即 `disable → enable` 重放的独立入口；`timeRange` 也已实测为独立窗口进入事件源，但要等待 start。`varChange` 在模型中是独立源，外部 `variable set-value` 是否按预期触发仍要在目标网关看日志验证；`loop` 必须由上游事件接入 `start`。物理按钮/传感器请用户实际触发后再看日志。

### 2. 读日志诊断并修复既有自动化

用户说某条自动化「不工作」时，先读它的真实运行日志定位，再改图修复，不要凭猜重写：

```bash
xgg rule logs <rule-id> --tail 50          # 观察已记录的触发 / 分支 / 动作结果
xgg rule view <rule-id> --pretty           # 对照规则图看是哪一段
# 改图：node add/update/remove、edge add/remove；复杂原子修改再用 rule set
xgg rule validate --rule-id <rule-id> --spec-aware # 改完核对设备/action 契约
xgg rule lint --rule-id <rule-id> --strict # 拓扑、必需输入、可达性与保存键
# 修复前已启用或用户要求启用时才运行 rule enable；刻意禁用的规则保持禁用
xgg rule logs <rule-id> --tail 20          # 复看日志确认修复
```

日志读法见「调试与验收」：`link <src>.<pin> → <dst>.<pin> = <事件>` 是边触发，`<node> [value]` 是取值 / 分支，`<node> success` / `<node> failed` 是动作结果。观察到这些项可作为对应触发、分支或动作的正向证据；未观察到则不能单独证明「没触发」，即使扩大窗口或去掉过滤，仍需结合规则图 readback、可控触发或其他证据。走了 `unmet` 分支则表示条件按 false 求值。

node/edge/layout/set 写入默认保留 live `enable`，所以已启用规则的多步修改可能立即生效，不能把最后的 `rule enable` 当成生效边界。先用 `rule view` 记录状态；会改变执行路径时，在授权下先 disable 并 readback，或离线构造/校验后用单次原子 `rule set`。验证后只按原状态和用户意图恢复。

优先做目标化变更，避免调用者手工构造整图 JSON：

```bash
xgg rule node update --rule-id <rid> --node-id <nid> --patch '{"cfg":{"name":"新名称"}}'
xgg rule edge remove --rule-id <rid> --from <node:pin> --to <node:pin>
xgg rule node remove --rule-id <rid> --node-id <nid> --cascade-edges
xgg rule rename <rid> --name "新规则名"
xgg rule set-tags <rid> --tags "照明,夜间"       # --tags "" 清空
xgg rule delete <rid>
```

`node update` 只对顶层与 `cfg` 做 merge；patch `props` / `inputs` / `outputs` 时要给完整替换对象，且不能改 `id` / `type`。`node remove` 不加 `--cascade-edges` 时会故意留下指向已删节点的 dangling incoming edges，常规删除应加该 flag；只有修复异常图时才考虑不加。目标化命令内部仍是 `getGraph → 整图 setGraph`；mutation lease 只串行 xgg 客户端，不是网页 CAS，执行期间不要同时编辑网页画布。每个写命令仍受 Agent snapshot/mutation guard 约束。

`rename` 只改 name 并保留 enable/uiType/tags/其他 userData；`set-tags` 是替换整组标签，不是追加；`delete` 默认先 snapshot，成功后也删除整个 `R<rid>` 本地变量 scope。删除不存在的规则默认报 `NOT_FOUND`，明确需要幂等清理时才加 `--allow-missing`。

### 3. 盘点现有设备与自动化，与用户头脑风暴新方案

帮用户在真实清单上做规划，而不是空想。先用只读命令建立全貌：

```bash
xgg device list --pretty                    # 家里有哪些可用设备（默认排除 ghost）
xgg device get <did> --pretty               # 从设备清单精确读取一个 DID 的元数据
xgg rule list --pretty                      # 已经配了哪些自动化
xgg rule view <rule-id> --pretty            # 逐条看现有自动化做了什么
xgg device spec <did> --pretty              # 某设备具体能力
```

据此判断哪些设备还没被任何规则用上、现有自动化是否有覆盖空白或互相冲突，再向用户提出更有价值的点子并说明依据。方案聊定后，直接走第 1 类的标准流程把它落地——盘点与创建在同一会话内衔接，不必让用户在设备列表和画布之间来回抄标识。

> 收尾时提醒用户：CLI 的改动需要在网关网页 **F5 刷新**才能看到（见「避坑：网页端变量缓存」）。

## 一、必须遵守的 CLI 操作规范

1. **会话失效就停手要码。** 出现 `AUTH_REQUIRED` / `AUTH_EXPIRED`，或写命令退出码 `3` 时，立即停止当前写操作，向用户索取一个新的 6 位登录码，再执行（登录码由用户在米家 App 的中枢网关设备页面获取；若中枢网关是路由器或家庭屏自带的，则在对应设备内的中枢网关功能页面获取。登录码短时有效，通常只能用一次）：

   ```bash
   xgg login --code <6位登录码> --base-url http://<gateway-ip>:8086
   ```

   登录会绑定一个常驻 agent 守护进程（约 60 分钟空闲后自毁并清空会话）。`xgg status` 看 `live` 与 `idleMsRemaining`。

2. **Agent 写操作启用快照目录。** 这样每次写前都会把网关全量状态落盘，便于回溯。**把快照目录建在当前工作目录下的子文件夹里**（如下面的 `$PWD/snapshots`），不要写到 `/tmp` 或全局家目录——快照随项目留存，用户随时可查、便于回溯：

   ```bash
   export XGG_AGENT_MODE=1
   export XGG_SNAPSHOTS_DIR="$PWD/snapshots"
   ```

   `XGG_AGENT_MODE=1` 时若缺 `--snapshots-dir`/`XGG_SNAPSHOTS_DIR`，写命令会以 `ConfigError`（退出码 `5`）在任何 RPC 之前失败。

3. **默认解析 JSON stdout，给人看才加 `--pretty`。** 例外：`xgg rule logs` **默认输出人类表格**，要 JSON（`{ok, count, entries:[...]}`）得显式加 `--json`。

4. **顺着提示走。** 命令返回的 `nextSteps`、或 stderr 里的 `note: ... next →`，在不违背用户需求的前提下按提示继续（用 `XGG_NO_NEXT_HINT=1` / `--no-next-hint` 可静音）。

5. **不要用 `--no-validate` / `--no-snapshot` / `--no-var-check` 绕过普通问题。** 它们只在你明确做 raw probe、且已知风险时才用。`--no-validate` 关闭默认图/卡片 validation gates（full write 上包括 topology lint 与保存键 schema 检查），但不绕过请求/envelope 解析；`--no-var-check` 关闭支持该 flag 的在线变量存在性检查；`--no-snapshot` 关闭写前快照。

6. **任何设备相关卡片都先查 spec，不猜属性/事件/动作名：**

   ```bash
   xgg device list --pretty
   xgg device spec <did> --pretty
   ```

   `device list` 默认排除 ghost device（网页标「设备已丢失」的：`online && !specV2Access && !specV3Access`）。不要把 ghost device 作为 `deviceOutput` 目标——命令会超时 `-9999`。只在排查设备清单差异时才用 `--include-ghost`。同名属性/动作/事件落在多个 service 时，按命令错误提示补 `--device-siid <N>` 消歧。

7. **CLI 写入后网页不会自动刷新。** CLI 直连网关写入，但**不会**向其他已打开的网页会话广播 `configChanged`。所以长开着网关网页的用户，看不到 CLI 新增/修改的变量、scope、规则，且引用这些变量的卡片会显示「变量已丢失」。**这是排查「CLI 写没生效」的头号误报**：先让用户 **F5 刷新网页**，再怀疑真有 bug。诊断顺序：① `xgg variable get-value` 确认网关上真有这个值 → ② `xgg rule view` 确认规则引用的 scope/id 对 → ③ 让用户刷新网页 → ④ 三项都过才往别处查。

### 退出码（写命令）

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 网关报错 / `rule lint` 有 warning |
| 2 | 写超时（未确认）/ `rule lint` 有 error |
| 3 | 认证失败/过期 → 重新 `xgg login` |
| 4 | 客户端 schema 解析失败（卡片 JSON 形状非法） |
| 5 | 配置错误（如 `XGG_AGENT_MODE` 缺快照目录、卡片/变量校验未过） |

`rule validate` / `rule lint` 这类只读命令用 `0`=干净、`1`=有 warning、`2`=有 error。**把 lint/validate 的 error（exit 2）当作启用前的硬止血点。**

### 环境变量与全局约定

| env var | 作用 |
|---|---|
| `XGG_BASE_URL` | 网关地址(等价 `--base-url`) |
| `XGG_SESSION_FILE` | 会话文件路径(默认 `~/.xgg/session.json`) |
| `XGG_AGENT_MODE=1` | 强制每次写前落快照(见规范 2) |
| `XGG_SNAPSHOTS_DIR` | 快照目录(等价 `--snapshots-dir`) |
| `XGG_LOGIN_CODE` | 登录码(等价 `login --code`) |
| `XGG_NO_NEXT_HINT=1` | 静音「next →」生命周期提示 |
| `XGG_NO_REFRESH_HINT=1` | 静音写后「F5 刷新网页」提示 |

- **优先级一律是 flag 覆盖 env**(`--base-url` > `XGG_BASE_URL`,`--session-file` > `XGG_SESSION_FILE`,`--snapshots-dir` > `XGG_SNAPSHOTS_DIR`)。没有配置文件,只认 flag + env + 会话存储。
- **默认输出 = stdout 上的紧凑单行 JSON**(`{ok:true,...}`),`--pretty` 才转人类表格;列表类命令的紧凑 JSON 才是机读权威形状。
- **命令失败时 stderr 输出单行 JSON** `{"ok":false,"error":{"code","message","hint","details"}}`,多个问题在 `error.details.issues`;两条 stderr 提示(写后「F5 刷新」+「next →」)都不污染 stdout,可放心解析 stdout。

## 二、固定工作流

```bash
xgg status
xgg device list --pretty
xgg device spec <did> --pretty

xgg rule new --name "<规则名>"                                   # 返回 rule id
xgg rule node add --rule-id <rid> --type <node-type> ...        # 每张卡片一条
xgg rule edge add --rule-id <rid> --from <node:pin> --to <node:pin>
xgg rule layout <rid>                                           # 连完线跑一次；执行卡按数据流布局，保留 nop 位置
xgg rule validate --rule-id <rid> --spec-aware                  # 设备 spec + action 输入 + 变量（一次列全部问题）
xgg rule lint --rule-id <rid> --strict                          # 边拓扑 + pin 颜色（再叠加保存键校验）
```

关键点：

- `rule new` 只创建空规则 envelope；每张卡片用 `rule node add` 加。默认 rule id 是无连字符的数字串。
- `rule node add --id <node-id>` 给节点稳定命名，后续连线更安全；不指定则随机。
- 连线用 `<node-id>:<pin>`，例如 `n-click:output` → `n-light-on:trigger`。
- `rule layout` 只改可执行卡片的网页画布坐标、不改逻辑：触发器/源在左，每个节点严格排在其所有输入右侧，分支纵向堆叠，相互独立的子自动化各占一条横带。`nop` 备注的位置表达它所说明的画布区域，因此保持不动。网页 UI 自己不做自动布局，所以这步是让 CLI 创建的规则在网页里可读的关键。
- 用户授权运行时才 `rule enable` 并在触发后读 `rule logs`；否则用 `rule view` 确认保持 `enable=false`。
- `rule enable` 返回成功只代表启用完成，**不代表触发成功**；触发后必须看 `rule logs`。

### 三层校验——分清哪条命令抓哪类问题

| 层 | 命令 | 抓什么 | 写入时是否自动跑 |
|---|---|---|---|
| 卡片配置 + 变量存在/scope | `rule validate`（dry-run，不写）；设备 action 加 `--spec-aware` | 卡片字段非法、`卡片变量丢失`、`卡片变量有误`；`--spec-aware` 还核对 action input 的逐索引 PIID、重复 short-name、原生 literal/统一数值域和变量有效 range。离线 `--body/--stdin` 不读网关变量清单，在线 `--rule-id` 才判断变量是否存在 | `rule set` / `rule enable` 默认跑本地校验；完整 action spec 契约仍以显式 `--spec-aware` 为准。node/edge/layout 默认接在线 var check；raw opt-out 只供明确探测或修复 |
| 边拓扑 + pin 颜色 | `rule lint`；`--strict` 再叠加保存键级检查 | 非法/断开的 endpoint、空边、重复边、fan-in > 1、event→state cross-color，以及缺失必需输入。普通 lint 对缺失的 `condition.trigger`、`eventSequence.input1/input2`、`logicAnd` 每个声明输入报 warning，strict 升为 error；`condition.condition` 刻意可选，未接时网关把它当 false。合法的同节点反馈只报 warning | `rule set` 跑 full lint；`rule enable` 跑 full lint + reachability；`edge add` 对新边做 pin/duplicate/fan-in/cross-color 检查。`node add/update/remove`、`edge remove`、layout 跳过 full-graph lint（schema/var 检查各自不同）；import 本身只渲染，重放脚本再走 set/node/edge 写路径。每批修改后都手动跑 strict lint |
| 按 pin + 状态真假聚合的有向可达性（never-fires sink） | `rule lint --strict`（读时报）；`rule enable` 写时硬拦 | `卡片不可达`：无法按目标卡必需输入与真假语义驱动动作卡（`deviceOutput`/`varSetNumber`/`varSetString`/`deviceGetSetVar`）。`eventSequence` 要全部事件输入；`condition.met` 要 trigger + may-true，`unmet` 要 trigger + may-false（未接状态即 false）；`statusLast` 只接受 may-true；`logicAnd`/`logicOr`/`logicNot` 传播真假；`signalOr` 任一路事件即可。`timeRange` 是独立的窗口进入事件源并同时提供状态；`loop.stop`/`onlyNTimes.zero` 不能单独向下游传播 | **仅 `rule enable` 硬拦**；`rule set` 不跑可达性（增量编写允许卡片悬空待连线），`rule validate` 也不报，要用 `rule lint --strict` 提前看到 |

启用前**两条都跑**看全量问题：`rule validate --rule-id <id> --spec-aware` 和 `rule lint --rule-id <id> --strict`。尤其是 `deviceOutput` action，省略 `--spec-aware` 就不会检查当前 `action.in`/`props.ins` 契约。`rule enable` 的内建预检是兜底，不是「看全问题」的替代（它的 `error.message` 只报第一个，`details.issues` 才有全部）。

## 三、如何获取卡片参数

> **空网关也能从零构造，不需要任何现成规则可抄。** 最稳的冷启动是用 shortcut：一条 `rule node add --type <T> <flags>` 不写 JSON 就能产出已建模卡片，缺什么参数以 `--help` 为准。选择节点、pin 或 raw JSON 结构时读取 [references/node-catalog.md](references/node-catalog.md)，组合常见图形时读取 [references/recipes.md](references/recipes.md)。有现成规则时，`xgg rule view <id>` 的整图 JSON 是保留未知/扩展字段的全量来源。

优先级从高到低：

1. **设备参数：** `xgg device spec <did> --pretty`。从 `Properties` 选 `--device-property`，`Actions` 选 `--device-action`，`Events` 选 `--device-event`。`deviceInput` 的 property/event 模式严格二选一；event 模式只用 `--event-filter*` 比较事件参数，不能混入 `--op`、`--threshold*`、`--property-*` 或 `--force-out-of-range` 这类 property 比较 flag。
2. **CLI shortcut 参数：** `xgg rule node add --help`。这是各卡片**参数名**的当前事实来源；25 种执行卡片和 `nop` 都有 shortcut，包括 `--type eventSequence --duration 5s`、`--type register`、`--type modeSwitch --outputs N`。
3. **学已有规则：** `xgg rule view <id> --pretty` 看节点 `props/inputs/outputs`；`xgg rule export <id> --format shell` 反译成可复现的 CLI 命令。
4. **没有 shortcut、要保留额外字段、或一次原子推整张图时才用 JSON。** `rule node add --cfg` 接受完整 `{cfg,inputs,outputs,props}`（推荐）或历史 cfg-only 形状；后者不能替代需要完整四段的卡片。`rule set --body <整图JSON文件>` 原子写整图。不要手拼残缺 payload；先从 `rule view` 取得现有全量 JSON，或按 [node catalog](references/node-catalog.md) 的 envelope/逐类结构构造，再用离线 `rule validate --body` 检查。设备卡 cfg 必须带 `urn`。

### 规则导出、导入与克隆

`rule export --format shell` 直接输出的脚本也必须落盘审阅；需要保存/改目标 ID 时，先导出 JSON，再用**必填的** `--from-file` 渲染：

```bash
export SNAPSHOTS_DIR="$PWD/snapshots"       # export/import 生成脚本读取这个变量
xgg rule export <source-id> --format json --strict-roundtrip > rule-export.json
xgg rule import --from-file rule-export.json > replay.sh
xgg rule import --from-file rule-export.json --target-id <target-id> \
  --target-name "克隆规则名" > clone.sh
# 审阅最终 enable 行为后再执行 bash replay.sh / bash clone.sh
```

`rule import` 自身只做离线文本转换，stdout 是 shell，不代表已写入。脚本先只读预检已捕获的本地变量；若导出包含本地变量，same-ID 重放会在 staging 前用兼容性保护准备这些变量，随后第一笔 **target-graph write** 用 `rule set --allow-cfg-overwrite` 原子写入空图和 `enable=false`（`--target-name` 同时生效）。clone 保留 `--expect-absent`，先创建禁用空壳，再准备 `R<target-id>` 变量。所有 node/edge 都在禁用状态下重建；源规则启用时只在完整组装后执行末尾 `rule enable`，禁用源保持禁用。脚本是逐命令事务，不是 replay-wide lease：执行期间禁止网页画布、其他 xgg/API writer 并发修改目标；staging 后失败会留下禁用 partial graph，用逐写快照检查或恢复。重放后总是 `validate --spec-aware → lint --strict → view/readback`；只有用户授权时才触发并读日志。

- 对当前 spec 有效的已建模节点，完整 typed `include` / `between`、`preload`、`simplified`、原生 action 参数、`nop` Delta/背景/几何与可由 DSL 无损表示的表达式可在 strict 模式往返；action literal 的原生 JSON 类型由 MIoT format 决定，只有数值 format 应用数值 value-list/range/step（bool/string 即使带 numeric value-list 也不能变成 number）。strict export 会按索引核对 `props.ins[i].piid === action.in[i]`、PIID/short-name 唯一性、literal 原生类型/统一数值域和变量 dtype/有效 range，任何语义损失 warning 都会使导出拒绝。permissive export 也必须明确警告，并避免重复 key 或 `__proto__` 静默丢值。
- `varSetNumber` / `varSetString` elements 若存在 DSL 歧义边界，任何 export 模式都会在输出前失败，不依赖 `--strict-roundtrip`；先给表达式增加显式分隔符。
- clone 只把 `R<source-id>` 改为 `R<target-id>`，预检本地变量计划后以 expect-absent 预留目标；`global` 是外部依赖，不创建、不改写。
- 未建模的未来节点导出为完整 opaque `--cfg` 结构，可同 ID 无损重放。因为 CLI 无法安全发现/改写 opaque payload 内的规则本地引用，带 opaque 节点时拒绝 `--target-id` clone。
- `--strict-roundtrip` 拒绝已建模节点的语义损失 warning；lossless opaque same-id fallback 是例外，并会给出信息性 warning。

## 四、节点、pin 与 typed operands

选择卡片、确认 pin 颜色、处理完整 include/between、审计 action 参数或手写 raw JSON 时，读取 [references/node-catalog.md](references/node-catalog.md)。该参考包含 25 种执行卡片 + nop、权威 pin 表、shortcut、wire 编码、整图 envelope 和逐类 props。

核心规则：

- event 只能接 event；event|state 输出可接两色；每个输入 pin 的 fan-in 上限为 1。
- 同节点反馈边合法且只报 warning；保留 warning 并验证终止。
- condition.condition 可不连，默认 false，只有 unmet 可达。
- timeRange 同时提供窗口状态和 start 进入事件；没有观察到等价 end 事件。
- 数值 `deviceInput` / `deviceGet` 与 number 型 `varChange` / `varGet` 使用 `--op between` 时，必须同时显式传 `--threshold <lower>` 和 `--threshold2 <upper>`；省略任一边界会在任何 session/spec/快照/写图前失败，不会静默补 `0`。显式下界 `0` 合法；非-between 标量比较仍保留历史默认 `0`。
- 已建模编辑优先用 simplified、preload、typed include/between 与原生 action 参数 shortcut；要保留 shortcut 不认识的额外字段时，从 `rule view` 做完整 JSON 往返，避免手工构造残缺 raw payload。

## 五、变量模型

网关变量是可被规则读写的持久值：

```bash
xgg variable list --pretty
xgg variable get <scope> --pretty
xgg variable get-config --scope global --id <id>
xgg variable get-value --scope global --id <id>
xgg variable create --scope global --id <id> --type number --value 0 --name "<显示名>"
xgg variable set-value --scope global --id <id> --value 1
xgg variable set-config --scope global --id <id> --name "<新显示名>"
xgg variable create --scope R<规则id> --id <id> --type number --value 0 --name "<显示名>"
xgg rule node add --rule-id <规则id> --type varChange --var-scope R<规则id> --var-id <id> --var-type number --op eq --threshold 1
xgg variable watch --follow                       # 持续观察变量变化（NDJSON）
```

当前网关模型与 CLI 约束：

- **类型只有 `number` 和 `string`，没有 boolean。** `--type boolean` 会被拒。开关状态用 `number` 的 `1/0` 或 `string` 的 `"on"/"off"`。
- **变量 id 和 scope 名都必须是非空纯字母数字** `[A-Za-z0-9]+`（可以数字开头），下划线/连字符/点/空格会被拒（`id/scope must be alphanumeric`）。
- **scope 三种可见性：**
  - `global`：全局，网页主页面「全局变量」可见，适合跨规则共享（在家模式、最后一次按钮动作、温度缓存等）。
  - `R<规则id>`：**规则内变量**，在该规则编辑页「本规则变量」可见，校验器接受。`rule new` 会自动 bootstrap 本规则的 `R<id>` scope。引用错 scope 会报 `卡片变量有误: <scope> is neither "global" nor "R<本规则id>"`。**因为 scope 必须是纯字母数字，要用规则内变量就让规则 id 保持纯字母数字（默认就是数字串，OK）。**
  - 其他任意串，或 `R<另一个/不存在的规则id>`：**ghost data**——网关可能存下，但当前规则不可见，网页也不会把它当作可用变量。不要用。
- **scope 识别：** `rule node add --rule-id <id>` 把且只把 `global` 与当前规则的 `R<id>` 当作已知 scope；变量写命令会读取在线规则清单，确认 `R<id>` 确实对应现存规则。合法的本规则 scope 不需要 `--allow-unknown-scope`。跨规则、不存在或自定义 scope 会告警，并在严格规则校验中失败；`--allow-unknown-scope` 只用于明确的 raw/ghost-data 实验，不能让该 scope 变成规则可见。
- **`set-value` 改值会核对类型：** `--type` 与变量已存类型不符直接退出 `5`(要改类型加 `--force-type`;不给 `--type` 则自动用已存类型)。删除用 `variable delete --scope <s> --id <id>`(或 `--all` 删整个 scope);`variable watch --follow --max-events <N>` 跟 N 条变化后退出。
- **配置和值分开：** `get-config` 读取单变量配置；`set-config` 只更新显示名，不改类型或当前值，并按写命令执行 snapshot guard。
- **变量 `--value` 不是统一 JSON 解析：** `number` 使用数值转换；`string` 原样保存 argv 文本。`--value Seed` 保存 `Seed`，`--value '"Seed"'` 会把双引号也保存为数据。只有确实需要引号字符时才在字符串参数中写 JSON 风格引号。
- 若用户明确说「不要用变量」，就别 `variable create`、别 `varChange/varGet/varSet*`。优先用 `deviceGet` 读真实设备状态；设备无可读状态时再问是否允许用 `register` 这种图内状态卡片。

### 避坑：网页端变量缓存（CLI 写不广播 configChanged）

CLI 直连网关写入变量，但**不会**向其他已打开的网页会话广播 `configChanged`。所以用 `variable create` / `set-value` / `delete` 对变量增删改查后，长开着网关网页的用户在浏览器刷新前看不到任何变更：

- 新建的变量在网页「全局变量」「本规则变量」里**看不到**——容易被误判为「CLI 创建失败」。
- 更具迷惑性的是，**引用该变量的卡片节点会在网页上显示「变量已丢失」**——容易被误判为「变量真的没了 / 被删了」。

这两种都是已知的网页端 UI 缓存表现，**不是** CLI 写入失败，也**不是**变量真的丢失。

**给 Agent 的行为指引**：当你已经用 `xgg variable get-value` 在网关上确认值真实存在、用 `xgg rule view` 确认规则引用的 scope/id 也对，而用户却反馈「网页上没看到这个变量」或「卡片显示变量已丢失」时，**不要**把它当成 CLI 写入失败、也**不要**断定变量真的丢了，更不要据此重写规则或重建变量。正确做法是主动告知用户：这是已知的网页端 UI 缓存 bug，请按 **F5 刷新网页**后再查看，变量与卡片即会恢复正常。诊断顺序固定为：

```bash
xgg variable get-value --scope <scope> --id <id>      # ① 确认网关上真有这个值
xgg rule view <rule-id> --pretty                       # ② 确认卡片引用的 scope/id 也对
# ③ 让用户 F5 刷新网页
# ④ 三项都过才往别处排查
```

## 六、表达式（`varSetNumber` / `varSetString` 的 `--expr`）

`--expr` 把你写的表达式拆成网关的 `elements` 数组。语法：

| 写法 | 含义 |
|---|---|
| `$id` | 变量引用，默认 scope（`global`，或 `--default-expr-scope` 指定） |
| `$scope.id` | 限定 scope 的变量引用 |
| `$$` | 字面量 `$` |
| 其余 | 字面文本（函数、运算符、中文都算） |

**永远用单引号包 `--expr`**，否则 shell 会把 `$id` 当成 shell 变量展开。

scope 和 id 共用变量创建入口的 `[A-Za-z0-9]+` 约束，因此 `$123`、`$global.123`、`$R456.123` 都是变量引用。每个未转义的 `$` 都必须启动合法的 `$id` 或 `$scope.id`；`$bad_id`、`$bad-id`、`$global.` 等会在本地直接报 `identifier`，不会在 `varSetString` 中静默拆成变量加普通文本。要写字面 `$` 一律用 `$$`。紧邻变量做减法时，数字/括号/函数调用可直接写（如 `$x-1`、`$x-abs(1)`）；其他情形建议写空格（`$x - $y`）以免把连字符误当成非法 id。

`rule export` 会用同一解析器回读它生成的 `--expr`。如果源图的结构化 elements 无法用 DSL 无损表达（例如变量后紧跟会被吞入变量 ID 的字母或数字常量），导出会直接报 `ConfigError`，不会生成语义漂移或注定失败的脚本；先在源表达式中加入空格等显式分隔符，或使用 `rule view` 的整图 JSON 往返。

- `varSetNumber`：把拼好的串当**数字表达式**求值。支持 `+ - * / %`、括号、逗号参数，以及函数库：
  `abs pow log sin cos tan asin acos atan max min round floor ceil rand randint now year month date day hours minutes seconds pi e`。
  **无参函数也要带括号**（`rand()` 不是 `rand`，否则被当变量名）；逗号用 ASCII `,`；`day()` 周日=0（不是 ISO 周一=1）；`now()` 是毫秒 epoch；`rand()` ∈ [0,1)。
- `varSetString`：只做字符串拼接，不运行数值表达式语法检查；仍会校验 `$` 变量引用 grammar。中文/UTF-8 正常，总长上限 512 字节。

例：`--expr '$global.count + 1'`（自增）、`--expr 'round($global.brightness65535 / 655.35)'`（65535→百分比）、`--expr 'randint(1, 16777215)'`（随机颜色）、`--expr '现在温度 $global.temp 度'`（字符串）。

> CLI **会**在本地校验 `varSetNumber` 数字表达式语法——使用与网页“保存”按钮一致的解析器。两种触发：① 所有开启 graph validation 的图写路径，以及 `rule enable` 的重新检查；非法即拒绝并回显**具体错误**（kind + 拼好的表达式串）。`rename` / `set-tags` / `delete` 不是图校验路径；`rule import` 只渲染文本，只有它生成的脚本真正执行写命令时才校验。② `rule expr-check '<表达式>'` 纯本地单验一条（不连网关，0 合法 / 2 非法，支持 `--pretty`）。**推荐 agent 拼规则前先 `expr-check` 验一遍。**

```bash
$ xgg rule expr-check '$global.count + 1'
{"ok":true,"input":"$global.count + 1","template":"$ + 1"}      # exit 0

$ xgg rule expr-check 'flor($x)'                                  # 拼错函数名
{"ok":false,"input":"flor($x)","template":"flor($)","kind":"function","message":"未知函数（检查拼写与大小写；无参函数也要带括号，如 rand()）"}   # exit 2

$ xgg rule expr-check --pretty 'abs($x'                           # 括号不配对
✗ 不合法 — 括号不匹配（检查 ( 与 ) 是否成对）[bracket]（表达式: "abs($"）   # exit 2
```

错误 `kind` 七类：DSL 预检查的 `identifier`（变量 scope/id 非法），以及网关算术解析器的 `bracket`（括号不配对）、`function`（未知函数）、`argCount`（参数个数不对）、`number`（空操作数/非数字 token）、`expression`（运算符两侧操作数不合法）、`internal`（解析内部错误）。`template` 是解析器实际看到的串（`$var` 折叠成 `$`）。`expr-check` 只校验**数字**表达式；`varSetString` 是纯拼接，但同样先做变量引用 grammar 预检查。

## 七、观察设备实时状态

在已审计 bundle 的调用面与当前 `xgg` 已建模接口中，未发现“客户端随时读取任意设备实时属性”的通用 RPC；这不是对所有固件/私有接口的绝对不存在证明。调试/汇报实时值时，把属性**导进变量**再读：

先用 spec 确认属性及其类型；下面是完整的一次性读取图（bool 映射为 number 0/1，其他属性选择与 spec/CLI 映射匹配的 `number|string` 变量）：

```bash
xgg device spec <did> --pretty
xgg variable create --scope global --id snap --type <number|string> --value <初值> --name snap
xgg rule new --name "读取属性到变量"                    # 记下 rid
xgg rule node add --rule-id <rid> --type onLoad --id n-load
xgg rule node add --rule-id <rid> --type deviceGetSetVar --id n-read \
  --device-did <did> --device-property <p> --var-scope global --var-id snap
xgg rule edge add --rule-id <rid> --from n-load:output --to n-read:input
xgg rule layout <rid>
xgg rule validate --rule-id <rid>
xgg rule lint --rule-id <rid> --strict
xgg rule enable <rid>
xgg variable get-value --scope global --id snap
xgg rule logs <rid> --tail 20
```

持续接收属性 notify 则改用 property-mode `deviceInputSetVar`，然后 `xgg variable watch --follow`；按 bundle/UI 语义，`--preload` 会在规则启用时先查询/评估一次当前值，`--no-preload` 只跳过这次初始动作，后续 notify/change 路径不变。该时序仍须在目标固件用日志或变量读数验证；同时先看 spec 的 `pushAvailable`。

审计 bundle 发现已知或疑似 RPC、且 typed 命令尚未覆盖时，可把 `xgg api <method> --kind read --params ...` 当作低层探针。对已知或可能修改状态的方法必须明确 `--kind write`，启用 Agent mode/快照目录并遵守 mutation guard；绝不能为了绕过保护把 write-capable 方法标成 read。它是有边界的协议探索入口，不是日常属性读取承诺。

### 分区标签与能力感知设备替换

已验证型号 `xiaomi.sensor_occupy.p1` 把 siid 4…35 映射为 A-1…B-16 标签；其他型号（包括其他潜在分区传感器）返回空列表，因此这不是通用分区发现：

```bash
xgg device partitions <did> --pretty
```

替换现有规则中的五类设备卡（`deviceInput` / `deviceGet` / `deviceOutput` / `deviceInputSetVar` / `deviceGetSetVar`）时，先只读解释候选和每项契约，再 dry-run 聚焦一个目标：

```bash
xgg rule device replacements --rule-id <rid> --node-id <nid> --pretty
xgg rule device replacements --rule-id <rid> --node-id <nid> \
  --target-did <target-did> [--target-siid <N> --target-piid <N>] --pretty
xgg rule device replace --rule-id <rid> --node-id <nid> \
  --target-did <target-did> [--target-siid <N> --target-piid <N>] --pretty
```

`--target-piid` / `--target-eiid` / `--target-aiid` 三选一，并与目标卡家族匹配；selectors 必须配 `--target-did`。同一目标有多个兼容 mapping 时必须按 dry-run 建议消歧。兼容性比较 URN 前五段、dtype、value-range min/max/step、value-list values、event arguments 与 action inputs。

默认 replacement discovery 排除 ghost device。显式用 `--target-did` 聚焦 ghost 做清单差异诊断时，候选会明确返回 `eligible:false` 与原因，不生成可应用的 `planId`。不要尝试把该诊断结果推进写路径。

只有用户确认 dry-run 后才写：

```bash
xgg rule device replace --rule-id <rid> --node-id <nid> \
  --target-did <target-did> --target-siid <N> --target-piid <N> \
  --apply --confirm-target-did <target-did> --snapshots-dir "$PWD/snapshots"
```

写路径固定强制 rollback snapshot，在同一 mutation lease 内 fresh 读取设备清单、reload spec、复查 live graph、严格校验、`setGraph` 并 readback；若目标从 dry-run 到 apply 之间变成 ghost，会在 `setGraph` 前硬拒绝。不支持 `--no-snapshot`。网关没有 CAS，应用期间让用户停止编辑网页画布。不要在家庭网关上为了“验证命令”随意替换真实设备卡。

## 八、典型需求模板

需求匹配按钮/toggle、时间窗、多路合并、延迟、循环、模式切换、变量或安全探针时，读取 [references/recipes.md](references/recipes.md)。配方只给图形模式；设备 short-name 与运行结果仍以目标网关 spec、lint、日志和 readback 为准。

## 九、调试与验收

1. 看图：`xgg rule view <rid> --pretty`
2. 静态检查：`xgg rule validate --rule-id <rid> --spec-aware` + `xgg rule lint --rule-id <rid> --strict`（设备 action 不得省略 spec-aware）
3. 触发并看日志：`xgg rule logs <rid> --tail 50`（默认表格；加 `--json` 出 JSON；`--level error` 只看错；`--follow` 持续跟）。

   日志行示例（一次 `onLoad → deviceOutput` 的执行）：

   ```
   info  -        规则启用
   info  n-load   link n-load.output → n-on.trigger = 事件
   info  n-on     n-on [true]
   info  n-on     n-on success
   ```

   读法：`link <src>.<pin> → <dst>.<pin> = 事件` 是边触发，`<node> [value]` 是该节点执行的取值/分支，`<node> success` / `failed` 是动作结果。

   > `rule logs` 输出的是从有界网关日志拉取中**成功解析的日志项**，再按 rule id / 时间 / level 过滤并应用 `--tail`。它不暴露未解析行、游标是否回绕或扫描是否完整，还受 `--max-blocks`、网关保留窗口和 tail 上限影响。因此空结果不能单独证明「从未触发」；必须结合规则图 readback、可控触发或其他证据判断。网页还会做自己的过滤和渲染，所以两者不必逐行一致。
4. 对专门构造、完整下游均为纯软件 marker 的探针，`onLoad` 可用 `rule disable` → `rule enable` 即时重放且不驱动物理设备；既有规则可能从 onLoad 驱动物理动作或业务变量，必须先审查完整下游并按用户授权触发。`timeRange` 可等待 start 验证窗口进入事件；`varChange` 等其他独立源先在目标网关验证实际触发。`loop` 不是独立入口，必须先由事件源驱动 `loop.start`；物理按钮、门锁、人体传感器要请用户实际触发后再看日志。
5. 网页显示「变量已丢失」但 CLI 里变量存在时，先让用户**刷新网页**，不要立刻重写规则（见规范 7）。

## 十、备份（本地 `.bak` 与网关云备份）

本地导出生成与官方 bundle 相同 envelope 的完整 version-2 `.bak`；导入同时接受 version 2 与官方旧版 rules-only 数组。导入会**删除当前全部规则和变量，再仅重建备份中包含的内容**，固定先 dry-run：

```bash
xgg backup local-export --output ./gateway-rules.bak
xgg backup local-import --input ./gateway-rules.bak --dry-run
# 只有用户明确授权 replace-all 后：
xgg backup local-import --input ./gateway-rules.bak \
  --confirm-replace-all --snapshots-dir "$PWD/snapshots"
```

读取阶段会在访问 session 前验证 SHA-256、bounded deflate、payload schema、变量与每张规则。旧版数组没有变量，会规范化为 `variables: {}`；真正导入会删除现有变量且不会重建它们，并不是 merge 或“保留当前变量”，所以必须在 dry-run 中核对 `createVariables` 等计数。真正应用固定强制 rollback snapshot、持有一个 mutation lease，并在首个失败处停止。不要用家庭网关做无授权恢复 E2E；安全验证只做 local-export、离线 decode/plan 与 `--dry-run`。

云备份命令：

```bash
xgg backup list --from fds --pretty             # 列云备份
xgg backup create --from fds --file-name "<名字>"   # 网关会给名字追加 .bak 后缀
xgg backup cloud-export --from fds --did <did> --ts <ts> --file-name "<名字>" --output ./history.bak --snapshots-dir "$PWD/snapshots"
xgg backup download --from fds --did <did> --ts <ts> --file-name "<名字>"   # 三项均来自 backup list；低层 generate 前必须先 download
xgg backup progress --from fds --progress-id <id>
xgg backup generate --from fds --did <did> --ts <ts> --file-name "<名字>"
xgg backup load --from fds --did <did> --ts <ts> --file-name "<名字>" --snapshots-dir "$PWD/snapshots"
xgg backup delete --from fds --did <did> --ts <ts> --file-name "<名字>" --snapshots-dir "$PWD/snapshots"
xgg backup config get --from fds
xgg backup config set --from fds --auto-backup true --auto-backup-limit <N> --snapshots-dir "$PWD/snapshots"
xgg backup create --from fds --file-name "<名字>" --wait   # 轮询进度到 100% 再返回
```

从历史云备份保存可移植文件时使用 `cloud-export`：它会在一个 mutation lease 内自动 download、等到终态再 generate，随后把官方 length-prefix/raw-deflate + SHA-256 envelope 以 `0600` 原子写入本地；默认拒绝覆盖，确需替换才加 `--overwrite`。stdout 只给文件与进度摘要，不输出完整家庭规则/变量。`generate` 是依赖网关缓存状态的低层命令，只用于已经明确完成同一 `{did,ts,file-name}` download 的高级流程。

`--from fds` 指小米云存储。Agent 模式同样受快照目录约束。

低层 `generate` 前必须先对完全相同的 `{did,ts,file-name}` 执行 `download`。`load` 会在一个 mutation lease 内自动 download、等缓存进度到 100%，再调用 load 并等待可确认的恢复终态；下载 ACK/进度含糊时不会进入 load，load 只返回 `{}` 等无进度 ACK 时仍按 `NOT_CONFIRMED` 封锁，不能把网页固定等待几秒当成完成。`load` 是全量恢复，`delete` 永久删除云备份，`config set` 改自动备份策略；三者都必须有用户明确授权和 rollback snapshot，不能仅为探测能力而执行。

`create` / `download` 默认原样返回网关 ACK/result；可轮询句柄可能是 bare number、`progress_id` 或 `progressId`，精确空对象 `{}` 表示同步完成，其他无句柄 ACK 不能证明完成。加 `--wait` 才会抽取句柄、轮询到 100% 并在 JSON 输出里附带统一的 `progress`；句柄 `0`（同步完成或命中网关本地缓存）立即映射为 100%。`load` 自动执行的下载终态摘要固定输出为 `downloadResult` / `downloadProgress`；load ACK 只表示已接受，因此无论是否带 `--wait` 都会在同一 mutation workflow 租约内等到 100% 后才返回，`--wait` 只额外把 load 的 terminal `progress` 写入输出。可选 `--poll-interval-ms`（默认 1000）同时作用于下载与恢复轮询，`--poll-timeout-ms`（默认 60000）给每个阶段独立的超时预算。

## 十一、常见踩坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `rule enable` 成功但动作没发生 | 只证明启用，未证明触发 | 触发后查 `rule logs` |
| 网页看不到 CLI 新建的变量/规则，或卡片显示「变量已丢失」 | 网页 SPA 缓存未刷新（CLI 写不广播） | 让用户 F5 刷新；先按规范 7 三步诊断 |
| `cross-color edge: event output → state input` (exit 5) | 把纯事件接进了状态输入 | 事件接事件输入；状态合并用 `logicOr/logicAnd`，事件合并用 `signalOr` |
| `fan-in cap ... 一个输入节点只能连一条线` | 一个输入 pin 接了多条入边 | 先过 `signalOr`/`logicOr`/`logicAnd` 再汇入 |
| `卡片不可达: <类型> sink ... has no satisfiable upstream event path`（enable exit 5 / lint error） | 独立事件源没有按目标 pin/真假聚合规则抵达动作卡；常见是 `eventSequence` 只活一路、`logicAnd` 缺状态、`condition` 分支缺对应真假事实、`statusLast` 只有 false，或只接了 `loop.stop`/`onlyNTimes.zero` | 补齐必需输入并检查真假：`eventSequence` 全部事件；`condition.met` / `statusLast` 要可变为 true 的状态，`condition.unmet` 要可为 false；需要反相时接 `logicNot`，多状态按 `logicAnd`/`logicOr` 组合；连完 `rule lint --strict` 复查 |
| `卡片变量有误: <scope> is neither global nor R<id>` | 引用了非法 scope（常见：复制规则后还指向源规则的 `R<旧id>`） | 改 `--var-scope global` 或当前规则的 `R<本规则id>`，或在新规则 scope 下重建变量 |
| `卡片变量丢失` | 变量不存在/被删 | 先 `xgg variable create` |
| `--type boolean ... not a valid gateway variable type` | 变量类型只有 number/string | 开关用 number 1/0 或 string on/off |
| `id/scope must be alphanumeric` | 变量 id/scope 含非字母数字 | 去掉 `_ - .` 等 |
| `float property only supports --op gt\|lt\|between` | **连续** float 属性不支持 gte/lte/eq/ne（带 value-list 的枚举 float 会自动按 `int` 处理，可用 eq/ne） | 改 `gt/lt/between`，或换思路（如 `logicNot` 取反表达 `≤`）；若该属性其实是枚举（有 value-list）本错误不该出现，复查 `xgg device spec` |
| `cannot write a number variable to ...: the MIoT property declares no value-range` | 把 `number` 变量写进没有 `value-range` 的设备属性/动作入参 | 改用字面 `--value <数值>`，或换一个 `device spec` 里声明了 `value-range` 的属性；boolean/string 变量不受限 |
| bool 属性比较不触发 | bool 只能 `eq`，threshold 必须 0/1 | `--op eq --threshold 1`(真) 或 `0`(假) |
| 设备属性触发不触发 | 设备 `pushAvailable=false`，property notify 收不到 | 改用 `deviceGet` 在事件到来时主动读 |
| 目标设备命令超时 `-9999` | ghost device 或设备不可达 | 换非 ghost 设备，查 `device list` 的可用性 |
| `varSetNumber` 表达式语法非法（写入被拒，exit 5） | 写错函数名/括号/参数 | 看回显的具体 kind+表达式串；或 `rule expr-check '<表达式>'` 单验一条；无参函数记得带括号 |
| `varSetNumber` 语法合法但算错（运行期数值不对） | 取值/逻辑问题（语法已过本地校验） | 看 `rule logs` 的 eval 结果 |

## 十二、收尾标准

向用户汇报完成前，至少：

```bash
xgg rule layout <rid>
xgg rule validate --rule-id <rid> --spec-aware
xgg rule lint --rule-id <rid> --strict
```

是否启用以用户意图和原规则状态为准，不要为验收擅自激活刻意禁用的自动化。用户授权运行、或原规则本就应启用时，才执行 `xgg rule enable <rid>` 并在触发后读 `rule logs`；否则用 `rule view`/readback 确认 `enable=false`。在已获运行授权前提下，能由 Agent 自主触发的（`onLoad`，或可安全驱动的设备；`loop` 仍需上游事件接 `start`）就触发并读日志/变量证明运行；不能的（物理按钮、传感器）明确告诉用户需要其物理触发，并在用户触发后再读日志确认。最后提醒用户：CLI 的改动需要在网关网页 **F5 刷新**才能看到。

## 附录：冷启动与 raw JSON

需要整图 envelope、逐类节点四段结构、卡片尺寸、比较 wire 编码或非平凡 JSON 实样时，读取 [references/node-catalog.md](references/node-catalog.md)。优先使用 shortcut；只有 shortcut 覆盖不到或必须原子写整图时才下沉到 raw JSON。
