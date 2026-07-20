# 小米中枢网关极客版 CLI（xgg）

> 使用 Codex、Claude 或其他 Agent 工具，调用本项目已审计并建模的小米中枢网关能力，进行 Vibe Coding 式的米家中枢网关自动化规则编程。

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

`xgg` 把网关的设备读取、规则图编辑、变量管理和运行日志都暴露成稳定、可解析的命令，因此特别适合交给 LLM Agent 按步骤操作。它让 Codex、Claude 等 Agent 不只是「帮你敲命令」，而是从需求出发，自己查设备、连规则图、校验、启用、读日志验证。下面三类用法覆盖从无到有、从坏到好、从有到更好的完整生命周期；不同能力的验证边界见后文「验证证据分级」。

### 用 LLM Agent 设计并创建自动化（主用法）

这是最主要的用法：把一句自然语言需求交给 Agent，剩下的交给它。

> 「天黑回家自动开玄关灯，半夜起夜把灯调到 10% 亮度。」

Agent 会先 `xgg device list` / `xgg device spec <did>` 看清你有哪些设备、它们能做什么，再按上文「创建自动化的标准流程」`rule new → node add → edge add → layout → validate → lint --strict` 把规则图建好。用户要求运行时才继续 enable，并在真实触发后查 logs；否则 readback 确认 `enable=false`。你只描述想要的效果，不必关心节点、边、表达式这些细节。

### 诊断与修复既有自动化

自动化「不工作」往往不是没创建，而是触发条件、时间段或动作目标写错了一处。与其在网页画布上反复猜，不如让 Agent 读真实运行日志定位：

```bash
xgg rule logs <rule-id> --tail 50
xgg rule view <rule-id> --pretty
```

Agent 可以把已解析的日志项与规则图 readback、可控触发结果结合起来，区分**已触发但动作没执行**、**条件没满足走了另一分支**等情况。定位之后，Agent 直接修改规则图，重新 `validate`、`lint --strict` 并按需要 `enable`，再结合 readback 与新的可观测结果确认修复——整个排障过程有据可查，而不是反复试错。

> `xgg rule logs` 输出的是从有界网关日志拉取中**成功解析的日志项**，再按 rule id / 时间 / level 过滤并应用 `--tail`。它不暴露未解析行、游标是否回绕或扫描是否完整，还受 `--max-blocks`、网关保留窗口和 tail 上限影响。因此空结果不能单独证明「从未触发」；它适合与规则图 readback 和可控触发证据结合排障，也不必和网页日志面板逐行对应。

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
cp -R "$CLI_PKG/skills/xgg-rule-authoring/." ~/.claude/skills/xgg-rule-authoring/

mkdir -p ~/.agents/skills/xgg-rule-authoring
cp -R "$CLI_PKG/skills/xgg-rule-authoring/." ~/.agents/skills/xgg-rule-authoring/

# 正文 build 标记内嵌除标记行外完整 SKILL.md UTF-8 字节的 SHA-256；正文改动但未更新标记会使测试失败
# 仓库/包内/已安装副本应显示同一个标记；不同就重新同步
grep '^<!-- xgg-skill-content-build:' \
  "$CLI_PKG/skills/xgg-rule-authoring/SKILL.md" \
  ~/.agents/skills/xgg-rule-authoring/SKILL.md
shasum -a 256 \
  "$CLI_PKG/skills/xgg-rule-authoring/SKILL.md" \
  ~/.agents/skills/xgg-rule-authoring/SKILL.md
# 递归比较才能同时覆盖 SKILL.md 与 references/；无输出即完全一致
diff -qr "$CLI_PKG/skills/xgg-rule-authoring" ~/.agents/skills/xgg-rule-authoring
diff -qr "$CLI_PKG/skills/xgg-rule-authoring" ~/.claude/skills/xgg-rule-authoring
```

从 GitHub 源码运行时，也可以直接把 [skills/xgg-rule-authoring/SKILL.md](skills/xgg-rule-authoring/SKILL.md) 交给 Agent 读取，或复制到本地 skills 目录：

```bash
mkdir -p ~/.claude/skills/xgg-rule-authoring
cp -R skills/xgg-rule-authoring/. ~/.claude/skills/xgg-rule-authoring/

