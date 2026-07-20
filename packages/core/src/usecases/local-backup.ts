import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DEFAULT_MAX_INNER_COMPRESSED_BYTES,
  type InnerJsonLimits,
  packInnerJson,
  unpackInnerJson,
} from '../crypto/deflate.js';
import type { ResourceDeps } from '../resources/index.js';
import { getRule, listRules } from '../resources/rules.js';
import { listScopes, listVariables } from '../resources/variables.js';
import {
  LegacyLocalBackupPayload,
  type LocalBackupPayload,
  LocalBackupPayload as LocalBackupPayloadSchema,
} from '../schemas/backup.js';
import { GraphSetRequest } from '../schemas/rule.js';
import { VariableCreateRequest, VariableSetValueRequest } from '../schemas/variable.js';
import { notConfirmedAfterAcknowledgement } from '../transport/confirmation.js';
import { ConfigError, NotConfirmedError, SchemaError, parseOrThrow } from '../transport/errors.js';
import { agentCall, withMutationWorkflow } from './agent-call.js';
import { dumpBeforeWrite } from './dump-before-write.js';

const DIGEST_BYTES = 32;
const LENGTH_PREFIX_BYTES = 4;

export type { LocalBackupPayload } from '../schemas/backup.js';

export interface LocalBackupExportOptions {
  /** Replace an existing destination atomically. Default: false. */
  overwrite?: boolean;
}

export interface LocalBackupExportResult {
  file: string;
  bytes: number;
  rules: number;
  variables: number;
}

export interface LocalBackupRulePlanEntry {
  id: string;
  name: string;
  enable: boolean;
  nodeCount: number;
}

export interface LocalBackupVariablePlanEntry {
  scope: string;
  id: string;
  type: 'number' | 'string';
  name: string;
}

export interface LocalBackupImportSide {
  rules: LocalBackupRulePlanEntry[];
  variableScopes: string[];
  variables: LocalBackupVariablePlanEntry[];
}

export interface LocalBackupImportPlan {
  formatVersion: 2;
  destructive: true;
  delete: LocalBackupImportSide;
  create: LocalBackupImportSide;
  totals: {
    deleteRules: number;
    deleteVariableScopes: number;
    deleteVariables: number;
    createRules: number;
    createVariableScopes: number;
    createVariables: number;
  };
}

export interface LocalBackupAppliedCounts {
  deletedRules: number;
  deletedVariableScopes: number;
  createdVariables: number;
  setVariableValues: number;
  createdRules: number;
}

export interface LocalBackupImportOptions {
  /** Runtime guard for the destructive replace-all operation. */
  confirmReplaceAll: boolean;
  /** Destination root for the mandatory complete pre-write snapshot. */
  snapshotsDir?: string;
}

export interface LocalBackupImportResult {
  snapshot: string;
  plan: LocalBackupImportPlan;
  applied: LocalBackupAppliedCounts;
}

/** Encode the official local-backup envelope: deflate frame followed by SHA-256. */
export function encodeLocalBackup(input: LocalBackupPayload): Buffer {
  const payload = parseOrThrow(LocalBackupPayloadSchema, input, 'LocalBackupPayload');
  const envelope = packInnerJson(payload);
  const digest = createHash('sha256').update(envelope).digest();
  return Buffer.concat([envelope, digest]);
}

/**
 * Verify digest first, then bounded-inflate and normalize either official
 * local-backup generation: the legacy rules-only array or version 2.
 */
