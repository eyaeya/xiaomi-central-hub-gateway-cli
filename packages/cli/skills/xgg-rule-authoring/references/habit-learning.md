# 家庭习惯学习与画像复用

## 目标与边界

这个流程用于新家庭首次使用 XGG、现有自动化缺少生活依据，或用户希望 Agent 先观察再设计规则的场景。目标是：用一张**无物理输出**的网关规则产生可观察行为日志，由独立、持续运行的采集过程在 24 小时至一周内定期拉取并写入项目私有目录，再把直接证据、待确认推断和用户修正整理为后续自动化设计的依据。只有网关规则而没有持久采集时，结果只能称为 best-effort。

准确口径是“覆盖当前网关可发现、声明具备 push/notify 条件且经用户同意的行为与上下文信号”，不是捕获人的全部生活。能力声明只证明候选资格，不证明运行期一定可靠上报；MIoT 没有暴露的行为、无 push 事件、离线设备、摄像头/音频语义和网关已淘汰的日志都不可恢复。

Agent 负责覆盖规划、生命周期、证据解释和向用户求证。CLI 的 `xgg learn plan/start/capture/status/clarify/finish/profile` 共同覆盖单图部署、可恢复采集、回访澄清和画像复用；普通 `rule logs` / `rule trace` 仍只提供有界诊断读取，不能代替 durable journal。只有 `capture` 成功提交 journal/checkpoint/gap，且 `finish` 在停用前完成最终 flush，才能声明相应的长周期落盘证据。任何日志都不能单独证明家庭常住人数、人员身份，或某次状态变化一定由人手动触发。

## 首次对话先确认

在写采集规则前，用简短问题确认：

1. 观察时长：建议先 24 小时，可延长到一周。
2. 是否排除卧室、门锁、摄像头、路由器或其他敏感设备。
3. 是否采环境上下文：分区人在传感器的照度默认纳入；其他设备的温湿度、功率等连续遥测默认不纳入。
4. 私有落盘目录；默认 `<agent-project>/.xgg-private/habit-learning/<session-id>/`。
5. 用户是否接受规则在采集期保持启用，并在回来后先最终拉取、再停用。

用户授权“真实设备可操作”也不等于观察图可以控制设备。观察规则始终禁止 `deviceOutput`、action、property write、`loop` 和 `--allow-no-push`。

## CLI 生命周期与恢复

标准顺序是：

```text
learn plan
→ 人工/Agent 审阅覆盖与隐私
→ learn start（只创建 disabled 图并输出 planId）
→ 明确授权后 learn start --enable --plan-id <reviewed-plan-id>
→ learn capture
→ learn status / capture --follow
→ learn finish
→ 若有问题则 learn clarify
→ 再次 learn finish
→ learn profile
```

对应的命令入口按同一顺序检查：

```bash
xgg learn plan --help
xgg learn start --help
xgg learn capture --help
xgg learn status --help
xgg learn finish --help
xgg learn clarify --help
xgg learn profile --help
```

第一次使用某个子命令前运行 `xgg learn <subcommand> --help`，不要凭旧会话或历史版本猜 flags。各命令的稳定边界如下：

- `plan` 只读 inventory/spec，返回纳入、排除和唯一单图计划；它不创建 study、变量或规则。
- `start` 消费已审阅计划，建立权限受限的私有 study、写前备份、rule-local variables 和一张 disabled 观察规则；计划或 live capability 漂移时 fail closed。启用需要明确授权，并须先通过 spec-aware validation、strict lint 和 readback。
- `capture` 一次调用至少完成一个 crash-consistent 增量批次：只把本 study 规则的内容写入 journal，先 append+fsync journal/gaps，再原子更新 checkpoint；`--follow` 是覆盖 24 小时至一周的持续单写者模式。重复启动、进程崩溃、网络/auth 中断或无磁盘空间都不能静默跳过日志或把 gap 伪装成连续。
- `status` 始终只读，并报告 phase、最后成功 capture、完整性、规则预期状态和待确认问题；每个新 Agent session、进程异常或用户回来时都先运行它。默认同时核对 live graph；认证暂不可用或只需离线恢复时加 `--local-only`，任何模式都不修改网关。
- `finish` 可恢复且顺序固定：规则仍启用时完成最终 capture、fsync journal/gaps、原子提交 checkpoint，然后 disable 并 readback `enable=false`。最终抓取或停用确认失败时保持 `finishing`/degraded 并非零退出；不能越过失败生成“完成”画像。
- `clarify` 把一条带 `recordedAt`、有效时间 `asOf` 和来源的用户修正追加到 `corrections.ndjson`，不覆写早期修正或 raw evidence。区域问题必须让用户查米家 App，不能由 Agent 从活动轨迹猜。
- `profile` 只返回不含原始设备标识的画像与 freshness 判定。默认会读取当前 live graph、inventory/spec 做漂移核对；`--local-only` 只用于离线检查，必定返回不可直接复用。只有 `reusableForRuleAuthoring=true` 的 `current` 画像可作为后续规则证据；`stale`、`expired`、`invalidated` 或 `insufficient` 一律回退为向用户提问或发起新的聚焦观察。
- 画像保存来源 `sourcePlanId`；在线 `profile` 与启用前重规划会强制刷新 MIoT spec，并比较完整计划指纹。同 URN 的枚举含义、单位、值域或能力变化也会阻止复用（`plan-drift`）。旧画像缺少该指纹时返回 `source-plan-unavailable`；不得手填指纹使旧证据看似有效，应重新完成来源核对或采集。

