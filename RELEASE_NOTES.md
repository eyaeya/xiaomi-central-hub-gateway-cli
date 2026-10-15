# xgg v3.2.2 · 修正 Skill 目录发现误报

3.2.1 正式发布后的本机自动升级已成功同步 CLI 与共享 Skill，但额外目录扫描把无权访问的无关应用配置目录误报为 Skill 同步失败。本补丁只在确认额外目录存在 skills 子目录后才把它作为候选；已知 Agent 目录、显式自定义路径及已发现 Skill 的真实权限错误继续逐路径报告。

不修改无关用户目录的权限。保留完整树校验、别名、定制备份、恢复和当前查询交接，CLI、Core 与随包 Skill 统一为 3.2.2。

## v3.2.1 历史：Agent Skill 随 CLI 自动更新

修复 CLI 已升级而 Agent 安装目录仍使用旧 Skill 的缺口。基于 v3.2.0 开发，完整保留离线灯光公式能力；CLI、Core 与随包 Skill 统一为 3.2.1。

- **同次自动升级：** 新 CLI 接手旧版本的自动升级交接，在当前查询前同步已识别的 Skill 副本。无需 GitHub 或额外执行 skills CLI。
- **离线修复：** 符合条件的前台查询从包内修复旧 Skill，不受 registry 冷却期影响；显式 update 在无新版时也修复。check/help/version、写操作及离线灯光公式保持原有只读或无自动更新边界。
- **完整目录与恢复：** 校验整个 Skill 树，保留软链接并去重；先暂存和备份，再替换、回读，失败恢复。定制原件备份后更新为官方版本，明确告知定制未自动合并。未知来源、无标记、较新版本或不安全目录保留并报告，部分失败不冒充全部成功。
- **Agent 重新读取：** 更新提示包含入口路径，要求重新读 SKILL.md 与任务 reference；不声称能替换已经进入对话的旧指令。

自动同步适用于识别出的既有安装；首次注册仍按 README 安装流程。自定义位置用 XGG_SKILL_DIRS。3.2.0 的显式 update 首次升级没有新进程交接，该历史路径在后续符合条件的查询或再次运行新版 update 时同步；3.2.0 自动升级路径在本次调用完成。

## v3.2.0 历史：内置灯光动态公式

新增完全离线的 `xgg light formula`，为 Agent 生成极客版可用的色温或亮度表达式，并预览指定日期的全天数值。只需选择色温或亮度，无需在重复的亮度算法之间选择。CLI、Core 与完整 Skill 同步为 3.2.0。

- **两个清晰入口：** `temperature` 输出 K，`brightness` 输出百分比；纬度和期望上下限显式指定。亮度默认采用标准曲线，按需提供一个 `--speed` 过渡倍率（默认 1）、`--offset-minutes` 和 `--invert`。小于 1 更柔和，大于 1 更陡。
- **公式与预览一致：** 修复来源工具的正午除零和非有限数值边界，预览遵循实际公式的向下取整；返回归一化参数、单位、模型限制与 30 秒建议重算周期。日期只控制预览，公式运行时读取网关日期与时钟。
- **适合 Agent 调用：** 默认 JSON，可用 `--expression-only` 取得单行公式，或 `--pretty` 查看曲线样本。严格拒绝错误参数；无需登录、不联网、不触发自动更新、不写入设备或规则。
- **Skill 主动建议：** 配置动态灯光时提示能力、复用已知参数并补问缺失信息；普通开关灯不插入推荐。应用前核对目标属性的单位、范围和步进，沿用快照与规则校验流程。

```bash
xgg light formula temperature --latitude 23.129 --min 3200 --max 5400 --date 2026-10-15 --pretty
xgg light formula brightness --latitude 23.129 --min 10 --max 100 --speed 0.5 --offset-minutes 30
```