export function decodeLocalBackup(
  input: Uint8Array,
  limits: InnerJsonLimits = {},
): LocalBackupPayload {
  const bytes = Buffer.from(input);
  if (bytes.length <= LENGTH_PREFIX_BYTES + DIGEST_BYTES) {
    throw new SchemaError('local backup is too short', {
      format: 'xiaomi-local-bak',
      bytes: bytes.length,
    });
  }

  const envelope = bytes.subarray(0, bytes.length - DIGEST_BYTES);
  const suppliedDigest = bytes.subarray(bytes.length - DIGEST_BYTES);
  const expectedDigest = createHash('sha256').update(envelope).digest();
  if (!timingSafeEqual(suppliedDigest, expectedDigest)) {
    throw new SchemaError('local backup digest mismatch', {
      format: 'xiaomi-local-bak',
    });
  }

  let raw: unknown;
  try {
    raw = unpackInnerJson(envelope, limits);
  } catch (error) {
    throw new SchemaError('local backup deflate payload is invalid', {
      format: 'xiaomi-local-bak',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (Array.isArray(raw)) {
    const legacyRules = parseOrThrow(LegacyLocalBackupPayload, raw, 'LegacyLocalBackupPayload');
    return parseOrThrow(
      LocalBackupPayloadSchema,
      {
        version: 2,
        rules: legacyRules.map((rule) => ({
          ...rule,
          id: rule.id ?? rule.cfg.id,
        })),
        variables: {},
      },
      'LocalBackupPayload',
    );
  }
  return parseOrThrow(LocalBackupPayloadSchema, raw, 'LocalBackupPayload');
}

/** Read and decode a `.bak` without touching the gateway or session store. */
export async function readLocalBackup(
  path: string,
  limits: InnerJsonLimits = {},
): Promise<LocalBackupPayload> {
  const file = resolve(path);
  const maxCompressedBytes = limits.maxCompressedBytes ?? DEFAULT_MAX_INNER_COMPRESSED_BYTES;
  if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes <= 0) {
    throw new ConfigError('maxCompressedBytes must be a positive safe integer');
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new ConfigError(`local backup input is not a file: ${file}`, { path: file });
    }
    const maxFileBytes = LENGTH_PREFIX_BYTES + maxCompressedBytes + DIGEST_BYTES;
    if (info.size > maxFileBytes) {
      throw new SchemaError(`local backup exceeds the compressed size limit ${maxFileBytes}`, {
        path: file,
        bytes: info.size,
        maxFileBytes,
      });
    }
    return decodeLocalBackup(await handle.readFile(), limits);
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof SchemaError ||
      error instanceof NotConfirmedError
    ) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(`unable to read local backup file: ${file}`, {
      path: file,
      ...(code !== undefined && { fsCode: code }),
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Collect the same complete version-2 payload as the official web bundle. */
export async function collectLocalBackup(deps: ResourceDeps): Promise<LocalBackupPayload> {
  const summaries = await listRules(deps);
  const seenRuleIds = new Set<string>();
  const rules: LocalBackupPayload['rules'] = [];
  for (const cfg of summaries) {
    if (seenRuleIds.has(cfg.id)) {
      throw new SchemaError(`local backup export found duplicate rule id: ${cfg.id}`, {
        ruleId: cfg.id,
      });
    }
    seenRuleIds.add(cfg.id);
    const graph = await getRule(cfg.id, deps);
    if (graph.id !== cfg.id) {
      throw new SchemaError(
        `local backup export rule id mismatch: requested ${cfg.id}, received ${graph.id}`,
        { requestedRuleId: cfg.id, receivedRuleId: graph.id },
      );
    }
    rules.push({ id: cfg.id, cfg, nodes: graph.nodes });
  }

  const scopes = await listScopes(deps);
  const seenScopes = new Set<string>();
  const entries: Array<[string, LocalBackupPayload['variables'][string]]> = [];
  for (const scope of scopes) {
    if (seenScopes.has(scope)) {
      throw new SchemaError(`local backup export found duplicate variable scope: ${scope}`, {
        scope,
      });
    }
    seenScopes.add(scope);
    entries.push([scope, await listVariables(scope, deps)]);
  }

  return parseOrThrow(
    LocalBackupPayloadSchema,
    { version: 2, rules, variables: Object.fromEntries(entries) },
    'LocalBackupPayload',
  );
}

/** Collect live state and publish a complete `.bak` through an atomic rename/link. */
export async function exportLocalBackup(
  outputPath: string,
  deps: ResourceDeps,
  options: LocalBackupExportOptions = {},
): Promise<LocalBackupExportResult> {
  // Deliberately do not acquire the mutation workflow here. Export issues only
  // gateway reads, and must remain available while writes are fenced for
  // inspection/recovery. It also prevents a local filesystem durability error
  // from being mistaken for an uncertain gateway mutation.
  const payload = await collectLocalBackup(deps);
  const encoded = encodeLocalBackup(payload);
  const file = await writeLocalBackupAtomically(outputPath, encoded, options.overwrite === true);
  return {
    file,
    bytes: encoded.length,
    rules: payload.rules.length,
    variables: countVariables(payload),
  };
}

/**
 * Run every deterministic import check before session access or mutation.
 * This intentionally validates the persisted/wire contract rather than the
 * stricter interactive-authoring lint: the official loader restores disabled
 * drafts and gateway-accepted legacy graphs without first making them runnable.
 */
export async function validateLocalBackupPayload(input: unknown): Promise<LocalBackupPayload> {
  const payload = parseOrThrow(LocalBackupPayloadSchema, input, 'LocalBackupPayload');
  for (const [scope, variables] of Object.entries(payload.variables)) {
    for (const [id, entry] of Object.entries(variables)) {
      parseOrThrow(
        VariableCreateRequest,
        { ...entry, scope, id },
        `LocalBackupVariable(${scope}.${id})`,
      );
    }
  }

  for (const rule of payload.rules) {
    parseOrThrow(GraphSetRequest, rule, `LocalBackupRule(${rule.id})`);
  }
  return payload;
}

/** Produce the exact live delete and backup create sets without writing. */
export async function planLocalBackupImport(
  input: unknown,
  deps: ResourceDeps,
): Promise<LocalBackupImportPlan> {
  const payload = await validateLocalBackupPayload(input);
  return buildImportPlan(payload, await collectLocalBackup(deps));
}

/**
 * Replace all rules and variables under one workflow lease. A complete
 * rollback snapshot is published before the first delete. The first failure
 * stops the sequence; any failure after an acknowledged write is reclassified
 * as NOT_CONFIRMED so the daemon fences later mutations pending inspection.
 */
export async function importLocalBackup(
  input: unknown,
  deps: ResourceDeps,
  options: LocalBackupImportOptions,
): Promise<LocalBackupImportResult> {
  const payload = await validateLocalBackupPayload(input);
  if (options?.confirmReplaceAll !== true) {
    throw new ConfigError(
      'local backup import replaces all rules and variables; explicit confirmation is required',
      { requiredFlag: '--confirm-replace-all' },
    );
  }

  return withMutationWorkflow(
    {
      baseUrl: deps.baseUrl,
      store: deps.store,
      operation: 'backup.local-import',
      ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
      ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
    },
    async () => {
      const snapshot = await dumpBeforeWrite({
        baseUrl: deps.baseUrl,
        store: deps.store,
        ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
        ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
        ...(options.snapshotsDir !== undefined && { snapshotsDir: options.snapshotsDir }),
      });
      const current = await collectLocalBackup(deps);
      const plan = buildImportPlan(payload, current);
      const applied = await applyImportPlan(payload, plan, deps);
      return { snapshot, plan, applied };
    },
  );
}

function buildImportPlan(
  source: LocalBackupPayload,
  current: LocalBackupPayload,
): LocalBackupImportPlan {
  const remove = describePayload(current);
  const create = describePayload(source);
  return {
    formatVersion: 2,
    destructive: true,
    delete: remove,
    create,
    totals: {
      deleteRules: remove.rules.length,
      deleteVariableScopes: remove.variableScopes.length,
      deleteVariables: remove.variables.length,
      createRules: create.rules.length,
      createVariableScopes: create.variableScopes.length,
      createVariables: create.variables.length,
    },
  };
}

function describePayload(payload: LocalBackupPayload): LocalBackupImportSide {
  // Preserve backup/list ordering because this plan is also the execution
  // order. The official loader iterates rules, scopes, and variables in their
  // serialized order rather than sorting identities.
  const rules = payload.rules.map((rule) => ({
    id: rule.id,
    name: rule.cfg.userData.name,
    enable: rule.cfg.enable,
    nodeCount: rule.nodes.length,
  }));
  const variables: LocalBackupVariablePlanEntry[] = [];
  for (const [scope, values] of Object.entries(payload.variables)) {
    for (const [id, entry] of Object.entries(values)) {
      variables.push({ scope, id, type: entry.type, name: entry.userData.name });
    }
  }
  return {
    rules,
    variableScopes: Object.keys(payload.variables),
    variables,
  };
}

async function applyImportPlan(
  payload: LocalBackupPayload,
  plan: LocalBackupImportPlan,
  deps: ResourceDeps,
): Promise<LocalBackupAppliedCounts> {
  const applied: LocalBackupAppliedCounts = {
    deletedRules: 0,
    deletedVariableScopes: 0,
    createdVariables: 0,
    setVariableValues: 0,
    createdRules: 0,
  };
  let acknowledgedWrites = 0;
  let phase = 'delete-rules';
  const write = async (method: string, params: unknown): Promise<void> => {
    await agentCall({
      baseUrl: deps.baseUrl,
      method,
      params,
      store: deps.store,
      kind: 'write',
      ...(deps.ipcClient !== undefined && { ipcClient: deps.ipcClient }),
      ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
    });
    acknowledgedWrites += 1;
  };

  try {
    for (const rule of plan.delete.rules) {
      await write('/api/deleteGraph', { id: rule.id });
      applied.deletedRules += 1;
    }

    phase = 'delete-variable-scopes';
    for (const scope of plan.delete.variableScopes) {
      await write('/api/deleteVar', { scope, all: true });
      applied.deletedVariableScopes += 1;
    }

    phase = 'create-variables';
    for (const variable of plan.create.variables) {
      const entry = payload.variables[variable.scope]?.[variable.id];
      if (entry === undefined) {
        throw new ConfigError(`local backup plan lost variable ${variable.scope}.${variable.id}`);
      }
      const create = parseOrThrow(
        VariableCreateRequest,
        { ...entry, scope: variable.scope, id: variable.id },
        `LocalBackupVariable(${variable.scope}.${variable.id})`,
      );
      await write('/api/createVar', create);
      applied.createdVariables += 1;

      phase = 'set-variable-values';
      const setValue = parseOrThrow(
        VariableSetValueRequest,
        { scope: variable.scope, id: variable.id, value: entry.value },
        `LocalBackupVariableValue(${variable.scope}.${variable.id})`,
      );
      await write('/api/setVarValue', setValue);
      applied.setVariableValues += 1;
      phase = 'create-variables';
    }

    phase = 'create-rules';
    for (const ruleSummary of plan.create.rules) {
      const rule = payload.rules.find((candidate) => candidate.id === ruleSummary.id);
      if (rule === undefined) {
        throw new ConfigError(`local backup plan lost rule ${ruleSummary.id}`);
      }
      await write(
        '/api/setGraph',
        parseOrThrow(GraphSetRequest, rule, `LocalBackupRule(${rule.id})`),
      );
      applied.createdRules += 1;
    }
    return applied;
  } catch (error) {
    if (acknowledgedWrites === 0) throw error;
    throw notConfirmedAfterAcknowledgement(
      error,
      'local backup import stopped after a partial restore; live state must be inspected before any retry or later mutation',
      {
        operation: 'backup.local-import',
        phase,
        acknowledgedWrites,
        applied,
        hint: 'inspect the mandatory rollback snapshot and live gateway state; do not rerun import blindly',
      },
    );
  }
}

function countVariables(payload: LocalBackupPayload): number {
  return Object.values(payload.variables).reduce(
    (count, variables) => count + Object.keys(variables).length,
    0,
  );
}

async function writeLocalBackupAtomically(
  outputPath: string,
  contents: Buffer,
  overwrite: boolean,
): Promise<string> {
  const target = resolve(outputPath);
  const directory = dirname(target);
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (overwrite) {
      await rename(temporary, target);
      published = true;
    } else {
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ConfigError(`local backup output already exists: ${target}`, {
            path: target,
            requiredFlag: '--overwrite',
          });
        }
        throw error;
      }
      published = true;
      await unlink(temporary);
    }
    await syncDirectory(directory);
    return target;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof NotConfirmedError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (published) {
      throw new NotConfirmedError(
        'local backup file was published but filesystem durability could not be confirmed',
        { path: target, ...(code !== undefined && { fsCode: code }) },
      );
    }
    throw new ConfigError(`unable to write local backup file: ${target}`, {
      path: target,
      ...(code !== undefined && { fsCode: code }),
    });
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}
