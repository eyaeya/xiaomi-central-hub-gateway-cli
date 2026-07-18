# @eyaeya/xgg-core

`@eyaeya/xgg-core` 是 `xgg` 的协议、会话、schema、资源和用例层。它面向需要在 Node.js 程序中复用小米中枢网关极客版能力的开发者。

大多数用户应该直接安装 CLI：

```bash
npm install -g @eyaeya/xgg-cli
```

`@eyaeya/xgg-cli` 会自动安装匹配版本的 `@eyaeya/xgg-core`。只有在 Node.js 程序里直接复用协议、schema 或 usecase 层时，才需要单独安装：

```bash
npm install @eyaeya/xgg-core
```

GitHub 仓库：[eyaeya/xiaomi-central-hub-gateway-cli](https://github.com/eyaeya/xiaomi-central-hub-gateway-cli)。

## 包内容

npm tarball 只包含：

- `dist/`
- `LICENSE`
- `README.md`

GitHub 仓库中的参考 bundle、fixtures、开发文档、探测记录和快照不会进入 npm 包。

## 说明

网关通信不是普通 HTTP API，而是加密 WebSocket 二进制协议。除低层逃生口外，core 层会用 schema 校验网关返回，避免调用方直接依赖未建模响应。

## DATA 响应大小限制

core 在解密 DATA frame 后、同步解压前执行两层上限检查：压缩数据默认最多 16 MiB，声明及实际解压后的 UTF-8 JSON 默认最多 64 MiB。长度声明必须为正数，zlib 的 `maxOutputLength` 还会阻止实际输出越过声明值。超限或损坏的响应会作为网络/协议失败结束当前 session。

默认值由 `DEFAULT_MAX_INNER_COMPRESSED_BYTES` 和 `DEFAULT_MAX_INNER_JSON_BYTES` 导出。确实需要处理更大备份响应的库调用方可以显式配置 `SessionChannel`，但应使用部署中测得的有限值，不要取消上限：

```ts
const channel = new SessionChannel({
  send,
  recv,
  receiveLimits: {
    maxCompressedBytes: 32 * 1024 * 1024,
    maxJsonBytes: 96 * 1024 * 1024,
  },
});
```
