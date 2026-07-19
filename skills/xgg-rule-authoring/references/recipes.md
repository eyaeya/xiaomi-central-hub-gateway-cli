# xgg 自动化配方

需求与下列模式匹配时读取本文。占位符：`<rid>` 规则 id、`<btn>` 触发设备 DID、`<light>` 目标设备 DID。设备卡在写前必须先 `device spec`，写后固定 `layout → validate → lint --strict → 按需 enable → trigger/log/readback`。

## 目录

- [按钮动作与 toggle](#按钮动作与-toggle)
- [时间窗与多路合并](#时间窗与多路合并)
- [延迟循环与模式](#延迟循环与模式)
- [变量与安全探针](#变量与安全探针)

## 按钮动作与 toggle

单击执行动作：

```bash
xgg rule node add --rule-id <rid> --type deviceInput \
  --device-did <btn> --device-event click --id n-click
xgg rule node add --rule-id <rid> --type deviceOutput \
  --device-did <light> --device-property <on-prop> --value true --id n-on
xgg rule edge add --rule-id <rid> --from n-click:output --to n-on:trigger
```

不用变量 toggle：先读真实开关，满足走 output 接关闭，不满足走 output2 接打开。

```bash
xgg rule node add --rule-id <rid> --type deviceInput \
  --device-did <btn> --device-event click --id n-toggle-click
xgg rule node add --rule-id <rid> --type deviceGet \
  --device-did <light> --device-property <on-prop> --op eq --threshold 1 --id n-is-on
xgg rule node add --rule-id <rid> --type deviceOutput \
  --device-did <light> --device-property <on-prop> --value false --id n-off
xgg rule node add --rule-id <rid> --type deviceOutput \
  --device-did <light> --device-property <on-prop> --value true --id n-on
xgg rule edge add --rule-id <rid> --from n-toggle-click:output --to n-is-on:input
xgg rule edge add --rule-id <rid> --from n-is-on:output --to n-off:trigger
xgg rule edge add --rule-id <rid> --from n-is-on:output2 --to n-on:trigger
```

单击/双击/长按分别控制时，为 spec 中实际存在的每个 event 各建一张 `deviceInput`，再分别接动作或 toggle 分支；不要猜 event short-name。

## 时间窗与多路合并

只在时间窗内响应按钮：

```bash
xgg rule node add --rule-id <rid> --type deviceInput \
  --device-did <btn> --device-event click --id n-click
xgg rule node add --rule-id <rid> --type timeRange \
  --start 08:00 --end 22:30 --id n-time
xgg rule node add --rule-id <rid> --type condition --id n-cond
xgg rule edge add --rule-id <rid> --from n-click:output --to n-cond:trigger
xgg rule edge add --rule-id <rid> --from n-time:output --to n-cond:condition
xgg rule edge add --rule-id <rid> --from n-cond:met --to <action-node>:trigger
```

`timeRange.output` 也能直接驱动 event sink，表达“进入窗口时执行一次”：

```bash
xgg rule edge add --rule-id <rid> --from n-time:output --to <action-node>:trigger
```

已实测 start 进入事件和独立窗口状态，没有观察到等价 end 事件。跨午夜的 `mingTextShow` 是 UI 元数据，不等同于运行时证据。

多事件合并：

```bash
xgg rule node add --rule-id <rid> --type signalOr --inputs 3 --id n-any
xgg rule edge add --rule-id <rid> --from n-a:output --to n-any:input0
xgg rule edge add --rule-id <rid> --from n-b:output --to n-any:input1
xgg rule edge add --rule-id <rid> --from n-c:output --to n-any:input2
xgg rule edge add --rule-id <rid> --from n-any:output --to <action-node>:trigger
```

状态合并改用 `logicOr` / `logicAnd`，每个 state input 的 fan-in 仍为 1。

## 延迟循环与模式

延迟关闭：

```bash
xgg rule node add --rule-id <rid> --type delay --duration 5m --id n-delay
xgg rule edge add --rule-id <rid> --from <trigger-node>:output --to n-delay:input
xgg rule edge add --rule-id <rid> --from n-delay:output --to <off-node>:trigger
```

事件循环：

```bash
xgg rule node add --rule-id <rid> --type onLoad --id n-load
xgg rule node add --rule-id <rid> --type loop --interval 30s --id n-loop
xgg rule edge add --rule-id <rid> --from n-load:output --to n-loop:start
xgg rule edge add --rule-id <rid> --from n-loop:output --to <downstream-node>:<event-input-pin>
```

下游 pin 按卡片选，例如 `deviceOutput:trigger`、`deviceGet:input`。`loop` 不是独立入口。若只需一次循环后停止，同一节点 `n-loop:output → n-loop:stop` 是合法有限反馈；lint warning 保留并用日志证明终止。

轮流执行模式：

```bash
xgg rule node add --rule-id <rid> --type modeSwitch --outputs 3 --id n-mode
xgg rule edge add --rule-id <rid> --from <trigger-node>:output --to n-mode:input
xgg rule edge add --rule-id <rid> --from n-mode:output0 --to <mode0-action>:trigger
xgg rule edge add --rule-id <rid> --from n-mode:output1 --to <mode1-action>:trigger
xgg rule edge add --rule-id <rid> --from n-mode:output2 --to <mode2-action>:trigger
```

## 变量与安全探针

变量状态：

```bash
xgg variable create --scope global --id mode --type number --value 0 --name "模式"
xgg rule node add --rule-id <rid> --type varSetNumber \
  --var-scope global --var-id mode --expr '$global.mode + 1' --id n-incr
xgg rule node add --rule-id <rid> --type varChange \
  --var-scope global --var-id mode --var-type number --op gte --threshold 3 --id n-mode-hi
xgg rule edge add --rule-id <rid> --from <trigger-node>:output --to n-incr:input
xgg rule edge add --rule-id <rid> --from n-mode-hi:output --to <action-node>:trigger
```

纯软件 onLoad marker（不驱动物理设备）：

```bash
xgg variable create --scope global --id probeMarker --type number --value 0 --name probeMarker
xgg rule node add --rule-id <rid> --type onLoad --id n-load
xgg rule node add --rule-id <rid> --type varSetNumber \
  --var-scope global --var-id probeMarker --expr '1' --id n-mark
xgg rule edge add --rule-id <rid> --from n-load:output --to n-mark:input
xgg rule layout <rid>
xgg rule validate --rule-id <rid>
xgg rule lint --rule-id <rid> --strict
xgg rule enable <rid>
xgg variable get-value --scope global --id probeMarker
xgg rule logs <rid> --tail 20
```

完成后删除临时规则和变量；删除规则会清理其 `R<rid>` scope，但 global probe 变量需单独 `variable delete`。
