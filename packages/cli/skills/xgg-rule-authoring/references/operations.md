# xgg 安全操作、变量与验收

真正连接网关、修改既有规则、使用变量/表达式、排障或备份时读取本文。图模型见 [graph-model.md](graph-model.md)，设备参数见 [device-semantics.md](device-semantics.md)。

## 目录

- [运行项目内的最新 CLI](#运行项目内的最新-cli)
- [登录与写前保护](#登录与写前保护)
- [输出和退出码](#输出和退出码)
- [创建修改与原子写入](#创建修改与原子写入)
- [导出导入与克隆](#导出导入与克隆)
- [变量与表达式](#变量与表达式)
- [一次性读取设备属性与低层 API](#一次性读取设备属性与低层-api)
- [校验启用与运行证明](#校验启用与运行证明)
- [日志与 trace](#日志与-trace)
- [网页缓存与并发编辑](#网页缓存与并发编辑)
- [备份与高风险恢复](#备份与高风险恢复)
- [完成标准](#完成标准)

## 运行项目内的最新 CLI

先确认命令来自当前项目/已同步 Skill 对应的构建，不要把同版本号的旧 npm 安装当作最新代码：

```bash
pnpm build
node packages/cli/dist/cli.js --help
```

发布安装场景可用 `xgg --help`，但处理未发布改动时一律把下文 `xgg` 替换为项目内 `node packages/cli/dist/cli.js`。Skill 正文有 content build marker；仓库 Skill、package mirror 与实际安装目录还应做递归字节对比。

## 登录与写前保护

```bash
xgg status
xgg login --code <one-time-code> --base-url http://<gateway-ip>:8086
export XGG_AGENT_MODE=1
export XGG_SNAPSHOTS_DIR="$PWD/snapshots"
```

- 只有 `AUTH_REQUIRED` / `AUTH_EXPIRED` 或退出码 3 时才索取新码；登录码一次性、短时有效，绝不写入日志报告、仓库、Issue/PR 或命令历史示例。
- Agent 写操作始终启用当前工作目录下的 snapshot 目录。不要用 `/tmp` 或全局目录保存家庭配置快照。
- 普通工作不使用 `--no-snapshot`、`--no-validate`、`--no-var-check`。它们只用于已经解释风险、可回滚的协议/修复实验。
- 写前先 `rule view` 记录 `enable`；已启用规则的 node/edge/layout/set 修改可能立即生效。
- Flag 覆盖 env：`--base-url`、`--session-file`、`--snapshots-dir` 分别覆盖同名 XGG env。

## 输出和退出码

默认解析紧凑 JSON stdout；只给人阅读时 `--pretty`。`rule logs` 是例外：默认表格，机读要 `--json`。错误在 stderr 为：

```json
{"ok":false,"error":{"code":"...","message":"...","hint":"...","details":{}}}
```

退出码：

| code | 含义 |
|---:|---|
| 0 | 成功/检查 clean |
| 1 | 网关错误，或 lint/validate 有 warning |
| 2 | 写入结果未确认/超时，或 lint/validate 有 error |
| 3 | 认证失败或过期 |
| 4 | 客户端 schema/响应解析失败 |
| 5 | 本地配置、安全 guard、参数或校验失败 |

`rule lint` JSON 的顶层 `ok:true` 表示**lint 命令成功执行**，不是“规则无问题”。Agent 必须同时检查进程退出码与 `summary.errors`/`summary.warnings`；`validate`、lint、mutation 的 `ok` 不能脱离各自契约统一解释。不要写 `cmd && ...` 后丢失需要记录的 warning/error 退出码。

## 创建修改与原子写入

标准增量路径：

```bash
xgg rule new --name "<name>"
xgg rule node add --rule-id <rid> --type <type> --id <stable-node-id> ...
xgg rule edge add --rule-id <rid> --from <source:pin> --to <target:pin>
xgg rule layout <rid>
```

目标化修改：

```bash
xgg rule node update --rule-id <rid> --node-id <nid> --patch '<json>'
xgg rule edge remove --rule-id <rid> --from <source:pin> --to <target:pin>
xgg rule node remove --rule-id <rid> --node-id <nid> --cascade-edges
xgg rule rename <rid> --name "<name>"
xgg rule set-tags <rid> --tags "a,b"
```

- `node update` 只 merge 顶层与 `cfg`；`props/inputs/outputs` 必须给完整 replacement，且不能改 id/type。
- 紧凑 `--from/--to` 只用于 canonical ID。既有 node ID 含 `:` 时，edge add/remove 同时给齐 `--from-node-id/--from-pin/--to-node-id/--to-pin`；export/import 会自动使用这条无损路径。
- 常规 remove 加 `--cascade-edges`；不加会故意留下 dangling incoming wires。
- 默认 node/edge/layout/set 会按精确 scope/id 检查在线变量存在和实际类型；node remove 也检查删除后的**剩余图**。SDK `createRule(initial nodes)` 在第一次 setGraph 前检查初始图；CLI 空图 `rule new` 不为此多读变量。`--no-var-check` 只供明确 raw probe/修复，不能放宽 scope/schema/spec/enable。
- `set-tags` 替换整组，不是 append；空字符串清空。
- `rule delete` 还会清理 `R<rid>` scope；global 变量需另删。幂等清理才 `--allow-missing`。

需要保留未知扩展字段或一次原子写整图时，用 `rule view`/export 的完整默认 JSON，不从 pretty 或未经当前 xgg 校验的片段拼 payload：

```bash
xgg rule validate --body ./graph.json
xgg rule set --body ./graph.json
```

已知/未来节点的 raw 形状、wire 编码见 node catalog。`--cfg` 表示完整节点 tuple 时，不得同时混用会覆盖语义的 shortcut flags；任何 flag 被“成功但忽略”都应视为 CLI 缺陷而不是可依赖行为。

## 导出导入与克隆

精确命令面是 `rule export <id> [--format shell|json] [--target-id] [--target-name] [--strict-roundtrip]`；默认 shell stdout，`--pretty` 只适用于 JSON。strict 要在 export 阶段声明，import 没有 strict flag。直接导出的 shell 也要落盘审阅；需要可靠重放或改目标 ID 时，先导 JSON，再用**必填**的 `--from-file` 离线渲染脚本：

```bash
export SNAPSHOTS_DIR="$PWD/snapshots"
export SOURCE_BASE_URL="http://<source-gateway>:8086"
export TARGET_BASE_URL="http://<target-gateway>:8086"
xgg rule export <source-id> --format json --strict-roundtrip \
  --base-url "$SOURCE_BASE_URL" > rule-export.json
xgg rule import --from-file rule-export.json --base-url "$TARGET_BASE_URL" > replay.sh
xgg rule import --from-file rule-export.json --target-id <target-id> \
  --target-name "克隆规则名" --base-url "$TARGET_BASE_URL" > clone.sh
# 审阅脚本和末尾 enable 行为，再按授权执行
```

执行前用 `rg -n '^BASE_URL=' replay.sh clone.sh` 确认每份脚本恰好一行、值就是目标且不含 `192.168.x.x` / `<...>` 占位符。冻结网页/其他 writer 后，先按 export 的 typed `externalVariables` 对**目标**重复只读断言；strict export 只证明源网关，不能替代这一步：

把下面内容落盘为 `target-global-preflight.sh`，用 `bash target-global-preflight.sh` 执行；只有 exit 0 才能继续：

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${XGG_NODE_ENTRY:?set absolute current-source dist/cli.js path}"
: "${TARGET_BASE_URL:?set explicit target URL}"
CLI=("${NODE_BIN:-node}" "$XGG_NODE_ENTRY")
[[ -f "$XGG_NODE_ENTRY" ]]

jq -e '(.externalVariables // []) as $deps | (($deps | type) == "array") and all($deps[]; .scope == "global" and (.expectedType == "number" or .expectedType == "string"))' \
  rule-export.json >/dev/null
jq -c '(.externalVariables // [])[]' rule-export.json > target-global-preflight.ndjson
while IFS= read -r dep; do
  id="$(jq -er '.id' <<<"$dep")"
  type="$(jq -er '.expectedType' <<<"$dep")"
  "${CLI[@]}" variable get-config --scope global --id "$id" --expect-type "$type" \
    --base-url "$TARGET_BASE_URL"
done < target-global-preflight.ndjson
```

`set -euo pipefail` 使任一 jq 解析、字段提取或目标类型断言失败都立即非零退出；不得复制命令后去掉该保护，也不得用管道/循环最后一项掩盖失败。全部 target global 通过后，same-ID 目标若当前 enabled，才可记录图/原状态并在获授权后 `rule disable` + readback，再执行脚本；脚本开头会重复这些断言以缩小竞态窗口。因为 local prepare 早于 graph staging，若脚本在 staging 前失败，目标会保持 disabled，不能未经诊断自动恢复 enable。

`rule import --from-file <export.json> [--target-id] [--target-name] [--base-url]` 只做 JSON→shell，不访问网关、不执行脚本，stdout 不是写入成功。strict export 已在源网关读取并检查可发现的 modeled local/global；opaque `--cfg` 内部不在证明范围内。replay 会先对所有可发现的 modeled `global` 依赖执行只读 `variable get-config --expect-type`，验证目标上存在且实际类型匹配；不比较值/显示名，也绝不创建、改值或改名。全部 global 通过后才预检捕获的 local 变量（local 精确比较类型、值和显示名），之后才允许首笔变量/规则写入。旧 JSON 真正没有可发现 global 依赖仍兼容；若 modeled node 命令引用 global 却没有 command+top-level typed declaration，或 declaration 没有可信 `expectedType`，same-ID/clone 都在输出脚本前 fail closed。same-ID replay 在 staging 前兼容准备本地变量，第一次 target-graph write 原子写禁用空图；clone 用 `--expect-absent` 预留禁用空壳，再创建改写为 `R<target-id>` 的本地变量。节点/边均在 disabled 状态重建；源启用时只在末尾恢复 enable，源禁用则保持禁用。

生成脚本默认 `XGG=xgg` 且 snapshot 目录是 `/tmp`；执行前必须覆盖成当前源码构建与工作目录内安全 SNAPSHOTS_DIR。直接 `rule export --format shell` 会嵌入 export 所连接的 URL；要换目标用上例 JSON + 显式 `rule import --base-url <target>` 渲染。import 省略 flag 时会先读取**渲染进程**的 `XGG_BASE_URL`：若它已设置，就硬编码进脚本，之后执行时的 `BASE_URL` 不能覆盖；只有渲染时两者都没有，脚本才保留运行时 `BASE_URL` fallback。不要依赖这个隐式分支，始终显式传目标。`XGG` 只接受一个 executable path，绝不能写 `XGG="node ..."` 或 `XGG="pnpm ..."`；未发布源码用 #180 的两个独立 argv 元素：

```bash
XGG_NODE_ENTRY="$(pwd -P)/packages/cli/dist/cli.js" \
  NODE_BIN="$(command -v node)" \
  SNAPSHOTS_DIR="$(pwd -P)/snapshots" bash replay.sh
```

路径含空格仍保持单一 argv，脚本不用 `eval`/拆词。脚本是逐命令事务，不是 replay-wide lease；global/local **预检**全为只读，失败时没有写入，但通过后仍可能并发漂移。same-ID 会在 graph staging 前逐个兼容创建缺失 local；按上段预先 disable 后，若此阶段中断，旧图保持原内容但仍是 disabled，同时只留下部分 local 创建。未按要求预先停用的旧图则可能仍 enabled，这正是禁止跳过该步骤的原因。clone 先预留 disabled 空壳，再创建 local。任何 target graph staging 之后失败，才会留下 disabled partial graph/变量。执行期间停止网页和其他 writer；失败后按所处阶段同时 readback 规则 enable/图与变量，并用逐写 snapshot 检查/恢复。成功后固定跑 spec-aware validate、strict lint 与 view/readback，只有用户授权才触发。

- strict export 在任何 staging 前读取源网关可发现的 modeled local/global 变量，按引用路径拒绝缺失 global、实际类型 mismatch、access/no-push、设备 literal/ref/action-index 契约和不可无损的 modeled 节点；permissive 必须给明确 warning，只有 no-push probe 会补 transient `--allow-no-push`。
- 能由 typed model、nop Delta/几何与表达式 DSL 无损表示的字段可 round-trip；表达式 elements 若有变量/常量词法边界歧义，所有 export 模式都拒绝，先给源表达式加显式分隔。
- 未建模 future node 用完整 opaque `--cfg` 同 ID 重放；CLI 无法发现/改写 opaque payload 内的 local 或 global 引用，所以带 opaque 节点拒绝 `--target-id` clone；same-ID 的信息性 warning 也意味着 strict export 与生成的 preflight 不能证明其内部依赖，启用前须独立审阅并另行证明。
- `--strict-roundtrip` 拒绝 modeled semantic-loss warning；lossless opaque same-ID fallback 是带信息 warning 的例外。

## 变量与表达式

变量 type 只有 `number|string`，scope/id 是非空 `[A-Za-z0-9]+`；常用 scope 为 `global` 与 `R<rid>`。

在线 inventory 按精确 scope+id 与**每个可发现的 modeled 引用路径**核对：`varChange/varGet` 匹配卡片 `varType`；`varSetNumber` target 和所有变量 operand 都是 number；`varSetString` target 是 string、operand 可 number|string；`deviceInputSetVar/deviceGetSetVar` capture 与 `deviceOutput` ref 匹配持久化 dtype/MIoT 投影。不要把同名变量、手写 dtype 或不存在的 bool 类型当成证明。

```bash
xgg variable create --scope global --id mode --type number --value 0 --name "模式"
xgg variable get global --pretty
xgg variable get-config --scope global --id mode --expect-type number --pretty
xgg variable get-value --scope global --id mode
xgg variable set-value --scope global --id mode --value 1
xgg variable watch --follow
```

`variable get <scope>` 列出 type+value；`get-config` 精确读取单变量的 type/metadata，加 `--expect-type number|string` 时是纯读存在/类型断言，missing 或 mismatch 非零退出，不比较值/显示名；`get-value` 只读 scalar current value，不能单独证明实际类型。

表达式 DSL：

| 写法 | 语义 |
|---|---|
| `$id` | 默认 scope 的变量 |
| `$scope.id` | 限定 scope |
| `$$` | 字面 `$` |
| 其他字符 | 常量/操作符/文本 |

shell 中始终单引号：

```bash
xgg rule expr-check '$global.count + 1'
xgg rule node add --rule-id <rid> --type varSetNumber \
  --var-scope global --var-id count --expr '$global.count + 1'
```

未转义 `$` 必须开始合法变量引用。`varSetNumber` 支持 `+ - * / %`、括号和以下固定 arity；函数都必须带括号：

| 参数数 | 函数 |
|---:|---|
| 1 | `abs sin cos tan asin acos atan round floor ceil` |
| 2 | `pow log randint` |
| ≥1 | `max min` |
| 0 | `rand now year month date day hours minutes seconds pi e` |

`log(x,y)` 是以 x 为底 y 的对数，三角函数用弧度；`month()` 为 1–12、`date()` 从 1 起、`day()` 周日=0、`now()` 是毫秒 epoch。`varSetString` 只拼接文本，但仍检查变量引用 grammar；当前 xgg CLI/schema 没有声明通用 UTF-8 长度上限，不要编造数字。

先用 `expr-check` 区分语法错误和运行期值错误；export 不能无损还原的 elements 会拒绝而不是生成漂移脚本。

## 一次性读取设备属性与低层 API

当前 xgg typed command surface 没有“客户端随时读取任意设备属性”的通用命令；这不是对所有私有固件接口的绝对不存在证明。需要主动取一次当前值时，把可读 property 导入变量：

```bash
xgg device spec <did> --pretty
xgg variable create --scope global --id snap --type <number|string> --value <初值> --name snap
xgg rule new --name "读取属性到变量"
xgg rule node add --rule-id <rid> --type onLoad --id nLoad
xgg rule node add --rule-id <rid> --type deviceGetSetVar --id nRead \
  --device-did <did> --device-property <property> \
  --var-scope global --var-id snap
xgg rule edge add --rule-id <rid> --from nLoad:output --to nRead:input
xgg rule layout <rid>
xgg rule validate --rule-id <rid> --spec-aware
xgg rule lint --rule-id <rid> --strict
# 审查完整下游并获授权后 enable，再读 variable/logs
```

string property 对应 string；其他 format（包括 bool）对应 number，bool 用 0/1。持续 notify 则用 property `deviceInputSetVar` + `variable watch --follow`；`--preload` 只控制 enable 时首次查询，不制造 notify/read/push。测试后按授权删除临时规则/变量。

仅当已明确掌握 method 与 params、而当前 typed CLI 尚未覆盖该 RPC 时，才用下面的 escape hatch；`--params` 与 `--params-file` 二选一：

```bash
xgg api /api/<method> [--kind read|write] \
  [--params '<JSON>' | --params-file <path>]
```

unknown/read 默认按 read；已知 mutation 省略 kind 或谎标 read 都应在 session/IPC 前拒绝，必须 `--kind write`。raw write 仍进入 mutation lease 与 rollback snapshot guard，Agent mode 必须有 snapshots dir；raw `/api/loadBackup` 还会等待 terminal progress，缺 progress id 以 `NOT_CONFIRMED` 结束。不要用 raw 绕过已有 typed 命令或保护；它是协议探索入口，不是日常设备读写承诺。

## 校验启用与运行证明

启用前固定两条：

```bash
xgg rule validate --rule-id <rid> --spec-aware
xgg rule lint --rule-id <rid> --strict
```

| gate | 覆盖范围 | 不覆盖 |
|---|---|---|
| validate | 节点 schema、变量 scope/存在性/实际类型；spec-aware 再查所有设备卡的 property/event/action、access、push、原生值域、action input 和 output ref | truth-aware sink 可达性 |
| lint | edge endpoint、duplicate/fan-in、pin color、必需输入、保存键；strict 加 reachability | 目标设备真实执行结果 |
| enable | 重跑保存校验、硬拦不可达 sink，并对 persisted deviceOutput variable ref 聚焦 fail-closed 拉取 spec | 其他设备卡的完整 live spec 证明；触发与动作成功证明 |

`rule set` 允许暂时不可达的增量图，`enable` 才硬拦；因此每批编辑后主动 strict lint。**任何含设备卡的规则**都不能省略 `--spec-aware`；离线 body/stdin 没有 live device/variable inventory，不能伪称已验证目标网关。常规业务规则必须让 spec-aware/strict lint errors=0；每条 warning 都要按路径逐项审计、解释并明确接受，未解释或未接受的 warning 视为阻断。已证明可终止的 self-loop、兼容旧节点 ID，以及同 ID 无损保留的 opaque/future 卡片可产生 advisory warning，但不能批量忽略。唯一允许 spec-aware error 的窄例外是用户明确授权验证固件扩展的 no-push 临时探针：仍运行并保存两份结果，只允许目标 source 的路径化 no-push error；strict lint 对同一 source 的 no-push warning（exit 1）也须显式接受，其他 errors 为零、其他 warnings 仍逐项审计。图必须隔离且下游只有安全软件 marker，enable 后立即取 logs/readback，再 disable/delete。该例外不使 validate/lint 变成 clean，也不能用于生产验收或 strict export。

只有用户授权运行时才：

```bash
xgg rule enable <rid>
# 触发可控入口或等待/请求物理触发
xgg rule logs <rid> --tail 50
xgg rule view <rid>
```

enable 成功只证明启用。运行完成必须用对应 node/edge 日志、变量 readback 或设备结果证明；刻意禁用的交付则证明 `enable=false`。

## 日志与 trace

```bash
xgg rule logs <rid> --tail 50 --json
xgg rule trace <rid> --pretty
xgg rule trace <rid> --node <nid> --max-blocks 16 --max-steps 200
```

- `link source.pin → target.pin = 事件` 是边触发；`node [value]` 是取值/分支；`success/failed` 是动作结果。
- 空日志不能证明从未运行：扫描受网关保留窗口、分页、`--max-blocks`、parser 与 tail 限制。
- trace 是**当前图** watchpoint 对有界、已解析历史日志的累计客户端投影；遇到“规则启用”会清空累计状态。检查 `completeness.fetch/parse/selection/topology/semantic`，不要只看 frames。
- `--max-blocks` 扩大源日志扫描；`--max-steps` 只裁剪最终帧。
- 未解析行只返回计数，不暴露可能属于其他规则的原文；合法重复行保留，分页按旧块→新块且保持块内顺序。
- 语义 label 来自共享 spec/catalog projector；`deviceGet` 按唯一 URN 复用 spec/catalog cache，只对 notify property 投影 value label，bool 也走同一 projector。失败回退 raw 并记录 semantic drift/fallback metadata；只暴露 URN、不暴露 DID。raw 值不是错误，但不能擅自翻译。
- topology drift、semantic discard、parse/fetch 边界和网关保留窗口都会使 trace 不完整；它不是新 RPC、不是设备实时真值。
- `onLoad` 可由 disable→enable 重放，但先审查全部下游，避免意外驱动物理动作。其他物理 source 应请用户触发或等待真实条件。

## 网页缓存与并发编辑

CLI 写入不向已经打开的网页 SPA 广播 `configChanged`。网页看不到新规则/变量或显示“变量已丢失”时：

1. `variable get-value` 证明值存在；
2. `rule view` 核对 scope/id；
3. 让用户 F5 刷新网页；
4. 仍异常才继续诊断。

目标化命令内部仍是 getGraph→setGraph。mutation lease 只串行 xgg 客户端，不是网页 CAS；写期间不要同时编辑网页画布。

## 备份与高风险恢复

安全基线：

```bash
xgg backup local-export --output ./gateway-rules.bak
xgg backup local-import --input ./gateway-rules.bak --dry-run
xgg backup list --from fds --pretty
xgg backup config get --from fds
```

本地 v2 `.bak` 包含 rules+variables、4-byte little-endian 原始长度 + raw-deflate + SHA-256；也兼容旧 rules-only 数组。读取阶段在访问 session 前验证 hash、bounded inflate、payload、变量与每张规则。旧数组会规范化为 `variables:{}`；local-import 必须在 `--dry-run` 与 `--confirm-replace-all` 中恰选一个。真正 apply 会先删除**全部规则和变量**再仅重建备份内容，不是 merge；先核对 dry-run 的 `createVariables` 等计数，apply 强制 rollback snapshot 且必须有用户明确授权。

云端完整命令面：

```bash
xgg backup list --from fds --pretty
xgg backup create --from fds --file-name "<名字>" --wait
xgg backup cloud-export --from fds --did <did> --ts <ts> --file-name "<名字>" --output ./history.bak
xgg backup download --from fds --did <did> --ts <ts> --file-name "<名字>"
xgg backup progress --from fds --progress-id <id>
xgg backup generate --from fds --did <did> --ts <ts> --file-name "<名字>"
xgg backup load --from fds --did <did> --ts <ts> --file-name "<名字>"
xgg backup delete --from fds --did <did> --ts <ts> --file-name "<名字>"
xgg backup config get --from fds
xgg backup config set --from fds --auto-backup true --auto-backup-limit <N>
```

`cloud-export` 在一个 mutation lease 内完成 download→终态→generate→0600 原子落盘，默认拒绝覆盖；低层 generate 只在相同 `{did,ts,file-name}` 已明确完成 download 后使用。`load` 是全量恢复，delete 永久删除，config set 改持久策略；三者不能用于能力探针，必须有用户授权和 rollback snapshot。

进度契约按命令区分：

- create/download 只有加 `--wait` 才轮询；`--poll-interval-ms/--poll-timeout-ms` 必须与 `--wait` 同用。wait 模式下句柄 0 或精确 `{}` 是同步完成，其他无可识别句柄的 ACK 为 `NOT_CONFIRMED`。
- cloud-export 不接受 `--wait`，但固定自动执行 download→terminal→generate；它可直接接两个 poll flags。
- load 无论是否有 `--wait` 都自动确认 download 与 restore terminal；这里 `--wait` 只控制 JSON 是否附最终 load progress，两个 poll flags 无需搭配 wait。含糊 download ACK 不进入恢复，含糊 load ACK 仍以 `NOT_CONFIRMED` 封锁。
- `backup progress` 只读一次，不是轮询器。可轮询句柄可能是 bare number、`progress_id` 或 `progressId`；terminal 判定为 `progress >= 100`。

timeout/`NOT_CONFIRMED` 一律不得汇报成功。

## 完成标准

每条创建/修复至少记录：

```text
需求分解与图计划
device spec / variable evidence
最终 rule view/readback
validate --spec-aware exit + summary
lint --strict exit + summary
最终 enable 状态
若获运行授权：触发证据 + logs/trace/variable/device result
snapshot/backup 与清理状态
```

最后提醒用户 F5 网页。临时规则、global probe 变量、测试备份和快照按授权清理；一次性码永不进入交付物。
