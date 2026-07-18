// F63b (2026-05-30) / GitHub #25 (2026-07-19) — graph-level directed
// reachability gate for `rule enable` and `rule lint --strict`.
//
// A sink is statically reachable only when a card that can independently
// originate runtime activity has a valid source -> target path to it. Weak
// connectivity is insufficient: a downstream loop/register must not prove
// that an upstream action can ever run, and a timeRange state is not an event
// bootstrap. The independent-source and input-flow facts live beside the pin
// table in pin-colors.ts so lint, reachability, and CLI guidance cannot drift.

import { NodeUnion } from '../schemas/nodes/index.js';
import { targetInputPinStatus } from './edge-integrity.js';
import { duplicateNodeIdIssues, findDuplicateNodeIds } from './graph-invariants.js';
import type { LintIssue } from './lint-graph.js';
import {
  INDEPENDENT_EVENT_SOURCE_TYPES,
  inputPropagatesEventReachability,
  isIndependentEventSourceType,
} from './pin-colors.js';

// Action / writer nodes: each must have an upstream independent event source.
// deviceInputSetVar is intentionally not a sink: it is itself an independent
// device source which also writes a variable.
const SINK_TYPES = new Set<string>([
  'deviceOutput',
  'deviceGetSetVar',
  'varSetNumber',
  'varSetString',
]);

interface ParsedNode {
  id: string;
  type: string;
  idx: number;
  raw: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

function parseNodes(rawNodes: unknown[]): ParsedNode[] {
  const out: ParsedNode[] = [];
  for (let idx = 0; idx < rawNodes.length; idx += 1) {
    const result = NodeUnion.safeParse(rawNodes[idx]);
    if (!result.success) continue;
    const node = result.data as Record<string, unknown>;
    const id = node.id;
    const type = node.type;
    if (typeof id !== 'string' || typeof type !== 'string') continue;
    const outputs =
      node.outputs && typeof node.outputs === 'object' && !Array.isArray(node.outputs)
        ? (node.outputs as Record<string, unknown>)
        : undefined;
    out.push(
      outputs !== undefined ? { id, type, idx, raw: node, outputs } : { id, type, idx, raw: node },
    );
  }
  return out;
}

function directedTargets(node: ParsedNode, nodesById: ReadonlyMap<string, ParsedNode>): string[] {
  const targets: string[] = [];
  if (node.outputs === undefined) return targets;

  for (const arr of Object.values(node.outputs)) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (typeof entry !== 'string') continue;
      const dot = entry.indexOf('.');
      if (dot <= 0 || dot === entry.length - 1 || entry.indexOf('.', dot + 1) !== -1) continue;

      const targetId = entry.slice(0, dot);
      const targetPin = entry.slice(dot + 1);
      const targetNode = nodesById.get(targetId);
      if (targetNode === undefined) continue;
      if (targetInputPinStatus(targetNode.raw, targetPin) === 'invalid') continue;

      // condition.condition is supporting state rather than an event path;
      // loop.stop cannot start loop output. Unknown future cards return null
      // and remain traversable for forward compatibility.
      if (inputPropagatesEventReachability(targetNode.type, targetPin) === false) continue;
      targets.push(targetId);
    }
  }
  return targets;
}

/**
 * Check that every action/writer sink is reachable from an independent event
 * source by following valid edges in their source -> target direction.
 *
 * Malformed edges, dangling targets, invalid modeled target pins, and edges
 * that only update non-emitting control/state inputs do not participate. Those
 * edge-shape failures are diagnosed by lintGraph; excluding them here prevents
 * a second bug from manufacturing a false reachability proof.
 *
 * Unknown future node types may be intermediate vertices once reached from a
 * known source, but are never guessed to be a source or sink themselves.
 */
export function checkReachability(rawNodes: unknown[]): LintIssue[] {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return [];
  const identityIssues = duplicateNodeIdIssues(findDuplicateNodeIds(rawNodes));
  if (identityIssues.length > 0) return identityIssues;

  const parsed = parseNodes(rawNodes);
  if (parsed.length === 0) return [];

  const nodesById = new Map(parsed.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();
  for (const node of parsed) adjacency.set(node.id, directedTargets(node, nodesById));

  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const node of parsed) {
    if (!isIndependentEventSourceType(node.type)) continue;
    reachable.add(node.id);
    queue.push(node.id);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const sourceId = queue[head];
    if (sourceId === undefined) continue;
    for (const targetId of adjacency.get(sourceId) ?? []) {
      if (reachable.has(targetId)) continue;
      reachable.add(targetId);
      queue.push(targetId);
    }
  }

  const sourceList = INDEPENDENT_EVENT_SOURCE_TYPES.join('/');
  const issues: LintIssue[] = [];
  for (const node of parsed) {
    if (!SINK_TYPES.has(node.type) || reachable.has(node.id)) continue;
    issues.push({
      severity: 'error',
      path: `nodes[${node.idx}]`,
      message: `卡片不可达: ${node.type} sink "${node.id}" has no upstream independent event source (${sourceList}) along directed edges — rule will never fire this action`,
    });
  }
  return issues;
}
