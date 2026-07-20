/**
 * agent-hints.ts — funnel-path level-2 guidance for LLM agents driving the
 * xgg CLI. Each successful mutation / lifecycle command consults
 * NEXT_STEP_RULES, picks the single most-specific match, and emits the
 * resulting hint via TWO channels:
 *
 *   1. stdout JSON `nextSteps: NextStepHint[]` (machine-readable; only
 *      present when ≥1 rule matches — absence preserves byte-identical
 *      backwards compatibility)
 *   2. stderr `note: [<ctx>] next → <cmd>  # <why>` lines (human-readable;
 *      colour-aware via ttyBoldYellow)
 *
 * Both channels honour --no-next-hint flag + XGG_NO_NEXT_HINT=1 env.
 * Failure paths (action throw) bypass this entirely — errors.ts lookupHint
 * owns the error channel to avoid double-emission.
 *
 *
 * Adding a new rule:
 *   1. Identify the command's wrap() tag (e.g. 'rule.node.add')
 *   2. Place the rule in array order — earlier rules win at the same
 *      specificity tier; more-specific (predicate-bearing) rules win
 *      over command-only catch-alls within the same command bucket
 *   3. cmd() must return strings starting with `xgg ` (lint test enforced)
 *   4. why must be self-contained — NO references to AGENTS.md /
 *      SKILL.md / any file outside the published CLI package
 *   5. Add a positive + negative test case to agent-hints.test.ts
 */

import {
  INDEPENDENT_EVENT_SOURCE_TYPES,
  INDEPENDENT_STATE_SOURCE_TYPES,
  isEditorCompatibleNodeId,
  modeledNodePinNames,
} from '@eyaeya/xgg-core';
import { type Command, Option } from 'commander';
import { ttyBoldYellow } from './tty.js';

export type LifecycleStage =
  | 'unauthenticated'
  | 'oriented'
  | 'created'
  | 'drafting'
  | 'wiring'
  | 'laid-out'
  | 'validated'
  | 'enabled'
  | 'observed';

export type LifecycleTransition = `${LifecycleStage} → ${LifecycleStage}`;

export interface NextStepRule {
  /** matches the wrap() cmdPath tag, e.g. 'rule.new', 'rule.node.add' */
  command: string;
  /** optional predicate over the action's result + parsed opts; specificity tier 2 */
  match?: (result: unknown, opts: unknown) => boolean;
  /** what to do next — function form, reads result/opts from closure */
  cmd: (result: unknown, opts: unknown) => string | string[];
  /** one-line rationale — self-contained, no external file refs */
  why: string;
  /** transition tag — grep-able, also keeps state machine upgrade path open */
  lifecycle: LifecycleTransition;
}

export interface NextStepHint {
  cmd: string;
  why: string;
  lifecycle: string;
}

/** Sugar: literal cmd that doesn't depend on result/opts. */
export const lit =
  (s: string | string[]) =>
  (_result: unknown, _opts: unknown): string | string[] =>
    s;

/** Type guard for predicate authors: narrows unknown to a record with key K. */
export const has = <K extends string>(o: unknown, k: K): o is Record<K, unknown> =>
  typeof o === 'object' && o !== null && k in o;

// Helpers used inside the rule table — kept close to the rules to keep the
// table greppable. `id(x)` extracts a string id from result-shapes that
// carry one; `scope(x)` reads .scope; etc. All return undefined on missing
// data; rule authors fall back to <id> / <scope> placeholders in the cmd
// string so the agent sees explicit "slot here" markers when the gateway
// payload is missing the expected field.
const readId = (r: unknown): string => (has(r, 'id') && typeof r.id === 'string' ? r.id : '<id>');
const readRuleId = (r: unknown): string =>
  has(r, 'ruleId') && typeof r.ruleId === 'string'
    ? r.ruleId
    : has(r, 'rule_id') && typeof r.rule_id === 'string'
      ? r.rule_id
      : readId(r);
