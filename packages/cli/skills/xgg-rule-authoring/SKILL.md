---
name: xgg-rule-authoring
description: Use when an LLM Agent needs to operate a Xiaomi Gateway Geek Edition (中枢网关极客版) through the xgg CLI — login, device discovery, authoring/validating/enabling automation rule graphs, the 25 executable cards plus the nop canvas note, variables, expressions, snapshots, logs, and backups.
---

# xgg 自动化编写 Skill

## 目标

用 `xgg` CLI 把用户的自然语言需求变成小米中枢网关极客版的自动化。网关里的每个自动化是一张**有向图**：节点是卡片，边是「某节点的输出 pin → 另一节点的输入 pin」。Agent 的任务不是「把命令跑到返回 ok」，而是「按需求选对卡片、查清参数、连对 pin、静态校验、启用，并用日志或变量读数证明它真的运行」。

> 本 Skill 里的所有命令形态与自动化模板，均已在真实网关上 `validate` + `lint` 全清并（可运行的部分）跑通验证。把它当事实来源；和 `--help` 冲突时以 `--help` 的**参数名**为准，和官方网关行为冲突时以网关为准。

## 使用场景（Agent 可承担的任务）

本 Skill 让你（Agent）独立承担下面三类任务，覆盖自动化的完整生命周期。三类与 README 的三类场景一一呼应，但写成给你的操作指引——每类点出关键命令与验收标准。任何一类都遵循同一条原则：写完不算完，要用日志或变量读数证明它真的按需求运行，命令返回 ok 不算完成。

### 1. 设计并创建自动化

把用户的自然语言需求变成一张可用的规则图。固定路径：

```bash
xgg rule new --name "<规则名>"            # 拿到 rule-id
xgg rule node add --rule-id <rule-id> ... # 每张卡片一条；设备卡先 device spec 查参数
xgg rule edge add --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule layout <rule-id>                  # 连完线跑一次；执行卡按数据流布局，保留 nop 位置
xgg rule validate --rule-id <rule-id>      # 卡片配置 + 变量存在/scope
xgg rule enable <rule-id>                  # 启用（自带保存键级预检）
xgg rule logs <rule-id> --tail 20          # 触发后看日志证明运行
```

设备相关卡片务必先 `xgg device spec <did>` 查清属性 / 事件 / 动作名，不猜字段。纯软件可确定重放的独立入口只有 `onLoad`，用 `disable` + `enable` 重放后读日志 / 变量；`loop` 必须由上游事件接入 `start`，物理触发的按钮、传感器则请用户实际触发后再看日志。

### 2. 读日志诊断并修复既有自动化

用户说某条自动化「不工作」时，先读它的真实运行日志定位，再改图修复，不要凭猜重写：

```bash
xgg rule logs <rule-id> --tail 50          # 定位：没触发 / 触发了没动作 / 条件没满足
xgg rule view <rule-id> --pretty           # 对照规则图看是哪一段
# 改图：rule node add / rule edge add，或取整图 JSON 改后写回
xgg rule validate --rule-id <rule-id>      # 改完先静态校验
xgg rule enable <rule-id>                  # 重新启用（disable + enable 可重放 onLoad）
xgg rule logs <rule-id> --tail 20          # 复看日志确认修复
```

日志读法见「调试与验收」：`link <src>.<pin> → <dst>.<pin> = <事件>` 是边触发，`<node> [value]` 是取值 / 分支，`<node> success` / `<node> failed` 是动作结果。日志里完全没出现触发器节点 = 规则根本没触发；走了 `unmet` 分支 = 条件没满足。

### 3. 盘点现有设备与自动化，与用户头脑风暴新方案

帮用户在真实清单上做规划，而不是空想。先用只读命令建立全貌：

```bash
xgg device list --pretty                    # 家里有哪些可用设备（默认排除 ghost）
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

5. **不要用 `--no-validate` / `--no-snapshot` / `--no-var-check` 绕过普通问题。** 它们只在你明确做 raw probe、且已知风险时才用。`--no-validate` 关掉网页保存键校验器，`--no-var-check` 关掉增量变量存在性检查，`--no-snapshot` 关掉写前快照。

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
xgg rule validate --rule-id <rid>                               # 卡片配置 + 变量存在/scope（一次列全部问题）
xgg rule lint --rule-id <rid> --strict                          # 边拓扑 + pin 颜色（再叠加保存键校验）
xgg rule enable <rid>                                           # 启用（自带保存键级预检，会兜底拦截）
xgg rule logs <rid> --tail 20                                   # 触发后看日志
```

关键点：

- `rule new` 只创建空规则 envelope；每张卡片用 `rule node add` 加。默认 rule id 是无连字符的数字串。
- `rule node add --id <node-id>` 给节点稳定命名，后续连线更安全；不指定则随机。
- 连线用 `<node-id>:<pin>`，例如 `n-click:output` → `n-light-on:trigger`。
- `rule layout` 只改可执行卡片的网页画布坐标、不改逻辑：触发器/源在左，每个节点严格排在其所有输入右侧，分支纵向堆叠，相互独立的子自动化各占一条横带。`nop` 备注的位置表达它所说明的画布区域，因此保持不动。网页 UI 自己不做自动布局，所以这步是让 CLI 创建的规则在网页里可读的关键。
- `rule enable` 返回成功只代表启用完成，**不代表触发成功**；触发后必须看 `rule logs`。

### 三层校验——分清哪条命令抓哪类问题

| 层 | 命令 | 抓什么 | 写入时是否自动跑 |
|---|---|---|---|
| 卡片配置 + 变量存在/scope | `rule validate`（dry-run，不写） | 卡片字段非法、`卡片变量丢失`、`卡片变量有误`（scope 既非 `global` 也非 `R<本规则id>`）；离线 `--body/--stdin` 也会校验 scope 白名单，但不读网关变量清单，因此只有在线 `--rule-id` 路径会判断变量是否存在 | `rule set` / `rule enable` 默认跑（违规抛 `ConfigError` 退出 5，`error.details.issues` 列出每个问题卡片）；增量 `node add` 不自动跑变量清单检查 |
| 边拓扑 + pin 颜色 | `rule lint`（`--strict` 再叠加上面那层） | 断边、空边、自环、重复边、event↔state cross-color 死线、`condition.condition` 无入边（网关默认 false，只走 `unmet`，`met` 是死分支） | **否**——网关 `setGraph` 接受这些，lint 只在读时报。但 `rule edge add` 自己会在写时拦 cross-color（见下） |
| 按 pin + 状态真假聚合的有向可达性（never-fires sink） | `rule lint --strict`（读时报）；`rule enable` 写时硬拦 | `卡片不可达`：独立事件源虽存在，但无法按目标卡的必需输入与真假语义驱动动作卡（`deviceOutput`/`varSetNumber`/`varSetString`/`deviceGetSetVar`）。`eventSequence` 要全部事件输入；`condition.met` 要 trigger + may-true，`unmet` 要 trigger + may-false；`statusLast` 只接受 may-true；`logicAnd`/`logicOr`/`logicNot` 传播布尔真假，直接事件路径还要更新；`signalOr` 任一路事件即可。`register` 初值/`setFalse` 是 false，`setTrue` 增加 true；`timeRange` 只供状态，不能直接 bootstrap；`loop.stop`/`onlyNTimes.zero` 也不能单独向下游传播 | **仅 `rule enable`**（抛 `ConfigError` 退出 5）；`rule set`/`setGraph` 不跑（增量编写允许卡片悬空待连线）；`rule validate` 也不报，要用 `rule lint --strict` 提前看到 |

