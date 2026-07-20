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

只有用户授权运行时才继续 `xgg rule enable <rule-id>`，触发后用 `rule logs` 验收；否则用 `rule view` 确认保持 `enable=false`。

`device list/get/spec --pretty` 都显示 spec URN 的稳定 `deviceType` token 和公共 `device-template` 的中文 `deviceTypeDescription`；目录失败会明示并只回退 token，不会误用 `modelName` 或 spec 产品描述，列表对整份清单只加载一次目录。`device spec --pretty` 再按自动化用途分组：事件与 notify 属性对应 `deviceInput` / `deviceInputSetVar`，read 属性对应 `deviceGet` / `deviceGetSetVar`，write 属性与 action 对应 `deviceOutput`；每组内部再分标准与 proprietary/vendor，且排除 `device-information` 元数据。property 会完整显示 selector/URN、raw format、UI 投影 dtype、value-list/range，action input 与 event argument 的 PIID 会解析成 property selector/name/type/domain；`action.out` 只显示为不可绑定的 MIoT 元数据，不代表规则图输出 pin。其他中文语义使用 best-effort 的 Bundle 优先级：值标签 `multiLanguage → normalization → raw`，service/property/event 名称 `multiLanguage → template → raw`，action 名称 `multiLanguage → raw → template`，action input 属性名 `multiLanguage → raw`；目录失败会在 `Catalog status` 明示并回退。跨 service 重复 short-name 会全部保留；按对应 `siid` 传 `--device-siid` 消歧。长行按 120 个终端显示列完整换行，中文、组合字符、emoji 和长 URN 不会误切或截断。三条 device 命令省略 `--pretty` 时原有紧凑 JSON shape 不变且不请求语义目录，供脚本解析。

复杂分支、条件或循环可用 `xgg rule trace <rule-id>` 查看按步累积的当前图 node/edge 状态；`--node` / `--edge` / `--watch` 可筛 watchpoint，`--since` / `--until` / `--start-step` / `--end-step` / `--max-steps` 可限定范围，`--next-from` 可导航到下一次变化，`--pretty` 输出紧凑时间线。默认 JSON 含日志分页停止原因、未解析行计数、扫描/选择边界、Bundle 语义丢弃与相对当前图的拓扑漂移，但不回显可能属于其他规则的未解析原文。分页按旧块到新块、块内原序重建且保留合法重复行。节点 info 按 Bundle 逐类型转译；`deviceGet` 按唯一 URN 复用公共 MIoT spec 与语义目录缓存，只为 notify 属性投影 value label，按 `multiLanguage → normalization → raw` 取值，bool 标签也由共享 projector 生成。spec / projector 失败和逐目录 fallback 会写入 semantic metadata，未知值仍显示 raw，并且只公开 URN、不含 DID。trace 是客户端从有界保留日志和当前规则图派生的投影，不是新网关 RPC、设备实时真值或完整执行证明。

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

CLI 建模 25 种可执行卡片，另支持无连接器的 `nop` 画布备注。设备比较支持 string `--property-value`、整数 `--property-include`，以及事件参数的 repeatable `--event-filter` / `--event-filter-include` / `--event-filter-between`；`--preload|--no-preload` 只适用于 property-mode `deviceInput` / `deviceInputSetVar` 与 `varChange`，`deviceGet` 不支持。旧 `deviceGet.props.preload` 会让 permissive export 警告、strict export 拒绝。受支持节点上的 preload 与 `--simplified true|false` 会被导出/导入保留。动作 `--params` 的 key 必须与 `action.in` property short-name 一一对应，值保留 MIoT 原生 number / boolean / string，并用 `{"param":{"$var":"global.id"}}` 引用动态变量。

数值 `deviceInput` / `deviceGet` 与 number 型 `varChange` / `varGet` 使用 `--op between` 时，`--threshold <lower>` 和 `--threshold2 <upper>` 必须同时显式给出；省略任一边界会在 session、spec、快照与写图之前失败。显式下界 `0` 合法，非-between 标量比较继续保留历史默认 `0`。

`action.in` 不得重复 PIID，distinct PIID 的 short-name 必须唯一；持久化 `props.ins[i].piid` 必须等于 `action.in[i]`。原生 JSON 类型由 MIoT format 决定，只有数值 format 才应用数值 value-list/value-range/step；bool/string 即使带 numeric value-list 也仍持久化为 boolean/string。无效 range 会拒绝；number 变量必须携带当前 spec 的有效 min/max/step。permissive export 会明确警告不可无损 replay 的旧图，并用索引语义、唯一占位 key 与无原型字典避免乱序、重复名或 `__proto__` 静默丢值；strict export 直接拒绝。


直接 `rule export --format shell` 与从 JSON import 渲染的脚本都要先落盘审阅；JSON import 必须用 `--from-file`：

```bash
export SNAPSHOTS_DIR="$PWD/snapshots"
xgg rule export <rule-id> --format json --strict-roundtrip > rule-export.json
xgg rule import --from-file rule-export.json > replay.sh
xgg rule import --from-file rule-export.json --target-id <new-rule-id> > clone.sh
# 审阅最终 enable 行为后再执行 bash replay.sh / bash clone.sh
```