const readScope = (r: unknown): string =>
  has(r, 'scope') && typeof r.scope === 'string'
    ? r.scope
    : has(r, 'varScope') && typeof r.varScope === 'string'
      ? r.varScope
      : '<scope>';
const readVarId = (r: unknown): string =>
  has(r, 'varId') && typeof r.varId === 'string' ? r.varId : readId(r);
const readNodeId = (r: unknown): string =>
  has(r, 'nodeId') && typeof r.nodeId === 'string' ? r.nodeId : '<thisNode>';
const readNodeType = (r: unknown, opts: unknown): string =>
  has(opts, 'type') && typeof opts.type === 'string'
    ? opts.type
    : has(r, 'type') && typeof r.type === 'string'
      ? r.type
      : '';

function hintShellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function splitEdgeHint(
  ruleId: string,
  from: { nodeId: string; pin: string },
  to: { nodeId: string; pin: string },
): string {
  return `xgg rule edge add --rule-id ${ruleId} --from-node-id ${hintShellQuote(from.nodeId)} --from-pin ${hintShellQuote(from.pin)} --to-node-id ${hintShellQuote(to.nodeId)} --to-pin ${hintShellQuote(to.pin)}`;
}

function hintEdgeRef(value: string): { nodeId: string; pin: string } | undefined {
  const separator = value.lastIndexOf(':');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { nodeId: value.slice(0, separator), pin: value.slice(separator + 1) };
}

function incomingNodeEdgeHint(r: unknown, opts: unknown, source = '<upstream>:<pin>'): string {
  const type = readNodeType(r, opts);
  const inputPin = modeledNodePinNames(type, 'input')?.[0] ?? '<pin>';
  const nodeId = readNodeId(r);
  const sourceRef = hintEdgeRef(source);
  if (!isEditorCompatibleNodeId(nodeId) && sourceRef !== undefined) {
    return splitEdgeHint(readRuleId(r), sourceRef, { nodeId, pin: inputPin });
  }
  return `xgg rule edge add --rule-id ${readRuleId(r)} --from ${source} --to ${nodeId}:${inputPin}`;
}

function outgoingNodeEdgeHint(r: unknown, opts: unknown): string {
  const type = readNodeType(r, opts);
  const outputPin = modeledNodePinNames(type, 'output')?.[0] ?? '<pin>';
  const nodeId = readNodeId(r);
  if (!isEditorCompatibleNodeId(nodeId)) {
    return splitEdgeHint(
      readRuleId(r),
      { nodeId, pin: outputPin },
      { nodeId: '<downstream>', pin: '<state-pin>' },
    );
  }
  return `xgg rule edge add --rule-id ${readRuleId(r)} --from ${nodeId}:${outputPin} --to <downstream>:<state-pin>`;
}

const hasCleanSummary = (r: unknown): boolean =>
  has(r, 'summary') &&
  has(r.summary, 'errors') &&
  r.summary.errors === 0 &&
  has(r.summary, 'warnings') &&
  r.summary.warnings === 0;

const isSingleLiveRule = (opts: unknown): boolean =>
  has(opts, 'ruleId') &&
  typeof opts.ruleId === 'string' &&
  opts.ruleId.length > 0 &&
  !(has(opts, 'all') && opts.all === true);

const isStrictLint = (opts: unknown): boolean => has(opts, 'strict') && opts.strict === true;

/**
 * NEXT_STEP_RULES — the single source of truth for hint dispatch. Populated
 * by Task 7 of the implementation plan. Iteration order = priority order
 * within the same specificity tier.
 */
