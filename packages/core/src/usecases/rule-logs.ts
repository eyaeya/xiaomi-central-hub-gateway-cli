import type { ResourceDeps } from '../resources/index.js';
import { agentCall } from './agent-call.js';

// The gateway exposes only one log RPC — `/api/getLog` — and it returns a
// newline-delimited "block" of raw log lines for the whole gateway, not for
// any specific rule. Codex M8 reverse-engineering (REPORT.md task 1):
//   - param: `{ num: number }` — block index, increment from 0 until empty
//     or the complete raw block repeats (server-side cursor).
//   - response: `{ jsonrpc, id, result: string }` where `result` is the
//     raw block text.
// All rule scoping + time filtering must happen on the client.

export interface RuleLogEntry {
  /** Epoch milliseconds (parsed from the second `|` field). */
  timestamp: number;
  /** ISO 8601 derived from `timestamp` — convenience for AI agents. */
  iso: string;
  /** Rule id (gateway calls it `graphId` in the log envelope). */
  graphId: string;
  /** Raw type letter from the log line. */
  rawType: 'r' | 'l' | 'i' | 'e';
  /** Coarse severity for filtering / table coloring. */
  level: 'info' | 'error';
  /** Node id (absent on `r` lines). */
  nodeId?: string;
  /** Source endpoint on `l` lines, formatted `nodeId.pin`. */
  src?: string;
  /** Destination endpoint on `l` lines, formatted `nodeId.pin`. */
  dst?: string;
  /** Stringified value carried on a link event (`l` lines). */
  linkValue?: string;
  /** Cfg blob on `r` lines (parsed JSON when valid, otherwise raw string). */
  ruleConfig?: unknown;
  /** Info payload string on `i` lines (often a JSON-encoded array). */
  info?: string;
  /** Numeric error code on `e` lines (e.g. `-9999`). */
  errorCode?: number;
  /** Human error message on `e` lines (e.g. `user ack timeout`). */
  errorMessage?: string;
  /** Human-readable rendering for terminal output. */
  message: string;
  /** Original line — used for follow-mode de-duplication. */
  raw: string;
}

/**
 * Parse a single newline-delimited log line. Returns `null` if the line
 * does not conform to the documented `3|<ts>|<type>|...` format so the
 * caller can skip junk gracefully.
 */
export function parseLogLine(raw: string): RuleLogEntry | null {
  if (!raw) return null;
  const parts = raw.split('|');
  if (parts.length < 4) return null;
  const [version, tsStr, type, graphId, ...rest] = parts;
  if (version !== '3') return null;
  if (graphId === undefined || tsStr === undefined) return null;
  const timestamp = Number(tsStr);
  if (!Number.isFinite(timestamp)) return null;
  if (type !== 'r' && type !== 'l' && type !== 'i' && type !== 'e') return null;

  const base: RuleLogEntry = {
    timestamp,
    iso: new Date(timestamp).toISOString(),
    graphId,
    rawType: type,
    level: type === 'e' ? 'error' : 'info',
    message: '',
    raw,
  };

  switch (type) {
    case 'r': {
      if (parts.length !== 5) return null;
      const cfgRaw = rest.join('|');
      base.message = renderRuleConfig(cfgRaw);
      base.ruleConfig = safeJsonParse(cfgRaw) ?? cfgRaw;
      return base;
    }
    case 'l': {
      if (parts.length !== 7) return null;
      const [src, dst, value] = rest;
      const [, srcPin] = src?.split('.') ?? [];
      const [, dstPin] = dst?.split('.') ?? [];
      if (srcPin === undefined || dstPin === undefined) return null;
      if (src !== undefined) base.src = src;
      if (dst !== undefined) base.dst = dst;
      if (value !== undefined) base.linkValue = value;
      const srcNode = src?.split('.')[0];
      if (srcNode) base.nodeId = srcNode;
      base.message = `link ${src ?? '?'} → ${dst ?? '?'} = ${renderLinkValue(value)}`;
      return base;
    }
    case 'i': {
      if (parts.length !== 6) return null;
      const [nodeId, ...payload] = rest;
      if (nodeId !== undefined) base.nodeId = nodeId;
      const info = payload.join('|');
      base.info = info;
      base.message = info === 'success' ? `${nodeId ?? '?'} success` : `${nodeId ?? '?'} ${info}`;
      return base;
    }
    case 'e': {
      if (parts.length !== 7) return null;
      const [nodeId, codeStr, ...msgParts] = rest;
      if (nodeId !== undefined) base.nodeId = nodeId;
      const errorCode = Number(codeStr);
      if (Number.isNaN(errorCode)) return null;
      base.errorCode = errorCode;
      const errorMessage = msgParts.join('|');
      base.errorMessage = errorMessage;
      base.message = `${nodeId ?? '?'} [error ${codeStr ?? '?'}] ${errorMessage}`;
      return base;
    }
  }
}

