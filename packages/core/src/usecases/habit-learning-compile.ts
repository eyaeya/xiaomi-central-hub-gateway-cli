import { createHash } from 'node:crypto';
import { resolveBundleCardGeometry, seedPosition } from '../resources/card-geometry.js';
import { type DeviceSpec, DeviceSpecSchema, type MiotProperty } from '../schemas/device-spec.js';
import {
  type HabitLearningPlan,
  HabitLearningPlanSchema,
  type HabitLearningSignal,
} from '../schemas/habit-learning.js';
import { isEditorCompatibleNodeId } from '../schemas/node-identifier.js';
import { GraphSetRequest, type GraphSetRequest as GraphSetRequestValue } from '../schemas/rule.js';
import { isValidVariableIdentifier } from '../schemas/variable-identifier.js';
import {
  VariableCreateRequest,
  type VariableCreateRequest as VariableCreateRequestValue,
} from '../schemas/variable.js';
import {
  type HabitLearningSourceMap,
  freezeHabitLearningSourceMap,
} from './habit-learning-observations.js';
import { layoutGraph } from './layout-graph.js';
import { lintGraph } from './lint-graph.js';

export const HABIT_LEARNING_COMPILE_VERSION = 1 as const;

const NODE_ID_HEX_LENGTH = 32;
const ALLOWED_OBSERVATION_NODE_TYPES = new Set(['deviceInput', 'deviceInputSetVar', 'signalOr']);

type CompiledObservationNode = {
  id: string;
  type: 'deviceInput' | 'deviceInputSetVar' | 'signalOr';
  cfg: {
    urn?: string;
    pos: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    name: string;
    version: number;
  };
  inputs: Record<string, null>;
  outputs: { output: string[] };
  props: Record<string, unknown>;
};

export type HabitLearningVariableSelector =
  | {
      kind: 'property';
    }
  | {
      kind: 'event-argument';
      piid: number;
      valueIndex: number;
    };

export interface HabitLearningLocalVariableDeclaration {
  /** The plan signal that owns this captured value. */
  signalId: string;
  /** The normalized-observation identity emitted by the source map. */
  sourceId: string;
  selector: HabitLearningVariableSelector;
  request: VariableCreateRequestValue;
}

export interface HabitLearningRuleDigests {
  /**
   * Execution and capture semantics. It deliberately excludes node positions,
   * compact-card markers, canvas transform, lifecycle enable state, and
   * human-facing labels.
   */
  semantic: string;
  /** Canvas transform and every node's position/size/compact-card marker. */
  layout: string;
}

export interface CompileHabitLearningRuleInput {
  plan: HabitLearningPlan;
  ruleId: string;
  ruleName?: string;
}

