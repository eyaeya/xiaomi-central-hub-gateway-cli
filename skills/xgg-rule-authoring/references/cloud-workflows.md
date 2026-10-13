# 米家云端与中枢网关联调

处理扫码登录、设备直接读写、持续观察，或云端与网关交叉验证时读取本文。云端命令无需网关 daemon；规则、变量和网关日志仍走本地网关会话。

## 先确认使用的 CLI

先检查 `xgg cloud --help`。旧版全局 CLI 可能没有云端能力，不能仅凭版本号判断它包含本次开发改动，也不要为使用新云端功能覆盖或降级另一套较新的规则 CLI。

在采用 `@xgg/cli` 源码 workspace 的开发仓库，将本文 `xgg` 替换为 `pnpm --filter @xgg/cli dev`，例如：

```bash
pnpm --filter @xgg/cli dev cloud --help
```

发布工作区先构建，再用 `node packages/cli/dist/cli.js cloud --help`。需要混用不同构建时，分别记录云端和规则命令的实际入口，勿将新 Skill 的参数传给不支持它们的旧 CLI；以对应入口 `--help` 核对。

## 登录：先云端扫码，再自主建立网关会话

1. 先完成 CLI、账号文件和执行入口等准备工作，安排在用户能够立即扫码时才生成二维码；生成后立即展示，不把扫码延后到构建、测试或研究结束。`xgg cloud login` 优先复用或刷新已有授权；`authenticated:true` 时无需扫码或调用 complete。默认凭据兼容 `~/.config/mijia-api/auth.json`，也可用 `--auth-file` / `XGG_CLOUD_AUTH_FILE` 隔离账号。
2. 若返回 `authenticated:false,status:"pending"`，先检查 `expiresAt` 尚未到期，再**在对话中直接展示返回的 `qrMarkdown`，或用 `qrImagePath` 的绝对路径嵌入图片**；不要只贴 JSON 或图片路径。向用户说明：“请打开米家 App 扫描这个二维码，并在手机上确认登录。” `loginUrl` 仅作打不开图片时的备用入口。二维码只在当前授权对话展示，不纳入公开报告、提交或长期知识库。
3. 展示二维码之后，优先使用返回的 `nextCommand.argv` 有界等待，默认等价于 `xgg cloud login --complete --wait-ms 20000`，期间继续向用户说明当前状态。该数组保留所选 `--auth-file` 的绝对路径、非默认 timeout/wait 和 pretty；不能重新拼一个丢失自定义账号文件的裸 complete。`nextAction` 是等价的 POSIX 安全命令，优先数组执行，不用 eval 或按空格拆词。数组首项为 `xgg`，可以按当前源码/node/npx入口替换命令前缀，其余参数保持原样。未扫码的普通等待结束仍返回 pending、保留同一二维码；不能当作失败，也不要反复生成新码。用户确认后继续 complete，直到 `authenticated:true`。`expiresAt` 是 ISO 过期时间；如果已到期或返回 qr-expired，旧二维码不能继续使用。先说明旧码已过期，待用户能立即扫码时再次 login，展示新返回的图片；不能再次要求用户扫描历史消息中的旧码。只有用户要求换码、凭据确实损坏或明确需要重启流程时才 `--restart`；已有有效授权仍会复用。用户明确要求切换账号时才 `cloud logout` 后重新登录。
4. 已有明确网关地址和 session 配置时先运行对应 `xgg status --base-url <BASE_URL>`，live 会话直接复用。未建立会话或地址未知时，先用 `cloud home list` / `cloud device list --home-id <HOME_ID>` 确定当前家庭和中枢 DID，再执行 `xgg cloud gateway login --did <GATEWAY_DID> [--base-url <URL>] [--session-file <PRIVATE_SESSION_FILE>]`。中枢可能是独立设备，也可能集成在路由器或家庭屏；不能因独立 hub 离线就推断家中没有在线中枢。多个候选无法由现有上下文确定时再请用户指定，勿盲选。

   登录成功返回明确的 `baseUrl`、`nextCommand.argv` 和等价 `nextAction`。先运行返回的 status 命令，保留其 `--base-url` 与自定义 `--session-file`；后续 rule/variable/logs 命令同样传这些参数，或在当前执行环境显式设置 `XGG_BASE_URL` / `XGG_SESSION_FILE`。登录并不会为其他本地命令隐式选默认网关，不扫描 session 后挑第一个。不要将云端 `--auth-file` 与网关 `--session-file` 混用。

   ```bash
   # 使用本次结果中的真实 baseUrl；自定义 session 时每条都保留同一文件
   xgg status --base-url <RETURNED_BASE_URL> --session-file <SAME_SESSION_FILE>
   xgg rule list --base-url <RETURNED_BASE_URL> --session-file <SAME_SESSION_FILE>
   ```

