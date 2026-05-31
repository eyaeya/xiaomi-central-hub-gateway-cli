import { readFile } from 'node:fs/promises';
import {
  ConfigError,
  type LintIssue,
  getRule,
  listAvailVarsForRule,
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

interface ValidateOpts extends RuleOpts {
  body?: string;
  ruleId?: string;
  stdin?: boolean;
  nextHint?: boolean;
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface GraphForValidator {
  id: string;
  cfg?: { id?: string; enable?: boolean };
  nodes?: unknown[];
}

function parseGraph(raw: string, source: string): GraphForValidator {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(
      `${source}: failed to parse JSON — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${source}: expected a JSON object with at least { id, nodes }`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string') {
    throw new ConfigError(`${source}: missing required string field "id"`);
  }
  return parsed as unknown as GraphForValidator;
}

export function attachValidate(cmd: Command): void {
  const sub = cmd
    .command('validate')
    .description(
      'Dry-run the web-UI save-button validator against a graph (read-only, no setGraph)',
    )
    .option('--body <path>', 'path to JSON file with {id, nodes, cfg?}')
    .option('--rule-id <id>', 'fetch a rule from the gateway and validate it')
    .option('--stdin', 'read graph JSON from stdin')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: table view (default: compact JSON)');
  addNextHintFlag(sub)
    .addHelpText(
      'after',
      `
Examples:
  $ xgg rule validate --body candidate.json --pretty
  $ xgg rule validate --rule-id 1748234567890
  $ jq '.' graph.json | xgg rule validate --stdin

Exit codes:
  0  no issues
  1  warnings only
  2  at least one error

Note: spec-aware bool dtype check requires daemon access (--rule-id always; --body/--stdin opportunistically). With no daemon, structural checks still run.`,
    )
    .action(
      wrap('rule.validate', async (opts: ValidateOpts) => {
        const inputModes = [
          opts.body !== undefined,
          opts.ruleId !== undefined,
          opts.stdin === true,
        ];
        const inputCount = inputModes.filter(Boolean).length;
        if (inputCount === 0) {
          throw new ConfigError('specify exactly one of --body, --rule-id, or --stdin');
        }
        if (inputCount > 1) {
          throw new ConfigError('--body, --rule-id, and --stdin are mutually exclusive');
        }

        let graph: GraphForValidator;
        let listAvailVars: ((ruleId: string) => Promise<string[]>) | undefined;
        if (opts.body !== undefined) {
          const raw = await readFile(opts.body, 'utf8');
          graph = parseGraph(raw, opts.body);
          // F23: opportunistic — if daemon is up, fetch the avail-vars list
          // so 卡片变量丢失 / 卡片变量有误 surface for --body mode too.
          // F47 (2026-05-30): narrow the swallow to the "no base-url" path
          // that makeDeps throws (ConfigError). Anything else (e.g. a
          // unexpected runtime error inside makeDeps) should surface so
          // the user knows why the var-existence check silently dropped.
          try {
            const deps = makeDeps(opts);
            listAvailVars = (ruleId: string) => listAvailVarsForRule(ruleId, deps);
          } catch (e) {
            if (!(e instanceof ConfigError)) throw e;
            // No daemon / no base-url → skip var-existence check
            // (validateGraph degrades; user can still validate shape).
          }
        } else if (opts.stdin === true) {
          const raw = await readStdin();
          graph = parseGraph(raw, '<stdin>');
          try {
            const deps = makeDeps(opts);
            listAvailVars = (ruleId: string) => listAvailVarsForRule(ruleId, deps);
          } catch (e) {
            if (!(e instanceof ConfigError)) throw e;
            // No daemon / no base-url → skip var-existence check.
          }
        } else {
          const deps = makeDeps(opts);
          const ruleResp = await getRule(opts.ruleId as string, deps);
          graph = { id: ruleResp.id, nodes: ruleResp.nodes };
          listAvailVars = (ruleId: string) => listAvailVarsForRule(ruleId, deps);
        }

        const issues = await validateGraph({
          graph,
          ...(listAvailVars !== undefined && { listAvailVars }),
        });
        const payload = {
          ok: !issues.some((i) => i.severity === 'error'),
          ruleId: graph.id,
          issues,
          summary: summarise(issues),
        };
        const hints = buildNextSteps('rule.validate', payload, opts);
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
            `rule ${graph.id}: ${payload.summary.errors} error(s), ${payload.summary.warnings} warning(s)\n`,
          );
          emitList({ jsonPayload: finalPayload, columns: cols, rows: issues }, { pretty: true });
        } else {
          emit(finalPayload, { pretty: false });
        }
        printNextStepHintLine(hints, opts, { contextLabel: `rule ${graph.id} (validated)` });
        process.exitCode = severityToExit(issues);
      }),
    );
}
