import {
  type AvailableVariable,
  ConfigError,
  type LintIssue,
  NotFoundError,
  editorNodeIdCompatibilityIssues,
  getDeviceSpec,
  getRule,
  listAvailVarsForRule,
  listDevices,
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
import { parseJsonInput, parsePositiveTimerMs, readJsonInput } from '../../local-input.js';
import { type TableColumn, emit, emitList } from '../../output.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface ValidateOpts extends RuleOpts {
  body?: string;
  ruleId?: string;
  stdin?: boolean;
  specAware?: boolean;
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
  return parseGraphValue(parseJsonInput(raw, source), source);
}

function parseGraphValue(parsed: unknown, source: string): GraphForValidator {
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
    .option('--body <path>', 'offline: path to JSON file with {id, nodes, cfg?}')
    .option('--rule-id <id>', 'fetch a rule from the gateway and validate it')
    .option('--stdin', 'offline: read graph JSON from stdin')
    .option(
      '--spec-aware',
      'check MIoT property access/dtype, property-write, and action input contracts; --rule-id also checks live device push availability',
    )
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

Local input contract:
  --body/--stdin perform deterministic local validation only: no session, daemon, or spec fetch.
  --spec-aware explicitly enables public MIoT registry I/O for any input mode,
  including per-card notify/read/write access plus deviceOutput property-write and action.in / props.ins contracts
  (native types, numeric domains, and variable metadata).
  --rule-id always reads the gateway graph and available variables from the daemon;
  with --spec-aware it also checks each push-source device's live pushAvailable flag.
  Offline --body/--stdin cannot prove device-instance push availability.`,
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
        // Validate every declared timer even when the selected input mode is
        // otherwise fully offline. This keeps the CLI contract independent of
        // whether --spec-aware or gateway-backed validation is enabled.
        const timeoutMs = parsePositiveTimerMs(opts.timeout, '--timeout');

        let graph: GraphForValidator;
        let listAvailVars: ((ruleId: string) => Promise<AvailableVariable[]>) | undefined;
        let getDeviceForValidation:
          | ((did: string) => Promise<{ pushAvailable: boolean }>)
          | undefined;
        if (opts.body !== undefined) {
          graph = parseGraphValue(await readJsonInput(opts.body, '--body'), opts.body);
        } else if (opts.stdin === true) {
          const raw = await readStdin();
          graph = parseGraph(raw, '<stdin>');
        } else {
          const deps = makeDeps(opts);
          const ruleResp = await getRule(opts.ruleId as string, deps);
          graph = { id: ruleResp.id, nodes: ruleResp.nodes };
          listAvailVars = (ruleId: string) => listAvailVarsForRule(ruleId, deps);
          let inventory: ReturnType<typeof listDevices> | undefined;
          getDeviceForValidation = async (did: string) => {
            inventory ??= listDevices(deps);
            const device = (await inventory)[did];
            if (device === undefined) {
              throw new NotFoundError(`device not found: ${did}`, { id: did });
            }
            return device;
          };
        }

        const issues = await validateGraph({
          graph,
          ...(listAvailVars !== undefined && { listAvailVars }),
          ...(opts.specAware === true && {
            getDeviceSpec: (urn: string) => getDeviceSpec(urn, { timeoutMs }),
          }),
          ...(opts.specAware === true &&
            getDeviceForValidation !== undefined && { getDevice: getDeviceForValidation }),
        });
        if (Array.isArray(graph.nodes)) {
          issues.push(...editorNodeIdCompatibilityIssues(graph.nodes));
        }
        const payload = {
          ok: !issues.some((i) => i.severity === 'error'),
          ruleId: graph.id,
          specAware: opts.specAware === true,
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
