import { NotFoundError, deleteGraph, dumpBeforeWrite, listRules } from '@eyaeya/xgg-core';
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

interface DeleteRuleOpts extends RuleOpts {
  snapshot?: boolean;
  snapshotsDir?: string;
  allowMissing?: boolean;
  refreshHint?: boolean;
  nextHint?: boolean;
}

export function attachDelete(cmd: Command): void {
  const sub = cmd
    .command('delete <id>')
    .description('Delete a rule graph (writes snapshot first)')
    .option('--no-snapshot', 'skip the pre-write dump snapshot (NOT recommended)')
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--allow-missing', 'treat "rule already gone" as success instead of NOT_FOUND error')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText(
      'after',
      '\nExample:\n  $ xgg rule delete 1748234567890 --snapshots-dir ./snapshots/',
    )
    .action(
      wrap('rule.delete', async (id: string, opts: DeleteRuleOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);
        // F28: gateway delete silently succeeds for unknown ids → look up first
        // and classify as NOT_FOUND, matching `device get` / `rule node add`.
        const rules = await listRules(deps);
        const existed = rules.some((r) => r.id === id);
        if (!existed && opts.allowMissing !== true) {
          throw new NotFoundError(`rule not found: ${id}`, { id });
        }
        // F53 (2026-05-30): when --allow-missing turns this into a no-op
        // (existed=false), skip the pre-write snapshot. dumpBeforeWrite
        // makes a full dumpAll RPC + mkdir/writeFile, and recording a
        // "before" checkpoint for an op that won't mutate state produces
        // a misleading snapshot path in the response payload (looks like
        // we deleted something).
        const snapshotPath =
          !guard.snapshotEnabled || !existed
            ? null
            : await dumpBeforeWrite({
                baseUrl: deps.baseUrl,
                store: deps.store,
                ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
                ...(snapshotsDir !== undefined && { snapshotsDir }),
              });
        if (existed) await deleteGraph(id, deps);
        const payloadBase = {
          ok: true,
          id,
          deleted: existed,
          existed,
          snapshot: snapshotPath,
        } as Record<string, unknown>;
        // Only emit hints when the destructive op actually ran; an
        // --allow-missing no-op doesn't change gateway state, so a "verify
        // the listing" prompt would be misleading.
        const hints = existed ? buildNextSteps('rule.delete', { id, ruleId: id }, opts) : [];
        emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
          pretty: opts.pretty === true,
        });
        // F63e (B10) — print only when we actually mutated; an --allow-missing
        // no-op (existed=false) didn't change gateway state, so no UI cache
        // is stale and a refresh hint would be misleading.
        if (existed) {
          printRefreshHint(opts, {
            baseUrl: deps.baseUrl,
            context: `rule ${id} (deleted)`,
          });
          printNextStepHintLine(hints, opts, { contextLabel: `rule ${id} (deleted)` });
        }
      }),
    );
}
