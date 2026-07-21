# @eyaeya/xgg-cli

小米中枢网关极客版命令行工具。安装后提供 `xgg` 命令，可登录网关、读取设备/规则/变量、编辑自动化规则图、管理变量与备份，并读取规则运行日志。

## 安装

```bash
npm install -g @eyaeya/xgg-cli
xgg --version
xgg --help
```

要求 Node.js 20.11 或更高版本。`@eyaeya/xgg-cli` 会自动安装匹配版本的 `@eyaeya/xgg-core`，不需要单独安装 core 包。

GitHub 仓库：[eyaeya/xiaomi-central-hub-gateway-cli](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli)。

## 快速使用

```bash
xgg login --code <6位登录码> --base-url http://<gateway-ip>:8086
xgg status
xgg device list --pretty
xgg device get <did> --pretty
xgg rule list --pretty
xgg variable list --pretty
```

6 位登录码来自米家 App 的中枢网关设备页（若中枢网关是路由器或家庭屏自带的，则在对应设备内的中枢网关功能页面获取）。登录码短时有效且通常只能用一次；认证失效或退出码 3 时，请获取新码后重新 `xgg login`。

## AI Agent

Agent 使用时建议设置快照目录：

```bash
export XGG_AGENT_MODE=1
export XGG_SNAPSHOTS_DIR="$PWD/snapshots"
```

完整 Agent 操作说明随 CLI 包一起发布，路径为：

```bash
$(npm root -g)/@eyaeya/xgg-cli/skills/xgg-rule-authoring/SKILL.md
```

