import type { SessionStore } from '../session/index.js';
import type { IpcClientFactory } from '../usecases/agent-call.js';

export interface ResourceDeps {
  baseUrl: string;
  store: SessionStore;
  ipcClient?: IpcClientFactory;
  timeoutMs?: number;
}

export { listDevices, getDevice } from './devices.js';
export {
  annotateServiceDescription,
  getDevicePartitions,
  isPartitionSiid,
  partitionLabel,
  partitionModelAllowlist,
  partitionsFromSpec,
} from './device-partitions.js';
export type { DevicePartition } from './device-partitions.js';
export {
  createBackup,
  deleteBackup,
  downloadBackup,
  extractBackupProgressId,
  generateBackup,
  getBackupConfig,
  getBackupProgress,
  listBackups,
  loadBackup,
  setBackupConfig,
  waitForBackupProgress,
} from './backup.js';
export type {
  BackupConfigResponse,
  BackupCreateInput,
  BackupItem,
  BackupOperationResponse,
  BackupProgressInput,
  BackupProgressResponse,
  BackupSetConfigInput,
  BackupTargetInput,
} from '../schemas/backup.js';
export {
  addEdge,
  addNode,
  createRule,
  deleteGraph,
  disableRule,
  enableRule,
  getRule,
  listRules,
  relayoutGraph,
  removeEdge,
  removeNode,
  renameRule,
  setGraph,
  setRuleTags,
  updateNode,
  upsertGraph,
  viewRule,
} from './rules.js';
export type {
  AddEdgeInput,
  AddNodeInput,
  AddNodeShortcut,
  CreateRuleOptions,
  EdgeRef,
  RelayoutGraphResult,
  RemoveEdgeInput,
  RemoveNodeInput,
  RuleEnableResult,
  RuleView,
  UpdateNodeInput,
  UpsertGraphOptions,
  UpsertGraphResult,
} from './rules.js';
export type { GraphSetRequest } from '../schemas/rule.js';
export {
  createVariable,
  deleteVariable,
  getVariableConfig,
  getVariableValue,
  listAvailVarsForRule,
  listScopes,
  listVariables,
  setVariableConfig,
  setVariableValue,
} from './variables.js';
export type {
  AvailableVariable,
  VarConfigResponse,
  VarEntry,
  VarValueResponse,
  VariableCreateRequest,
  VariableDeleteRequest,
  VariableSetConfigRequest,
  VariableSetValueRequest,
} from '../schemas/variable.js';
export { NotFoundError } from '../transport/errors.js';