export const NEXT_STEP_RULES: NextStepRule[] = [
  // ----- A. Authentication / orientation (spec §5.1) -----
  {
    command: 'login',
    cmd: lit(['xgg device list --pretty', 'xgg rule list --pretty']),
    why: 'orient yourself before authoring — device DIDs and existing rule IDs are the building blocks; ghost-state surfaces here too',
    lifecycle: 'unauthenticated → oriented',
  },
  {
    command: 'device.list',
    cmd: lit('xgg device spec <did>'),
    why: 'every deviceInput/deviceOutput card needs a property/event from the spec, not a guess',
    lifecycle: 'oriented → drafting',
  },
  {
    command: 'device.spec',
    cmd: lit('xgg rule new --name "<NAME>"'),
    why: 'spec read, time to create the rule envelope; node add / edge add follow',
    lifecycle: 'oriented → drafting',
  },

  // ----- B. Drafting + nodes + edges (spec §5.2) -----
  {
    command: 'rule.new',
    match: (_r, opts) => !(has(opts, 'enable') && opts.enable === true),
    cmd: (r) => `xgg rule node add --rule-id ${readId(r)} --type <trigger>`,
    why: "every automation needs an independent event source. Pick the source matching the user's requirement (deviceInput for a device event/property, alarmClock for time-of-day, timeRange for the verified window-entry event plus current-window state, varChange for variable observation, or deviceInputSetVar). loop/register need an upstream control signal. NOTE: during early agent self-test or smoke-checking, onLoad is a useful optional source because `xgg rule disable <id> && xgg rule enable <id>` re-fires it deterministically without physical interaction — but it is not the default for real automations, choose by intent",
    lifecycle: 'created → drafting',
  },
  {
    command: 'rule.new',
    match: (_r, opts) => has(opts, 'enable') && opts.enable === true,
    cmd: (r) => `xgg rule node add --rule-id ${readId(r)} --type <trigger>`,
    why: 'rule was created already-enabled; add an independent event source next. The enable state is already on, so each node add immediately becomes part of the live rule',
    lifecycle: 'created → enabled',
  },
  {
    command: 'rule.node.add',
    match: (_r, opts) => has(opts, 'type') && TRIGGER_TYPES.has(String(opts.type)),
    cmd: (r) =>
      `xgg rule node add --rule-id ${readRuleId(r)} --type <action> (e.g. deviceOutput / varSetNumber)`,
    why: 'a trigger with no action card produces no observable effect — add at least one downstream card',
    lifecycle: 'drafting → drafting',
  },
  {
    command: 'rule.node.add',
    match: (_r, opts) => has(opts, 'type') && STATE_SOURCE_TYPES.has(String(opts.type)),
    cmd: outgoingNodeEdgeHint,
    why: 'this card is a zero-input state source; wire its output to a downstream state pin such as condition.condition',
    lifecycle: 'drafting → wiring',
  },
  {
    command: 'rule.node.add',
    match: (_r, opts) => has(opts, 'type') && opts.type === 'nop',
    cmd: (r) => `xgg rule node add --rule-id ${readRuleId(r)} --type <next-card>`,
    why: 'nop is a canvas-only note with no connectors or runtime behavior; keep authoring the executable graph without wiring the note',
    lifecycle: 'drafting → drafting',
  },
  {
    command: 'rule.node.add',
    match: (_r, opts) =>
      has(opts, 'type') &&
      ACTION_TYPES.has(String(opts.type)) &&
      !TRIGGER_TYPES.has(String(opts.type)),
    cmd: (r, opts) => incomingNodeEdgeHint(r, opts, '<trigger>:output'),
    why: 'action card must be wired from a trigger; CLI does not auto-wire on add',
    lifecycle: 'drafting → wiring',
  },
  {
    command: 'rule.node.add',
    match: (_r, opts) =>
      has(opts, 'type') &&
      VAR_CARD_TYPES.has(String(opts.type)) &&
      !TRIGGER_TYPES.has(String(opts.type)) &&
      !ACTION_TYPES.has(String(opts.type)),
    cmd: (r, opts) => {
      // node.add result lacks scope/varId (those live on opts, not on the
      // gateway-returned node payload). Real-gateway walk on 2026-05-31 caught
      // the placeholder leak — prefer opts.varScope/varId, fall back to result
      // so the hint stays useful even if commander option names drift.
      const scope =
        has(opts, 'varScope') && typeof opts.varScope === 'string' ? opts.varScope : readScope(r);
      const varId =
        has(opts, 'varId') && typeof opts.varId === 'string' ? opts.varId : readVarId(r);
      return [
        incomingNodeEdgeHint(r, opts),
        `xgg variable get-value --scope ${scope} --id ${varId}`,
      ];
    },
    why: 'var-card refs are pre-checked at add time, but vars can be deleted out-of-band — log the assumption explicitly',
    lifecycle: 'drafting → wiring',
  },
  {
    command: 'rule.node.add',
    cmd: incomingNodeEdgeHint,
    why: 'wire this node into the existing graph before adding more',
    lifecycle: 'drafting → wiring',
  },
  {
    command: 'rule.edge.add',
    cmd: (r) => [
      `xgg rule edge add --rule-id ${readRuleId(r)} --from <upstream>:<pin> --to <downstream>:<pin>`,
      `xgg rule layout ${readRuleId(r)} && xgg rule validate --rule-id ${readRuleId(r)}`,
    ],
    why: 'either keep wiring, or — when the graph is complete — layout + validate before enable; layout is cosmetic but makes the UI legible',
    lifecycle: 'wiring → laid-out',
  },
  {
    command: 'rule.layout',
    cmd: (r) => `xgg rule validate --rule-id ${readRuleId(r)}`,
    why: 'layout only changes executable-card pos.x/y and preserves free-form nop note positions; `rule validate` runs the same per-card schema + variable existence/scope/type pre-flight that `rule set` / `rule enable` use, and must pass before enable',
    lifecycle: 'laid-out → validated',
  },

  // ----- C. Validate + enable + observe (spec §5.3) -----
  {
    command: 'rule.validate',
    match: (r, opts) => hasCleanSummary(r) && isSingleLiveRule(opts),
    cmd: (r) => `xgg rule lint --rule-id ${readRuleId(r)} --strict`,
    why: 'save-button validation is clean; strict lint must also check topology, required inputs, and directed sink reachability before enable',
    lifecycle: 'validated → validated',
  },
  // Validate warnings/errors and offline --body/--stdin inputs intentionally
  // have no lifecycle hint. They are not a safe hand-off to live lint/enable.
  {
    command: 'rule.lint',
    match: (r, opts) => hasCleanSummary(r) && isSingleLiveRule(opts) && !isStrictLint(opts),
    cmd: (r) => `xgg rule lint --rule-id ${readRuleId(r)} --strict`,
    why: 'advisory lint is clean; rerun this single live rule with --strict to add save-button validation, required-input errors, and directed reachability',
    lifecycle: 'validated → validated',
  },
  {
    command: 'rule.lint',
    match: (r, opts) => hasCleanSummary(r) && isSingleLiveRule(opts) && isStrictLint(opts),
    cmd: (r) => `xgg rule enable ${readRuleId(r)}`,
    why: 'single-rule strict lint is clean across card validation, topology, required inputs, and directed reachability; enable is the next lifecycle step',
    lifecycle: 'validated → enabled',
  },
  // Lint warnings/errors and --all runs intentionally have no lifecycle hint:
  // they cannot safely identify one clean live rule to enable, and routing
  // back to validate would create a validate↔lint loop.
  // The remaining enable/disable/log hints in this section are post-enable
  // observation and replay steps, not entry points into the authoring funnel.
  // `rule enable` still runs its own full write gate on every replay.
  {
    command: 'rule.enable',
    cmd: (r) => [
      `xgg rule logs ${readId(r)} --tail 20`,
      `xgg rule disable ${readId(r)} && xgg rule enable ${readId(r)}`,
    ],
    why: 'enable returns immediately but the rule may still fail at runtime; matching parsed `rule logs` entries provide positive evidence, but the bounded log view is not the only verification. Combine it with controlled triggers, variable readings, or graph readback. For onLoad-based rules the disable+enable cycle re-fires the trigger deterministically without physical interaction; for other trigger types the agent must ask the user to physically trigger the rule (button-press, property change, etc.) before re-polling logs',
    lifecycle: 'validated → observed',
  },
  {
    command: 'rule.disable',
    cmd: (r) => `xgg rule enable ${readId(r)}`,
    why: 'disable alone usually means you intend to re-enable; call out the next move explicitly (matches the e2e disable→enable→logs loop)',
    lifecycle: 'enabled → enabled',
  },
  {
    command: 'rule.logs',
    match: (r) => has(r, 'entries') && Array.isArray(r.entries) && r.entries.length === 0,
    cmd: (r) => [
      `xgg rule disable ${readRuleId(r)} && xgg rule enable ${readRuleId(r)}`,
      `xgg rule logs ${readRuleId(r)} --follow --interval-ms 1500`,
    ],
    why: 'this bounded pull returned no matching parsed log entries; that alone does not prove whether the rule fired. For onLoad rules the disable+enable cycle can re-fire the trigger deterministically; for other trigger types ask the user to physically trigger (button-press, property change), then combine any matching entries with graph readback or variable evidence',
    lifecycle: 'enabled → observed',
  },
  {
    command: 'rule.logs',
    match: (r) =>
      has(r, 'entries') &&
      Array.isArray(r.entries) &&
      r.entries.some(
        (e) =>
          (has(e, 'level') && e.level === 'error') || (has(e, 'status') && e.status === 'failed'),
      ),
    cmd: (r) => [
      `xgg rule view ${readRuleId(r)} --pretty`,
      `xgg rule lint --rule-id ${readRuleId(r)}`,
      `xgg rule validate --rule-id ${readRuleId(r)}`,
    ],
    why: 'gateway logs name the failing node id and reason — drill into that node before re-running',
    lifecycle: 'observed → drafting',
  },
  // Rule 20: NO HINT when all entries success — terminal happy state.

  // ----- D. Variable lifecycle (spec §5.4) -----
  {
    command: 'variable.create',
    cmd: (_r, opts) => {
      const scope = has(opts, 'scope') && typeof opts.scope === 'string' ? opts.scope : '<scope>';
      const id = has(opts, 'id') && typeof opts.id === 'string' ? opts.id : '<id>';
      return `xgg rule node add --rule-id <rule-id> --type varGet|varChange|varSetNumber|varSetString --var-scope ${scope} --var-id ${id}`;
    },
    why: 'variable created but no card references it yet; wire it into a rule or it sits unused (ghost-data risk if scope ≠ global)',
    lifecycle: 'drafting → drafting',
  },
  {
    command: 'variable.set-value',
    cmd: (_r, opts) => {
      const scope = has(opts, 'scope') && typeof opts.scope === 'string' ? opts.scope : '<scope>';
      const id = has(opts, 'id') && typeof opts.id === 'string' ? opts.id : '<id>';
      return `xgg variable get-value --scope ${scope} --id ${id}`;
    },
    why: 'NotConfirmed on set-value is silent — explicit read confirms gateway state',
    lifecycle: 'drafting → drafting',
  },
  {
    command: 'variable.delete',
    cmd: lit('xgg rule view <rule-id> --pretty'),
    why: 'orphan var-card refs become `卡片变量丢失` at next enable; scan any rule that may reference this variable',
    lifecycle: 'drafting → drafting',
  },
  {
    command: 'variable.watch',
    match: (_r, opts) => !(has(opts, 'follow') && opts.follow === true),
    cmd: lit('xgg variable watch --follow --interval-ms 800'),
    why: 'snapshot is one-shot; for live observation switch to --follow (mirrors the 米家 dashboard polling cadence)',
    lifecycle: 'observed → observed',
  },

  // ----- E. Other (terminal / tools) (spec §5.5) -----
  {
    command: 'rule.set',
    cmd: (r) =>
      `xgg rule lint --rule-id ${readId(r) === '<id>' ? readRuleId(r) : readId(r)} --strict`,
    why: 'rule set checks card shape and variable references, but strict lint must still check topology, required inputs, and directed reachability before enable',
    lifecycle: 'drafting → validated',
  },
  {
    command: 'rule.delete',
    cmd: lit('xgg rule list --pretty'),
    why: 'delete is destructive — verify the listing immediately to confirm the rule was removed and adjacent ids are intact',
    lifecycle: 'enabled → oriented',
  },
  {
    command: 'rule.export',
    match: (_r, opts) => has(opts, 'format') && opts.format === 'json',
    cmd: lit('xgg rule import --from-file <exported.json>'),
    why: 'export ↔ import is the round-trip pair; verify both sides before treating export as truth',
    lifecycle: 'observed → observed',
  },
];

