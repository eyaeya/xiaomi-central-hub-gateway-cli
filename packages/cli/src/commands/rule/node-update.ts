import { ConfigError, dumpBeforeWrite, updateNode } from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { parseJsonInput } from '../../local-input.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
  runMutationWorkflow,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface NodeUpdateOpts extends RuleOpts {
  ruleId: string;
  nodeId: string;
  patch: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
  // F66f/#173 — opt out of the incremental online variable existence/type sweep.
  varCheck?: boolean;
}

export function attachNodeUpdate(cmd: Command): void {
  const node = cmd.commands.find((c) => c.name() === 'node') ?? cmd.command('node');
  if (!node.description()) node.description('Node operations within a rule');
  const sub = node
    .command('update')
    .description('Update a node in a rule graph')
    .requiredOption('--rule-id <id>', 'rule id')
    .requiredOption('--node-id <id>', 'target node id')
    .requiredOption('--patch <JSON>', 'partial node patch as JSON string')
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
  addRefreshHintFlag(sub)
    .addHelpText(
      'after',
      '\nExample:\n  $ xgg rule node update --rule-id r1 --node-id n1 --patch \'{"cfg":{"name":"new"}}\' --snapshots-dir ./snapshots/',
    )
    .action(
      wrap('rule.node.update', async (opts: NodeUpdateOpts) => {
        const parsedPatch = parseJsonInput(opts.patch, '--patch');
        if (parsedPatch === null || typeof parsedPatch !== 'object' || Array.isArray(parsedPatch)) {
          throw new ConfigError('--patch must be a JSON object');
        }
        const patch = parsedPatch as Record<string, unknown>;
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);

        const { snapshotPath, result } = await runMutationWorkflow(
          'rule.node.update',
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
            const result = await updateNode(
              {
                ruleId: opts.ruleId,
                nodeId: opts.nodeId,
                patch,
                varCheck: opts.varCheck !== false,
              },
              deps,
            );
            return { snapshotPath, result };
          },
        );
        emit(
          { ok: true, nodeId: result.nodeId, snapshot: snapshotPath },
          { pretty: opts.pretty === true },
        );
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${opts.ruleId} (node-update ${opts.nodeId})`,
        });
      }),
    );
}
