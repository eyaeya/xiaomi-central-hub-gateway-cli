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
  runMutationWorkflow,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';
import { type EdgeEndpointOpts, parseEdgeEndpoints } from './_helpers.js';

interface EdgeAddOpts extends RuleOpts, EdgeEndpointOpts {
  ruleId: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
  nextHint?: boolean;
  // F66f/#173 — opt out of the incremental online variable existence/type sweep.
  varCheck?: boolean;
}

export function attachEdgeAdd(cmd: Command): void {
  const edge = cmd.commands.find((c) => c.name() === 'edge') ?? cmd.command('edge');
  if (!edge.description()) edge.description('Edge operations within a rule');
  const sub = edge
    .command('add')
    .description('Add an edge between two nodes in a rule graph')
    .requiredOption('--rule-id <id>', 'rule id')
    .option('--from <NID:pin>', 'source endpoint as nodeId:pin (canonical ids)')
    .option('--to <NID:pin>', 'target endpoint as nodeId:pin (canonical ids)')
    .option('--from-node-id <id>', 'lossless source node id (requires all split endpoint flags)')
    .option('--from-pin <pin>', 'lossless source pin (requires all split endpoint flags)')
    .option('--to-node-id <id>', 'lossless target node id (requires all split endpoint flags)')
    .option('--to-pin <pin>', 'lossless target pin (requires all split endpoint flags)')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option(
      '--no-var-check',
      'skip the incremental online variable existence/type sweep (raw probes only)',
    )
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg rule edge add --rule-id r1 --from n1:output --to n2:trigger --snapshots-dir ./snapshots/\n  $ xgg rule edge add --rule-id r1 --from-node-id legacy:id --from-pin output --to-node-id n2 --to-pin trigger --snapshots-dir ./snapshots/',
    )
    .action(
      wrap('rule.edge.add', async (opts: EdgeAddOpts) => {
        const { from, to } = parseEdgeEndpoints(opts);
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);

        const { snapshotPath, result } = await runMutationWorkflow(
          'rule.edge.add',
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
            const result = await addEdge(
              { ruleId: opts.ruleId, from, to, varCheck: opts.varCheck !== false },
              deps,
            );
            return { snapshotPath, result };
          },
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
          context: `rule ${opts.ruleId} (edge-add ${from.nodeId}:${from.pin}→${to.nodeId}:${to.pin})`,
        });
        printNextStepHintLine(hints, opts, {
          contextLabel: `rule ${opts.ruleId} (+edge)`,
        });
      }),
    );
}
