# 小米中枢网关极客版 CLI（xgg）

> 使用 Codex、Claude 或其他 Agent 工具，调用小米中枢网关的全部能力，进行 Vibe Coding 式的米家中枢网关自动化规则编程。

`xgg` 是用于操作小米中枢网关极客版的命令行工具。它把网关的登录、设备读取、自动化规则图编辑、变量管理、备份管理和调试日志封装成稳定的 CLI，适合人类在终端中使用，也适合 LLM Agent 按步骤创建和验证自动化。

本仓库包含两个包（命令名为 `xgg`）：

- `@xgg/core`：协议、会话、schema、资源和用例层。
- `@xgg/cli`：命令行入口，安装后提供 `xgg` 命令。

> npm 包名/scope 待定（`@xgg` 为占位）；命令名固定为 `xgg`。

## 免责声明

本项目是**非官方**工具，与小米（Xiaomi）**无任何隶属关系，未获其授权或背书**。「小米」「米家」「中枢网关极客版」「Xiaomi」等名称为其各自所有者的商标，本项目仅作描述性使用，不使用任何官方 logo。`xgg` 通过加密 WebSocket 与**用户自有**的网关设备通信，仅供个人合法使用，风险自负。

> Unofficial project, not affiliated with or endorsed by Xiaomi. All trademarks belong to their respective owners.

## 人类安装

要求：

- Node.js 20.11 或更高版本。
- 能从当前电脑访问网关极客版网页地址，通常是 `http://<gateway-ip>:8086`。
- 手机米家 App 中网关设备页显示的 6 位登录码。登录码短时有效且通常只能用一次。

从 GitHub 源码运行（当前推荐方式）：

```bash
git clone <repo-url> xgg
cd xgg
corepack enable pnpm
pnpm install
pnpm build
node packages/cli/dist/cli.js --help
```

npm 包待发布（scope 待定）。发布后将支持：

```bash
npm install -g @xgg/cli   # 待发布
xgg --version
xgg --help
```

## AI Agent 安装

推荐让 Agent 同时构建 CLI 并读取本仓库内置 Skill。当前从 GitHub 源码构建（见上方「人类安装」；npm 发布后可改用 `npm install -g @xgg/cli`）。

然后把 [skills/xgg-rule-authoring/SKILL.md](skills/xgg-rule-authoring/SKILL.md) 交给你的 Agent 读取，或放入 Agent 支持的本地 skills 目录。例如：

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

`XGG_AGENT_MODE=1` 会拒绝无快照写入，避免 Agent 修改规则图或变量后没有可回滚证据。

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
- 连线完成后跑 `xgg rule layout <rule-id>`，让网页画布中的卡片按数据流排布。
- 启用前跑 `xgg rule validate --rule-id <rule-id>`；启用后用 `xgg rule logs` 看真实触发日志。
- 对 Agent 自测场景，可用 `onLoad` 作为触发节点，再通过 `rule disable` + `rule enable` 重放，不需要人类物理按按钮。

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
xgg rule validate --rule-id <rule-id>
xgg rule lint --rule-id <rule-id> [--strict]
xgg rule enable <rule-id>
xgg rule disable <rule-id>
xgg rule logs <rule-id> [--tail 50] [--level error] [--follow]
xgg rule export <rule-id> --format shell

xgg variable list [--pretty]
xgg variable get <scope> [--pretty]
xgg variable create --scope global --id <id> --type number --value <value> --name "<name>"
xgg variable get-value --scope global --id <id>
xgg variable set-value --scope global --id <id> --value <value>
xgg variable watch [--pretty]

xgg backup list --from fds [--pretty]
xgg backup create --from fds --file-name <name>
```

默认 stdout 输出 JSON，适合 Agent 解析；需要人读表格时加 `--pretty`。

## 重要限制

- 网关没有普通 HTTP API。`xgg` 通过加密 WebSocket 二进制协议连接网关，登录使用米家 App 提供的 6 位码。
- 已打开的网关网页不会自动看到 CLI 写入的规则、变量或 scope。CLI 写入后请刷新网页，再判断 UI 是否同步。
- `xgg device list` 默认排除 ghost device。不要把网页标为“设备已丢失”的设备作为 `deviceOutput` 目标。
- 变量类型只有 `number` 和 `string`。开关状态建议用数字 `1/0` 或字符串表示。
- 变量 scope 默认用 `global`。规则本地变量使用 `R<rule-id>` 约定；如果 rule id 含连字符，本地变量 scope 无法按该约定合法创建，建议改用 `global` 或使用纯字母数字 rule id。
- 网关没有直接读取任意设备实时属性的通用 RPC。需要观测设备属性时，创建规则把属性写入变量，再用 `xgg variable watch` 观察。
- `xgg api` 是低层逃生口，不建议把它作为常规自动化编辑路径。

## GitHub 与 npm 内容边界

GitHub 源码发布根目录是本目录。**本仓库不包含任何小米官方前端 bundle 或专有代码**。

npm 只发布 `@xgg/core` 与 `@xgg/cli` 两个包。两个包的 `package.json` 使用 `files` allow-list，npm tarball 只包含 `dist`、`LICENSE`、`README.md`，不会包含 fixtures、开发计划、探测记录、快照或本地逆向材料。

## 开发与发布检查

```bash
corepack enable pnpm
pnpm install
pnpm check
pnpm build
pnpm pack:release
tar -tzf release-artifacts/xgg-cli-0.1.0.tgz
```

发布前至少确认：

- `pnpm check` 通过。
- `pnpm pack:release` 能生成 `@xgg/core` 和 `@xgg/cli` tarball。
- 临时安装生成的 CLI tarball 后，`xgg --version` 和 `xgg --help` 正常。
- `tar -tzf` 确认 npm tarball 只含 `dist/LICENSE/README.md`（不含源码、fixtures、本地材料）。
- 公开树中没有真实 IP、6 位登录码、设备 DID、家庭名或本地快照。

发布命令：

```bash
pnpm --filter @xgg/core publish --access public
pnpm --filter @xgg/cli publish --access public
```

如果没有 `@xgg` scope 权限，请先改两个包的 `name` 和相互依赖，再重新打包验证。

## Agent 权威参考

供 AI Agent 操作本 CLI 的完整权威指南（含 25 种卡片、pin 颜色规则、变量模型、表达式、调试流程，均经真实网关验证）见 [skills/xgg-rule-authoring/SKILL.md](skills/xgg-rule-authoring/SKILL.md)。

## License

GNU 通用公共许可证 v3 或更新版本（GPL-3.0-or-later），见 [LICENSE](LICENSE)。

Copyright (C) 2026 不系 (@eyaeya)
