import {
  ConfigError,
  type FilterRuleLogsOpts,
  NetworkError,
  type RuleLogEntry,
  fetchRuleLogs,
  filterRuleLogs,
  parseTimestamp,
} from '@eyaeya/xgg-core';
import Table from 'cli-table3';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import {
  addNextHintFlag,
  buildNextSteps,
  nextHintOptedOut,
  printNextStepHintLine,
  withNextSteps,
} from '../../agent-hints.js';
import { parsePositiveTimerMs } from '../../local-input.js';
import { emit } from '../../output.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface LogsOpts extends RuleOpts {
  tail?: string;
  since?: string;
  until?: string;
  level?: string;
  follow?: boolean;
  intervalMs?: string;
  maxBlocks?: string;
  maxEvents?: string;
  durationMs?: string;
  json?: boolean;
  nextHint?: boolean;
}

const DEFAULT_TAIL = 50;
const DEFAULT_FOLLOW_INTERVAL_MS = 2000;
const MAX_NETWORK_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;

export function attachLogs(cmd: Command): void {
  const sub = cmd
    .command('logs <id>')
    .description(
      "Read a rule's runtime log entries (gateway /api/getLog, client-side filtered by rule id and time range)",
    )
    .option('--tail <N>', `keep last N entries after filters (default ${DEFAULT_TAIL})`)
    .option('--since <ts>', 'lower bound — epoch ms or ISO-8601')
    .option('--until <ts>', 'upper bound — epoch ms or ISO-8601')
    .option('--level <level>', 'filter by level: info | error')
    .option('--follow', 'poll for new entries and stream them as they arrive')
    .option(
      '--interval-ms <N>',
      `polling interval for --follow (default ${DEFAULT_FOLLOW_INTERVAL_MS})`,
    )
    .option('--max-blocks <N>', 'max getLog blocks to fetch per poll (default 8)')
    .option(
      '--max-events <N>',
      'stop after N new entries, excluding initial dump (0: initial dump only)',
    )
    .option(
      '--duration-ms <N>',
      'stop starting --follow polls after N ms; in-flight reads use --timeout',
    )
    .option(
      '--json',
      'emit one JSON envelope; --follow then emits each new entry as one NDJSON line',
    )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'render with extra colors / wider columns');
  addNextHintFlag(sub)
    .addHelpText(
      'after',
      `
Examples:
  $ xgg rule logs 1779888258312
  $ xgg rule logs 1779888258312 --tail 10 --level error --json
  $ xgg rule logs 1779888258312 --since 2026-05-27T12:00:00Z
  $ xgg rule logs 1779888258312 --follow --interval-ms 1500
  $ xgg rule logs 1779888258312 --follow --json --duration-ms 30000 --max-events 20

Note: this shows successfully parsed entries from a bounded gateway log fetch,
then filters by rule id / time / level and applies --tail. It does not expose
unparsed rows, cursor wrap, or scan completeness, and is bounded by --max-blocks,
gateway retention, and the tail limit. Empty output alone does not prove that a
rule never triggered. The web UI applies its own filtering and rendering, so the
two views need not match row for row. With --follow --json, the first line is the
initial envelope and each later line is one newly observed entry.`,
    )
    .action(
      wrap('rule.logs', async (id: string, opts: LogsOpts) => {
        if (
          opts.follow !== true &&
          (opts.intervalMs !== undefined ||
            opts.maxEvents !== undefined ||
            opts.durationMs !== undefined)
        ) {
          throw new ConfigError('--interval-ms / --max-events / --duration-ms require --follow');
        }
        const filterOpts = buildFilter(id, opts);
        const maxBlocks =
          opts.maxBlocks !== undefined
            ? parsePositiveIntOrThrow(opts.maxBlocks, '--max-blocks')
            : undefined;
        const intervalMs =
          opts.intervalMs !== undefined
            ? parsePositiveTimerMs(opts.intervalMs, '--interval-ms')
            : DEFAULT_FOLLOW_INTERVAL_MS;
        const maxEvents =
          opts.maxEvents !== undefined
            ? parseIntOrThrow(opts.maxEvents, '--max-events')
            : undefined;
        const durationMs =
          opts.durationMs !== undefined
            ? parsePositiveTimerMs(opts.durationMs, '--duration-ms')
            : undefined;
        const deps = makeDeps(opts);
        const fetchDeps = {
          baseUrl: deps.baseUrl,
          store: deps.store,
          ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
          ...(maxBlocks !== undefined && { maxBlocks }),
        };

        if (opts.follow !== true) {
          const block = await fetchRuleLogs(fetchDeps);
          const filtered = filterRuleLogs(block.entries, filterOpts);
          // Build hints before render — render owns stdout emission and
          // needs to know whether to attach nextSteps to the JSON envelope.
          const hintResult = { ruleId: id, entries: filtered };
          const hints = buildNextSteps('rule.logs', hintResult, opts);
          render(filtered, opts, hints);
          printNextStepHintLine(hints, opts, { contextLabel: `rule ${id} (logs)` });
          return;
        }

        await followLoop(fetchDeps, filterOpts, opts, intervalMs, maxEvents, durationMs);
      }),
    );
}

