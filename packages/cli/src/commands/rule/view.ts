import { viewRule } from '@eyaeya/xgg-core';
import Table from 'cli-table3';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { emit } from '../../output.js';
import { splitGraphemes, truncateDisplayText, wrapDisplayText } from '../../terminal-text.js';
import { type RuleOpts, makeDeps } from './_deps.js';

export { truncateDisplayText, wrapDisplayText } from '../../terminal-text.js';

interface ViewOpts extends RuleOpts {
  nodesOnly?: boolean;
}

const RECORD_SUMMARY_MAX_CHARS = 420;
const RECORD_SUMMARY_MAX_ENTRIES = 16;
const VALUE_SUMMARY_MAX_CHARS = 260;
const STRING_SUMMARY_MAX_CHARS = 96;
const COLLECTION_SUMMARY_MAX_ENTRIES = 12;
const COLLECTION_SUMMARY_MAX_DEPTH = 3;
const TOPOLOGY_SUMMARY_MAX_CHARS = 320;
const TOPOLOGY_SUMMARY_MAX_PINS = 16;
const TOPOLOGY_SUMMARY_MAX_TARGETS = 8;
export const RULE_VIEW_PRETTY_COLUMN_WIDTHS = [16, 14, 18, 32, 52, 48] as const;
const TABLE_CELL_PADDING_WIDTH = 2;
const TABLE_CONTENT_WIDTHS = {
  nodeId: RULE_VIEW_PRETTY_COLUMN_WIDTHS[0] - TABLE_CELL_PADDING_WIDTH,
  type: RULE_VIEW_PRETTY_COLUMN_WIDTHS[1] - TABLE_CELL_PADDING_WIDTH,
  name: RULE_VIEW_PRETTY_COLUMN_WIDTHS[2] - TABLE_CELL_PADDING_WIDTH,
  inputs: RULE_VIEW_PRETTY_COLUMN_WIDTHS[3] - TABLE_CELL_PADDING_WIDTH,
  props: RULE_VIEW_PRETTY_COLUMN_WIDTHS[4] - TABLE_CELL_PADDING_WIDTH,
  outputs: RULE_VIEW_PRETTY_COLUMN_WIDTHS[5] - TABLE_CELL_PADDING_WIDTH,
} as const;

