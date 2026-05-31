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