启用前**两条都跑**看全量问题：`rule validate --rule-id <id>` 和 `rule lint --rule-id <id> --strict`。`rule enable` 的内建预检是兜底，不是「看全问题」的替代（它的 `error.message` 只报第一个，`details.issues` 才有全部）。

## 三、如何获取卡片参数

> **空网关也能从零构造,不需要任何现成规则可抄。** 最稳的冷启动是用 shortcut(第五、十节):一条 `rule node add --type <T> <flags>` 不写一行 JSON 就能产出合法卡片,缺什么参数 `--help` 会告诉你。只有「某卡片没有 shortcut」「要复刻网页里的复杂卡片」「想一次原子推送整张图」时才需要手写 JSON——这时**不要猜结构,直接抄附录 A**(整图信封 + 25 类执行节点、`nop` 备注节点精确 JSON + 比较算子 wire 编码,均经离线 `rule validate --body` 实测零错零警)。有现成规则时 `xgg rule view <id>` 拿到的就是可改可写回的整图 JSON;空网关没得 view,就以附录 A 的模板起步。

优先级从高到低：

1. **设备参数：** `xgg device spec <did> --pretty`。从 `Properties` 选 `--device-property`，`Actions` 选 `--device-action`，`Events` 选 `--device-event`。
2. **CLI shortcut 参数：** `xgg rule node add --help`。这是各卡片**参数名**的当前事实来源。注意：`--help` 里 `eventSequence` 的示例仍展示老的 `--cfg` 路径，但 `eventSequence` / `register` / `modeSwitch` **都已有 shortcut**（`--type eventSequence --duration 5s`、`--type register`、`--type modeSwitch --outputs N`）——优先用 shortcut，不要被那个示例带去 `--cfg`。
3. **学已有规则：** `xgg rule view <id> --pretty` 看节点 `props/inputs/outputs`；`xgg rule export <id> --format shell` 反译成可复现的 CLI 命令。
4. **没有 shortcut、要复刻复杂 UI 卡片、或一次推整张图时才用 JSON。** 两条路径:`rule node add --cfg '<单节点JSON>'`(增量加一张卡)或 `rule set --body <整图JSON文件>`(原子推整张图)。**关键:四段 `cfg/inputs/outputs/props` 必须齐全**,只给内层 `props` 会被网关拒(`Invalid props`);设备卡的 `cfg` 还必须带 `urn`;每个节点的 `props` 形状各不相同(不是空 `{}`)。逐类节点的精确四段结构、整图信封、比较算子 wire 编码,全在**附录 A**,带可直接抄、已实测的实样。

## 四、pin 颜色与连线规则

每个 pin 有颜色：**event**（紫，瞬时信号，如单击、定时、延时结束）、**state**（绿，持续电平，如「当前在时间段内」「开关为开」），以及 **`event|state` 双色**（只出现在**输出** pin，能连任意输入）。

**连线合法性**（CLI `rule edge add` 在写时就强制执行，照搬网页画布规则）：

```
合法(源, 目标) = 源是 event|state 双色  或者  源颜色 == 目标颜色
```

通配只在**源侧**。由此推出一条极简结论：**唯一的 cross-color 违规 = 纯 event 输出 → state 输入**（因为下表里没有任何纯 state 输出，所有输出非 event 即双色）。state 输入只有这几个：`condition.condition`、`logicAnd/logicOr.inputN`、`logicNot.input`、`statusLast.input`。把纯事件接进它们会被 `rule edge add` 直接拒：

```
CONFIG (exit 5): cross-color edge: event output "<a>.output" → state input "<b>.condition" (canvas-illegal, runtime-dead)
```

**两条硬连线约束（写时强制）：**

- **fan-in cap = 1：** 每个**输入 pin 只能接一条入边**。再接第二条会被拒：`fan-in cap: input pin "<n>.<pin>" is already wired from another source（一个输入节点只能连一条线）`。要把多个源汇入一个动作，**必须先过一个 `signalOr`（事件）/ `logicOr`/`logicAnd`（状态）**。
- **cross-color**：见上。`rule edge add` 拦住的是单条边；批量 `rule set`/`import`（走原始 `setGraph`）不过这道关，所以批量导入后要用 `rule lint` 兜底查 cross-color。

### 权威 pin 表（25 类执行卡片 + 1 类备注节点，输出标注颜色）

| 类型 | 输入 pin | 输出 pin |
|---|---|---|
| `deviceInput` | — | `output`：事件模式(`--device-event`)=**event**；属性模式(`--op`)=**event\|state** |
| `deviceGet` | `input`(event) | `output`/`output2`(event) — 满足/不满足 |
| `deviceOutput` | `trigger`(event) | `output`(event) |
| `alarmClock` | — | `output`(event) |
| `timeRange` | — | `output`(**event\|state**) |
| `delay` | `input`(event) | `output`(event) |
| `statusLast` | `input`(**state**) | `output`(**event\|state**) |
| `condition` | `trigger`(event)、`condition`(**state**) | `met`/`unmet`(event) |
| `loop` | `start`/`stop`(event) | `output`(event) |
| `onlyNTimes` | `input`/`zero`(event) | `output`(event) |
| `counter` | `input`/`zero`(event) | `output`(**event\|state**) |
| `signalOr` | `input0`/`input1`/…(event) | `output`(event) |
| `logicOr` | `input0`/`input1`/…(**state**) | `output`(**event\|state**) |
| `logicAnd` | `input0`/`input1`/…(**state**) | `output`(**event\|state**) |
| `logicNot` | `input`(**state**) | `output`(**event\|state**) |
| `onLoad` | — | `output`(event) |
| `nop` | — | —（画布备注，无连接器） |
| `eventSequence` | `input1`/`input2`(event) | `output`(event) |
| `register` | `setTrue`/`setFalse`(event) | `output`(**event\|state**) |
| `modeSwitch` | `input`(event) | `output0`/`output1`/…(event) |
| `deviceInputSetVar` | — | `output`(event) |
| `deviceGetSetVar` | `input`(event) | `output`(event) |
| `varChange` | — | `output`(**event\|state**) |
| `varGet` | `input`(event) | `output`/`output2`(event) — 满足/不满足 |
| `varSetNumber` | `input`(event) | `output`(event) |
| `varSetString` | `input`(event) | `output`(event) |

