# ADR 0014：原生米家云端接口与独立命令树

日期：2026-10-13。状态：accepted。

用户要求把 Do1e/mijia-api 的能力并入 xgg。采用原生 TypeScript 适配其 HTTP/RC4/扫码与刷新协议，保留 GPL 来源声明，避免用户为了运行 xgg 再安装 Python/uv。使用已有 Node 标准库与 zod，不新增运行时依赖。

云端凭证、HTTP 请求与网关 daemon 分域；命令为 xgg cloud，既有 xgg device 不改变含义。云端设备摘要移除设备 token、定位与网络秘密。云端写入仍接公共 mutation guard，快照不调用网关 dump。写入结果不确定时不自动重发。

取码为有证据驱动的显式 bootstrap。不得从任意六位数字推断 passcode，也不得把 passcode 输出到 CLI/stdout/快照。扫码登录可刷新但不承诺永不过期。新设计覆盖旧文档中没有云端 transport、不能从云端取码的历史假设。