5. 六位码由命令在内存取出并传入网关登录，Agent 不打印、不保存、不手工拼入命令行。只有云端取码确实不支持、目标无法确定，或用户明确选择手动方式，才说明原因并请用户提供新码，使用原 `xgg login --code <CODE>`。

云端 exit 3 的 `error.details.domain=cloud` 应走扫码；不能向用户索取网关码修复云端授权。网关 exit 3 优先走云端引导。授权可续用但不保证永久有效。`cloud logout` 与网关 `logout` 各自独立，多步任务结束不需要为了“清理”强制登出可复用会话。

## 查询、直接控制与观察

```bash
xgg cloud home list
xgg cloud device list --home-id <HOME_ID>
xgg cloud device spec --did <DID>
xgg cloud device get --did <DID> --property <SERVICE.PROPERTY> --source device
xgg cloud device watch --did <DID> --property <SERVICE.PROPERTY> --source device \
  --interval-ms 3000 --duration-ms 30000 --max-events 10
```

同名设备使用精确 DID 或家庭限定；property/action 的 service、索引、access、类型与值域来自该设备 spec。云端 spec 用于云端操作；规则卡仍必须核对网关 `device spec`，不能拿云端在线/可读证明网关支持 push 或本地路由。

### 数据来源决定读数能证明什么

| `--source` | 含义与使用边界 |
|---|---|
| `auto` | `get` 的默认策略，可能返回缓存。适合能力探索和一般状态浏览；不能单凭它确认写入或恢复已生效。 |
| `device` | 直接请求设备 RPC；`watch` 默认采用它。写前基线、写后因果验收、恢复核验都显式使用它，并检查返回的 `sourcePolicy` 和读取结果。 |
| `cache` | 请求缓存报告。适合只会 notify、没有设备直读能力的传感器；记录 `updateTime`，注明这是历史上报，不称为此刻实时状态。 |

已实测缓存优先读取在恢复后仍返回先前测试值；请求成功不意味着缓存已经刷新。不能通过反复读取 `auto/cache`，或发现恰好等于原值，就证明恢复完成。`device` 不支持、离线、失败或返回未确认时，**不得降级为缓存并宣称已经恢复**。可以在已有授权范围内采用独立网关读回或现场观察补充证据，否则明确“设备直读失败，恢复尚未确认”。只读传感器可用 `auto/cache` 并保留 `updateTime`；没有上报时间时必须说明时效未知。

`watch` 是 HTTP 定时轮询：先输出 snapshot，随后输出 change NDJSON；不是米家推送订阅，不能保证捕获短于采样间隔的变化。默认最多观察 60 秒；`--max-events` 包含首次 snapshot，`--follow` 才取消默认时间界限。为测试显式设置持续时间或事件上限；不要仅靠变化次数估算结束时间，不变的设备仍需等待持续时间上限。未确认的值不能作为变化已生效的证据，错误或中断后的空白也不能解释为“状态没有变”。

```bash
export XGG_AGENT_MODE=1
export XGG_SNAPSHOTS_DIR="$PWD/.xgg-local/snapshots"
xgg cloud device get --did <DID> --property <SERVICE.PROPERTY> --source device
xgg cloud device set --did <DID> --property <SERVICE.PROPERTY> --value <JSON_VALUE>
xgg cloud device get --did <DID> --property <SERVICE.PROPERTY> --source device
```

先用 `--source device` 取得已确认的原值，将值、来源和采样时间记录在私有任务证据中。`device set` 写前固定使用 device 策略读取可读属性原值并写云端私有快照，不降级缓存；读取不支持、失败或未确认会阻止写入。明确 write-only 属性可被控制，但**不能据此完成“改变后恢复原值”测试**。动作、场景和语音调用的快照只是审计，不保证可撤销；恢复测试选择可读、可写且有明确原值的状态属性，传感器只读即可。

