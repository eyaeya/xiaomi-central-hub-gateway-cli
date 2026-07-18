import {
  ConfigError,
  type LintIssue,
  checkReachability,
  getRule,
  lintGraph,
  listAvailVarsForRule,
  listDevices,
  listRules,
  validateGraph,
} from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import {
  addNextHintFlag,
  buildNextSteps,
  nextHintOptedOut,
  printNextStepHintLine,
  withNextSteps,
} from '../../agent-hints.js';
import { type TableColumn, emit, emitList } from '../../output.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface LintOpts extends RuleOpts {
  ruleId?: string;
  all?: boolean;
  strict?: boolean;
  nextHint?: boolean;
}

interface RuleLintResult {
  ruleId: string;
  issues: LintIssue[];
  summary: { errors: number; warnings: number };
}

function severityToExit(issues: LintIssue[]): number {
  if (issues.some((i) => i.severity === 'error')) return 2;
  if (issues.some((i) => i.severity === 'warn')) return 1;
  return 0;
}

function summarise(issues: LintIssue[]) {
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warn').length,
  };
}

function worstPath(issues: LintIssue[]): string {
  const first = issues.find((i) => i.severity === 'error') ?? issues[0];
  return first?.path ?? '';
}

export function attachLint(cmd: Command): void {
  const sub = cmd
    .command('lint')
    .description('Lint a rule graph (or all rules) — reports schema, edge, and reference issues')
    .option('--rule-id <id>', 'lint a single rule by id')
    .option('--all', 'lint every rule on the gateway')
    .option('--strict', 'also run the web-UI save-button validator rules')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: table view (default: compact JSON)');
  addNextHintFlag(sub)
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg rule lint --rule-id 1748234567890\n  $ xgg rule lint --all --pretty',
    )
    .action(
      wrap('rule.lint', async (opts: LintOpts) => {
        const hasRuleId = opts.ruleId !== undefined;
        const hasAll = opts.all === true;
        if (hasRuleId === hasAll) {
          throw new ConfigError('specify exactly one of --rule-id or --all');
        }

        const deps = makeDeps(opts);
        const devices = await listDevices(deps);

        if (hasRuleId) {
          const ruleId = opts.ruleId as string;
          const ruleResp = await getRule(ruleId, deps);
          const issues = lintGraph({
            graph: { id: ruleResp.id, nodes: ruleResp.nodes },
            devices,
            strict: opts.strict === true,
          });
          if (opts.strict === true) {
            issues.push(
              ...(await validateGraph({
                graph: { id: ruleResp.id, nodes: ruleResp.nodes },
                listAvailVars: (rid) => listAvailVarsForRule(rid, deps),
              })),
            );
            // F63b / GitHub #25 — the same directed reachability predicate used
            // by enable is surfaced here before authors flip the enable bit.
            if (Array.isArray(ruleResp.nodes)) {
              issues.push(...checkReachability(ruleResp.nodes));
            }
          }
          const payload = { ok: true, ruleId, issues, summary: summarise(issues) };
          const hints = buildNextSteps('rule.lint', payload, opts);
          const finalPayload = nextHintOptedOut(opts)
            ? (payload as Record<string, unknown>)
            : withNextSteps(payload as unknown as Record<string, unknown>, hints);

          if (opts.pretty) {
            const cols: TableColumn<LintIssue>[] = [
              { header: 'severity', get: (r) => r.severity },
              { header: 'path', get: (r) => r.path },
              { header: 'message', get: (r) => r.message },
            ];
            process.stdout.write(
              `rule ${ruleId}: ${payload.summary.errors} error(s), ${payload.summary.warnings} warning(s)\n`,
            );
            emitList({ jsonPayload: finalPayload, columns: cols, rows: issues }, { pretty: true });
          } else {
            emit(finalPayload, { pretty: false });
          }
          printNextStepHintLine(hints, opts, { contextLabel: `rule ${ruleId} (linted)` });
          process.exitCode = severityToExit(issues);
          return;
        }

        // --all mode
        const rules = await listRules(deps);
        const results: RuleLintResult[] = [];

        for (const rule of rules) {
          const ruleResp = await getRule(rule.id, deps);
          const issues = lintGraph({
            graph: { id: ruleResp.id, nodes: ruleResp.nodes },
            devices,
            strict: opts.strict === true,
          });
          if (opts.strict === true) {
            issues.push(
              ...(await validateGraph({
                graph: { id: ruleResp.id, nodes: ruleResp.nodes },
                listAvailVars: (rid) => listAvailVarsForRule(rid, deps),
              })),
            );
            if (Array.isArray(ruleResp.nodes)) {
              issues.push(...checkReachability(ruleResp.nodes));
            }
          }
          results.push({ ruleId: rule.id, issues, summary: summarise(issues) });
        }

        const allIssues = results.flatMap((r) => r.issues);
        const globalSummary = {
          errors: allIssues.filter((i) => i.severity === 'error').length,
          warnings: allIssues.filter((i) => i.severity === 'warn').length,
          rulesChecked: rules.length,
        };
        const payload = { ok: true, rules: results, summary: globalSummary };
        const hints = buildNextSteps('rule.lint', payload, opts);
        const finalPayload = nextHintOptedOut(opts)
          ? (payload as Record<string, unknown>)
          : withNextSteps(payload as unknown as Record<string, unknown>, hints);

        if (opts.pretty) {
          const cols: TableColumn<RuleLintResult>[] = [
            { header: 'ruleId', get: (r) => r.ruleId },
            { header: 'errors', get: (r) => String(r.summary.errors) },
            { header: 'warnings', get: (r) => String(r.summary.warnings) },
            { header: 'worstPath', get: (r) => worstPath(r.issues) },
          ];
          emitList({ jsonPayload: finalPayload, columns: cols, rows: results }, { pretty: true });
        } else {
          emit(finalPayload, { pretty: false });
        }
        printNextStepHintLine(hints, opts, {
          contextLabel: `rule lint --all (${rules.length} rules)`,
        });
        process.exitCode = severityToExit(allIssues);
      }),
    );
}