function buildFilter(id: string, opts: LogsOpts): FilterRuleLogsOpts {
  const level = opts.level;
  if (level !== undefined && level !== 'info' && level !== 'error') {
    throw new ConfigError(`--level must be 'info' or 'error' (got '${level}')`);
  }
  let sinceMs: number | undefined;
  let untilMs: number | undefined;
  try {
    sinceMs = parseTimestamp(opts.since);
    untilMs = parseTimestamp(opts.until);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const tail = opts.tail !== undefined ? parseIntOrThrow(opts.tail, '--tail') : DEFAULT_TAIL;
  const filter: FilterRuleLogsOpts = {
    ruleId: id,
    tail,
    ...(sinceMs !== undefined && { sinceMs }),
    ...(untilMs !== undefined && { untilMs }),
    ...(level === 'info' || level === 'error' ? { level } : {}),
  };
  return filter;
}

// F53 (2026-05-30) — strict decimal-digit guard. Pre-F53 `Number(raw)`
// silently accepted '1e3' (= 1000), '0x10' (= 16), leading/trailing
// whitespace (' 5 ' → 5), and the empty string ('' → 0). None of those
// match what a user types on the CLI when they mean "a count", and the
// exponent/hex forms in particular invite painful guess-the-value bugs.
// Also clamp at MAX_TAIL — a million-entry tail starves the renderer
// and the daemon-proxy buffer; the help text promises "keep last N
// entries", which doesn't need to mean "all of memory".
const MAX_TAIL = 100_000;

function parseIntOrThrow(raw: string, flag: string, maximum = MAX_TAIL): number {
  // Accept canonical nonnegative decimals only: 0 or [1-9][0-9]*.
  // Rejects '+5', '-5', '007', '1.0', '1e3', '0x10', ' 5 ', ''.
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new ConfigError(`${flag} must be a nonnegative decimal integer (got '${raw}')`);
  }
  const n = Number(raw);
  if (n > maximum) {
    throw new ConfigError(`${flag} must be <= ${maximum} (got '${raw}')`);
  }
  return n;
}

function parsePositiveIntOrThrow(raw: string, flag: string, maximum = MAX_TAIL): number {
  const n = parseIntOrThrow(raw, flag, maximum);
  if (n === 0) throw new ConfigError(`${flag} must be positive (got '${raw}')`);
  return n;
}

