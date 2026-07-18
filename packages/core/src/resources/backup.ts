import { setTimeout as sleep } from 'node:timers/promises';
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
import { NotConfirmedError, parseOrThrow } from '../transport/errors.js';
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

// Pull a numeric progress_id out of a create/download/load response (the gateway
// returns a bare number, `{progress_id}`, or `{progressId}`; `{}` / null mean
// "no async progress to track"). Returns null when there is nothing pollable.
export function extractBackupProgressId(resp: unknown): number | null {
  if (typeof resp === 'number' && Number.isFinite(resp)) return resp;
  if (resp !== null && typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    if (typeof r.progress_id === 'number') return r.progress_id;
    if (typeof r.progressId === 'number') return r.progressId;
  }
  return null;
}

export interface WaitForBackupOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Test seam — inject a getBackupProgress stub. */
  _getBackupProgress?: typeof getBackupProgress;
}

// Poll getBackupProgress until it reaches 100, used by the backup command's
// `--wait` flag. A progressId of 0 means the gateway completed instantly (e.g.
// downloadBackup found the file already in its local cache), so there is nothing
// to poll — return done immediately.
export async function waitForBackupProgress(
  input: { from: string; progressId: number; operation?: string },
  deps: ResourceDeps,
  opts: WaitForBackupOptions = {},
): Promise<BackupProgressResponse> {
  if (input.progressId === 0) return { progress: 100 };
  const poll = opts._getBackupProgress ?? getBackupProgress;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 60_000;
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const p = await poll({ from: input.from, progressId: input.progressId }, deps);
    if (p.progress >= 100) return p;
    if (Date.now() >= deadline) {
      throw new NotConfirmedError(
        `backup progress polling timed out after ${pollTimeoutMs}ms (progressId=${input.progressId}, last=${p.progress})`,
        {
          operation: input.operation ?? 'backup.operation',
          from: input.from,
          progressId: input.progressId,
          lastProgress: p.progress,
          pollTimeoutMs,
        },
      );
    }
    await sleep(pollIntervalMs);
  }
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