mkdir -p ~/.agents/skills/xgg-rule-authoring
cp -R skills/xgg-rule-authoring/. ~/.agents/skills/xgg-rule-authoring/
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

自动化规则在网关中是一张有向图：节点是卡片，边是卡片输出到输入的连线。官方画布包含 25 种可执行卡片，另有 1 种无连接器、无运行时可达性语义的 `nop` 富文本备注节点。推荐流程：

```bash
xgg device list --pretty
xgg device spec <did>

xgg rule new --name "<自动化名称>"
xgg rule node add --rule-id <rule-id> --type deviceInput \
  --device-did <button-did> --device-event click --id n-click
xgg rule node add --rule-id <rule-id> --type deviceOutput \
  --device-did <target-did> --device-property <property> --value <value> --id n-action
xgg rule node add --rule-id <rule-id> --type nop \
  --text "按钮单击后执行目标动作" --background '#FFD966' --id n-note
xgg rule edge add --rule-id <rule-id> --from n-click:output --to n-action:trigger
xgg rule layout <rule-id>
xgg rule validate --rule-id <rule-id> --spec-aware
xgg rule lint --rule-id <rule-id> --strict
```

要点：

- 先跑 `xgg device spec <did>`，再选择属性、动作或事件，不要凭设备名猜字段。
- `deviceInput` 的 `--device-property` 属性模式和 `--device-event` 事件模式二选一，不能混用。事件参数比较只用 `--event-filter` / `--event-filter-include` / `--event-filter-between`；`--op`、`--threshold`、`--threshold2`、`--property-value`、`--property-include`、`--force-out-of-range` 只属于属性模式，event 模式传入时会在读取 session/spec、快照或写网关前拒绝。
- `deviceOutput --value '$scope.id'` 表示变量引用；字符串字面值若以 `$` 开头，需要把第一个 `$` 写两次，例如 `--value '$$hello'` 实际写入 `$hello`。`rule export` 会自动添加这一层转义。
- 连线完成后跑 `xgg rule layout <rule-id>`，让可执行卡片按数据流排布；`nop` 的自由位置会保留，避免备注离开它所说明的区域。
- 启用前跑 `xgg rule validate --rule-id <rule-id> --spec-aware` 和 `xgg rule lint --rule-id <rule-id> --strict`。`deviceOutput` action 必须使用 spec-aware 校验，才能核对当前 `action.in` 契约。只有用户授权运行时才执行 `xgg rule enable <rule-id>`，触发后用 `xgg rule logs` 验收；否则用 `rule view` 确认保持 `enable=false`。
- 对专门构造、完整下游均为纯软件 marker 的 Agent 探针，可用 `onLoad` 配合 `rule disable` + `rule enable` 重放，不需要人类物理按按钮；既有规则可能从 onLoad 驱动物理动作或业务变量，先审查完整下游并取得授权再重放。
- `nop` 只给网页画布添加备注，不参与连线或执行。纯文本用 `--text`；要保留标题、粗体、列表、对齐等格式，用 `--delta '<Quill ops JSON>'`（也接受 `{"ops":[...]}`），`rule export` / `rule import` 会无损往返 Delta、背景色、尺寸和位置，`rule layout` 不会搬动它。
- 严格 lint 与 enable 会按目标 pin 的必需输入语义检查动作可达性，并把状态“可用 / 可能为 true / 可能为 false”分开。独立事件源包括 `onLoad`、`alarmClock`、`timeRange`、`deviceInput`、`deviceInputSetVar`、`varChange`；`timeRange` 同时提供时间窗状态，并在进入窗口时发出事件（没有观察到等价的窗口结束事件）。`condition.condition` 未连线时按 `false` 处理，因此 trigger 可走 `unmet`，但 `met` 不可达。`register` 初值与 `setFalse` 提供 false，只有可达的 `setTrue` 再增加 true；`eventSequence` 的每个事件输入都必须可达；`logicAnd` / `logicOr` / `logicNot` 按布尔语义传播真假状态，`signalOr` 则任一路事件即可。`loop.stop` 与 `onlyNTimes.zero` 是控制输入，不能单独证明下游动作可执行。
- 同一节点的反馈边是网关和画布接受的合法结构；lint 会保留 warning，提醒确认反馈能终止。不要因为出现 self-loop 就删掉 `loop.output → loop.stop` 这类有限反馈。

