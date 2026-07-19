import { ConfigError, dumpBeforeWrite, upsertGraph } from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import {
  addNextHintFlag,
  buildNextSteps,
  nextHintOptedOut,
  printNextStepHintLine,
  withNextSteps,
} from '../../agent-hints.js';
import { readJsonInput } from '../../local-input.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface SetOpts extends RuleOpts {
  body: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  validate?: boolean;
  allowCfgOverwrite?: boolean;
  expectAbsent?: boolean;
  refreshHint?: boolean;
  nextHint?: boolean;
}

export function attachSet(cmd: Command): void {
  const sub = cmd
    .command('set')
    .description('Upsert a rule graph from a JSON file (writes snapshot first)')
    .requiredOption('--body <path>', 'path to JSON file containing {id, nodes, cfg}')
    .option('--no-snapshot', 'skip the pre-write dump snapshot (NOT recommended)')
    .option('--no-validate', 'skip the web-UI save-button validator (NOT recommended)')
    .option(
      '--allow-cfg-overwrite',
      "write the body's cfg (enable/uiType/userData) verbatim instead of preserving the live rule's (default: preserve, mirroring the UI save() flow)",
    )
    .option(
      '--expect-absent',
      'create-only: fail if the body rule id already exists (used by --target-id clone replay)',
    )
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText(
      'after',
      '\nExample:\n  $ xgg rule set --body rule.json --snapshots-dir ./snapshots/',
    )
    .action(
      wrap('rule.set', async (opts: SetOpts) => {
        const parsedBody = await readJsonInput<unknown>(opts.body, '--body');
        if (
          parsedBody === null ||
          typeof parsedBody !== 'object' ||
          Array.isArray(parsedBody) ||
          typeof (parsedBody as Record<string, unknown>).id !== 'string'
        ) {
          throw new ConfigError('--body file must contain a JSON object with a string id');
        }
        const body = parsedBody as Parameters<typeof upsertGraph>[0];
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
        // W-B (2026-05-29 save-flow parity): read-merge-write. Preserve the
        // live rule's enable/uiType/userData (bumping lastUpdateTime) so a
        // hand-edited / stale body can't silently disable a rule or roll its
        // timestamp backward — mirroring the UI save() flow. --allow-cfg-overwrite
        // opts into writing the body's cfg verbatim.
        const result = await upsertGraph(body, deps, {
          validate: opts.validate !== false,
          ...(opts.allowCfgOverwrite === true && { allowCfgOverwrite: true }),
          ...(opts.expectAbsent === true && { expectAbsent: true }),
        });
        if (result.cfgEnableIgnored) {
          process.stderr.write(
            `[xgg rule set] warning: body cfg.enable differs from the live rule and was ignored to avoid an accidental enable/disable. Use \`xgg rule enable ${body.id}\` / \`xgg rule disable ${body.id}\` to change it, or pass --allow-cfg-overwrite to force the body's cfg.\n`,
          );
        }
        const payloadBase = {
          ok: true,
          id: body.id,
          snapshot: snapshotPath,
          cfgPreserved: result.cfgPreserved,
        } as Record<string, unknown>;
        const hints = buildNextSteps('rule.set', { id: body.id, ruleId: body.id }, opts);
        emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${body.id} (graph upserted)`,
        });
        printNextStepHintLine(hints, opts, { contextLabel: `rule ${body.id} (set)` });
      }),
    );
}