生命周期 checkpoint 使用 `preparing → ready-disabled → observing / observing-degraded → finishing → awaiting-clarification → complete`。不要根据墙钟或对话记忆自行推进 phase，以 `status` 读取的 durable state 为准。

换一个 Agent session 或隔天恢复时，从私有 `handoff.md` 取得准确的 study 目录，先运行：

```bash
xgg learn status --study-dir <private-study-dir> --local-only
```

- `ready-disabled`：再次核对授权，并把 disabled start 输出中已审阅的 `planId` 原样带入 `xgg learn start --study-dir <private-study-dir> --enable --plan-id <reviewed-plan-id>`；不能自行调用通用 `rule enable`。
- `observing` / `observing-degraded`：检查 gaps、last healthy capture 和计划终点；需要续采时运行 `xgg learn capture --study-dir <private-study-dir> --follow`。
- `finishing`：重新运行 `xgg learn finish --study-dir <private-study-dir>`，由 checkpoint 从安全边界续做，不能手工先 disable。
- `awaiting-clarification`：逐设备向用户展示未解析的原始区域代号，按 `xgg learn clarify --help` 的当前参数契约逐条追加，再用同一 `--study-dir` 重跑 `finish`。
- `complete`：用 `xgg learn profile --study-dir <private-study-dir>` 读取 freshness；不要因为 phase complete 就跳过 profile 的可复用性判定。

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

默认纳入：门窗状态、按钮事件、人体/区域存在、灯/插座/窗帘开关或手动事件、家电开始/结束/运行模式。门锁状态只有用户明确同意后才可纳入；含人员、账号或开锁身份的事件/参数继续排除。默认排除：battery、RSSI、fault、配置、累计量、连续功率、路由 client-id、摄像头/音频/通话内容。

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

常规路径由 `learn start` 编译和写入，不让 Agent 手工逐节点拼出另一套观察图。`start` 内部顺序固定：

```text
official local backup + dry-run
→ disabled empty rule and local variables
→ one complete graph write
→ layout
→ validate --spec-aware
→ lint --strict
→ view/readback
→ 保持 ready-disabled
→ 获明确授权后由 start --enable --plan-id <reviewed-plan-id> 重新规划核对并启用
→ baseline/journal/readback smoke
```

`start` 必须把 `--baseline-quiet-ms`、`--baseline-hard-cap-ms` 与 `--debounce-ms` 的实际值写入 start intent/coverage；Agent 应根据目标网关的实测延迟显式选择，未覆盖时也要把 CLI 默认值作为本 session 的冻结参数报告。要求 errors=0、warnings 逐条审计；通常本图也应 warnings=0。至少证明一个 property raw value、一个 event source/link、规则 enable 状态和无设备输出。采集期冻结 node id、spec mapping 和 graph；不要 layout、编辑或重复 enable。若 `start` 中断，先用 `learn status` 读取已落盘阶段和已创建资源，不能把失败当成自动回滚成功。

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
  device-map.private.json
  specs/
  graphs/rule.json
  state.json
  journal.ndjson
  gaps.ndjson
  profile.json
  profile.md
  corrections.ndjson
