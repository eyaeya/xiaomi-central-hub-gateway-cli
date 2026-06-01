import {
  ConfigError,
  type FilterRuleLogsOpts,
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
  json?: boolean;
  nextHint?: boolean;
}

const DEFAULT_TAIL = 50;
const DEFAULT_FOLLOW_INTERVAL_MS = 2000;

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
    .option('--json', 'emit raw parsed JSON array instead of the table')
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

Note: this shows the gateway's RAW log rows, best-effort parsed and filtered only
by rule id / time / level. It deliberately does NOT replicate the web UI's log
VIEW, which additionally filters rows by node connection type, renders per-node
Chinese info, and silently drops rows it cannot strictly parse. The raw payload
is more useful for debugging a rule; expect richer/looser output than the web log panel.`,
    )
    .action(
      wrap('rule.logs', async (id: string, opts: LogsOpts) => {
        const filterOpts = buildFilter(id, opts);
        const maxBlocks =
          opts.maxBlocks !== undefined
            ? parseIntOrThrow(opts.maxBlocks, '--max-blocks')
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

        const intervalMs =
          opts.intervalMs !== undefined
            ? parseIntOrThrow(opts.intervalMs, '--interval-ms')
            : DEFAULT_FOLLOW_INTERVAL_MS;
        await followLoop(fetchDeps, filterOpts, opts, intervalMs);
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

function parseIntOrThrow(raw: string, flag: string): number {
  // Accept canonical nonnegative decimals only: 0 or [1-9][0-9]*.
  // Rejects '+5', '-5', '007', '1.0', '1e3', '0x10', ' 5 ', ''.
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new ConfigError(`${flag} must be a nonnegative decimal integer (got '${raw}')`);
  }
  const n = Number(raw);
  if (n > MAX_TAIL) {
    throw new ConfigError(`${flag} must be <= ${MAX_TAIL} (got '${raw}')`);
  }
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
): Promise<void> {
  const seenRaw = new Set<string>();
  // Initial dump: print whatever's already there matching the filter so the
  // user has context, then mark every line we showed as "seen" so the next
  // tick only renders new arrivals.
  const initial = await fetchRuleLogs(fetchDeps);
  const initialFiltered = filterRuleLogs(initial.entries, filterOpts);
  render(initialFiltered, opts);
  for (const e of initial.entries) seenRaw.add(e.raw);

  // sleep helper kept terse — no extra deps.
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // Loop until SIGINT — Ctrl-C ends the process and the daemon stays.
  // We intentionally do not signal an exit code from a follower; users
  // expect tail-like semantics.
  while (true) {
    await sleep(intervalMs);
    let next: Awaited<ReturnType<typeof fetchRuleLogs>>;
    try {
      next = await fetchRuleLogs(fetchDeps);
    } catch (err) {
      process.stderr.write(`(follow: fetch failed — ${(err as Error).message}; retrying)\n`);
      continue;
    }
    const fresh = next.entries.filter((e) => !seenRaw.has(e.raw));
    for (const e of fresh) seenRaw.add(e.raw);
    // In follow mode we never tail — every fresh entry that matches is
    // worth showing as it arrives. Rebuild the filter without `tail`
    // (biome lint forbids `delete` on object properties).
    const { tail: _tail, ...noTailFilter } = filterOpts;
    void _tail;
    const matched = filterRuleLogs(fresh, noTailFilter);
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
  }
}
