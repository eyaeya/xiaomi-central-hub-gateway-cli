# 家庭习惯学习与画像复用

## 目标与边界

这个流程用于新家庭首次使用 XGG、现有自动化缺少生活依据，或用户希望 Agent 先观察再设计规则的场景。目标是：用一张**无物理输出**的网关规则产生可观察行为日志，由独立、持续运行的采集过程在 24 小时至一周内定期拉取并写入项目私有目录，再把直接证据、待确认推断和用户修正整理为后续自动化设计的依据。只有网关规则而没有持久采集时，结果只能称为 best-effort。

准确口径是“覆盖当前网关可发现、声明具备 push/notify 条件且经用户同意的行为与上下文信号”，不是捕获人的全部生活。能力声明只证明候选资格，不证明运行期一定可靠上报；MIoT 没有暴露的行为、无 push 事件、离线设备、摄像头/音频语义和网关已淘汰的日志都不可恢复。

Agent 负责覆盖规划、生命周期、证据解释和向用户求证。当前 CLI 的 `xgg learn plan` 只读扫描 live inventory/spec，并输出带 reason code 的单图覆盖计划；先运行一次查看房间/设备 ID，取得用户选择后再用 `--exclude-room <room-id...>`、`--exclude-device <did...>` 重新规划。`rule logs` / `rule trace` 仍只提供有界读取，不应被描述成自动、可恢复的长期采集；只有另行运行的持久采集过程完成 journal、checkpoint、gap 和最终 flush 后，才能声明对应落盘证据。任何日志都不能单独证明家庭常住人数、人员身份，或某次状态变化一定由人手动触发。

## 首次对话先确认

在写采集规则前，用简短问题确认：

1. 观察时长：建议先 24 小时，可延长到一周。
2. 是否排除卧室、门锁、摄像头、路由器或其他敏感设备。
3. 是否采环境上下文：分区人在传感器的照度默认纳入；其他设备的温湿度、功率等连续遥测默认不纳入。
4. 私有落盘目录；默认 `<agent-project>/.xgg-private/habit-learning/<session-id>/`。
5. 用户是否接受规则在采集期保持启用，并在回来后先最终拉取、再停用。

用户授权“真实设备可操作”也不等于观察图可以控制设备。观察规则始终禁止 `deviceOutput`、action、property write、`loop` 和 `--allow-no-push`。

## 覆盖计划

先运行 `xgg learn plan --pretty` 读 live inventory 和每台设备的 spec。为每个候选保存 included/excluded 与 reason code，不要只列成功项；`--include-context` 仅在用户同意普通环境上下文后使用，敏感项与用户排除项必须先复核。机器计划只使用当前 schema 的以下精确 reason code：

```text
device-offline
device-ghost
device-no-spec-access
device-push-unavailable
user-excluded
spec-fetch-failed
semantic-catalog-fallback
property-not-notify
sample-only-not-behavior
configuration-or-diagnostic
duration-default-excluded
high-frequency-default-excluded
default-policy-excluded
sensitive-default-excluded
event-argument-unresolved
capture-dtype-unsupported
context-default-deferred
included-p0-behavior
included-p1-context
```

默认纳入：门锁/门窗状态、按钮事件、人体/区域存在、灯/插座/窗帘开关或手动事件、家电开始/结束/运行模式。默认排除：battery、RSSI、fault、配置、累计量、连续功率、路由 client-id、摄像头/音频/通话内容。

### 覆盖必须分三层报告

单图是部署与生命周期约束，不是覆盖结论。`coverage.json` 必须同时给出三个互不替代的层级，既保存计数也保存逐项明细：

- **设备覆盖：** live inventory 中可见设备总数，以及 included、excluded、实际出现非 baseline transaction、仅 baseline、ambiguous、missing 的设备；每个排除项保留 reason code。
- **房间覆盖：** inventory 中每个房间及未分配房间的设备数、候选信号数、纳入信号数和实际出现信号数；用户排除的房间必须仍出现在分母与排除明细里。
- **信号覆盖：** observable、included、expected-preload、baseline-seen、behavior-seen、baseline-only、ambiguous、missing 和 excluded 的 signal ID 集合及数量。

规划覆盖与观察覆盖要分开：前者回答“图里准备采什么”，后者回答“观察窗里实际看见什么”。不得只给一个合并百分比，也不得因所有 included signal 都在同一 `graph` 就声称“全屋完整”；离线、无 spec/push、隐私排除、日志保留丢失和观察窗内未出现都限制结论。