脚本先只读预检已捕获的本地变量；若导出包含本地变量，same-ID 重放会在 staging 前用兼容性保护准备这些变量，随后第一笔 target-graph write 用 `rule set --allow-cfg-overwrite` 原子写入空图和 `enable=false`（`--target-name` 同时生效）。clone 保留 `--expect-absent`，先建禁用空壳，再准备目标规则变量。node/edge 全程在禁用状态下重建；源规则启用时只在完整组装后执行末尾 `rule enable`，源规则禁用时保持禁用。脚本是逐命令事务，不是 replay-wide lease：执行期间禁止网页、其他 xgg 或 API writer 并发修改目标；staging 后失败会留下禁用 partial graph，用逐写快照恢复。未知未来节点会以 opaque `--cfg` 仅支持同 ID 重放；因无法安全重写其内部引用，含 opaque 节点的 export 不允许 `--target-id` 克隆。

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

本地候选图可直接用 `xgg rule validate --body candidate.json` 或管道到 `--stdin`。这两种模式默认不读取 session、不连接 daemon/网关，也不访问公网；只有显式添加 `--spec-aware` 才会查询公网 MIoT spec registry，并核对 property/event dtype 以及 action input 的 missing/extra/duplicate PIID、逐索引顺序、重复 short-name、literal 原生类型/统一数值域、变量 dtype/有效 range。设备 action 图的主验收必须使用 `xgg rule validate --rule-id <rule-id> --spec-aware`；`--rule-id` 会读取已登录网关的规则和变量。

`deviceOutput --value '$scope.id'` 表示变量引用。若字符串字面值本身以 `$` 开头，把第一个 `$` 写两次：例如 `--value '$$hello'` 实际写入 `$hello`；`rule export` 会自动添加这一层转义。

`variable create/set-value --value` 按变量类型处理：`number` 使用数值转换；`string` 原样保存收到的 argv 文本。`--value Seed` 保存 `Seed`，而 `--value '"Seed"'` 会把双引号也作为数据保存；不要为字符串额外添加 JSON 引号。

`variable get-config --scope <scope> --id <id>` 读取单个变量配置；`variable set-config --scope <scope> --id <id> --name <name>` 只更新显示名，不改类型或当前值，并按其他写命令一样执行 snapshot guard。

规则变量 scope 只有两类是编辑器可见的：`global`，以及当前规则的 `R<rule-id>`。变量写命令会用在线规则清单识别现存的 `R<id>`，`rule node add` 则只把与自身 `--rule-id` 精确匹配的 `R<id>` 视为本地 scope；正常本地变量流程不需要 `--allow-unknown-scope`。跨规则、不存在或自定义 scope 仍会告警，并在严格规则校验中失败。

克隆规则时，CLI 只把 `R<source-id>` 规则内变量迁移到 `R<target-id>`，先只读预检完整变量计划，再以 `expect-absent` 创建空目标规则，确认目标 ID 未被占用后才准备本地变量、节点和边；只有源规则启用时才在脚本末尾追加 enable。已有目标（包括预检期间新出现的目标）会在任何变量/规则写入前停止，且永不覆盖。已有目标变量只有在类型、当前值和显示名完全兼容时才保留；真实创建仍会重新检查变量竞态。网关没有跨变量事务，并发变量修改仍可能让脚本中途停止，可用每次写前生成的 snapshot 恢复。`global` 变量作为明确的外部依赖保留，必须由目标网关预先提供。

默认 stdout 输出 JSON，适合脚本和 Agent 解析；加 `--pretty` 输出人读表格。`rule trace` 也遵循此约定。例外：`rule logs` 默认输出人读表格，需要 JSON 时显式加 `--json`。

Skill 正文包含可 grep 的 `xgg-skill-content-build` 标记，其中内嵌除标记行及其换行外完整 `SKILL.md` UTF-8 字节的 SHA-256，测试会拒绝正文变化但摘要未更新的陈旧标记。安装或升级后可对比包内与已安装的标记；不同表示虽然 npm 版本号可能相同，Skill 内容仍未同步。仓库与 npm 包内的整个 Skill 目录由测试保证字节一致；`references/` 仍应通过完整目录递归比较确认。

复制安装后，用递归 diff 校验 `SKILL.md` 与 `references/` 都一致：

```bash
CLI_SKILL="$(npm root -g)/@eyaeya/xgg-cli/skills/xgg-rule-authoring"
diff -qr "$CLI_SKILL" ~/.agents/skills/xgg-rule-authoring
diff -qr "$CLI_SKILL" ~/.claude/skills/xgg-rule-authoring
```

## 注意

CLI 写入后，已打开的网关网页需要手动刷新才能看到新规则或变量。npm 包不包含 GitHub 仓库里的官方前端参考 bundle、fixtures、开发计划或本地探测材料。

验证证据要分层理解：CLI help/schema/unit/integration test 证明命令与序列化；安全实机探针已经覆盖 `condition` 默认 false 的 `unmet`、可终止 self-loop、`timeRange` 窗口进入事件；具体 property/event/action、分区型号、设备替换和恢复仍必须在目标网关按 spec、lint、日志与 readback 单独验收，不代表所有场景都已实机执行。
