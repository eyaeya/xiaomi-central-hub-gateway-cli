# 小米中枢网关极客版 CLI（xgg）

> 使用 Codex、Claude 或其他 Agent 工具，调用小米中枢网关的全部能力，进行 Vibe Coding 式的米家中枢网关自动化规则编程。

`xgg` 是用于操作小米中枢网关极客版的命令行工具。它把网关的登录、设备读取、自动化规则图编辑、变量管理、备份管理和调试日志封装成稳定的 CLI，适合人类在终端中使用，也适合 LLM Agent 按步骤创建和验证自动化。

本仓库包含两个包（命令名为 `xgg`）：

- `@eyaeya/xgg-core`：协议、会话、schema、资源和用例层。
- `@eyaeya/xgg-cli`：命令行入口，安装后提供 `xgg` 命令，并携带 Agent skill 文档。

GitHub 仓库：[eyaeya/xiaomi-central-hub-gateway-cli](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli)。npm 包：[`@eyaeya/xgg-cli`](https://www.npmjs.com/package/@eyaeya/xgg-cli)、[`@eyaeya/xgg-core`](https://www.npmjs.com/package/@eyaeya/xgg-core)。

## 实机效果

下面是一次完整的真机演示：把一句中文需求交给 Agent（这里用 CodeX），它自己调用 `xgg` 查设备、连规则图、校验并写入网关，最终在中枢网关里生成可运行的自动化。三张图依「需求 → Agent 处理 → 网关成品」顺序排列，均为缩略图，**点击可在 GitHub 文件查看页中打开完整原图**。

**① 用户给 Agent 的需求 Prompt**

<a href="卧室自动化CodeX%20需求.png"><img src="卧室自动化CodeX%20需求.png" alt="卧室自动化需求 Prompt（点击查看完整原图）" width="720" loading="lazy"></a>

一句话自然语言需求，描述想要的卧室自动化效果，直接交给 CodeX。

<table>
  <tr>
    <td align="center"><b>② CodeX 的完整处理回显</b></td>
    <td align="center"><b>③ 网关里实际创建出的自动化</b></td>
  </tr>
  <tr>
    <td align="center"><a href="卧室自动化CodeX%20回复.png"><img src="卧室自动化CodeX%20回复.png" alt="CodeX 处理过程回显（点击查看完整原图）" height="380" loading="lazy"></a></td>
    <td align="center"><a href="卧室自动化实例.png"><img src="卧室自动化实例.png" alt="中枢网关里实际创建的自动化（点击查看完整原图）" height="380" loading="lazy"></a></td>
  </tr>
  <tr>
    <td align="center">CodeX 调用 <code>xgg</code> 查设备、组装规则图、表达式校验、推送保存并读日志验证的全过程。</td>
    <td align="center">中枢网关 App 里被 Agent 实际创建出来的规则图。</td>
  </tr>
</table>

## 免责声明

本项目是**非官方**工具，与小米（Xiaomi）**无任何隶属关系，未获其授权或背书**。「小米」「米家」「中枢网关极客版」「Xiaomi」等名称为其各自所有者的商标，本项目仅作描述性使用，不使用任何官方 logo。`xgg` 通过加密 WebSocket 与**用户自有**的网关设备通信，仅供个人合法使用，风险自负。

> Unofficial project, not affiliated with or endorsed by Xiaomi. All trademarks belong to their respective owners.

## 使用场景

`xgg` 把网关的设备读取、规则图编辑、变量管理和运行日志都暴露成稳定、可解析的命令，因此特别适合交给 LLM Agent 按步骤操作。它让 Codex、Claude 等 Agent 不只是「帮你敲命令」，而是从需求出发，自己查设备、连规则图、校验、启用、读日志验证。下面三类用法都已在真实网关上跑通，覆盖从无到有、从坏到好、从有到更好的完整生命周期。

### 用 LLM Agent 设计并创建自动化（主用法）

这是最主要的用法：把一句自然语言需求交给 Agent，剩下的交给它。

> 「天黑回家自动开玄关灯，半夜起夜把灯调到 10% 亮度。」

Agent 会先 `xgg device list` / `xgg device spec <did>` 看清你有哪些设备、它们能做什么，再按上文「创建自动化的标准流程」`rule new → node add → edge add → layout → validate → enable` 把规则图建好并启用，最后用 `xgg rule logs <rule-id> --tail <N>` 确认它真的触发，而不是停在「命令返回 ok」。你只描述想要的效果，不必关心节点、边、表达式这些细节。

### 诊断与修复既有自动化

自动化「不工作」往往不是没创建，而是触发条件、时间段或动作目标写错了一处。与其在网页画布上反复猜，不如让 Agent 读真实运行日志定位：

```bash
xgg rule logs <rule-id> --tail 50
xgg rule view <rule-id> --pretty
```

Agent 读日志后能区分到底是**根本没触发**、**触发了但动作没执行**，还是**条件没满足走了另一分支**。定位之后，Agent 直接修改规则图，重新 `validate` 并 `enable`，再看一眼日志确认修好了——整个排障过程有据可查，而不是反复试错。

> `xgg rule logs` 拿到的是网关**原始日志行**（仅按 rule id / 时间 / level 过滤），比网页日志面板更全也更「糙」——网页那套会再按节点连接类型过滤、逐节点渲染中文说明并丢弃解析不了的行，所以 CLI 日志更适合排障，但不必和网页逐行对应。

### 盘点现有设备与自动化，一起头脑风暴

用久了，家里有哪些设备、配过哪些自动化，自己往往也记不全。可以让 Agent 先盘点，再在此基础上提想法：

```bash
xgg device list --pretty
xgg rule list --pretty
xgg rule view <rule-id> --pretty
```

在这份真实清单的基础上，Agent 能和你一起头脑风暴：哪些设备还没被用起来、哪些场景值得自动化、现有规则有没有可以合并或补强的地方。聊定有价值的新点子后，直接接上「主用法」的标准流程落地——盘点、构思、实现连成一条线，不用你在设备列表和画布之间来回抄标识。

> 提示：CLI 写入不会自动同步到已打开的网关网页。Agent 完成改动后，请在网页 **F5 刷新**再查看（见「重要限制」）。

## 人类安装

要求：

- Node.js 20.11 或更高版本。
- 能从当前电脑访问网关极客版网页地址，通常是 `http://<gateway-ip>:8086`。
- 米家 App 中枢网关设备页显示的 6 位登录码（若中枢网关是路由器或家庭屏自带的，则在对应设备内的中枢网关功能页面获取）。登录码短时有效且通常只能用一次。

从 npm 安装 CLI（推荐）：

```bash
npm install -g @eyaeya/xgg-cli
xgg --version
xgg --help
```

`@eyaeya/xgg-cli` 会自动安装匹配版本的 `@eyaeya/xgg-core`，通常不需要手动安装 core 包。只有在 Node.js 程序里直接复用协议、schema 或 usecase 层时，才需要：

```bash
npm install @eyaeya/xgg-core
```

从 GitHub 源码运行：

```bash
git clone https://github.com/eyaeya/xiaomi-central-hub-gateway-cli.git xgg
cd xgg
corepack enable pnpm
pnpm install
pnpm build
node packages/cli/dist/cli.js --help
```

## AI Agent 安装

> 请将以下内容复制给 Agent，让其帮安装。

让 Agent 用起来需要两步：装 CLI（提供 `xgg` 命令）+ 装 Skill（让 Agent 知道怎么用 `xgg`）。

**第一步：安装 CLI。**

```bash
npm install -g @eyaeya/xgg-cli
```

**第二步：安装 Skill。** 推荐用 [skills CLI](https://github.com/vercel-labs/skills) 一键从本仓库拉取并安装（会自动放到 `.claude/skills/` 或 `.agents/skills/`）：

```bash
npx skills add eyaeya/xiaomi-central-hub-gateway-cli
```

也可以手动安装。`@eyaeya/xgg-cli` 包内自带一份离线 skill，若你的 Agent 支持本地 skills 目录，可从全局 npm 包中复制：

```bash
CLI_PKG="$(npm root -g)/@eyaeya/xgg-cli"

mkdir -p ~/.claude/skills/xgg-rule-authoring
cp "$CLI_PKG/skills/xgg-rule-authoring/SKILL.md" ~/.claude/skills/xgg-rule-authoring/SKILL.md

mkdir -p ~/.agents/skills/xgg-rule-authoring
cp "$CLI_PKG/skills/xgg-rule-authoring/SKILL.md" ~/.agents/skills/xgg-rule-authoring/SKILL.md
```

从 GitHub 源码运行时，也可以直接把 [skills/xgg-rule-authoring/SKILL.md](skills/xgg-rule-authoring/SKILL.md) 交给 Agent 读取，或复制到本地 skills 目录：

```bash
mkdir -p ~/.claude/skills/xgg-rule-authoring
cp skills/xgg-rule-authoring/SKILL.md ~/.claude/skills/xgg-rule-authoring/SKILL.md

mkdir -p ~/.agents/skills/xgg-rule-authoring
cp skills/xgg-rule-authoring/SKILL.md ~/.agents/skills/xgg-rule-authoring/SKILL.md
```

Agent 执行写操作时建议开启专用快照目录：

```bash
export XGG_AGENT_MODE=1
export XGG_SNAPSHOTS_DIR="$PWD/snapshots"
```

`XGG_AGENT_MODE=1` 会拒绝无快照写入，避免 Agent 修改规则图、变量或备份配置后没有可回滚证据。写前 rollback artifact 会完整保存规则节点与边、各 scope 的变量配置和值；所有 backup 写命令还会记录 backup list 与 config，download/load/delete 会额外记录目标引用。任一必需读取失败时 mutation 会 fail closed，不会留下可误认的快照或继续写入。建议把快照目录建在当前项目目录下（上面的 `$PWD/snapshots`），让快照随项目留存、便于回溯。

`xgg dump` 只用于 best-effort 资源索引，不是 rollback artifact；若任一资源读取失败，它会输出 `partial:true`、`ok:false` 并返回非零状态。

装好之后，Agent 应主动引导用户完成登录：请用户打开**米家 App 中的中枢网关设备页面**（如果中枢网关是路由器或家庭屏自带的，则打开对应设备内的中枢网关功能页面），把页面上的**中枢网关网址**和 **6 位动态码**发给 Agent，Agent 据此运行 `xgg login --code <6位动态码> --base-url <中枢网关网址>` 完成登录，之后即可开始读取设备、创建自动化。

## 快速开始

```bash
xgg login --code <6位登录码> --base-url http://<gateway-ip>:8086
xgg status
xgg device list --pretty
xgg rule list --pretty
xgg variable list --pretty
```

登录成功后，CLI 会启动 per-host daemon 复用已认证会话。daemon 的空闲窗口按最后一次网关调用向后延长，适合多轮 Agent 操作；`xgg status` 可查看会话状态。遇到认证失效或退出码 3 时，不要盲目重试，请重新从米家 App 获取新的 6 位登录码后再执行 `xgg login`。

## 创建自动化的标准流程

自动化规则在网关中是一张有向图：节点是卡片，边是卡片输出到输入的连线。推荐流程：

```bash
xgg device list --pretty
xgg device spec <did>

xgg rule new --name "<自动化名称>"
xgg rule node add --rule-id <rule-id> --type deviceInput \
  --device-did <button-did> --device-event click --id n-click
xgg rule node add --rule-id <rule-id> --type deviceOutput \
  --device-did <target-did> --device-property <property> --value <value> --id n-action
xgg rule edge add --rule-id <rule-id> --from n-click:output --to n-action:trigger
xgg rule layout <rule-id>
xgg rule validate --rule-id <rule-id>
xgg rule enable <rule-id>
xgg rule logs <rule-id> --tail 20
```

要点：

- 先跑 `xgg device spec <did>`，再选择属性、动作或事件，不要凭设备名猜字段。
- `deviceOutput --value '$scope.id'` 表示变量引用；字符串字面值若以 `$` 开头，需要把第一个 `$` 写两次，例如 `--value '$$hello'` 实际写入 `$hello`。`rule export` 会自动添加这一层转义。
- 连线完成后跑 `xgg rule layout <rule-id>`，让网页画布中的卡片按数据流排布。
- 启用前跑 `xgg rule validate --rule-id <rule-id>` 和 `xgg rule lint --rule-id <rule-id> --strict`；启用后用 `xgg rule logs` 看真实触发日志。
- 对 Agent 自测场景，可用 `onLoad` 作为触发节点，再通过 `rule disable` + `rule enable` 重放，不需要人类物理按按钮。
- 严格 lint 与 enable 会按目标 pin 的必需输入语义检查动作可达性，并把状态“可用 / 可能为 true / 可能为 false”分开。独立事件源只有 `onLoad`、`alarmClock`、`deviceInput`、`deviceInputSetVar`、`varChange`；`timeRange` 只提供可真可假的条件状态，不能直接启动事件路径，但可经 `statusLast` 的“状态持续为 true 后触发”桥接成事件。`register` 初值与 `setFalse` 提供 false，只有可达的 `setTrue` 再增加 true；因此 `condition.met` 要 trigger + may-true，`condition.unmet` 要 trigger + may-false，`statusLast` 也只接受 may-true。`eventSequence` 的每个事件输入都必须可达；`logicAnd` / `logicOr` / `logicNot` 按布尔语义传播真假状态，直接传播事件时仍需更新路径，`signalOr` 则任一路事件即可。`loop.stop` 与 `onlyNTimes.zero` 是控制输入，不能单独证明下游动作可执行。

### 离线校验候选规则

`rule validate --body` 和 `--stdin` 默认是确定性的纯本地检查：不会读取 session、连接 daemon/网关，也不会访问公网 MIoT spec 服务。适合 CI、预提交检查和尚未登录网关时验证卡片 schema、字段与表达式：

```bash
xgg rule validate --body candidate.json
jq '.' candidate.json | xgg rule validate --stdin
```

需要额外核对设备 property/event 参数与 dtype 时，显式加 `--spec-aware`。该选项会访问公网 MIoT spec registry；404 会作为 warning 告知该 URN 的 spec 检查已跳过，超时、5xx 或无效 spec 会作为独立 error issue 返回，同时保留同一次运行已发现的本地结构/表达式问题：

```bash
xgg rule validate --body candidate.json --spec-aware
xgg rule validate --rule-id <rule-id> --spec-aware
```

`--rule-id` 模式本身会从已登录 daemon 读取网关规则与可用变量；是否访问公网 spec 仍只由 `--spec-aware` 决定。

## 常用命令

```bash
xgg login --code <6位登录码> --base-url http://<gateway-ip>:8086
xgg logout
xgg status
xgg dump

xgg device list [--pretty] [--include-ghost]
xgg device spec <did>

xgg rule list [--pretty]
xgg rule view <rule-id> [--pretty]
xgg rule new --name "<name>" [--id <id>]
xgg rule node add --rule-id <rule-id> --type <type> ...
xgg rule edge add --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule layout <rule-id>
xgg rule validate (--rule-id <rule-id> | --body <file> | --stdin) [--spec-aware]
xgg rule lint --rule-id <rule-id> [--strict]
xgg rule enable <rule-id>
xgg rule disable <rule-id>
xgg rule logs <rule-id> [--tail 50] [--level error] [--follow]
xgg rule export <rule-id> --format shell [--target-id <new-rule-id>]

xgg variable list [--pretty]
xgg variable get <scope> [--pretty]
xgg variable create --scope global --id <id> --type number --value <value> --name "<name>"
xgg variable get-value --scope global --id <id>
xgg variable set-value --scope global --id <id> --value <value>
xgg variable watch [--pretty]

xgg backup list --from fds [--pretty]
xgg backup create --from fds --file-name <name> [--snapshots-dir <dir>] [--wait]
xgg backup download --from fds --did <did> --ts <ts> --file-name <name> [--snapshots-dir <dir>] [--wait]
xgg backup config set --from fds --auto-backup <true|false> [--snapshots-dir <dir>]

xgg api <method> [--kind read] [--params '<json>']
xgg api <method> --kind write --snapshots-dir <dir> [--params '<json>']
```

默认 stdout 输出 JSON，适合 Agent 解析；需要人读表格时加 `--pretty`。例外：`xgg rule logs` 默认输出人类表格，需要 JSON 时显式加 `--json`。

## 重要限制

- 网关没有普通 HTTP API。`xgg` 通过加密 WebSocket 二进制协议连接网关，登录使用米家 App 提供的 6 位码。
- 已打开的网关网页不会自动看到 CLI 写入的规则、变量或 scope。CLI 写入后请刷新网页，再判断 UI 是否同步。
- `xgg device list` 默认排除 ghost device。不要把网页标为“设备已丢失”的设备作为 `deviceOutput` 目标。
- 变量类型只有 `number` 和 `string`。开关状态建议用数字 `1/0` 或字符串表示。
- 变量命令的 `--value` 按变量类型处理：`number` 使用数值转换；`string` 原样保存收到的 argv 文本。`--value Seed` 保存 `Seed`，而 `--value '"Seed"'` 会把双引号也作为数据保存；不要为字符串额外添加 JSON 引号。
- 变量 scope 默认用 `global`。规则本地变量使用 `R<rule-id>` 约定；如果 rule id 含连字符，本地变量 scope 无法按该约定合法创建，建议改用 `global` 或使用纯字母数字 rule id。
- `rule export` 会用当前表达式解析器回读生成的 `varSetNumber` / `varSetString --expr`；若源图的结构化 elements 无法用 DSL 无损表示（例如变量后紧跟会被吞入变量 ID 的字母或数字常量），导出会以 `ConfigError` 拒绝。请先在源表达式中加入显式分隔符，或改用 `rule view` 的整图 JSON 往返。
- `rule export/import --target-id` 克隆时只把源规则的 `R<source-id>` 迁移为 `R<target-id>`，并先用导出时的当前值准备被引用的规则内变量；脚本会先只读预检完整变量计划，再开始任何创建。兼容的已有变量会保留，类型/值/显示名冲突则在写变量或规则前失败且绝不覆盖。`global` 始终是明确的外部依赖，不会被创建或改写。
- 网关没有直接读取任意设备实时属性的通用 RPC。需要观测设备属性时，创建规则把属性写入变量，再用 `xgg variable watch` 观察。
- `xgg api` 是低层逃生口，不建议把它作为常规自动化编辑路径。read 是普通/未知方法的默认 intent；当前已知写接口必须显式传 `--kind write`，并进入与 typed 写命令相同的 Agent guard、完整写前 rollback snapshot 与 `NOT_CONFIRMED` 超时分类。未知的新接口仍可显式选择 read 或 write，JSON 输出会回显最终 `kind`。

## GitHub 与 npm 内容边界

GitHub 源码发布根目录是本目录。**本仓库不包含任何小米官方前端 bundle 或专有代码**。

npm 只发布 `@eyaeya/xgg-core` 与 `@eyaeya/xgg-cli` 两个包。`@eyaeya/xgg-cli` 依赖并自动安装 `@eyaeya/xgg-core`，用户只需要全局安装 CLI 包。两个包的 `package.json` 使用 `files` allow-list：core tarball 只包含 `dist`、`LICENSE`、`README.md`；cli tarball 额外包含 `skills/xgg-rule-authoring/SKILL.md`，不会包含 fixtures、开发计划、探测记录、快照或本地逆向材料。

## 开发与发布检查

```bash
corepack enable pnpm
pnpm install
pnpm check
pnpm build
pnpm pack:release
tar -tzf release-artifacts/eyaeya-xgg-cli-*.tgz
```

发布前至少确认：

- `pnpm check` 通过。
- `pnpm pack:release` 能生成 `@eyaeya/xgg-core` 和 `@eyaeya/xgg-cli` tarball。
- 临时安装生成的 CLI tarball 后，`xgg --version` 和 `xgg --help` 正常。
- `tar -tzf` 确认 core tarball 只含 `dist/LICENSE/README.md`，cli tarball 只额外含 `skills/xgg-rule-authoring/SKILL.md`（不含源码、fixtures、本地材料）。
- 公开树中没有真实 IP、6 位登录码、设备 DID、家庭名或本地快照。

发布命令：

```bash
npm publish release-artifacts/eyaeya-xgg-core-*.tgz --access public
npm publish release-artifacts/eyaeya-xgg-cli-*.tgz --access public
```

必须先发布 `@eyaeya/xgg-core`，再发布 `@eyaeya/xgg-cli`，因为 CLI 包依赖 core 包。

## Agent 权威参考

供 AI Agent 操作本 CLI 的完整权威指南（含 25 种卡片、pin 颜色规则、变量模型、表达式、调试流程，均经真实网关验证）见 [skills/xgg-rule-authoring/SKILL.md](skills/xgg-rule-authoring/SKILL.md)。

## License

GNU 通用公共许可证 v3 或更新版本（GPL-3.0-or-later），见 [LICENSE](LICENSE)。

Copyright (C) 2026 不系 (@eyaeya)