常见连法：事件触发动作 `event → trigger/input/start`；状态做条件 `state → condition.condition`；事件进条件门 `event → condition.trigger`，再由 `condition.met/unmet` 分支；多事件合并 `signalOr`；多状态合并 `logicOr`/`logicAnd`。

> ⚠️ `signalOr`（事件 OR）和 `logicOr`（状态 OR）的卡片 schema **完全相同**，差别只在 pin 颜色。选错那个不会被 schema 拦，但事件源接 `logicOr` 的状态输入会被 `rule edge add` 的 cross-color 拦住，所以按上表的颜色选对那一个。

## 五、25 种执行卡片 + 1 种备注节点速查

| 类型 | 作用 | 常用 CLI 形态 | 备注 |
|---|---|---|---|
| `deviceInput` | 设备属性变化(状态)或设备事件(事件)触发 | 属性：`--device-did <did> --device-property <p> --op <op> --threshold <n>`；事件：`--device-event <e> [--event-filter <piid>=<v1>]` | 属性模式监听 push notify，`pushAvailable=false` 设备收不到（用 `deviceGet` 代替）；事件模式不受影响 |
| `deviceGet` | 输入事件到来时读设备属性并分支 | `--device-did <did> --device-property <p> --op <op> --threshold <n>` | 满足 `output`，不满足 `output2` |
| `deviceOutput` | 写设备属性或调用设备动作 | 属性：`--device-property <p> --value <v>`；动作：`--device-action <a> --params '<json>'` | bool 属性 `--value true/false` 均可；`$scope.id` 是变量引用，字面前导 `$` 要写成 `$$`（如 `$$hello` 写入 `$hello`） |
| `deviceInputSetVar` | 设备属性变化/事件参数写入变量 | 属性：`--device-property <p> --var-scope <s> --var-id <id>`；事件多参：`--device-event <e> --event-arg-var <piid>=<scope>.<id>`(可重复) | 设备无直接读 RPC，靠它把属性导进变量再读 |
| `deviceGetSetVar` | 输入事件到来时读设备属性并写入变量 | `--device-property <p> --var-scope <s> --var-id <id>` | 按需读取版（vs `deviceInputSetVar` 的变化推送版） |
| `alarmClock` | 定时 / 日出 / 日落触发 | 定时：`--at HH:MM[:SS] [--days 0,1..6 \| --weekday-only \| --holiday-only]`；日出日落：`--sunrise\|--sunset --latitude <n> --longitude <n> [--offset-min <±N>]` | 输出 event；日出日落**必须**给经纬度；`--offset-min` 负=之前 |
| `timeRange` | 当前是否处于时间段内（状态，不是触发） | `--start HH:MM --end HH:MM [--days 0..6 \| --weekday-only \| --holiday-only]` | 输出双色，惯用接 `condition.condition` |
| `delay` | 事件延迟后继续 | `--duration 5s`（`ms\|s\|m`） | 同一 delay 被新事件触发会重新计时；并行计时用多张 |
| `statusLast` | 状态持续一段时间后触发 | `--duration 10s` | 输入须是 state；状态中途变 false 计时重置 |
| `condition` | 用状态判断事件走满足/不满足 | 无额外参数 | 两个输入都要连；只连 trigger 时 condition 视为 false 走 unmet |
| `loop` | start 后按间隔循环，stop 停 | `--interval 30s` | 常配 `onLoad → loop.start` 自启 |
| `onlyNTimes` | 最多放行 N 次事件，zero 重置 | `--threshold <N>` | 放行前 N 个再阻断 |
| `counter` | 累计 N 次后触发，zero 清零 | `--threshold <N>` | 到 N 触发一次、之后状态保持 true（输出双色） |
| `signalOr` | 合并多事件，任一到来就输出 | `--inputs <N>`（默认 2） | 输入/输出皆 event |
| `logicOr` | 多状态任一为真则输出真 | `--inputs <N>` | 输入须是 state |
| `logicAnd` | 多状态全为真才输出真 | `--inputs <N>` | **每个输入都要连**，未连的输入视为 false |
| `logicNot` | 状态取反 | 无额外参数 | 常用来表达 `≤`（对 `>` 取反）等 |
| `onLoad` | 规则(重)加载时触发一次 | 无额外参数 | 触发时机见下；Agent 自测的主入口 |
| `nop` | 网页画布富文本备注 | 纯文本：`--text <s> [--background <css>]`；无损格式：`--delta '<Quill ops JSON>'` | 无输入/输出连接器，不参与运行；Delta、背景与尺寸可由 export/import 无损往返 |
| `eventSequence` | 两事件按 `input1→input2` 顺序在时限内发生才触发 | `--duration 5s`（shortcut） | 顺序按 pin 命名位置，不是到达先后 |
| `register` | 图内布尔锁存器 | 无额外参数（shortcut） | 初值 false（要 true 默认用 `onLoad→setTrue`）；输出状态 |
| `modeSwitch` | 每次输入轮流走 output0、output1… | `--outputs <N>`（≥2，shortcut） | 循环指针**跨规则重载保持**、不随 onLoad 重置；空 `outputN` 是合法跳过位 |
| `varChange` | 变量变化且满足比较时触发 | `--var-scope <s> --var-id <id> --var-type number\|string --op <op> --threshold <n>` 或 `--var-value <s>` | 输出双色 |
| `varGet` | 输入事件到来时读变量并分支 | 同 `varChange`（多 `input`，无 preload） | 满足 `output`，不满足 `output2` |
| `varSetNumber` | 算数字表达式并写入数字变量 | `--var-scope <s> --var-id <id> --expr '<expr>'` | 见「表达式」 |
| `varSetString` | 拼文本表达式并写入字符串变量 | `--var-scope <s> --var-id <id> --expr '<expr>'` | 字符串总长上限 512 字节 |

### onLoad 触发时机（四种，且仅这四种）

① 规则保存（任何编辑后保存）② 网关重启（断电、固件升级）③ 规则从禁用变启用（`rule enable`）④ 备份恢复。**正常运行期间不会再触发**，且与其他触发器在加载时刻的先后顺序未定义。因为 ③，`onLoad` 是 Agent 唯一能用纯软件 100% 自触发的入口。

## 六、比较操作（按 dtype 精确）

设备属性的 dtype 决定可用算子和等值的 wire 编码——**用错算子会被拒、用错编码会运行不触发**：

| dtype（来自 MIoT format） | `deviceInput`/`deviceGet` 可用 `--op` | 等值(`eq`)的 wire 编码 |
|---|---|---|
| `int`（所有整型 int8..int64/uint*） | `gt lt gte lte eq ne between` | `operator:"include"` + 数组 `v1:[n]` |
| `float` | **仅 `gt lt between`**（`gte/lte/eq/ne` 被网关拒 `Invalid operator`） | —（float 不做等值） |
| `bool` | 仅 `eq` | `operator:"="` + 标量 `v1:true/false`（`--threshold 1`=真，`0`=假） |
| `string` | 仅 `eq` | `operator:"="` + 标量 `v1:"open"`（用 `--property-value open`） |