### 分区人在传感器是完整语义单元

不能只采整体有人/无人。对每台分区人在传感器至少纳入当前 spec 中具备 notify/push 条件的完整信号集合：

- 整体 occupancy 状态；
- **全部**分区 occupancy 状态；
- 设备整体以及每个分区 service 暴露的**全部** illumination；
- spec 提供的全部区域进入/离开事件及其每个可解析参数；
- 若有 `people-num`，作为“瞬时传感器人数估计”纳入，但不能解释为家庭人数。

设备常只暴露 `A-1`、`A-2`、`B-1` 或 `Zone-1` 等代号。原样冻结 node→代号→SIID/PIID 映射；不要在采集前猜“床边”“门口”。用户回来时必须主动请其打开米家 App，确认代号对应的实际位置、当前启用的地图以及未使用区域。

`has-someone-duration` / `no-one-duration` 若持续 notify，可能造成日志风暴。默认用 occupancy 状态切换的时间戳推导区间；只有明确测得通知频率可接受且用户需要原生计数时才纳入。

### 默认一张统一图

同一次家庭学习的规划结果只有单数 `graph`，并只写入一张规则图；不得生成预分片 `shards`，不得按来源数量、房间、P0/P1 优先级、16 路估算或 A/B 区拆图。统一图完整保留同一设备的区域集合，也便于一次 trace、一次启停和一份 node mapping。

“运行容量尚未实测”只能记录为 limitation，不能成为自动拆图或静默丢弃信号的理由。只有目标网关对完整单图返回可复现的容量/运行错误，Agent 保存错误和图摘要、将计划标为 blocked，并再次取得用户对多图例外的明确同意后，才可讨论拆分；拆分时仍要证明没有漏掉原计划的任何信号。

## 安全图形

property 原始值用 `deviceInputSetVar(property)` 写 rule-local number/string 变量；event 参数用 `deviceInputSetVar(event)`；零参数 event 用 `deviceInput(event)`。默认让每个 property、每个 event argument 对应一个专用、稳定的 local variable，并把 node id、selector 和 variable id 一起冻结；不能用共享 scratch variable 覆盖不同来源的历史身份。只有单图在目标网关出现可复现的资源错误、用户同意例外，且实测证明日志仍能无歧义关联 source node 时，才可考虑复用变量。

### Baseline 是协议，不是固定时间窗

状态源可以 `preload=true` 请求启动基线，事件源没有 preload。baseline 必须绑定本次 enable 边界与图中明确的 expected-preload source 集合：

1. 保存 enable request、ack、规则启用日志与 readback 的时间；优先使用网关可观察的启用边界，只有上下界时就保留不确定区间。
2. 从最终 readback 图枚举所有 `preload=true` 的 property source，冻结为 expected-preload 集合。
3. 从 enable 边界开始接收日志；所有 expected source 已到达即可结束，否则在“连续没有新 expected source”的 quiet period 后结束，但必须受 hard cap 限制。
4. quiet period 与 hard cap 都是本 session 显式记录的参数，应依据实测日志延迟选择；不能固定为 5 秒，也不能把首次拉取的全部日志都标成 baseline。
5. 只有可关联到 expected source 与本次启用边界的 preload transaction 才标为 `baseline`。hard cap 到期仍未到达的是 `missing`；顺序、边界或迟到 preload 无法判定的是 `ambiguous`。真实 event 或边界后的 property change 不因出现在首轮拉取中就自动降为 baseline。

baseline、missing、ambiguous 都不能计作用户行为。报告必须保存 expected/seen/missing/ambiguous 的 source ID 明细，而不是只有总数。

零参数 event 和需要显式传播证据的 event 可进入一个 `signalOr`，再驱动 rule-local `varSetNumber` 计数器。property capture 本身有变量副作用，允许 `outputs.output=[]`。全图变量只用 `R<rule-id>`，不污染 global。

构建顺序固定：

```text
official local backup + dry-run
→ disabled empty rule and local variables
→ one complete graph write
→ layout
→ validate --spec-aware
→ lint --strict
→ view/readback
→ enable only with explicit authorization
→ baseline/log/readback smoke
```

要求 errors=0、warnings 逐条审计；通常本图也应 warnings=0。至少证明一个 property raw value、一个 event source/link、规则 enable 状态和无设备输出。采集期冻结 node id、spec mapping 和 graph；不要 layout、编辑或重复 enable。

