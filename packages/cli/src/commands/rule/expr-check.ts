import { type ExprCheckResult, checkVarSetNumberExprString } from '@xgg/core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';

interface ExprCheckOpts {
  pretty?: boolean;
}

// Local-only: no gateway connection. Validates a varSetNumber arithmetic
// expression string against the faithful port of the gateway's `Lr.check`
// parser, so an agent can verify one expression before wiring it into a graph.
// `$id` / `$scope.id` collapse to the gateway's `$` operand, matching what
// `--expr` produces, so the verdict equals what `rule set` would give.
export function attachExprCheck(cmd: Command): void {
  cmd
    .command('expr-check <expr>')
    .description(
      'Validate a varSetNumber expression locally (no gateway) — same grammar as the web save button',
    )
    .option('--pretty', 'pretty-print: human-readable line (default: compact JSON)')
    .addHelpText(
      'after',
      [
        '',
        'Use single quotes so the shell does not expand $vars.',
        '',
        'Examples:',
        "  $ xgg rule expr-check '$global.count + 1'",
        "  $ xgg rule expr-check 'round($brightness / 655.35)'",
        "  $ xgg rule expr-check 'flor($x)'        # exit 2: 未知函数",
        '',
        'Exit codes: 0 = valid, 2 = invalid expression.',
      ].join('\n'),
    )
    .action(
      wrap('rule.expr-check', async (expr: string, opts: ExprCheckOpts) => {
        const result: ExprCheckResult = checkVarSetNumberExprString(expr);
        const payload = {
          ok: result.ok,
          input: expr,
          template: result.template,
          ...(result.ok ? {} : { kind: result.kind, message: result.message }),
        };

        if (opts.pretty) {
          if (result.ok) {
            process.stdout.write(`✓ 合法 — 表达式: "${result.template}"\n`);
          } else {
            process.stdout.write(
              `✗ 不合法 — ${result.message} [${result.kind}]（表达式: "${result.template}"）\n`,
            );
          }
        } else {
          emit(payload, { pretty: false });
        }

        process.exitCode = result.ok ? 0 : 2;
      }),
    );
}
