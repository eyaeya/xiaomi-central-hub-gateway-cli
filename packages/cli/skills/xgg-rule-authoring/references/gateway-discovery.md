# 定位真实中枢与发现登录地址

不知道中枢设备、云端 DID 或极客版地址时读取本文。先通过云端清单与当前型号信息缩小范围，再让 `cloud gateway login` 发现地址；没有 IP 不是首先向用户索码的理由。扫码流程见 [cloud-workflows.md](cloud-workflows.md)。

## 先区分三层能力

- **蓝牙/Mesh 网关**：连接和转发特定协议的设备。产品写有“网关”或“蓝牙 Mesh”，并不证明集成米家中枢。
- **中枢能力**：承载米家自动化的协调、计算等功能，可能由独立中枢、路由器、家庭屏/中控屏、音箱或智能存储提供。同系列不同型号不能互推；中枢不一定自带蓝牙/Mesh 网关。
- **极客版本地 API**：本项目规则/变量/日志需要的管理接口。中枢身份仍不足以证明当前地区、固件、主/子节点角色支持极客入口或云端地址/取码 RPC；需具体说明和实际连接验证。

## 五类、11 款候选清单

下表完整纳入用户提供的候选范围，并依据官方产品正文、参数表或详情图核对中枢信息（2026-10-14），用于寻找实际承载中枢的设备，不是极客版或双 RPC 的兼容白名单。以后遇到用户提供但官方资料暂缺的候选，保留并标明待核对，不能因此排除。

