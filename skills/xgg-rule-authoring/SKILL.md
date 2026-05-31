---
name: xgg-rule-authoring
description: Use when an LLM Agent needs to operate a Xiaomi Gateway Geek Edition (中枢网关极客版) through the xgg CLI — login, device discovery, authoring/validating/enabling automation rule graphs, the 25 node cards, variables, expressions, snapshots, logs, and backups.
---

# xgg 自动化编写 Skill

## 目标

用 `xgg` CLI 把用户的自然语言需求变成小米中枢网关极客版的自动化。网关里的每个自动化是一张**有向图**：节点是卡片，边是「某节点的输出 pin → 另一节点的输入 pin」。Agent 的任务不是「把命令跑到返回 ok」，而是「按需求选对卡片、查清参数、连对 pin、静态校验、启用，并用日志或变量读数证明它真的运行」。

> 本 Skill 里的所有命令形态与自动化模板，均已在真实网关上 `validate` + `lint` 全清并（可运行的部分）跑通验证。把它当事实来源；和 `--help` 冲突时以 `--help` 的**参数名**为准，和官方网关行为冲突时以网关为准。

## 一、必须遵守的 CLI 操作规范

1. **会话失效就停手要码。** 出现 `AUTH_REQUIRED` / `AUTH_EXPIRED`，或写命令退出码 `3` 时，立即停止当前写操作，向用户索取一个新的 6 位登录码，再执行（登录码由用户在网关网页控制台获取，是一次性的）：

   ```bash
   xgg login --code <6位登录码> --base-url http://<gateway-ip>:8086
   ```

   登录会绑定一个常驻 agent 守护进程（约 60 分钟空闲后自毁并清空会话）。`xgg status` 看 `live` 与 `idleMsRemaining`。

2. **Agent 写操作启用快照目录。** 这样每次写前都会把网关全量状态落盘，便于回溯：

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

## 二、固定工作流

```bash
xgg status
xgg device list --pretty
xgg device spec <did> --pretty

xgg rule new --name "<规则名>"                                   # 返回 rule id
xgg rule node add --rule-id <rid> --type <node-type> ...        # 每张卡片一条
xgg rule edge add --rule-id <rid> --from <node:pin> --to <node:pin>
xgg rule layout <rid>                                           # 连完线跑一次，按数据流分层布局
xgg rule validate --rule-id <rid>                               # 卡片配置 + 变量存在/scope（一次列全部问题）
xgg rule lint --rule-id <rid> --strict                          # 边拓扑 + pin 颜色（再叠加保存键校验）
xgg rule enable <rid>                                           # 启用（自带保存键级预检，会兜底拦截）
xgg rule logs <rid> --tail 20                                   # 触发后看日志
```

关键点：

- `rule new` 只创建空规则 envelope；每张卡片用 `rule node add` 加。默认 rule id 是无连字符的数字串。
- `rule node add --id <node-id>` 给节点稳定命名，后续连线更安全；不指定则随机。
- 连线用 `<node-id>:<pin>`，例如 `n-click:output` → `n-light-on:trigger`。
- `rule layout` 只改网页画布坐标、不改逻辑：触发器/源在左，每个节点严格排在其所有输入右侧，分支纵向堆叠，相互独立的子自动化各占一条横带。网页 UI 自己不做自动布局，所以这步是让 CLI 创建的规则在网页里可读的关键。
- `rule enable` 返回成功只代表启用完成，**不代表触发成功**；触发后必须看 `rule logs`。

### 三层校验——分清哪条命令抓哪类问题

| 层 | 命令 | 抓什么 | 写入时是否自动跑 |
|---|---|---|---|
| 卡片配置 + 变量存在/scope | `rule validate`（dry-run，不写） | 卡片字段非法、`卡片变量丢失`、`卡片变量有误`（scope 既非 `global` 也非 `R<本规则id>`） | `rule set` / `rule enable` 默认跑（违规抛 `ConfigError` 退出 5，`error.details.issues` 列出每个问题卡片）；增量 `node add` 不自动跑变量清单检查 |
| 边拓扑 + pin 颜色 | `rule lint`（`--strict` 再叠加上面那层） | 断边、空边、自环、重复边、event↔state cross-color 死线 | **否**——网关 `setGraph` 接受这些，lint 只在读时报。但 `rule edge add` 自己会在写时拦 cross-color（见下） |

启用前**两条都跑**看全量问题：`rule validate --rule-id <id>` 和 `rule lint --rule-id <id> --strict`。`rule enable` 的内建预检是兜底，不是「看全问题」的替代（它的 `error.message` 只报第一个，`details.issues` 才有全部）。

## 三、如何获取卡片参数