### 精细编辑、完整比较与展示状态

不必为改一个字段而手工构造整图 JSON。先 `rule view` 读取当前图，再做目标化变更：

```bash
xgg rule node update --rule-id <rule-id> --node-id <node-id> --patch '{"cfg":{"name":"新名称"}}'
xgg rule edge remove --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule node remove --rule-id <rule-id> --node-id <node-id> --cascade-edges
xgg rule rename <rule-id> --name "新规则名"
xgg rule set-tags <rule-id> --tags "照明,夜间"       # --tags "" 清空
xgg rule delete <rule-id>
```

目标化 node/edge/layout/set 写入默认保留 live `enable`，所以对已启用规则的多步修改可能立即生效，不能把最后的 `rule enable` 当成唯一生效边界。先用 `rule view` 记录状态；会改变执行路径时，取得授权后先 disable 并 readback，或离线构造/校验后用一次原子 `rule set`。完成 validate/lint 后只按原状态和用户意图恢复。

节点 shortcut 还能保留官方画布状态并表达完整 typed 比较：

```bash
# 设备属性的整数集合；事件参数的集合与 between 范围
xgg rule node add --rule-id <rule-id> --type deviceGet \
  --device-did <did> --device-property mode --property-include 1,2,3
xgg rule node add --rule-id <rule-id> --type deviceInput \
  --device-did <did> --device-event <event> \
  --event-filter-include 2=1,2,3 --event-filter-between 3=18.5,26.5

# string 属性值不用数值 threshold；preload 与 simplified 都可显式往返
xgg rule node add --rule-id <rule-id> --type deviceInput \
  --device-did <did> --device-property mode --op eq --property-value open \
  --preload --simplified true
```

`deviceInput` / `deviceGet` 的数值属性，以及 number 型 `varChange` / `varGet`，使用 `--op between` 时必须同时显式传 `--threshold <lower>` 与 `--threshold2 <upper>`。省略任一边界都会在 session、spec、快照和写图之前被拒绝；不会再把省略的下界静默解释为 `0`。显式 `--threshold 0` 合法，非-between 标量比较仍保留历史默认 `0`。

`--preload` / `--no-preload` 适用于 `deviceInput`、`deviceInputSetVar` 的属性模式和 `varChange`，默认是官方新卡片行为 `false`；`deviceGet` 由输入事件主动查询，不支持 `preload`。旧图若在 `deviceGet.props` 中带该字段，普通导出会警告，`--strict-roundtrip` 会拒绝，避免重放时静默丢字段。`--simplified true|false` 是执行卡的 UI 紧凑状态。导出会保留受支持节点上的显式值。动作调用的 `--params` 依据 MIoT action input format 保留 number / boolean / string 原生类型，也支持动态变量：

```bash
xgg rule node add --rule-id <rule-id> --type deviceOutput \
  --device-did <did> --device-action <action> \
  --params '{"level":4,"enabled":true,"label":"hello","volume":{"$var":"global.targetVolume"}}'
```

`--params` 的 key 必须与 `action.in` 引用的 property short-name 一一对应，不能缺失、额外或重复；`action.in` 不能重复 PIID，不同 PIID 的 short-name 也必须唯一。持久化 `props.ins[i].piid` 必须严格等于 `action.in[i]`，因为网关 bundle 按索引绑定参数。原生 JSON 类型完全由 MIoT format 决定；只有数值 format 才应用数值 value-list/value-range/step，即使异常或厂商扩展 spec 给 bool/string 附带 numeric value-list，也不能把它们持久化成 number。非有限边界、`min > max` 或 `step <= 0` 的 range 会拒绝，number 变量还必须有同一份有效 min/max/step。整数动作入参只接受 JavaScript 安全整数，避免 `int64` / `uint64` 在 JSON number 中静默舍入；超出范围时命令会拒绝，不能声称已无损覆盖 64 位整数全集。

