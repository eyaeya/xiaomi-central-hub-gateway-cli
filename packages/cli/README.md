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
```

默认 stdout 输出 JSON，适合脚本和 Agent 解析；加 `--pretty` 输出人读表格。

## 注意

CLI 写入后，已打开的网关网页需要手动刷新才能看到新规则或变量。npm 包不包含 GitHub 仓库里的官方前端参考 bundle、fixtures、开发计划或本地探测材料。
