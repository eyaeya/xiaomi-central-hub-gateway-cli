import { dumpBeforeWrite, enableRule } from '@eyaeya/xgg-core';
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
  runMutationWorkflow,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface EnableOpts extends RuleOpts {
  snapshot?: boolean;
  snapshotsDir?: string;
  validate?: boolean;
  refreshHint?: boolean;
  nextHint?: boolean;
}

export function attachEnable(cmd: Command): void {
  const sub = cmd
    .command('enable <id>')
    .description('Enable a rule by id (validates the graph first; see --no-validate)')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option(
      '--no-validate',
      'skip card/variable, strict topology, required-input, and directed-reachability gates (request/envelope parsing still applies; NOT recommended)',
    )
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText(
      'after',
      `
Example:
  $ xgg rule enable 1748234567890

Before flipping enable on, xgg checks modeled card config, variable
existence/scope/type, canonical deviceOutput variable targets, strict topology
and required inputs, then directed sink reachability. Validation failures are
ConfigError (exit 5), preventing a lost/wrong-type variable, unsupported output
ref, broken, or statically dead graph from being activated silently.
--no-validate is only for an explicit raw probe and does not bypass
request/envelope parsing.`,
    )
    .action(
      wrap('rule.enable', async (id: string, opts: EnableOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);
        const { snapshotPath, result } = await runMutationWorkflow(
          'rule.enable',
          deps,
          async () => {
            const snapshotPath = !guard.snapshotEnabled
              ? null
              : await dumpBeforeWrite({
                  baseUrl: deps.baseUrl,
                  store: deps.store,
                  ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
                  ...(snapshotsDir !== undefined && { snapshotsDir }),
                });
            const result = await enableRule(id, deps, { validate: opts.validate !== false });
            return { snapshotPath, result };
          },
        );
        const payloadBase = {
          ok: true,
          ...result,
          snapshot: snapshotPath,
        } as Record<string, unknown>;
        const hints = buildNextSteps('rule.enable', { id, ruleId: id }, opts);
        emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${id} (enabled)`,
        });
        printNextStepHintLine(hints, opts, { contextLabel: `rule ${id} (enabled)` });
      }),
    );
}