设备 string 属性比较必须用 `--property-value <S>`，不能用数值 `--threshold`；例如 `--device-property mode --op eq --property-value open`。`--property-value` 不经 `parseFloat`，空字符串会在本地被拒绝。

变量比较（`varChange`/`varGet`）规则不同：

- `--var-type number`：用 `--threshold`（`between` 再加 `--threshold2`），算子 `gt lt gte lte eq ne between`；等值 wire 是 `operator:"="` + **标量** `v1`（**不是** `include`+数组，和设备卡相反）。
- `--var-type string`：**必须**用 `--var-value <S>`（与 `--threshold` 互斥），且只能 `--op eq`。
- `between` 必须同时给 `--threshold` 和 `--threshold2`，仅 int/float 与 number 变量可用。

## 七、变量模型

网关变量是可被规则读写的持久值：

```bash
xgg variable list --pretty
xgg variable get <scope> --pretty
xgg variable get-value --scope global --id <id>
xgg variable create --scope global --id <id> --type number --value 0 --name "<显示名>"
xgg variable set-value --scope global --id <id> --value 1
xgg variable create --scope R<规则id> --id <id> --type number --value 0 --name "<显示名>"
xgg rule node add --rule-id <规则id> --type varChange --var-scope R<规则id> --var-id <id> --var-type number --op eq --threshold 1
xgg variable watch --pretty                       # 实时观察变量变化
```

硬约束（均经网关验证）：

- **类型只有 `number` 和 `string`，没有 boolean。** `--type boolean` 会被拒。开关状态用 `number` 的 `1/0` 或 `string` 的 `"on"/"off"`。
- **变量 id 和 scope 名都必须是非空纯字母数字** `[A-Za-z0-9]+`（可以数字开头），下划线/连字符/点/空格会被拒（`id/scope must be alphanumeric`）。
- **scope 三种可见性：**
  - `global`：全局，网页主页面「全局变量」可见，适合跨规则共享（在家模式、最后一次按钮动作、温度缓存等）。
  - `R<规则id>`：**规则内变量**，在该规则编辑页「本规则变量」可见，校验器接受。`rule new` 会自动 bootstrap 本规则的 `R<id>` scope。引用错 scope 会报 `卡片变量有误: <scope> is neither "global" nor "R<本规则id>"`。**因为 scope 必须是纯字母数字，要用规则内变量就让规则 id 保持纯字母数字（默认就是数字串，OK）。**
  - 其他任意串，或 `R<另一个/不存在的规则id>`：**ghost data**——网关可能存下，但当前规则不可见，网页也不会把它当作可用变量。不要用。
- **scope 识别：** `rule node add --rule-id <id>` 把且只把 `global` 与当前规则的 `R<id>` 当作已知 scope；变量写命令会读取在线规则清单，确认 `R<id>` 确实对应现存规则。合法的本规则 scope 不需要 `--allow-unknown-scope`。跨规则、不存在或自定义 scope 会告警，并在严格规则校验中失败；`--allow-unknown-scope` 只用于明确的 raw/ghost-data 实验，不能让该 scope 变成规则可见。
- **`set-value` 改值会核对类型：** `--type` 与变量已存类型不符直接退出 `5`(要改类型加 `--force-type`;不给 `--type` 则自动用已存类型)。删除用 `variable delete --scope <s> --id <id>`(或 `--all` 删整个 scope);`variable watch --follow --max-events <N>` 跟 N 条变化后退出。
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

## 八、表达式（`varSetNumber` / `varSetString` 的 `--expr`）

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
- `varSetString`：纯字符串拼接，无语法检查；中文/UTF-8 正常；总长上限 512 字节。

例：`--expr '$global.count + 1'`（自增）、`--expr 'round($global.brightness65535 / 655.35)'`（65535→百分比）、`--expr 'randint(1, 16777215)'`（随机颜色）、`--expr '现在温度 $global.temp 度'`（字符串）。

> CLI **会**在本地校验 `varSetNumber` 数字表达式语法——内置与网页"保存"按钮**完全一致**的解析器。两种触发：① `rule set`/`import`/`node add`/`enable` 写入时自动校验，非法即拒绝并回显**具体错误**（kind + 拼好的表达式串）；② `rule expr-check '<表达式>'` 纯本地单验一条（不连网关，0 合法 / 2 非法，支持 `--pretty`）。**推荐 agent 拼规则前先 `expr-check` 验一遍。**

```bash
$ xgg rule expr-check '$global.count + 1'
{"ok":true,"input":"$global.count + 1","template":"$ + 1"}      # exit 0

$ xgg rule expr-check 'flor($x)'                                  # 拼错函数名
{"ok":false,"input":"flor($x)","template":"flor($)","kind":"function","message":"未知函数（检查拼写与大小写；无参函数也要带括号，如 rand()）"}   # exit 2

$ xgg rule expr-check --pretty 'abs($x'                           # 括号不配对
✗ 不合法 — 括号不匹配（检查 ( 与 ) 是否成对）[bracket]（表达式: "abs($"）   # exit 2
```

错误 `kind` 七类：DSL 预检查的 `identifier`（变量 scope/id 非法），以及网关算术解析器的 `bracket`（括号不配对）、`function`（未知函数）、`argCount`（参数个数不对）、`number`（空操作数/非数字 token）、`expression`（运算符两侧操作数不合法）、`internal`（解析内部错误）。`template` 是解析器实际看到的串（`$var` 折叠成 `$`）。`expr-check` 只校验**数字**表达式；`varSetString` 是纯拼接，但同样先做变量引用 grammar 预检查。

## 九、观察设备实时状态

**网关没有「直接读某设备某属性」的 RPC。** 要在调试/汇报时知道某设备属性现在的值，把它**导进变量**再读：

```bash
# 按需读一次：onLoad → deviceGetSetVar(设备属性 → 变量)，启用后读变量
xgg rule node add --rule-id <rid> --type deviceGetSetVar --device-did <did> --device-property <p> --var-scope global --var-id snap
# 或变化推送：deviceInputSetVar（属性每次变化时写进变量）
xgg variable get-value --scope global --id snap     # 或 xgg variable watch
```

## 十、典型需求模板（均经真实网关验证）

> 占位符：`<rid>` 规则 id，`<btn>` 按钮 did，`<light>` 目标设备 did，`<on-prop>` 可写开关属性名。

### 1. 单击按钮执行一个动作

```bash
xgg rule node add --rule-id <rid> --type deviceInput --device-did <btn> --device-event click --id n-click
xgg rule node add --rule-id <rid> --type deviceOutput --device-did <light> --device-property <on-prop> --value true --id n-on
xgg rule edge add --rule-id <rid> --from n-click:output --to n-on:trigger
```

### 2. 不用变量实现「按钮切换开/关」

前提：目标设备 spec 里有可读的开关属性。`deviceGet.output`=「当前已开」接关闭，`output2`=「当前未开」接打开。

