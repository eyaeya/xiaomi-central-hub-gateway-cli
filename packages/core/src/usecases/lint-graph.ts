import {
  editorNodeIdCompatibilityMessage,
  isEditorCompatibleNodeId,
} from '../schemas/node-identifier.js';
import { NodeUnion } from '../schemas/nodes/index.js';
import { devicePushCapabilityMessage, isDevicePushSourceCard } from './device-card-capabilities.js';
import { isModeledNodeType, targetInputPinStatus } from './edge-integrity.js';
import {
  duplicateNodeIdIssues,
  findDuplicateNodeIds,
  missingRequiredInputIssues,
} from './graph-invariants.js';
import { arePinColorsCompatible, resolvePinColor } from './pin-colors.js';
import { checkNodeStrict } from './typed-schemas.js';

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

function editorNodeIdCompatibilityIssue(
  node: Record<string, unknown>,
  index: number,
): LintIssue | null {
  if (typeof node.type !== 'string' || typeof node.id !== 'string') return null;
  if (isEditorCompatibleNodeId(node.id)) return null;
  return {
    severity: 'warn',
    path: `nodes[${index}].id`,
    message: editorNodeIdCompatibilityMessage(node.id),
  };
}

/** Advisory only: never rewrites or rejects persisted legacy node ids. */
export function editorNodeIdCompatibilityIssues(nodes: readonly unknown[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const legacyIds = new Set<string>();
  for (let index = 0; index < nodes.length; index += 1) {
    const raw = nodes[index];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const node = raw as Record<string, unknown>;
    const compatibility = editorNodeIdCompatibilityIssue(node, index);
    if (compatibility !== null) {
      issues.push(compatibility);
      legacyIds.add(node.id as string);
    }
  }

  // Every graph edge is source-owned: the source identity is implicit in the
  // node containing outputs, while the target identity is stored as
  // "nodeId.pin". Report the exact stored reference whenever either endpoint
  // uses a legacy id, so an eventual atomic migration has an auditable
  // rewrite inventory instead of only a node-level warning.
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const raw = nodes[nodeIndex];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const node = raw as Record<string, unknown>;
    const outputs = node.outputs;
    if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) continue;
    const sourceId = typeof node.id === 'string' ? node.id : undefined;
    for (const [pin, targets] of Object.entries(outputs)) {
      if (!Array.isArray(targets)) continue;
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        const target = targets[targetIndex];
        if (typeof target !== 'string') continue;
        const affectedIds = [...legacyIds].filter(
          (id) => id === sourceId || target.startsWith(`${id}.`),
        );
        if (affectedIds.length === 0) continue;
        issues.push({
          severity: 'warn',
          path: `nodes[${nodeIndex}].outputs.${pin}[${targetIndex}]`,
          message: `edge ${JSON.stringify(`${sourceId ?? '<unknown>'}.${pin} -> ${target}`)} is affected by non-editor-compatible node id(s): ${affectedIds.map((id) => JSON.stringify(id)).join(', ')}. The stored endpoint remains unchanged; migrate the whole graph atomically before renaming any id.`,
        });
      }
    }
  }
  return issues;
}

/** Client-side linter: surfaces edge-format errors and semantic smells
 *  that the gateway accepts silently. */
