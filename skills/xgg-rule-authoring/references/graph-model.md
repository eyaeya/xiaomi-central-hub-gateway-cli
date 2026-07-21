# 小米中枢网关规则图执行模型

设计新规则、解释复杂分支、判断某条线为什么永远不会触发，或需要手写/审查整图 JSON 时读取本文。先理解事件与状态，再选卡片；不要从 JSON 字段名反猜运行语义。

## 目录

- [先把自然语言拆成运行事实](#先把自然语言拆成运行事实)
- [图与节点的 JSON 结构](#图与节点的-json-结构)
- [wire 只序列化在源节点 outputs](#wire-只序列化在源节点-outputs)
- [pin 颜色与连线规则](#pin-颜色与连线规则)
- [事件可达性与状态真假](#事件可达性与状态真假)
- [控制卡的运行语义](#控制卡的运行语义)
- [规则生命周期与内部状态](#规则生命周期与内部状态)
- [静态契约不能替代的运行探针](#静态契约不能替代的运行探针)
- [增量编写与原子整图](#增量编写与原子整图)
- [设计检查表](#设计检查表)

## 先把自然语言拆成运行事实

把需求中的每个短语归入下表，再画图。一个名词可能同时产生事件与状态，例如 property-mode `deviceInput.output`；不要因此把两种用途混为一条线。

| 需求问题 | 需要的事实 | 常用卡片 |
|---|---|---|
| 什么事情启动一次执行？ | event | `deviceInput` event/property notify、`alarmClock`、`onLoad`、`varChange`；此前目标网关实测 `timeRange` 在 start 进入时发 event，其他固件仍复验 |
| 执行发生时还必须满足什么？ | state | property-mode `deviceInput`、`timeRange`、`varChange`、`register`、`logic*`、`statusLast` |
| 要在触发瞬间主动查询什么？ | event → comparison branch | `deviceGet` / `varGet` |
| 真/假分别做什么？ | branch | `condition.met/unmet`、`deviceGet.output/output2`、`varGet.output/output2` |
| 多路事件任一路都算？ | event aggregation | `signalOr` |
| 多路状态任一/全部满足？ | state aggregation | `logicOr` / `logicAnd`；反相用 `logicNot` |
| 要记住一个开关、次数或轮次？ | graph-local state | `register`、`counter`、`onlyNTimes`、`modeSwitch`，或持久变量 |
| 要等待、保持、按顺序或重复？ | temporal control | `delay`、`statusLast`、`eventSequence`、`loop` |
| 最终产生什么副作用？ | reachable sink | `deviceOutput`、`deviceGetSetVar`、`varSetNumber`、`varSetString` |

先写一张计划表，不要直接执行命令：

```text
自然语言片段 | event/state | 节点.type | 输出 pin | 消费节点:输入 pin | 参数来源
门锁开门       event         deviceInput output    nSeq:input1       device spec event
5 分钟内有人   event         deviceInput output    nSeq:input2       device spec event
夜间窗口       state         timeRange   output    nCond:condition  用户时间
顺序成立       event         eventSequence output  nCond:trigger    timeout=5min
开灯           sink          deviceOutput output   -                 device spec writable property
```

如果某个动作没有独立 event source 到它的有向路径，或者路径只接到了 `condition.condition`、`loop.stop`、`onlyNTimes.zero` 这类辅助 pin，它不会因为“图上看起来连着”就执行。

## 图与节点的 JSON 结构

一条规则是一个 envelope：

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
      "transform": {"x": 0, "y": 0, "scale": 1, "rotate": 0},
      "lastUpdateTime": 0,
      "version": 0
    }
  }
}
```

顶层 `id` 与 `cfg.id` 表示同一规则。启停优先使用 `rule enable/disable`；不要靠普通 `rule set` body 偷改 `cfg.enable`。`userData.transform` 是画布视口，不是执行逻辑。

每个已建模执行节点严格包含六段：

```json
{
  "id": "nCheck",
  "type": "deviceGet",
  "cfg": {"name": "deviceGet", "version": 1, "pos": {"x": 0, "y": 0, "width": 700, "height": 240}, "urn": "urn:miot-spec-v2:device:..."},
  "inputs": {"input": null},
  "outputs": {"output": [], "output2": []},
  "props": {"did": "<did>", "siid": 2, "piid": 1, "dtype": "boolean", "operator": "=", "v1": true}
}
```

- `id`：规则内唯一、后续命令复用的节点标识。
- `type`：执行卡类型；不要用 UI 中文名或未经当前 xgg 校验的旧称猜值。定时卡的实际类型是 `alarmClock`，不是 `timer`。
- `cfg`：卡片 UI/版本/位置以及设备 URN；`pos`、`simplified` 等字段可能只影响显示。少数 UI marker 位于 `props`，例如 `timeRange.props.mingTextShow`，不能因其是显示字段就写进 `cfg`。
- `inputs`：声明输入 pin，值通常保持 `null`；它不是入边清单。
- `outputs`：声明输出 pin，并保存从该 pin 发出的目标 endpoint 数组。
- `props`：网关运行时真正读取的参数，例如 DID、比较运算、timeout、变量或 action inputs。

`nop` 是画布备注，不执行；虽然 envelope 序列化 `outputs:{"output":[]}`，网页没有 connector，禁止给它连边。未知未来节点使用完整 passthrough 保真；不要用已知节点的六段 schema 删除其扩展字段。

## wire 只序列化在源节点 outputs

canonical CLI endpoint 用冒号，JSON wire 用点：

```bash
xgg rule edge add --rule-id <rid> --from nSource:output --to nTarget:trigger
```

对应 JSON 只在源节点记录：

```json
{
  "id": "nSource",
  "outputs": {"output": ["nTarget.trigger"]}
}
```

目标节点仍是：

```json
{"id":"nTarget","inputs":{"trigger":null}}
```

不要把边同时写进 target input，也不要把 CLI 的 `node:pin` 原样写进 `outputs`。同一 source output 可以 fan-out 到多个目标；同一 target input 最多只能有一条入边。

若既有 node ID 自身含 `:`，紧凑 CLI endpoint 会有歧义；edge add/remove 必须同时给齐 `--from-node-id <id> --from-pin <pin> --to-node-id <id> --to-pin <pin>`。当前 export 保存结构化端点并自动选这种形式；旧 JSON export 只能按**最后一个**冒号恢复 pin。不要为方便连线而静默改 legacy ID。

## pin 颜色与连线规则

颜色是运行类型，不是装饰：

| 源输出 | event 输入 | state 输入 |
|---|---:|---:|
| `event` | 可接 | 不可接 |
| `state` | 不可接 | 可接 |
| `event\|state` | 可接 | 可接 |

通配只发生在**源输出**：`event|state` 可以喂两种输入；不要反推“目标若是双类型就能接任意源”。当前建模输入本身没有这种通配需求。

- 合并 event：用 `signalOr`。
- 合并 state：用 `logicOr` / `logicAnd`。
- 反相 state：用 `logicNot`。
- 每个 input pin fan-in 上限为 1；先聚合，再接下游。
- `deviceInput` event-mode 的 `output` 是纯 event；property-mode 是 `event|state`。
- `timeRange.output` 是 `event|state`：它同时能连接 event 与 state 消费者。此前目标网关安全探针观察到 start 进入事件与独立窗口 state，未观察到等价 end event；这是范围化实机证据，不是静态契约证明，换固件仍要复验。

完整 pin 表见 [node-catalog.md](node-catalog.md)。

## 事件可达性与状态真假

区分四种事实：event 可达、state 可用、state 可能为 true、state 可能为 false。仅知道“有 state”不能证明 `statusLast` 或 `condition.met` 可走。

独立 event source：`deviceInput`、`deviceInputSetVar`、`alarmClock`、`timeRange`、`onLoad`、`varChange`。其中物理/变量 source 是否真的发出事件仍依赖目标网关、push 与触发条件。

动作/写入 sink：`deviceOutput`、`deviceGetSetVar`、`varSetNumber`、`varSetString`。每个 sink 在启用前都必须有一条满足准确 pin 与真假条件的上游 event 路径。

特殊聚合规则：

- `eventSequence`：`input1` 与 `input2` 都必须 event 可达，且运行时必须按顺序、在 timeout 内到达。
- `condition`：`trigger` 必须 event 可达；`condition` 是辅助 state。未接时 XGG 静态模型只判 `unmet` 可达，且此前目标网关安全探针确实走 `unmet`；业务规则仍应接入明确 state，换固件或把该行为作为关键契约时复验。
- `logicAnd`：所有声明的 state inputs 都要可用且都可能 true；任一路 state 更新可驱动重新求值。
- `logicOr`：任一路 state 可用即可求值；想让 true 分支可达，至少一路可能 true。
- `logicNot`：交换 may-true / may-false。
- `statusLast`：静态模型只有在输入 state 可能为 true 时才允许其输出可达；false 是否取消/复位计时及精确时点属于 executor 行为，必须实机验证。
- `loop.start` 启动，`loop.stop` 只停止；只接 stop 不能启动下游。此前目标网关已验证同节点 `loop.output → loop.stop` 可形成一次有限反馈，但首 tick、重复 start 与竞态仍需目标环境探针。
- `onlyNTimes.input` 才能放行；`zero` 只重置。
- `counter` 的 `input` 累计，`zero` 清零；不要把清零边当作达到阈值的替代路径。

`rule lint --strict` 会报告 truth/pin-aware 的 never-fires sink；`rule enable` 会硬拦。`rule validate` 不替代这层检查。

## 控制卡的运行语义

| 卡片 | 语义 | 常见误用 |
|---|---|---|
| `condition` | event 到 trigger 时读取 condition state，走 met 或 unmet | 把 state 直接接 trigger；以为未接 condition 会走 met |
| `signalOr` | 任一输入 event 到达就输出 event | 用它合并 state |
| `logicAnd/Or/Not` | 聚合/反相 state，输出双类型更新 | 用它合并纯按钮 event |
| `delay` | 把 event 延后 | 把同一卡未经实测地当成并行计时器；并发/重置策略要探针 |
| `statusLast` | state 连续保持指定时长 | 把 event 接入 state pin；未验证 false 取消时机 |
| `eventSequence` | input1 后 input2，且间隔不超过 timeout | 只接一路；把“两者都发生”误当无序 AND |
| `loop` | start 后每 interval 输出，stop 终止 | 当成无输入独立定时器 |
| `onlyNTimes` | reset 周期内只放行前 N 个 input event | 与“累计到 N 次才输出”的 counter 混淆 |
| `counter` | 统计 input，阈值结果从双类型 output 给出；zero 清零 | 未经实测断言第 N/N+1、阈值后保持或复位 |
| `register` | setTrue/setFalse 控制一个图内布尔 latch | 把静态分析初值或一次探针当成重启后持久性 |
| `modeSwitch` | 每次 input 轮换到连续 output0..N-1 | 以为每条输出同时执行，或未经探针断言 reload 后指针 |

复杂模式与完整命令见 [recipes.md](recipes.md)。

## 规则生命周期与内部状态

- `onLoad` 是无输入 event source；用 disable→enable 可控触发前，必须先审查全部下游。当前 xgg 静态契约不包含固件 executor，不能据此承诺保存、重启、恢复等每个生命周期都会触发。
- `preload=true` 仅适用于 property-mode `deviceInput` / `deviceInputSetVar` 与 `varChange`：UI 意图是在规则启用时先查询/评估一次；默认 false 只跳过首次查询，不关闭后续 notify/change。preload 是否向下游发 event 仍须日志证明。
- XGG 静态可达性把 `register` 初始状态建模为 false；这是一项保守分析假设，不是禁用、重启或恢复后真实固件状态的证明。
- `register`、`counter`、`onlyNTimes`、`modeSwitch`、`loop` 都含图内状态。需要跨规则共享、可直接读写或有明确持久性时，改用网关变量并显式设计初始化。
- 已启用规则的 node/edge/layout/set 修改通常保留 `enable`，因此多步编辑可能立即改变线上行为。需要隔离时先获授权 disable，或离线构造后单次 `rule set`。

## 静态契约不能替代的运行探针

当前 xgg 的 node/wire schema、save validator 与日志 projector 不包含固件 executor。下面这些问题不能从卡片名字或静态代码下定论：

| 卡片/链路 | 需要在目标网关证明 |
|---|---|
| `delay` | 新事件覆盖、排队还是并行；0/负 legacy 值如何执行 |
| `loop` | 首 tick、重复 start；已验证的同节点 output→stop 以外反馈终止性 |
| `statusLast` | false 的取消/复位时点；满足后输出何种 event/state 序列 |
| `eventSequence` | 并发序列、超时和 reset 的精确规则 |
| `counter` | 第 N 还是 N+1；达到阈值后保持、继续还是复位 |
| `onlyNTimes` | 达到 N 后行为及 zero 的精确复位；它没有内建“每天” |
| `register` / `modeSwitch` | disable、enable、保存、网关重启、备份恢复后的状态/指针 |
| action/set/query output | output 在成功、失败或仅提交后发出；关键串接看 success/failed 日志 |
| `timeRange` | 此前目标网关观察到 start event + 窗口 state、未见等价 end event；其他固件/关键业务复验 |

此前受控目标网关探针已得到三条可复用、但仍限定固件/配置的证据：空 `condition.condition` 在 trigger 时走 `unmet`；`loop.output → 同一 loop.stop` 能形成有限反馈；`timeRange` 在 start 进入时发 event 并同时提供窗口 state，未观察到等价 end event。设计可以利用这些能力，但交付必须注明证据范围；换网关/固件或业务后果较高时重新取 logs/trace/readback。

安全探针优先用临时规则与变量 marker，不驱动物理设备；涉及真实动作时必须有用户授权。把结论限定到目标固件版本，并把日志/trace/readback 一起落盘。

## 增量编写与原子整图

优先使用 typed shortcut：它会从目标 spec 生成完整 `{cfg,inputs,outputs,props}`，并执行本地约束。增量流程允许暂时悬空节点，因此每批修改后主动 strict lint。

仅在下列情况使用 raw JSON：

1. 未建模的未来卡片需要完整保真；
2. shortcut 不认识的扩展字段必须保留；
3. 需要一次原子写入整图。

raw 前先从默认 JSON `rule view`/export 取全量结构，不要解析 pretty，也不要从文档片段拼残缺 payload。用 `rule validate --body <file>` 离线验形；在线写入后再 `validate --spec-aware`、`lint --strict`、readback。

## 设计检查表

写第一条命令前回答：

1. 独立 event source 是谁？若没有，什么外部 event 驱动查询或 loop.start？
2. 哪些事实是持续 state，哪些只是瞬时 event？
3. 触发时查询用 `deviceGet/varGet`，持续订阅用 `deviceInput/varChange`，是否选对？
4. 多路合并用了正确颜色的 aggregator 吗？每个 target input 是否只有一条线？
5. `condition` 的 trigger 与 condition 分开了吗？met/unmet 与真/假意图一致吗？
6. 延时、保持、顺序、循环、次数、轮转分别需要哪张控制卡？reset/stop 路径在哪里？
7. 每个 sink 是否存在满足准确 pin 与真假条件的 event 路径？
8. 所有设备 short-name、siid、value-list/range、event arg、action input 是否来自当前 spec？
9. 变量 scope/type 是否存在且与卡片契约一致？
10. 是否先保持禁用完成 layout、spec-aware validate、strict lint，再按授权启用并取日志/readback？
