import { exportRule, renderExportedAsShell } from '@eyaeya/xgg-core';
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
import { type RuleOpts, makeDeps } from './_deps.js';

interface ExportOpts extends RuleOpts {
  format?: string;
  targetId?: string;
  targetName?: string;
  // F54 (2026-05-30) — turn unknown-cfg-key warnings into hard errors.
  // Use in CI / agent-funnel paths where the script must round-trip
  // byte-identically (no silent UI-only fields dropped).
  strictRoundtrip?: boolean;
  nextHint?: boolean;
}

export function attachExport(cmd: Command): void {
  const sub = cmd
    .command('export <id>')
    .description(
      'Reverse-translate a rule into the `xgg` CLI command sequence that recreates it (round-trip with `rule node add` c-shortcuts)',
    )
    .option('--format <fmt>', 'output format: shell (default) | json', 'shell')
    .option(
      '--target-id <ID>',
      'clone the rule under a new id (script will recreate a new rule, not overwrite the source)',
    )
    .option(
      '--target-name <NAME>',
      "override the cloned rule's userData.name (default: '[Cloned] <original>' when --target-id is set, unchanged otherwise)",
    )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output (only with --format json)')
    .option(
      '--strict-roundtrip',
      'fail (instead of warn) if any node carries a cfg key the exporter would drop on round-trip (F54). Use in CI / agent-funnel paths.',
    );
  addNextHintFlag(sub)
    .addHelpText(
      'after',
      `
Examples:
  $ xgg rule export 1779888258312
      # Emits a runnable bash script on stdout. The script preserves
      # the original node ids via --id flags and re-enables the rule
      # if the source was enabled.

  $ xgg rule export 1779888258312 --format json --pretty
      # Emits the structured ExportedRule (commands array) as JSON for
      # programmatic consumption (e.g. AI agents that want to learn
      # from existing user-built rules).

  $ XGG="pnpm exec tsx packages/cli/src/cli.ts" BASE_URL="http://192.168.x.x:8086" \\
      bash <(xgg rule export 1779888258312)
      # End-to-end replay against a different gateway / dev worktree.

  $ xgg rule export 1779888258312 --target-id 9999999999999
      # Clone the rule under a new id; name becomes "[Cloned] <orig>".

  $ xgg rule export 1779888258312 --target-id 9999999999999 \\
        --target-name "按钮播报-备份"
      # Clone with an explicit name.

Limitations:
  - deviceInput / deviceOutput nodes require the source gateway to be
    online so the spec for the referenced device can be fetched (used
    to reverse siid+piid into property/action/event names).
  - All modeled flow / logic / timing / variable node types (including
    eventSequence, register, modeSwitch, signalOr, logicAnd/Or/Not, condition,
    counter, onlyNTimes, loop, delay, statusLast) DO have c-shortcut
    equivalents and round-trip as \`rule node add\` commands. Only genuinely
    unknown / not-yet-modeled node types (e.g. nop, or a future card the
    exporter has not learned) emit a # WARNING comment; recreate those by hand
    with \`rule node add --cfg '<JSON>'\`.`,
    )
    .action(
      wrap('rule.export', async (id: string, opts: ExportOpts) => {
        const format = opts.format ?? 'shell';
        if (format !== 'shell' && format !== 'json') {
          throw new Error(`--format must be 'shell' or 'json', got '${format}'`);
        }
        const deps = makeDeps(opts);
        const rename: { targetId?: string; targetName?: string } = {};
        if (opts.targetId !== undefined) rename.targetId = opts.targetId;
        if (opts.targetName !== undefined) rename.targetName = opts.targetName;
        const exported = await exportRule({
          baseUrl: deps.baseUrl,
          store: deps.store,
          ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
          ruleId: id,
          ...(Object.keys(rename).length > 0 && { rename }),
          ...(opts.strictRoundtrip === true && { strictRoundtrip: true }),
        });
        const hints = buildNextSteps('rule.export', { id, ruleId: id }, opts);

        if (format === 'json') {
          const payloadBase = { ok: true, ...exported } as Record<string, unknown>;
          emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
            pretty: opts.pretty === true,
          });
          printNextStepHintLine(hints, opts, { contextLabel: `rule ${id} (exported)` });
          return;
        }

        const script = renderExportedAsShell(exported, {
          ...(deps.baseUrl && { baseUrl: deps.baseUrl }),
        });
        // Surface warnings on stderr so they don't pollute the script body
        // that piping to `bash` would execute.
        for (const w of exported.warnings) {
          process.stderr.write(`# WARNING (xgg rule export): ${w}\n`);
        }
        process.stdout.write(script);
        // Shell-format has no JSON envelope to carry nextSteps; the stderr
        // note: channel still fires (it doesn't pollute the script body
        // piped to bash).
        printNextStepHintLine(hints, opts, { contextLabel: `rule ${id} (exported)` });
      }),
    );
}