export function lintGraph(input: LintGraphInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const nodes = input.graph.nodes;
  if (!nodes) return issues;

  // Graph identity must be checked before nodesById is constructed: assigning
  // duplicate ids into a Map silently makes the later node overwrite the
  // earlier one and corrupts every endpoint lookup that follows.
  const duplicateGroups = findDuplicateNodeIds(nodes);
  issues.push(...duplicateNodeIdIssues(duplicateGroups));
  const duplicateIds = new Set(duplicateGroups.map((group) => group.id));
  issues.push(...editorNodeIdCompatibilityIssues(nodes));

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

    if (!isModeledNodeType(nodeType)) {
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

    if (isDevicePushSourceCard(nodeType)) {
      const props = (node.props ?? {}) as Record<string, unknown>;
      const did = typeof props.did === 'string' ? props.did : undefined;
      const isPushMode = Number.isInteger(props.piid) || Number.isInteger(props.eiid);
      const pushAvailable = did === undefined ? undefined : input.devices?.[did]?.pushAvailable;
      if (did !== undefined && isPushMode && pushAvailable === false) {
        const message = devicePushCapabilityMessage(nodeType, did, pushAvailable);
        issues.push({
          severity: 'warn',
          path: `nodes[${i}].props.did`,
          message: `${message}. --allow-no-push is transient probe intent and is not persisted; use deviceGet/deviceGetSetVar for an active read, or verify this source on the target gateway.`,
        });
      }
    }

    nodeIds.add(nodeId);
    if (!duplicateIds.has(nodeId)) nodesById.set(nodeId, node);
    parsed.push({ node, idx: i });
  }

  // Phase 2: check edges on each successfully-parsed node.
  // Also collect every edge target string ("<dstId>.<dstPin>") so a later pass
  // can flag required state-input pins that nothing feeds.
  const edgeTargets = new Set<string>();
  // Canvas fan-in is keyed by the full target endpoint. Keep source endpoints
  // unique so a repeated identical edge retains the existing duplicate-edge
  // diagnosis, while another output on the same source node still counts as a
  // distinct incoming wire.
  const incomingByTarget = new Map<string, Map<string, string>>();
  for (const { node, idx } of parsed) {
    const outputs = node.outputs;
    if (!outputs || typeof outputs !== 'object') continue;

    for (const [pin, arr] of Object.entries(outputs as Record<string, unknown>)) {
      if (!Array.isArray(arr)) continue;

      const seen = new Set<string>();
      let hasDuplicate = false;

      for (let j = 0; j < arr.length; j++) {
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
            // GitHub #96 — the official canvas permits same-node feedback,
            // and some cards have finite control paths (for example
            // loop.output -> loop.stop). Keep the risk visible in every lint
            // mode without treating all self-loops as invalid topology.
            severity: 'warn',
            path: edgePath,
            message: 'self-loop (gateway and canvas accept; verify feedback terminates)',
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
            const pinStatus = targetInputPinStatus(targetNode, targetPin);
            if (pinStatus === 'invalid') {
              const availablePins = Object.keys(
                typeof targetNode.inputs === 'object' &&
                  targetNode.inputs !== null &&
                  !Array.isArray(targetNode.inputs)
                  ? targetNode.inputs
                  : {},
              );
              const available =
                availablePins.length > 0
                  ? `available: ${availablePins.join(', ')}`
                  : 'node has no input pins';
              issues.push({
                severity: 'error',
                path: edgePath,
                message: `target input pin "${targetPin}" does not exist on modeled ${String(targetNode.type)} node "${targetId}" (${available})`,
              });
            } else {
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

              edgeTargets.add(entry);
              const sourceEndpoint = `${sourceId}.${pin}`;
              const incoming = incomingByTarget.get(entry) ?? new Map<string, string>();
              if (!incoming.has(sourceEndpoint) && incoming.size > 0) {
                const existingSource = incoming.keys().next().value as string;
                issues.push({
                  severity: 'error',
                  path: edgePath,
                  message: `fan-in cap: input pin "${entry}" is already wired from ${existingSource}; cannot also wire ${sourceEndpoint} (canvas-illegal — "一个输入节点只能连一条线")`,
                });
              }
              incoming.set(sourceEndpoint, edgePath);
              incomingByTarget.set(entry, incoming);
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

  // Required-input policy is intentionally selective. Strict write/enable
  // gates reject incomplete nodes, while advisory lint preserves warnings for
  // authors assembling a graph incrementally.
  issues.push(...missingRequiredInputIssues(parsed, edgeTargets, input.strict === true));

  return issues;
}
