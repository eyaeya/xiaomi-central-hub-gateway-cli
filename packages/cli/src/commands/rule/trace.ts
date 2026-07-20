import {
  ConfigError,
  type RuleTraceFrame,
  buildRuleTraceWatchpoints,
  calculateRuleTrace,
  fetchRuleLogs,
  findNextRuleTraceWatchpoint,
  parseTimestamp,
  resolveRuleTraceDeviceGetLabels,
  ruleTraceLinkWatchpointId,
  ruleTraceNodeWatchpointId,
  viewRule,
} from '@eyaeya/xgg-core';
import Table from 'cli-table3';
import type { Command, OptionValues } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import { type RuleOpts, makeDeps } from './_deps.js';

interface TraceOpts extends RuleOpts {
  since?: string;
  until?: string;
  startStep?: string;
  endStep?: string;
  maxSteps?: string;
  maxBlocks?: string;
  node: string[];
  edge: string[];
  watch: string[];
  nextFrom?: string;
}

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_MAX_BLOCKS = 8;
const MAX_COUNT = 100_000;

export function attachTrace(cmd: Command): void {
  cmd
    .command('trace <id>')
    .description(
      'Reconstruct client-derived cumulative rule frames from the current graph and bounded logs',
    )
    .option('--since <ts>', 'inclusive frame-time lower bound (epoch ms or ISO-8601)')
    .option('--until <ts>', 'inclusive frame-time upper bound (epoch ms or ISO-8601)')
    .option('--start-step <N>', 'inclusive absolute calculator step')
    .option('--end-step <N>', 'inclusive absolute calculator step')
    .option(
      '--max-steps <N>',
      `return at most the newest N selected frames (default ${DEFAULT_MAX_STEPS})`,
    )
    .option('--max-blocks <N>', `max getLog blocks to fetch (default ${DEFAULT_MAX_BLOCKS})`)
    .option('--node <id>', 'trace one current-graph node watchpoint (repeatable)', collect, [])
    .option(
      '--edge <src.pin->dst.pin>',
      'trace one current-graph edge watchpoint (repeatable)',
      collect,
      [],
    )
    .option(
      '--watch <id>',
      'trace an exact Bundle watchpoint id: node:<id> or link:<src>-><dst> (repeatable)',
      collect,
      [],
    )
    .option('--next-from <N>', 'also return the next selected watchpoint change at/after step N')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'render a compact human timeline instead of stable JSON')
    .addHelpText(
      'after',
      `
Examples:
  $ xgg rule trace 1779888258312
  $ xgg rule trace 1779888258312 --node n-condition --node n-action --pretty
  $ xgg rule trace 1779888258312 --edge 'n-loop.output->n-loop.stop' --since 2026-07-20T00:00:00Z
  $ xgg rule trace 1779888258312 --watch 'node:n-action' --next-from 10

Boundary: this is a client-derived projection of bounded retained log blocks onto
the current rule graph. It is not a gateway execution RPC, real-time device truth,
or proof that an execution is complete. JSON always includes pagination, parse,
selection, and current-graph/topology-drift metadata.`,
    )
    .action(
      wrap('rule.trace', async (id: string, rawOpts: OptionValues) => {
        const opts = rawOpts as TraceOpts;
        const maxBlocks = parseCount(opts.maxBlocks ?? String(DEFAULT_MAX_BLOCKS), '--max-blocks');
        if (maxBlocks === 0) throw new ConfigError('--max-blocks must be at least 1');
        const maxSteps = parseCount(opts.maxSteps ?? String(DEFAULT_MAX_STEPS), '--max-steps');
        const startStep = parseOptionalCount(opts.startStep, '--start-step');
        const endStep = parseOptionalCount(opts.endStep, '--end-step');
        const nextFrom = parseOptionalCount(opts.nextFrom, '--next-from');
        if (startStep !== undefined && endStep !== undefined && endStep < startStep) {
          throw new ConfigError('--end-step must be greater than or equal to --start-step');
        }
        const { sinceMs, untilMs } = parseTimeBounds(opts);
        const deps = makeDeps(opts);

        // Snapshot the current graph first. The trace reports that historical
        // logs may have been emitted by older topology rather than hiding drift.
        const view = await viewRule(id, deps);
        const available = buildRuleTraceWatchpoints(view.nodes);
        const requested = requestedWatchpoints(opts);
        const filter = requested.length === 0 ? undefined : requested;
        if (filter !== undefined)
          assertKnownWatchpoints(
            filter,
            available.map((entry) => entry.id),
          );

        const fetched = await fetchRuleLogs({
          baseUrl: deps.baseUrl,
          store: deps.store,
          timeoutMs: deps.timeoutMs,
          maxBlocks,
        });
        const observedInfoNodeIds = new Set(
          fetched.entries
            .filter((entry) => entry.graphId === id && entry.rawType === 'i')
            .map((entry) => entry.nodeId),
        );
        const deviceGetLabels = await resolveRuleTraceDeviceGetLabels(
          view.nodes.filter((node) => observedInfoNodeIds.has(node.id)),
        );
        const calculation = calculateRuleTrace({
          ruleId: id,
          nodes: view.nodes,
          entries: fetched.entries,
          deviceGetLabels: deviceGetLabels.labelsByNodeId,
          ...(filter !== undefined && { filter }),
        });
        const selected = selectFrames(calculation.frames, {
          maxSteps,
          ...(sinceMs !== undefined && { sinceMs }),
          ...(untilMs !== undefined && { untilMs }),
          ...(startStep !== undefined && { startStep }),
          ...(endStep !== undefined && { endStep }),
        });
        const navigation =
          nextFrom === undefined
            ? undefined
            : (findNextRuleTraceWatchpoint(
                calculation.frames,
                nextFrom,
                calculation.selectedWatchpoints,
              ) ?? null);
        const reasonCodes = completenessReasons(
          fetched,
          calculation.topologyDrift.entryCount,
          calculation.semanticDrift.entryCount,
          deviceGetLabels.specLookup.failureCount,
        );
        const payload = {
          ok: true,
          traceVersion: 1,
          ruleId: id,
          graph: {
            source: 'current-rule-graph' as const,
            nodeCount: view.nodes.length,
            edgeCount: available.filter((entry) => entry.type === 'link').length,
            historicalTopologyMayDiffer: true,
          },
          watchpoints: {
            available,
            selected: calculation.selectedWatchpoints,
          },
          totalSteps: calculation.frames.length,
          count: selected.frames.length,
          frames: selected.frames,
          ...(navigation !== undefined && { navigation: { from: nextFrom, next: navigation } }),
          completeness: {
            complete: false,
            provesCompleteExecution: false,
            reasonCodes,
            boundary:
              'client-derived projection of bounded retained logs onto the current graph; not real-time device truth',
            fetch: {
              blocksRead: fetched.blocksRead,
              maxBlocks: fetched.maxBlocks,
              stopReason: fetched.stopReason,
              cursorWrapped: fetched.cursorWrapped,
              reachedExplicitEnd: fetched.stopReason === 'empty-block',
              boundedByMaxBlocks: fetched.stopReason === 'max-blocks',
            },
            parse: {
              parsedEntries: fetched.entries.length,
              matchingRuleEntries: calculation.matchingLogEntries,
              unparsedLineCount: fetched.unparsed.length,
              rawUnparsedLinesExposed: false,
            },
            selection: selected.metadata,
            topology: {
              boundary: 'current-graph-watchpoints-only' as const,
              driftEntryCount: calculation.topologyDrift.entryCount,
              missingWatchpointEntryCount: calculation.topologyDrift.missingWatchpointEntryCount,
              incompatibleLinkEntryCount: calculation.topologyDrift.incompatibleLinkEntryCount,
              driftWatchpoints: calculation.topologyDrift.watchpoints,
            },
            semantic: {
              boundary:
                'Bundle getInfo/pin projection; deviceGet uses notify-property instance value-list then built-in bool labels; device multiLanguage/catalog normalization is not reproduced' as const,
              driftEntryCount: calculation.semanticDrift.entryCount,
              nodeInfoParseFailureCount: calculation.semanticDrift.nodeInfoParseFailureCount,
              incompatibleLinkEntryCount: calculation.semanticDrift.incompatibleLinkEntryCount,
              driftWatchpoints: calculation.semanticDrift.watchpoints,
              specLookup: deviceGetLabels.specLookup,
            },
          },
        };

        if (opts.pretty === true) renderHuman(payload);
        else emit(payload, { pretty: false });
      }),
    );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function requestedWatchpoints(opts: TraceOpts): string[] {
  const result = [
    ...opts.node.map(ruleTraceNodeWatchpointId),
    ...opts.edge.map((edge) => normalizeEdge(edge)),
    ...opts.watch,
  ];
  return [...new Set(result)];
}

