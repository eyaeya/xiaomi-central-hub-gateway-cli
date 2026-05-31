import { dumpBeforeWrite, renameRule } from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface RenameOpts extends RuleOpts {
  name: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
}

// F66c (2026-05-31) — `xgg rule rename <id> --name <NEW>`. CLI analog of the
// rule-header rename input. Wraps the core `renameRule` helper which calls
// /api/changeGraphConfig with a preserved-cfg payload (only userData.name +
// monotonic lastUpdateTime change).
export function attachRename(cmd: Command): void {
  const sub = cmd
    .command('rename <id>')
    .description('Rename a rule (preserves enable/uiType/tags/timestamp invariants)')
    .requiredOption('--name <NAME>', 'new rule name shown in the gateway UI')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addRefreshHintFlag(sub)
    .addHelpText('after', '\nExample:\n  $ xgg rule rename 1748234567890 --name "Evening light"')
    .action(
      wrap('rule.rename', async (id: string, opts: RenameOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);
        const snapshotPath = !guard.snapshotEnabled
          ? null
          : await dumpBeforeWrite({
              baseUrl: deps.baseUrl,
              store: deps.store,
              ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
              ...(snapshotsDir !== undefined && { snapshotsDir }),
            });
        await renameRule(id, opts.name, deps);
        emit(
          { ok: true, id, name: opts.name, snapshot: snapshotPath },
          { pretty: opts.pretty === true },
        );
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${id} (renamed to ${JSON.stringify(opts.name)})`,
        });
      }),
    );
}
