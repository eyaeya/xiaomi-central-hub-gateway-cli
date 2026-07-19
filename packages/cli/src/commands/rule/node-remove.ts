import { dumpBeforeWrite, removeNode } from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
  runMutationWorkflow,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface NodeRemoveOpts extends RuleOpts {
  ruleId: string;
  nodeId: string;
  cascadeEdges?: boolean;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
}

export function attachNodeRemove(cmd: Command): void {
  const node = cmd.commands.find((c) => c.name() === 'node') ?? cmd.command('node');
  if (!node.description()) node.description('Node operations within a rule');
  const sub = node
    .command('remove')
    .description('Remove a node from a rule graph')
    .requiredOption('--rule-id <id>', 'rule id')
    .requiredOption('--node-id <id>', 'target node id')
    .option('--cascade-edges', 'also remove edges that point at the deleted node')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addRefreshHintFlag(sub)
    .addHelpText(
      'after',
      '\nExample:\n  $ xgg rule node remove --rule-id r1 --node-id n1 --cascade-edges --snapshots-dir ./snapshots/',
    )
    .action(
      wrap('rule.node.remove', async (opts: NodeRemoveOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);

        const { snapshotPath, result } = await runMutationWorkflow(
          'rule.node.remove',
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
            const result = await removeNode(
              {
                ruleId: opts.ruleId,
                nodeId: opts.nodeId,
                ...(opts.cascadeEdges === true && { cascadeEdges: true }),
              },
              deps,
            );
            return { snapshotPath, result };
          },
        );
        emit(
          {
            ok: true,
            nodeId: result.nodeId,
            removedEdges: result.removedEdges,
            snapshot: snapshotPath,
          },
          { pretty: opts.pretty === true },
        );
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${opts.ruleId} (node-remove ${opts.nodeId})`,
        });
      }),
    );
}
