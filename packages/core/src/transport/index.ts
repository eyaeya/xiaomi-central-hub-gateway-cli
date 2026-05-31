export type { BinaryTransport } from './fake.js';
export { makeFakeTransportPair, StubGatewayServer } from './fake.js';
export {
  DATA_TYPE,
  decodeFrame,
  encodeProtocolList,
  encodeRawFrame,
  encodeSelectedProtocol,
  parseProtocolList,
  parseSelectedProtocol,
} from './frames.js';
export { runPasscodeHandshake } from './handshake.js';
export type { HandshakeResult, RunHandshakeOptions } from './handshake.js';
export { JsonRpcRouter } from './jsonrpc.js';
export type { JsonRpcRouterOptions } from './jsonrpc.js';
export { SessionChannel } from './session-channel.js';
export { connectWs, toWsUrl } from './ws.js';
export type { ConnectWsOptions } from './ws.js';
