# 复杂自动化图配方

需求涉及多事件顺序、状态门、限次/reset、latch、轮换、轮询或动态 action 参数时读取本文。配方演示**图结构**，设备 short-name、事件参数、action params 与 literal 必须用目标 `device spec` 替换。

## 目录

- [使用方式](#使用方式)
- [触发后主动查询并双分支](#触发后主动查询并双分支)
- [门锁事件后五分钟内有人且仅夜间播报](#门锁事件后五分钟内有人且仅夜间播报)
- [多传感器状态保持与每日限次](#多传感器状态保持与每日限次)
- [累计 N 次并显式复位](#累计-n-次并显式复位)
- [可布防的 register 状态门](#可布防的-register-状态门)
- [有界循环查询](#有界循环查询)
- [轮换模式](#轮换模式)
- [number 状态驱动 boolean 输出](#number-状态驱动-boolean-输出)
- [preload 与初始化](#preload-与初始化)
- [配方验收矩阵](#配方验收矩阵)

## 使用方式

先写计划表，再替换占位符：

```text
事实 | E/S | node.type/mode | source pin | target pin | 参数证据 | reset/stop
```

共同骨架：

```bash
xgg device spec <did> --pretty
xgg rule new --name "<name>"
# node add + edge add
xgg rule layout <rid>
xgg rule validate --rule-id <rid> --spec-aware
xgg rule lint --rule-id <rid> --strict
```

先保持 disabled。授权运行后才 enable、执行可控触发并查 logs/trace/readback。下文命令不包含 operational flags；Agent mode/snapshot 见 [operations.md](operations.md)。

## 触发后主动查询并双分支

适合“不维护影子状态；按钮到来时读一次灯的真实开关”。`deviceGet.output`=满足，`output2`=不满足：

```bash
xgg rule node add --rule-id <rid> --type deviceInput --id nClick \
  --device-did <button-did> --device-event <click-event>
xgg rule node add --rule-id <rid> --type deviceGet --id nIsOn \
  --device-did <light-did> --device-property <on-property> --op eq --threshold 1
xgg rule node add --rule-id <rid> --type deviceOutput --id nOff \
  --device-did <light-did> --device-property <on-property> --value false
xgg rule node add --rule-id <rid> --type deviceOutput --id nOn \
  --device-did <light-did> --device-property <on-property> --value true
xgg rule edge add --rule-id <rid> --from nClick:output --to nIsOn:input
xgg rule edge add --rule-id <rid> --from nIsOn:output --to nOff:trigger
xgg rule edge add --rule-id <rid> --from nIsOn:output2 --to nOn:trigger
```

这是 query branch，不是 property subscription。若两个设备事件都能触发同一 query，先各接 `signalOr.inputN`，再从 `signalOr.output` 接 `deviceGet.input`。

## 门锁事件后五分钟内有人且仅夜间播报

需求编译：

```text
门锁事件并保存参数 E  deviceInputSetVar(event) → varGet(discriminator) → eventSequence.input1
有人事件           E  deviceInput(event)       → eventSequence.input2
五分钟有序窗口     E  eventSequence            → condition.trigger
夜间窗口           S  timeRange                → condition.condition
拼动态文案         E  varSetString             → speaker.trigger
```

先按 event argument format 创建变量；非 string（包括 bool）捕获为 number：

```bash
xgg variable create --scope global --id lockMethod --type number --value 0 --name "开锁方式"
xgg variable create --scope global --id announceText --type string --value "" --name "播报内容"

xgg rule node add --rule-id <rid> --type deviceInputSetVar --id nLock \
  --device-did <lock-did> --device-event <lock-event> \
  --event-arg-var <method-piid>=global.lockMethod
xgg rule node add --rule-id <rid> --type varGet --id nUnlock \
  --var-scope global --var-id lockMethod --var-type number \
  --op eq --threshold <unlock-enum-value>
xgg rule node add --rule-id <rid> --type deviceInput --id nPresence \
  --device-did <presence-did> --device-event <presence-event>
xgg rule node add --rule-id <rid> --type eventSequence --id nSeq --duration 5min
xgg rule node add --rule-id <rid> --type timeRange --id nNight \
  --start 20:00 --end 07:00
xgg rule node add --rule-id <rid> --type condition --id nNightGate
xgg rule node add --rule-id <rid> --type varSetString --id nMessage \
  --var-scope global --var-id announceText \
  --expr '夜间门锁事件，开锁方式 $global.lockMethod，随后检测到有人'
xgg rule node add --rule-id <rid> --type deviceOutput --id nSpeak \
  --device-did <speaker-did> --device-action <play-text-action> \
  --params '{"<text-param>":{"$var":"global.announceText"}}'

xgg rule edge add --rule-id <rid> --from nLock:output --to nUnlock:input
xgg rule edge add --rule-id <rid> --from nUnlock:output --to nSeq:input1
xgg rule edge add --rule-id <rid> --from nPresence:output --to nSeq:input2
xgg rule edge add --rule-id <rid> --from nSeq:output --to nNightGate:trigger
xgg rule edge add --rule-id <rid> --from nNight:output --to nNightGate:condition
xgg rule edge add --rule-id <rid> --from nNightGate:met --to nMessage:input
xgg rule edge add --rule-id <rid> --from nMessage:output --to nSpeak:trigger
```

若 lock event 本身已是业务需要的独立语义而无需按参数筛选，可省略 nUnlock；否则 set-var 卡不接受 `--event-filter*`，必须捕获后用 varGet 分支。若有多个要保存的参数，重复 `--event-arg-var`。第一次实机必须证明：capture→output→varGet 的 happens-before、变量在下游表达式前已更新、sequence timeout/reset 符合固件、跨午夜状态正确、action output/success 日志一致。

## 多传感器状态保持与每日限次

需求：“任一人体传感器持续有人 2 分钟、且处于夜间，今天最多提醒一次；午夜复位。”先 OR presence states，再与夜间 AND，最后保持、限次：

```bash
xgg rule node add --rule-id <rid> --type deviceInput --id nP1 \
  --device-did <p1> --device-property <occupancy> --op eq --threshold 1 --preload
xgg rule node add --rule-id <rid> --type deviceInput --id nP2 \
  --device-did <p2> --device-property <occupancy> --op eq --threshold 1 --preload
xgg rule node add --rule-id <rid> --type logicOr --id nAnyPresence --inputs 2
xgg rule node add --rule-id <rid> --type timeRange --id nNight --start 22:00 --end 06:00
xgg rule node add --rule-id <rid> --type logicAnd --id nNightPresence --inputs 2
xgg rule node add --rule-id <rid> --type statusLast --id nHeld --duration 2min
xgg rule node add --rule-id <rid> --type onlyNTimes --id nOnce --threshold 1
xgg rule node add --rule-id <rid> --type alarmClock --id nMidnight --at 00:00

xgg rule edge add --rule-id <rid> --from nP1:output --to nAnyPresence:input0
xgg rule edge add --rule-id <rid> --from nP2:output --to nAnyPresence:input1
xgg rule edge add --rule-id <rid> --from nAnyPresence:output --to nNightPresence:input0
xgg rule edge add --rule-id <rid> --from nNight:output --to nNightPresence:input1
xgg rule edge add --rule-id <rid> --from nNightPresence:output --to nHeld:input
xgg rule edge add --rule-id <rid> --from nHeld:output --to nOnce:input
xgg rule edge add --rule-id <rid> --from nMidnight:output --to nOnce:zero
xgg rule edge add --rule-id <rid> --from nOnce:output --to <alertNode>:trigger
```

`onlyNTimes` 没有“每天”字段；每日语义来自 alarmClock→zero。这里选择 `--preload`，因为启用时已经有人也应初始化两路 state；若业务明确只从启用后的下一次 notify 开始计时才改成 `--no-preload`。preload 不扩大 notify/read/push，且它是否把初始 state/event 传播到 logic/statusLast 仍需目标日志验证。`statusLast` 的 false 取消时点、onlyNTimes 第一次/复位行为也需变量 marker 或真实日志验证。

## 累计 N 次并显式复位

`counter` 是阈值 B output，不是“前 N 次放行”。例如多个入口累计到 3 次触发：

```bash
xgg rule node add --rule-id <rid> --type signalOr --id nAny --inputs 2
xgg rule node add --rule-id <rid> --type counter --id nCount --threshold 3
xgg rule node add --rule-id <rid> --type alarmClock --id nReset --at 00:00
xgg rule edge add --rule-id <rid> --from nSourceA:output --to nAny:input0
xgg rule edge add --rule-id <rid> --from nSourceB:output --to nAny:input1
xgg rule edge add --rule-id <rid> --from nAny:output --to nCount:input
xgg rule edge add --rule-id <rid> --from nReset:output --to nCount:zero
xgg rule edge add --rule-id <rid> --from nCount:output --to <actionNode>:trigger
```

Bundle 不能证明输出发生在第 N 还是 N+1、达到后保持还是复位。先把 action 换成 probe variable，在目标固件做 1、2、3、4 次输入和 zero 后序列，再决定业务是否采用。

## 可布防的 register 状态门

arm/disarm 是 event，真正告警 event 到来时读取 register state：

```bash
xgg rule node add --rule-id <rid> --type register --id nArmed
xgg rule node add --rule-id <rid> --type condition --id nGate
xgg rule edge add --rule-id <rid> --from nArmEvent:output --to nArmed:setTrue
xgg rule edge add --rule-id <rid> --from nDisarmEvent:output --to nArmed:setFalse
xgg rule edge add --rule-id <rid> --from nAlarmEvent:output --to nGate:trigger
xgg rule edge add --rule-id <rid> --from nArmed:output --to nGate:condition
xgg rule edge add --rule-id <rid> --from nGate:met --to <alarmAction>:trigger
```

XGG static model 以初始 false 做可达性分析，但真实 disable/enable、保存、重启、恢复后的 register 状态必须探针。安全系统需要明确持久状态时，用 number 变量 0/1 + `varGet`/`varChange`，不要依赖未证明的 latch 生命周期。

## 有界循环查询

需求：“按钮后每 30 秒检查一次，持续 5 分钟；满足时执行动作；5 分钟到自动 stop。”同一个 start event fan-out 到 loop.start 与 delay.input：

```bash
xgg rule node add --rule-id <rid> --type loop --id nLoop --interval 30s
xgg rule node add --rule-id <rid> --type delay --id nStopAfter --duration 5min
xgg rule node add --rule-id <rid> --type deviceGet --id nQuery \
  --device-did <did> --device-property <property> --op gt --threshold <value>
xgg rule edge add --rule-id <rid> --from nStart:output --to nLoop:start
xgg rule edge add --rule-id <rid> --from nStart:output --to nStopAfter:input
xgg rule edge add --rule-id <rid> --from nStopAfter:output --to nLoop:stop
xgg rule edge add --rule-id <rid> --from nLoop:output --to nQuery:input
xgg rule edge add --rule-id <rid> --from nQuery:output --to <actionNode>:trigger
```

是否立即首查、重复 start、stop 与同刻 tick 的顺序是固件行为。若用户要求“立刻一次”，另把 start event 直接接 query 前的 `signalOr`，不要假定 loop 首 tick。

## 轮换模式

同一按钮依次执行三种模式：

```bash
xgg rule node add --rule-id <rid> --type modeSwitch --id nMode --outputs 3
xgg rule edge add --rule-id <rid> --from nTrigger:output --to nMode:input
xgg rule edge add --rule-id <rid> --from nMode:output0 --to nSceneA:trigger
xgg rule edge add --rule-id <rid> --from nMode:output1 --to nSceneB:trigger
xgg rule edge add --rule-id <rid> --from nMode:output2 --to nSceneC:trigger
```

输出编号必须从 0 连续；每次只选一路。不要未经实测承诺 disable/reload/reboot 后从 output0 重新开始。若初始模式是业务关键，用持久 number variable + `varGet`/`varSetNumber` 显式实现。

空 output 是合法的显式“该轮跳过”位，Bundle save validator 只要求 output0…N-1 键连续，不要求每路都连接 sink；跨空位如何推进及 pointer 生命周期仍需实机验证。

## number 状态驱动 boolean 输出

网关没有 bool 变量，boolean 与任何存在 `value-list` 字段的设备目标（包括 `[]`）也不接受变量 ref。需求“把 number 变量 0/1 写成设备开关”必须先分支，再写两个 native boolean literal：

```bash
xgg rule node add --rule-id <rid> --type varGet --id nFlag \
  --var-scope global --var-id enabled --var-type number --op eq --threshold 1
xgg rule node add --rule-id <rid> --type deviceOutput --id nTrue \
  --device-did <did> --device-property <bool-property> --value true
xgg rule node add --rule-id <rid> --type deviceOutput --id nFalse \
  --device-did <did> --device-property <bool-property> --value false
xgg rule edge add --rule-id <rid> --from nTrigger:output --to nFlag:input
xgg rule edge add --rule-id <rid> --from nFlag:output --to nTrue:trigger
xgg rule edge add --rule-id <rid> --from nFlag:output2 --to nFalse:trigger
```

先用 `xgg variable get global --pretty` 或 `variable get-config` 确认实际类型为 number，目标 property 可写且 native format 为 bool；不要写 `--value '$global.enabled'`。同一模式也适用于 value-list literal 输出：按 number/string query 分支，每个分支写该 spec 枚举的原生 literal。

## preload 与初始化

`--preload` 仅用于三类：property `deviceInput`、property `deviceInputSetVar`、`varChange`。它表达 enable 时先查询/评估当前值；默认 false。示例：

```bash
xgg rule node add --rule-id <rid> --type deviceInputSetVar --id nCurrent \
  --device-did <did> --device-property <property> \
  --var-scope global --var-id currentValue --preload
```

enable 前同时审查：

1. 所有 `onLoad` 下游；
2. 三类 preload 卡片的变量/动作下游；
3. 当前 rule enable 状态与 snapshot；
4. preload 是否实际向 output 发 event——只能用目标日志/readback证明。

若需要确定顺序的初始化，优先显式 `onLoad → deviceGetSetVar → downstream`，并验证 get-set output 的时序；不要让多个独立 preload source 形成隐式竞态。

## 配方验收矩阵

| 模式 | 静态必须过 | 运行时必须证明 |
|---|---|---|
| query branch | device spec/read access、output/output2 接向 | 满足与不满足各一次 |
| sequence + gate | 两个 sequence inputs、condition E/S 分离 | 顺序、逆序、timeout、夜间真/假 |
| hold + limit | state colors、zero 可达 | false reset、N 次、午夜 reset |
| counter | threshold、B→E 连接；仅业务要求复位时 zero 可达 | 第 N/N+1、阈值后；有复位需求时再证明 zero 后 |
| register | setTrue/setFalse/trigger 路径 | 初始、disable/enable、reboot |
| bounded/cancellable loop | start 与 stop 都可达 | 首 tick、间隔、停止、重复 start |
| deliberate permanent loop | start 可达；可省略 stop；正 interval | tick/间隔、disable/delete 终止、事件风暴风险 |
| modeSwitch | 连续 outputs；业务需要的路接 sink，空 output 可作显式跳过位 | 跨空位推进、轮换顺序与生命周期 |
| dynamic action | params native type/value domain | 变量更新先后、success/failed、设备结果 |

每个负例也要观察：不能只触发成功路径一次。测试结束按授权删除临时规则/global 变量，并保留脱敏后的命令、summary、日志/trace/readback 证据。