数学行为参考 [Jimmy Website 的 MIoT Geek 工具](https://lzj.ac.cn/tools/iot/miot-geek)，由 xgg 独立实现。模型使用近似月份和固定正午，不是精确天文日出日落计算；极区有界延伸和偏移后的午夜跳变已有说明。离线计算与语法验证不等于目标灯具的物理验收。

## v3.1.0 历史：前台自动更新与镜像回退

新增 `xgg update --check` 和 `xgg update`，分别用于独立检查版本与升级当前 npm 全局安装，无需米家授权或网关登录。CLI、Core 与随包 Skill 同步为 3.1.0；已有云端直控、中枢登录和规则能力继续保留。

- **前台择机升级：** 有限只读命令通过命令行解析后、业务查询前检查更新，成功检查后间隔至少 24 小时、失败后至少 1 小时。写操作、登录/扫码、后台 daemon、持续观察、help/version 和 CI 不触发；`XGG_AUTO_UPDATE=0` 可关闭。
- **本次调用立即生效：** 升级完成后切换到新 CLI，由它执行当前查询且仅执行一次；旧 CLI 不先执行业务动作，新进程不递归更新。更新提示只写 stderr，业务 stdout 与退出码来自执行查询的 CLI；离线等更新失败继续原查询。已有 daemon 和登录会话保持运行。
- **网络回退：** 默认 npm 官方源失败后尝试 npmmirror，检查与暂存安装均支持回退；`--registry` / `XGG_UPDATE_REGISTRY` 可指定可信 HTTPS registry。结果标明来源与降级状态，镜像可能落后，离线不算最新，也不保证所有大陆网络可达。
- **受控替换：** 仅管理已确认的 npm 全局安装，固定版本暂存完整依赖、核对 CLI/Core 与运行检查后再替换；保留失败恢复路径，并以锁防止并发更新。源码、局部依赖、npx、pnpm 链接和无法确认的安装不自动覆盖，不使用 sudo。
- **Skill 分开同步：** 包内完整 Skill 随升级更新，Agent 全局发现目录中的副本仍须按 README 显式同步，不自动覆盖定制内容。

```bash
xgg update --check
xgg update
xgg update --registry https://registry.npmmirror.com
```

首次安装或旧版本尚无 `update` 命令时，使用文末的 npm 安装命令，再按 [README](README.md#检查与升级) 完成 Skill 同步与验证。

## v3.0.1 历史：补齐五类 11 款中枢候选

v3.0.1 修正中枢定位指引的候选遗漏：音箱与智能存储也必须进入查找流程，不能把此前独立中枢、路由器、家庭屏的例子当作类别白名单。CLI 帮助、完整 Skill、README 与 npm 包说明同步更新；已有云端直控、扫码、自动取码和双向联调能力继续保留。

## 本轮修复：先完整查找候选，再验证目标接口

| 候选类别 | 本次纳入的型号 |
| --- | --- |
| 独立中枢 | 小米中枢网关。 |
| 路由器 | BE10000 Pro、BE7200 Pro、BE6500 Pro、BE3600 Pro 套装主路由、BE3600 Pro 网线版主路由。 |
| 屏幕 | Xiaomi 智能家庭屏 11、小米智能中控屏 Max。 |
| 音箱 | Xiaomi Sound 2 Max、Xiaomi Sound 2 Pro。 |
| 智能存储 | 小米智能存储：中枢能力与协议网关不同，该候选仅有中枢、无网关能力。 |

五类 11 款全部纳入候选查找、地址发现与取码工作流。小米智能存储的中枢能力不等于协议网关能力；不能因为它没有网关功能就排除，也不能把其他设备的蓝牙/Mesh 网关能力当作支持极客版的证明。完整型号依据、尚待核实项和回退操作见 [中枢定位指南](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli/blob/v3.0.1/skills/xgg-rule-authoring/references/gateway-discovery.md)。

实现继续使用已有、不限制产品类别的双 RPC 路径：按确认的 DID 发现地址，再获取六位码并在内存中登录。没有新增型号硬编码或猜测接口，云端取码失败时保留明确错误并按缺失信息回退；纯网络故障先检查地址、端口、同网与路由，不立即更换登录码。

**候选目录不是 11 款全量实机认证。** 官方中枢说明、用户提供的候选、极客版与两个 RPC 的实际支持需要分别记录。此次改动前已用已发布的 3.0.0 在现有路由器集成中枢完成无已知 IP、新 session 的只读登录回归；该单机结果不能外推至其他型号。此前 3.0.0 与 2.2.0 的实测记录保留如下，并明确对应轮次。

## v3.0.0 历史：从米家扫码到自主发现中枢，云端与本地一起验证

xgg 将米家云端直控、Agent 对话扫码、中枢地址发现、自动取码和双向联调整合为完整工作流。用户不知道中枢 IP 时，Agent 也能先从米家设备清单确定候选，再通过云端发现地址并登录；云端路径不可用时，有明确的手动地址与六位码回退。

v3.0.0 基于已发布的 v2.2.0，统一交付已有云端能力与本轮中枢定位、登录引导修订。本次由项目维护者按能力升级指定 3.0.0 大版本号；已有命令与习惯学习、结构化 trace、规则保真导入导出、设备替换和写入保护继续保留。`@eyaeya/xgg-core`、`@eyaeya/xgg-cli` 与随包 Skill 一同升级。

### v3.0.0 重点：不知道 IP，也能自主找到并登录中枢

登录不再以用户提前抄好 IP 和六位码为默认前提。Agent 先完成米家扫码授权、列出目标家庭设备，再从具备中枢能力的设备中确认实际候选；完整的五类清单在 v3.0.1 中补齐，见上文。设备名或品类只是识别线索，具体型号、固件及云端 RPC 必须逐一核对；多候选时先确认目标，不能取清单第一台。

官方产品页提供了具体区分：[BE6500 Pro](https://www.mi.com/xiaomi-routers/6500pro) 内置中枢且支持极客版；[家庭屏 11](https://www.mi.com/xiaomi-smartdisplay-11) 确认集成中枢，但未确认极客 RPC；[家庭屏 Pro 8](https://www.mi.com/xiaomi-smartdisplay-pro-8) 则明确需要另购中枢。蓝牙 Mesh、内置中枢与支持取码 RPC 不能互相替代，产品昵称也不能代替完整型号。

```bash
xgg cloud home list
xgg cloud device list --home-id <HOME_ID>
# 省略 --base-url，且不保留旧 XGG_BASE_URL 覆盖，让云端发现地址。
xgg cloud gateway login --did <GATEWAY_DID>
# 按 nextCommand.argv 续接，或显式使用返回地址。
xgg status --base-url <RETURNED_BASE_URL>
```

纯网络故障先核对地址、端口、是否同网及路由，不立即换码。只有云端地址发现/取码不支持，或确实需要补充地址、认证信息时，才说明具体失败原因，引导用户从对应米家设备的中枢/极客版页面补充所缺信息；需要手动认证时使用当前地址与新的六位码：

```bash
xgg login --base-url <USER_PROVIDED_URL> --code <FRESH_CODE>
```

v3.0.0 当轮已实测去除地址、会话及登录码的环境覆盖，使用新的独立 session，仅凭明确 DID 与云端授权发现地址、取得码并登录，返回 `reused:false`，随后 `status.live=true`。本机仍须可访问发现的局域网地址；这证明了目标路由器集成中枢的流程，不代表全部候选型号都支持相关 RPC。完整流程加入随包 Skill 的 `references/gateway-discovery.md`。

### 直接操作米家设备，不必先经过中枢规则

v2.2.0 已提供的 `xgg cloud` 命令组基于 [Do1e/mijia-api](https://github.com/Do1e/mijia-api) 的公开实现整合为原生 TypeScript，不要求 Python、uv 或运行中的网关 daemon。

- 发现家庭、房间和设备，按 DID 或唯一名称选择目标。
- 查询 MIoT spec，读取单个、多个或全部可读属性；按类型、枚举与范围校验设置值和动作参数。
- 设置设备状态、执行动作、列出和运行场景，查询耗材与统计，使用小爱音箱。
- 用 `cloud device watch` 持续观察设备报告的属性，输出初始快照和变化 NDJSON。
- 用独立云端授权控制设备；网关的规则、变量、备份与日志能力继续使用原有命令。

```bash
xgg cloud device list
xgg cloud device spec --did <DID>
xgg cloud device get --did <DID> --property light.on --source device
xgg cloud device get --did <DID> --properties light.on,light.brightness --source device
xgg cloud device watch --did <DID> --property light.on --source device
```

`watch` 是有界轮询，默认间隔 3 秒、持续 60 秒，不是服务端事件推送；时间戳表示采样观察时间。采样错误不会被伪装成设备状态变化，间隔内的短暂变化仍可能遗漏。

### 明确设备直读来源，避免缓存造成恢复误判

实机测试发现：设备已恢复，云端默认数据源仍可能返回恢复前的缓存值。使用 v2.2.0 已提供的 `--source auto|device|cache`，明确每次查询使用的来源。`device get` 默认 `auto` 保持兼容，`device watch` 默认 `device`；设备写入前的原值读取固定为 `device`，不降级到缓存。输出中的 `sourcePolicy` 让 Agent 可以核对实际请求策略。

回读和恢复验收使用 `--source device`，请求设备 RPC 查询；并非所有设备都支持该模式，失败时不能退回缓存后宣称验证成功。`auto` / `cache` 的结果及 `updateTime` 只能作为缓存或上报证据，不能证明设备刚刚改变状态。设备直读也仍然是设备报告值，不能替代现场观察。

### 用户扫码，Agent 完成后续登录

运行 `xgg cloud login` 后，已有授权可以直接复用；需要新授权时，CLI 生成本地二维码 PNG，并返回 `qrImagePath`、`qrMarkdown`、`expiresAt` 和 `nextAction`。Agent 在对话中展示二维码，明确提示用户使用**米家 App 扫码确认**。用户确认后，再调用有界的完成命令：

```bash
xgg cloud login
xgg cloud login --complete --wait-ms 30000
xgg cloud status
```

两阶段流程让 Agent 有机会展示图片、等待用户响应，再完成授权。二维码过期或需要重开时使用 `--restart`。图片展示不受支持时仍保留 `qrUrl` / `loginUrl`。

默认凭据路径与 mijia-api 的 `~/.config/mijia-api/auth.json` 兼容，可复用已有授权，也可指定独立文件。凭据可刷新，但不保证永久有效；撤销、失效或账号验证仍可能要求重新扫码。二维码和登录链接是临时授权材料，不能写入公开日志、fixture 或提交。

### 自主取得中枢六位码，减少人工接力

```bash
xgg cloud gateway login --did <GATEWAY_DID>
# 使用返回的 baseUrl；或先按 nextCommand.argv 执行生成的 status 命令。
xgg rule list --base-url <RETURNED_BASE_URL>
```

Agent 确定实际中枢设备后，可以通过云端取得局域网地址与六位登录码，在内存中交给既有登录流程。已有 live daemon 会被优先复用；验证码不会进入输出、命令行参数或快照。该流程已在支持相关 RPC 的路由器集成中枢上验证。

成功结果明确返回 `baseUrl`、`nextCommand.argv` 与 `nextAction`。后续本地命令仍须携带返回的 `--base-url` 或显式设置 `XGG_BASE_URL`，登录不会隐式选择默认网关；自定义 session 文件也须通过同一 `--session-file` / `XGG_SESSION_FILE` 延续。生成的下一步命令保留该文件的绝对路径，Agent 可以据此继续操作。

中枢候选包括独立设备、路由器、屏幕、音箱与智能存储，不能因为独立 hub 离线就判断中枢不可用。电脑仍需能访问中枢的局域网地址。目标设备不支持云端取码时，保留原来的手动六位码登录。

### 双向联调：设备状态和规则日志互相验证

**中枢 → 云端：** Agent 修改规则图，完成 `validate --spec-aware` 与 `lint --strict` 后，按用户授权启用已审查的测试入口；通过云端 `get --source device` / `watch` 检查目标设备，再结合网关日志核对动作分支。

**云端 → 中枢：** Agent 记录原值和测试开始时间，通过云端改变设备；在中枢日志、变量中查看是否触发了预期规则。测试完成先停用测试入口，再恢复原状态并以 `--source device` 回读，观察规则保留供用户检查。

```bash
xgg cloud device get --did <DEVICE_DID> --property <PROPERTY> --source device
xgg cloud device set --did <DEVICE_DID> --property <PROPERTY> --value <JSON> \
  --snapshots-dir ./snapshots/
xgg rule logs <RULE_ID> --since <ISO_TIMESTAMP> --json --base-url <RETURNED_BASE_URL>
# 最后按记录的原值恢复设备，再用 --source device 回读确认。
```

API ACK、`accepted`、设备回读、网关执行日志各自提供不同证据。日志中的成功或云端上报的新值，不等于现场肉眼确认物理动作。对超时或状态未知的写入，先查询设备与日志，不自动重发。

### 延续云端能力审查带来的升级

- **更完整的读取路径：** 支持批量属性读取和无需账号的公共 spec 查询，减少逐个属性调用及不必要的认证。
- **更清晰的身份与定位：** 家庭、房间与设备信息一起使用；缓存复用查询结果，减少多步操作的重复请求。
- **更安全的默认行为：** 音箱指令默认静默；写前固定从设备读取原值，未确认时阻止写入；状态未知的写入不自动重放。
- **更易读的证据：** 属性观察输出明确标记云端来源、轮询模式及设备报告值，避免把轮询称作推送或物理验证。
- **同步升级 Skill：** 优先米家扫码授权，再自主取码登录中枢；新增两种联调流程、恢复步骤和证据边界。安装须复制完整 Skill 目录，包括 `references/`。

云端设备变更接入既有 Agent 快照保护，但快照内容独立于网关 dump。可读属性会记录写前原值；动作、场景、语音指令及明确的只写属性仅有审计记录，不承诺可以自动撤销。真实快照保持私有。

### 能力与验证边界

这次覆盖主要云端业务路径，**没有宣称完全替代 mijia-api 的所有入口和工具**。上游 MCP 服务、批量 set/action、按场景名称或批量运行场景的便利入口、绕过 spec 的原始 MIoT 高层入口、磁盘 spec 缓存、消息检查业务输出和 HAR 解密辅助工具尚未集成；地区与语言目前使用中国区 / zh_CN，没有提供多地区切换。具体设备能否执行某项操作取决于账号权限、在线状态、设备 spec 与固件；不可恢复动作不能用“测试后恢复”笼统代替风险判断。

此前 v2.2.0 云端集成轮次的真实设备验收覆盖了 37 台设备的清单（30 台在线、7 台离线），从中选择 17 台进行可逆写入验证：

| 验收项 | 结果 |
| --- | --- |
| 写前设备直读保护 | 1 台未通过，CLI 阻止写入。 |
| 实际写入与恢复 | 16 台实际写入，16 台最终原值恢复均已回读确认。 |
| 测试变化确认 | 14 台变化已回读确认；2 台仅有 ACK，未确认测试变化。 |
| 未确认项 | 摄像头亮度和窗帘唤醒设置，不能计作动作成功。 |

此前 v2.2.0 构建的**中枢 → 云端**测试中，网关输出驱动灯变化，云端 `watch` 观察到 `false → true → false`；**云端 → 中枢**测试中，云端改变灯后，中枢变量记录 `1`，恢复后记录 `0`。两条测试规则均停用并保留。恢复确认、设备报告的测试变化和现场物理动作是不同结论，没有宣称 16 台全部动作成功或肉眼观测全部效果。

v2.2.0 轮次的已有授权复用和**从新扫码到中枢的完整链路**均已验证：使用独立的新授权文件，米家 App 扫码确认后 CLI 返回 `authenticated:true`；该新授权成功查询云端设备，并通过新的独立网关 session 自动取码、登录及读取规则列表，全程无需手抄六位码。改用唯一图片路径后的成功对比支持界面缓存复用旧图的解释，未取得界面缓存内部证据。所有动作、场景、音箱指令和统计类型没有因此获得全量实机认证。完整证据与未覆盖范围见 [云端审查与实测记录](docs/superpowers/reviews/2026-10-13-cloud-review-results.md)。

## 升级 CLI 与完整 Skill

按 [README 安装流程](README.md#安装人类与-ai-agent) 安装 CLI，并用对应版本的 Git tag 安装完整 Skill，包含 `references/`。已有安装也要同步更新 Skill，不能只替换二进制。

```bash
npm install -g @eyaeya/xgg-cli@3.2.2
xgg --version
xgg cloud --help
npx --yes skills add eyaeya/xiaomi-central-hub-gateway-cli@v3.2.2 --global --all
```

Agent 仍须执行 README 的全局 Skill 发现验证，确认实际调用者能够加载该 Skill。源码开发则运行 `pnpm install`、`pnpm build`，通过 `node packages/cli/dist/cli.js` 调用当前 checkout，并用 `skills add .` 安装同一份指南。

协议来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，接口见 [cloud API](docs/api/cloud.md) 与 [自动取码登录](docs/api/cloud-gateway.md)。本项目是非官方工具，与小米没有隶属关系或授权背书。