function renderRuleConfig(raw: string): string {
  const parsed = safeJsonParse(raw) as { enable?: boolean } | null;
  if (parsed && typeof parsed.enable === 'boolean') {
    return parsed.enable ? '规则启用' : '规则停用';
  }
  return `rule cfg: ${raw}`;
}

function renderLinkValue(raw: string | undefined): string {
  if (raw === 'true') return '真';
  if (raw === 'false') return '伪';
  if (raw === 'null' || raw === undefined) return '事件';
  return raw;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface FetchRuleLogsInputs extends ResourceDeps {
  /** Max number of log blocks to pull (each block is one `/api/getLog` call). */
  maxBlocks?: number;
}

export interface FetchRuleLogsResult {
  /** Parsed entries in chronological block order: oldest block to newest, preserving each block. */
  entries: RuleLogEntry[];
  /** Raw lines we could not parse. Internal diagnostic data; CLI output must expose only counts. */
  unparsed: string[];
  /** How many blocks we actually fetched. */
  blocksRead: number;
  /** True when paging stopped because a full raw block repeated exactly. */
  cursorWrapped: boolean;
  /** Why pagination stopped; `max-blocks` means the client scan bound was reached. */
  stopReason: 'empty-block' | 'duplicate-block' | 'max-blocks';
  /** Effective caller-provided pagination bound. */
  maxBlocks: number;
}

const DEFAULT_MAX_BLOCKS = 8;

/**
 * Pull every available log block from `/api/getLog`, parse each line, and
 * return oldest-block-first entries while preserving line order inside each
 * block. The gateway pages newest block first. Stop only at an empty block or
 * an exactly repeated full block; identical raw lines inside or across
 * different blocks remain valid.
 */
export async function fetchRuleLogs(input: FetchRuleLogsInputs): Promise<FetchRuleLogsResult> {
  const maxBlocks = input.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const rawBlocks: string[][] = [];
  const seenRawBlocks = new Set<string>();
  let blocksRead = 0;
  let cursorWrapped = false;
  let stopReason: FetchRuleLogsResult['stopReason'] = 'max-blocks';

  for (let num = 0; num < maxBlocks; num += 1) {
    const raw = await agentCall({
      baseUrl: input.baseUrl,
      method: '/api/getLog',
      params: { num },
      store: input.store,
      kind: 'read',
      ...(input.ipcClient !== undefined && { ipcClient: input.ipcClient }),
      ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
    });
    blocksRead = num + 1;
    if (typeof raw !== 'string' || raw.length === 0) {
      stopReason = 'empty-block';
      break;
    }

    const lines = raw.split('\n').filter((l) => l.length > 0);
    const first = lines[0];
    if (first === undefined) {
      stopReason = 'empty-block';
      break;
    }

    if (seenRawBlocks.has(raw)) {
      cursorWrapped = true;
      stopReason = 'duplicate-block';
      break;
    }
    seenRawBlocks.add(raw);
    rawBlocks.push(lines);
  }

  const entries: RuleLogEntry[] = [];
  const unparsed: string[] = [];
  for (const lines of rawBlocks.reverse()) {
    for (const line of lines) {
      const parsed = parseLogLine(line);
      if (parsed) {
        entries.push(parsed);
      } else {
        unparsed.push(line);
      }
    }
  }
  return { entries, unparsed, blocksRead, cursorWrapped, stopReason, maxBlocks };
}

export interface FilterRuleLogsOpts {
  ruleId: string;
  /** Inclusive lower bound (epoch ms). */
  sinceMs?: number;
  /** Inclusive upper bound (epoch ms). */
  untilMs?: number;
  /** Severity filter — match exact level. */
  level?: 'info' | 'error';
  /** Keep only the last N entries after filtering. */
  tail?: number;
}

/**
 * Apply CLI-style filters to a parsed log block. Time bounds are inclusive;
 * `tail` keeps the newest entries after every other filter has run.
 */
export function filterRuleLogs(entries: RuleLogEntry[], opts: FilterRuleLogsOpts): RuleLogEntry[] {
  const { sinceMs, untilMs, level } = opts;
  let out = entries.filter((e) => e.graphId === opts.ruleId);
  if (sinceMs !== undefined) out = out.filter((e) => e.timestamp >= sinceMs);
  if (untilMs !== undefined) out = out.filter((e) => e.timestamp <= untilMs);
  if (level !== undefined) out = out.filter((e) => e.level === level);
  if (opts.tail !== undefined && opts.tail >= 0 && out.length > opts.tail) {
    out = out.slice(out.length - opts.tail);
  }
  return out;
}

/**
 * Accept an epoch-ms number, an epoch-ms string, or an ISO-8601 string.
 * Returns `undefined` for an undefined input so CLI option chaining stays
 * terse; throws for unparseable strings so the caller can surface a clear
 * ConfigError.
 */
export function parseTimestamp(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number') return raw;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && /^\d+$/.test(raw.trim())) return asNum;
  const asDate = Date.parse(raw);
  if (Number.isNaN(asDate)) {
    throw new Error(`unparseable timestamp: ${raw} (expected epoch-ms or ISO-8601)`);
  }
  return asDate;
}