优先级从高到低：

1. **设备参数：** `xgg device spec <did> --pretty`。从 `Properties` 选 `--device-property`，`Actions` 选 `--device-action`，`Events` 选 `--device-event`。
2. **CLI shortcut 参数：** `xgg rule node add --help`。这是各卡片**参数名**的当前事实来源。注意：`--help` 里 `eventSequence` 的示例仍展示老的 `--cfg` 路径，但 `eventSequence` / `register` / `modeSwitch` **都已有 shortcut**（`--type eventSequence --duration 5s`、`--type register`、`--type modeSwitch --outputs N`）——优先用 shortcut，不要被那个示例带去 `--cfg`。
3. **学已有规则：** `xgg rule view <id> --pretty` 看节点 `props/inputs/outputs`；`xgg rule export <id> --format shell` 反译成可复现的 CLI 命令。
4. **没有 shortcut 或要复刻复杂 UI 卡片时才用 `--cfg`。** `--cfg` 必须是完整四段，只给内层 `cfg` 会被网关拒（`Invalid props`）：

   ```json
   {
     "cfg": {"pos": {"x": 100, "y": 100, "width": 240, "height": 120}, "name": "<type>", "version": 1},
     "inputs": {},
     "outputs": {"output": []},
     "props": {}
   }
   ```

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

### 权威 pin 表（25 类，输出标注颜色）

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

## 五、25 种卡片速查

