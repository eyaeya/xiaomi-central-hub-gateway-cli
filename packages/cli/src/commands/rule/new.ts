import { ConfigError, createRule, dumpBeforeWrite } from '@eyaeya/xgg-core';
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

interface NewOpts extends RuleOpts {
  name: string;
  id?: string;
  uiType: string;
  enable: boolean;
  snapshot?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
  nextHint?: boolean;
}

function parseBoolean(raw: string): boolean {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`--enable must be true|false|1|0 (got "${raw}")`);
}

export function attachNew(cmd: Command): void {
  const sub = cmd
    .command('new')
    .description('Create an empty rule graph with a complete cfg envelope')
    .requiredOption('--name <NAME>', 'rule name shown in the gateway UI')
    .option('--id <ID>', 'rule id (default: current epoch milliseconds)')
    .option('--ui-type <TYPE>', 'rule uiType field', 'test')
    .option('--enable <BOOL>', 'initial enable state: true|false', parseBoolean, false)
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText('after', '\nExample:\n  $ xgg rule new --name "Evening automation"')
    .action(
      wrap('rule.new', async (opts: NewOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);
        const now = Date.now();
        const id = opts.id ?? String(now);
        const body = {
          id,
          nodes: [],
          cfg: {
            id,
            userData: {
              name: opts.name,
              transform: { x: 0, y: 0, scale: 1, rotate: 0 },
              lastUpdateTime: now,
              version: 0,
            },
            uiType: opts.uiType,
            enable: opts.enable,
          },
        };
        const snapshotPath = await runMutationWorkflow('rule.new', deps, async () => {
          const snapshot = !guard.snapshotEnabled
            ? null
            : await dumpBeforeWrite({
                baseUrl: deps.baseUrl,
                store: deps.store,
                ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
                ...(snapshotsDir !== undefined && { snapshotsDir }),
              });
          await createRule(body, deps);
          return snapshot;
        });
        const payloadBase = { ok: true, id, snapshot: snapshotPath } as Record<string, unknown>;
        const hints = buildNextSteps('rule.new', { id, ...opts }, opts);
        emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${id} (created: ${JSON.stringify(opts.name)})`,
        });
        printNextStepHintLine(hints, opts, { contextLabel: `rule ${id} (created)` });
      }),
    );
}