每次写后与恢复后都用 `get --source device` readback；`code:0`/`ok` 只是请求层确认，`code:1`/`accepted` 明确未确认，二者都不替代设备读回。设备报告值与现场可见物理效果也应分别描述。写超时或 NOT_CONFIRMED 后先查询状态与日志，不自动重发原写入；确认当前状态后，按已获授权的恢复步骤处理。

## 方向一：改网关自动化，用云端观察设备

1. 用 `get --source device` 保存目标属性原值，记录规则原 enable 状态和开始时间。需要运行自动化的完整下游必须在用户授权范围内。
2. 按本 Skill 构图；先 disabled 编写，现有 enabled 规则多步编辑可能立即生效。修改后 layout、validate、strict lint、view，并完成该版本主 Skill 要求的全部启用门槛。主 Skill 要求 `--spec-aware` 时必须使用支持它的规则入口，不能因旧入口没有该参数就省略。
3. **触发前**启动有界 `cloud device watch --source device`，拿到首次 snapshot 后再触发规则；也可在触发前后各做一次 `get --source device`，但后者只能证明两个采样点。
4. 用该时间窗口的网关 logs（支持时加 trace）对应云端变化：网关 source → 分支/动作日志 → 云端目标值。enable 成功不等于设备完成动作，云端单一目标值也不证明是该规则导致。
5. 测试完成先 disable 临时触发/循环规则，确认停止后恢复设备原值并再次云端 `get --source device`。保留本次测试规则供用户核对，除非用户要求清理，不批量删除；已有业务规则按用户授权恢复原 enable 状态。

```bash
xgg cloud device watch --did <DID> --property <SERVICE.PROPERTY> --source device \
  --interval-ms 3000 --duration-ms 30000
# 在另一执行会话按授权触发已经校验的规则，然后读取本次窗口
# 若使用自定义session-file，下面同样传入该文件；不能假定跨会话继承env
xgg rule logs <RULE_ID> --since <ISO_TIMESTAMP> --json --base-url <RETURNED_BASE_URL>
xgg cloud device get --did <DID> --property <SERVICE.PROPERTY> --source device
```

## 方向二：云端改变设备，用网关观察反应

1. `rule view` 审查完整下游，保证此次云端变更触发的业务动作也已授权；用 `get --source device` 保存设备原值、来源和时间。
2. 优先利用既有规则 logs/变量观察。需要单独探针时，notify 且网关 `pushAvailable=true` 的属性可用 `deviceInputSetVar`；不支持 push 但网关 spec 声明属性有 read 的设备，可使用无物理输出的 `onLoad → loop → deviceGetSetVar`。无 read 也无可用 push 时无法用这两种路径完成网关观察，须报告能力边界；不能把“云端能读”解释成“网关一定会通知”。
3. 临时观察图走编辑 → 校验 → 保存/启用 → 云端触发 → 查日志的完整回路。按 spec 创建 number|string marker，bool 用 number 0/1；不要为了观察而添加 deviceOutput。
4. 云端 set 后用云端 get/watch 的 `--source device` 确认目标值，再读取 `rule logs --since ... --json` 与 `variable get-value` / `variable watch`。对齐时间与目标属性，证明网关看到了对应变化；不把旧日志当成本次反馈。
5. 恢复原设备值，用 `get --source device` 核对云端，并核对网关 marker；停止并 readback 临时观察规则的 disabled 状态，保留规则和测试证据供用户核对。若观察图有任何物理下游，则先停止它再恢复设备，避免恢复过程再触发副作用；此时该 marker 不会继续更新，应另用独立无物理输出观察图或一次性网关查询验证恢复，做不到就明确网关侧恢复回读尚未完成。

## 交付的证据边界

逐项记录：设备/属性（公开材料脱敏）、原值、测试值、写入响应、设备回读及 sourcePolicy、网关日志/变量、恢复回读、最终规则状态。缓存样本另记 updateTime 与时效限制。离线、read-only、write-only、无可验证恢复方法的设备分别标注，不把“列出来”或“调用过”算作控制成功。场景、音箱、清零、重置、重启等不能当成普适的开关还原探针。