```bash
xgg rule node add --rule-id <rid> --type deviceInput --device-did <btn> --device-event click --id n-click
xgg rule node add --rule-id <rid> --type deviceGet --device-did <light> --device-property <on-prop> --op eq --threshold 1 --id n-is-on
xgg rule node add --rule-id <rid> --type deviceOutput --device-did <light> --device-property <on-prop> --value false --id n-off
xgg rule node add --rule-id <rid> --type deviceOutput --device-did <light> --device-property <on-prop> --value true --id n-on
xgg rule edge add --rule-id <rid> --from n-click:output --to n-is-on:input
xgg rule edge add --rule-id <rid> --from n-is-on:output  --to n-off:trigger
xgg rule edge add --rule-id <rid> --from n-is-on:output2 --to n-on:trigger
```

### 3. 单击 / 双击 / 长按分别控制

事件名来自 `xgg device spec <btn> --pretty`（常见 `click` / `double-click` / `long-press`）。三张 `deviceInput` 各连各的动作：

```bash
xgg rule node add --rule-id <rid> --type deviceInput --device-did <btn> --device-event click        --id n-click
xgg rule node add --rule-id <rid> --type deviceInput --device-did <btn> --device-event double-click --id n-dbl
xgg rule node add --rule-id <rid> --type deviceInput --device-did <btn> --device-event long-press   --id n-long
# 每路各自连到 deviceOutput，或连到模板 2 的 deviceGet 分支各自 toggle
```

### 4. 只在某个时间段内响应按钮

`timeRange` 是状态，不能直接当 trigger，要经 `condition`：

```bash
xgg rule node add --rule-id <rid> --type deviceInput --device-did <btn> --device-event click --id n-click
xgg rule node add --rule-id <rid> --type timeRange --start 08:00 --end 22:30 --id n-time
xgg rule node add --rule-id <rid> --type condition --id n-cond
xgg rule edge add --rule-id <rid> --from n-click:output --to n-cond:trigger
xgg rule edge add --rule-id <rid> --from n-time:output  --to n-cond:condition
xgg rule edge add --rule-id <rid> --from n-cond:met     --to <action-node>:trigger
```

> 跨午夜（`end < start`，如 22:00→06:00）网页能保存成单节点，但网关运行时如何处理未经证实——需要确定性时用两个 `timeRange` + `logicOr`。

### 5. 多个触发条件任一触发同一动作

每个输入 pin 只能接一条线，所以多事件汇一处**必须**经 `signalOr`（状态则用 `logicOr`/`logicAnd`）：

```bash
xgg rule node add --rule-id <rid> --type signalOr --inputs 3 --id n-any
xgg rule edge add --rule-id <rid> --from n-a:output --to n-any:input0
xgg rule edge add --rule-id <rid> --from n-b:output --to n-any:input1
xgg rule edge add --rule-id <rid> --from n-c:output --to n-any:input2
xgg rule edge add --rule-id <rid> --from n-any:output --to <action-node>:trigger
```

### 6. 延迟关闭

```bash
xgg rule node add --rule-id <rid> --type delay --duration 5m --id n-delay
xgg rule edge add --rule-id <rid> --from <trigger-node>:output --to n-delay:input
xgg rule edge add --rule-id <rid> --from n-delay:output --to <off-node>:trigger
```

### 7. 事件循环 / 定时轮询（Agent 自测常用）

```bash
xgg rule node add --rule-id <rid> --type onLoad --id n-load
xgg rule node add --rule-id <rid> --type loop --interval 30s --id n-loop
xgg rule edge add --rule-id <rid> --from n-load:output --to n-loop:start
xgg rule edge add --rule-id <rid> --from n-loop:output --to <action-or-query-node>:input
```

### 8. 轮流执行多个模式

```bash
xgg rule node add --rule-id <rid> --type modeSwitch --outputs 3 --id n-mode
xgg rule edge add --rule-id <rid> --from <trigger-node>:output --to n-mode:input
xgg rule edge add --rule-id <rid> --from n-mode:output0 --to <mode0-action>:trigger
xgg rule edge add --rule-id <rid> --from n-mode:output1 --to <mode1-action>:trigger
xgg rule edge add --rule-id <rid> --from n-mode:output2 --to <mode2-action>:trigger
```

### 9. 用变量记录状态并触发

```bash
xgg variable create --scope global --id mode --type number --value 0 --name "模式"
xgg rule node add --rule-id <rid> --type varSetNumber --var-scope global --var-id mode --expr '$global.mode + 1' --id n-incr
xgg rule node add --rule-id <rid> --type varChange --var-scope global --var-id mode --var-type number --op gte --threshold 3 --id n-mode-hi
# n-incr.input 接事件源；n-mode-hi.output 接 mode≥3 时的动作
```

### 10. Agent 自测探针（纯软件可触发，无设备副作用）

`onLoad → varSetNumber` 写 marker，启用后读变量证明规则真的跑了：

```bash
xgg variable create --scope global --id probeMarker --type number --value 0 --name "probeMarker"
xgg rule node add --rule-id <rid> --type onLoad --id n-load
xgg rule node add --rule-id <rid> --type varSetNumber --var-scope global --var-id probeMarker --expr '1' --id n-mark
xgg rule edge add --rule-id <rid> --from n-load:output --to n-mark:input
xgg rule validate --rule-id <rid>
xgg rule enable <rid>
xgg variable get-value --scope global --id probeMarker     # 期望 1
```

## 十一、调试与验收

1. 看图：`xgg rule view <rid> --pretty`
2. 静态检查：`xgg rule validate --rule-id <rid>` + `xgg rule lint --rule-id <rid> --strict`
3. 触发并看日志：`xgg rule logs <rid> --tail 50`（默认表格；加 `--json` 出 JSON；`--level error` 只看错；`--follow` 持续跟）。

   日志行示例（一次 `onLoad → deviceOutput` 的执行）：

   ```
   info  -        规则启用
   info  n-load   link n-load.output → n-on.trigger = 事件
   info  n-on     n-on [true]
   info  n-on     n-on success
   ```

   读法：`link <src>.<pin> → <dst>.<pin> = 事件` 是边触发，`<node> [value]` 是该节点执行的取值/分支，`<node> success` / `failed` 是动作结果。

   > `rule logs` 输出的是网关**原始日志行**（仅按 rule id / 时间 / level 过滤），刻意**不复刻网页日志面板**——网页还会按节点连接类型再过滤、逐节点渲染中文说明、并静默丢弃它无法严格解析的行。所以 CLI 日志比网页更全也更「糙」，调规则时反而更有用，但别指望和网页日志面板逐行一致。
4. 可由 Agent 纯软件确定重放的是 `onLoad`：`rule disable` 再 `rule enable` 即可重放，然后读日志或变量。`loop` 不是独立入口，必须先由 `onLoad` 或其他事件源驱动 `loop.start`；物理触发的按钮、门锁、人体传感器要请用户实际触发后再看日志。
5. 网页显示「变量已丢失」但 CLI 里变量存在时，先让用户**刷新网页**，不要立刻重写规则（见规范 7）。

