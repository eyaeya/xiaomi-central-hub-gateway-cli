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
import { notConfirmedAfterAcknowledgement } from '../transport/confirmation.js';
import { ConfigError, NotConfirmedError, parseOrThrow } from '../transport/errors.js';
import { agentCall } from '../usecases/agent-call.js';
import type { ResourceDeps } from './index.js';
import { withResourceMutationWorkflow } from './mutation-workflow.js';

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

async function createBackupWithinWorkflow(
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

export async function createBackup(
  input: BackupCreateInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  parseOrThrow(BackupCreateInput, input, 'BackupCreateInput');
  return withResourceMutationWorkflow(deps, 'backup.create', () =>
    createBackupWithinWorkflow(input, deps),
  );
}

async function requestBackupDownloadWithinWorkflow(
  input: BackupTargetInput,
  deps: ResourceDeps,
): Promise<unknown> {
  return callBackup(deps, '/api/downloadBackup', targetRequest(input, 'BackupDownload'), 'write');
}

async function downloadBackupWithinWorkflow(
  input: BackupTargetInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  const raw = await requestBackupDownloadWithinWorkflow(input, deps);
  return parseOrThrow(BackupOperationResponse, raw, 'BackupDownloadResponse');
}

export async function downloadBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  targetRequest(input, 'BackupDownload');
  return withResourceMutationWorkflow(deps, 'backup.download', () =>
    downloadBackupWithinWorkflow(input, deps),
  );
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

export interface BackupGenerateCompletion {
  downloadResult: BackupOperationResponse;
  downloadProgress: BackupProgressResponse;
  content: BackupContent;
}

/**
 * Implement the cloud-export prerequisite: materialize the selected cloud file
 * in gateway cache and confirm completion before asking the gateway to generate
 * its portable payload. The whole sequence owns one mutation workflow lease.
 */
export async function downloadAndGenerateBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
  opts: WaitForBackupOptions = {},
): Promise<BackupGenerateCompletion> {
  targetRequest(input, 'BackupCloudExport');
  assertBackupPollOptions(opts);
  return withResourceMutationWorkflow(deps, 'backup.cloud-export', async () => {
    const { result, progress } = await ensureBackupDownloadedWithinWorkflow(
      input,
      deps,
      opts,
      'backup.cloud-export.download',
    );
    const content = await generateBackup(input, deps);
    return { downloadResult: result, downloadProgress: progress, content };
  });
}

async function ensureBackupDownloadedWithinWorkflow(
  input: BackupTargetInput,
  deps: ResourceDeps,
  opts: WaitForBackupOptions,
  operation: string,
): Promise<{ result: BackupOperationResponse; progress: BackupProgressResponse }> {
  const raw = await requestBackupDownloadWithinWorkflow(input, deps);
  let result: BackupOperationResponse;
  try {
    result = parseOrThrow(BackupOperationResponse, raw, 'BackupDownloadResponse');
  } catch (error) {
    throw notConfirmedAfterAcknowledgement(
      error,
      'backup download was acknowledged but its response could not be interpreted; cache completion is not confirmed',
      {
        operation,
        phase: 'ack-parse',
        from: input.from,
        hint: 'log out, log in again, and inspect backup state before retrying',
      },
    );
  }

  const progressId = extractBackupProgressId(result);
  if (progressId === 0 || isExactEmptyObject(result)) {
    return { result, progress: { progress: 100 } };
  }
  if (progressId === null) {
    throw new NotConfirmedError(
      'backup download was accepted without enough progress metadata to confirm cache completion',
      {
        operation,
        from: input.from,
        hint: 'log out, log in again, and inspect backup state before retrying',
      },
    );
  }

  let progress: BackupProgressResponse;
  try {
    progress = await waitForBackupProgress({ from: input.from, progressId, operation }, deps, opts);
  } catch (error) {
    throw notConfirmedAfterAcknowledgement(
      error,
      'backup download was acknowledged but cache completion could not be confirmed',
      {
        operation,
        phase: 'progress-confirmation',
        from: input.from,
        progressId,
        hint: 'log out, log in again, and inspect backup state before retrying',
      },
    );
  }
  return { result, progress };
}

interface BackupLoadTerminalCompletion {
  result: BackupOperationResponse;
  progress: BackupProgressResponse;
}

