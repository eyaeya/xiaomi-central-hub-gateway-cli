import {
  BackupConfigRequest,
  BackupConfigResponse,
  BackupContent,
  BackupCreateInput,
  BackupCreateRequest,
  type BackupItem,
  BackupListRequest,
  BackupListResponse,
  BackupOperationResponse,
  BackupProgressInput,
  BackupProgressRequest,
  BackupProgressResponse,
  BackupSetConfigInput,
  BackupSetConfigRequest,
  BackupTargetInput,
  BackupTargetRequest,
} from '../schemas/backup.js';
import { parseOrThrow } from '../transport/errors.js';
import { agentCall } from '../usecases/agent-call.js';
import type { ResourceDeps } from './index.js';

type CallKind = 'read' | 'write';

function callBackup(
  deps: ResourceDeps,
  method: string,
  params: unknown,
  kind?: CallKind,
): Promise<unknown> {
  return agentCall({
    baseUrl: deps.baseUrl,
    method,
    params,
    store: deps.store,
    ...(kind !== undefined && { kind }),
    ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
}

function normalizeList(response: BackupListResponse): BackupItem[] {
  return Array.isArray(response) ? response : response.list;
}

function targetRequest(input: BackupTargetInput, label: string): BackupTargetRequest {
  const parsed = parseOrThrow(BackupTargetInput, input, `${label}Input`);
  return parseOrThrow(
    BackupTargetRequest,
    { from: parsed.from, params: parsed.backup },
    `${label}Request`,
  );
}

export async function listBackups(from: string, deps: ResourceDeps): Promise<BackupItem[]> {
  const params = parseOrThrow(BackupListRequest, { from }, 'BackupListRequest');
  const raw = await callBackup(deps, '/api/getBackupList', params);
  return normalizeList(parseOrThrow(BackupListResponse, raw, 'BackupListResponse'));
}

export async function createBackup(
  input: BackupCreateInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  const parsed = parseOrThrow(BackupCreateInput, input, 'BackupCreateInput');
  const params = parseOrThrow(
    BackupCreateRequest,
    { from: parsed.from, params: { fileName: parsed.fileName } },
    'BackupCreateRequest',
  );
  const raw = await callBackup(deps, '/api/createBackup', params, 'write');
  return parseOrThrow(BackupOperationResponse, raw, 'BackupCreateResponse');
}

export async function downloadBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  const raw = await callBackup(
    deps,
    '/api/downloadBackup',
    targetRequest(input, 'BackupDownload'),
    'write',
  );
  return parseOrThrow(BackupOperationResponse, raw, 'BackupDownloadResponse');
}

// generateBackup is a state-coupled READ — see schemas/backup.ts comment.
// Must be preceded by downloadBackup with the same { did, ts, fileName };
// otherwise the gateway returns ENOENT ("backup file not exist").
export async function generateBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
): Promise<BackupContent> {
  const raw = await callBackup(deps, '/api/generateBackup', targetRequest(input, 'BackupGenerate'));
  return parseOrThrow(BackupContent, raw, 'BackupGenerateResponse');
}

export async function loadBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  const raw = await callBackup(
    deps,
    '/api/loadBackup',
    targetRequest(input, 'BackupLoad'),
    'write',
  );
  return parseOrThrow(BackupOperationResponse, raw, 'BackupLoadResponse');
}

export async function deleteBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  const raw = await callBackup(
    deps,
    '/api/deleteBackup',
    targetRequest(input, 'BackupDelete'),
    'write',
  );
  return parseOrThrow(BackupOperationResponse, raw, 'BackupDeleteResponse');
}

export async function getBackupProgress(
  input: BackupProgressInput,
  deps: ResourceDeps,
): Promise<BackupProgressResponse> {
  const parsed = parseOrThrow(BackupProgressInput, input, 'BackupProgressInput');
  const params = parseOrThrow(
    BackupProgressRequest,
    { from: parsed.from, params: { progress_id: parsed.progressId } },
    'BackupProgressRequest',
  );
  const raw = await callBackup(deps, '/api/getBackupProgress', params);
  return parseOrThrow(BackupProgressResponse, raw, 'BackupProgressResponse');
}

export async function getBackupConfig(
  from: string,
  deps: ResourceDeps,
): Promise<BackupConfigResponse> {
  const params = parseOrThrow(BackupConfigRequest, { from }, 'BackupConfigRequest');
  const raw = await callBackup(deps, '/api/getBackupConfig', params);
  return parseOrThrow(BackupConfigResponse, raw, 'BackupConfigResponse');
}

export async function setBackupConfig(
  input: BackupSetConfigInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  const parsed = parseOrThrow(BackupSetConfigInput, input, 'BackupSetConfigInput');
  const config: { autoBackup: boolean; autoBackupLimit?: number } = {
    autoBackup: parsed.autoBackup,
  };
  if (parsed.autoBackupLimit !== undefined) {
    config.autoBackupLimit = parsed.autoBackupLimit;
  }
  const params = parseOrThrow(
    BackupSetConfigRequest,
    { from: parsed.from, params: config },
    'BackupSetConfigRequest',
  );
  const raw = await callBackup(deps, '/api/setBackupConfig', params, 'write');
  return parseOrThrow(BackupOperationResponse, raw, 'BackupSetConfigResponse');
}