数值 property 比较确需越过有效 spec 的 range/step 时，`deviceInput` / `deviceGet` 可显式用 `--force-out-of-range`；它不绕过无效 range metadata（非有限、min>max、step<=0）、value-list、finite/safe-integer、operator 或 operand shape 校验，不能当作通用关闭校验。

### 导出、导入与未来节点

`rule export --format shell` 与 `rule import` 渲染出的脚本都必须先落盘审阅。JSON 路径用必填的 `--from-file`：

```bash
export SNAPSHOTS_DIR="$PWD/snapshots"
xgg rule export <rule-id> --format json --strict-roundtrip > rule-export.json
xgg rule import --from-file rule-export.json > replay.sh
xgg rule import --from-file rule-export.json --target-id <new-rule-id> > clone.sh
# 审阅最终 enable 行为后再执行 bash replay.sh / bash clone.sh
```

脚本先只读预检已捕获的规则内变量；若导出包含规则内变量，same-ID 重放会在 staging 前用兼容性保护准备这些变量，随后第一笔 **target-graph write** 用 `rule set --allow-cfg-overwrite` 原子写入空图和 `enable=false`（`--target-name` 也在这里生效）。clone 保留 `--expect-absent`，先成功创建禁用空壳，再准备 `R<target-id>` 变量。此后所有 node/edge 都在禁用状态下重建；源规则启用时只在完整组装后执行末尾 `rule enable`，源规则禁用时保持禁用。same-ID 重放会替换目标图，而且整段脚本是逐命令事务，不是 replay-wide lease：执行期间禁止网页画布、其他 xgg 进程或 API 客户端并发修改目标；staging 后失败会留下禁用的 partial graph，用逐写快照检查或恢复。

对当前 spec 有效、已建模的节点，完整 typed `include` / `between`、`preload`、`simplified`、`nop`、动作原生参数与规则内变量可在 `--strict-roundtrip` 下往返。strict export 会先核对持久化 `deviceOutput.props.ins` 与 `action.in` 的逐索引对应、PIID/short-name 唯一性、原生 literal 类型/取值域及变量 dtype/range；任何 typed replay 无法复现的动作输入或其他语义损失 warning 都会拒绝导出。permissive export 会保留明确 warning，并用索引语义、唯一占位 key 及无原型参数字典避免乱序、重复 key 或 `__proto__` 造成静默丢值。未来新增但当前 CLI 尚未建模的节点会导出成 opaque `--cfg` 结构，允许同 ID 无损重放并给出信息性 warning；CLI 无法安全发现其中的规则内引用，因此带 opaque 节点的导出会拒绝 `--target-id` 克隆。

### 分区设备与能力感知替换

已验证型号 `xiaomi.sensor_occupy.p1` 可把 siid 4…35 映射为 A-1…B-16 分区标签；其他型号返回空列表（不是通用分区发现）：

```bash
xgg device partitions <did> --pretty
```

替换规则里的设备卡时，先只读解释兼容性，再显式应用：

```bash
xgg rule device replacements --rule-id <rule-id> --node-id <node-id> --pretty
xgg rule device replacements --rule-id <rule-id> --node-id <node-id> \
  --target-did <did> --target-siid <siid> --target-piid <piid> --pretty
xgg rule device replace --rule-id <rule-id> --node-id <node-id> \
  --target-did <did> --target-siid <siid> --target-piid <piid> --pretty
xgg rule device replace --rule-id <rule-id> --node-id <node-id> \
  --target-did <did> --target-siid <siid> --target-piid <piid> \
  --apply --confirm-target-did <did> \
  --snapshots-dir "$PWD/snapshots"
```

替换支持五类设备卡（`deviceInput` / `deviceGet` / `deviceOutput` / `deviceInputSetVar` / `deviceGetSetVar`），会比较 URN 前五段、dtype、value-range、value-list、事件参数与动作入参。属性卡用 `--target-piid`，事件卡改用 `--target-eiid`，动作卡改用 `--target-aiid`，三者互斥；使用 selector 必须同时给 `--target-did`。目标存在多个兼容 mapping 时必须按 discovery 结果消歧。`replace` 默认 dry-run，只有完全相同的 selector 计划确认后才加 `--apply`；写路径在同一 mutation lease 内强制快照、fresh spec/graph 复核、严格校验和写后 readback。网关没有 CAS，应用期间不要同时编辑网页画布。