## 十二、备份（网关云备份）

```bash
xgg backup list --from fds --pretty             # 列云备份
xgg backup create --from fds --file-name "<名字>"   # 网关会给名字追加 .bak 后缀
xgg backup download --from fds --did <did> --ts <ts> --file-name "<名字>"   # 三项均来自 backup list；generate/load 前必须先 download
xgg backup create --from fds --file-name "<名字>" --wait   # 轮询进度到 100% 再返回
```

`--from fds` 指小米云存储。Agent 模式同样受快照目录约束。

`create` / `download` 默认立即返回网关给的 `progress_id`，操作可在后台继续；加 `--wait` 会轮询到 100% 并在 JSON 输出里附带 `progress`。`load` 是 restore，ACK 只表示已接受，因此无论是否带 `--wait` 都会在 mutation workflow 租约内等到 100% 后才返回；`--wait` 只额外把 terminal `progress` 写入输出。`progress_id` 为 0（同步完成或命中网关本地缓存）时立即完成。可选 `--poll-interval-ms`（默认 1000）调轮询间隔、`--poll-timeout-ms`（默认 60000）调超时。

## 十三、常见踩坑

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

## 十四、收尾标准

向用户汇报完成前，至少：

```bash
xgg rule layout <rid>
xgg rule validate --rule-id <rid>
xgg rule lint --rule-id <rid> --strict
xgg rule enable <rid>
xgg rule logs <rid> --tail 20
```

能由 Agent 自主触发的（`onLoad`，或可安全驱动的设备；`loop` 仍需上游事件接 `start`）就触发并读日志/变量证明运行；不能的（物理按钮、传感器）明确告诉用户需要其物理触发，并在用户触发后再读日志确认。最后提醒用户：CLI 的改动需要在网关网页 **F5 刷新**才能看到。

## 附录 A：整图 JSON 与逐类节点结构（冷启动手写参考）

> 给手写 JSON 的人用——空网关、没有现成规则可抄，或要一次原子推送整张图时。本附录所有结构均经离线 `xgg rule validate --body` 实测：全 25 类执行节点 + `nop` 备注节点 + 整图信封零错零警。（`rule validate --body` / `--stdin` 默认不读 session、不连 daemon/网关、也不访问公网，能直接跑卡片 schema 校验；只有显式加 `--spec-aware` 才查询公网 MIoT spec。`rule lint` 的边拓扑强校验**没有** `--body` 离线入口，会在 `rule set` / `rule enable` 写入时自动叠加；而**可达性（never-fires sink）校验只在 `rule enable` 写时跑、`rule set` 不跑**，离线想看就 `rule lint --strict`。）**首选仍是 shortcut（第五、十节）**；只有 shortcut 覆盖不到时才下沉到这里。

### A.1 节点四段通用结构

每个节点 = `{ "type", "id", "cfg", "inputs", "outputs", "props" }`，**四段都必须有且 strict**（多余 key 会被拒）。

- **`id`**：全图唯一，自己起（shortcut 会自动生成 `n-<毫秒时间戳>`，手写必须自带）。边靠它引用。
- **`cfg`** 按卡片分几个家族：
  - 逻辑/流程/时间卡：`{ "pos": {"x","y","width","height"}, "name": "<type>", "version": 1 }`（`urn` 省略）。
  - **设备卡**（deviceInput / deviceGet / deviceOutput / deviceInputSetVar / deviceGetSetVar）：**必须**再加 `"urn": "<设备的 urn:miot-spec-v2:...>"`（从 `device spec` 拿）。
  - **表达式卡**（varSetNumber / varSetString）：`pos` 多一个可选 `"exprHeight": 30`。
  - **时长卡**（delay / statusLast / loop / eventSequence）：`cfg` 多 `"unit"` + `"value"`（只是显示用；真正生效的毫秒数在 `props.timeout`/`interval`，两者要一致）。
  - **alarmClock**：`cfg` 多 `"happenType": "now"` + `"tempOffset": 0`。
  - **nop 备注**：`cfg` 多 `"contents": [Quill Delta insert ops]` + `"background": "#80CAFF"`；`pos.width/height` 是可调整后的备注尺寸。
- **`inputs`**：每个输入 pin 写 `null`；多输入卡写成记录，如 `{"input0": null, "input1": null}`。无输入的触发器卡写 `{}`。
- **`outputs`**：每个输出 pin 写**边数组**。**边没有独立结构——一条边就是字符串 `"<目标节点id>.<目标pin>"`，放进源节点对应输出 pin 的数组里。** 没连出去也要写空数组，如 `{"output": []}`（不能省成 `{}`）。

`nop` 是唯一的非执行节点：为匹配官方序列化信封仍写 `"outputs":{"output":[]}`，但网页连接器列表为空，数组必须保持空；不要给它连边。

**手写最常翻车的 8 件事**：① 漏 `id` 或重复 ② `cfg.pos` 的 `width/height` 用了小默认值导致网页卡片画歪（用 A.3 的尺寸表；执行卡写完跑 `rule layout`，`nop` 自由位置会保留）③ 漏 `cfg.version`/`cfg.name`，或 `cfg.version` 写成小数（**必须是整数**，模板里逻辑/时间卡用 `1`、事件卡用 `0`；非整数 `validate-graph` 直接拒 `卡片配置有误: Invalid cfg.version (须为整数)`）④ 设备卡漏 `cfg.urn` ⑤ 把空 `outputs` 省成 `{}` 或漏掉必填输入 pin → `... failed its strict schema` ⑥ 时长卡漏 `cfg.unit/value` 或与 props 毫秒不一致 ⑦ alarmClock 漏 `happenType/tempOffset` ⑧ 把边写成对象而不是 `"id.pin"` 字符串。

### A.2 整图信封（`rule set --body <file>`）

顶层三个必填 key：

```json
{
  "id": "<规则id>",
  "nodes": [ "<节点>", "<节点>" ],
  "cfg": {
    "id": "<规则id(同上)>",
    "uiType": "test",
    "enable": false,
    "userData": {
      "name": "<规则名>",
      "transform": { "x": 0, "y": 0, "scale": 1, "rotate": 0 },
      "lastUpdateTime": 0,
      "version": 0
    }
  }
}
```

`transform` 是严格四键（x/y/scale/rotate）；`userData.version` 与节点的 `cfg.version` 是两回事。

**`rule set` 是网页「保存」键的等价物，默认 read-merge-write**：对**已存在**的规则，会保留线上的 `enable/uiType/userData`、忽略 body 里的 `cfg`（除非 `--allow-cfg-overwrite`），只刷新时间戳；对**新规则**，body 的 `cfg` 原样写入。所以 `enable` 只在新建时生效——**开关规则一律用 `rule enable`/`rule disable`，别靠改 body**。默认会跑 lint + 卡片校验 + 变量存在性检查（`--no-validate` 跳过）、并落写前快照（`--no-snapshot` 跳过）。