图摘要必须拆成两个用途不同的 digest：

- `semanticDigest` 覆盖执行节点类型与配置、source selector、pin/edge、变量绑定及其他会改变采集含义的字段；忽略坐标、宽高、极简展示和 `nop` 等纯展示状态。
- `layoutDigest` 覆盖坐标、宽高、极简展示、`nop` 与其他画布表现字段。

semantic digest 改变会终止当前连续证据段，并要求记录 gap、重新审计覆盖与 baseline；只有 layout digest 改变时记录展示漂移，但不能伪报成采集语义变化。未知字段无法可靠分类时 fail closed：纳入 semantic digest 或明确标记 digest incomplete，不能猜它只是布局。

## 私有落盘

默认布局：

```text
.xgg-private/habit-learning/<session-id>/
  handoff.md
  session.json
  plan.json
  coverage.json
  inventory.private.json
  specs/
  graphs/rule.json
  state.json
  journal.ndjson
  gaps.ndjson
  completeness.json
  profile.json
  profile.md
  corrections.ndjson
  corrections.md
```

目录必须 `0700`，文件必须 `0600`。若在 Git 项目内，先写本地 `.git/info/exclude` 或使用项目已有私有 ignore，再用 `git check-ignore` 证明；raw DID、设备名、活动、登录码绝不能进入 Git、Issue、PR 或公开 fixture。

`inventory.private.json` 保存 DID/真实名称/node mapping；公开或可共享的 profile 使用稳定匿名 key。登录码是一次性也不能写入会话文件。

`session.json` 至少保存 session/rule/graph ID、开始与计划结束时间、`semanticDigest`、`layoutDigest`、预期 enable 状态、下一步操作和待确认区域清单。`state.json` 是 capture-state/checkpoint：保存有界的日志指纹、累计计数、最后成功轮询和完整性状态；`journal.ndjson` 只追加本次学习规则的记录；`gaps.ndjson` 追加重叠丢失、分页上限、网络中断、语义图漂移或意外停用等缺口。`corrections.ndjson` 是用户确认与修正的 append-only 权威记录，`corrections.md` 只是可重新生成的人读视图。`handoff.md` 用不依赖旧对话的文字说明当前状态、恢复步骤、证据边界和回访问题，让新的 Agent session 可以续接。

## 采集期与完整性

底层日志是全网关分页流；当前网关日志接口未公开保证 retention、块大小或容量。普通 `rule logs --follow` 只有进程内去重和 stdout，不是可恢复的一周采集器。若没有另外运行并验证过的持久采集过程，就明确把试验标为 best-effort，并建议先做 24 小时，不能直接承诺一周完整。

长期证据的主路径固定为：增量读取 logs → 原始顺序写入 `journal.ndjson` → 原子更新 checkpoint → 从 journal 派生 observations。`rule trace` 是基于当前图和有界日志的诊断投影，只用于调查特定 source、分支、链路或计数异常；不能替代 journal、不能作为长期计数主来源，也不能覆盖 graph drift 前的原始证据。

### 先折叠 source transaction，再计行为

同一次设备来源触发通常会产生 source info、source link、`signalOr`/其他聚合器、marker variable 与 counter 等一串支持日志。分析器必须按 rule ID、source node/selector、可观察 transaction/因果顺序和原始行引用，把整条支持链折叠成一个 source transaction：

- source property/event 是 observation 的身份与时间锚点；
- link、聚合器、marker、counter 和其他下游执行行作为 `supportRefs` 保存，只证明本次图传播，不新增生活行为计数；
- 原始 journal 行不删除、不改写，折叠结果反向保存 `rawRefs`；
- 没有可靠 transaction ID 时，不能只凭“时间很近”强行合并；无法区分连续快速触发时标为 ambiguous transaction，并给出计数范围而不是伪精确次数。

一个 source transaction 最多贡献一次该来源的行为 observation。counter 值可以用于诊断采集链是否漏跑，但不能当成家庭行为次数的独立第二票。

### 状态区间必须 gap-aware

状态持续时间只在连续证据段内计算。日志 overlap 丢失、分页上限、网络中断、解析缺口、规则 disable/re-enable、网关重启或 `semanticDigest` 改变都会切断连续段：

- gap 前仍为 true 的状态只能在最后已知时刻右删失，不能延续到 gap 后；
- gap 后第一条状态只用于 re-anchor；除非有连续证据，不把它解释为一次进入/离开 transition；
- 输出 interval 时保存 segment ID、左右边界是否 censored、相关 gap ID 与 confidence；
- 任何频次、持续时间、路径或作息结论都不得跨 gap 拼接。