/**
 * Independent event sources — shared with core reachability/pin semantics.
 * Predicates use this to decide whether a freshly added source needs a
 * downstream action. `deviceInputSetVar` is both a source and a variable
 * writer (legacy fusion of two semantics in one card type).
 */
export const TRIGGER_TYPES = new Set<string>(INDEPENDENT_EVENT_SOURCE_TYPES);

/** Zero-input cards that expose independent supporting state (possibly plus an event). */
export const STATE_SOURCE_TYPES = new Set<string>(INDEPENDENT_STATE_SOURCE_TYPES);

/**
 * Action cards — the write-side leaves of a rule graph. After adding one,
 * the next step is usually to wire an edge from a trigger.
 */
export const ACTION_TYPES = new Set<string>([
  'deviceOutput',
  'varSetNumber',
  'varSetString',
  'deviceGetSetVar',
]);

/**
 * Cards that reference a variable by scope+id. After adding one, the hint
 * suggests confirming the referenced variable still resolves
 * (vars can be deleted out-of-band).
 */
export const VAR_CARD_TYPES = new Set<string>([
  'varGet',
  'varChange',
  'varSetNumber',
  'varSetString',
  'deviceInputSetVar',
  'deviceGetSetVar',
]);

/**
 * Specificity tier:
 *   2 — rule has a predicate (most specific)
 *   1 — rule is command-only catch-all (least specific)
 *
 * Within the same tier, array order in NEXT_STEP_RULES wins (earlier first).
 */