**最小可推实样**（`onLoad → varSetNumber` 写 marker，已离线 `rule validate --body` 零错零警）：

```json
{
  "id": "1700000000000",
  "nodes": [
    { "id": "ol1", "type": "onLoad",
      "cfg": { "pos": {"x":40,"y":40,"width":200,"height":120}, "name":"onLoad", "version":1 },
      "inputs": {}, "outputs": { "output": ["vsn1.input"] }, "props": {} },
    { "id": "vsn1", "type": "varSetNumber",
      "cfg": { "pos": {"x":264,"y":40,"width":740,"height":220,"exprHeight":30}, "name":"varSetNumber", "version":1 },
      "inputs": { "input": null }, "outputs": { "output": [] },
      "props": { "scope":"global", "id":"marker", "elements":[ {"type":"const","value":"1"} ] } }
  ],
  "cfg": {
    "id": "1700000000000", "uiType": "test", "enable": false,
    "userData": { "name":"cold-start marker", "transform":{"x":0,"y":0,"scale":1,"rotate":0}, "lastUpdateTime":0, "version":0 }
  }
}
```

```bash
xgg rule set --body rule.json      # 推整张图（变量 marker 要先 variable create）
xgg rule enable <规则id>            # 单独启用
```

> **有现成规则时不用手写**：`xgg rule view <id> > rule.json` 拿到的就是上面这个 envelope 形状，改完 `xgg rule set --body rule.json` 写回（`rule view` 是规范的 round-trip 读路径；`rule export` 产出的是可复现的**命令脚本/结构**，不是整图 JSON，不能直接喂回 `set`）。
>
> **变量感知 clone：** `rule export <source> --target-id <target>`（或先 `--format json` 再 `rule import --target-id`）只把源规则本地 scope `R<source>` 改成 `R<target>`。导出会读取规则真正引用的本地变量，把导出时的**当前值**连同 type/显示名带进脚本；脚本先只读预检完整变量计划，再以 `expect-absent` 创建空目标规则，确认目标 ID 未被占用后才准备变量并依次写节点、边、enable。已有目标（包括只读预检期间新出现的目标）在任何变量/规则写入前失败且绝不覆盖；已有变量三项完全兼容时保留，任何冲突也在首次写前失败，真实创建还会 fresh check。目标规则预留成功后，`R<target>` 已是在线可识别的规则 scope，实际变量创建与后续节点重放都不需要 `--allow-unknown-scope`；仅在目标尚不存在的只读预检阶段使用该抑制开关。网关无跨变量事务，并发变量修改仍可能让脚本中途停止，可用写前 snapshot 恢复。`global` 只列为明确外部依赖，不创建、不改写；其他 scope 直接拒绝。`source=target` 不会冒充 clone（省略 `--target-id` 才是同 id 重放）。
>
> **`rule export` 的有损点：** `deviceInput`/`deviceGet` 的 `include()` 过滤若 `v1` 是**多值集合**（如 `v1:[1,2,3]`），export 会打印警告——CLI 单个 `--threshold` 只能复现第一个值（`v1[0]`），重放脚本会让成员集合缩水。事件触发的 `arguments` 过滤同理：只有 `=,!=,>,<,>=,<=` 这几个算子能经 `--event-filter` 往返，`between`/`include` 会在导出时被丢弃并打印警告。要保留完整多值集合或这些算子，别用导出脚本重放，改用 `rule view` 的整图 JSON round-trip。

### A.3 25 类执行节点 + `nop` 备注节点 props / inputs / outputs 速查

`cfg.name` = type；`cfg` 按 A.1 家族补全。inputs 值都是 `null`，outputs 值都是边数组（`["目标id.目标pin"]`）。

| type | inputs pin | outputs pin | props 关键字段 |
|---|---|---|---|
| `deviceInput`（属性） | — | `output` | `did, siid, piid, dtype, operator, v1[, v2][, preload]`（见 A.4） |
| `deviceInput`（事件） | — | `output` | `did, siid, eiid[, arguments:[{piid,dtype[,operator,v1]}]]`（`arguments` 可省/空数组 = 匹配该事件的任意取值；与 `deviceInputSetVar` 事件须 ≥1 个不同） |
| `deviceGet` | `input` | `output, output2` | 同 deviceInput 属性（满足走 output，不满足 output2） |
| `deviceOutput`（动作） | `trigger` | `output` | `did, siid, aiid, ins:[{piid,value}\|{piid,scope,id,dtype[,min,max,step]}]`（变量入参 `dtype:number` 必带 `min,max,step`；boolean/string 不带，见 A.4 注） |
| `deviceOutput`（写属性） | `trigger` | `output` | 字面：`did,siid,piid,value`；变量：`did,siid,piid,scope,id,dtype`，且 `dtype:number` 必带 `min,max,step`（缺则校验失败），boolean/string 不带（见 A.4 注） |
| `deviceInputSetVar`（属性） | — | `output` | `did,siid,piid,dtype,scope,id`（属性变化即写入变量；`dtype` ∈ number/boolean/string） |
| `deviceInputSetVar`（事件） | — | `output` | `did,siid,eiid,arguments:[{piid,dtype,scope,id}]`（≥1 个；**每个 arg 的 `dtype` 必填**，漏了被 strict 拒） |
| `deviceGetSetVar` | `input` | `output` | `did,siid,piid,dtype,scope,id`（只有属性模式；需 `input` 触发主动读） |
| `alarmClock`（定时） | — | `output` | `type:"periodicAlarm", isSunset:false, hour,minute,second, filter`；cfg 加 happenType/tempOffset |
| `alarmClock`（日出/日落） | — | `output` | `type:"sunset", isSunset, offset(秒), latitude, longitude, filter` |
| `timeRange` | — | `output` | `start:{hour,minute,second}, end:{...}, filter` |
| `delay` | `input` | `output` | `timeout`（毫秒）；cfg 加 unit/value |
| `statusLast` | `input` | `output` | `timeout`（毫秒）；cfg 加 unit/value |
| `loop` | `start, stop` | `output` | `interval`（毫秒）；cfg 加 unit/value |
| `condition` | `trigger, condition` | `met, unmet` | `{}` |
| `onlyNTimes` | `input, zero` | `output` | `n`（整数≥1） |
| `counter` | `input, zero` | `output` | `n`（整数≥1） |
| `signalOr` | `input0..inputN-1` | `output` | `{}` |
| `logicOr` | `input0..inputN-1` | `output` | `{}` |
| `logicAnd` | `input0..inputN-1` | `output` | `{}` |
| `logicNot` | `input` | `output` | `{}` |
| `onLoad` | — | `output` | `{}` |
| `nop` | — | `output`（必须为空数组，无连接器） | `{}`；`cfg.contents` 是 Quill insert ops，`cfg.background` 是背景色 |
| `eventSequence` | `input1, input2` | `output` | `timeout`（毫秒）；cfg 加 unit/value |
| `register` | `setTrue, setFalse` | `output` | `{}`（无初值字段，初值 false） |
| `modeSwitch` | `input` | `output0..outputN-1` | `{}` |
| `varChange` | — | `output` | `scope,id,varType,preload,operator,v1[,v2]`（见 A.4） |
| `varGet` | `input` | `output, output2` | `scope,id,varType,operator,v1[,v2]`（**无 preload**） |
| `varSetNumber` | `input` | `output` | `scope,id,elements:[...]`（见 A.5） |
| `varSetString` | `input` | `output` | `scope,id,elements:[...]`（见 A.5） |