| 类别 | 具体产品 | 中枢依据与定位边界 |
|---|---|---|
| 独立中枢 | [小米中枢网关](https://www.mi.com/shop/buy/detail?product_id=15755) | 官方独立中枢产品。 |
| 路由器 | [小米路由器 BE10000 Pro](https://www.mi.com/xiaomi-routers/be-10000-pro) | 官方说明集成智能中枢及蓝牙 Mesh 网关。 |
| 路由器 | [小米路由器 BE7200 Pro](https://www.mi.com/shop/buy/detail?product_id=24611) | 官方商品摘要列明智能中枢网关及蓝牙 Mesh 网关。 |
| 路由器 | [小米路由器 BE6500 Pro](https://www.mi.com/xiaomi-routers/6500pro) | 官方说明内置中枢，脚注提及米家极客版；**Pro 不可省略**。 |
| 路由器 | [小米路由器 BE3600 Pro 套装版](https://www.mi.com/xiaomi-routers/be-3600-pro-suit/specs) | 官方参数：**仅主路由支持中枢**，主/子路由均有蓝牙 Mesh 网关。 |
| 路由器 | [小米路由器 BE3600 Pro 网线版](https://www.mi.com/xiaomi-routers/be-3600-pro-wired1/specs) | 官方参数：**仅主路由支持中枢，主路由没有蓝牙 Mesh 网关**；子路由有蓝牙 Mesh、无中枢。 |
| 屏幕 | [小米智能家庭屏 11](https://www.mi.com/xiaomi-smartdisplay-11) | 官方说明集成中枢网关及 Mesh 2.0。 |
| 屏幕 | [小米智能中控屏 Max](https://www.mi.com/shop/buy/detail?product_id=21335) | 官方详情图说明集成本地中枢及小米 Mesh 2.0。 |
| 音箱 | [Xiaomi Sound 2 Max](https://www.mi.com/shop/buy/detail?product_id=22104) | 官方详情图列明中枢能力及小米 Mesh 2.0；极客入口与双 RPC 仍需验证。 |
| 音箱 | [Xiaomi Sound 2 Pro](https://www.mi.com/shop/buy/detail?product_id=22545) | 官方详情图列明中枢能力及小米 Mesh 2.0；不能用 Max 或旧款规格替代本机确认。 |
| 智能存储 | [小米智能存储](https://www.mi.com/shop/buy/detail?product_id=24989) | 用户定位为**仅中枢、无网关**；官方详情确认中枢，蓝牙 Mesh 网关需另购。仍是中枢候选，不据此推断没有蓝牙硬件。 |

表中产品名不等于云端 `model` 或 DID，未确认的映射不能编造。官方中枢说明、支持极客版的文字、两个 RPC 的实际响应和 LAN 登录成功是不同证据；没有逐款实测就不能宣称 11 款均支持取址/取码。其他用户指明或有中枢依据的型号也按同一路径纳入，不建立型号、类别或 `model` 前缀白名单。

具体型号对照：[小米智能家庭屏 Pro 8](https://www.mi.com/xiaomi-smartdisplay-pro-8) 的页面说明自带 Mesh、相关中枢能力需另购中枢网关；[小爱触屏音箱 Pro 8](https://www.mi.com/aispeaker-pro8?product_id=1194900016) 的页面确认蓝牙 Mesh 网关。它们是不同产品，且这些说明仅约束各自型号，不能外推排除所有屏幕或音箱，更不能排除上表的 Sound 2 Max/Pro。

优先核对准确型号及当前官方说明；昵称、类别和 MIoT 类型只用于筛选。不要仅靠 `gateway` 字符串、电脑的网络默认网关 IP、或某台独立 hub 离线做结论。默认网关地址只能证明 IP 路由的下一跳，真实中枢可能在另一台设备中。

## 从目标家庭定位 DID

```bash
xgg cloud home list
xgg cloud device list --home-id <HOME_ID>
```

1. 按用户已指定的家庭选择 home；只有多个家庭且上下文无法区分时，展示家庭选项请用户选择。不要把其他家庭或个人共享设备自动当成本次目标。
2. 使用当前 JSON 的真实字段：`did`、`name`、`model`、`spec_type`、`isOnline`、`home_id`，以及可选的 `home`、`room`、`room_id`。输出没有 `homeName`/`roomName`；房间或在线字段缺失时记为未知，不补造。
3. 结合准确 `model`、`spec_type`、家庭/房间和型号资料，覆盖上表独立中枢、路由器、屏幕、音箱、智能存储五类候选。用户可能将设备改名为任意昵称，名称完全不含“中枢”“网关”也正常。用户明确指出的候选即使官方资料暂缺，也继续核对实际清单；MIoT spec 未给出极客接口、未提供蓝牙/Mesh 功能，都不能证明中枢或极客接口不存在。路由套装或有多个中枢时核对当前主/子节点角色，不能把主节点能力默认套到每台子节点。
4. 多个候选仍无法确定时，给用户简洁的“名称、准确型号、房间、在线状态”列表，询问哪个设备的米家页面有中枢/极客功能。用户也不知道时，继续下面的 App 定位和人工兜底，不把“请提供 DID”当作终点。

真实 DID、家庭和房间信息仅用于当前私有任务；公开报告、fixture 与提交必须脱敏。

## 不提供 IP 的云端发现路径

选定真实 DID 后，未知地址就**省略 `--base-url`**：

```bash
xgg cloud gateway login --did <GATEWAY_DID>
```

`--base-url` 和 `XGG_BASE_URL` 都会覆盖自动发现；先排除属于其他目标的环境变量。POSIX shell 可仅对本次命令去掉旧覆盖，不改用户的持久配置：

```bash
env -u XGG_BASE_URL xgg cloud gateway login --did <GATEWAY_DID>
# 如需独立会话，显式添加 --session-file <PRIVATE_SESSION_FILE>
```

五类候选选定 DID 后都使用这同一条命令，不需要按型号选择接口。它依次调用 `miIO.get_autowebconfig_url` 读取极客管理 URL、`miIO.get_central_link_passcode` 内存取码，并登录本地网关；不要求用户预先知道 IP，也不暴露登录码。CLI 没有型号白名单，但目标的地区、固件和主/子角色仍可能影响 RPC 支持。已在一台集成式中枢上清除地址/会话/登录码覆盖、使用全新 session 实测 `reused=false`，随后 `status.live=true`；这是该路径的证据，不是所有中枢或固件的兼容保证。本机仍需能访问返回的局域网地址，云端授权不替代本地网络连接。

成功后执行返回的 `nextCommand.argv`（其余参数原样保留，首项可按实际 CLI 入口替换）。后续 status/rule/variable/logs 都沿用返回 `baseUrl` 和相同 session-file，或在当前执行环境显式设置 `XGG_BASE_URL` / `XGG_SESSION_FILE`。云端账号文件 auth-file 与网关 session-file 分开；登录不会给其他命令隐式选择默认网关。

## 云端找不到时的人工兜底

先按具体失败分流：云端授权失效（exit 3 且 `error.details.domain=cloud`）走扫码；账号/共享权限不足先核对当前账号、家庭归属及设备权限，不能当作型号不支持，也不能反复扫码或换 DID 碰运气。明确报告发现/取码 RPC 不支持时才进入该分支；超时或一般 RPC 错误本身不能证明不支持。地址和码已取得但 LAN 不可达时先排查网络，不能宣称本地会话已建立。用户选择手动，或云端权限暂无法解决但能从 App 取得本地登录信息时，也可使用下述路径。

用户不知道承载中枢的设备，或已确认目标但云端发现/取码不支持时：

- 引导查看米家 App 当前家庭中的“网关设备”“中枢”相关分类，或已选候选设备（包括路由器、家庭屏/中控屏、音箱、智能存储）设备页里的中枢/极客入口。智能存储可能不出现在蓝牙/Mesh 网关分类中；不能因此从清单排除。菜单名称和路径随 App、设备型号、地区及固件变化，不承诺固定点击路径。
- 如需 LAN IP，可让用户在路由器客户端列表中按准确型号核对设备。路由器管理页面入口本身不能当作中枢极客 URL；端口也需核对。`8086` 只是示例端口，不能替用户确认当前地址。
- 将缺失信息一次问齐：**“请打开米家 App 中实际承载中枢的设备，提供极客版的完整管理 URL；或提供该设备的局域网 IP 和端口，同时给出页面最新的六位登录码。”** 已有可信完整地址时无需重问；不要只问六位码却留下地址未知。
- 用户找不到极客入口时，先核对具体型号、角色、地区/固件支持情况；不能承诺所有中枢都能开启或使用本项目的本地 API。

拿到完整地址与新码后，为避免不同命令/进程的环境漂移，手动 login 与后续命令显式传入同一 `--session-file`。如采用默认文件，先确认没有指向其他文件的 `XGG_SESSION_FILE`，再同时省略下面两处该参数：

```bash
xgg login --code <CODE> --base-url <BASE_URL> --session-file <SAME_SESSION_FILE>
xgg status --base-url <BASE_URL> --session-file <SAME_SESSION_FILE>
# 后续 rule/variable/logs 命令同样保留 base-url 与 session-file
```

确认 live 后重试原只读操作。物理写入如果先前结果未知，先读状态与日志，不能因重新登录自动重放。本地地址不可达、超时等网络问题先检查同一局域网/路由、地址与端口，不反复索取登录码。