async function loadBackupWithinWorkflow(
  input: BackupTargetInput,
  deps: ResourceDeps,
  opts: LoadBackupOptions,
): Promise<BackupLoadTerminalCompletion> {
  const raw = await callBackup(
    deps,
    '/api/loadBackup',
    targetRequest(input, 'BackupLoad'),
    'write',
  );
  let result: BackupOperationResponse;
  try {
    result = parseOrThrow(BackupOperationResponse, raw, 'BackupLoadResponse');
  } catch (error) {
    throw notConfirmedAfterAcknowledgement(
      error,
      'backup load was acknowledged but its response could not be interpreted; restore completion is not confirmed',
      {
        operation: 'backup.load',
        phase: 'ack-parse',
        from: input.from,
        hint: 'log out, log in again, and inspect live state before retrying or making any later mutation',
      },
    );
  }
  const progressId = extractBackupProgressId(result);
  if (progressId === null) {
    throw new NotConfirmedError(
      'backup load was accepted without a progress_id; restore completion is not confirmed',
      {
        operation: 'backup.load',
        from: input.from,
        hint: 'log out, log in again, and inspect live state before any later mutation',
      },
    );
  }
  let progress: BackupProgressResponse;
  try {
    progress = await waitForBackupProgress(
      { from: input.from, progressId, operation: 'backup.load' },
      deps,
      {
        ...(opts.pollIntervalMs !== undefined && { pollIntervalMs: opts.pollIntervalMs }),
        ...(opts.pollTimeoutMs !== undefined && { pollTimeoutMs: opts.pollTimeoutMs }),
      },
    );
  } catch (error) {
    throw notConfirmedAfterAcknowledgement(
      error,
      'backup load was acknowledged but terminal restore progress could not be confirmed',
      {
        operation: 'backup.load',
        phase: 'progress-confirmation',
        from: input.from,
        progressId,
        hint: 'log out, log in again, and inspect live state before retrying or making any later mutation',
      },
    );
  }
  return { result, progress };
}

/**
 * Restore a backup through the complete xgg workflow and keep one mutation
 * lease from cache download through terminal restore progress.
 * Both download and load responses are acknowledgements; releasing after
 * either one would let a later mutation race unfinished gateway work.
 */
export interface BackupLoadCompletion {
  downloadResult: BackupOperationResponse;
  downloadProgress: BackupProgressResponse;
  result: BackupOperationResponse;
  progress: BackupProgressResponse;
}

export function loadBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
  opts: LoadBackupOptions & { includeProgress: true },
): Promise<BackupLoadCompletion>;
export function loadBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
  opts?: LoadBackupOptions & { includeProgress?: false },
): Promise<BackupOperationResponse>;
export function loadBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
  opts: LoadBackupOptions,
): Promise<BackupOperationResponse | BackupLoadCompletion>;
export async function loadBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
  opts: LoadBackupOptions = {},
): Promise<BackupOperationResponse | BackupLoadCompletion> {
  targetRequest(input, 'BackupLoad');
  assertBackupPollOptions(opts);
  const completion = await withResourceMutationWorkflow(deps, 'backup.load', async () => {
    const { result: downloadResult, progress: downloadProgress } =
      await ensureBackupDownloadedWithinWorkflow(input, deps, opts, 'backup.load.download');
    const load = await loadBackupWithinWorkflow(input, deps, {
      ...(opts.pollIntervalMs !== undefined && { pollIntervalMs: opts.pollIntervalMs }),
      ...(opts.pollTimeoutMs !== undefined && { pollTimeoutMs: opts.pollTimeoutMs }),
    });
    return { downloadResult, downloadProgress, ...load };
  });
  return opts.includeProgress === true ? completion : completion.result;
}

async function deleteBackupWithinWorkflow(
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

export async function deleteBackup(
  input: BackupTargetInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  targetRequest(input, 'BackupDelete');
  return withResourceMutationWorkflow(deps, 'backup.delete', () =>
    deleteBackupWithinWorkflow(input, deps),
  );
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
  if (isBackupProgressId(resp)) return resp;
  if (resp !== null && typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    if (isBackupProgressId(r.progress_id)) return r.progress_id;
    if (isBackupProgressId(r.progressId)) return r.progressId;
  }
  return null;
}

function isBackupProgressId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isExactEmptyObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

export interface LoadBackupOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Return the real terminal progress together with the preserved gateway acknowledgement. */
  includeProgress?: boolean;
}

export interface WaitForBackupOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Test seam — inject a getBackupProgress stub. */
  _getBackupProgress?: typeof getBackupProgress;
}

const MAX_TIMER_MS = 2_147_483_647;

/** Internal shared guard for every loop that may hold a mutation lease. */
export function assertBackupPollOptions(opts: LoadBackupOptions): void {
  for (const [name, value] of [
    ['pollIntervalMs', opts.pollIntervalMs],
    ['pollTimeoutMs', opts.pollTimeoutMs],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS)
    ) {
      throw new ConfigError(`${name} must be a positive integer <= ${MAX_TIMER_MS}`, {
        option: name,
        value,
      });
    }
  }
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
  assertBackupPollOptions(opts);
  if (input.progressId === 0) {
    return { progress: 100 };
  }
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

async function setBackupConfigWithinWorkflow(
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

export async function setBackupConfig(
  input: BackupSetConfigInput,
  deps: ResourceDeps,
): Promise<BackupOperationResponse> {
  parseOrThrow(BackupSetConfigInput, input, 'BackupSetConfigInput');
  return withResourceMutationWorkflow(deps, 'backup.config.set', () =>
    setBackupConfigWithinWorkflow(input, deps),
  );
}
