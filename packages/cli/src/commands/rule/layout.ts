import { dumpBeforeWrite, relayoutGraph } from '@eyaeya/xgg-core';
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

interface LayoutOpts extends RuleOpts {
  snapshot?: boolean;
  snapshotsDir?: string;
  validate?: boolean;
  refreshHint?: boolean;
  nextHint?: boolean;
  // F66f (2026-05-31) — opt out of the incremental var-existence sweep.
  varCheck?: boolean;
}

export function attachLayout(cmd: Command): void {
  const sub = cmd
    .command('layout <id>')
    .description(
      'Flow-aware relayout: reposition executable cards by wiring while preserving nop notes',
    )
    .option('--no-snapshot', 'skip the pre-write dump snapshot (NOT recommended)')
    .option('--no-validate', 'skip the web-UI save-button validator (NOT recommended)')
    .option('--no-var-check', 'skip the F66f incremental var-existence sweep (raw probes only)')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText(
      'after',
      [
        '',
        'Lays cards out by data flow: triggers/sources on the left, each node to the',
        'right of all its inputs, branches stacked vertically, and independent',
        'sub-automations in separate horizontal bands. Only cfg.pos.x/y change.',
        'Run it once after all `rule edge add` calls, before `rule enable`.',
        '',
        'Example:',
        '  $ xgg rule layout 1748234567890 --snapshots-dir ./snapshots/',
      ].join('\n'),
    )
    .action(
      wrap('rule.layout', async (id: string, opts: LayoutOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);
        const { snapshotPath, result } = await runMutationWorkflow(
          'rule.layout',
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
            const result = await relayoutGraph(id, deps, {
              validate: opts.validate !== false,
              varCheck: opts.varCheck !== false,
            });
            return { snapshotPath, result };
          },
        );
        const payloadBase = {
          ok: true,
          id,
          nodeCount: result.nodeCount,
          moved: result.moved,
          snapshot: snapshotPath,
        } as Record<string, unknown>;
        const hints = buildNextSteps('rule.layout', { id, ruleId: id }, opts);
        emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${id} (layout: ${result.moved}/${result.nodeCount} nodes moved)`,
        });
        printNextStepHintLine(hints, opts, { contextLabel: `rule ${id} (laid out)` });
      }),
    );
}