同一份文档也可在 GitHub 仓库中的 `skills/xgg-rule-authoring/SKILL.md` 查看。也可以用 [skills CLI](https://github.com/vercel-labs/skills) 一键安装该 Skill：

```bash
npx skills add eyaeya/xiaomi-central-hub-gateway-cli
```

Skill 是一个完整目录，不是单文件提示词。陌生 Agent 首次编写规则必须从入口继续读取 `references/graph-model.md` 与 `references/node-catalog.md`；涉及设备、复杂时序或真实网关操作时，再读取 `device-semantics.md`、`recipes.md`、`operations.md`。尚未发布到 npm 的源码变更要用当前 checkout 的 `node packages/cli/dist/cli.js`，并从同一 checkout 递归同步 Skill；重装全局包不会获得未发布变更。

## 常用流程

```bash
xgg device spec <did> --pretty
xgg rule new --name "<自动化名称>"
xgg rule node add --rule-id <rule-id> --type <type> ...
xgg rule edge add --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule layout <rule-id>
xgg rule validate --rule-id <rule-id> --spec-aware
xgg rule lint --rule-id <rule-id> --strict
```

typed 节点显式 `--id` 只允许 `[A-Za-z0-9]+`，省略时自动生成兼容 ID。旧图 ID 保持可读且会由 validate/lint 列出节点与受影响 edge；export/import 仅为 modeled typed 旧节点补 replay intent，并用分离 endpoint flags 无歧义传递含 `:` 的旧 ID。该 intent 会拒绝 raw/opaque、缺 ID 与已兼容 ID，但 CLI 无法验证 provenance；Agent 只能用它重放既有 typed 节点，不能据此新建 legacy ID。

只有用户授权运行时才继续 `xgg rule enable <rule-id>`，触发后用 `rule logs` 验收；否则用 `rule view` 确认保持 `enable=false`。

`device list/get/spec --pretty` 都显示 spec URN 的稳定 `deviceType` token 和公共 `device-template` 的中文 `deviceTypeDescription`；目录失败会明示并只回退 token，不会误用 `modelName` 或 spec 产品描述，列表对整份清单只加载一次目录。`device spec --pretty` 再按自动化用途分组：事件与 notify 属性对应 `deviceInput` / `deviceInputSetVar`，read 属性对应 `deviceGet` / `deviceGetSetVar`，write 属性与 action 对应 `deviceOutput`；每组内部再分标准与 proprietary/vendor，且排除 `device-information` 元数据。property 会完整显示 selector/URN、raw format、UI 投影 dtype、value-list/range，action input 与 event argument 的 PIID 会解析成 property selector/name/type/domain；`action.out` 只显示为不可绑定的 MIoT 元数据，不代表规则图输出 pin。其他中文语义使用当前 xgg 的 best-effort 优先级：值标签 `multiLanguage → normalization → raw`，service/property/event 名称 `multiLanguage → template → raw`，action 名称 `multiLanguage → raw → template`，action input 属性名 `multiLanguage → raw`；目录失败会在 `Catalog status` 明示并回退。跨 service 重复 short-name 会全部保留；按对应 `siid` 传 `--device-siid` 消歧。长行按 120 个终端显示列完整换行，中文、组合字符、emoji 和长 URN 不会误切或截断。三条 device 命令省略 `--pretty` 时原有紧凑 JSON shape 不变且不请求语义目录，供脚本解析。

复杂分支、条件或循环可用 `xgg rule trace <rule-id>` 查看按步累积的当前图 node/edge 状态；`--node` / `--edge` / `--watch` 可筛 watchpoint，`--since` / `--until` / `--start-step` / `--end-step` / `--max-steps` 可限定范围，`--next-from` 可导航到下一次变化，`--pretty` 输出紧凑时间线。`--max-blocks <N>` 控制从网关源 `getLog` 扫描多少个保留日志块（默认 8）；`--max-steps <N>` 只裁剪扫描、投影后返回的最新 N 帧，不能扩大源扫描。若 JSON 的 `completeness.fetch.boundedByMaxBlocks` 为 `true`，或 `completeness.fetch.stopReason` 为 `max-blocks`，可增大 `--max-blocks <N>` 扫描更宽的保留日志；但增大它仍不能越过网关保留窗口，也不能证明执行完整。默认 JSON 含日志分页停止原因、未解析行计数、扫描/选择边界、节点语义投影丢弃与相对当前图的拓扑漂移；兼容既有机器消费者，语义漂移 reason code 仍为 `bundle-semantic-drift`。输出不回显可能属于其他规则的未解析原文。分页按旧块到新块、块内原序重建且保留合法重复行。节点 info 按当前 xgg 已建模节点逐类型转译；`deviceGet` 按唯一 URN 复用公共 MIoT spec 与语义目录缓存，只为 notify 属性投影 value label，按 `multiLanguage → normalization → raw` 取值，bool 标签也由共享 projector 生成。spec / projector 失败和逐目录 fallback 会写入 semantic metadata，未知值仍显示 raw，并且只公开 URN、不含 DID。trace 是客户端从有界保留日志和当前规则图派生的投影，不是新网关 RPC、设备实时真值或完整执行证明。

`xgg rule view <rule-id> --pretty` 用稳定、有界的 JSON 型摘要展示每个节点的 `inputs`、`props` 与输出拓扑，便于快速审查；字符串带 JSON 引号，number/boolean/null 保持原生类型，数组/对象结构明确，嵌套标量数组保留前若干实际值，省略时会标出数量。表格使用固定列宽并按终端显示宽度换行或截断，中文、组合字符和 emoji 不会按 JavaScript 字符数误切；用于后续命令的 `nodeId` 与精确节点 `type` 始终无损多行显示，不加省略号。机器处理、编辑重放、读取未知或被摘要省略的字段时，必须改用不带 `--pretty` 的默认无损 JSON。

目标化编辑和规则生命周期不需要整图重写：

```bash
xgg rule node update --rule-id <rule-id> --node-id <node-id> --patch '<JSON>'
xgg rule edge remove --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule node remove --rule-id <rule-id> --node-id <node-id> --cascade-edges
xgg rule rename <rule-id> --name "<name>"
xgg rule set-tags <rule-id> --tags "tag1,tag2"
xgg rule delete <rule-id>
```

这些 node/edge/layout/set 写入默认保留 live `enable`；已启用规则的多步修改可能立即生效。先记录状态，会改变执行路径时在授权下 disable/readback，或离线构造后单次原子 `rule set`；验证后只按原状态和用户意图恢复。

CLI 建模 25 种可执行卡片，另支持无连接器的 `nop` 画布备注。typed property 卡会按用途硬检 `notify`（`deviceInput*`）、`read`（`deviceGet*`）或 `write`（property `deviceOutput`）；push source 默认还要求设备 `pushAvailable=true`。`--allow-no-push` 仅允许本次 typed node-add 作为目标网关运行时探针继续，不持久化、不绕过 property access、不证明会发出事件；在线 `validate --spec-aware` 仍把 no-push 记为 error，strict lint 仍给同一 source 的 no-push warning/exit 1。常规规则不得有 error；每条 advisory warning 都必须逐项审计、解释并明确接受，否则视为阻断。只有用户明确授权的隔离临时探针，才可把目标 source 的 spec-aware no-push error 作为唯一允许的 error，并仍逐项审计所有 warning、要求下游仅安全软件 marker、取证后立即 disable/delete。no-push property 仅在有 read 时可由可靠触发驱动 `deviceGet` / `deviceGetSetVar` 降级；event payload/次数/顺序不能被 query 重建，没有等价可靠 source 时应判定无法可靠实现。strict export 会拒绝 access mismatch 与 no-push source；permissive export 对后者明确 warning 并补回 transient flag。设备比较支持 string `--property-value`、整数 `--property-include`，以及事件参数的 repeatable `--event-filter` / `--event-filter-include` / `--event-filter-between`；`--preload|--no-preload` 只适用于 property-mode `deviceInput` / `deviceInputSetVar` 与 `varChange`，`deviceGet` 不支持，且 preload 不会制造缺失的 notify/read 能力。旧 `deviceGet.props.preload` 会让 permissive export 警告、strict export 拒绝。受支持节点上的 preload 与 `--simplified true|false` 会被导出/导入保留。动作 `--params` 的 key 必须与 `action.in` property short-name 一一对应，值保留 MIoT 原生 number / boolean / string，并用 `{"param":{"$var":"global.id"}}` 引用动态变量。

数值 `deviceInput` / `deviceGet` 与 number 型 `varChange` / `varGet` 使用 `--op between` 时，`--threshold <lower>` 和 `--threshold2 <upper>` 必须同时显式给出；省略任一边界会在 session、spec、快照与写图之前失败。显式下界 `0` 合法，非-between 标量比较继续保留历史默认 `0`。

`action.in` 不得重复 PIID，distinct PIID 的 short-name 必须唯一；持久化 `props.ins[i].piid` 必须等于 `action.in[i]`。原生 JSON 类型由 MIoT format 决定，只有数值 format 才应用数值 value-list/value-range/step；bool/string 即使带 numeric value-list 也仍持久化为 boolean/string。无效 range 会拒绝；number 变量必须携带当前 spec 的有效 min/max/step。permissive export 会明确警告不可无损 replay 的旧图，并用索引语义、唯一占位 key 与无原型字典避免乱序、重复名或 `__proto__` 静默丢值；strict export 直接拒绝。


直接 `rule export --format shell` 与从 JSON import 渲染的脚本都要先落盘审阅；JSON import 必须用 `--from-file`：

```bash
export SNAPSHOTS_DIR="$PWD/snapshots"
export SOURCE_BASE_URL="http://<source-gateway>:8086"
export TARGET_BASE_URL="http://<target-gateway>:8086"
xgg rule export <rule-id> --format json --strict-roundtrip \
  --base-url "$SOURCE_BASE_URL" > rule-export.json
xgg rule import --from-file rule-export.json --base-url "$TARGET_BASE_URL" > replay.sh
xgg rule import --from-file rule-export.json --target-id <new-rule-id> \
  --base-url "$TARGET_BASE_URL" > clone.sh
# 审阅最终 enable 行为后再执行 bash replay.sh / bash clone.sh
```

执行前检查两份脚本各自唯一的 `BASE_URL=` 行就是实际目标，且不含 `192.168.x.x` / `<...>` 占位符。冻结其他 writer 后，按 `rule-export.json.externalVariables[]` 的 `id/expectedType` 对目标逐个执行 `variable get-config --scope global --expect-type ... --base-url "$TARGET_BASE_URL"`；全部通过后，same-ID 目标若当前启用，才可记录图/状态并在获授权后 disable + readback，再执行会重复 global preflight 的脚本。因 local prepare 早于 graph staging，失败后先诊断，不自动恢复 enable；完整无 `eval` 循环见随 CLI 发布的 Skill `operations.md`。

生成脚本把 `XGG` 严格当作一个可执行文件路径（默认 `xgg`），不能放入 `node ...` / `pnpm exec ...` 多词命令。需要重放当前源码时先 `pnpm build`，再安全地把 Node 与入口作为两个 argv 元素传入：

```bash
XGG_NODE_ENTRY="/absolute/path/to/xgg/packages/cli/dist/cli.js" \
  NODE_BIN="/absolute/path/to/node" bash replay.sh
```

脚本使用 Bash argv array，不使用 `eval` 或未加引号的拆词；含空格路径保持为单个参数。`NODE_BIN` 可省略并默认使用 PATH 上的 `node`。上述 import 显式把目标 URL 嵌入脚本。若省略 `--base-url`，import 会先读取渲染进程的 `XGG_BASE_URL`；一旦有值就硬编码，执行时 `BASE_URL` 不能覆盖。只有渲染时二者都没有才保留运行时 fallback，且脚本不会从登录 session 推断目标；因此不要依赖隐式分支，始终显式传目标 URL。

脚本先用只读 `variable get-config --expect-type` 断言全部**可发现的 modeled** `global` 外部依赖存在且类型匹配；不比较其值/显示名，也不创建或修改 global。通过后才预检已捕获的本地变量；若导出包含本地变量，same-ID 重放会在 staging 前用兼容性保护准备这些变量，随后第一笔 target-graph write 用 `rule set --allow-cfg-overwrite` 原子写入空图和 `enable=false`（`--target-name` 同时生效）。clone 保留 `--expect-absent`，先建禁用空壳，再准备目标规则变量。旧 JSON 真正无可发现的 global 依赖继续兼容；可发现 global 引用缺少匹配 typed declaration，或 declaration 没有可信 `expectedType` 时，在渲染前 fail closed，需重新导出。node/edge 全程在禁用状态下重建；源规则启用时只在完整组装后执行末尾 `rule enable`，源规则禁用时保持禁用。脚本是逐命令事务，不是 replay-wide lease：执行期间禁止网页、其他 xgg 或 API writer 并发修改目标。预检失败没有写入；same-ID local prepare 若在 staging 前中断，旧图可能仍保持原状（包括 enabled），但可能只创建了部分 local。clone staging 或任一 target-graph staging 后失败才会留下禁用 partial graph。失败后应同时 readback 图/enable 与变量，并用逐写快照恢复。未知未来节点会以 opaque `--cfg` 仅支持同 ID 重放；CLI 不解析其中潜藏的 local/global 引用，所以生成的 preflight 不是完整依赖证明，启用前必须独立审阅并另行证明；含 opaque 节点的 export 不允许 `--target-id` 克隆。

设备扩展与官方格式本地备份：

```bash
xgg device partitions <did> --pretty
xgg rule device replacements --rule-id <rule-id> --node-id <node-id> --pretty
xgg rule device replace --rule-id <rule-id> --node-id <node-id> --target-did <did>
xgg backup local-export --output ./gateway-rules.bak
xgg backup local-import --input ./gateway-rules.bak --dry-run
xgg backup list --from fds --pretty
xgg backup create --from fds --file-name <name> --wait
xgg backup progress --from fds --progress-id <id>
xgg backup cloud-export --from fds --did <did> --ts <ts> --file-name <name> --output ./history.bak --snapshots-dir "$PWD/snapshots"
xgg backup download --from fds --did <did> --ts <ts> --file-name <name> --snapshots-dir "$PWD/snapshots"
xgg backup generate --from fds --did <did> --ts <ts> --file-name <name>
xgg backup load --from fds --did <did> --ts <ts> --file-name <name> --snapshots-dir "$PWD/snapshots"
xgg backup delete --from fds --did <did> --ts <ts> --file-name <name> --snapshots-dir "$PWD/snapshots"
xgg backup config get --from fds
xgg backup config set --from fds --auto-backup <true|false> --auto-backup-limit <N> --snapshots-dir "$PWD/snapshots"
```

Replacement discovery 默认排除 ghost device。显式用 `--target-did` 聚焦 ghost 时，只返回 `eligible:false` 的诊断候选，不生成可应用的 `planId`；`--apply` 会在快照后 fresh 读取设备清单，并在 `setGraph` 前拒绝已经或新近变成 ghost 的目标。

`device partitions` 当前只对已验证型号 `xiaomi.sensor_occupy.p1` 映射 siid 4…35 为 A-1…B-16；其他型号返回空列表，不是通用分区发现。设备替换默认 dry-run；写入必须再加 `--apply --confirm-target-did <did>` 和快照目录。本地 import 是 replace-all，固定先 dry-run；真正恢复必须 `--confirm-replace-all` 并强制 rollback snapshot。

`backup local-import` 接受完整 version-2 `.bak` 和官方旧版 rules-only 数组。旧版数组不含变量；确认执行仍会删除当前全部规则与变量，再只重建旧备份中的规则，所以不会保留当前变量。先在 dry-run 里核对 `createVariables` 等完整计数。

历史云备份导出优先使用 `backup cloud-export`；它自动完成 download、终态进度确认、generate 与官方 `.bak` 原子发布，默认拒绝覆盖已有文件。低层 `backup generate` 仍保留给已经明确完成缓存下载的高级流程。

低层 `generate` 前必须先对相同 `{did,ts,file-name}` 执行 `backup download`；`load` 会在同一 mutation lease 内自动 download、确认缓存终态，再恢复并确认 load 进度。下载状态不确定时不会进入 load；load 返回无可轮询句柄的 ACK 时仍以 `NOT_CONFIRMED` 封锁。`load`、`delete` 和 `backup config set` 都是写操作，需要用户明确授权与 rollback snapshot；完整参数以各子命令 `--help` 为准。

本地候选图可直接用 `xgg rule validate --body candidate.json` 或管道到 `--stdin`。这两种模式默认不读取 session、不连接 daemon/网关，也不访问公网；只有显式添加 `--spec-aware` 才会查询公网 MIoT spec registry，并核对 property 卡的 notify/read/write access、property/event dtype、property-write 的原生 literal/统一数值域/变量 metadata、output ref 的 literal-only 边界，以及 action input 的 missing/extra/duplicate PIID、逐索引顺序、重复 short-name 和同类 literal/变量契约。设备卡图的主验收必须使用 `xgg rule validate --rule-id <rule-id> --spec-aware`；`--rule-id` 会读取已登录网关的规则、带实际 `number|string` 类型的变量清单和一次设备清单，从而追加变量类型与 live `pushAvailable` 诊断。常规业务规则必须让 spec-aware/strict lint errors=0；每条 warning 都要逐项审计、解释并明确接受，未解释或未接受的 warning 视为阻断。合法可解释的 advisory warning 包括已证明可终止的 self-loop、兼容旧节点 ID，以及同 ID 无损保留的 opaque/future 卡片，不能批量忽略。获授权的 no-push 隔离临时探针仍要运行并记录两者，只能容许目标 source 的 spec-aware no-push error；strict lint 的同源 no-push warning/exit 1 也须显式接受。离线 body/stdin 没有变量或设备实例证据，不能证明引用类型或 push 可用。

`deviceOutput --value '$scope.id'` 表示变量引用。若字符串字面值本身以 `$` 开头，把第一个 `$` 写两次：例如 `--value '$$hello'` 实际写入 `$hello`；`rule export` 会自动添加这一层转义。数值 property-write literal 会按 MIoT format 严格解析完整十进制/scientific token：float/double 必须有限，整数必须是精确 safe integer，并检查非空 value-list 与有效 value-range/step。当前 xgg 的 typed variable-ref 契约只支持不含 `value-list` 字段的 string 目标，或不含该字段且带有效 value-range 的 number 目标；boolean 与任何存在 `value-list` 字段的目标（包括空数组）都是 literal-only。默认 `rule enable` 会只对实际存在的 persisted output ref 做聚焦、fail-closed 的 spec 证明；404、网络失败或无效 spec 都会在 enable 写入前停止，但不会把无关旧设备节点纳入完整 spec-aware gate。

`variable create/set-value --value` 按变量类型处理：`number` 使用数值转换；`string` 原样保存收到的 argv 文本。`--value Seed` 保存 `Seed`，而 `--value '"Seed"'` 会把双引号也作为数据保存；不要为字符串额外添加 JSON 引号。

`variable get-config --scope <scope> --id <id>` 读取单个变量配置；加 `--expect-type number|string` 时只读断言存在性/类型，missing 或 mismatch 以 `ConfigError` 非零退出，不比较值或显示名。`variable set-config --scope <scope> --id <id> --name <name>` 只更新显示名，不改类型或当前值，并按其他写命令一样执行 snapshot guard。

规则变量 scope 只有两类是编辑器可见的：`global`，以及当前规则的 `R<rule-id>`。变量写命令会用在线规则清单识别现存的 `R<id>`，`rule node add` 则只把与自身 `--rule-id` 精确匹配的 `R<id>` 视为本地 scope；正常本地变量流程不需要 `--allow-unknown-scope`。在线规则写入与 validate 按每个可发现的引用点核对清单中的实际 `number|string` 类型；`varSetString` 目标必须是 string，其拼接 operand 按当前 xgg 契约可引用 number 或 string。跨规则、不存在、自定义 scope 或类型不匹配都会在写入/校验时失败。strict export 也会在任何 staging 前读取源网关可发现的 modeled local/global 变量并拒绝同类不匹配或缺失 global；opaque `--cfg` 不在该证明范围内。permissive export 则输出路径化 warning。`--no-var-check` 只跳过在线存在性/实际类型清单，不放宽合法 scope、schema、spec-aware 或 enable 的 canonical-output gate。

克隆规则时，CLI 只把 `R<source-id>` 规则内变量迁移到 `R<target-id>`，先只读断言全部可发现的 modeled `global` 依赖存在且类型匹配，再预检完整的已捕获本地变量计划；随后以 `expect-absent` 创建空目标规则，确认目标 ID 未被占用后才准备本地变量、节点和边。含 opaque 节点时会直接拒绝 clone，因为无法证明或改写其内部变量引用。只有源规则启用时才在脚本末尾追加 enable。已有目标（包括预检期间新出现的目标）会在任何变量/规则写入前停止，且永不覆盖。已有目标本地变量只有在类型、当前值和显示名完全兼容时才保留；真实创建仍会重新检查变量竞态。网关没有 replay-wide/cross-variable transaction，预检后并发变量漂移仍可能让脚本中途停止，可用每次写前生成的 snapshot 恢复。`global` 变量不会被创建或改写。

默认 stdout 输出 JSON，适合脚本和 Agent 解析；加 `--pretty` 输出人读表格。`rule trace` 也遵循此约定。例外：`rule logs` 默认输出人读表格，需要 JSON 时显式加 `--json`。

Skill 正文包含可 grep 的 `xgg-skill-content-build` 标记。摘要覆盖按相对 POSIX 路径排序的整个 Skill 文件树；每项按“路径、字节长度、原始字节”入 hash，只有 `SKILL.md` 的 marker 行及其换行不参与计算。测试会拒绝正文或任一 reference 变化但摘要未更新的陈旧标记，并保证仓库与 npm 包内的整个 Skill 目录字节一致。安装或升级后仍应递归比较包内与已安装目录；marker 相同只能快速识别内容版本，不能替代完整目录校验。

复制安装后，用递归 diff 校验 `SKILL.md` 与 `references/` 都一致：

```bash
CLI_SKILL="$(npm root -g)/@eyaeya/xgg-cli/skills/xgg-rule-authoring"
diff -qr "$CLI_SKILL" ~/.agents/skills/xgg-rule-authoring
diff -qr "$CLI_SKILL" ~/.claude/skills/xgg-rule-authoring
```

## 注意

CLI 写入后，已打开的网关网页需要手动刷新才能看到新规则或变量。npm 包内的 CLI、core 与 Skill 是自包含的，不依赖仓外参考文件、开发计划或本地探测材料。

验证证据要分层理解：当前 xgg 的 help/schema/validator/projector/unit/integration test 证明命令、canonical wire、pin、序列化和静态分析，但不证明固件 executor；既有安全实机探针只证明当时目标固件上的对应观察。具体 property/event/action、时序/reset、内部状态持久性、分区型号、设备替换和恢复仍必须在目标网关按 spec、lint、日志与 readback 单独验收。
