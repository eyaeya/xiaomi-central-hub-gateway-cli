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
xgg device spec <did>
xgg rule new --name "<自动化名称>"
xgg rule node add --rule-id <rule-id> --type <type> ...
xgg rule edge add --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule layout <rule-id>
xgg rule validate --rule-id <rule-id>
xgg rule lint --rule-id <rule-id> --strict
```

只有用户授权运行时才继续 `xgg rule enable <rule-id>`，触发后用 `rule logs` 验收；否则用 `rule view` 确认保持 `enable=false`。

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

CLI 建模 25 种可执行卡片，另支持无连接器的 `nop` 画布备注。设备比较支持 string `--property-value`、整数 `--property-include`，以及事件参数的 repeatable `--event-filter` / `--event-filter-include` / `--event-filter-between`；`--preload|--no-preload` 与 `--simplified true|false` 会被导出/导入保留。动作 `--params` 保留 MIoT 原生 number / boolean / string，并用 `{"param":{"$var":"global.id"}}` 引用动态变量。

`deviceInput` / `deviceGet --force-out-of-range` 只跳过数值 range/step 检查，不绕过 value-list、finite/safe-integer、operator 或 operand shape 校验。

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
xgg backup download --from fds --did <did> --ts <ts> --file-name <name> --snapshots-dir "$PWD/snapshots"
xgg backup generate --from fds --did <did> --ts <ts> --file-name <name>
xgg backup load --from fds --did <did> --ts <ts> --file-name <name> --snapshots-dir "$PWD/snapshots"
xgg backup delete --from fds --did <did> --ts <ts> --file-name <name> --snapshots-dir "$PWD/snapshots"
xgg backup config get --from fds
xgg backup config set --from fds --auto-backup <true|false> --snapshots-dir "$PWD/snapshots"
```

`device partitions` 当前只对已验证型号 `xiaomi.sensor_occupy.p1` 映射 siid 4…35 为 A-1…B-16；其他型号返回空列表，不是通用分区发现。设备替换默认 dry-run；写入必须再加 `--apply --confirm-target-did <did>` 和快照目录。本地 import 是 replace-all，固定先 dry-run；真正恢复必须 `--confirm-replace-all` 并强制 rollback snapshot。

云端 `generate` / `load` 前必须先对相同 `{did,ts,file-name}` 执行 `backup download`。`load`、`delete` 和 `backup config set` 都是写操作，需要用户明确授权与 rollback snapshot；完整参数以各子命令 `--help` 为准。

本地候选图可直接用 `xgg rule validate --body candidate.json` 或管道到 `--stdin`。这两种模式默认不读取 session、不连接 daemon/网关，也不访问公网；只有显式添加 `--spec-aware` 才会查询公网 MIoT spec registry。`--rule-id` 会读取已登录网关的规则和变量，但同样只在添加 `--spec-aware` 后查询公网 spec。

`deviceOutput --value '$scope.id'` 表示变量引用。若字符串字面值本身以 `$` 开头，把第一个 `$` 写两次：例如 `--value '$$hello'` 实际写入 `$hello`；`rule export` 会自动添加这一层转义。

`variable create/set-value --value` 按变量类型处理：`number` 使用数值转换；`string` 原样保存收到的 argv 文本。`--value Seed` 保存 `Seed`，而 `--value '"Seed"'` 会把双引号也作为数据保存；不要为字符串额外添加 JSON 引号。

`variable get-config --scope <scope> --id <id>` 读取单个变量配置；`variable set-config --scope <scope> --id <id> --name <name>` 只更新显示名，不改类型或当前值，并按其他写命令一样执行 snapshot guard。

规则变量 scope 只有两类是编辑器可见的：`global`，以及当前规则的 `R<rule-id>`。变量写命令会用在线规则清单识别现存的 `R<id>`，`rule node add` 则只把与自身 `--rule-id` 精确匹配的 `R<id>` 视为本地 scope；正常本地变量流程不需要 `--allow-unknown-scope`。跨规则、不存在或自定义 scope 仍会告警，并在严格规则校验中失败。

克隆规则时，CLI 只把 `R<source-id>` 规则内变量迁移到 `R<target-id>`，先只读预检完整变量计划，再以 `expect-absent` 创建空目标规则，确认目标 ID 未被占用后才准备本地变量、节点和边；只有源规则启用时才在脚本末尾追加 enable。已有目标（包括预检期间新出现的目标）会在任何变量/规则写入前停止，且永不覆盖。已有目标变量只有在类型、当前值和显示名完全兼容时才保留；真实创建仍会重新检查变量竞态。网关没有跨变量事务，并发变量修改仍可能让脚本中途停止，可用每次写前生成的 snapshot 恢复。`global` 变量作为明确的外部依赖保留，必须由目标网关预先提供。

默认 stdout 输出 JSON，适合脚本和 Agent 解析；加 `--pretty` 输出人读表格。例外：`rule logs` 默认输出人读表格，需要 JSON 时显式加 `--json`。

Skill 正文包含可 grep 的 `xgg-skill-content-build` 标记。安装或升级后可对比包内与已安装的 `SKILL.md` 标记；不同表示虽然 npm 版本号可能相同，Skill 内容仍未同步。仓库与 npm 包内的整个 Skill 目录由测试保证字节一致。

复制安装后，用递归 diff 校验 `SKILL.md` 与 `references/` 都一致：

```bash
CLI_SKILL="$(npm root -g)/@eyaeya/xgg-cli/skills/xgg-rule-authoring"
diff -qr "$CLI_SKILL" ~/.agents/skills/xgg-rule-authoring
diff -qr "$CLI_SKILL" ~/.claude/skills/xgg-rule-authoring
```

## 注意

CLI 写入后，已打开的网关网页需要手动刷新才能看到新规则或变量。npm 包不包含 GitHub 仓库里的官方前端参考 bundle、fixtures、开发计划或本地探测材料。

验证证据要分层理解：CLI help/schema/unit/integration test 证明命令与序列化；安全实机探针已经覆盖 `condition` 默认 false 的 `unmet`、可终止 self-loop、`timeRange` 窗口进入事件；具体 property/event/action、分区型号、设备替换和恢复仍必须在目标网关按 spec、lint、日志与 readback 单独验收，不代表所有场景都已实机执行。