| 类型 | 作用 | 常用 CLI 形态 | 备注 |
|---|---|---|---|
| `deviceInput` | 设备属性变化(状态)或设备事件(事件)触发 | 属性：`--device-did <did> --device-property <p> --op <op> --threshold <n>`；事件：`--device-event <e> [--event-filter <piid>=<v1>]` | 属性模式监听 push notify，`pushAvailable=false` 设备收不到（用 `deviceGet` 代替）；事件模式不受影响 |
| `deviceGet` | 输入事件到来时读设备属性并分支 | `--device-did <did> --device-property <p> --op <op> --threshold <n>` | 满足 `output`，不满足 `output2` |
| `deviceOutput` | 写设备属性或调用设备动作 | 属性：`--device-property <p> --value <v>`；动作：`--device-action <a> --params '<json>'` | bool 属性 `--value true/false` 均可 |
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
| `string` | 仅 `eq` | `operator:"include"` + 字符串数组 |

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
xgg variable watch --pretty                       # 实时观察变量变化
```

硬约束（均经网关验证）：

- **类型只有 `number` 和 `string`，没有 boolean。** `--type boolean` 会被拒。开关状态用 `number` 的 `1/0` 或 `string` 的 `"on"/"off"`。
- **变量 id 和 scope 名都必须是纯字母数字** `[A-Za-z0-9]`，下划线/连字符/点/空格会被拒（`id/scope must be alphanumeric`）。
- **scope 三种可见性：**
  - `global`：全局，网页主页面「全局变量」可见，适合跨规则共享（在家模式、最后一次按钮动作、温度缓存等）。
  - `R<规则id>`：**规则内变量**，在该规则编辑页「本规则变量」可见，校验器接受。`rule new` 会自动 bootstrap 本规则的 `R<id>` scope。引用错 scope 会报 `卡片变量有误: <scope> is neither "global" nor "R<本规则id>"`。**因为 scope 必须是纯字母数字，要用规则内变量就让规则 id 保持纯字母数字（默认就是数字串，OK）。**
  - 其他任意串：**ghost data**——网关存，但网页任何地方都不显示、规则也可能永不触发。不要用。
- **关于 ghost 警告：** CLI 对「非 `global`」的 scope 一律打印一条 `not in the web-UI-known set {global}` 的警告——**这条警告对合法的 `R<规则id>` 也会打，是已知的过宽警告**，R-scope 本身合法。确实要用非 global scope 时加 `--allow-unknown-scope` 静音。
- 若用户明确说「不要用变量」，就别 `variable create`、别 `varChange/varGet/varSet*`。优先用 `deviceGet` 读真实设备状态；设备无可读状态时再问是否允许用 `register` 这种图内状态卡片。

## 八、表达式（`varSetNumber` / `varSetString` 的 `--expr`）

`--expr` 把你写的表达式拆成网关的 `elements` 数组。语法：

| 写法 | 含义 |
|---|---|
| `$id` | 变量引用，默认 scope（`global`，或 `--default-expr-scope` 指定） |
| `$scope.id` | 限定 scope 的变量引用 |
| `$$` | 字面量 `$` |
| 其余 | 字面文本（函数、运算符、中文都算） |

**永远用单引号包 `--expr`**，否则 shell 会把 `$id` 当成 shell 变量展开。

- `varSetNumber`：把拼好的串当**数字表达式**求值。支持 `+ - * / %`、括号、逗号参数，以及函数库：
  `abs pow log sin cos tan asin acos atan max min round floor ceil rand randint now year month date day hours minutes seconds pi e`。
  **无参函数也要带括号**（`rand()` 不是 `rand`，否则被当变量名）；逗号用 ASCII `,`；`day()` 周日=0（不是 ISO 周一=1）；`now()` 是毫秒 epoch；`rand()` ∈ [0,1)。
- `varSetString`：纯字符串拼接，无语法检查；中文/UTF-8 正常；总长上限 512 字节。

例：`--expr '$global.count + 1'`（自增）、`--expr 'round($global.brightness65535 / 655.35)'`（65535→百分比）、`--expr 'randint(1, 16777215)'`（随机颜色）、`--expr '现在温度 $global.temp 度'`（字符串）。

> CLI **不**在本地校验数字表达式语法，写错（如 `flor(x)`）会在运行时失败——去 `rule logs` 看 eval 报错。

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
4. 可由 Agent 自触发的（`onLoad` / `loop`）：`rule disable` 再 `rule enable` 即可重放 `onLoad`，然后读日志或变量。物理触发的（按钮、门锁、人体传感器）要请用户实际触发后再看日志。
5. 网页显示「变量已丢失」但 CLI 里变量存在时，先让用户**刷新网页**，不要立刻重写规则（见规范 7）。

## 十二、备份（网关云备份）

```bash
xgg backup list --from fds --pretty             # 列云备份
xgg backup create --from fds --name "<名字>"     # 网关会给名字追加 .bak 后缀
xgg backup download <id> --from fds             # generate/load 前必须先 download
```

`--from fds` 指小米云存储。Agent 模式同样受快照目录约束。

## 十三、常见踩坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `rule enable` 成功但动作没发生 | 只证明启用，未证明触发 | 触发后查 `rule logs` |
| 网页看不到 CLI 新建的变量/规则，或卡片显示「变量已丢失」 | 网页 SPA 缓存未刷新（CLI 写不广播） | 让用户 F5 刷新；先按规范 7 三步诊断 |
| `cross-color edge: event output → state input` (exit 5) | 把纯事件接进了状态输入 | 事件接事件输入；状态合并用 `logicOr/logicAnd`，事件合并用 `signalOr` |
| `fan-in cap ... 一个输入节点只能连一条线` | 一个输入 pin 接了多条入边 | 先过 `signalOr`/`logicOr`/`logicAnd` 再汇入 |
| `卡片变量有误: <scope> is neither global nor R<id>` | 引用了非法 scope（常见：复制规则后还指向源规则的 `R<旧id>`） | 改 `--var-scope global` 或当前规则的 `R<本规则id>`，或在新规则 scope 下重建变量 |
| `卡片变量丢失` | 变量不存在/被删 | 先 `xgg variable create` |
| `--type boolean ... not a valid gateway variable type` | 变量类型只有 number/string | 开关用 number 1/0 或 string on/off |
| `id/scope must be alphanumeric` | 变量 id/scope 含非字母数字 | 去掉 `_ - .` 等 |
| `float property only supports --op gt\|lt\|between` | float 属性不支持 gte/lte/eq/ne | 改 `gt/lt/between`，或换思路（如 `logicNot` 取反表达 `≤`） |
| bool 属性比较不触发 | bool 只能 `eq`，threshold 必须 0/1 | `--op eq --threshold 1`(真) 或 `0`(假) |
| 设备属性触发不触发 | 设备 `pushAvailable=false`，property notify 收不到 | 改用 `deviceGet` 在事件到来时主动读 |
| 目标设备命令超时 `-9999` | ghost device 或设备不可达 | 换非 ghost 设备，查 `device list` 的可用性 |
| `varSetNumber` 运行时 eval 报错 | 表达式语法写错（CLI 不本地校验） | 看 `rule logs`，修表达式；无参函数记得带括号 |

## 十四、收尾标准

向用户汇报完成前，至少：

```bash
xgg rule layout <rid>
xgg rule validate --rule-id <rid>
xgg rule lint --rule-id <rid> --strict
xgg rule enable <rid>
xgg rule logs <rid> --tail 20
```

能由 Agent 自主触发的（`onLoad`/`loop`，或可安全驱动的设备）就触发并读日志/变量证明运行；不能的（物理按钮、传感器）明确告诉用户需要其物理触发，并在用户触发后再读日志确认。最后提醒用户：CLI 的改动需要在网关网页 **F5 刷新**才能看到。
