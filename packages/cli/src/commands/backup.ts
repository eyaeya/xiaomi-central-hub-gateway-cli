import {
  type BackupItem,
  ConfigError,
  NotConfirmedError,
  createBackup,
  createStore,
  deleteBackup,
  downloadBackup,
  dumpBeforeWrite,
  exportLocalBackup,
  extractBackupProgressId,
  generateBackup,
  getBackupConfig,
  getBackupProgress,
  importLocalBackup,
  listBackups,
  loadBackup,
  planLocalBackupImport,
  readLocalBackup,
  setBackupConfig,
  validateLocalBackupPayload,
  waitForBackupProgress,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { parsePositiveTimerMs } from '../local-input.js';
import { type TableColumn, emit, emitList } from '../output.js';
import {
  type ResolvedMutationGuard,
  assertAgentModeOrSnapshotsDir,
  runMutationWorkflow,
} from './_mutation-guard.js';

interface GatewayOpts {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
}

interface BackupOpts extends GatewayOpts {
  from: string;
  // Optional poll-to-100 on create/download; load always waits, and this flag
  // controls whether terminal progress is included in its JSON output.
  wait?: boolean;
  pollIntervalMs?: string;
  pollTimeoutMs?: string;
}

interface BackupTargetOpts extends BackupOpts {
  did: string;
  ts: string;
  fileName: string;
  deviceName?: string;
  modelName?: string;
  self?: boolean;
}

interface MutationOpts extends BackupOpts {
  snapshot?: boolean;
  snapshotsDir?: string;
}

type SnapshotOpts = BackupTargetOpts & MutationOpts;

interface CreateOpts extends MutationOpts {
  fileName: string;
}

interface ProgressOpts extends BackupOpts {
  progressId: string;
}

interface SetConfigOpts extends MutationOpts {
  autoBackup: string;
  autoBackupLimit?: string;
}

interface LocalExportOpts extends GatewayOpts {
  output: string;
  overwrite?: boolean;
}

interface LocalImportOpts extends GatewayOpts {
  input: string;
  dryRun?: boolean;
  confirmReplaceAll?: boolean;
  snapshotsDir?: string;
}

interface ParsedWaitOptions {
  enabled: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

type BackupWaitOperation = 'backup.create' | 'backup.download';

function makeDeps(opts: GatewayOpts) {
  const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
  if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
  const timeoutMs = parsePositiveTimerMs(opts.timeout, '--timeout');
  const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
  return { baseUrl, store, timeoutMs };
}

function addGatewayOptions(cmd: Command, prettyHelp = 'pretty-print JSON output'): Command {
  return cmd
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', prettyHelp);
}

// F26: gateway currently exposes a single vocab ("fds"); keep --from optional
// with that default so terminal use is one keystroke shorter. AI agents can
// still pin the vocab explicitly to survive future expansion.
function addCommonOptions(cmd: Command, prettyHelp = 'pretty-print JSON output'): Command {
  return addGatewayOptions(cmd, prettyHelp).option(
    '--from <from>',
    'backup source vocabulary; current gateway builds use fds',
    'fds',
  );
}

function addTargetOptions(cmd: Command): Command {
  return addCommonOptions(cmd)
    .requiredOption('--did <did>', 'backup DID from `xgg backup list`')
    .requiredOption('--ts <ts>', 'backup timestamp from `xgg backup list`')
    .requiredOption('--file-name <name>', 'backup fileName from `xgg backup list`')
    .option('--device-name <name>', 'optional deviceName copied from `xgg backup list`')
    .option('--model-name <name>', 'optional modelName copied from `xgg backup list`')
    .option('--self', 'include self=true in the backup reference');
}

// `--wait` polls create/download to 100%. Restore always waits inside core;
// there this flag requests the terminal progress object in command output.
// A progress_id of 0 (synchronous/local-cache hit) resolves instantly.
function addWaitOptions(cmd: Command): Command {
  return cmd
    .option('--wait', 'poll to 100% (load always waits; this includes progress in output)')
    .option(
      '--poll-interval-ms <ms>',
      'progress poll interval (default 1000; requires --wait except for load)',
    )
    .option(
      '--poll-timeout-ms <ms>',
      'progress poll timeout (default 60000; requires --wait except for load)',
    );
}

async function maybeWaitForProgress(
  from: string,
  operation: BackupWaitOperation,
  waitOpts: ParsedWaitOptions,
  result: unknown,
  deps: ReturnType<typeof makeDeps>,
): Promise<{ progress: number } | undefined> {
  if (!waitOpts.enabled) return undefined;
  const progressId = extractBackupProgressId(result);
  if (progressId === null) {
    if (isExactEmptyObject(result)) return { progress: 100 };
    throw new NotConfirmedError(
      `${operation} returned no confirmable progress handle while --wait was requested`,
      {
        operation,
        from,
        hint: 'inspect backup state before retrying the operation',
      },
    );
  }
  const progress = await waitForBackupProgress({ from, progressId, operation }, deps, {
    ...(waitOpts.pollIntervalMs !== undefined && {
      pollIntervalMs: waitOpts.pollIntervalMs,
    }),
    ...(waitOpts.pollTimeoutMs !== undefined && { pollTimeoutMs: waitOpts.pollTimeoutMs }),
  });
  return waitOpts.enabled ? progress : undefined;
}

function isExactEmptyObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function addSnapshotOptions(cmd: Command): Command {
  return cmd
    .option('--no-snapshot', 'skip the pre-write dump snapshot (NOT recommended)')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)');
}

function parseNonnegativeInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${flag} must be a nonnegative integer`);
  }
  return value;
}

function parseBoolean(raw: string, flag: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${flag} must be true or false`);
}

function parseOptionalNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`${flag} must be a number`);
  return value;
}

function parseWaitOptions(opts: BackupOpts, alwaysWait = false): ParsedWaitOptions {
  const suppliedPollFlags = [
    ...(opts.pollIntervalMs !== undefined ? ['--poll-interval-ms'] : []),
    ...(opts.pollTimeoutMs !== undefined ? ['--poll-timeout-ms'] : []),
  ];
  if (opts.wait !== true && !alwaysWait) {
    if (suppliedPollFlags.length > 0) {
      throw new ConfigError(`${suppliedPollFlags.join(' and ')} require --wait`);
    }
  }
  return {
    enabled: opts.wait === true,
    ...(opts.pollIntervalMs !== undefined && {
      pollIntervalMs: parsePositiveTimerMs(opts.pollIntervalMs, '--poll-interval-ms'),
    }),
    ...(opts.pollTimeoutMs !== undefined && {
      pollTimeoutMs: parsePositiveTimerMs(opts.pollTimeoutMs, '--poll-timeout-ms'),
    }),
  };
}

function backupRef(opts: BackupTargetOpts): BackupItem {
  const ref: BackupItem = {
    did: opts.did,
    ts: opts.ts,
    fileName: opts.fileName,
  };
  if (opts.deviceName !== undefined) ref.deviceName = opts.deviceName;
  if (opts.modelName !== undefined) ref.modelName = opts.modelName;
  if (opts.self === true) ref.self = true;
  return ref;
}

async function snapshotBeforeBackupWrite(
  guard: ResolvedMutationGuard,
  opts: { from: string },
  deps: ReturnType<typeof makeDeps>,
  target?: BackupItem,
): Promise<string | null> {
  if (!guard.snapshotEnabled) return null;
  return dumpBeforeWrite({
    baseUrl: deps.baseUrl,
    store: deps.store,
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
    ...(guard.snapshotsDir !== undefined && { snapshotsDir: guard.snapshotsDir }),
    backup: { from: opts.from, ...(target !== undefined && { target }) },
  });
}

