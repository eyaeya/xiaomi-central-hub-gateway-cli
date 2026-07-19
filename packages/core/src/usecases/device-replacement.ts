import { createHash } from 'node:crypto';
import type {
  DeviceSpec,
  MiotAction,
  MiotEvent,
  MiotProperty,
  MiotService,
} from '../schemas/device-spec.js';
import type { Device } from '../schemas/device.js';
import { ConfigError } from '../transport/errors.js';

export const DEVICE_REPLACEMENT_NODE_TYPES = [
  'deviceInput',
  'deviceGet',
  'deviceOutput',
  'deviceInputSetVar',
  'deviceGetSetVar',
] as const;

export type DeviceReplacementNodeType = (typeof DEVICE_REPLACEMENT_NODE_TYPES)[number];
export type DeviceReplacementCapabilityKind = 'property' | 'event' | 'action';
export type DeviceReplacementUsage = 'notify' | 'get' | 'set';
export type DeviceReplacementDtype = 'int' | 'float' | 'boolean' | 'string';

export interface DeviceReplacementValueRange {
  min: number;
  max: number;
  step: number;
}

export interface DeviceReplacementProperty {
  kind: 'property';
  siid: number;
  piid: number;
  serviceUrn: string;
  urn: string;
  serviceDescription: string;
  description: string;
  dtype: DeviceReplacementDtype;
  valueRange?: DeviceReplacementValueRange;
  valueList?: Array<number | boolean>;
}

export interface DeviceReplacementEvent {
  kind: 'event';
  siid: number;
  eiid: number;
  serviceUrn: string;
  urn: string;
  serviceDescription: string;
  description: string;
  arguments?: DeviceReplacementProperty[];
}

export interface DeviceReplacementAction {
  kind: 'action';
  siid: number;
  aiid: number;
  serviceUrn: string;
  urn: string;
  serviceDescription: string;
  description: string;
  inputs: DeviceReplacementProperty[];
}

export type DeviceReplacementCapability =
  | DeviceReplacementProperty
  | DeviceReplacementEvent
  | DeviceReplacementAction;

export interface DeviceReplacementSource {
  nodeType: DeviceReplacementNodeType;
  usage: DeviceReplacementUsage;
  did: string;
  urn: string;
  capability: DeviceReplacementCapability;
}

export interface DeviceReplacementCheck {
  contract: string;
  source: unknown;
  target: unknown;
  compatible: boolean;
  reason?: string;
}

export interface DeviceReplacementEvaluation {
  target: DeviceReplacementCapability;
  compatible: boolean;
  checks: DeviceReplacementCheck[];
  reasons: string[];
}

export interface DeviceReplacementCandidate {
  did: string;
  name: string;
  model: string;
  urn: string;
  compatible: boolean;
  evaluations: DeviceReplacementEvaluation[];
  reasons: string[];
  specError?: string;
}

export interface DeviceReplacementSelector {
  siid?: number;
  piid?: number;
  eiid?: number;
  aiid?: number;
}

export interface DeviceReplacementSelectionError {
  code: 'CONFIG';
  message: string;
  selector: DeviceReplacementSelector;
  details?: Record<string, unknown>;
}

export interface DeviceReplacementPlan {
  ruleId: string;
  nodeId: string;
  nodeType: DeviceReplacementNodeType;
  dryRun: true;
  source: DeviceReplacementSource;
  candidates: DeviceReplacementCandidate[];
  targetDid?: string;
  selectedMapping?: DeviceReplacementEvaluation;
  /** Why a focused dry-run could not resolve exactly one mapping. */
  selectionError?: DeviceReplacementSelectionError;
  planId?: string;
}

export interface ResolveDeviceReplacementSourceInput {
  node: Record<string, unknown>;
  sourceSpec: DeviceSpec;
}

