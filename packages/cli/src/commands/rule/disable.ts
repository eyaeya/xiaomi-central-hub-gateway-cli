import { disableRule, dumpBeforeWrite } from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import {
  addNextHintFlag,
  buildNextSteps,
  nextHintOptedOut,
  printNextStepHintLine,
  withNextSteps,
} from '../../agent-hints.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface DisableOpts extends RuleOpts {
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
  nextHint?: boolean;
}

export function attachDisable(cmd: Command): void {
  const sub = cmd
    .command('disable <id>')
    .description('Disable a rule by id')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText('after', '\nExample:\n  $ xgg rule disable 1748234567890')
    .action(
      wrap('rule.disable', async (id: string, opts: DisableOpts) => {
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
        const result = await disableRule(id, deps);
        const payloadBase = {
          ok: true,
          ...result,
          snapshot: snapshotPath,
        } as Record<string, unknown>;
        const hints = buildNextSteps('rule.disable', { id, ruleId: id }, opts);
        emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${id} (disabled)`,
        });
        printNextStepHintLine(hints, opts, { contextLabel: `rule ${id} (disabled)` });
      }),
    );
}