export function backupCommand(): Command {
  const cmd = new Command('backup').description('Backup operations');

  addGatewayOptions(
    cmd
      .command('local-export')
      .description('Export all rules and variables to an official-format local .bak')
      .requiredOption('--output <path>', 'destination .bak path')
      .option('--overwrite', 'atomically replace an existing destination')
      .addHelpText(
        'after',
        '\nExample:\n  $ xgg backup local-export --output ./gateway-rules.bak\n  # Read-only gateway operation; the destination is published atomically.',
      ),
  ).action(
    wrap('backup.local-export', async (opts: LocalExportOpts) => {
      const deps = makeDeps(opts);
      const result = await exportLocalBackup(opts.output, deps, {
        overwrite: opts.overwrite === true,
      });
      emit({ ok: true, ...result }, { pretty: opts.pretty === true });
    }),
  );

  addGatewayOptions(
    cmd
      .command('local-import')
      .description('Validate/plan or replace from a current or legacy official local .bak')
      .requiredOption('--input <path>', 'source .bak path')
      .option('--dry-run', 'report the complete live delete/create plan without writing')
      .option(
        '--confirm-replace-all',
        'perform the destructive replace-all import after a mandatory rollback snapshot',
      )
      .option(
        '--snapshots-dir <path>',
        'directory for the mandatory pre-write snapshot (env: XGG_SNAPSHOTS_DIR)',
      )
      .addHelpText(
        'after',
        '\nExamples:\n  $ xgg backup local-import --input ./gateway-rules.bak --dry-run\n  $ xgg backup local-import --input ./gateway-rules.bak --confirm-replace-all --snapshots-dir ./snapshots/\n\nImport accepts complete version-2 backups and official legacy rules-only arrays. A legacy array contains no variables: apply still deletes every current rule and variable, then recreates only its rules. Import verifies SHA-256, bounded deflate, payload schema, variables, and every rule before session access. Applying always snapshots first, holds one mutation lease, and stops on the first failure.',
      ),
  ).action(
    wrap('backup.local-import', async (opts: LocalImportOpts) => {
      // File integrity and all deterministic payload checks deliberately run
      // before base-url/session/snapshot handling.
      const payload = await readLocalBackup(opts.input);
      await validateLocalBackupPayload(payload);
      const dryRun = opts.dryRun === true;
      const confirmed = opts.confirmReplaceAll === true;
      if (dryRun === confirmed) {
        throw new ConfigError(
          'choose exactly one of --dry-run or --confirm-replace-all for local import',
        );
      }

      if (dryRun) {
        const deps = makeDeps(opts);
        const plan = await planLocalBackupImport(payload, deps);
        emit({ ok: true, dryRun: true, plan }, { pretty: opts.pretty === true });
        return;
      }

      const guard = assertAgentModeOrSnapshotsDir({
        snapshot: true,
        ...(opts.snapshotsDir !== undefined && { snapshotsDir: opts.snapshotsDir }),
      });
      const deps = makeDeps(opts);
      const result = await runMutationWorkflow('backup.local-import', deps, () =>
        importLocalBackup(payload, deps, {
          confirmReplaceAll: true,
          ...(guard.snapshotsDir !== undefined && { snapshotsDir: guard.snapshotsDir }),
        }),
      );
      emit({ ok: true, dryRun: false, ...result }, { pretty: opts.pretty === true });
    }),
  );

  addCommonOptions(
    cmd
      .command('list')
      .description('List cloud backups')
      .addHelpText('after', '\nExample:\n  $ xgg backup list --from fds --pretty'),
    'pretty-print: table view (default: compact JSON)',
  ).action(
    wrap('backup.list', async (opts: BackupOpts) => {
      const deps = makeDeps(opts);
      const result = await listBackups(opts.from, deps);
      const columns: TableColumn<(typeof result)[number]>[] = [
        { header: 'fileName', get: (r) => r.fileName },
        { header: 'ts', get: (r) => r.ts },
        { header: 'did', get: (r) => r.did },
        { header: 'self', get: (r) => String(r.self ?? '') },
      ];
      emitList(
        { jsonPayload: { ok: true, backups: result }, columns, rows: result },
        { pretty: opts.pretty === true },
      );
    }),
  );

  addWaitOptions(
    addSnapshotOptions(
      addCommonOptions(
        cmd
          .command('create')
          .description('Create a cloud backup (writes snapshot first)')
          .requiredOption('--file-name <name>', 'backup filename')
          .addHelpText(
            'after',
            '\nExample:\n  $ xgg backup create --from fds --file-name probe.bak --snapshots-dir ./snapshots/\n  $ xgg backup create --file-name probe.bak --wait   # poll to 100% before returning',
          ),
      ),
    ),
  ).action(
    wrap('backup.create', async (opts: CreateOpts) => {
      const waitOpts = parseWaitOptions(opts);
      const guard = assertAgentModeOrSnapshotsDir(opts);
      const deps = makeDeps(opts);
      const { snapshot, result, progress } = await runMutationWorkflow(
        'backup.create',
        deps,
        async () => {
          const snapshot = await snapshotBeforeBackupWrite(guard, opts, deps);
          const result = await createBackup({ from: opts.from, fileName: opts.fileName }, deps);
          const progress = await maybeWaitForProgress(
            opts.from,
            'backup.create',
            waitOpts,
            result,
            deps,
          );
          return { snapshot, result, progress };
        },
      );
      emit(
        { ok: true, snapshot, result, ...(progress && { progress }) },
        { pretty: opts.pretty === true },
      );
    }),
  );

  addCommonOptions(
    cmd
      .command('progress')
      .description('Read backup operation progress')
      .requiredOption('--progress-id <id>', 'progress_id returned by backup operation')
      .addHelpText('after', '\nExample:\n  $ xgg backup progress --from fds --progress-id 5'),
  ).action(
    wrap('backup.progress', async (opts: ProgressOpts) => {
      const deps = makeDeps(opts);
      const progressId = parseNonnegativeInt(opts.progressId, '--progress-id');
      const result = await getBackupProgress({ from: opts.from, progressId }, deps);
      emit({ ok: true, progress: result }, { pretty: opts.pretty === true });
    }),
  );

  addWaitOptions(
    addSnapshotOptions(
      addTargetOptions(
        cmd
          .command('download')
          .description('Request a cloud backup download (writes snapshot first)')
          .addHelpText(
            'after',
            '\nExample:\n  $ xgg backup download --from fds --did <DID> --ts <TS> --file-name <NAME> --snapshots-dir ./snapshots/ --wait\n  # download is a prerequisite for `backup generate` / `backup load` of the same\n  # {did,ts,file-name}; result 0 means the file is already in the gateway cache.',
          ),
      ),
    ),
  ).action(
    wrap('backup.download', async (opts: SnapshotOpts) => {
      const waitOpts = parseWaitOptions(opts);
      const guard = assertAgentModeOrSnapshotsDir(opts);
      const target = backupRef(opts);
      const deps = makeDeps(opts);
      const { snapshot, result, progress } = await runMutationWorkflow(
        'backup.download',
        deps,
        async () => {
          const snapshot = await snapshotBeforeBackupWrite(guard, opts, deps, target);
          const result = await downloadBackup({ from: opts.from, backup: target }, deps);
          const progress = await maybeWaitForProgress(
            opts.from,
            'backup.download',
            waitOpts,
            result,
            deps,
          );
          return { snapshot, result, progress };
        },
      );
      emit(
        { ok: true, snapshot, result, ...(progress && { progress }) },
        { pretty: opts.pretty === true },
      );
    }),
  );

  addTargetOptions(
    cmd
      .command('generate')
      .description('Request a generated/exportable backup')
      .addHelpText(
        'after',
        '\nExample:\n  $ xgg backup generate --from fds --did <DID> --ts <TS> --file-name <NAME>\n  # Prerequisite: run `xgg backup download` with the SAME {did,ts,file-name}\n  # first — generate is a state-coupled read and fails if the file is not yet\n  # in the gateway cache.',
      ),
  ).action(
    wrap('backup.generate', async (opts: BackupTargetOpts) => {
      const deps = makeDeps(opts);
      const result = await generateBackup({ from: opts.from, backup: backupRef(opts) }, deps);
      emit({ ok: true, result }, { pretty: opts.pretty === true });
    }),
  );

  addWaitOptions(
    addSnapshotOptions(
      addTargetOptions(
        cmd
          .command('load')
          .description('Restore a cloud backup (writes snapshot first)')
          .addHelpText(
            'after',
            '\nExample:\n  $ xgg backup load --from fds --did <DID> --ts <TS> --file-name <NAME> --snapshots-dir ./snapshots/\n  # Prerequisite: run `xgg backup download` with the SAME {did,ts,file-name} first.',
          ),
      ),
    ),
  ).action(
    wrap('backup.load', async (opts: SnapshotOpts) => {
      const waitOpts = parseWaitOptions(opts, true);
      const guard = assertAgentModeOrSnapshotsDir(opts);
      const target = backupRef(opts);
      const deps = makeDeps(opts);
      const { snapshot, result, progress } = await runMutationWorkflow(
        'backup.load',
        deps,
        async () => {
          const snapshot = await snapshotBeforeBackupWrite(guard, opts, deps, target);
          const completed = await loadBackup({ from: opts.from, backup: target }, deps, {
            includeProgress: true,
            ...(waitOpts.pollIntervalMs !== undefined && {
              pollIntervalMs: waitOpts.pollIntervalMs,
            }),
            ...(waitOpts.pollTimeoutMs !== undefined && {
              pollTimeoutMs: waitOpts.pollTimeoutMs,
            }),
          });
          return {
            snapshot,
            result: completed.result,
            progress: waitOpts.enabled ? completed.progress : undefined,
          };
        },
      );
      emit(
        { ok: true, snapshot, result, ...(progress && { progress }) },
        { pretty: opts.pretty === true },
      );
    }),
  );

  addSnapshotOptions(
    addTargetOptions(
      cmd
        .command('delete')
        .description('Delete a cloud backup (writes snapshot first)')
        .addHelpText(
          'after',
          '\nExample:\n  $ xgg backup delete --from fds --did <DID> --ts <TS> --file-name <NAME> --snapshots-dir ./snapshots/',
        ),
    ),
  ).action(
    wrap('backup.delete', async (opts: SnapshotOpts) => {
      const guard = assertAgentModeOrSnapshotsDir(opts);
      const target = backupRef(opts);
      const deps = makeDeps(opts);
      const { snapshot, result } = await runMutationWorkflow('backup.delete', deps, async () => {
        const snapshot = await snapshotBeforeBackupWrite(guard, opts, deps, target);
        const result = await deleteBackup({ from: opts.from, backup: target }, deps);
        return { snapshot, result };
      });
      emit({ ok: true, snapshot, result }, { pretty: opts.pretty === true });
    }),
  );

  const config = cmd.command('config').description('Backup auto-backup configuration');

  addCommonOptions(
    config
      .command('get')
      .description('Get backup configuration')
      .addHelpText('after', '\nExample:\n  $ xgg backup config get --from fds'),
  ).action(
    wrap('backup.config.get', async (opts: BackupOpts) => {
      const deps = makeDeps(opts);
      const result = await getBackupConfig(opts.from, deps);
      emit({ ok: true, config: result }, { pretty: opts.pretty === true });
    }),
  );

  addSnapshotOptions(
    addCommonOptions(
      config
        .command('set')
        .description('Set backup configuration (writes snapshot first)')
        .requiredOption('--auto-backup <true|false>', 'enable or disable automatic cloud backup')
        .option('--auto-backup-limit <n>', 'optional automatic backup retention limit')
        .addHelpText(
          'after',
          '\nExample:\n  $ xgg backup config set --from fds --auto-backup true --snapshots-dir ./snapshots/',
        ),
    ),
  ).action(
    wrap('backup.config.set', async (opts: SetConfigOpts) => {
      const autoBackup = parseBoolean(opts.autoBackup, '--auto-backup');
      const autoBackupLimit = parseOptionalNumber(opts.autoBackupLimit, '--auto-backup-limit');
      const guard = assertAgentModeOrSnapshotsDir(opts);
      const deps = makeDeps(opts);
      const { snapshot, result } = await runMutationWorkflow(
        'backup.config.set',
        deps,
        async () => {
          const snapshot = await snapshotBeforeBackupWrite(guard, opts, deps);
          const result = await setBackupConfig(
            {
              from: opts.from,
              autoBackup,
              ...(autoBackupLimit !== undefined && { autoBackupLimit }),
            },
            deps,
          );
          return { snapshot, result };
        },
      );
      emit({ ok: true, snapshot, result }, { pretty: opts.pretty === true });
    }),
  );

  return cmd;
}