**卡片尺寸**（`pos` 的 width × height；`rule layout` 自动排执行卡坐标并保留 `nop` 的自由位置）：deviceInput 584×206、deviceGet 700×240、deviceOutput 684×204、deviceInputSetVar 554×206、deviceGetSetVar 566×200、alarmClock 512×152、timeRange 524×152、delay 320×120、statusLast 340×140、condition 320×140、loop 510×160、onlyNTimes 382×160、counter 328×160、signalOr 340×180、logicOr/logicAnd/logicNot 240×120、onLoad 200×120、nop 320×60（可调整）、eventSequence 524×180、register 340×140、modeSwitch 280×160、varChange 532×160、varGet 532×200、varSetNumber 740×220（+exprHeight 30）、varSetString 712×220（+exprHeight 30）。

### A.4 比较算子的 wire 编码（JSON 实样）

第六节按 dtype 讲了能用哪些算子，这里给写进 `props` 的精确编码。**最容易错的一条：设备卡的整型等值用 `include`+数组，变量 number 的等值用 `=`+标量，二者相反。**

```json
{ "dtype":"int",    "operator":"include", "v1":[1] }
{ "dtype":"int",    "operator":">",       "v1":30 }
{ "dtype":"int",    "operator":"between", "v1":20, "v2":30 }
{ "dtype":"float",  "operator":">",       "v1":40 }
{ "dtype":"boolean","operator":"=",       "v1":true }
{ "dtype":"string", "operator":"=",       "v1":"open" }

{ "varType":"number", "operator":"=",       "v1":1 }
{ "varType":"number", "operator":">=",      "v1":3 }
{ "varType":"number", "operator":"between", "v1":1, "v2":5 }
{ "varType":"string", "operator":"=",       "v1":"on" }
```

要点：设备卡整型等值 = `include` + 数组 `v1:[n]`；变量 number 等值 = `"="` + 标量（不是数组）。float 只支持 `> < between`；bool/string 只支持 `=`。`varChange` 的 props 还要带 `"preload": true|false`（变化即比较 / 仅被读时比较），`varGet` 不带 `preload`。shortcut 的 `--op eq/gt/lt/gte/lte/ne/between` 会自动选对 operator 与编码。

> **value-list（枚举）属性的比较 dtype 按 `int` 处理。** 当 MIoT format 是 `float` 但该属性带非空 `value-list`（离散枚举值）时，共享 dtype projector 会把比较 dtype 投影为 `int`。`deviceInput`/`deviceGet` 属性比较因此可用 `eq/ne`（其中 shortcut `eq` 编码为 wire `include` 数组）；`deviceInput` 事件参数过滤则使用 `int` 的标量 `= != > < >= <=` 算子。**非枚举**的连续 float 仍保持 `float`：属性 shortcut 仅支持 `gt lt between`，事件过滤仅支持 `> <`。写变量类卡使用下文的 `number / string` 词表，不使用此比较 dtype。不确定某属性是否带枚举，先 `xgg device spec <did> --pretty` 看它有没有 value-list。

> **两套 dtype 词表别混。** 比较卡（deviceInput/deviceGet 的 `props.dtype`）用 **MIoT 格式**：`int / float / boolean / string`（决定能用哪些算子，见第六节）。而**写变量类卡**（deviceInputSetVar 的属性 `dtype` 与事件 arg 的 `dtype`、deviceGetSetVar 的 `dtype`、deviceOutput 变量入参的 `dtype`）用**变量类型词表**：`number / boolean / string`（**没有 `int`/`float`**——写 `int` 会被 strict schema 拒）。

> **deviceOutput 变量入参的 range（min/max/step）。** `deviceOutput` 的变量引用（动作 `ins` 与写属性两处）当 `dtype` 为 `number` 时**必须**同时带 `min`、`max`、`step` 三个数字字段——缺任意一个会触发 strict schema 的 refine 被拒（网关报 `Invalid max/min/step`，整张图保存失败）。`dtype` 为 `boolean`/`string` 时**不需要**这三个字段（网关正常形状里也不带，照属性自身类型给值即可）。number 的范围取属性 spec 的取值范围：`xgg device spec <did>` 里该 piid 的 value-range / `[min,max,step]`，不确定时用属性自身的合法区间。

> **写 `number` 变量进设备属性/动作入参，目标属性必须自带 `value-range`。** 用 `xgg rule node add` shortcut 写 number 变量时，上面那三个 `min/max/step` 由目标 MIoT 属性的 `value-range` 自动填入（无需手写）。若目标属性没有 `value-range`（`device spec` 里看不到该字段），`node add` 会**快速失败**报 `cannot write a number variable to <目标>: ... the MIoT property declares no value-range`——改用字面 `--value <数值>`，或换一个声明了 `value-range` 的属性。`boolean`/`string` 变量不受此限。

### A.5 几个非平凡卡片的完整实样

**varSetNumber / varSetString 的 elements**（表达式拆成数组；`const` 的 value 永远是字符串，`var` 引用别的变量）：

```json
"props": { "scope":"global", "id":"count",
  "elements": [ {"type":"var","scope":"global","id":"count"}, {"type":"const","value":"+1"} ] }
```

等价于 shortcut `--expr '$global.count + 1'`。字符串卡同构，网关只做拼接、不校验语法；数字卡会本地校验语法，写错回显具体错误（见第八节 / `rule expr-check`）。

**deviceOutput 调用动作**（`ins` 里每个入参可以是字面 `value`，也可以是变量引用 `{piid,scope,id,dtype}`）：

```json
"props": { "did":"<did>", "siid":5, "aiid":1,
  "ins": [ {"piid":1, "value":3}, {"piid":2, "scope":"global", "id":"level", "dtype":"number", "min":1, "max":100, "step":1} ] }
```

**alarmClock 日落**（经纬度必填；`offset` 是秒，负=之前；`filter` 三形：`{}` 每天 / `{"inHoliday":true}` 或 `{"inHoliday":false}` / `{"day":[1,2,3,4,5]}`，星期日=0）：

```json
"props": { "type":"sunset", "isSunset":true, "offset":-1800,
  "latitude":31.2, "longitude":121.4, "filter":{"day":[1,2,3,4,5]} }
```

**modeSwitch / 多输入逻辑卡**（输出/输入是从 0 起的连续记录，至少两个）：

```json
"outputs": { "output0": ["a.trigger"], "output1": ["b.trigger"], "output2": [] }
"inputs":  { "input0": null, "input1": null, "input2": null }
```