默认 replacement discovery 会排除 ghost device。若显式用 `--target-did` 聚焦 ghost 做诊断，候选会返回 `eligible:false` 及原因，但不会生成 `planId`，因此不可应用。`--apply` 还会在快照后重新读取设备清单；即使目标在 dry-run 时可用、应用前变成 ghost，也会在 `setGraph` 前硬拒绝。

### 验证证据分级

- **离线确定性检查：** CLI `--help`、schema、unit/integration test、`rule validate --body/--stdin` 和 bundle 对照，证明命令形状、序列化与静态约束。
- **安全实机探针：** 已验证未接状态的 `condition` 走 `unmet`、同节点 `loop.output → loop.stop` 有限反馈、`timeRange` 在窗口进入时发出事件并提供独立状态；这些探针只写临时规则/变量，不驱动物理设备。
- **目标网关验收：** 真实 property/event/action、分区型号、设备替换、物理触发和恢复操作依赖具体设备与固件，必须在用户网关上重新跑 `spec → validate --spec-aware → lint → trigger/log/readback`，不能从离线测试推断“全部实机验证”。

### 离线校验候选规则

`rule validate --body` 和 `--stdin` 默认是确定性的纯本地检查：不会读取 session、连接 daemon/网关，也不会访问公网 MIoT spec 服务。适合 CI、预提交检查和尚未登录网关时验证卡片 schema、字段与表达式：

```bash
xgg rule validate --body candidate.json
jq '.' candidate.json | xgg rule validate --stdin
```

需要额外核对设备 property/event 参数与 dtype，或 `deviceOutput` action 的 `action.in`/`props.ins` 输入契约时，显式加 `--spec-aware`；设备 action 图的主验收流程必须使用它。动作检查覆盖 missing/extra/duplicate PIID、逐索引顺序、重复 short-name、literal 原生类型与统一数值域、变量 dtype 与有效 number range metadata；property-write 节点保持原有行为。该选项会访问公网 MIoT spec registry；404 会作为 warning 告知该 URN 的 spec 检查已跳过，超时、5xx 或无效 spec 会作为独立 error issue 返回，同时保留同一次运行已发现的本地结构/表达式问题：

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
xgg device get <did> [--pretty]
xgg device spec <did>
xgg device partitions <did> [--pretty]

xgg rule list [--pretty]
xgg rule view <rule-id> [--pretty]
xgg rule new --name "<name>" [--id <id>]
xgg rule node add --rule-id <rule-id> --type <type> ...
xgg rule node update --rule-id <rule-id> --node-id <node-id> --patch '<JSON>'
xgg rule node remove --rule-id <rule-id> --node-id <node-id> [--cascade-edges]
xgg rule edge add --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule edge remove --rule-id <rule-id> --from <node:pin> --to <node:pin>
xgg rule layout <rule-id>
xgg rule validate (--rule-id <rule-id> | --body <file> | --stdin) [--spec-aware]
xgg rule lint --rule-id <rule-id> [--strict]
xgg rule enable <rule-id>
xgg rule disable <rule-id>
xgg rule rename <rule-id> --name "<name>"
xgg rule set-tags <rule-id> --tags "<tag1,tag2>"
xgg rule delete <rule-id>
xgg rule logs <rule-id> [--tail 50] [--level error] [--follow]
xgg rule export <rule-id> --format shell [--target-id <new-rule-id>]
xgg rule export <rule-id> --format json > rule-export.json
xgg rule import --from-file rule-export.json [--target-id <new-rule-id>]
xgg rule device replacements --rule-id <rule-id> --node-id <node-id>
xgg rule device replace --rule-id <rule-id> --node-id <node-id> --target-did <did> [--apply --confirm-target-did <did>]

