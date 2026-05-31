# @xgg/core

`@xgg/core` 是 `xgg` 的协议、会话、schema、资源和用例层。它面向需要在 Node.js 程序中复用小米中枢网关极客版能力的开发者。

大多数用户应该直接安装 CLI：

```bash
npm install -g @xgg/cli
```

## 包内容

npm tarball 只包含：

- `dist/`
- `LICENSE`
- `README.md`

GitHub 仓库中的参考 bundle、fixtures、开发文档、探测记录和快照不会进入 npm 包。

## 说明

网关通信不是普通 HTTP API，而是加密 WebSocket 二进制协议。除低层逃生口外，core 层会用 schema 校验网关返回，避免调用方直接依赖未建模响应。
