# MIoT 设备语义与参数词汇

设计任何设备卡片、解释 spec 枚举、构造事件参数过滤或 action 输入时读取本文。设备 short-name、SIID/PIID/EIID/AIID、访问权限和值域必须来自**目标网关当前 `device spec`**；当前 xgg schema 只描述节点结构与值编码，不能替代某台设备的 live spec。

## 目录

- [先选对设备卡](#先选对设备卡)
- [如何从 spec 取参数](#如何从-spec-取参数)
- [中文语义到 raw wire](#中文语义到-raw-wire)
- [属性比较的完整词汇](#属性比较的完整词汇)
- [事件与事件参数](#事件与事件参数)
- [设备输出与 action 输入](#设备输出与-action-输入)
- [设备值写入变量](#设备值写入变量)
- [分区与替换](#分区与替换)
- [设备卡检查表](#设备卡检查表)

## 先选对设备卡

| 意图 | 卡片 | 何时运行 | 分支/结果 |
|---|---|---|---|
| 订阅属性变化并比较 | `deviceInput` property mode | property notify；可选 enable 时 preload | `output` 同时可作 event/state |
| 订阅设备事件 | `deviceInput` event mode | event 到达 | `output` event |
| 被上游触发后主动读属性并比较 | `deviceGet` | `input` event | 满足走 `output`，否则 `output2` |
| 写属性或调用 action | `deviceOutput` | `trigger` event | `output` 可串接；是否在成功后发需看日志 |
| 属性 notify 时写变量 | `deviceInputSetVar` property mode | notify；可选 preload | `output` 可串接；变量先后需实机证明 |
| 设备事件参数写变量 | `deviceInputSetVar` event mode | 带参数的 event | `output` 可串接；变量先后需实机证明 |
| 被触发后读属性写变量 | `deviceGetSetVar` | `input` event | `output` 可串接；读写完成时机需实机证明 |

“当前状态是否满足”与“触发瞬间查询一次”不是同一需求。前者用持续 source/state，后者用 `deviceGet`。设备不推送 property 时，不要期待 property-mode `deviceInput` 可靠触发；若该 property 有 `read`，可由可靠 event/alarm/loop 驱动 `deviceGet` 做分支，或用 `deviceGetSetVar` 捕获当前值；没有 read 就没有通用主动查询降级。no-push event 的瞬时参数、次数与顺序不能由 `deviceGet` 重建：改用业务等价的可靠 event source；只有需求本质是“采样当前状态”、且存在等价 readable property 时才重设计为查询，否则明确判定当前设备/固件无法可靠实现。

`deviceInput` / `deviceInputSetVar` 的 property 与 event 都是 push source，目标设备实例必须 `pushAvailable=true`；property 还必须有 `notify`。设备报告 `pushAvailable=true` 且 property 有 `notify` 时，直接使用正常 push source，日志属于运行验收而不是 author 前置条件。`--allow-no-push` 只允许**本次 typed node add** 越过设备级 push gate；它不持久化、不绕过 notify/read/write，也不会凭空让属性/event 产生上报。在线 spec-aware 会保留 no-push error，strict lint 会保留同一 source 的 no-push warning/exit 1；只有用户明确授权的隔离临时探针，才可把目标 source 的 spec-aware no-push 作为唯一允许的 error，并显式接受同源 lint warning。其他 errors 为零，其他 warnings 仍逐项审计；图必须无物理副作用且测试后立即 disable/delete。若探针日志仍不能证明 push，按上一段区分 property 查询降级与 event 不可重建边界，不能把无日志当成能力证明。

## 如何从 spec 取参数

```bash
xgg device list --pretty
xgg device get <did> --pretty
xgg device spec <did> --pretty
```

对目标 service/property/event/action 记录：

```text
DID | spec URN | service short-name + siid |
property short-name + piid + format + access + value-list/value-range |
event short-name + eiid + arguments[] |
action short-name + aiid + in[]/out[]
```

- CLI 接受 URN 第四段 short-name，例如 `occupancy-status`，不接受 UI 中文名。
- 同一 short-name 出现在多个 service 时，必须加 `--device-siid <N>`；不要让“第一个匹配”代替业务选择。
- property `deviceInput` / `deviceInputSetVar` 要 `notify`，`deviceGet` / `deviceGetSetVar` 要 `read`，property `deviceOutput` 要 `write`；两类 push source 的 property/event 还要设备 `pushAvailable=true`。
- `value-list` 是闭集枚举：`value` 是 wire 数值，description/本地化 label 是语义。Agent 应向用户解释 label，但命令仍传数值。
- `value-range` 固定解释为 `[min,max,step]`，三个值都必须有限、`min <= max`、`step > 0`。
- ghost device 默认不列出，也不应作为输出目标。只有盘点差异时才 `--include-ghost`。

## 中文语义到 raw wire

`device list/get/spec --pretty` 的中文是给人理解的 projector，不是新的 wire vocabulary。Agent 应把 label 讲给用户，同时在命令/JSON 中继续传 raw short-name、SIID/PIID/EIID/AIID 和枚举 `value`。当前 projector 的精确 fallback 是：

| 对象 | 中文/语义来源优先级 | wire 仍使用 |
|---|---|---|
| 设备品类 | 公共 `device-template` 的 `zh_cn` → URN 派生 raw device-type token | raw device-type/URN；不得回退 `modelName` 或产品描述冒充品类 |
| value-list 值 | `multiLanguage` → normalization → spec instance 的 `entry.description` | 枚举原生 `value` |
| service/property/event | `multiLanguage` → template → spec instance 的 `.description` | URN raw short-name + 对应 SIID/PIID/EIID |
| action | `multiLanguage` → 非空 instance `.description` → template → raw instance description | URN raw action short-name + AIID |
| action input property | `multiLanguage` → spec instance property `.description`（不走 property template） | URN raw property short-name + PIID |

这里的 “raw description” 是目标 spec 实例提供的显示文本，**不是** wire short-name 或枚举数值。目录/spec/projector 失败时必须向用户标出 fallback metadata，不能把 raw description 再猜译。跨 service 重复 short-name 必须保留各自 SIID，不能因中文相同而合并。省略 `--pretty` 的 machine JSON 保持原始 shape，不应为语义显示额外请求目录。

## 属性比较的完整词汇

CLI operator 与网关 wire 不同：

| 投影 dtype | CLI `--op` / literal | 实际 wire | 语义 |
|---|---|---|---|
| `int` | `eq` | `operator:"include", v1:[N]` | 等于枚举/整数 N |
| `int` | `ne gt lt gte lte` | `!= > < >= <=` + scalar `v1` | 不等/大小比较 |
| `int` | `between --threshold A --threshold2 B` | `between`, `v1:A,v2:B` | 闭区间意图；要求 `A <= B` |
| `int` | `--property-include A,B,...` | `include`, `v1:[...]` | 集合成员，顺序保留 |
| continuous `float` | `gt lt between` | `> < between` | 不支持 eq/ne/gte/lte |
| `boolean` | `eq --threshold 0|1` | `=`, scalar boolean | false/true |
| `string` | `eq --property-value S` | `=`, scalar string | 字符串相等 |

投影规则：MIoT `float` 若有非空 `value-list`，按离散 `int` 比较；真正连续 float 才使用 float 方言；`bool → boolean`、`string → string`，其他整数宽度和未知数值 format 都投影为 `int`。

数值 operand 还必须满足：

1. 数值有限；int 必须是 JavaScript safe integer。
2. 非空 `value-list` 是闭集，operand 必须在其中。
3. 有 `value-range` 时必须落在 min/max 且从 min 起按 step 对齐。
4. `--force-out-of-range` 只允许 property comparison 跳过**有效 range**的边界/step；不能绕过 malformed range、value-list、非有限值、operator 或 operand shape。

`between` 两个边界都必须显式给出。非-between 数值比较未传 threshold 时存在历史默认 0，但 Agent 不应依赖隐式值；把业务 operand 明写出来。

## 事件与事件参数

普通 trigger-only event：

```bash
xgg rule node add --rule-id <rid> --type deviceInput \
  --device-did <did> --device-siid <siid> --device-event <event>
```

事件参数来自该 event 的 `arguments:[piid,...]`，每个 PIID 必须能在同一 service 的 properties 找到 format。过滤三种：

```bash
--event-filter '1=1'                 # scalar；也支持 != > < >= <=，受 dtype 限制
--event-filter-include '2=1,2,3'     # 仅 int
--event-filter-between '3=18.5,26.5' # int/float
```

- 三种 flag 都可重复，但同一 PIID 跨三类只能出现一次。
- scalar：boolean/string 只允许 `=`；continuous float 只允许 `>`/`<`；int 允许 `= != > < >= <=`。
- include 与 between 仍校验 value-list/range/step。
- 不加过滤时 `arguments:[]` 表示 event 到达即匹配；不要省略该数组。

把 event 参数写变量用 `deviceInputSetVar`：

```bash
--event-arg-var 1=global.lockOp
--event-arg-var 3=global.lockMethod
```

0 参数事件不能使用此卡，因为没有可捕获值，改用 `deviceInput`。单参数事件可用 `--var-scope/--var-id`；多参数至少给一条 repeatable `--event-arg-var`，可以只映射业务需要的 PIID，也可以全部捕获；两种写法互斥。事件未列出的 PIID、重复 PIID、找不到 backing property 都应停止，而不是猜 dtype。

`deviceInputSetVar` event 负责捕获，不接受 `--event-filter*`。若同一参数既要决定“只响应解锁”等枚举，又要保存给下游，正确图是：

```text
deviceInputSetVar(event capture).output
  → varGet(captured discriminator).input
  → varGet.output
  → business event consumer
```

不要给 capture 卡塞 filter，也不要并行放一张 filtered `deviceInput` 后假定两条 source 无竞态。首次运行必须用变量 readback + node/edge 日志证明 capture 在 output/varGet 前完成；否则该 happens-before 仍是未证实项。

## 设备输出与 action 输入

### 写 property

```bash
xgg rule node add --rule-id <rid> --type deviceOutput \
  --device-did <did> --device-property <property> --value <literal>
```

- bool literal 接受 `true|false|0|1`，规范 wire 为 JSON boolean。
- property/action string literal 必须非空；非空值保留原字符串。property 字面量若以 `$` 开头，用 `$$` 转义一个 `$`；action 普通 JSON string 不需要该转义。
- float 必须有限；整数必须为可解析整数并满足目标域。
- 单个 `$scope.id` 表示变量引用，wire 为 `scope,id,dtype`，不是字符串 literal；先读取同 scope/id 的实际在线类型并核对引用路径。
- output ref 只支持无 `value-list` 字段的 string，或无该字段且有有效 value-range 的 number；boolean 与任何存在 `value-list` 字段的目标（包括 `[]`）都是 literal-only。
- 动态 boolean 必须先把 number 0/1 查询/状态分支，再分别连接两个 literal `false` / `true` output；不能声明不存在的 bool 变量。

### 调 action

```bash
xgg rule node add --rule-id <rid> --type deviceOutput \
  --device-did <did> --device-action <action> \
  --params '{"text-content":"hello","volume":50}'
```

`--params` 的 key 是 `action.in` 各 PIID 对应 property 的 short-name，且必须**恰好**覆盖全部 inputs：不能缺、不能多。持久化 `props.ins[i].piid` 按 `action.in[i]` 顺序绑定；`action.out` 只是输出声明，不是可传参数。

literal 的 JSON 类型由 backing property format 决定：bool/string 不因错误的 numeric value-list 而变成数字；integer formats 必须 safe integer；float/double 必须有限；数值仍受 value-list/range/step 约束。action input 的 boolean 与任何存在 `value-list` 字段的目标（包括 `[]`）同样 literal-only；变量 ref 只允许无 `value-list` 字段的 string，或无该字段且有有效 range 的 number。变量参数写为：

```json
{"text-content":{"$var":"global.message"}}
```

重复 action input PIID，或不同 PIID 映射成同一 short-name 时，JSON object 无法无歧义表达，typed authoring 必须拒绝；不要改用猜测的顺序绕过。持久化后还要核对每个 `props.ins[i].piid === action.in[i]`，不能只比较 params object 的 keys；`__proto__` 等键也不能因普通对象原型而静默丢失。

## 设备值写入变量

网关变量类型只有 `number|string`：

- property/event arg format `string` → string 变量；其他 format（包括 bool）→ number 变量，bool 值按 0/1 表达。
- `deviceInputSetVar` property mode 与 `deviceInput` 一样可 `--preload`：enable 时先查询一次；默认/`--no-preload` 只跳过首次查询，不关闭后续 notify。
- `deviceGetSetVar` 是 event-triggered pull，只支持 property，不支持 event。
- scope/id 均为非空 `[A-Za-z0-9]+`；常用 scope 是 `global` 或当前规则 `R<rid>`。
- 创建卡片前先创建并按每个可发现的 modeled 引用路径核对实际类型；普通流程不要用 `--no-var-check`。默认在线 graph 写与 node remove 都会检查修改后剩余图中可发现的 modeled 引用，SDK `createRule(initial nodes)` 也会在第一次写图前做同类检查；opaque/future payload 不在证明范围。`--no-var-check` 只跳在线 inventory，不放宽 scope/schema/spec/enable。
- strict export 在 staging 前读取源网关可发现的 modeled local/global 变量并拒绝实际类型 mismatch 或缺失 global；opaque `--cfg` 内部引用不在该证明范围。permissive export 只能给路径化 warning，不能把不匹配说成已证明可重放。

## 分区与替换

`xgg device partitions <did> --pretty` 只对已明确支持的型号映射 A-1…B-16，不是通用 service 发现。其他设备用 spec 的 service description/SIID。

替换已有五类设备卡前先 dry-run：

```bash
xgg rule device replacements --rule-id <rid> --node-id <nid> --pretty
xgg rule device replacements --rule-id <rid> --node-id <nid> \
  --target-did <did> [--target-siid <N>] \
  [--target-piid <N> | --target-eiid <N> | --target-aiid <N>] --pretty
```

兼容性比较 URN 前五段、dtype、range/list、event arguments 或 action inputs。property/event/action 分别用 `--target-piid` / `--target-eiid` / `--target-aiid` 消歧，三者互斥；任何 capability selector（包括 `--target-siid`）都必须和 `--target-did` 一起使用。只有用户确认候选后，才把 dry-run 的同一 DID/SIID/PIID|EIID|AIID selector 原样传给 `device replace ... --apply --confirm-target-did ...`；apply 会按该 selector 重新规划并复核，写路径必须有 rollback snapshot。不要把 ghost 的诊断候选当作可应用计划。

## 设备卡检查表

1. 选择的是订阅、事件、主动查询、写属性、调 action，还是捕获到变量？
2. short-name/SIID/PIID/EIID/AIID 是否来自目标网关当前 spec？
3. 同名 service 是否已用 `--device-siid` 消歧？
4. operator、literal JSON 类型、枚举 label/value 与 range/step 是否一致？
5. event argument PIID、action.in 顺序及 params keys 是否完整且无重复？
6. property notify 是否可用；若不可用，哪个 event 驱动 `deviceGet`？
7. 写入变量的 type/scope/id 是否已存在并匹配？
8. 写后是否执行 `validate --spec-aware`、strict lint、readback，并在授权触发后检查日志/动作结果？