xgg variable list [--pretty]
xgg variable get <scope> [--pretty]
xgg variable get-config --scope global --id <id> [--pretty]
xgg variable create --scope global --id <id> --type number --value <value> --name "<name>"
xgg variable get-value --scope global --id <id>
xgg variable set-value --scope global --id <id> --value <value>
xgg variable set-config --scope global --id <id> --name "<new-name>"
xgg variable watch --pretty
xgg variable watch --follow [--max-events <N>]

xgg backup list --from fds [--pretty]
xgg backup local-export --output ./gateway-rules.bak
xgg backup local-import --input ./gateway-rules.bak --dry-run
xgg backup local-import --input ./gateway-rules.bak --confirm-replace-all --snapshots-dir <dir>
xgg backup progress --from fds --progress-id <id>
xgg backup cloud-export --from fds --did <did> --ts <ts> --file-name <name> --output ./history.bak --snapshots-dir <dir>
xgg backup generate --from fds --did <did> --ts <ts> --file-name <name>
xgg backup load --from fds --did <did> --ts <ts> --file-name <name> --snapshots-dir <dir>
xgg backup delete --from fds --did <did> --ts <ts> --file-name <name> --snapshots-dir <dir>
xgg backup config get --from fds
xgg backup create --from fds --file-name <name> [--snapshots-dir <dir>] [--wait]
xgg backup download --from fds --did <did> --ts <ts> --file-name <name> [--snapshots-dir <dir>] [--wait]
xgg backup config set --from fds --auto-backup <true|false> [--snapshots-dir <dir>]

