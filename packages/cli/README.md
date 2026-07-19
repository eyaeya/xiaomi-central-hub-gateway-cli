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
xgg rule enable <rule-id>
xgg rule logs <rule-id> --tail 20
xgg rule export <rule-id> --target-id <new-rule-id>
```

本地候选图可直接用 `xgg rule validate --body candidate.json` 或管道到 `--stdin`。这两种模式默认不读取 session、不连接 daemon/网关，也不访问公网；只有显式添加 `--spec-aware` 才会查询公网 MIoT spec registry。`--rule-id` 会读取已登录网关的规则和变量，但同样只在添加 `--spec-aware` 后查询公网 spec。

`deviceOutput --value '$scope.id'` 表示变量引用。若字符串字面值本身以 `$` 开头，把第一个 `$` 写两次：例如 `--value '$$hello'` 实际写入 `$hello`；`rule export` 会自动添加这一层转义。

`variable create/set-value --value` 按变量类型处理：`number` 使用数值转换；`string` 原样保存收到的 argv 文本。`--value Seed` 保存 `Seed`，而 `--value '"Seed"'` 会把双引号也作为数据保存；不要为字符串额外添加 JSON 引号。

规则变量 scope 只有两类是编辑器可见的：`global`，以及当前规则的 `R<rule-id>`。变量写命令会用在线规则清单识别现存的 `R<id>`，`rule node add` 则只把与自身 `--rule-id` 精确匹配的 `R<id>` 视为本地 scope；正常本地变量流程不需要 `--allow-unknown-scope`。跨规则、不存在或自定义 scope 仍会告警，并在严格规则校验中失败。

克隆规则时，CLI 只把 `R<source-id>` 规则内变量迁移到 `R<target-id>`，先只读预检完整变量计划，再以 `expect-absent` 创建空目标规则，确认目标 ID 未被占用后才准备本地变量、节点、边和 enable。已有目标（包括预检期间新出现的目标）会在任何变量/规则写入前停止，且永不覆盖。已有目标变量只有在类型、当前值和显示名完全兼容时才保留；真实创建仍会重新检查变量竞态。网关没有跨变量事务，并发变量修改仍可能让脚本中途停止，可用每次写前生成的 snapshot 恢复。`global` 变量作为明确的外部依赖保留，必须由目标网关预先提供。

默认 stdout 输出 JSON，适合脚本和 Agent 解析；加 `--pretty` 输出人读表格。

## 注意

CLI 写入后，已打开的网关网页需要手动刷新才能看到新规则或变量。npm 包不包含 GitHub 仓库里的官方前端参考 bundle、fixtures、开发计划或本地探测材料。
