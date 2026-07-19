// F63b (2026-05-30) / GitHub #25 (2026-07-19) — graph-level directed
// reachability gate for `rule enable` and `rule lint --strict`.
//
// GitHub #64 refines that gate from node-level BFS to an endpoint-aware,
// monotone fixed point. Runtime-driving events and supporting state are
// deliberately separate facts: timeRange can satisfy condition.condition,
// for example, but cannot bootstrap condition.trigger or an action by itself.

import { NodeUnion } from '../schemas/nodes/index.js';
import { isModeledNodeType, targetInputPinStatus } from './edge-integrity.js';
import {
  duplicateNodeIdIssues,
  findDuplicateNodeIds,
  requiredInputPins,
} from './graph-invariants.js';
import type { LintIssue } from './lint-graph.js';
import {
  INDEPENDENT_EVENT_SOURCE_TYPES,
  inputPropagatesEventReachability,
  isIndependentEventSourceType,
  isIndependentStateSourceType,
  resolvePinColor,
} from './pin-colors.js';

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
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

interface DirectedEdge {
  sourceEndpoint: string;
  targetEndpoint: string;
  targetNodeId: string;
  targetPin: string;
}

interface InputRequirement {
  mode: 'any' | 'all';
  pins: string[];
}

interface ActivationPolicy {
  event?: InputRequirement;
  state?: InputRequirement;
  eventRequiresState?: true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
    out.push({
      id,
      type,
      idx,
      raw: node,
      inputs: asRecord(node.inputs),
      outputs: asRecord(node.outputs),
    });
  }
  return out;
}

function activationPolicy(
  node: ParsedNode,
  observedIncomingPins: readonly string[],
): ActivationPolicy {
  const declaredPins = [...new Set([...Object.keys(node.inputs), ...observedIncomingPins])];
  const requiredPins = requiredInputPins(node.raw);
  const all = (pins: string[]): InputRequirement => ({ mode: 'all', pins });
  const any = (pins: string[]): InputRequirement => ({ mode: 'any', pins });

  // UnknownNode deliberately permits firmware cards whose input declaration
  // is absent or unfamiliar. Derive their candidate pins from real incoming
  // edges and preserve event/state facts independently through an optimistic
  // ANY-input pass-through; never promote them to independent sources.
  if (!isModeledNodeType(node.type)) {
    return {
      event: any(declaredPins),
      state: any(declaredPins),
    };
  }

  switch (node.type) {
    case 'eventSequence':
      return { event: all(requiredPins) };
    case 'condition':
      return {
        event: all(['trigger']),
        // condition.condition is optional for graph validity, but a wired
        // value still controls which output branch can run.
        state: all(['condition']),
      };
    case 'logicAnd':
      return {
        event: any(requiredPins),
        state: all(requiredPins),
        eventRequiresState: true,
      };
    case 'logicOr':
      return {
        event: any(declaredPins),
        state: any(declaredPins),
        eventRequiresState: true,
      };
    case 'signalOr':
      return { event: any(declaredPins) };
    case 'loop':
      return { event: all(['start']) };
    case 'onlyNTimes':
      return { event: all(['input']) };
    case 'counter':
      // The gateway's zero-path output behavior is not sufficiently evidenced
      // to reject it. Preserve the prior optimistic ANY behavior for now.
      return { event: any(['input', 'zero']) };
    case 'register':
      return { event: any(['setTrue', 'setFalse']) };
    case 'statusLast':
      // This card is the explicit state-to-event bridge: a true state held
      // for the configured duration emits even without a separate event pin.
      return { state: all(['input']) };
    default: {
      const eventPins = declaredPins.filter(
        (pin) => inputPropagatesEventReachability(node.type, pin) !== false,
      );
      const statePins = declaredPins.filter(
        (pin) => resolvePinColor(node.type, pin, 'input', asRecord(node.raw.props)) === 'state',
      );
      return {
        ...(eventPins.length > 0 ? { event: any(eventPins) } : {}),
        ...(statePins.length > 0 ? { state: any(statePins) } : {}),
        ...(statePins.length > 0 ? { eventRequiresState: true as const } : {}),
      };
    }
  }
}

function directedEdges(
  nodes: ParsedNode[],
  nodesById: ReadonlyMap<string, ParsedNode>,
): DirectedEdge[] {
  const edges: DirectedEdge[] = [];
  for (const node of nodes) {
    for (const [sourcePin, values] of Object.entries(node.outputs)) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value !== 'string') continue;
        const dot = value.indexOf('.');
        if (dot <= 0 || dot === value.length - 1 || value.indexOf('.', dot + 1) !== -1) continue;
        const targetId = value.slice(0, dot);
        const targetPin = value.slice(dot + 1);
        const target = nodesById.get(targetId);
        if (target === undefined || targetInputPinStatus(target.raw, targetPin) === 'invalid') {
          continue;
        }
        edges.push({
          sourceEndpoint: `${node.id}.${sourcePin}`,
          targetEndpoint: `${targetId}.${targetPin}`,
          targetNodeId: targetId,
          targetPin,
        });
      }
    }
  }
  return edges;
}

