import { dumpBeforeWrite, removeEdge } from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';
import { parseEdgeRef } from './_helpers.js';

interface EdgeRemoveOpts extends RuleOpts {
  ruleId: string;
  from: string;
  to: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
  // F66f (2026-05-31) — opt out of the incremental var-existence sweep.
  varCheck?: boolean;
}

export function attachEdgeRemove(cmd: Command): void {
  const edge = cmd.commands.find((c) => c.name() === 'edge') ?? cmd.command('edge');
  if (!edge.description()) edge.description('Edge operations within a rule');
  const sub = edge
    .command('remove')
    .description("Remove an edge from a rule's graph")
    .requiredOption('--rule-id <id>', 'rule id')
    .requiredOption('--from <NID:pin>', 'source endpoint as nodeId:pin')
    .requiredOption('--to <NID:pin>', 'target endpoint as nodeId:pin')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option(
      '--no-var-check',
      'skip the F66f incremental var-existence sweep (raw probes / cleanup of broken graphs)',
    )
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addRefreshHintFlag(sub)
    .addHelpText(
      'after',
      '\nExample:\n  $ xgg rule edge remove --rule-id r1 --from n1:output --to n2:trigger --snapshots-dir ./snapshots/',
    )
    .action(
      wrap('rule.edge.remove', async (opts: EdgeRemoveOpts) => {
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

        const result = await removeEdge(
          { ruleId: opts.ruleId, from, to, varCheck: opts.varCheck !== false },
          deps,
        );
        emit(
          { ok: true, edgeString: result.edgeString, snapshot: snapshotPath },
          { pretty: opts.pretty === true },
        );
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${opts.ruleId} (edge-remove ${opts.from}→${opts.to})`,
        });
      }),
    );
}