xgg api <method> [--kind read] [--params '<json>']
xgg api <method> --kind write --snapshots-dir <dir> [--params '<json>']
```

默认 stdout 输出 JSON，适合 Agent 解析；需要人读表格时加 `--pretty`。例外：`xgg rule logs` 默认输出人类表格，需要 JSON 时显式加 `--json`。

## 重要限制

- 在已审计的极客版网页 bundle 控制路径中，规则、变量、设备与备份操作走加密 WebSocket 二进制协议承载的 RPC；`xgg` 复用了这条路径，登录使用米家 App 提供的 6 位码。这不是对所有固件、服务或未来版本“绝不存在 HTTP API”的证明。
- 已打开的网关网页不会自动看到 CLI 写入的规则、变量或 scope。CLI 写入后请刷新网页，再判断 UI 是否同步。
- `xgg device list` 与默认 replacement discovery 都排除 ghost device。显式聚焦 ghost 的替换 dry-run 仅返回 `eligible:false` 诊断结果且没有 `planId`；不要把网页标为“设备已丢失”的设备作为规则目标。
- 变量类型只有 `number` 和 `string`。开关状态建议用数字 `1/0` 或字符串表示。
- 变量命令的 `--value` 按变量类型处理：`number` 使用数值转换；`string` 原样保存收到的 argv 文本。`--value Seed` 保存 `Seed`，而 `--value '"Seed"'` 会把双引号也作为数据保存；不要为字符串额外添加 JSON 引号。
- `variable get-config` 读取单个变量的配置；`set-config` 只更新显示名，不改类型或当前值，并按其他写命令一样执行 snapshot guard。
- 变量 scope 默认用 `global`。规则本地变量使用当前规则的 `R<rule-id>`；变量写命令会确认其中的 rule id 确实存在，规则节点也只接受与自身 `--rule-id` 匹配的本地 scope。合法本地 scope 不需要 `--allow-unknown-scope`；跨规则、不存在或自定义 scope 会告警并在严格校验中失败。如果 rule id 含连字符，本地变量 scope 无法按该约定合法创建，建议改用 `global` 或使用纯字母数字 rule id。
- `rule export` 会用当前表达式解析器回读生成的 `varSetNumber` / `varSetString --expr`；若源图的结构化 elements 无法用 DSL 无损表示（例如变量后紧跟会被吞入变量 ID 的字母或数字常量），导出会以 `ConfigError` 拒绝。请先在源表达式中加入显式分隔符，或改用 `rule view` 的整图 JSON 往返。
- `rule export/import --target-id` 克隆时只把源规则的 `R<source-id>` 迁移为 `R<target-id>`。脚本先只读预检完整变量计划，再以 `expect-absent` 创建空目标规则，确认目标 ID 未被占用后才准备规则内变量；已有目标（包括预检期间新出现的目标）会在任何变量/规则写入前失败，绝不覆盖。兼容的已有变量会保留，类型/值/显示名冲突也会在首次写前失败。`global` 始终是明确的外部依赖，不会被创建或改写。
- 在已审计 bundle 的调用面与当前 `xgg` 已建模接口中，未发现“客户端随时读取任意设备实时属性”的通用 RPC。需要观测实时值时，用 `deviceInputSetVar`（变化推送）或 `deviceGetSetVar`（由规则事件触发读取）写入变量，再用 `xgg variable watch --follow` 观察；不要把这个结论外推为所有固件都绝无其他私有接口。
- `backup local-import` 同时接受完整 version-2 `.bak` 与官方旧版 rules-only 数组；旧版没有变量，解码后规范化为 `variables: {}`。`--confirm-replace-all` 会先删除当前全部规则和变量，再仅重建备份包含的内容，因此导入旧版文件不会保留或重建任何变量。固定先跑 `--dry-run` 并核对 `createVariables` 等计数；应用路径必须有 rollback snapshot，且不应在未授权的家庭网关上做恢复试验。
- 从历史云备份取得可移植文件时优先用 `backup cloud-export`：它会在同一 mutation lease 内自动 download、确认进度并 generate，再于 lease 释放后原子发布官方 envelope 的 `.bak`，stdout 不包含完整规则/变量。低层 `backup generate` 只适合明确知道同一备份已在网关缓存中的高级流程。
- `backup load` 复现网页 Bundle 的完整恢复前置：在同一 mutation lease 内先 download、确认缓存进度，再调用 load 并等待可确认的恢复终态；不需要手工预下载。下载 ACK/进度含糊时绝不进入 load；load 若只返回 `{}` 等无进度 ACK，仍按 `NOT_CONFIRMED` 封锁，不能把网页固定等待数秒当成完成证据。
- `xgg api` 是低层逃生口，不建议把它作为常规自动化编辑路径。read 是普通/未知方法的默认 intent；当前已知写接口必须显式传 `--kind write`，并进入与 typed 写命令相同的 Agent guard、完整写前 rollback snapshot 与 `NOT_CONFIRMED` 超时分类。未知的新接口仍可显式选择 read 或 write，JSON 输出会回显最终 `kind`。

## GitHub 与 npm 内容边界

GitHub 源码发布根目录是本目录。**本仓库不包含任何小米官方前端 bundle 或专有代码**。

npm 只发布 `@eyaeya/xgg-core` 与 `@eyaeya/xgg-cli` 两个包。`@eyaeya/xgg-cli` 依赖并自动安装 `@eyaeya/xgg-core`，用户只需要全局安装 CLI 包。两个包的 `package.json` 使用 `files` allow-list：core tarball 只包含 `dist`、`LICENSE`、`README.md`；cli tarball 额外包含整个 `skills/xgg-rule-authoring/`（正文与 references），不会包含 fixtures、开发计划、探测记录、快照或本地逆向材料。

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
- `tar -tzf` 确认 core tarball 只含 `dist/LICENSE/README.md`，cli tarball 只额外含 `skills/xgg-rule-authoring/` 正文与 references（不含源码、fixtures、本地材料）。
- 公开树中没有真实 IP、6 位登录码、设备 DID、家庭名或本地快照。

发布命令：

```bash
npm publish release-artifacts/eyaeya-xgg-core-*.tgz --access public
npm publish release-artifacts/eyaeya-xgg-cli-*.tgz --access public
```

必须先发布 `@eyaeya/xgg-core`，再发布 `@eyaeya/xgg-cli`，因为 CLI 包依赖 core 包。

## Agent 权威参考

供 AI Agent 操作本 CLI 的完整权威指南（含 25 种可执行卡片 + `nop` 备注节点、pin 颜色规则、变量模型、表达式、调试流程与分级验证边界）见 [skills/xgg-rule-authoring/SKILL.md](skills/xgg-rule-authoring/SKILL.md)。

## License

GNU 通用公共许可证 v3 或更新版本（GPL-3.0-or-later），见 [LICENSE](LICENSE)。

Copyright (C) 2026 不系 (@eyaeya)
