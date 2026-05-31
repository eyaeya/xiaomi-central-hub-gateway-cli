// F63b (2026-05-30) — graph-level reachability gate for `rule enable`.
//
// Story: a rule whose action card (deviceOutput / varSetNumber / varSetString /
// deviceGetSetVar) is in a weakly-connected component with NO trigger card
// (onLoad / alarmClock / deviceInput / loop / timeRange / varChange / register /
// deviceInputSetVar) can be saved + enabled by the gateway, but it will never
// fire. The official web UI hides this trap because save() runs from the same
// canvas you wire on, so a fully-disconnected sink is visually obvious; the
// CLI's save-then-enable split makes it possible to enable a never-fires graph.
//
// This is the universal funnel where the new check belongs (memory:
// feedback-gate-on-agent-funnel-paths). Wired into validate-graph at the end of
// the per-node loop so per-card 卡片配置有误 errors still win priority — a sink
// that fails its own schema check is more actionable than a reachability one.
//
// `deviceInputSetVar` is the subtle case: per the node schemas it is BOTH a
// trigger (`inputs: z.object({}).strict()` == self-firing) AND it writes a
// variable. A standalone deviceInputSetVar with no edges is a complete
// automation. We therefore classify it as a TRIGGER for the purposes of
// reachability (it cannot be a dangling sink).

import { NodeUnion } from '../schemas/nodes/index.js';
import type { LintIssue } from './lint-graph.js';

// Self-firing nodes: their `inputs` schema is empty, or they are bootstrapped
// internally by the runtime even when wired (loop start/stop, register
// setTrue/setFalse). A graph component containing any of these can fire.
const TRIGGER_TYPES = new Set<string>([
  'onLoad',
  'alarmClock',
  'deviceInput',
  'deviceInputSetVar',
  'loop',
  'register',
  'timeRange',
  'varChange',
]);

// Action / writer nodes: if one of these sits in a component with no trigger,
// the rule is silently dead. (deviceInputSetVar is intentionally NOT here —
// see classification note above.)
const SINK_TYPES = new Set<string>([
  'deviceOutput',
  'deviceGetSetVar',
  'varSetNumber',
  'varSetString',
]);

interface ParsedNode {
  id: string;
  type: string;
  outputs?: Record<string, unknown>;
}

function parseNodes(rawNodes: unknown[]): ParsedNode[] {
  const out: ParsedNode[] = [];
  for (const raw of rawNodes) {
    const result = NodeUnion.safeParse(raw);
    if (!result.success) continue;
    const node = result.data as Record<string, unknown>;
    const id = node.id;
    const type = node.type;
    if (typeof id !== 'string' || typeof type !== 'string') continue;
    const outputs =
      node.outputs && typeof node.outputs === 'object' && !Array.isArray(node.outputs)
        ? (node.outputs as Record<string, unknown>)
        : undefined;
    out.push(outputs !== undefined ? { id, type, outputs } : { id, type });
  }
  return out;
}

// Union-Find on node ids for weakly-connected components.
function makeUF(ids: string[]): {
  find: (x: string) => string;
  union: (a: string, b: string) => void;
} {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

/**
 * Reachability check: every weakly-connected component that contains a sink
 * must also contain at least one trigger. Emits one error per dangling sink.
 *
 * Edges are extracted from `node.outputs[pin][i]` strings of form
 * `targetId.targetPin`. Edges with malformed strings, dangling targets, or
 * unparseable target nodes are skipped — those failure modes are surfaced
 * elsewhere (lint-graph phase-2 / per-card schema checks).
 *
 * Unknown node types (forward-compat UnknownNode fallback) are skipped from
 * sink classification so we never false-flag a future node type.
 */
export function checkReachability(rawNodes: unknown[]): LintIssue[] {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return [];

  const parsed = parseNodes(rawNodes);
  if (parsed.length === 0) return [];

  const ids = parsed.map((n) => n.id);
  const idSet = new Set(ids);
  const uf = makeUF(ids);

  for (const node of parsed) {
    const outputs = node.outputs;
    if (outputs === undefined) continue;
    for (const arr of Object.values(outputs)) {
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (typeof entry !== 'string') continue;
        const dot = entry.indexOf('.');
        if (dot === -1) continue;
        const targetId = entry.slice(0, dot);
        if (!idSet.has(targetId)) continue;
        uf.union(node.id, targetId);
      }
    }
  }

  // Bucket nodes by component root.
  const triggersByRoot = new Map<string, number>();
  const sinksByRoot = new Map<string, Array<{ idx: number; node: ParsedNode }>>();
  // Original index for path reporting. We need to map the parsed node back to
  // its index in the raw `rawNodes` array — keep aligned by walking both.
  const parsedIndexById = new Map<string, number>();
  for (let i = 0; i < rawNodes.length; i += 1) {
    const result = NodeUnion.safeParse(rawNodes[i]);
    if (!result.success) continue;
    const id = (result.data as Record<string, unknown>).id;
    if (typeof id === 'string') parsedIndexById.set(id, i);
  }

  for (const node of parsed) {
    const root = uf.find(node.id);
    if (TRIGGER_TYPES.has(node.type)) {
      triggersByRoot.set(root, (triggersByRoot.get(root) ?? 0) + 1);
    }
    if (SINK_TYPES.has(node.type)) {
      const list = sinksByRoot.get(root) ?? [];
      const idx = parsedIndexById.get(node.id) ?? -1;
      list.push({ idx, node });
      sinksByRoot.set(root, list);
    }
  }

  const issues: LintIssue[] = [];
  for (const [root, sinks] of sinksByRoot.entries()) {
    if ((triggersByRoot.get(root) ?? 0) > 0) continue;
    for (const { idx, node } of sinks) {
      issues.push({
        severity: 'error',
        path: idx >= 0 ? `nodes[${idx}]` : `nodes.${node.id}`,
        message: `卡片不可达: ${node.type} sink "${node.id}" has no upstream trigger (onLoad/alarmClock/deviceInput/varChange/timeRange/loop/register/deviceInputSetVar) — rule will never fire this action`,
      });
    }
  }
  return issues;
}