function requirementSatisfied(
  nodeId: string,
  requirement: InputRequirement | undefined,
  incomingByTarget: ReadonlyMap<string, readonly DirectedEdge[]>,
  factAvailable: (pin: string, sourceEndpoint: string) => boolean,
): boolean {
  if (requirement === undefined || requirement.pins.length === 0) return false;
  const satisfied = (pin: string): boolean =>
    (incomingByTarget.get(`${nodeId}.${pin}`) ?? []).some((edge) =>
      factAvailable(pin, edge.sourceEndpoint),
    );
  return requirement.mode === 'all'
    ? requirement.pins.every(satisfied)
    : requirement.pins.some(satisfied);
}

function inputPinHasFact(
  nodeId: string,
  pin: string,
  incomingByTarget: ReadonlyMap<string, readonly DirectedEdge[]>,
  facts: ReadonlySet<string>,
): boolean {
  return (incomingByTarget.get(`${nodeId}.${pin}`) ?? []).some((edge) =>
    facts.has(edge.sourceEndpoint),
  );
}

function allPinsCanBeFalse(
  nodeId: string,
  pins: readonly string[],
  incomingByTarget: ReadonlyMap<string, readonly DirectedEdge[]>,
  falseStateOutputs: ReadonlySet<string>,
): boolean {
  return (
    pins.length > 0 &&
    pins.every((pin) => {
      const incoming = incomingByTarget.get(`${nodeId}.${pin}`) ?? [];
      // Unwired logicOr inputs have the gateway's default false value, but do
      // not themselves manufacture state availability or runtime activity.
      return (
        incoming.length === 0 || incoming.some((edge) => falseStateOutputs.has(edge.sourceEndpoint))
      );
    })
  );
}

function addFact(set: Set<string>, value: string): boolean {
  if (set.has(value)) return false;
  set.add(value);
  return true;
}

/**
 * Check that every action/writer sink has a satisfiable upstream event path.
 *
 * Facts are attached to output endpoints, not merely nodes. A monotone fixed
 * point aggregates the exact target pins required by multi-input cards. Event
 * facts drive runtime work. State availability, may-true, and may-false are
 * separate monotone facts so a known false value cannot satisfy a true-only
 * card such as statusLast. Unknown future cards retain optimistic pass-through
 * behavior once reached, while never being guessed to be an independent source
 * or sink.
 */