```

目录必须 `0700`，文件必须 `0600`。若在 Git 项目内，先写本地 `.git/info/exclude` 或使用项目已有私有 ignore，再用 `git check-ignore` 证明；raw DID、设备名、活动、登录码绝不能进入 Git、Issue、PR 或公开 fixture。

`inventory.private.json` 保存冻结 inventory；`device-map.private.json` 保存真实 DID、名称、型号、房间与稳定匿名 `deviceKey` 的本地对应关系，必须在生成澄清问题前写好，供 Agent 在本机向用户指明要查哪台设备。公开或可共享的 profile 只能使用匿名 key。登录码是一次性也不能写入会话文件。

`session.json` 至少保存 study/session/rule/graph ID、durable phase、开始与计划结束时间、`semanticDigest`、`layoutDigest`、预期 enable 状态和待确认区域清单。`state.json` 是 capture-state/checkpoint：保存有界的日志指纹、累计计数、最后成功轮询和完整性状态；`journal.ndjson` 只追加本次学习规则的记录；`gaps.ndjson` 追加重叠丢失、分页上限、网络中断、语义图漂移或意外停用等缺口。`corrections.ndjson` 是用户确认与修正的 append-only 权威记录。`handoff.md` 用不依赖旧对话的文字说明当前 phase、study ID、准确 `--study-dir` 恢复命令、证据边界和回访问题，让新的 Agent session 可以续接；登录码和其他认证材料不得写入其中。

## 采集期与完整性

底层日志是全网关分页流；当前网关日志接口未公开保证 retention、块大小或容量。普通 `rule logs --follow` 只有进程内去重和 stdout，不是可恢复的一周采集器。正式 24 小时至一周观察必须运行 `xgg learn capture --study-dir <private-study-dir> --follow`，并通过 `learn status` 验证 supervisor owner/heartbeat、last healthy capture、checkpoint 和 gaps；只启用规则、只运行一次 capture 或让普通日志 stdout 挂着都不能称为 durable 长周期采集。

长期证据的主路径固定为：增量读取 logs → 筛选本 study 规则 → 原始顺序 append+fsync `journal.ndjson` → append+fsync gaps → 原子更新 checkpoint → 从 journal 派生 observations。写 journal 成功但 checkpoint 更新失败时，恢复必须通过稳定 batch ID 去重并只补交 checkpoint；写失败则保留上次确认的 checkpoint 并报告 degraded。`rule trace` 是基于当前图和有界日志的诊断投影，只用于调查特定 source、分支、链路或计数异常；不能替代 journal、不能作为长期计数主来源，也不能覆盖 graph drift 前的原始证据。

### 先折叠 source transaction，再计行为

同一次设备来源触发通常会产生 source info、source link、`signalOr`/其他聚合器、marker variable 与 counter 等一串支持日志。分析器必须按 rule ID、source node/selector、可观察 transaction/因果顺序和原始行引用，把整条支持链折叠成一个 source transaction：

- source property/event 是 observation 的身份与时间锚点；
- link、聚合器、marker、counter 和其他下游执行行作为 `supportRefs` 保存，只证明本次图传播，不新增生活行为计数；
- 原始 journal 行不删除、不改写，折叠结果反向保存 `rawRefs`；
- 没有可靠 transaction ID 时，不能只凭“时间很近”强行合并；无法区分连续快速触发时标为 ambiguous transaction，并给出计数范围而不是伪精确次数。

一个 source transaction 最多贡献一次该来源的行为 observation。counter 值可以用于诊断采集链是否漏跑，但不能当成家庭行为次数的独立第二票。

学习开始时把当前有效 IANA 时区冻结进 coverage/start intent；`finish`、跨日 routine 和 point-event 日桶必须始终复用该值，不能随下一次 Agent 所在主机变化。零参数按钮等一次性事件按 `source + local date` 保存日桶、首末网关时间、准确计数和 raw evidence refs；画像可用每日首个直接事件形成候选时间窗，但不能把整个观察期压成一个 `event-count` 后再声称掌握跨日规律。

### 状态区间必须 gap-aware

状态持续时间只在连续证据段内计算。日志 overlap 丢失、分页上限、网络中断、解析缺口、规则 disable/re-enable、网关重启或 `semanticDigest` 改变都会切断连续段：

- gap 前仍为 true 的状态只能在最后已知时刻右删失，不能延续到 gap 后；
- gap 后第一条状态只用于 re-anchor；除非有连续证据，不把它解释为一次进入/离开 transition；
- 输出 interval 时保存 segment ID、左右边界是否 censored、相关 gap ID 与 confidence；
- 任何频次、持续时间、路径或作息结论都不得跨 gap 拼接。

用户回来时，顺序不可反：

1. 先运行 `xgg learn status --study-dir <private-study-dir>`；分别核对 durable phase、live `semanticDigest`、`layoutDigest`、规则 ID 和 enable 状态。语义漂移或意外停用先写入 gaps，不能覆盖原证据。`capture` / `capture --follow` 一旦确认 `SEMANTIC_GRAPH_DRIFT`，必须在 gap 落盘后立即用受快照与 mutation lease 保护的 fail-safe disable 停用并 readback，再转入可恢复的 `finishing`；不能让已失去“无物理输出”证明的未知图继续无人值守运行。
2. 运行 `xgg learn finish --study-dir <private-study-dir>`。规则仍启用且语义未漂移时，它必须完成最后一次日志拉取、journal/gap fsync、checkpoint 原子更新和 completeness 落盘；需要 trace 时再从会话 start time 有界扫描。若规则已被意外停用或语义图已经漂移，必须先持久化 `RULE_UNEXPECTEDLY_DISABLED` / `SEMANTIC_GRAPH_DRIFT` gap，再按有缺口的证据收尾，绝不能重新启用或混入漂移后的日志。
3. 正常路径只有 final capture 已提交后才能 disable，并必须 readback `enable=false`。最终抓取的网络/持久化失败保留可恢复 finish checkpoint并返回非零；已持久化的意外停用/语义漂移 gap 则允许生成明确标为 gapped 且非 sufficient 的画像，不能声称连续完整。
4. `finish` 从 observation 生成按设备分组的未映射区域代号问题，并进入 `awaiting-clarification`；Agent 主动请用户打开米家 App 确认实际位置、当前地图和未使用区域，此时不能先生成带猜测的正式画像。
5. 按 `xgg learn clarify --help` 的当前参数契约，把每个用户回答以带 `asOf` 的新记录追加到 `corrections.ndjson`，保留旧修正与 raw evidence 不变，再重新运行 `finish`。
6. `finish` 结合 observations、gaps 和 corrections 原子生成 `profile.json/profile.md`；随后用 `xgg learn profile --study-dir <private-study-dir>` 读取 freshness 和 `reusableForRuleAuthoring`。成功落盘并通过读取后，再单独询问是否 delete rule/raw data。

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
- 每条候选 edge/path 使用用户确认后的语义描述两端，同时保留 raw label、支持 transaction、观察次数、时间窗、替代解释、confidence 及实际采用的 correction IDs；
- gap、未确认区域或仅有一次抖动证据会中断/降低路径置信度，不得被平滑掉；
- 拓扑描述的是传感器区域之间的可观察转移，不代表人员身份、人数或建筑学上的唯一通路。

## 后续 Agent 的读取顺序

以后创建任何家庭自动化前：

1. 对候选 study 运行 `xgg learn profile --study-dir <private-study-dir>`，让命令核对当前 live graph 与 inventory/spec，再读取 freshness `status`、`reusableForRuleAuthoring` 和 reason codes；不要只看文件存在或 phase complete。无网关连接时可加 `--local-only` 检查，但该结果不能授权规则设计。
2. 只有 `status=current` 且 `reusableForRuleAuthoring=true` 时，才读取 `profile.json/profile.md` 作为当前证据；`stale`、`expired`、`invalidated`、`insufficient` 或缺少画像时回退到用户确认或新建聚焦观察。
3. 读取 append-only `corrections.ndjson` 与画像中的 `userConfirmed`、`automationConstraints`。
4. 检查 observed range、coverage、gaps、generatedAt/expiresAt，以及当前 inventory/semantic digest 是否使画像失效。
5. 只有需要复核时才读取原始 journal、source transaction 和 private mapping；这些私有标识不能复制进新规则说明、Issue 或 PR。
6. 新规则的阈值和时段必须引用画像中的 observation/userConfirmed evidence；hypothesis 仍需用户确认，证据不足就询问用户或先做短期补采。

画像不是永久真相。到达 `expiresAt`、采集语义改变、关键设备 inventory 漂移，或家庭成员、家具、区域配置发生变化后，应标记 expired/invalidated 并重新观察。