function render(
  entries: RuleLogEntry[],
  opts: LogsOpts,
  hints: ReturnType<typeof buildNextSteps> = [],
): void {
  if (opts.json === true) {
    const base: Record<string, unknown> = { ok: true, count: entries.length, entries };
    const payload = nextHintOptedOut(opts) ? base : withNextSteps(base, hints);
    emit(payload, { pretty: false });
    return;
  }
  if (entries.length === 0) {
    process.stdout.write('(no log entries match the filter)\n');
    return;
  }
  const tableOpts: ConstructorParameters<typeof Table>[0] = {
    head: ['timestamp', 'level', 'node', 'message'],
    style: { head: [], border: [] },
    wordWrap: true,
  };
  if (opts.pretty === true) tableOpts.colWidths = [25, 7, 18, 70];
  const table = new Table(tableOpts);
  for (const e of entries) {
    table.push([e.iso, e.level, e.nodeId ?? '-', e.message]);
  }
  process.stdout.write(`${table.toString()}\n`);
}

async function followLoop(
  fetchDeps: Parameters<typeof fetchRuleLogs>[0],
  filterOpts: ReturnType<typeof buildFilter>,
  opts: LogsOpts,
  intervalMs: number,
  maxEvents: number | undefined,
  durationMs: number | undefined,
): Promise<void> {
  const seenRaw = new Set<string>();
  const deadline = durationMs === undefined ? undefined : Date.now() + durationMs;
  let initial = true;
  let emitted = 0;
  let delayMs = 0;
  let consecutiveFailures = 0;
  let lastNetworkError: NetworkError | undefined;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const { tail: _tail, ...noTailFilter } = filterOpts;
  void _tail;

  // An explicit duration bounds scheduling, not cancellation: the gateway's
  // paged read API has a timeout per RPC but no cancellation signal.
  while (true) {
    if (delayMs > 0) {
      const remaining = deadline === undefined ? delayMs : Math.max(0, deadline - Date.now());
      await sleep(Math.min(delayMs, remaining));
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      // A window ending during an outage is a failed observation, not evidence
      // that nothing happened. Preserve the last typed error for the outer wrap.
      if (lastNetworkError !== undefined) throw lastNetworkError;
      return;
    }
    let next: Awaited<ReturnType<typeof fetchRuleLogs>>;
    try {
      next = await fetchRuleLogs(fetchDeps);
    } catch (err) {
      // Auth/schema/config/service/unknown errors need intervention. Only
      // transient network reads can be retried, with a bounded failure streak.
      if (!(err instanceof NetworkError)) throw err;
      consecutiveFailures += 1;
      if (consecutiveFailures > MAX_NETWORK_RETRIES) {
        process.stderr.write('(follow: network retry limit reached; stopping)\n');
        throw err;
      }
      lastNetworkError = err;
      delayMs = Math.min(
        Math.max(intervalMs, 250) * 2 ** (consecutiveFailures - 1),
        MAX_RETRY_DELAY_MS,
      );
      process.stderr.write(
        `(follow: network read failed; retry ${consecutiveFailures}/${MAX_NETWORK_RETRIES} in ${delayMs}ms)\n`,
      );
      continue;
    }
    consecutiveFailures = 0;
    lastNetworkError = undefined;
    delayMs = intervalMs;
    if (initial) {
      render(filterRuleLogs(next.entries, filterOpts), opts);
      for (const e of next.entries) seenRaw.add(e.raw);
      initial = false;
      if (maxEvents === 0) return;
      continue;
    }
    const fresh = next.entries.filter((e) => !seenRaw.has(e.raw));
    for (const e of fresh) seenRaw.add(e.raw);
    const filtered = filterRuleLogs(fresh, noTailFilter);
    const matched = maxEvents === undefined ? filtered : filtered.slice(0, maxEvents - emitted);
    if (matched.length === 0) continue;
    if (opts.json === true) {
      for (const e of matched) process.stdout.write(`${JSON.stringify(e)}\n`);
    } else {
      const table = new Table({
        head: ['timestamp', 'level', 'node', 'message'],
        style: { head: [], border: [] },
        wordWrap: true,
      });
      for (const e of matched) table.push([e.iso, e.level, e.nodeId ?? '-', e.message]);
      process.stdout.write(`${table.toString()}\n`);
    }
    emitted += matched.length;
    if (maxEvents !== undefined && emitted >= maxEvents) return;
  }
}