interface CapabilityRequest {
  nodeType: DeviceReplacementNodeType;
  usage: DeviceReplacementUsage;
  kind: DeviceReplacementCapabilityKind;
  did: string;
  urn: string;
  siid: number;
  iid: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${context} requires a non-empty ${field}`, { field, context });
  }
  return value;
}

function requiredIid(record: Record<string, unknown>, field: string, context: string): number {
  const value = record[field];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ConfigError(`${context} requires a positive integer ${field}`, { field, context });
  }
  return value as number;
}

function replacementNodeType(value: unknown): DeviceReplacementNodeType {
  if (
    typeof value !== 'string' ||
    !(DEVICE_REPLACEMENT_NODE_TYPES as readonly string[]).includes(value)
  ) {
    throw new ConfigError(
      `device replacement only supports ${DEVICE_REPLACEMENT_NODE_TYPES.join('|')} nodes`,
      { type: value },
    );
  }
  return value as DeviceReplacementNodeType;
}

function requestFromNode(node: Record<string, unknown>): CapabilityRequest {
  const nodeType = replacementNodeType(node.type);
  if (!isRecord(node.cfg) || !isRecord(node.props)) {
    throw new ConfigError(`device replacement requires a complete ${nodeType} node`, {
      nodeId: node.id,
      nodeType,
    });
  }
  const did = requiredString(node.props, 'did', `${nodeType}.props`);
  const urn = requiredString(node.cfg, 'urn', `${nodeType}.cfg`);
  const siid = requiredIid(node.props, 'siid', `${nodeType}.props`);

  if (nodeType === 'deviceOutput') {
    if (Number.isInteger(node.props.piid)) {
      return {
        nodeType,
        usage: 'set',
        kind: 'property',
        did,
        urn,
        siid,
        iid: requiredIid(node.props, 'piid', `${nodeType}.props`),
      };
    }
    return {
      nodeType,
      usage: 'set',
      kind: 'action',
      did,
      urn,
      siid,
      iid: requiredIid(node.props, 'aiid', `${nodeType}.props`),
    };
  }

  if (nodeType === 'deviceInput' || nodeType === 'deviceInputSetVar') {
    if (Number.isInteger(node.props.piid)) {
      return {
        nodeType,
        usage: 'notify',
        kind: 'property',
        did,
        urn,
        siid,
        iid: requiredIid(node.props, 'piid', `${nodeType}.props`),
      };
    }
    return {
      nodeType,
      usage: 'notify',
      kind: 'event',
      did,
      urn,
      siid,
      iid: requiredIid(node.props, 'eiid', `${nodeType}.props`),
    };
  }

  return {
    nodeType,
    usage: 'get',
    kind: 'property',
    did,
    urn,
    siid,
    iid: requiredIid(node.props, 'piid', `${nodeType}.props`),
  };
}

function urnContract(urn: string): string {
  return urn.split(':').slice(0, 5).join(':');
}

function propertyDtype(property: MiotProperty): DeviceReplacementDtype {
  if (property.format === 'string') return 'string';
  if (property.format === 'bool') return 'boolean';
  if (property.format === 'float') {
    // Official bundle parser checks for the presence of value-list, not its
    // length, and projects an enum-like float onto the integer dialect.
    return property['value-list'] !== undefined ? 'int' : 'float';
  }
  return 'int';
}

function normalizeProperty(
  service: MiotService,
  property: MiotProperty,
): DeviceReplacementProperty {
  const base: DeviceReplacementProperty = {
    kind: 'property',
    siid: service.iid,
    piid: property.iid,
    serviceUrn: service.type,
    urn: property.type,
    serviceDescription: service.description,
    description: property.description,
    dtype: propertyDtype(property),
  };
  const range = property['value-range'];
  if (range !== undefined) {
    return {
      ...base,
      valueRange: { min: range[0], max: range[1], step: range[2] },
    };
  }
  const list = property['value-list'];
  if (list !== undefined) {
    return { ...base, valueList: list.map((entry) => entry.value) };
  }
  if (property.format === 'bool') {
    // The official parser synthesizes a bool value-list even when the raw
    // MIoT instance omits one, before compareProperty sees the capability.
    return { ...base, valueList: [true, false] };
  }
  return base;
}

function propertyByIid(service: MiotService, piid: number, context: string): MiotProperty {
  const property = service.properties?.find((entry) => entry.iid === piid);
  if (property === undefined) {
    throw new ConfigError(`${context} references missing property iid ${piid}`, {
      siid: service.iid,
      piid,
    });
  }
  return property;
}

function normalizeEvent(service: MiotService, event: MiotEvent): DeviceReplacementEvent {
  return {
    kind: 'event',
    siid: service.iid,
    eiid: event.iid,
    serviceUrn: service.type,
    urn: event.type,
    serviceDescription: service.description,
    description: event.description,
    ...(event.arguments !== undefined && {
      arguments: event.arguments.map((piid) =>
        normalizeProperty(
          service,
          propertyByIid(service, piid, `event ${service.iid}.${event.iid}`),
        ),
      ),
    }),
  };
}

function normalizeAction(service: MiotService, action: MiotAction): DeviceReplacementAction {
  return {
    kind: 'action',
    siid: service.iid,
    aiid: action.iid,
    serviceUrn: service.type,
    urn: action.type,
    serviceDescription: service.description,
    description: action.description,
    inputs: action.in.map((piid) =>
      normalizeProperty(
        service,
        propertyByIid(service, piid, `action ${service.iid}.${action.iid}`),
      ),
    ),
  };
}

function capabilitiesFor(
  spec: DeviceSpec,
  kind: DeviceReplacementCapabilityKind,
  usage: DeviceReplacementUsage,
): DeviceReplacementCapability[] {
  const capabilities: DeviceReplacementCapability[] = [];
  for (const service of spec.services) {
    if (kind === 'property') {
      const access = usage === 'notify' ? 'notify' : usage === 'get' ? 'read' : 'write';
      for (const property of service.properties ?? []) {
        if (property.access.includes(access)) {
          capabilities.push(normalizeProperty(service, property));
        }
      }
    } else if (kind === 'event') {
      for (const event of service.events ?? []) capabilities.push(normalizeEvent(service, event));
    } else {
      for (const action of service.actions ?? [])
        capabilities.push(normalizeAction(service, action));
    }
  }
  return capabilities;
}

function capabilityIid(capability: DeviceReplacementCapability): number {
  if (capability.kind === 'property') return capability.piid;
  if (capability.kind === 'event') return capability.eiid;
  return capability.aiid;
}

export function resolveDeviceReplacementSource(
  input: ResolveDeviceReplacementSourceInput,
): DeviceReplacementSource {
  const request = requestFromNode(input.node);
  const capability = capabilitiesFor(input.sourceSpec, request.kind, request.usage).find(
    (entry) => entry.siid === request.siid && capabilityIid(entry) === request.iid,
  );
  if (capability === undefined) {
    throw new ConfigError(
      `source ${request.kind} ${request.siid}.${request.iid} is absent from the current ${request.usage} capability set; replacement is unsafe`,
      {
        nodeId: input.node.id,
        nodeType: request.nodeType,
        usage: request.usage,
        kind: request.kind,
        siid: request.siid,
        iid: request.iid,
      },
    );
  }
  return {
    nodeType: request.nodeType,
    usage: request.usage,
    did: request.did,
    urn: request.urn,
    capability,
  };
}

function check(
  contract: string,
  source: unknown,
  target: unknown,
  compatible: boolean,
  reason: string,
): DeviceReplacementCheck {
  return {
    contract,
    source,
    target,
    compatible,
    ...(!compatible && { reason }),
  };
}

function sameValueSet(source: Array<number | boolean>, target: Array<number | boolean>): boolean {
  return (
    source.length === target.length &&
    source.every((value) => target.some((entry) => entry === value))
  );
}

function propertyChecks(
  source: DeviceReplacementProperty,
  target: DeviceReplacementProperty,
  prefix: string,
): DeviceReplacementCheck[] {
  const checks = [
    check(
      `${prefix}.serviceUrn[:5]`,
      urnContract(source.serviceUrn),
      urnContract(target.serviceUrn),
      urnContract(source.serviceUrn) === urnContract(target.serviceUrn),
      'service URN contract differs',
    ),
    check(
      `${prefix}.urn[:5]`,
      urnContract(source.urn),
      urnContract(target.urn),
      urnContract(source.urn) === urnContract(target.urn),
      'property URN contract differs',
    ),
    check(
      `${prefix}.dtype`,
      source.dtype,
      target.dtype,
      source.dtype === target.dtype,
      'property dtype differs',
    ),
  ];

  // These checks deliberately mirror the official comparator's source-led
  // semantics: a range/list present on the source must be reproduced exactly;
  // an extra range/list on a target is not itself a rejection.
  if (source.valueRange !== undefined) {
    const targetRange = target.valueRange;
    checks.push(
      check(
        `${prefix}.valueRange`,
        source.valueRange,
        targetRange ?? null,
        targetRange !== undefined &&
          source.valueRange.min === targetRange.min &&
          source.valueRange.max === targetRange.max &&
          source.valueRange.step === targetRange.step,
        'value-range min/max/step differs',
      ),
    );
  }
  if (source.valueList !== undefined) {
    const targetList = target.valueList;
    checks.push(
      check(
        `${prefix}.valueList`,
        source.valueList,
        targetList ?? null,
        targetList !== undefined && sameValueSet(source.valueList, targetList),
        'value-list values differ',
      ),
    );
  }
  return checks;
}

function eventChecks(
  source: DeviceReplacementEvent,
  target: DeviceReplacementEvent,
): DeviceReplacementCheck[] {
  const checks = [
    check(
      'event.serviceUrn[:5]',
      urnContract(source.serviceUrn),
      urnContract(target.serviceUrn),
      urnContract(source.serviceUrn) === urnContract(target.serviceUrn),
      'service URN contract differs',
    ),
    check(
      'event.urn[:5]',
      urnContract(source.urn),
      urnContract(target.urn),
      urnContract(source.urn) === urnContract(target.urn),
      'event URN contract differs',
    ),
  ];
  if (source.arguments === undefined) return checks;
  checks.push(
    check(
      'event.arguments.length',
      source.arguments.length,
      target.arguments?.length ?? null,
      target.arguments !== undefined && source.arguments.length === target.arguments.length,
      'event argument count differs',
    ),
  );
  for (const sourceArgument of source.arguments) {
    const targetArgument = target.arguments?.find((entry) => entry.piid === sourceArgument.piid);
    checks.push(
      check(
        `event.arguments[piid=${sourceArgument.piid}].piid`,
        sourceArgument.piid,
        targetArgument?.piid ?? null,
        targetArgument !== undefined,
        `event argument piid ${sourceArgument.piid} is missing`,
      ),
    );
    if (targetArgument !== undefined) {
      checks.push(
        ...propertyChecks(
          sourceArgument,
          targetArgument,
          `event.arguments[piid=${sourceArgument.piid}]`,
        ),
      );
    }
  }
  return checks;
}

function actionChecks(
  source: DeviceReplacementAction,
  target: DeviceReplacementAction,
): DeviceReplacementCheck[] {
  const checks = [
    check(
      'action.serviceUrn[:5]',
      urnContract(source.serviceUrn),
      urnContract(target.serviceUrn),
      urnContract(source.serviceUrn) === urnContract(target.serviceUrn),
      'service URN contract differs',
    ),
    check(
      'action.urn[:5]',
      urnContract(source.urn),
      urnContract(target.urn),
      urnContract(source.urn) === urnContract(target.urn),
      'action URN contract differs',
    ),
    check(
      'action.inputs.length',
      source.inputs.length,
      target.inputs.length,
      source.inputs.length === target.inputs.length,
      'action input count differs',
    ),
  ];
  for (const sourceInput of source.inputs) {
    const targetInput = target.inputs.find((entry) => entry.piid === sourceInput.piid);
    checks.push(
      check(
        `action.inputs[piid=${sourceInput.piid}].piid`,
        sourceInput.piid,
        targetInput?.piid ?? null,
        targetInput !== undefined,
        `action input piid ${sourceInput.piid} is missing`,
      ),
    );
    if (targetInput !== undefined) {
      checks.push(
        ...propertyChecks(sourceInput, targetInput, `action.inputs[piid=${sourceInput.piid}]`),
      );
    }
  }
  return checks;
}

function evaluateCapability(
  source: DeviceReplacementCapability,
  target: DeviceReplacementCapability,
): DeviceReplacementEvaluation {
  let checks: DeviceReplacementCheck[];
  if (source.kind === 'property' && target.kind === 'property') {
    checks = propertyChecks(source, target, 'property');
  } else if (source.kind === 'event' && target.kind === 'event') {
    checks = eventChecks(source, target);
  } else if (source.kind === 'action' && target.kind === 'action') {
    checks = actionChecks(source, target);
  } else {
    checks = [check('capability.kind', source.kind, target.kind, false, 'capability kind differs')];
  }
  const reasons = checks
    .filter((entry) => !entry.compatible)
    .map((entry) => entry.reason ?? `${entry.contract} differs`);
  return { target, compatible: reasons.length === 0, checks, reasons };
}

export function evaluateDeviceReplacementCandidate(
  source: DeviceReplacementSource,
  device: Device & { did: string },
  targetSpec: DeviceSpec,
): DeviceReplacementCandidate {
  const targets = capabilitiesFor(targetSpec, source.capability.kind, source.usage);
  const evaluations = targets.map((target) => evaluateCapability(source.capability, target));
  const compatible = evaluations.some((entry) => entry.compatible);
  const reasons =
    evaluations.length === 0
      ? [`target exposes no ${source.usage} ${source.capability.kind} capabilities`]
      : compatible
        ? []
        : [
            `all ${evaluations.length} ${source.usage} ${source.capability.kind} mappings are incompatible`,
          ];
  return {
    did: device.did,
    name: device.name,
    model: device.model,
    urn: device.urn,
    compatible,
    evaluations,
    reasons,
  };
}

export function replacementCandidateWithSpecError(
  device: Device & { did: string },
  message: string,
): DeviceReplacementCandidate {
  return {
    did: device.did,
    name: device.name,
    model: device.model,
    urn: device.urn,
    compatible: false,
    evaluations: [],
    reasons: [`target MIoT spec could not be checked: ${message}`],
    specError: message,
  };
}

function selectorMatches(
  capability: DeviceReplacementCapability,
  selector: DeviceReplacementSelector,
): boolean {
  if (selector.siid !== undefined && capability.siid !== selector.siid) return false;
  if (capability.kind === 'property') {
    if (selector.eiid !== undefined || selector.aiid !== undefined) return false;
    return selector.piid === undefined || capability.piid === selector.piid;
  }
  if (capability.kind === 'event') {
    if (selector.piid !== undefined || selector.aiid !== undefined) return false;
    return selector.eiid === undefined || capability.eiid === selector.eiid;
  }
  if (selector.piid !== undefined || selector.eiid !== undefined) return false;
  return selector.aiid === undefined || capability.aiid === selector.aiid;
}

export function selectDeviceReplacementMapping(
  candidate: DeviceReplacementCandidate,
  selector: DeviceReplacementSelector = {},
): DeviceReplacementEvaluation {
  const compatible = candidate.evaluations.filter(
    (entry) => entry.compatible && selectorMatches(entry.target, selector),
  );
  if (compatible.length === 1) return compatible[0] as DeviceReplacementEvaluation;
  if (compatible.length === 0) {
    throw new ConfigError(`device ${candidate.did} has no compatible mapping for the selector`, {
      did: candidate.did,
      selector,
      reasons: candidate.reasons,
      evaluations: candidate.evaluations,
    });
  }
  throw new ConfigError(
    `device ${candidate.did} has ${compatible.length} compatible mappings; select one with --target-siid and --target-piid/--target-eiid/--target-aiid`,
    {
      did: candidate.did,
      selector,
      compatibleMappings: compatible.map((entry) => entry.target),
    },
  );
}

export function replaceDeviceNode(
  node: Record<string, unknown>,
  targetDid: string,
  targetUrn: string,
  mapping: DeviceReplacementEvaluation,
): Record<string, unknown> {
  if (!mapping.compatible) {
    throw new ConfigError('cannot apply an incompatible device replacement mapping', {
      targetDid,
      reasons: mapping.reasons,
    });
  }
  if (!isRecord(node.cfg) || !isRecord(node.props)) {
    throw new ConfigError('device replacement requires a complete node');
  }
  const target = mapping.target;
  const props: Record<string, unknown> = {
    ...node.props,
    did: targetDid,
    siid: target.siid,
  };
  if (target.kind === 'property') props.piid = target.piid;
  else if (target.kind === 'event') props.eiid = target.eiid;
  else props.aiid = target.aiid;
  return {
    ...node,
    cfg: { ...node.cfg, urn: targetUrn },
    props,
  };
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

export function deviceReplacementPlanId(
  node: Record<string, unknown>,
  source: DeviceReplacementSource,
  candidate: DeviceReplacementCandidate,
  mapping: DeviceReplacementEvaluation,
): string {
  const material = stableValue({
    node,
    source,
    target: { did: candidate.did, urn: candidate.urn, capability: mapping.target },
  });
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
