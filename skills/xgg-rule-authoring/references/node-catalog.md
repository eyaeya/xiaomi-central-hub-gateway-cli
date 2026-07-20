# xgg 节点与 wire 速查

需要选择卡片、确认 pin 颜色、手写 raw JSON 或审计 export 时读取本文。优先使用 `xgg rule node add --help` 的 shortcut；只有 shortcut 覆盖不到或必须原子写整图时才手写 JSON。

## 目录

- [连线与 pin 颜色](#连线与-pin-颜色)
- [25 种执行卡片与 nop](#25-种执行卡片与-nop)
- [typed 比较与 action 参数](#typed-比较与-action-参数)
- [整图与节点 JSON](#整图与节点-json)
- [逐类 props 速查](#逐类-props-速查)
- [非平凡 wire 实样](#非平凡-wire-实样)

## 连线与 pin 颜色

pin 颜色有 event、state、event|state。只有源输出可以是 event|state 通配；纯 event 输出不能接 state 输入。每个输入 pin 的 fan-in 上限为 1，多事件先过 `signalOr`，多状态先过 `logicOr` / `logicAnd`。

同节点反馈边合法，lint 只给 warning；保留 warning 并验证反馈终止。`loop.output → loop.stop` 是已实测的有限反馈。

| 类型 | 输入 pin | 输出 pin |
|---|---|---|
| `deviceInput` | — | 属性模式 `output` event|state；事件模式 event |
| `deviceGet` | `input` event | `output` / `output2` event |
| `deviceOutput` | `trigger` event | `output` event |
| `alarmClock` | — | `output` event |
| `timeRange` | — | `output` event|state（窗口进入事件 + 窗口状态） |
| `delay` | `input` event | `output` event |
| `statusLast` | `input` state | `output` event|state |
| `condition` | `trigger` event；`condition` state | `met` / `unmet` event |
| `loop` | `start` / `stop` event | `output` event |
| `onlyNTimes` | `input` / `zero` event | `output` event |
| `counter` | `input` / `zero` event | `output` event|state |
| `signalOr` | `input0..N-1` event | `output` event |
| `logicOr` / `logicAnd` | `input0..N-1` state | `output` event|state |
| `logicNot` | `input` state | `output` event|state |
| `onLoad` | — | `output` event |
| `eventSequence` | `input1` / `input2` event | `output` event |
| `register` | `setTrue` / `setFalse` event | `output` event|state |
| `modeSwitch` | `input` event | `output0..N-1` event |
| `deviceInputSetVar` | — | `output` event |
| `deviceGetSetVar` | `input` event | `output` event |
| `varChange` | — | `output` event|state |
| `varGet` | `input` event | `output` / `output2` event |
| `varSetNumber` / `varSetString` | `input` event | `output` event |
| `nop` | — | —（serialized `output:[]` 不是连接器） |

`condition.condition` 未连线时网关按 false 处理：trigger 可走 `unmet`，`met` 不可达。`timeRange` 可直接接 event sink，也可作为状态接 condition/logic；已实测 start 进入事件，没有观察到等价的 end 事件。

## 25 种执行卡片与 nop

| 类型 | 常用 shortcut | 要点 |
|---|---|---|
| `deviceInput` | property：`--device-property <p> --op <op> ...`；event：`--device-event <e> --event-filter* ...` | property/event 严格二选一；property 依赖 push；event filters 可重复，不能混入 property 比较 flag |
| `deviceGet` | `--device-property <p> --op <op> ...` | 输入后主动读；满足 output，否则 output2 |
| `deviceOutput` | property：`--device-property <p> --value <v>`；action：`--device-action <a> --params '<json>'` | 参数按 MIoT format 保留原生类型 |
| `deviceInputSetVar` | property + `--var-scope/--var-id`；event + repeatable `--event-arg-var` | 变化/事件参数写变量 |
| `deviceGetSetVar` | property + `--var-scope/--var-id` | 由输入事件触发读取并写变量 |
| `alarmClock` | `--at HH:MM[:SS]` 或 `--sunrise/--sunset` | 日出日落必须给经纬度；offset 负数=之前；支持 days/工作日/节假日过滤 |
| `timeRange` | `--start ... --end ... [--ming-text-show true|false]` | 状态 + start 进入事件；mingTextShow 仅 UI 元数据 |
| `delay` | `--duration 5s` | 新事件会重置同一卡计时；并行计时用多张卡 |
| `statusLast` | `--duration 10s` | state 持续为 true 后输出；中途 false 会重置计时 |
| `condition` | 无额外 flag | condition 未接 = false |
| `loop` | `--interval 30s` | 必须先驱动 start；stop 可接有限反馈 |
| `onlyNTimes` | `--threshold <N>` | 只放行前 N 次；zero 重置 |
| `counter` | `--threshold <N>` | 累计至 N 后输出保持 true；zero 清零 |
| `signalOr` | `--inputs <N>` | 事件 OR |
| `logicOr` / `logicAnd` | `--inputs <N>` | 状态逻辑 |
| `logicNot` / `onLoad` / `register` | 无额外 flag | register 初值 false |
| `eventSequence` | `--duration 5s` | 按 input1→input2 顺序且在时限内发生；两路都要可达 |
| `modeSwitch` | `--outputs <N>` | output0..N-1 循环；指针跨规则重载/onLoad 保持，空输出是合法跳过位 |
| `varChange` / `varGet` | `--var-type number|string --op ...` | string 用 `--var-value` |
| `varSetNumber` / `varSetString` | `--expr '<expr>'` | shell 中始终单引号保护 `$` |
| `nop` | `--text` 或 `--delta`，可加 `--background` | 备注节点，不参与执行/可达性 |

所有执行卡 shortcut 可加 `--simplified true|false`。只有 `deviceInput` / `deviceInputSetVar` property mode 与 `varChange` 可加 `--preload` / `--no-preload`，默认 false。按已审计 bundle/UI 语义，`true` 会在规则启用时先查询/评估一次当前属性或变量，`false` 只跳过这次初始动作；后续 property notify / variable change 路径不变，且 preload 不会制造缺失的 notify/read/push 能力。`deviceInput` / `deviceInputSetVar` property/event push source 可用 transient `--allow-no-push` 做目标网关 runtime probe；它不持久化、不绕过 property access、不证明会发出，在线 spec-aware 仍诊断 no-push。该时序是 bundle 证据，不代表所有目标固件都已实机验证，仍要用日志或变量读数验收。`nop` 和 raw `--cfg` 路径不接受这些 shortcut flags。

审计 bundle 枚举的 `onLoad` 时机是保存、网关重启、禁用转启用和备份恢复；本轮安全实机只验证了 `disable → enable`。保存/重启/恢复时机必须在目标网关通过日志重新验证，不要把 bundle 分支直接写成全部实机证据。

## typed 比较与 action 参数

| MIoT 比较 dtype | property shortcut | wire |
|---|---|---|
| `int`（含非空 value-list 枚举投影） | `gt lt gte lte eq ne between`；集合用 `--property-include` | eq/include 使用 `operator:"include", v1:[...]` |
| 连续 `float` | `gt lt between` | 标量/范围 |
| `bool` | `eq --threshold 0|1` | `operator:"=", v1:boolean` |
| `string` | `eq --property-value <S>` | `operator:"=", v1:string` |

属性与 number 变量范围使用 `--op between --threshold <lower> --threshold2 <upper>`；`deviceInput` / `deviceGet` / `varChange` / `varGet` 的两个边界都必须显式给出，省略任一边界会在任何 session/spec/快照/写图前失败。显式下界 `0` 合法，非-between 标量比较仍保留历史默认 `0`。事件参数：

```bash
--event-filter '1=1'
--event-filter-include '2=1,2,3'
--event-filter-between '3=18.5,26.5'
```

三类均可重复，但同一 piid 只能出现一次。include 仅 int，between 支持 int/float。int 必须是精确 safe integer；所有数值按 value-list/value-range/step 验证。

`--force-out-of-range` 只适用于 typed `deviceInput` / `deviceGet` 数值属性比较，只跳过有效 value-range 的边界与 step 对齐检查；它不绕过无效 range metadata（非有限、min>max、step<=0）、value-list、finite/safe-integer、operator 或 operand shape 校验。strict export 会在需要时重放该 flag。

变量 number 比较使用标量 `operator:"="`，不要套用设备 int 的 include 编码；string 变量只支持 `eq --var-value`。

property-write 与动作参数共用原生类型和数值域契约：数值 `--value` 必须是完整十进制/scientific token，float/double 必须有限，整数必须是精确 safe integer；非空 value-list 与有效 value-range/step 都会执行。字符串首个 `$` 仍用 `$$` 转义，bool `0|1|true|false` 会持久化成 canonical boolean，spec-aware 读取时也兼容历史 numeric `0/1`。

动作 `--params` 的 key 必须恰好覆盖 `action.in` 对应 property short-name；`action.in` 不得重复 PIID，distinct PIID 的 short-name 也必须唯一。number / boolean / string 的原生 JSON 类型由 MIoT format 决定；只有数值 format 应用数值 value-list/value-range/step，bool/string 即使附带 numeric value-list 也仍是 boolean/string。变量引用用 `{"$var":"scope.id"}`。number 变量要求目标 input 有有效 value-range，以生成 min/max/step；非有限边界、min>max、step<=0 都拒绝。整数 action input 仅支持 safe integer，超出范围的 int64/uint64 会拒绝。bundle 按 index 绑定，因此持久化 `props.ins[i].piid` 必须等于 `action.in[i]`。`rule validate --spec-aware` 与 strict export 执行同一输入契约；permissive export 会明确 warning，并用索引投影、唯一占位 key 与无原型字典避免乱序、重复名或 `__proto__` 静默丢值。

## 整图与节点 JSON

每个**已建模节点**严格包含 `{type,id,cfg,inputs,outputs,props}`。未知未来节点为保真采用 passthrough，可在这些键之外保留扩展字段；不要把已建模节点的严格六段约束误套成会删除 opaque 字段。设备卡 cfg 必须带 urn；时长卡 cfg 带 unit/value，真正毫秒数在 props.timeout/interval；表达式卡 pos 可带 exprHeight；nop cfg 带 Quill `contents` 与 `background`。

整图 envelope：

```json
{
  "id": "1700000000000",
  "nodes": [],
  "cfg": {
    "id": "1700000000000",
    "uiType": "test",
    "enable": false,
    "userData": {
      "name": "规则名",
      "transform": {"x":0,"y":0,"scale":1,"rotate":0},
      "lastUpdateTime": 0,
      "version": 0
    }
  }
}
```

已存在规则的 `rule set` 默认 read-merge-write，保留 live enable/uiType/userData（除非 `--allow-cfg-overwrite`）并刷新时间戳；新规则使用 body cfg。开关规则用 `enable` / `disable`，不要依赖普通 body cfg.enable。export/import 重放是有意的例外：第一笔 target-graph write 明确传 `--allow-cfg-overwrite`，原子 staging 空图与 `enable=false`，完整重建后才按导出状态决定是否 `enable`。

最小 onLoad marker：

```json
{
  "id":"1700000000000",
  "nodes":[
    {"id":"load","type":"onLoad","cfg":{"pos":{"x":40,"y":40,"width":200,"height":120},"name":"onLoad","version":1},"inputs":{},"outputs":{"output":["mark.input"]},"props":{}},
    {"id":"mark","type":"varSetNumber","cfg":{"pos":{"x":264,"y":40,"width":740,"height":220,"exprHeight":30},"name":"varSetNumber","version":1},"inputs":{"input":null},"outputs":{"output":[]},"props":{"scope":"global","id":"marker","elements":[{"type":"const","value":"1"}]}}
  ],
  "cfg":{"id":"1700000000000","uiType":"test","enable":false,"userData":{"name":"marker","transform":{"x":0,"y":0,"scale":1,"rotate":0},"lastUpdateTime":0,"version":0}}
}
```

`nop` serialized outputs 必须是 `{"output":[]}` 且永远为空；不要给它连边。`rule layout` 只移动执行卡，保留 nop 自由位置。

## 逐类 props 速查

| type | inputs | outputs | props / cfg 关键字段 |
|---|---|---|---|
| `deviceInput` property | — | output | `did,siid,piid,dtype,operator,v1[,v2][,preload]` |
| `deviceInput` event | — | output | `did,siid,eiid[,arguments:[{piid,dtype[,operator,v1[,v2]]}]]`；bare `{piid,dtype}` 是 match-any |
| `deviceGet` | input | output,output2 | 同 property comparison，无 preload |
| `deviceOutput` action | trigger | output | `did,siid,aiid,ins:[{piid,value}|{piid,scope,id,dtype,...}]` |
| `deviceOutput` property | trigger | output | `did,siid,piid,value` 或变量 ref |
| `deviceInputSetVar` property | — | output | `did,siid,piid,dtype,scope,id[,preload]` |
| `deviceInputSetVar` event | — | output | `did,siid,eiid,arguments:[{piid,dtype,scope,id}]` |
| `deviceGetSetVar` | input | output | `did,siid,piid,dtype,scope,id` |
| `alarmClock` | — | output | periodic 或 sunset shape + filter |
| `timeRange` | — | output | `start,end,filter[,mingTextShow]` |
| `delay` / `statusLast` / `eventSequence` | 见 pin 表 | output | `timeout` |
| `loop` | start,stop | output | `interval` |
| `onlyNTimes` / `counter` | input,zero | output | `n` |
| logic/signal/onLoad/register/modeSwitch | 见 pin 表 | 见 pin 表 | `{}` |
| `condition` | trigger,condition | met,unmet | `{}` |
| `varChange` | — | output | `scope,id,varType,preload,operator,v1[,v2]` |
| `varGet` | input | output,output2 | 同 var comparison，无 preload |
| `varSetNumber` / `varSetString` | input | output | `scope,id,elements` |
| `nop` | — | serialized output=[] | props `{}`；内容/背景在 cfg |

常用尺寸：deviceInput 584×206、deviceGet 700×240、deviceOutput 684×204、deviceInputSetVar 554×206、deviceGetSetVar 566×200、alarmClock 512×152、timeRange 524×152、condition 320×140、loop 510×160、onLoad 200×120、nop 320×60、varSetNumber 740×220、varSetString 712×220。其他卡让 shortcut 生成后再 `rule layout`。

## 非平凡 wire 实样

```json
{"dtype":"int","operator":"include","v1":[1,2,3]}
{"dtype":"int","operator":"between","v1":20,"v2":30}
{"dtype":"float","operator":">","v1":40}
{"dtype":"boolean","operator":"=","v1":true}
{"dtype":"string","operator":"=","v1":"open"}
{"varType":"number","operator":"=","v1":1}
{"varType":"number","operator":"between","v1":1,"v2":5}
```

表达式 elements：

```json
{"scope":"global","id":"count","elements":[
  {"type":"var","scope":"global","id":"count"},
  {"type":"const","value":"+1"}
]}
```

动态 action input：

```json
{"piid":2,"scope":"global","id":"level","dtype":"number","min":1,"max":100,"step":1}
```

日落：

```json
{"type":"sunset","isSunset":true,"offset":-30,"latitude":31.2,"longitude":121.4,"filter":{"day":[1,2,3,4,5]}}
```

`props.offset` 是 signed minutes；上例表示日落前 30 分钟，不是秒或毫秒。
