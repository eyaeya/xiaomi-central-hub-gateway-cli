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
  // Use in CI / agent-funnel paths where the script must not carry any
  // warning that signals a semantic round-trip loss.
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
      'clone under a new id; replay fails instead of overwriting an existing target rule',
    )
    .option(
      '--target-name <NAME>',
      "override the replayed/cloned rule's userData.name (default: '[Cloned] <original>' when --target-id is set, source name otherwise)",
    )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output (only with --format json)')
    .option(
      '--strict-roundtrip',
      'fail on modeled-node warnings that signal semantic loss (cfg/spec mapping/operand); unmodeled opaque cards remain allowed for lossless same-id replay, while --target-id clone rejects them',
    );
  addNextHintFlag(sub)
    .addHelpText(
      'after',
      `
Examples:
  $ xgg rule export 1779888258312 > replay.sh
      # Render for review. After variable preflight/preparation, its first
      # target-graph write stages an empty shell with enable=false.

  $ xgg rule export 1779888258312 --format json --pretty
      # Emits the structured ExportedRule (commands array) as JSON for
      # programmatic consumption (e.g. AI agents that want to learn
      # from existing user-built rules).

  $ XGG="pnpm exec tsx packages/cli/src/cli.ts" BASE_URL="http://192.168.x.x:8086" \\
      SNAPSHOTS_DIR="./snapshots" bash replay.sh
      # Review first; execution env belongs on bash, not the render command.

  $ xgg rule export 1779888258312 --target-id 9999999999999
      # Clone the rule under a new id; name becomes "[Cloned] <orig>".
      # R1779888258312 local-variable references become R9999999999999;
      # referenced local variables are preflighted read-only, then prepared
      # only after the create-only target rule succeeds.

  $ xgg rule export 1779888258312 --target-id 9999999999999 \\
        --target-name "按钮播报-备份"
      # Clone with an explicit name.

Limitations:
  - Same-id replay is deliberately destructive: its first guarded graph write
    replaces the target cfg/body with the exported empty shell and enable=false.
    Nodes and edges are then rebuilt while disabled; an enabled export appends
    rule enable only after assembly. The script uses separate CLI transactions,
    not one replay-wide lease: do not concurrently modify the target from the
    web canvas, another xgg process, or an API client. A failure after the
    staging graph write leaves a disabled partial graph; use the emitted
    rollback snapshots to inspect or restore it.
  - --strict-roundtrip rejects modeled-node warnings that would change or omit
    graph semantics, including stale spec mappings, unsupported operands and
    unknown modeled cfg/props keys. Unmodeled future cards are preserved as
    opaque raw nodes and remain valid in strict mode for lossless same-id
    replay; --target-id cloning still rejects them because unknown payloads
    cannot be remapped safely. Permissive export surfaces warnings on stderr/JSON.
  - varSetNumber / varSetString elements must be losslessly expressible in
    the current --expr DSL. Export fails before returning a script when a
    variable/constant boundary would be absorbed or rejected; add an explicit
    separator in the source expression or use rule view JSON round-trip.
  - Rule-local variables are captured with their current value and display
    name. Every replay first preflights the complete variable plan read-only.
    Same-id then prepares captured variables with compatibility guards before
    its first target-graph write. A --target-id clone instead writes the
    disabled empty target with create-only/expect-absent semantics before any
    variable write, then prepares the remapped R<target-id> variables. Thus an
    existing clone target, including one which appears during preflight, aborts
    without changing its graph or variables. Each variable create repeats its
    compatibility check. The gateway has no cross-variable transaction, so a
    concurrent variable change can still stop replay; per-write snapshots are
    the recovery path.
    --target-id must differ from the source id.
  - global variables are explicit external dependencies: export lists them in
    JSON/warnings but never creates or modifies them. Any non-global scope
    other than R<source-id> is rejected instead of guessed.
  - All five modeled device-backed node families (deviceInput, deviceGet,
    deviceOutput, deviceInputSetVar, deviceGetSetVar) require the source gateway
    to expose the referenced DID/spec so ids can be reversed to typed names.
  - All modeled flow / logic / timing / variable node types (including
    eventSequence, register, modeSwitch, signalOr, logicAnd/Or/Not, condition,
    counter, onlyNTimes, loop, delay, statusLast), plus the non-executable
    \`nop\` Quill note, DO have c-shortcut equivalents and round-trip as
    \`rule node add\` commands. Genuinely unknown future node types are retained
    as complete opaque \`rule node add --cfg '<JSON>'\` fallbacks, with their
    edges restored after every endpoint exists. Same-id replay is lossless;
    \`--target-id\` cloning is rejected for opaque nodes because their unknown
    payload may contain rule-local references that cannot be remapped safely.`,
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