function specificity(r: NextStepRule): number {
  return r.match !== undefined ? 2 : 1;
}

/**
 * buildNextSteps — pick the single most-specific rule matching cmd path
 * and current result/opts, then materialize its cmd() output into one or
 * more NextStepHint entries. Always returns [] on no-match, so callers can
 * unconditionally pass the result to withNextSteps() and printNextStepHintLine().
 *
 * Throw-safety: a buggy predicate or cmd() function in one rule cannot
 * crash the CLI; we log a one-line stderr warning and skip the offending
 * rule (or skip the entire hint if the winning rule's cmd() throws).
 */
export function buildNextSteps(cmd: string, result: unknown, opts: unknown): NextStepHint[] {
  const matches: NextStepRule[] = [];
  for (const rule of NEXT_STEP_RULES) {
    if (rule.command !== cmd) continue;
    if (rule.match !== undefined) {
      try {
        if (!rule.match(result, opts)) continue;
      } catch (e) {
        process.stderr.write(
          `note: agent-hints predicate for "${rule.command}" threw (${(e as Error).message}); skipping rule\n`,
        );
        continue;
      }
    }
    matches.push(rule);
  }
  if (matches.length === 0) return [];
  // Stable sort by specificity (descending). Array order within same tier is
  // preserved by stable .sort() in Node 12+.
  matches.sort((a, b) => specificity(b) - specificity(a));
  const top = matches[0];
  if (top === undefined) return [];
  let cmds: string | string[];
  try {
    cmds = top.cmd(result, opts);
  } catch (e) {
    process.stderr.write(
      `note: agent-hints cmd for "${top.command}" threw (${(e as Error).message}); skipping hint\n`,
    );
    return [];
  }
  const cmdArr = Array.isArray(cmds) ? cmds : [cmds];
  return cmdArr.map((c) => ({ cmd: c, why: top.why, lifecycle: top.lifecycle }));
}