export function checkReachability(rawNodes: unknown[]): LintIssue[] {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return [];
  const identityIssues = duplicateNodeIdIssues(findDuplicateNodeIds(rawNodes));
  if (identityIssues.length > 0) return identityIssues;

  const parsed = parseNodes(rawNodes);
  if (parsed.length === 0) return [];

  const nodesById = new Map(parsed.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, DirectedEdge[]>();
  const incomingPinsByNode = new Map<string, Set<string>>();
  for (const edge of directedEdges(parsed, nodesById)) {
    const incoming = incomingByTarget.get(edge.targetEndpoint) ?? [];
    incoming.push(edge);
    incomingByTarget.set(edge.targetEndpoint, incoming);
    const incomingPins = incomingPinsByNode.get(edge.targetNodeId) ?? new Set<string>();
    incomingPins.add(edge.targetPin);
    incomingPinsByNode.set(edge.targetNodeId, incomingPins);
  }

  const eventNodes = new Set<string>();
  const stateNodes = new Set<string>();
  const eventOutputs = new Set<string>();
  const stateOutputs = new Set<string>();
  const trueStateOutputs = new Set<string>();
  const falseStateOutputs = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of parsed) {
      const policy = activationPolicy(node, [...(incomingPinsByNode.get(node.id) ?? [])]);
      const eventInputsReady = requirementSatisfied(
        node.id,
        policy.event,
        incomingByTarget,
        (pin, sourceEndpoint) => {
          if (!eventOutputs.has(sourceEndpoint)) return false;
          // A state input is "updating" only when the same source endpoint
          // provides both a state value and an event-driving path. This keeps
          // an event-only cross-color edge from manufacturing logic reachability.
          const targetColor = resolvePinColor(node.type, pin, 'input', asRecord(node.raw.props));
          return targetColor !== 'state' || stateOutputs.has(sourceEndpoint);
        },
      );
      // The gateway evaluates an unwired condition.condition input as false.
      // Preserve that card-specific default without treating arbitrary absent
      // state inputs as available or overriding a real incoming condition edge.
      const conditionDefaultsFalse =
        node.type === 'condition' &&
        (incomingByTarget.get(`${node.id}.condition`) ?? []).length === 0;
      const stateInputsReady =
        conditionDefaultsFalse ||
        requirementSatisfied(node.id, policy.state, incomingByTarget, (_pin, sourceEndpoint) =>
          stateOutputs.has(sourceEndpoint),
        );
      const trueStateInputsReady =
        !conditionDefaultsFalse &&
        requirementSatisfied(node.id, policy.state, incomingByTarget, (_pin, sourceEndpoint) =>
          trueStateOutputs.has(sourceEndpoint),
        );
      const falseStateInputsReady =
        conditionDefaultsFalse ||
        requirementSatisfied(node.id, policy.state, incomingByTarget, (_pin, sourceEndpoint) =>
          falseStateOutputs.has(sourceEndpoint),
        );
      let eventReady =
        isIndependentEventSourceType(node.type) ||
        (eventInputsReady && (policy.eventRequiresState !== true || stateInputsReady));
      let stateReady =
        isIndependentStateSourceType(node.type) ||
        stateInputsReady ||
        // Event-driven dual-output cards (register/counter/property sources)
        // have a usable state after their driving path is reachable.
        eventReady;
      let stateMayBeTrue = stateReady;
      let stateMayBeFalse = stateReady;

      switch (node.type) {
        case 'register': {
          const setTrueReady = inputPinHasFact(node.id, 'setTrue', incomingByTarget, eventOutputs);
          // The register has an available false state before either setter
          // fires. A reachable setTrue adds may-true but never removes the
          // initial may-false fact from this path-insensitive fixed point.
          stateReady = true;
          stateMayBeTrue = setTrueReady;
          stateMayBeFalse = true;
          break;
        }
        case 'counter':
          // Counter starts at zero/false. Once either modeled control path is
          // live, retain the pre-#65 optimistic TOP truth domain; zero output
          // behavior is intentionally not tightened without gateway evidence.
          stateReady = true;
          stateMayBeTrue = eventReady;
          stateMayBeFalse = true;
          break;
        case 'condition':
          stateReady = false;
          stateMayBeTrue = false;
          stateMayBeFalse = false;
          break;
        case 'statusLast':
          // A state value is observable at the output, but only a may-true
          // input can complete the duration and emit an event.
          eventReady = trueStateInputsReady;
          stateReady = stateInputsReady;
          stateMayBeTrue = trueStateInputsReady;
          stateMayBeFalse = falseStateInputsReady;
          break;
        case 'logicAnd': {
          const pins = policy.state?.pins ?? [];
          stateReady = stateInputsReady;
          stateMayBeTrue = trueStateInputsReady;
          stateMayBeFalse =
            stateReady &&
            pins.some((pin) => inputPinHasFact(node.id, pin, incomingByTarget, falseStateOutputs));
          break;
        }
        case 'logicOr': {
          const pins = policy.state?.pins ?? [];
          stateReady = stateInputsReady;
          stateMayBeTrue = trueStateInputsReady;
          stateMayBeFalse =
            stateReady && allPinsCanBeFalse(node.id, pins, incomingByTarget, falseStateOutputs);
          break;
        }
        case 'logicNot':
          stateReady = stateInputsReady;
          stateMayBeTrue = falseStateInputsReady;
          stateMayBeFalse = trueStateInputsReady;
          break;
        default:
          // Modeled non-boolean dual outputs and unknown future cards remain
          // conservative TOP once their state domain is available.
          break;
      }

      if (eventReady) changed = addFact(eventNodes, node.id) || changed;
      if (stateReady) changed = addFact(stateNodes, node.id) || changed;

      for (const outputPin of Object.keys(node.outputs)) {
        const endpoint = `${node.id}.${outputPin}`;
        const color = resolvePinColor(node.type, outputPin, 'output', asRecord(node.raw.props));
        let eventOutputReady = eventReady;
        if (node.type === 'condition' && outputPin === 'met') {
          eventOutputReady = eventReady && trueStateInputsReady;
        } else if (node.type === 'condition' && outputPin === 'unmet') {
          eventOutputReady = eventReady && falseStateInputsReady;
        }
        if (eventOutputReady && color !== 'state') {
          changed = addFact(eventOutputs, endpoint) || changed;
        }
        if (stateReady && color !== 'event') {
          changed = addFact(stateOutputs, endpoint) || changed;
        }
        if (stateMayBeTrue && color !== 'event') {
          changed = addFact(trueStateOutputs, endpoint) || changed;
        }
        if (stateMayBeFalse && color !== 'event') {
          changed = addFact(falseStateOutputs, endpoint) || changed;
        }
      }
    }
  }

  const sourceList = INDEPENDENT_EVENT_SOURCE_TYPES.join('/');
  const issues: LintIssue[] = [];
  for (const node of parsed) {
    if (!SINK_TYPES.has(node.type) || eventNodes.has(node.id)) continue;
    issues.push({
      severity: 'error',
      path: `nodes[${node.idx}]`,
      message: `卡片不可达: ${node.type} sink "${node.id}" has no satisfiable upstream event path from an independent source (${sourceList}) under required-input semantics — rule will never fire this action`,
    });
  }
  return issues;
}