function compareKeys(left: string, right: string): number {
  const leftMatch = /^(.*?)(\d+)$/.exec(left);
  const rightMatch = /^(.*?)(\d+)$/.exec(right);
  if (leftMatch !== null && rightMatch !== null && leftMatch[1] === rightMatch[1]) {
    const numericDifference = Number(leftMatch[2]) - Number(rightMatch[2]);
    if (numericDifference !== 0) return numericDifference;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonString(value: string): string {
  const encoded = JSON.stringify(value);
  let terminalSafe = '';
  for (const character of encoded) {
    const codePoint = character.codePointAt(0) as number;
    terminalSafe +=
      codePoint >= 0x7f && codePoint <= 0x9f
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : character;
  }
  return terminalSafe;
}

function quotedStringWithin(value: string, maxChars: number): string {
  const encoded = jsonString(value);
  if (encoded.length <= maxChars) return encoded;

  const characters = splitGraphemes(value);
  for (let keep = Math.min(characters.length, maxChars); keep >= 0; keep -= 1) {
    const omitted = characters.length - keep;
    const candidate = jsonString(`${characters.slice(0, keep).join('')}…(+${omitted} chars)`);
    if (candidate.length <= maxChars) return candidate;
  }
  return '"…"';
}

function scalarSummary(value: unknown, maxChars: number): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return quotedStringWithin(value, Math.min(maxChars, STRING_SUMMARY_MAX_CHARS));
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return 'Infinity';
    if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
    return String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (value === undefined) return 'undefined';
  return undefined;
}

function collectionMarker(kind: 'items' | 'keys', omitted: number): string {
  return kind === 'items'
    ? jsonString(`…(+${omitted} items)`)
    : `${jsonString('…')}:${jsonString(`(+${omitted} keys)`)}`;
}

function valueSummary(value: unknown, maxChars: number, depth = 0): string {
  const scalar = scalarSummary(value, maxChars);
  if (scalar !== undefined) return scalar;

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const containsOnlyScalars = value.every(
      (entry) => scalarSummary(entry, VALUE_SUMMARY_MAX_CHARS) !== undefined,
    );
    if (depth >= COLLECTION_SUMMARY_MAX_DEPTH && !containsOnlyScalars) {
      return `[${collectionMarker('items', value.length)}]`;
    }

    const entries: string[] = [];
    const limit = Math.min(value.length, COLLECTION_SUMMARY_MAX_ENTRIES);
    for (let index = 0; index < limit; index += 1) {
      const remaining = value.length - index - 1;
      const marker = remaining > 0 ? collectionMarker('items', remaining) : '';
      const punctuation = 2 + entries.join(',').length + (entries.length > 0 ? 1 : 0);
      const reserved = marker === '' ? 0 : marker.length + 1;
      const available = Math.min(VALUE_SUMMARY_MAX_CHARS, maxChars - punctuation - reserved);
      if (available < 5) break;
      entries.push(valueSummary(value[index], available, depth + 1));
    }
    const omitted = value.length - entries.length;
    if (omitted > 0) entries.push(collectionMarker('items', omitted));
    return `[${entries.join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareKeys);
    if (keys.length === 0) return '{}';
    if (depth >= COLLECTION_SUMMARY_MAX_DEPTH) {
      return `{${collectionMarker('keys', keys.length)}}`;
    }

    const entries: string[] = [];
    const limit = Math.min(keys.length, COLLECTION_SUMMARY_MAX_ENTRIES);
    for (let index = 0; index < limit; index += 1) {
      const key = keys[index] as string;
      const keyPrefix = `${quotedStringWithin(key, STRING_SUMMARY_MAX_CHARS)}:`;
      const remaining = keys.length - index - 1;
      const marker = remaining > 0 ? collectionMarker('keys', remaining) : '';
      const punctuation = 2 + entries.join(',').length + (entries.length > 0 ? 1 : 0);
      const reserved = marker === '' ? 0 : marker.length + 1;
      const available = Math.min(
        VALUE_SUMMARY_MAX_CHARS,
        maxChars - punctuation - reserved - keyPrefix.length,
      );
      if (available < 5) break;
      entries.push(`${keyPrefix}${valueSummary(record[key], available, depth + 1)}`);
    }
    const omitted = keys.length - entries.length;
    if (omitted > 0) entries.push(collectionMarker('keys', omitted));
    return `{${entries.join(',')}}`;
  }

  return quotedStringWithin(String(value), maxChars);
}

function boundedStructuredSummary(summary: string, source: unknown, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  if (Array.isArray(source)) {
    const marker = jsonString(`…(+${source.length} items; summary exceeded ${maxChars} chars)`);
    return `[${marker}]`;
  }
  if (typeof source === 'object' && source !== null) {
    const keyCount = Object.keys(source).length;
    return `{${jsonString('…')}:${jsonString(
      `(+${keyCount} keys; summary exceeded ${maxChars} chars)`,
    )}}`;
  }
  return quotedStringWithin(String(source), maxChars);
}

/** Stable, typed and explicitly bounded JSON-like summary for pretty rule inspection. */
export function summarizeRuleRecord(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return boundedStructuredSummary(
      valueSummary(value, RECORD_SUMMARY_MAX_CHARS),
      value,
      RECORD_SUMMARY_MAX_CHARS,
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareKeys);
  if (keys.length === 0) return '';

  const entries: string[] = [];
  const limit = Math.min(keys.length, RECORD_SUMMARY_MAX_ENTRIES);
  for (let index = 0; index < limit; index += 1) {
    const key = keys[index] as string;
    const keyPrefix = `${quotedStringWithin(key, STRING_SUMMARY_MAX_CHARS)}:`;
    const remaining = keys.length - index - 1;
    const marker = remaining > 0 ? collectionMarker('keys', remaining) : '';
    const punctuation = 2 + entries.join(',').length + (entries.length > 0 ? 1 : 0);
    const reserved = marker === '' ? 0 : marker.length + 1;
    const available = Math.min(
      VALUE_SUMMARY_MAX_CHARS,
      RECORD_SUMMARY_MAX_CHARS - punctuation - reserved - keyPrefix.length,
    );
    if (available < 5) break;
    entries.push(`${keyPrefix}${valueSummary(record[key], available, 1)}`);
  }
  const omitted = keys.length - entries.length;
  if (omitted > 0) entries.push(collectionMarker('keys', omitted));
  return boundedStructuredSummary(`{${entries.join(',')}}`, value, RECORD_SUMMARY_MAX_CHARS);
}

function cellText(value: string, maxChars = 80): string {
  const quoted = quotedStringWithin(value, maxChars + 2);
  return quoted.slice(1, -1);
}

/** Stable, bounded topology summary that retains the existing output-pin emphasis. */
export function summarizeRuleOutputs(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return summarizeRuleRecord(value);
  }
  const outputs = value as Record<string, unknown>;
  const pins = Object.keys(outputs)
    .filter((pin) => Array.isArray(outputs[pin]) && (outputs[pin] as unknown[]).length > 0)
    .sort(compareKeys);
  const entries: string[] = [];
  const limit = Math.min(pins.length, TOPOLOGY_SUMMARY_MAX_PINS);
  for (let index = 0; index < limit; index += 1) {
    const pin = pins[index] as string;
    const targets = outputs[pin] as unknown[];
    const shownTargets = targets
      .slice(0, TOPOLOGY_SUMMARY_MAX_TARGETS)
      .map((target) => cellText(String(target), 80));
    if (targets.length > shownTargets.length) {
      shownTargets.push(`…(+${targets.length - shownTargets.length} targets)`);
    }
    const entry = `${cellText(pin)}→${shownTargets.join(',')}`;
    const omittedPins = pins.length - index - 1;
    const marker = omittedPins > 0 ? `…(+${omittedPins} pins)` : '';
    const candidateLength =
      entries.join(' | ').length + (entries.length > 0 ? 3 : 0) + entry.length;
    if (candidateLength + (marker === '' ? 0 : marker.length + 3) > TOPOLOGY_SUMMARY_MAX_CHARS) {
      break;
    }
    entries.push(entry);
  }
  if (pins.length > entries.length) entries.push(`…(+${pins.length - entries.length} pins)`);
  return entries.join(' | ');
}

export function attachView(cmd: Command): void {
  cmd
    .command('view <id>')
    .description(
      "Read a rule's full graph (cfg + nodes) — the standard read path for `rule set` round-trips",
    )
    .option('--nodes-only', 'omit cfg/userData; emit just the nodes array')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: name + bounded node inputs/props/topology summary')
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg rule view 1748234567890\n  $ xgg rule view 1748234567890 --pretty\n  $ xgg rule view 1748234567890 > rule.json && xgg rule set --body rule.json',
    )
    .action(
      wrap('rule.view', async (id: string, opts: ViewOpts) => {
        const deps = makeDeps(opts);
        const view = await viewRule(id, deps);
        const payload = opts.nodesOnly
          ? { ok: true, id: view.id, nodes: view.nodes }
          : { ok: true, ...view };
        if (!opts.pretty) {
          emit(payload, { pretty: false });
          return;
        }
        const name = truncateDisplayText(cellText(view.cfg.userData.name, 240), 120);
        const ruleId = truncateDisplayText(cellText(view.id, 160), 80);
        const uiType = truncateDisplayText(cellText(view.cfg.uiType, 80), 40);
        process.stdout.write(
          `${name} (id=${ruleId}, uiType=${uiType}, enable=${view.cfg.enable})\n\n`,
        );
        const table = new Table({
          head: ['nodeId', 'type', 'name', 'inputs', 'props', 'outputs'],
          colWidths: [...RULE_VIEW_PRETTY_COLUMN_WIDTHS],
          style: { head: [], border: [] },
        });
        for (const node of view.nodes) {
          const cfg = (node as { cfg?: { name?: string } }).cfg;
          const inputs = (node as { inputs?: unknown }).inputs ?? {};
          const props = (node as { props?: unknown }).props ?? {};
          const outputs = (node as { outputs?: unknown }).outputs ?? {};
          table.push([
            wrapDisplayText(
              cellText((node as { id: string }).id, 160),
              TABLE_CONTENT_WIDTHS.nodeId,
            ),
            wrapDisplayText(
              cellText((node as { type: string }).type, 160),
              TABLE_CONTENT_WIDTHS.type,
            ),
            truncateDisplayText(cellText(cfg?.name ?? '', 160), TABLE_CONTENT_WIDTHS.name),
            wrapDisplayText(summarizeRuleRecord(inputs), TABLE_CONTENT_WIDTHS.inputs),
            wrapDisplayText(summarizeRuleRecord(props), TABLE_CONTENT_WIDTHS.props),
            wrapDisplayText(summarizeRuleOutputs(outputs), TABLE_CONTENT_WIDTHS.outputs),
          ]);
        }
        process.stdout.write(`${table.toString()}\n`);
      }),
    );
}