/**
 * withNextSteps — pure helper to add `nextSteps` to a JSON payload.
 *
 * Identity when hints is empty: returns the same reference, preserving
 * byte-identical backwards compatibility with stdout JSON of all existing
 * commands that emit `{ ok: true, ... }`.
 *
 * Non-empty: appends `nextSteps` at the END of the field order (Object
 * spread preserves insertion order in V8). This keeps the most-likely-
 * consumed fields (`ok`, `id`, `snapshot`) at the head of the JSON.
 */
export function withNextSteps<T extends Record<string, unknown>>(
  payload: T,
  hints: NextStepHint[],
): T | (T & { nextSteps: NextStepHint[] }) {
  if (hints.length === 0) return payload;
  return { ...payload, nextSteps: hints };
}

/**
 * Opts shape consumed by printNextStepHintLine. `nextHint` is parsed from
 * commander's --no-next-hint flag (default true; --no-next-hint flips to
 * false). Keep the field name in sync with addNextHintFlag below — Commander
 * derives the property name from `--no-next-hint` → `nextHint: boolean`.
 */
export interface NextStepHintOpts {
  nextHint?: boolean;
}

export interface NextStepHintDetail {
  /** human-readable mutation context: 'rule 123' / 'variable global/x' / 'login' */
  contextLabel?: string;
}