用户回来时，顺序不可反：

1. 读取 `session.json`，分别核对 live `semanticDigest`、`layoutDigest`、规则 ID 和 enable 状态；语义漂移或意外停用先写入 gaps，不能覆盖原证据。
2. 在规则仍启用时完成最后一次日志拉取、journal fsync、checkpoint 原子更新和 completeness 落盘；需要 trace 时从会话 start time 扫描，并递增 `--max-blocks` 直到 stop reason 不再是 `max-blocks`。
3. 然后 disable，readback `enable=false`。
4. 从 observation 生成按设备分组的未映射区域代号问题，主动请用户打开米家 App 确认实际位置、当前地图和未使用区域；此时不能先生成带猜测的正式画像。
5. 把用户回答以带 `asOf` 的新记录追加到 `corrections.ndjson`，保留旧修正与 raw evidence 不变，再生成 `corrections.md` 视图。
6. 结合 observations、gaps 和 corrections 生成 `profile.json/profile.md`；成功落盘后，再单独询问是否 delete rule/raw data。

空日志不证明行为没发生。`empty-block` 只说明本次扫描触到当前接口末端；`gateway-retention-unknown` 始终保留。图漂移、未解析行、max-block、网络中断和意外停用都必须进入 gaps/completeness 元数据，不能混入上面的 coverage reason code。

## 分析纪律

画像分四层：

1. `observations`：日志直接支持的时间、值、频次、序列与持续区间。
2. `hypotheses`：推断、置信度、替代解释和需要用户确认的问题。
3. `userConfirmed`：用户确认的区域语义、人数、作息或修正；每条都引用 append-only correction。
4. `automationConstraints`：禁止自动化的设备、时段、动作和隐私偏好。

典型限制：

- occupancy 可能来自人、宠物、访客或误报；
- 多房间同时活动不必然代表多人；
- `people-num` 是瞬时传感器估计，不是常住人数；
- 不得把多个房间的 occupancy overlap 相加、取峰值或与 `people-num` 组合来推断家庭人数；
- 灯/窗帘/家电状态可能来自既有自动化、设备策略或远程操作；
- 没有发生的行为只表示观察窗内未见，不能证明家庭永远不用该设备。

先计算可复核事实，再提问：哪些区域是床边/门口/书桌？哪张 map 生效？哪些区域未配置？家庭常住人数和宠物情况是什么？每条回答以独立 correction 追加，至少包含稳定 `correctionId`、`recordedAt`、语义生效时间 `asOf`、subject、value、确认来源与可选 `supersedes`。若用户只确认“当前 App 所示”，`asOf` 就是本次确认时刻；除非用户进一步确认观察期间映射未变化，不能把当前区域语义追溯套用到整个历史窗口。profile 中的 `userConfirmed` 是这些 append-only 记录按 as-of 计算出的视图，不得覆写旧确认或 raw evidence。

### 从分区语义形成候选拓扑

只有在区域代号已有适用于对应观察时段的 `userConfirmed` 映射后，才能从同一 continuous segment 内的 source transaction 推导房间/区域候选拓扑路径。推导必须容忍传感器抖动与视野重叠：

- 重复同值、短暂 off/on、相邻区域同时 occupancy、进入/离开事件延迟都先按有记录的 debounce/overlap 容忍参数归并；
- 同时活跃区域表示一个区域集合或不确定边，不强行排成唯一严格序列；
- 每条候选 edge/path 保存支持 transaction、观察次数、时间窗、替代解释和 confidence；
- gap、未确认区域或仅有一次抖动证据会中断/降低路径置信度，不得被平滑掉；
- 拓扑描述的是传感器区域之间的可观察转移，不代表人员身份、人数或建筑学上的唯一通路。

## 后续 Agent 的读取顺序

以后创建任何家庭自动化前：

1. 查找最新未过期的 `profile.json/profile.md`；
2. 读取 append-only `corrections.ndjson`、其 `corrections.md` 视图和 `automationConstraints`；
3. 检查 observed range、coverage、gaps、generatedAt/expiresAt；
4. 只有需要复核时才读取原始 journal、source transaction 和 private mapping；
5. 新规则的阈值和时段必须引用画像证据，证据不足就询问用户或先做短期补采。

画像不是永久真相。家庭成员、家具、区域配置或设备变化后应标记过期并重新观察。
