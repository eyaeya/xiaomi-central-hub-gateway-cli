export { createIpcClient } from './ipc-client.js';
export type { IpcClient, IpcClientOptions } from './ipc-client.js';
export { createIpcServer } from './ipc-server.js';
export type {
  IpcHandlerContext,
  IpcServerHandle,
  IpcServerOptions,
} from './ipc-server.js';
export {
  createFileMutationLeaseCoordinator,
  createInMemoryMutationLeaseCoordinator,
} from './mutation-lease.js';
export type {
  MutationLeaseCoordinator,
  MutationLeaseStatus,
} from './mutation-lease.js';
export { assertAgentIdentity } from './identity.js';
export type { AgentPingIdentity } from './identity.js';
export {
  canonicalGatewayKey,
  defaultAgentRuntimeDir,
  resolveAgentEndpoint,
  resolveAgentInstanceEndpoint,
} from './ipc-path.js';
export type {
  AgentEndpoint,
  AgentEndpointKind,
  ResolveAgentEndpointInput,
  ResolveAgentInstanceEndpointInput,
} from './ipc-path.js';
export { runAgent } from './process.js';
export type { AgentHandle, RunAgentOptions } from './process.js';
export { runAgentMain } from './main.js';
export type { RunAgentMainHandle, RunAgentMainOptions } from './main.js';
export { spawnAgent } from './spawn.js';
export type { SpawnAgentOptions, SpawnAgentResult } from './spawn.js';