export interface CompiledHabitLearningRule {
  compileVersion: typeof HABIT_LEARNING_COMPILE_VERSION;
  planId: string;
  planGraphId: string;
  rule: GraphSetRequestValue;
  localVariables: HabitLearningLocalVariableDeclaration[];
  sourceMap: HabitLearningSourceMap;
  digests: HabitLearningRuleDigests;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function stableNodeId(kind: string, identity: unknown): string {
  return `n${digest({ kind, identity }).slice(0, NODE_ID_HEX_LENGTH)}`;
}

function stableVariableId(signalId: string, selector: HabitLearningVariableSelector): string {
  return `v${digest({ kind: 'habit-learning-variable', signalId, selector }).slice(
    0,
    NODE_ID_HEX_LENGTH,
  )}`;
}

function parameterSourceId(signalId: string, piid: number): string {
  return digest({ kind: 'habit-learning-event-argument-source', signalId, piid });
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertEqualStringArrays(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new TypeError(
      `${label} must exactly match the included signal order (${expected.join(', ')})`,
    );
  }
}

function assertEqualStringSets(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (
    actualSet.size !== actual.length ||
    expectedSet.size !== expected.length ||
    actualSet.size !== expectedSet.size ||
    [...actualSet].some((value) => !expectedSet.has(value))
  ) {
    throw new TypeError(
      `${label} must exactly match the included signal set (${expected.join(', ')})`,
    );
  }
}

function includedSignals(plan: HabitLearningPlan): HabitLearningSignal[] {
  if (plan.policy.graphMode !== 'single' || plan.policy.automaticPartitioning !== false) {
    throw new TypeError('habit-learning compiler requires one non-partitioned graph');
  }
  if (plan.graph.automaticPartitioning !== false) {
    throw new TypeError('habit-learning graph must not be automatically partitioned');
  }

  const byId = new Map<string, HabitLearningSignal>();
  for (const signal of plan.signals) {
    if (byId.has(signal.signalId)) {
      throw new TypeError(`duplicate habit-learning signalId: ${signal.signalId}`);
    }
    byId.set(signal.signalId, signal);
  }

  const expectedIds = plan.signals
    .filter((signal) => signal.included)
    .map((signal) => signal.signalId);
  assertEqualStringSets(plan.graph.signalIds, expectedIds, 'plan.graph.signalIds');
  if (plan.graph.sourceCount !== expectedIds.length) {
    throw new TypeError(
      `plan.graph.sourceCount=${plan.graph.sourceCount} does not match ${expectedIds.length} included signals`,
    );
  }
  if (expectedIds.length === 0) {
    throw new TypeError('habit-learning plan has no included observable signals to compile');
  }
  const expectedGraphId = digest({ mode: 'single', signalIds: plan.graph.signalIds });
  if (plan.graph.graphId !== expectedGraphId) {
    throw new TypeError(
      `plan.graph.graphId does not match its included signal set (expected ${expectedGraphId})`,
    );
  }

  return plan.graph.signalIds.map((signalId) => {
    const signal = byId.get(signalId);
    if (signal === undefined) {
      throw new TypeError(`plan.graph references unknown signalId: ${signalId}`);
    }
    if (signal.tier === 'excluded') {
      throw new TypeError(`included signal ${signalId} cannot have tier=excluded`);
    }
    if (signal.selector.kind === 'property') {
      if (signal.observability !== 'push-notify' || !signal.selector.access.includes('notify')) {
        throw new TypeError(
          `included property signal ${signalId} must be a notify-capable push source`,
        );
      }
      return signal;
    }

    if (signal.observability !== 'event') {
      throw new TypeError(`included event signal ${signalId} must have observability=event`);
    }
    const argumentPiids = signal.selector.argumentPiids;
    const uniquePiids = new Set(argumentPiids);
    if (uniquePiids.size !== argumentPiids.length) {
      throw new TypeError(`event signal ${signalId} has duplicate argument PIIDs`);
    }
    assertEqualStringArrays(
      signal.selector.arguments.map((argument) => String(argument.piid)),
      argumentPiids.map(String),
      `event signal ${signalId} resolved arguments`,
    );
    return signal;
  });
}

function sourceFormat(signal: HabitLearningSignal): string {
  if (signal.selector.kind !== 'property') {
    throw new TypeError('sourceFormat requires a property signal');
  }
  switch (signal.selector.sourceDtype) {
    case 'boolean':
      return 'bool';
    case 'float':
      return 'float';
    case 'string':
      return 'string';
    default:
      return 'int';
  }
}

function propertyForSignal(signal: HabitLearningSignal): MiotProperty {
  if (signal.selector.kind !== 'property') {
    throw new TypeError('propertyForSignal requires a property signal');
  }
  return {
    iid: signal.selector.piid,
    type: signal.semantics.capabilityUrn,
    description: signal.semantics.capabilityDescription,
    format: sourceFormat(signal),
    access: [...signal.selector.access],
    ...(signal.semantics.unit !== undefined && { unit: signal.semantics.unit }),
    ...(signal.semantics.valueRange !== undefined && {
      'value-range': [
        signal.semantics.valueRange.min,
        signal.semantics.valueRange.max,
        signal.semantics.valueRange.step,
      ] as [number, number, number],
    }),
    ...(signal.semantics.valueList !== undefined && {
      'value-list': signal.semantics.valueList.map((entry) => ({ ...entry })),
    }),
  };
}

function syntheticSpecForSignal(signal: HabitLearningSignal): DeviceSpec {
  const selector = signal.selector;
  const service =
    selector.kind === 'property'
      ? {
          iid: selector.siid,
          type: signal.semantics.serviceUrn,
          description: signal.semantics.serviceDescription,
          properties: [propertyForSignal(signal)],
          events: [],
          actions: [],
        }
      : {
          iid: selector.siid,
          type: signal.semantics.serviceUrn,
          description: signal.semantics.serviceDescription,
          properties: selector.arguments.map((argument) => ({
            iid: argument.piid,
            type: argument.urn,
            description: argument.description,
            format: argument.format,
            access: [],
            ...(argument.unit !== undefined && { unit: argument.unit }),
            ...(argument.valueRange !== undefined && {
              'value-range': [
                argument.valueRange.min,
                argument.valueRange.max,
                argument.valueRange.step,
              ] as [number, number, number],
            }),
            ...(argument.valueList !== undefined && {
              'value-list': argument.valueList.map((entry) => ({ ...entry })),
            }),
          })),
          events: [
            {
              iid: selector.eiid,
              type: signal.semantics.capabilityUrn,
              description: signal.semantics.capabilityDescription,
              arguments: [...selector.argumentPiids],
            },
          ],
          actions: [],
        };

  return DeviceSpecSchema.parse({
    type: signal.device.urn,
    description: signal.device.model || signal.device.name || 'Habit-learning device',
    services: [service],
  });
}

function applyCanonicalGeometry(
  node: CompiledObservationNode,
  spec?: DeviceSpec,
): CompiledObservationNode {
  const resolution = resolveBundleCardGeometry(node, {
    ...(spec !== undefined && {
      specsByUrn: new Map([[spec.type, spec]]),
    }),
  });
  if (resolution.kind !== 'resolved') {
    throw new TypeError(
      `cannot resolve Bundle card geometry for ${node.type} node ${node.id}: ${resolution.reason}`,
    );
  }
  return {
    ...node,
    cfg: {
      ...node.cfg,
      pos: {
        ...node.cfg.pos,
        width: resolution.geometry.width,
        height: resolution.geometry.height,
      },
    },
  };
}

function variableName(signal: HabitLearningSignal, argumentDescription?: string): string {
  const parts = [
    signal.device.name.trim(),
    signal.semantics.capabilityDescription.trim(),
    argumentDescription?.trim() ?? '',
  ].filter((part) => part.length > 0);
  return parts.join(' · ') || `家庭习惯采集 ${signal.signalId.slice(0, 8)}`;
}

function variableDeclaration(
  signal: HabitLearningSignal,
  sourceId: string,
  scope: string,
  selector: HabitLearningVariableSelector,
  type: 'number' | 'string',
  argumentDescription?: string,
): HabitLearningLocalVariableDeclaration {
  const request = VariableCreateRequest.parse({
    scope,
    id: stableVariableId(signal.signalId, selector),
    type,
    value: type === 'number' ? 0 : '',
    userData: {
      name: variableName(signal, argumentDescription),
    },
  });
  return {
    signalId: signal.signalId,
    sourceId,
    selector,
    request,
  };
}

function sourceNode(
  signal: HabitLearningSignal,
  scope: string,
): {
  node: CompiledObservationNode;
  variables: HabitLearningLocalVariableDeclaration[];
  sourceDefinitions: HabitLearningSourceMap['sources'];
} {
  const id = stableNodeId('habit-learning-source-node', signal.signalId);
  const spec = syntheticSpecForSignal(signal);
  const cfg = {
    urn: signal.device.urn,
    pos: seedPosition(
      signal.selector.kind === 'event' && signal.selector.argumentPiids.length === 0
        ? 'deviceInput'
        : 'deviceInputSetVar',
    ),
    name:
      signal.selector.kind === 'event' && signal.selector.argumentPiids.length === 0
        ? 'deviceInput'
        : 'deviceInputSetVar',
    version: 1,
  };

  if (signal.selector.kind === 'property') {
    const declaration = variableDeclaration(
      signal,
      signal.signalId,
      scope,
      { kind: 'property' },
      signal.selector.captureDtype,
    );
    const node = applyCanonicalGeometry(
      {
        id,
        type: 'deviceInputSetVar',
        cfg,
        inputs: {},
        outputs: { output: [] },
        props: {
          did: signal.device.did,
          siid: signal.selector.siid,
          piid: signal.selector.piid,
          dtype: signal.selector.captureDtype,
          scope,
          id: declaration.request.id,
          preload: true,
        },
      },
      spec,
    );
    return {
      node,
      variables: [declaration],
      sourceDefinitions: [
        {
          sourceId: signal.signalId,
          kind: 'property',
          nodeId: id,
        },
      ],
    };
  }

  if (signal.selector.argumentPiids.length === 0) {
    const node = applyCanonicalGeometry(
      {
        id,
        type: 'deviceInput',
        cfg,
        inputs: {},
        outputs: { output: [] },
        props: {
          did: signal.device.did,
          siid: signal.selector.siid,
          eiid: signal.selector.eiid,
          arguments: [],
        },
      },
      spec,
    );
    return {
      node,
      variables: [],
      // The compiler fills the unique first-hop destination after it creates
      // the shared observation fan-in.
      sourceDefinitions: [],
    };
  }

  const variables = signal.selector.arguments.map((argument, valueIndex) =>
    variableDeclaration(
      signal,
      parameterSourceId(signal.signalId, argument.piid),
      scope,
      {
        kind: 'event-argument',
        piid: argument.piid,
        valueIndex,
      },
      argument.captureDtype,
      argument.description,
    ),
  );
  const node = applyCanonicalGeometry(
    {
      id,
      type: 'deviceInputSetVar',
      cfg,
      inputs: {},
      outputs: { output: [] },
      props: {
        did: signal.device.did,
        siid: signal.selector.siid,
        eiid: signal.selector.eiid,
        arguments: variables.map((declaration) => ({
          piid:
            declaration.selector.kind === 'event-argument' ? declaration.selector.piid : Number.NaN,
          dtype: declaration.request.type,
          scope,
          id: declaration.request.id,
        })),
      },
    },
    spec,
  );
  return {
    node,
    variables,
    sourceDefinitions: variables.map((declaration) => {
      if (declaration.selector.kind !== 'event-argument') {
        throw new TypeError(
          `internal error: event signal ${signal.signalId} produced a property variable`,
        );
      }
      return {
        sourceId: declaration.sourceId,
        kind: 'parameter-event' as const,
        nodeId: id,
        valueIndex: declaration.selector.valueIndex,
      };
    }),
  };
}

function fanInNode(graphId: string, sourceCount: number): CompiledObservationNode {
  const inputCount = Math.max(sourceCount, 2);
  const inputs = Object.fromEntries(
    Array.from({ length: inputCount }, (_, index) => [`input${index}`, null]),
  );
  return applyCanonicalGeometry({
    id: stableNodeId('habit-learning-observation-fan-in', graphId),
    type: 'signalOr',
    cfg: {
      pos: seedPosition('signalOr'),
      name: 'signalOr',
      version: 1,
    },
    inputs,
    outputs: { output: [] },
    props: {},
  });
}

function layoutObservationGraph(
  nodes: CompiledObservationNode[],
  fanInId: string,
): CompiledObservationNode[] {
  const positions = layoutGraph({
    nodes: nodes.map((node) => ({
      id: node.id,
      width: node.cfg.pos.width,
      height: node.cfg.pos.height,
    })),
    edges: nodes
      .filter((node) => node.id !== fanInId)
      .map((node) => ({ from: node.id, to: fanInId })),
  });
  return nodes.map((node) => {
    const position = positions[node.id];
    if (position === undefined) {
      throw new TypeError(`layout did not produce a position for habit-learning node ${node.id}`);
    }
    return {
      ...node,
      cfg: {
        ...node.cfg,
        pos: {
          ...node.cfg.pos,
          x: position.x,
          y: position.y,
        },
      },
    };
  });
}

function semanticNodeMaterial(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const cfg = isRecord(node.cfg) ? node.cfg : {};
  const { pos: _pos, simplified: _simplified, name: _name, ...semanticCfg } = cfg;
  const outputs = isRecord(node.outputs)
    ? Object.fromEntries(
        Object.entries(node.outputs).map(([pin, targets]) => [
          pin,
          Array.isArray(targets) ? [...targets].sort() : targets,
        ]),
      )
    : node.outputs;
  return {
    id: node.id,
    type: node.type,
    cfg: semanticCfg,
    inputs: node.inputs,
    outputs,
    props: node.props,
  };
}

export function habitLearningRuleSemanticDigest(
  rule: GraphSetRequestValue,
  localVariables: readonly HabitLearningLocalVariableDeclaration[],
  sourceMap: HabitLearningSourceMap,
): string {
  return digest({
    compileVersion: HABIT_LEARNING_COMPILE_VERSION,
    rule: {
      uiType: rule.cfg.uiType,
      nodes: [...rule.nodes]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(semanticNodeMaterial),
    },
    localVariables: [...localVariables]
      .sort((left, right) => {
        const leftKey = `${left.request.scope}\u0000${left.request.id}`;
        const rightKey = `${right.request.scope}\u0000${right.request.id}`;
        return leftKey.localeCompare(rightKey);
      })
      .map((declaration) => ({
        signalId: declaration.signalId,
        sourceId: declaration.sourceId,
        selector: declaration.selector,
        scope: declaration.request.scope,
        id: declaration.request.id,
        type: declaration.request.type,
        value: declaration.request.value,
      })),
    sourceMap: {
      sources: [...sourceMap.sources].sort((left, right) =>
        left.sourceId.localeCompare(right.sourceId),
      ),
    },
  });
}

export function habitLearningRuleLayoutDigest(rule: GraphSetRequestValue): string {
  return digest({
    transform: rule.cfg.userData.transform,
    nodes: [...rule.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => {
        const cfg = isRecord(node.cfg) ? node.cfg : {};
        return {
          id: node.id,
          pos: cfg.pos,
          simplified: cfg.simplified ?? false,
        };
      }),
  });
}

function assertAllowedNodes(rule: GraphSetRequestValue): void {
  const seen = new Set<string>();
  for (const node of rule.nodes) {
    if (!ALLOWED_OBSERVATION_NODE_TYPES.has(node.type)) {
      throw new TypeError(
        `habit-learning graph contains forbidden or unknown node type "${node.type}"`,
      );
    }
    if (!isEditorCompatibleNodeId(node.id)) {
      throw new TypeError(`habit-learning node id is not editor-compatible: ${node.id}`);
    }
    if (seen.has(node.id)) {
      throw new TypeError(`duplicate habit-learning node id: ${node.id}`);
    }
    seen.add(node.id);
  }
}

function declarationBySource(
  declarations: readonly HabitLearningLocalVariableDeclaration[],
): Map<string, HabitLearningLocalVariableDeclaration> {
  const bySource = new Map<string, HabitLearningLocalVariableDeclaration>();
  const variableRefs = new Set<string>();
  for (const declaration of declarations) {
    assertNonEmptyString(declaration.signalId, 'localVariables[].signalId');
    assertNonEmptyString(declaration.sourceId, 'localVariables[].sourceId');
    const request = VariableCreateRequest.parse(declaration.request);
    const variableRef = `${request.scope}\u0000${request.id}`;
    if (variableRefs.has(variableRef)) {
      throw new TypeError(
        `duplicate habit-learning local variable: ${request.scope}.${request.id}`,
      );
    }
    variableRefs.add(variableRef);
    if (bySource.has(declaration.sourceId)) {
      throw new TypeError(
        `duplicate habit-learning local variable sourceId: ${declaration.sourceId}`,
      );
    }
    bySource.set(declaration.sourceId, declaration);
  }
  return bySource;
}

function nodeRecord(node: unknown, label: string): Record<string, unknown> {
  if (!isRecord(node)) throw new TypeError(`${label} must be an object`);
  return node;
}

function assertSourceMapAndVariables(
  compilation: CompiledHabitLearningRule,
  rule: GraphSetRequestValue,
): void {
  const sourceMap = freezeHabitLearningSourceMap(compilation.sourceMap);
  if (sourceMap.ruleId !== rule.id) {
    throw new TypeError(
      `habit-learning source map ruleId=${sourceMap.ruleId} does not match rule ${rule.id}`,
    );
  }
  const localScope = `R${rule.id}`;
  const declarations = declarationBySource(compilation.localVariables);
  for (const declaration of compilation.localVariables) {
    if (declaration.request.scope !== localScope) {
      throw new TypeError(
        `habit-learning variable ${declaration.request.id} must use local scope ${localScope}`,
      );
    }
  }

  const nodesById = new Map(rule.nodes.map((node) => [node.id, node]));
  const fanInNodes = rule.nodes.filter((node) => node.type === 'signalOr');
  if (fanInNodes.length !== 1) {
    throw new TypeError(
      `habit-learning graph must contain exactly one observation signalOr (got ${fanInNodes.length})`,
    );
  }
  const fanIn = fanInNodes[0];
  if (fanIn === undefined) throw new TypeError('habit-learning observation signalOr is missing');
  const fanInOutputs = nodeRecord(fanIn.outputs, 'signalOr.outputs');
  if (!Array.isArray(fanInOutputs.output) || fanInOutputs.output.length !== 0) {
    throw new TypeError('habit-learning observation signalOr must not drive any downstream sink');
  }

  const sourceNodes = rule.nodes.filter((node) => node.id !== fanIn.id);
  const sourceNodeIds = new Set(sourceNodes.map((node) => node.id));
  const fanInInputs = nodeRecord(fanIn.inputs, 'signalOr.inputs');
  if (Object.keys(fanInInputs).length !== Math.max(sourceNodes.length, 2)) {
    throw new TypeError('habit-learning signalOr input count does not match source count');
  }

  const definitionsByNode = new Map<string, typeof sourceMap.sources>();
  for (const source of sourceMap.sources) {
    const nodeId =
      source.kind === 'zero-argument-event'
        ? source.firstHop.src.slice(0, source.firstHop.src.lastIndexOf('.'))
        : source.nodeId;
    const definitions = definitionsByNode.get(nodeId) ?? [];
    definitionsByNode.set(nodeId, [...definitions, source]);
  }
  for (const nodeId of definitionsByNode.keys()) {
    if (!nodesById.has(nodeId) || !sourceNodeIds.has(nodeId)) {
      throw new TypeError(`habit-learning source map references unknown source node ${nodeId}`);
    }
  }

  const usedDeclarationSources = new Set<string>();
  sourceNodes.forEach((node, sourceIndex) => {
    const expectedTarget = `${fanIn.id}.input${sourceIndex}`;
    const outputs = nodeRecord(node.outputs, `${node.id}.outputs`);
    if (
      !Array.isArray(outputs.output) ||
      outputs.output.length !== 1 ||
      outputs.output[0] !== expectedTarget
    ) {
      throw new TypeError(
        `habit-learning source ${node.id} must have exactly one edge to ${expectedTarget}`,
      );
    }
    const definitions = definitionsByNode.get(node.id) ?? [];
    const props = nodeRecord(node.props, `${node.id}.props`);

    if (node.type === 'deviceInput') {
      const arguments_ = props.arguments;
      if (!Array.isArray(arguments_) || arguments_.length !== 0) {
        throw new TypeError(
          `habit-learning deviceInput ${node.id} must be a zero-argument event source`,
        );
      }
      if (
        definitions.length !== 1 ||
        definitions[0]?.kind !== 'zero-argument-event' ||
        definitions[0].firstHop.src !== `${node.id}.output` ||
        definitions[0].firstHop.dst !== expectedTarget
      ) {
        throw new TypeError(
          `habit-learning zero-argument source ${node.id} has an unknown or non-canonical first hop`,
        );
      }
      return;
    }

    if (node.type !== 'deviceInputSetVar') {
      throw new TypeError(`unknown habit-learning observation source type: ${node.type}`);
    }
    const arguments_ = props.arguments;
    if (Array.isArray(arguments_)) {
      if (arguments_.length === 0 || definitions.length !== arguments_.length) {
        throw new TypeError(
          `habit-learning parameter event ${node.id} source-map cardinality mismatch`,
        );
      }
      arguments_.forEach((argumentValue, valueIndex) => {
        const argument = nodeRecord(argumentValue, `${node.id}.props.arguments[${valueIndex}]`);
        const definition = definitions.find(
          (candidate) =>
            candidate.kind === 'parameter-event' && candidate.valueIndex === valueIndex,
        );
        if (definition === undefined || definition.kind !== 'parameter-event') {
          throw new TypeError(
            `habit-learning parameter event ${node.id} has unknown source at valueIndex=${valueIndex}`,
          );
        }
        const declaration = declarations.get(definition.sourceId);
        if (
          declaration === undefined ||
          declaration.selector.kind !== 'event-argument' ||
          declaration.selector.valueIndex !== valueIndex ||
          declaration.selector.piid !== argument.piid ||
          declaration.request.scope !== argument.scope ||
          declaration.request.id !== argument.id ||
          declaration.request.type !== argument.dtype
        ) {
          throw new TypeError(
            `habit-learning parameter source ${definition.sourceId} does not match its local variable`,
          );
        }
        usedDeclarationSources.add(definition.sourceId);
      });
      return;
    }

    if (definitions.length !== 1 || definitions[0]?.kind !== 'property') {
      throw new TypeError(
        `habit-learning property source ${node.id} has unknown or missing source-map entry`,
      );
    }
    const definition = definitions[0];
    if (definition.kind !== 'property' || definition.valueIndex !== undefined) {
      throw new TypeError(`habit-learning property source ${node.id} cannot select a value index`);
    }
    if (props.preload !== true) {
      throw new TypeError(`habit-learning property source ${node.id} must set preload=true`);
    }
    const declaration = declarations.get(definition.sourceId);
    if (
      declaration === undefined ||
      declaration.selector.kind !== 'property' ||
      declaration.request.scope !== props.scope ||
      declaration.request.id !== props.id ||
      declaration.request.type !== props.dtype
    ) {
      throw new TypeError(
        `habit-learning property source ${definition.sourceId} does not match its local variable`,
      );
    }
    usedDeclarationSources.add(definition.sourceId);
  });

  for (const sourceId of declarations.keys()) {
    if (!usedDeclarationSources.has(sourceId)) {
      throw new TypeError(
        `habit-learning local variable source ${sourceId} is not used by the observation graph`,
      );
    }
  }
}

/**
 * Re-check a compiled bundle before any variable or rule write is attempted.
 *
 * This is intentionally narrower than generic graph validation: only the
 * three observation-only node types are accepted, every source must have a
 * canonical source-map transport, every capture must resolve to a rule-local
 * variable, and both digests must still match.
 */
export function assertCompiledHabitLearningRule(compilation: CompiledHabitLearningRule): void {
  if (compilation.compileVersion !== HABIT_LEARNING_COMPILE_VERSION) {
    throw new TypeError(`unsupported habit-learning compileVersion: ${compilation.compileVersion}`);
  }
  if (!/^[a-f0-9]{64}$/.test(compilation.planId)) {
    throw new TypeError('compiled habit-learning planId must be a sha256 digest');
  }
  if (!/^[a-f0-9]{64}$/.test(compilation.planGraphId)) {
    throw new TypeError('compiled habit-learning planGraphId must be a sha256 digest');
  }

  const rule = GraphSetRequest.parse(compilation.rule);
  if (rule.cfg.enable !== false) {
    throw new TypeError('compiled habit-learning rule must remain disabled');
  }
  if (rule.cfg.id !== rule.id) {
    throw new TypeError('compiled habit-learning rule cfg.id must match id');
  }
  assertAllowedNodes(rule);
  const lintIssues = lintGraph({ graph: rule, strict: true });
  if (lintIssues.length > 0) {
    const first = lintIssues[0];
    throw new TypeError(
      `compiled habit-learning graph failed strict lint: ${first?.message ?? 'unknown issue'} (${first?.path ?? 'graph'})`,
    );
  }
  assertSourceMapAndVariables(compilation, rule);

  const semantic = habitLearningRuleSemanticDigest(
    rule,
    compilation.localVariables,
    compilation.sourceMap,
  );
  if (semantic !== compilation.digests.semantic) {
    throw new TypeError('compiled habit-learning semantic digest mismatch');
  }
  const layout = habitLearningRuleLayoutDigest(rule);
  if (layout !== compilation.digests.layout) {
    throw new TypeError('compiled habit-learning layout digest mismatch');
  }
}

/**
 * Compile one deterministic, disabled, observation-only rule from a reviewed
 * habit-learning plan. This function performs no I/O and never creates,
 * enables, or mutates a gateway rule or variable.
 */
export function compileHabitLearningRule(
  input: CompileHabitLearningRuleInput,
): CompiledHabitLearningRule {
  assertNonEmptyString(input.ruleId, 'ruleId');
  if (!isValidVariableIdentifier(input.ruleId)) {
    throw new TypeError(
      'ruleId must be ASCII alphanumeric so its rule-local variable scope R<ruleId> is valid',
    );
  }
  const ruleName = input.ruleName ?? input.plan.graph.label;
  assertNonEmptyString(ruleName, 'ruleName');

  const plan = HabitLearningPlanSchema.parse(input.plan);
  const signals = includedSignals(plan);
  const localScope = `R${input.ruleId}`;
  if (!isValidVariableIdentifier(localScope)) {
    throw new TypeError(`derived habit-learning local scope is invalid: ${localScope}`);
  }

  const fanIn = fanInNode(plan.graph.graphId, signals.length);
  const sourceNodes: CompiledObservationNode[] = [];
  const localVariables: HabitLearningLocalVariableDeclaration[] = [];
  const sourceDefinitions: HabitLearningSourceMap['sources'][number][] = [];

  signals.forEach((signal, sourceIndex) => {
    const compiled = sourceNode(signal, localScope);
    const target = `${fanIn.id}.input${sourceIndex}`;
    compiled.node.outputs.output = [target];
    sourceNodes.push(compiled.node);
    localVariables.push(...compiled.variables);
    if (signal.selector.kind === 'event' && signal.selector.argumentPiids.length === 0) {
      sourceDefinitions.push({
        sourceId: signal.signalId,
        kind: 'zero-argument-event',
        firstHop: {
          src: `${compiled.node.id}.output`,
          dst: target,
        },
      });
    } else {
      sourceDefinitions.push(...compiled.sourceDefinitions);
    }
  });

  const nodeIds = new Set<string>();
  const variableIds = new Set<string>();
  for (const node of [...sourceNodes, fanIn]) {
    if (nodeIds.has(node.id)) {
      throw new TypeError(`stable habit-learning node id collision: ${node.id}`);
    }
    nodeIds.add(node.id);
  }
  for (const declaration of localVariables) {
    if (variableIds.has(declaration.request.id)) {
      throw new TypeError(`stable habit-learning variable id collision: ${declaration.request.id}`);
    }
    variableIds.add(declaration.request.id);
  }

  const nodes = layoutObservationGraph([...sourceNodes, fanIn], fanIn.id);
  const rule = GraphSetRequest.parse({
    id: input.ruleId,
    nodes,
    cfg: {
      id: input.ruleId,
      uiType: 'test',
      enable: false,
      userData: {
        name: ruleName,
        transform: { x: 0, y: 0, scale: 1, rotate: 0 },
        lastUpdateTime: 0,
        version: 0,
      },
    },
  });
  const sourceMap = freezeHabitLearningSourceMap({
    ruleId: input.ruleId,
    sources: sourceDefinitions,
  });
  const compilation: CompiledHabitLearningRule = {
    compileVersion: HABIT_LEARNING_COMPILE_VERSION,
    planId: plan.planId,
    planGraphId: plan.graph.graphId,
    rule,
    localVariables,
    sourceMap,
    digests: {
      semantic: habitLearningRuleSemanticDigest(rule, localVariables, sourceMap),
      layout: habitLearningRuleLayoutDigest(rule),
    },
  };
  assertCompiledHabitLearningRule(compilation);
  return compilation;
}
