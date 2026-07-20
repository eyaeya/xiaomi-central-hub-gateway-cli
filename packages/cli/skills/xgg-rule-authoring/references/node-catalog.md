# 25 种执行卡片、nop 与 canonical wire

选择卡片、确认每类 flag/default/pin，或审查 raw JSON 时读取本文。本表以固定 Xiaomi Bundle 的 Web 节点和当前 xgg typed model 为准；目标设备参数另见 [device-semantics.md](device-semantics.md)。

## 目录

- [禁止复制 GUIDE 的旧节点 JSON](#禁止复制-guide-的旧节点-json)
- [所有节点的共同 envelope](#所有节点的共同-envelope)
- [完整 pin 表](#完整-pin-表)
- [node add 共同参数](#node-add-共同参数)
- [25+nop 参数总表](#25nop-参数总表)
- [typed access、比较、变量与 output 契约](#typed-access比较变量与-output-契约)
- [逐类 cfg/props wire 键](#逐类-cfgprops-wire-键)
- [时间日期的 canonical 编码](#时间日期的-canonical-编码)
- [变量与表达式 wire](#变量与表达式-wire)
- [raw 整图与 opaque 节点](#raw-整图与-opaque-节点)

## 禁止复制 GUIDE 的旧节点 JSON

`ref/GUIDE.md` 只覆盖 18 类且示例系统性过时；它适合查 RPC 名，不适合生成节点。以下写法必须改成 Bundle canonical：

| GUIDE 旧写法 | canonical wire |
|---|---|
| `type:"timer"` | `type:"alarmClock"` |
| `dtype:"bool"` | `dtype:"boolean"` |
| `operator:"eq"` + `value` | wire operator `= != > < >= <= between include` + `v1[/v2]` |
| `outputs.output=[[node,pin]]` | `outputs.output=["node.pin"]` |
| `deviceOutput.params` | property `value` 或 action `ins[]` |
| `deviceOutput.outputs:{}` | `outputs:{output:[]}`，允许继续串接 |
| `filter:{type,days:[1..7]}` | `{}` / `{inHoliday:boolean}` / `{day:[0..6]}` |
| sunrise/sunset offset 为毫秒 | signed integer minutes |
| duration unit `s|m|h` | raw cfg `ms|s|min|hour`；runtime field 才是毫秒 |

Agent 不得把 GUIDE 示例“微调后试写”。先用 typed shortcut；raw 必须来自当前 `rule view`/export 或本文 canonical schema。

## 所有节点的共同 envelope

已建模执行节点严格六段：

```json
{
  "id": "nCheck",
  "type": "deviceGet",
  "cfg": {
    "name": "deviceGet",
    "version": 1,
    "pos": {"x": 0, "y": 0, "width": 700, "height": 240},
    "urn": "urn:miot-spec-v2:device:...",
    "simplified": false
  },
  "inputs": {"input": null},
  "outputs": {"output": [], "output2": []},
  "props": {"did": "<did>", "siid": 2, "piid": 1, "dtype": "boolean", "operator": "=", "v1": true}
}
```

- `cfg.name` 通常等于 type；`cfg.version` 是整数；`cfg.simplified` 只影响显示。
- `inputs` 声明 pin，以 `null` 占位，不保存入边。
- 边只在源节点 `outputs.<pin>`：JSON endpoint 为 `targetId.targetPin`；CLI endpoint 为 `targetId:targetPin`。
- 每个 target input 最多一条入边；source output 可 fan-out。
- 设备节点 cfg 带当前 spec URN。表达式卡 `pos` 可额外含 `exprHeight`。
- `nop` 序列化 `outputs.output=[]`，但网页/日志没有 connector，禁止连边。

未知未来 type 采用 passthrough，只要求非空 id/type，必须保留所有未知字段。已知节点不能借 UnknownNode fallback 绕过严格 schema；普通流程绝不 `--no-validate`。

## 完整 pin 表

`E`=event，`S`=state/status，`B`=event|state（源侧通配）。

| type/mode | inputs | outputs | 分支语义 |
|---|---|---|---|
| `deviceInput` property | — | `output:B` | notify 比较结果/变化 |
| `deviceInput` event | — | `output:E` | event 匹配 |
| `deviceGet` | `input:E` | `output:E`, `output2:E` | 满足 / 不满足 |
| `deviceOutput` | `trigger:E` | `output:E` | 可串接；Bundle 不证明 success 后才发 |
| `alarmClock` | — | `output:E` | 定时源 |
| `timeRange` | — | `output:B` | 窗口状态；此前目标网关观察到 start event、未见等价 end，其他固件复验 |
| `delay` | `input:E` | `output:E` | 延后 |
| `signalOr` | `input0..N-1:E` | `output:E` | 任一事件 |
| `logicOr` / `logicAnd` | `input0..N-1:S` | `output:B` | 状态 OR / AND |
| `logicNot` | `input:S` | `output:B` | 状态反相 |
| `condition` | `trigger:E`, `condition:S` | `met:E`, `unmet:E` | 触发时满足 / 不满足 |
| `loop` | `start:E`, `stop:E` | `output:E` | 周期输出/停止 |
| `onlyNTimes` | `input:E`, `zero:E` | `output:E` | 前 N 次门 / reset |
| `counter` | `input:E`, `zero:E` | `output:B` | 阈值计数 / reset |
| `modeSwitch` | `input:E` | `output0..N-1:E` | 轮换单一输出 |
| `register` | `setTrue:E`, `setFalse:E` | `output:B` | 图内 latch |
| `eventSequence` | `input1:E`, `input2:E` | `output:E` | input1→input2 |
| `statusLast` | `input:S` | `output:B` | 状态保持 |
| `onLoad` | — | `output:E` | enable/lifecycle source；具体时机需实机 |
| `deviceInputSetVar` | — | `output:E` | 可串接；捕获与 output 的 happens-before 需实机 |
| `deviceGetSetVar` | `input:E` | `output:E` | 可串接；query/写变量与 output 的先后需实机 |
| `varChange` | — | `output:B` | 变量比较 source |
| `varGet` | `input:E` | `output:E`, `output2:E` | 满足 / 不满足 |
| `varSetNumber` / `varSetString` | `input:E` | `output:E` | 可串接；赋值与 output 的先后需实机 |
| `nop` | — | 无 | 仅画布备注 |

`condition.trigger`、`eventSequence.input1/input2` 与全部 `logicAnd.inputN` 是 strict required。`condition.condition` 可不接；XGG static model 将其视为 false。其余 stop/zero/setFalse 等可能是辅助入口，设计者仍要明确是否需要。

## node add 共同参数

每个 executable typed shortcut 都可用：

```text
--rule-id --type --id --pos x,y,width,height[,exprHeight]
--simplified true|false
```

省略 `--id` 时生成 `n` + 32 位小写十六进制 UUID（去掉连字符）；显式新 typed ID 必须是非空 ASCII alphanumeric `[A-Za-z0-9]+`，与固定 Web validator 对齐，不能含 `- _ . :`、空白或 Unicode。为后续 wire 明确传稳定 ID。既有图中的非 canonical ID 要保真观察/导出并报告，不能静默改名，因为所有 source outputs 都引用它。

`--allow-legacy-id` 是窄化的**重放 intent**：只在既有 export 为 modeled typed shortcut 给出非 canonical 显式 ID 时使用。它会拒绝省略 ID、canonical ID、raw `--cfg`、unknown/opaque type；Core SDK 对应 intent 是 `legacyNodeIdReplay:true`。CLI 无法验证一个 noncanonical ID 的 provenance，因此 Agent 还必须自行保证它来自既有图，绝不能拿该 flag 新建 legacy ID。当前 export 会自动输出该 flag，旧 JSON export 在 import/render 时也只为可安全建模的 typed 节点补齐；opaque 节点仍保留完整 raw tuple，不能借此转成近似卡片。

省略 `--pos` 时，XGG 使用当前 per-card editing 尺寸并按已有卡片做紧凑 flow placement；显式值必须是 `x,y,width,height`，仅表达式卡可加第五个 `exprHeight`。省略 `--simplified` 时不写该 cfg marker；显式 true/false 会保留，且只适用于执行卡、不适用于 nop。连接/输出/安全 flags（base-url、session-file、timeout、pretty、snapshots、validation/hints）不属于节点语义。

`--cfg` 选择完整 raw tuple 时，只与 `--type`、可选 `--id` 及 operational flags 配合；不得混入 typed authoring flags。对 typed shortcut 只传下表该行列出的 flags——无关参数必须由 CLI 本地拒绝，不能依赖“当前碰巧被忽略”。

`--allow-unknown-scope` 只允许在下表含变量目标、变量表达式或 `$scope.id` 参数的路由使用；它仅压制非 `global` / 当前 `R<rule-id>` scope 的本地 warning，不能创建变量、证明变量存在或让 strict validation 通过，正常规则不要使用。

## 25+nop 参数总表

表中省略共同 `--rule-id --type --id --pos --simplified`。

| type/mode | 必需 flags | 仅本类型可选 flags、默认与 wire |
|---|---|---|
| `deviceInput` property | `--device-did --device-property` | `--device-siid`; numeric `--op` 默认 `gt`、`--threshold` 默认 0；bool 必须显式 `--threshold 0|1`；string 必须非空 `--property-value`；between 两界显式；另有 `--property-include --force-out-of-range --allow-no-push`; `--preload/--no-preload` 默认 false |
| `deviceInput` event | `--device-did --device-event` | `--device-siid`; repeatable `--event-filter`, `--event-filter-include`, `--event-filter-between`; `--allow-no-push` 仅 runtime probe；raw `arguments:[]` 即 match-any；新卡 canonical `cfg.name:"deviceInput",version:1` |
| `deviceGet` | `--device-did --device-property` | 同 property comparison 的 dtype-specific operand/default；不支持启动预读；`output` 满足，`output2` 不满足 |
| `deviceOutput` property | `--device-did --device-property --value` | `--device-siid`; `$scope.id` 变量，`$$` 转义字面 `$`; raw scope 实验才 `--allow-unknown-scope` |
| `deviceOutput` action | `--device-did --device-action` | `--device-siid`; action.in 非空时 `--params <JSON>` 必须精确覆盖全部 short-name；参数含变量时 raw scope 实验才 `--allow-unknown-scope`; action/property 两模式互斥 |
| `deviceInputSetVar` property | `--device-did --device-property --var-scope --var-id` | `--device-siid`; `--preload/--no-preload` 默认 false；`--allow-no-push` 仅 runtime probe；raw scope 实验才 `--allow-unknown-scope` |
| `deviceInputSetVar` event | `--device-did --device-event` + variable route | `--device-siid`; 1 参数可 scope/id 或一条 `--event-arg-var`; 多参数至少一条 repeatable `--event-arg-var`，可只捕获所需 PIID；0 参数拒绝；两种 route 互斥；`--allow-no-push` 仅 runtime probe；raw scope 实验才 `--allow-unknown-scope` |
| `deviceGetSetVar` | `--device-did --device-property --var-scope --var-id` | `--device-siid`; property-only；raw scope 实验才 `--allow-unknown-scope` |
| `alarmClock` | 恰好一个 `--at HH:MM[:SS]` / `--sunrise` / `--sunset` | `--offset-min` 是 signed integer minutes、默认 0；sun 必需 `--latitude [-90,90]`、`--longitude [-180,180]`; 日期过滤三选一 |
| `timeRange` | `--start HH:MM[:SS] --end HH:MM[:SS]` | `--ming-text-show true|false`; 日期过滤三选一；省略时仅 start>end 派生 true，同日窗口不写该 UI marker |
| `delay` | `--duration <integer><unit>` | unit=`ms|s|min|hour`，typed 也接受 `m|h` 并 canonicalize；值可 0/负数，普通延迟用正数；值与换算毫秒均须 finite integer；非正值只做获授权隔离探针 |
| `statusLast` | `--duration <integer><unit>` | unit 同上，值必须 ≥1，换算毫秒也须 finite integer；runtime timeout 毫秒 |
| `eventSequence` | `--duration <integer><unit>` | unit/范围同 statusLast；固定两个输入 |
| `loop` | `--interval <integer><unit>` | unit 同 delay，值可 0/负数；普通轮询用正数；非正值不得直接启用，研究需隔离探针、硬停止与回滚；runtime interval 毫秒 |
| `signalOr` | — | `--inputs N` 默认 2、整数 ≥2；E inputs |
| `logicOr` / `logicAnd` | — | `--inputs N` 默认 2、整数 ≥2；S inputs，编号连续 |
| `logicNot` / `condition` / `register` / `onLoad` | — | 无 type-specific flag |
| `onlyNTimes` | `--threshold N` | 整数 ≥1；`zero` 是可选控制 pin，仅在业务要开启新计数窗口时连接；没有自动按日 reset，按日需求用 alarmClock→zero |
| `counter` | `--threshold N` | 整数 ≥1；`zero` 是可选控制 pin，仅在业务需要清零时连接；达到阈值的精确 tick/保持需实机 |
| `modeSwitch` | — | `--outputs N` 默认 2、整数 ≥2；pins 必须连续 output0… |
| `varChange` number | `--var-scope --var-id --var-type number` | `--op` 默认 eq，`--threshold` 默认 0；between 必需 threshold2；preload 默认 false；raw scope 实验才 `--allow-unknown-scope` |
| `varChange` string | 同上但 string | 仅 eq，必需 `--var-value`; preload 默认 false；raw scope 实验才 `--allow-unknown-scope` |
| `varGet` number/string | 同 `varChange` | 无 preload；`output` 满足、`output2` 不满足；raw scope 实验才 `--allow-unknown-scope` |
| `varSetNumber` / `varSetString` | `--var-scope --var-id --expr` | `--default-expr-scope` 默认 global；raw scope 实验才 `--allow-unknown-scope`；只有这两类允许 pos.exprHeight |
| `nop` | — | `--text`（规范成 Quill 文档行）/ `--delta '<ops[] 或 {"ops":[]}>'` 互斥；`--background` 默认 `#80CAFF`; pos 只有 4 值；不允许 simplified/executable flags |

设备/变量 operator、event filter、action native types 的完整词汇见 [device-semantics.md](device-semantics.md)。

既有 event-mode `deviceInput` 的整数 `cfg.version:0` 仍可读取/校验；typed export/import 重放会按固定编辑器的一步迁移生成 canonical `version:1`，不要把 `0` 继续复制到新卡。property mode 新卡同样生成 `version:1`。

## typed access、比较、变量与 output 契约

设备卡资格先于值域：`deviceInput` / `deviceInputSetVar` property 必须有 `notify`，`deviceGet` / `deviceGetSetVar` 必须有 `read`，property `deviceOutput` 必须有 `write`；两类 Input 卡的 property/event push source 还要求设备实例 `pushAvailable=true`。`--allow-no-push` 只放行本次 typed add 的设备级 push gate，不持久化、不绕任何 access、不证明会发出；online spec-aware 仍返回 no-push error，strict lint 仍返回同一 source 的 no-push warning/exit 1。常规规则必须 errors=0，所有 warnings 逐项审计、解释并明确接受；只有获明确授权的隔离临时探针，才可把目标 source 的 spec-aware no-push 作为唯一允许的 error，并显式接受同源 lint warning、无物理副作用、取证后立即 disable/delete。strict export 拒绝 access mismatch/no-push；permissive export 只为 no-push 明确 warning 并补 transient flag。

`preload` 只用于 `deviceInput` / `deviceInputSetVar` property 与 `varChange`，默认 false；true 表示 enable 时先查询/评估一次，后续 notify/change 路径不变。它不能制造 notify/read/push。Bundle 对 `onLoad` 只证明无输入 event pin 与 UI“本自动化启用时”标注；此前目标网关安全实测确认 disable→enable 会触发，save/restart/restore 等时机仍未证明。

| MIoT comparison dtype | CLI operator/operand | canonical wire |
|---|---|---|
| `int` property（含非空 value-list 枚举） | `gt lt gte lte eq ne between`; 集合 `--property-include` | property 的 eq 与显式 include 都用 `operator:"include",v1:[...]`；其余标量用 scalar `v1` |
| `int` event argument | scalar `--event-filter PIID<op>V`；集合/范围分别用 `--event-filter-include` / `--event-filter-between` | scalar eq 是 `operator:"=",v1:V`；只有显式 include 才是 `operator:"include",v1:[...]` |
| 连续 `float` | `gt lt between` | 标量/范围 |
| `bool` | `eq --threshold 0|1` | `operator:"=",v1:boolean` |
| `string` | `eq --property-value <S>` | `operator:"=",v1:string` |

`between` 的 lower/upper 都必须显式给出；显式 0 合法。event filter 的 `--event-filter PIID=V`、`--event-filter-include PIID=V,...`、`--event-filter-between PIID=L,U` 可重复，但每个 PIID 只能出现一次；include 只用于 int，between 用于 int/float。整数必须是精确 safe integer，所有数值服从 value-list/range/step。`--force-out-of-range` 仅跳过有效 range 的边界/step 对齐，不绕无效 metadata、value-list、finite/safe-int、operator 或 shape。

网关变量只有 `number|string`。在线 validate 与默认 set/node/edge/layout 写路径按精确 scope+id 和每个可发现的引用路径核对实际类型；node remove 校验删除后的剩余图，SDK `createRule(initial nodes)` 也在首个 setGraph 前门禁，CLI 空图 `rule new` 不增加该预读。`varSetNumber` target/operand 都是 number；`varSetString` target 是 string、operand 可 number|string；capture/output ref 按 dtype。strict export 在 staging 前读取 source 中可发现的 modeled local/global，拒绝 mismatch 或缺 global；opaque `--cfg` 内部引用不在证明范围。permissive 给路径化 warning。`--no-var-check` 只跳在线 inventory，不放宽 scope/schema/spec/enable。

property/action literal 使用 MIoT 原生 JSON 类型。数值 token 必须完整十进制/scientific，float/double 有限，整数精确 safe integer，并服从非空 value-list 与有效 range/step；bool `0|1|true|false` canonicalize 为 boolean。property `--value` 以单个 `$` 开头会被解释为变量 ref，字面 `$` 用 `$$`；action `--params` 只把 `{"$var":"scope.id"}` 对象解释为变量，普通 JSON string 中的 `$` 无需转义。

`deviceOutput` variable ref 仅支持无 `value-list` 字段的 string，或无该字段且有有效 range 的 number。boolean 与任何存在 `value-list` 字段的目标（包括 `[]`）都是 literal-only；动态 boolean 先用 number 0/1 分支，再分别连到 literal false/true output。spec-aware validate 诊断旧 ref，strict export 和默认 enable fail closed；enable 只为实际含 ref 的 URN 取 spec，404/network/schema 失败均先于 enable write。

action `--params` key 必须精确覆盖 `action.in` 的 property short-name；PIID 不重复，distinct PIID 的 short-name 唯一，且 `props.ins[i].piid===action.in[i]`。native type 由 format 决定，只有数值 format 应用数值域；变量用 `{"$var":"scope.id"}`，number ref 要有效 range。permissive export 也必须 warning，并按索引、唯一占位 key 与无原型字典防乱序、重复名和 `__proto__` 静默丢值。

## 逐类 cfg/props wire 键

新 typed 执行卡通常使用 `cfg.name=<type>, version:1, pos[,simplified]`；设备卡再带 `urn`，时长卡再带 UI 的 `unit/value`。下表用于 readback/raw 审查，不替代 typed shortcut：

| type/mode | canonical `props` 或特殊 `cfg` 键 |
|---|---|
| `deviceInput` property | `did,siid,piid,dtype,operator,v1[,v2],preload` |
| `deviceInput` event | `did,siid,eiid,arguments:[{piid,dtype,operator,v1[,v2]}]`；无过滤必须是 `arguments:[]` |
| `deviceGet` | 同 property comparison，无 `preload` |
| `deviceOutput` property | 始终有 `did,siid,piid`，再二选一：literal `value`；或变量 `scope,id,dtype[,min,max,step]` |
| `deviceOutput` action | `did,siid,aiid,ins:[{piid,value}|{piid,scope,id,dtype,...}]` |
| `deviceInputSetVar` property | `did,siid,piid,dtype,scope,id,preload` |
| `deviceInputSetVar` event | `did,siid,eiid,arguments:[{piid,dtype,scope,id}]` |
| `deviceGetSetVar` | `did,siid,piid,dtype,scope,id` |
| `alarmClock` | periodic/sunset fields与 `filter`；完整 shape 见下节 |
| `timeRange` | `start,end,filter[,mingTextShow]`；marker 位于 props，不在 cfg |
| `delay` / `statusLast` / `eventSequence` | `timeout` 毫秒；cfg 保存 canonical `unit/value` |
| `loop` | `interval` 毫秒；cfg 保存 canonical `unit/value` |
| `onlyNTimes` / `counter` | `n` |
| `signalOr` / `logicOr` / `logicAnd` / `logicNot` / `condition` / `onLoad` / `register` / `modeSwitch` | props `{}`；动态数量由连续 input/output pins 表达 |
| `varChange` | `scope,id,varType,preload,operator,v1[,v2]` |
| `varGet` | 同 variable comparison，无 `preload` |
| `varSetNumber` / `varSetString` | `scope,id,elements`；cfg.pos 可含 `exprHeight` |
| `nop` | props `{}`；Quill `contents` 与 `background` 在 cfg；serialized `output:[]` 永远为空 |

literal 与变量 action inputs 按 `action.in` 索引绑定；不能只比较对象 key。已知节点若缺这六段或把字段放错 cfg/props，应由 validate 拒绝；unknown/opaque 节点则必须保留完整扩展 tuple。

## 时间日期的 canonical 编码

日期过滤四种：

```json
{}
{"inHoliday":false}
{"inHoliday":true}
{"day":[0,1,2,3,4,5,6]}
```

分别表示每天、法定工作日、法定节假日、自定义星期（0=周日）。CLI `--weekday-only` / `--holiday-only` / `--days` 最多选一个；自定义至少一天。

`alarmClock` 的实际 type 永远是 `alarmClock`：

```json
{"type":"periodicAlarm","isSunset":false,"hour":7,"minute":30,"second":0,"filter":{}}
{"type":"sunset","isSunset":false,"offset":-30,"latitude":31.2,"longitude":121.4,"filter":{}}
{"type":"sunset","isSunset":true,"offset":15,"latitude":31.2,"longitude":121.4,"filter":{"day":[1,2,3,4,5]}}
```

第二行是日出前 30 分钟，第三行是日落后 15 分钟。`props.offset` 是 signed integer minutes；`cfg.happenType/tempOffset` 只是网页编辑状态。

为保证 raw JSON 重新打开后不漂移，UI marker 必须与 offset 同步：`0 → happenType:"now",tempOffset:0`，负数 → `"before",abs(offset)`，正数 → `"after",abs(offset)`；typed shortcut 会自动生成。

时长节点同时保存 UI 与 runtime：

```json
{"cfg":{"unit":"min","value":5},"props":{"timeout":300000}}
{"cfg":{"unit":"hour","value":1},"props":{"interval":3600000}}
```

typed literal suffix 可用 canonical `ms|s|min|hour` 或别名 `m|h`，新 cfg 只写 canonical unit；runtime 永远是换算后的毫秒，二者必须一致。既有 raw `cfg.unit:"m"` 仅为历史兼容可读/重放，`"h"` 不是合法 raw unit。固定 Bundle validator 对 `delay.timeout` 与 `loop.interval` 只要求整数，允许 0/负数；`statusLast.timeout` 与 `eventSequence.timeout` 则必须大于 0。前者是可表达/可保存能力，不等于 Bundle 证明了非正值的 executor 行为。disabled 规则只能证明保存；真正研究必须获明确授权，使用隔离临时规则、无物理副作用 marker、外部超时/硬停止、日志与回滚，尤其非正 `loop` 要防事件风暴。普通规则仍用正值。

## 变量与表达式 wire

number `varChange` / `varGet` 的完整 CLI operator 是 `eq|ne|gt|lt|gte|lte|between`，wire 分别为 `=|!=|>|<|>=|<=|between`；`between` 必须同时显式给 `--threshold` 与 `--threshold2`。string 只允许 `eq --var-value <S>`；反相用 `logicNot`（持续状态）或 `varGet.output2`（触发式查询）。number 非-between 未传 `--threshold` 的历史默认是 0，但 Agent 应显式写业务阈值。

number/string comparison：

```json
{"scope":"global","id":"mode","varType":"number","operator":">=","v1":3,"preload":false}
{"scope":"global","id":"mode","varType":"number","operator":"between","v1":1,"v2":5}
{"scope":"global","id":"label","varType":"string","operator":"=","v1":"home"}
```

表达式 elements：

```json
{"scope":"global","id":"count","elements":[
  {"type":"var","scope":"global","id":"count"},
  {"type":"const","value":" + 1"}
]}
```

`varSetNumber` 对拼接结果运行数值 parser；`varSetString` 只拼接。完整 DSL 与函数见 [operations.md](operations.md)。

## raw 整图与 opaque 节点

规则 body：

```json
{
  "id":"1700000000000",
  "nodes":[],
  "cfg":{
    "id":"1700000000000",
    "uiType":"test",
    "enable":false,
    "userData":{
      "name":"规则名",
      "transform":{"x":0,"y":0,"scale":1,"rotate":0},
      "lastUpdateTime":0,
      "version":0
    }
  }
}
```

默认 `rule view` machine envelope 是 `{ok:true,id,cfg,nodes}`；该命令没有 lifecycle `nextSteps`，也不接受 `--no-next-hint`。`--nodes-only` 和 `rule get` 缺 cfg，不能当完整 body。raw 工作流：

```bash
xgg rule view <rid> > ./graph.json
xgg rule validate --body ./graph.json
xgg rule set --body ./graph.json
```

已有规则的 set 默认保留 live enable/uiType/userData 并更新时间；只有明确的 clone/staging/恢复流程才 `--allow-cfg-overwrite`。启停始终用 enable/disable。

未建模未来卡片要从 view/export 捕获完整节点，用 `rule node add --type <future> --cfg '<full tuple>'` 同 ID 保真。strict export 在 clone 无法保留 opaque 语义时必须拒绝；不要把 unknown 节点套进最近似的已知 schema。
