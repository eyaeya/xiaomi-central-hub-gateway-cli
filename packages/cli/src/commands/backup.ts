import {
  type BackupItem,
  ConfigError,
  createBackup,
  createStore,
  deleteBackup,
  downloadBackup,
  dumpBeforeWrite,
  generateBackup,
  getBackupConfig,
  getBackupProgress,
  listBackups,
  loadBackup,
  setBackupConfig,
} from '@eyaeya/xgg-core';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { type TableColumn, emit, emitList } from '../output.js';
import { assertAgentModeOrSnapshotsDir } from './_mutation-guard.js';

interface BackupOpts {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
  from: string;
}

interface BackupTargetOpts extends BackupOpts {
  did: string;
  ts: string;
  fileName: string;
  deviceName?: string;
  modelName?: string;
  self?: boolean;
}

interface SnapshotOpts extends BackupTargetOpts {
  snapshot?: boolean;
  snapshotsDir?: string;
}

interface CreateOpts extends BackupOpts {
  fileName: string;
}

interface ProgressOpts extends BackupOpts {
  progressId: string;
}

interface SetConfigOpts extends BackupOpts {
  autoBackup: string;
  autoBackupLimit?: string;
}

function makeDeps(opts: BackupOpts) {
  const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
  if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
  const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
  return { baseUrl, store, timeoutMs: Number(opts.timeout) };
}

// F26: gateway currently exposes a single vocab ("fds"); keep --from optional
// with that default so terminal use is one keystroke shorter. AI agents can
// still pin the vocab explicitly to survive future expansion.
function addCommonOptions(cmd: Command, prettyHelp = 'pretty-print JSON output'): Command {
  return cmd
    .option('--from <from>', 'backup source vocabulary; current gateway builds use fds', 'fds')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', prettyHelp);
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
  opts: { snapshot?: boolean; snapshotsDir?: string },
  deps: ReturnType<typeof makeDeps>,
): Promise<string | null> {
  const guard = assertAgentModeOrSnapshotsDir(opts);
  if (!guard.snapshotEnabled) return null;
  return dumpBeforeWrite({
    baseUrl: deps.baseUrl,
    store: deps.store,
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
    ...(guard.snapshotsDir !== undefined && { snapshotsDir: guard.snapshotsDir }),
  });
}

export function backupCommand(): Command {
  const cmd = new Command('backup').description('Backup operations');

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

  addCommonOptions(
    cmd
      .command('create')
      .description('Create a cloud backup')
      .requiredOption('--file-name <name>', 'backup filename')
      .addHelpText('after', '\nExample:\n  $ xgg backup create --from fds --file-name probe.bak'),
  ).action(
    wrap('backup.create', async (opts: CreateOpts) => {
      const deps = makeDeps(opts);
      const result = await createBackup({ from: opts.from, fileName: opts.fileName }, deps);
      emit({ ok: true, result }, { pretty: opts.pretty === true });
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

  addTargetOptions(
    cmd
      .command('download')
      .description('Request a cloud backup download')
      .addHelpText(
        'after',
        '\nExample:\n  $ xgg backup download --from fds --did <DID> --ts <TS> --file-name <NAME>',
      ),
  ).action(
    wrap('backup.download', async (opts: BackupTargetOpts) => {
      const deps = makeDeps(opts);
      const result = await downloadBackup({ from: opts.from, backup: backupRef(opts) }, deps);
      emit({ ok: true, result }, { pretty: opts.pretty === true });
    }),
  );

  addTargetOptions(
    cmd
      .command('generate')
      .description('Request a generated/exportable backup')
      .addHelpText(
        'after',
        '\nExample:\n  $ xgg backup generate --from fds --did <DID> --ts <TS> --file-name <NAME>',
      ),
  ).action(
    wrap('backup.generate', async (opts: BackupTargetOpts) => {
      const deps = makeDeps(opts);
      const result = await generateBackup({ from: opts.from, backup: backupRef(opts) }, deps);
      emit({ ok: true, result }, { pretty: opts.pretty === true });
    }),
  );

  addSnapshotOptions(
    addTargetOptions(
      cmd
        .command('load')
        .description('Restore a cloud backup (writes snapshot first)')
        .addHelpText(
          'after',
          '\nExample:\n  $ xgg backup load --from fds --did <DID> --ts <TS> --file-name <NAME> --snapshots-dir ./snapshots/',
        ),
    ),
  ).action(
    wrap('backup.load', async (opts: SnapshotOpts) => {
      const deps = makeDeps(opts);
      const snapshot = await snapshotBeforeBackupWrite(opts, deps);
      const result = await loadBackup({ from: opts.from, backup: backupRef(opts) }, deps);
      emit({ ok: true, snapshot, result }, { pretty: opts.pretty === true });
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
      const deps = makeDeps(opts);
      const snapshot = await snapshotBeforeBackupWrite(opts, deps);
      const result = await deleteBackup({ from: opts.from, backup: backupRef(opts) }, deps);
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

  addCommonOptions(
    config
      .command('set')
      .description('Set backup configuration')
      .requiredOption('--auto-backup <true|false>', 'enable or disable automatic cloud backup')
      .option('--auto-backup-limit <n>', 'optional automatic backup retention limit')
      .addHelpText('after', '\nExample:\n  $ xgg backup config set --from fds --auto-backup true'),
  ).action(
    wrap('backup.config.set', async (opts: SetConfigOpts) => {
      const deps = makeDeps(opts);
      const autoBackup = parseBoolean(opts.autoBackup, '--auto-backup');
      const autoBackupLimit = parseOptionalNumber(opts.autoBackupLimit, '--auto-backup-limit');
      const result = await setBackupConfig(
        {
          from: opts.from,
          autoBackup,
          ...(autoBackupLimit !== undefined && { autoBackupLimit }),
        },
        deps,
      );
      emit({ ok: true, result }, { pretty: opts.pretty === true });
    }),
  );

  return cmd;
}