/**
 * printNextStepHintLine — write one stderr `note:` line per hint, bold-yellow
 * when stderr is a TTY (honours NO_COLOR + XGG_NO_NEXT_HINT). No-op when
 * hints is empty or opt-out is active.
 *
 * Line format (matches printRefreshHint conventions for the `note:` prefix):
 *   note: [<contextLabel>] next → <cmd>  # <why>
 *
 * Multi-cmd hints (same rule, multiple cmds) emit as multiple independent
 * lines so human grep and agent prompt parsing both stay simple.
 */
export function printNextStepHintLine(
  hints: NextStepHint[],
  opts: NextStepHintOpts,
  detail?: NextStepHintDetail,
): void {
  if (hints.length === 0) return;
  if (opts.nextHint === false) return;
  if (process.env.XGG_NO_NEXT_HINT === '1') return;
  for (const hint of hints) {
    const parts = ['note:'];
    if (detail?.contextLabel) parts.push(`[${detail.contextLabel}]`);
    parts.push(`next → ${hint.cmd}  # ${hint.why}`);
    const line = `${ttyBoldYellow(process.stderr, parts.join(' '))}\n`;
    process.stderr.write(line);
  }
}

/**
 * Convenience: returns true when EITHER --no-next-hint flag is set OR
 * XGG_NO_NEXT_HINT=1 is in the environment. Use this at the call site
 * to decide whether to attach nextSteps to the JSON payload.
 *
 * printNextStepHintLine self-checks the same conditions internally —
 * this helper only matters for the stdout JSON branch. Spec §6.4 requires
 * BOTH channels honour the env var, so call sites must gate the JSON
 * payload through this helper before `withNextSteps()`.
 */
export function nextHintOptedOut(opts: NextStepHintOpts): boolean {
  return opts.nextHint === false || process.env.XGG_NO_NEXT_HINT === '1';
}

/**
 * Attach the --no-next-hint flag to a commander command. Mirrors
 * addRefreshHintFlag at _mutation-guard.ts:140-152 — same naming
 * convention so the two opt-out flags read consistently in --help.
 */
export function addNextHintFlag<T extends Command>(c: T): T {
  c.addOption(
    new Option(
      '--no-next-hint',
      'suppress the post-action "next →" lifecycle hint (env: XGG_NO_NEXT_HINT=1)',
    ).default(true),
  );
  return c;
}
