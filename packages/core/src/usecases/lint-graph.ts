import { NodeUnion } from '../schemas/nodes/index.js';
import { arePinColorsCompatible, resolvePinColor } from './pin-colors.js';
import { TYPED_SCHEMAS, checkNodeStrict } from './typed-schemas.js';

export interface LintIssue {
  severity: 'warn' | 'error';
  path: string;
  message: string;
}

export interface LintGraphInput {
  graph: {
    id: string;
    nodes?: unknown[];
  };
  devices?: Record<string, { pushAvailable?: boolean }>;
  strict?: boolean;
}

// F62 (2026-05-30): derive from TYPED_SCHEMAS so the two stay in lockstep.
// "Known" == "we have a strict schema for it"; anything else is forward-compat.
const KNOWN_NODE_TYPES = new Set<string>(Object.keys(TYPED_SCHEMAS));

/** Client-side linter: surfaces edge-format errors and semantic smells
 *  that the gateway accepts silently. */
export function lintGraph(input: LintGraphInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const nodes = input.graph.nodes;
  if (!nodes) return issues;

  // Phase 1: parse each node, collect valid ids.
  const parsed: Array<{ node: Record<string, unknown>; idx: number }> = [];
  const nodeIds = new Set<string>();
  const nodesById = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < nodes.length; i++) {
    const raw = nodes[i];
    const result = NodeUnion.safeParse(raw);

    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? 'schema error';
      issues.push({ severity: 'error', path: `nodes[${i}]`, message: msg });
      continue;
    }

    const node = result.data as Record<string, unknown>;
    const nodeType = node.type as string;
    const nodeId = node.id as string;

    if (!KNOWN_NODE_TYPES.has(nodeType)) {
      issues.push({
        severity: 'warn',
        path: `nodes[${i}]`,
        message: `unknown type "${nodeType}" — UnknownNode fallback`,
      });
    } else {
      // F62 (2026-05-30) — NodeUnion's UnknownNode fallback (z.union arms
      // try in order, last is UnknownNode.passthrough) masks broken
      // modeled nodes: e.g. `deviceInputSetVar{eiid, arguments:[]}` is
      // rejected by DeviceInputSetVarNode (F61 .min(1)) but accepted by
      // UnknownNode, so safeParse returns success and the per-type
      // violation is silently swallowed. Re-check via the strict schema
      // map (same map that validate-graph's F24 keystone uses) and emit
      // an error so `xgg rule lint` matches the rule-set/enable
      // rejection. We KEEP the node in `parsed`/`nodesById`/`nodeIds` so
      // phase-2 edge checks don't cascade dangling-target errors against
      // a node that merely failed strict shape.
      const strict = checkNodeStrict(node);
      if (strict !== null) {
        const where = strict.field ? ` at ${strict.field}` : '';
        issues.push({
          severity: 'error',
          path: `nodes[${i}]`,
          message: `${nodeType} node failed its strict schema${where}: ${strict.message}`,
        });
      }
    }

    if (nodeType === 'deviceInput') {
      const props = (node.props ?? {}) as Record<string, unknown>;
      const did = typeof props.did === 'string' ? props.did : undefined;
      const isStateMode = props.piid !== undefined && props.eiid === undefined;
      if (did !== undefined && isStateMode && input.devices?.[did]?.pushAvailable === false) {
        issues.push({
          severity: 'warn',
          path: `nodes[${i}]`,
          message:
            'deviceInput state-mode on pushAvailable:false device — input never fires (F17). Use deviceGet or register.',
        });
      }
    }

    nodeIds.add(nodeId);
    nodesById.set(nodeId, node);
    parsed.push({ node, idx: i });
  }

  // Phase 2: check edges on each successfully-parsed node.
  // Also collect every edge target string ("<dstId>.<dstPin>") so a later pass
  // can flag required state-input pins that nothing feeds.
  const edgeTargets = new Set<string>();
  for (const { node, idx } of parsed) {
    const outputs = node.outputs;
    if (!outputs || typeof outputs !== 'object') continue;

    for (const [pin, arr] of Object.entries(outputs as Record<string, unknown>)) {
      if (!Array.isArray(arr)) continue;

      const seen = new Set<string>();
      let hasDuplicate = false;

      for (let j = 0; j < arr.length; j++) {
        if (typeof arr[j] === 'string') edgeTargets.add(arr[j] as string);
        const entry = arr[j];
        const edgePath = `nodes[${idx}].outputs.${pin}[${j}]`;

        if (entry === '') {
          issues.push({
            severity: 'error',
            path: edgePath,
            message: 'empty edge string (gateway rejects)',
          });
          continue;
        }

        if (typeof entry !== 'string') {
          issues.push({
            severity: 'error',
            path: edgePath,
            message: 'edge must be a string',
          });
          continue;
        }

        const dotIdx = entry.indexOf('.');
        if (dotIdx === -1) {
          issues.push({
            severity: 'error',
            path: edgePath,
            message: 'malformed edge (no dot separator; gateway rejects)',
          });
          continue;
        }

        const targetId = entry.slice(0, dotIdx);

        if (entry.indexOf('.', dotIdx + 1) !== -1) {
          // F66b (2026-05-31) — promoted to error. Bundle connectTool.connect
          // splits via ml() at the first dot only; everything after the
          // second dot is silently dropped, leaving a runtime-dangling wire
          // whose target is the wrong pin. F62 strict Connection schema
          // already rejects the 3-part string; this lint-level promotion
          // catches it on `rule lint` / setGraph paths too.
          issues.push({
            severity: 'error',
            path: edgePath,
            message:
              'edge string contains multiple dots (gateway accepts; only first dot is split)',
          });
        }

        const sourceId = node.id as string;
        if (targetId === sourceId) {
          issues.push({
            severity: 'warn',
            path: edgePath,
            message: 'self-loop (gateway accepts; suspicious)',
          });
        }

        if (!nodeIds.has(targetId)) {
          issues.push({
            severity: 'error',
            path: edgePath,
            message: `dangling edge: target node "${targetId}" not in graph`,
          });
        } else {
          // F29: pin event/state color legality. The canvas refuses a wire from
          // an event output into a state-only input (or vice versa); it saves
          // via the CLI but is runtime-dead. Only checked when both pin colors
          // resolve — an unknown type/pin skips (forward-compat, no false flag).
          const targetNode = nodesById.get(targetId);
          if (targetNode !== undefined) {
            const targetPin = entry.slice(dotIdx + 1);
            const srcColor = resolvePinColor(
              node.type as string,
              pin,
              'output',
              node.props as Record<string, unknown> | undefined,
            );
            const tgtColor = resolvePinColor(
              targetNode.type as string,
              targetPin,
              'input',
              targetNode.props as Record<string, unknown> | undefined,
            );
            if (arePinColorsCompatible(srcColor, tgtColor) === false) {
              issues.push({
                severity: 'error',
                path: edgePath,
                message: `cross-color edge: ${srcColor} output "${pin}" → ${tgtColor} input "${targetPin}" (canvas-illegal, runtime-dead)`,
              });
            }
          }
        }

        if (seen.has(entry)) {
          hasDuplicate = true;
        }
        seen.add(entry);
      }

      if (hasDuplicate) {
        // F66b (2026-05-31) — promoted to error. Bundle connectTool.connect
        // refuses a second identical edge (`-1===o.outputs[n.connect]
        // .indexOf(m)`). The gateway dispatcher fires downstream once per
        // array entry, so an accepted duplicate means the deviceOutput
        // executes N times per upstream trigger — a shape the UI never
        // produces. F28 addEdge already throws; align lint at error so
        // `rule lint` / setGraph bodies are gated identically.
        issues.push({
          severity: 'error',
          path: `nodes[${idx}].outputs.${pin}`,
          message: 'duplicate edge entries (gateway accepts; canvas refuses second identical wire)',
        });
      }
    }
  }

  // A `condition` node whose `condition` input has no incoming edge has no state
  // source feeding the gate. A canvas-authored condition always wires one
  // (timeRange / logic / varGet / deviceInput); the CLI funnel can't "see" the
  // empty pin the way the canvas does. Verified against the real gateway: an
  // unconnected condition defaults to FALSE, so ONLY the `unmet` branch fires
  // and `met` is dead.
  for (const { node, idx } of parsed) {
    if (node.type !== 'condition') continue;
    const id = node.id as string;
    if (!edgeTargets.has(`${id}.condition`)) {
      issues.push({
        severity: 'warn',
        path: `nodes[${idx}]`,
        message: `condition node "${id}" condition input has no incoming edge — gateway defaults it to FALSE (verified), so only the "unmet" branch fires and "met" is dead. Wire a state source (timeRange/logic/varGet/deviceInput) into ${id}.condition.`,
      });
    }
  }

  return issues;
}