function normalizeEdge(edge: string): string {
  const split = edge.split('->');
  if (split.length !== 2 || split[0]?.includes('.') !== true || split[1]?.includes('.') !== true) {
    throw new ConfigError(`--edge must be srcNode.pin->dstNode.pin (got '${edge}')`);
  }
  return ruleTraceLinkWatchpointId(split[0], split[1]);
}

function assertKnownWatchpoints(requested: string[], available: string[]): void {
  const known = new Set(available);
  const unknown = requested.filter((entry) => !known.has(entry));
  if (unknown.length === 0) return;
  throw new ConfigError('trace watchpoint is not present in the current rule graph', {
    unknown,
    boundary: 'current-rule-graph',
  });
}

function parseTimeBounds(opts: TraceOpts): { sinceMs?: number; untilMs?: number } {
  let sinceMs: number | undefined;
  let untilMs: number | undefined;
  try {
    sinceMs = parseTimestamp(opts.since);
    untilMs = parseTimestamp(opts.until);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  if (sinceMs !== undefined && untilMs !== undefined && untilMs <= sinceMs) {
    throw new ConfigError('--until must be greater than --since');
  }
  return {
    ...(sinceMs !== undefined && { sinceMs }),
    ...(untilMs !== undefined && { untilMs }),
  };
}

function parseOptionalCount(raw: string | undefined, flag: string): number | undefined {
  return raw === undefined ? undefined : parseCount(raw, flag);
}

function parseCount(raw: string, flag: string): number {
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new ConfigError(`${flag} must be a nonnegative decimal integer (got '${raw}')`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_COUNT) {
    throw new ConfigError(`${flag} must be <= ${MAX_COUNT} (got '${raw}')`);
  }
  return value;
}

interface FrameSelectionInput {
  sinceMs?: number;
  untilMs?: number;
  startStep?: number;
  endStep?: number;
  maxSteps: number;
}

function selectFrames(frames: RuleTraceFrame[], input: FrameSelectionInput) {
  let selected = frames.filter(
    (frame) =>
      (input.sinceMs === undefined || frame.timestamp >= input.sinceMs) &&
      (input.untilMs === undefined || frame.timestamp <= input.untilMs) &&
      (input.startStep === undefined || frame.step >= input.startStep) &&
      (input.endStep === undefined || frame.step <= input.endStep),
  );
  const beforeMaxSteps = selected.length;
  if (selected.length > input.maxSteps) selected = selected.slice(selected.length - input.maxSteps);
  const first = selected[0];
  const last = selected[selected.length - 1];
  return {
    frames: selected,
    metadata: {
      sinceMs: input.sinceMs ?? null,
      untilMs: input.untilMs ?? null,
      startStep: input.startStep ?? null,
      endStep: input.endStep ?? null,
      maxSteps: input.maxSteps,
      matchingBeforeMaxSteps: beforeMaxSteps,
      returnedSteps: selected.length,
      returnedStartStep: first?.step ?? null,
      returnedEndStep: last?.step ?? null,
      truncatedByMaxSteps: beforeMaxSteps > selected.length,
      allCalculatedFramesReturned: selected.length === frames.length,
    },
  };
}

function completenessReasons(
  fetched: Awaited<ReturnType<typeof fetchRuleLogs>>,
  topologyDriftCount: number,
  semanticDriftCount: number,
  specLookupFailureCount: number,
): string[] {
  const reasons = ['gateway-retention-unknown', 'historical-topology-not-snapshotted'];
  if (fetched.stopReason === 'max-blocks') reasons.push('scan-hit-max-blocks');
  if (fetched.stopReason === 'duplicate-block') reasons.push('pagination-duplicate-block');
  if (fetched.unparsed.length > 0) reasons.push('unparsed-log-lines');
  if (topologyDriftCount > 0) reasons.push('current-graph-topology-drift');
  if (semanticDriftCount > 0) reasons.push('bundle-semantic-drift');
  if (specLookupFailureCount > 0) reasons.push('device-get-spec-lookup-failed-raw-fallback');
  return reasons;
}

function renderHuman(payload: {
  ruleId: string;
  totalSteps: number;
  count: number;
  frames: RuleTraceFrame[];
  completeness: { reasonCodes: string[] };
}): void {
  process.stdout.write(
    `rule ${payload.ruleId}: ${payload.count}/${payload.totalSteps} trace frames (client-derived; not device truth)\n`,
  );
  process.stdout.write(`incomplete: ${payload.completeness.reasonCodes.join(', ')}\n`);
  if (payload.frames.length === 0) {
    process.stdout.write('(no trace frames match the selection)\n');
    return;
  }
  const table = new Table({
    head: ['step', 'timestamp', 'changed', 'info', 'active'],
    style: { head: [], border: [] },
    wordWrap: true,
  });
  for (const frame of payload.frames) {
    const latest = frame.changed === null ? undefined : frame.status[frame.changed];
    table.push([
      String(frame.step),
      frame.iso,
      frame.changed ?? '(enable reset)',
      latest?.info ?? '规则启用',
      String(Object.keys(frame.status).length),
    ]);
  }
  process.stdout.write(`${table.toString()}\n`);
}
