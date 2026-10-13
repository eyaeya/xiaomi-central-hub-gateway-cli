# 米家云端 API

实现：`packages/core/src/cloud/{auth,transport,resources}.ts`。
Schema：`packages/core/src/schemas/cloud.ts`。
契约：`packages/core/tests/contract/cloud.test.ts`；fixtures：`fixtures/responses/cloud/*-synthetic.json`。

来源是 [Do1e/mijia-api](https://github.com/Do1e/mijia-api) v5.0.0、
commit `2cc61f2e4ae21d9e3736e450c968bbe53c87ebd1` 的 `apis.py` 与 `devices.py`，
以及其[官方文档](https://mijia-api.do1e.com/)。协议由原生 TypeScript 实现，无 Python 运行时。
身份认证和网关 daemon session 独立；参见 ADR 0014 和 2026-10-13 云端设计。

## 传输与认证

业务路径以米家云端 `/app` 为根路径，使用扫码授权后的账户凭证、请求 nonce、
RC4/signature 和 session cookies。HTTPS transport 负责顶层 HTTP/API code 检查，
资源层只接收顶层 `result` 后再次经过下表所列 zod schema。
凭证文件与上游 `~/.config/mijia-api/auth.json` 兼容，不写入设备快照或 stdout。
扫码图片展示、pending 复用、有界等待、显式恢复与云端优先取码流程见
[cloud-auth.md](cloud-auth.md)。

`CloudTransport.request(path, body, {mutation?: boolean})` 和 `getSpec(specType)` 可注入，
测试使用 fake transport。写请求不因超时、token 刷新或设备错误自动重发。
错误只含安全描述、domain 与数值 code，不携带原始云端响应。

## 已登记接口

以下业务接口为 POST，MIoT spec 为公开 GET。表中的 fixture 名省略 `-synthetic.json`。

| 方法 / path | 请求 body | `result` schema / fixture |
| --- | --- | --- |
| POST `/v2/homeroom/gethome_merged` | `fg, fetch_share, fetch_share_dev, fetch_cariot, limit, app_ver, plat_form` | `CloudHomesResult` / `homes` |
| POST `/home/home_device_list` | `home_owner, home_id, limit:200, start_did` 与兼容设备 flags | `CloudDevicesResult` / `devices` |
| POST `/v2/home/device_list_page` | 兼容设备 flags，固定 unknown SSID/BSSID，不读取本机网络身份 | `CloudSharedDevicesResult` / `shared-devices` |
| GET `https://miot-spec.org/miot-spec-v2/instance?type=<URN>` | 无账户凭证 | `CloudSpecResult` / `spec` |
| POST `/miotspec/prop/get` | `params:[{did,siid,piid},...], datasource:1/2/3` | `CloudPropertiesResult` / `property-get`, `property-error`, `property-batch`; `cloud-live/property-{auto,device}-redacted-live.json` |
| POST `/miotspec/prop/set` | `params:[{did,siid,piid,value}]` | `CloudPropertiesResult` / `property-set` |
| POST `/miotspec/action` | `params:{did,siid,aiid,in:[values]}` | `CloudActionResult` / `action` |
| POST `/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList` | `app_version:12,get_type:2,home_id,owner_uid` | `CloudScenesResult` / `scenes` |
| POST `/appgateway/miot/appsceneservice/AppSceneService/NewRunScene` | `scene_id,scene_type:2,phone_id:'null',home_id,owner_uid` | `CloudRunSceneResult` / `scene-run` |
| POST `/v2/home/standard_consumable_items` | `home_id,owner_id,filter_ignore:true` | `CloudConsumablesResult` / `consumables` |
| POST `/v2/user/statistics` | `did,key,data_type,limit,time_start,time_end` | `CloudStatisticsResult` / `statistics` |

云端取网关 URL、6 位登录码与网关握手是独立实验接口，见 [cloud-gateway.md](cloud-gateway.md)。

## CloudClient 语义

- `listHomes()` 返回家庭 ID、名称、owner UID、房间 ID/名称及可选 `dids` 关联；去掉地址、坐标和网络标识。`dids:null` 表示没有可用关联。
- `listDevices(homeId?)` 遍历可见家庭、逐页获取设备，再补充单独共享设备，以 DID 去重。
  显式家庭过滤时不混入其他家庭/单独共享的设备；`homeId:'shared'` 只查单独共享。
  家庭设备页使用 `max_did`，共享设备页使用 `next_start_did`；每次分页要求游标前进，
  最多 100 页，避免循环或静默丢失。共享分页字段参考
  [小米官方公开协议使用点](https://github.com/XiaoMi/ha_xiaomi_home/blob/main/custom_components/xiaomi_home/miot/miot_cloud.py#L585)，
  仅取接口字段事实，不引入其实现。
- 设备输出仅含 `did,name,model,isOnline?,spec_type?,home_id?,home?,room?,room_id?`。`home` 由家庭名称得到，`room/room_id` 由房间 `dids` 唯一关联得到；共享设备或冲突/缺失关联不猜测房间。token、SSID、BSSID、
  MAC、经纬度、owner 对象和 extra 元数据均不输出。
- 选择设备必须指定唯一 DID 或唯一精确名称；同名报错，禁止自动选第一台。
- `deviceSpec(selector)` 将原始 MIoT 定义解析成 `properties` 与 `actions`，保留 siid/piid/aiid、
  名称、服务名称、类型、权限、枚举与范围，以及可选 `comment` 中文说明（含枚举说明）。动作输入按 `in` 中的 piid 解析，缺失定义失败。
- `specByType(specType)` 直接读取完整 URN 对应公共规格，返回 `{specType,properties,actions}`；不要求云端凭据，也不枚举家庭/设备。
- 一个 `CloudClient` 实例默认缓存家庭/设备元数据 30 秒、按完整 URN 缓存规格 5 分钟；没有磁盘缓存，不缓存属性值、动作/场景结果。构造选项 `deviceCacheTtlMs/specCacheTtlMs` 可调整，0 禁用；`clearCache()` 强制下次重新发现。缓存副本隔离，修改返回对象不污染后续调用。长期轮询必须绑定明确 DID，不能把元数据缓存中的在线状态视为实时心跳。
- `getProperty(selector,{property})` / `setProperty(selector,{property},value)` 支持 `on`、
  `light.on`、`2.1` 或显式 `{siid:2,piid:1}`；重复短名称必须消歧。
- `getProperty/getProperties` 可传第三参数 `{source:'auto'|'device'|'cache'}`，默认 auto。
  auto 映射 datasource=1，优先服务器缓存；device 映射 2，直接下发设备 RPC；cache 映射 3，
  只读缓存，没有缓存时可返回错误。来源依据为[小米官方连接文档](https://iot.mi.com/v2/new/doc/plugin/other/connection-wifi)。
  device 失败不会自动降级为缓存。协议 code=0 不表示新鲜；直接读取也仍是设备报告，不能代替现场观察。
- `getProperties(selector, selectors?)` 一次查询同一设备的多个属性，省略 selectors 查询所有可读属性；显式空数组、重复或不可读属性在发送前拒绝。采用每请求最多 20 项的客户端保守分批策略，不声称这是服务端硬上限。返回数组按请求顺序排列；返回身份必须逐项唯一匹配，遗漏、重复、多余和跨设备混入均报 SCHEMA。
- 批量读取负/其他错误 code 以该项 `status:'error',confirmed:false` 返回，其他成功项保留；code 1 仍是 accepted 且可能无值。单项 `getProperty` 保持非 0/1 code 抛错契约。代码 0 必须有类型正确的 value。读取输出保留可选 `updateTime`（上游声明为 epoch 秒）；缺失时不虚构服务时间，轮询应另记录本地采样时间，不能据云端缓存值断言实时物理变化。
- 属性读写权限在发送前检查，写入严格校验 bool/string/float/integer、整数类型边界、
  `value-list`、`value-range` 和 step，不隐式把字符串转数字或布尔。读取值亦校验 MIoT 类型，但不把写入范围当作传感器读取限制。
- 只写属性的 read 预检返回 CONFIG、`details.reason:'property-not-readable'`，
  CLI 可据此保存不可回读的操作审计；其他读取错误不能吞掉后继续写入。
- `action(selector,{action,inputs})` 使用同样的名称/数字选择与输入数量/类型/范围检查。
  `speaker(...,'run',quiet)` 默认 quiet=true，映射 `execute-text-directive`，输入 `[text, quiet ? 1 : 0]`；
  `speaker(...,'play')` 映射 `play-text`，输入 `[text]`，不硬编码特定型号服务编号。
- 云端属性/动作返回必须匹配请求身份，每项 code 都检查：0 为协议确认、1 为
  `status:'accepted',confirmed:false`，单项操作的其他正负 code 均报错（批量只读按上述逐项错误契约）。协议确认不能替代物理回读。
  写入已发送后，响应结构/身份/条目数异常以 NOT_CONFIRMED 报告，须先查状态再决定重试。
- `runScene(sceneId,homeId)` 先确认场景属于所选家庭。成功仅为提交接受，始终
  `status:'accepted',confirmed:false`，不声称场景中的设备动作全部完成。
- `listConsumables(homeId?)` 返回所有分组的耗材，保留单项/多项 details，不执行重置。
- 统计限制 1–1000 条和有序时间范围；支持 hour/day/week/month 与对应 `_v3` 类型。
  `value` 保持原始字符串，绝不 eval；不同型号可支持不同 key 和统计周期。

## 实证边界

2026-10-13 的实施前 probe 已核对实际家庭/设备字段，随后只读核对场景与耗材 item 形态。
`fixtures/responses/cloud/` 的 fixture 明确标为 **synthetic**：它们以脱敏形态重建协议，不能作为真机通过证据；另见下节 `cloud-live/` 真实形状补采。
原始抓取保存在忽略目录 `.xgg-local/cloud-probe/`，不进入公开仓库。

单测涵盖敏感字段移除、名称歧义、家庭过滤、共享去重、分页卡住、权限/类型/范围/枚举、
错误项、code 1、动作输入与场景提交边界。真机设备读写、状态恢复、网关取码和日志联调
由当次 e2e 报告提供证据；未真机执行的场景、音箱、统计不能按单测宣称已验证。

## 脱敏真实响应契约（2026-10-13 补采）

`fixtures/responses/cloud-live/` 与上述 synthetic 目录分开保存。家庭、设备、属性读取、
场景列表、耗材列表均在有效授权下通过原生 transport 再次只读调用，先保留真实 `result`
到忽略目录，再按 allow-list 脱敏和缩减数组。没有把上游 flattened 列表重新包装成真实
响应；HTTP/API 外层由 transport 校验后剥离，fixture 明确只代表其真实 `result` 容器。
本次补采以网络白名单禁止登录/刷新，未进行物理写入。

对应 schema 依次为 `CloudHomesResult`、`CloudDevicesResult`、`CloudPropertiesResult`、
`CloudScenesResult`、`CloudConsumablesResult`；另有已取得的公共 MIoT 真实 spec 节选，
由 `CloudSpecResult` 校验。契约测试为 `packages/core/tests/contract/cloud-live.test.ts`。
具体来源、保留字段、裁剪和脱敏方式见该目录 README；UID/DID/家庭与房间名、场景 ID、
网络身份、定位、token、时间等均替换或移除。公开规格中的型号与服务/属性 ID 予以保留。
真实形状样本与 synthetic 测试承担不同证据角色，不扩大未实测能力的完成声明。

### 属性写入前的确认值

CLI 对可读属性使用 source=device 先查询原值；只有 `code:0` 且存在 `value` 才会记录快照并发出写入。`code:1` 的 accepted 读取、网络失败或无确认值均停止写入，不悄悄降级缓存。只写属性保留显式不可读的审计记录，不声称可以恢复。

## Agent 属性采样与观察

`cloud device get` 使用单个 `--property` 或 `--siid/--piid` 时保持 `result` 输出；
`--properties <逗号分隔名称>` 或不指定属性时返回批量 `results`，后者选择所有可读属性。
批量失败项仍携带各自 code；调用者不能只检查顶层 `ok` 就宣称全部读取成功。
`get --source` 默认 auto；`watch --source` 默认 device，也可显式选择 auto/cache，输出保留 sourcePolicy。

`cloud device watch` 是客户端轮询，不是云端推送订阅。输出 NDJSON：第一次成功采样为
`snapshot`，以后值发生变化为 `change`，附 `source:cloud`、`mode:polling`、
`evidence:reported` 和本地 `observedAt`。服务端可选 `updateTime` 原样保留在属性结果中；
它与本地采样时刻含义不同，也不能代替物理效果验证。

- 默认间隔 3000 ms，最小 1000 ms；默认观察 60000 ms。
- `--follow` 取消默认时长，显式 `--duration-ms` 优先；`--max-events` 包含初始 snapshot，
  可以与时长同时使用，任一边界满足即停止。
- 开始时将用户设备选择解析为明确 DID；复用同一客户端与有界元数据缓存，属性值每轮请求。
  auto/cache 可以读取服务端缓存，不能据此承诺每次都是设备最新值。
- 只有全部 code=0 且值有效的样本才能建立/更新变化基线。网络错误或 code=1 最多容忍
  3 次连续失败后退出；负/其他设备 code、认证错误和 schema 错误立即传播，不伪造变化。
- SIGINT 清理计时器并中止未完成的请求；watch 不写入设备、不自动恢复或重放物理操作。

双向联调应先记录基线与起始时间，再进行已经授权的单次刺激：本地规则调整后通过
cloud get/watch 回读；云端控制后通过本地 rule logs/variable watch 观察。结束时恢复原值并
再次回读，日志与云端结果分别记录其时间和证据来源，避免将先前缓存状态解释为本次效果。
