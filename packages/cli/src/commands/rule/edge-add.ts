import { addEdge, dumpBeforeWrite } from '@eyaeya/xgg-core';
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
import { parseEdgeRef } from './_helpers.js';

interface EdgeAddOpts extends RuleOpts {
  ruleId: string;
  from: string;
  to: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
  nextHint?: boolean;
  // F66f (2026-05-31) — opt out of the incremental var-existence sweep.
  varCheck?: boolean;
}

export function attachEdgeAdd(cmd: Command): void {
  const edge = cmd.commands.find((c) => c.name() === 'edge') ?? cmd.command('edge');
  if (!edge.description()) edge.description('Edge operations within a rule');
  const sub = edge
    .command('add')
    .description('Add an edge between two nodes in a rule graph')
    .requiredOption('--rule-id <id>', 'rule id')
    .requiredOption('--from <NID:pin>', 'source endpoint as nodeId:pin')
    .requiredOption('--to <NID:pin>', 'target endpoint as nodeId:pin')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option('--no-var-check', 'skip the F66f incremental var-existence sweep (raw probes only)')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText(
      'after',
      '\nExample:\n  $ xgg rule edge add --rule-id r1 --from n1:output --to n2:trigger --snapshots-dir ./snapshots/',
    )
    .action(
      wrap('rule.edge.add', async (opts: EdgeAddOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);
        const from = parseEdgeRef(opts.from, '--from');
        const to = parseEdgeRef(opts.to, '--to');

        const snapshotPath = !guard.snapshotEnabled
          ? null
          : await dumpBeforeWrite({
              baseUrl: deps.baseUrl,
              store: deps.store,
              ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
              ...(snapshotsDir !== undefined && { snapshotsDir }),
            });

        const result = await addEdge(
          { ruleId: opts.ruleId, from, to, varCheck: opts.varCheck !== false },
          deps,
        );
        const payloadBase = {
          ok: true,
          edgeString: result.edgeString,
          snapshot: snapshotPath,
        } as Record<string, unknown>;
        const hints = buildNextSteps(
          'rule.edge.add',
          { ruleId: opts.ruleId, edgeString: result.edgeString },
          opts,
        );
        emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${opts.ruleId} (edge-add ${opts.from}→${opts.to})`,
        });
        printNextStepHintLine(hints, opts, {
          contextLabel: `rule ${opts.ruleId} (+edge)`,
        });
      }),
    );
}
