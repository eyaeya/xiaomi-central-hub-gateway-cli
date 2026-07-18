import { readFileSync } from 'node:fs';
import {
  type AgentCallKind,
  type BackupItem,
  ConfigError,
  agentCall,
  createStore,
  dumpBeforeWrite,
  resolveAgentCallKind,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { emit } from '../output.js';
import { assertAgentModeOrSnapshotsDir } from './_mutation-guard.js';

const RAW_BACKUP_WRITE_METHODS = new Set([
  '/api/createBackup',
  '/api/deleteBackup',
  '/api/downloadBackup',
  '/api/loadBackup',
  '/api/setBackupConfig',
]);
const RAW_BACKUP_TARGET_METHODS = new Set([
  '/api/deleteBackup',
  '/api/downloadBackup',
  '/api/loadBackup',
]);

interface ApiOpts {
  params?: string;
  paramsFile?: string;
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  kind?: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  pretty?: boolean;
}

function parseKind(value: string | undefined): AgentCallKind | undefined {
  if (value === undefined || value === 'read' || value === 'write') return value;
  throw new ConfigError('--kind must be either "read" or "write"');
}

function backupContextForRawWrite(
  method: string,
  params: unknown,
): { from: string; target?: BackupItem } | undefined {
  if (!RAW_BACKUP_WRITE_METHODS.has(method)) return undefined;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ConfigError(
      `raw backup write "${method}" requires object params with "from" so rollback state can be captured`,
    );
  }
  const request = params as Record<string, unknown>;
  if (typeof request.from !== 'string' || request.from.length === 0) {
    throw new ConfigError(
      `raw backup write "${method}" requires string params.from so rollback state can be captured`,
    );
  }
  if (!RAW_BACKUP_TARGET_METHODS.has(method)) return { from: request.from };
  if (
    request.params === null ||
    typeof request.params !== 'object' ||
    Array.isArray(request.params)
  ) {
    throw new ConfigError(
      `raw backup write "${method}" requires params.params with did, ts, and fileName so the rollback target can be captured`,
    );
  }
  const target = request.params as Record<string, unknown>;
  if (
    typeof target.did !== 'string' ||
    typeof target.ts !== 'string' ||
    typeof target.fileName !== 'string'
  ) {
    throw new ConfigError(
      `raw backup write "${method}" requires string params.params.did, ts, and fileName so the rollback target can be captured`,
    );
  }
  return {
    from: request.from,
    // The three identity fields are required, but retain every optional and
    // future passthrough field so the rollback audit names the exact target
    // object that the raw write sends.
    target: target as BackupItem,
  };
}

export function apiCommand(): Command {
  return new Command('api')
    .description('Low-level escape hatch: forward a raw JSON-RPC call through the per-host agent.')
    .argument('<method>', 'JSON-RPC method name')
    .option('--params <json>', 'JSON params (string)')
    .option('--params-file <path>', 'JSON params from file')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option(
      '--kind <read|write>',
      'explicit call intent; known gateway mutations require write (default: read)',
    )
    .option('--no-snapshot', 'skip the pre-write rollback snapshot (NOT recommended)')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      '\nIntent:\n  Calls default to read, except known mutations which require --kind write.\n  Unknown future methods remain available with an explicit --kind.\n\nExamples:\n  $ xgg api /api/getDevList --pretty\n  $ xgg api /api/getGraph --kind read --params \'{"id":"1748234567890"}\'\n  $ xgg api /api/setVarValue --kind write --snapshots-dir ./snapshots --params \'{"scope":"global","id":"x","value":1}\'',
    )
    .action(
      wrap('api', async (method: string, opts: ApiOpts) => {
        const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
        if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
        let params: unknown = null;
        if (opts.paramsFile) {
          params = JSON.parse(readFileSync(opts.paramsFile, 'utf8'));
        } else if (opts.params) {
          params = JSON.parse(opts.params);
        }
        const kind = resolveAgentCallKind(method, parseKind(opts.kind));
        const guard = kind === 'write' ? assertAgentModeOrSnapshotsDir(opts) : undefined;
        const backup =
          kind === 'write' && guard?.snapshotEnabled === true
            ? backupContextForRawWrite(method, params)
            : undefined;
        const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
        const timeoutMs = Number(opts.timeout);
        const snapshot =
          kind === 'write' && guard?.snapshotEnabled === true
            ? await dumpBeforeWrite({
                baseUrl,
                store,
                timeoutMs,
                ...(guard.snapshotsDir !== undefined && { snapshotsDir: guard.snapshotsDir }),
                ...(backup !== undefined && { backup }),
              })
            : null;
        const result = await agentCall({
          baseUrl,
          method,
          params,
          store,
          timeoutMs,
          kind,
        });
        emit(
          { ok: true, method, kind, ...(kind === 'write' && { snapshot }), result },
          { pretty: opts.pretty === true },
        );
      }),
    );
}
