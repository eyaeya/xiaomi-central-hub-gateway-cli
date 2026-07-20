import type { DeviceSpec } from '../schemas/device-spec.js';
import type { DeviceGetNode } from '../schemas/nodes/device-get.js';
import type { Node } from '../schemas/rule.js';
import {
  type DeviceSpecSemanticCatalogStatus,
  type ProjectDeviceSpecSemanticsOptions,
  type SemanticDeviceSpecProjection,
  projectDeviceSpecSemantics,
} from './device-spec-semantics.js';
import { getDeviceSpec } from './get-device-spec.js';
import type { RuleLogEntry } from './rule-logs.js';

export type RuleTraceWatchpointType = 'node' | 'link';

export interface RuleTraceWatchpoint {
  id: string;
  type: RuleTraceWatchpointType;
  nodeId?: string;
  src?: string;
  dst?: string;
}

export interface RuleTraceWatchpointStatus {
  /** Monotonic ordering of accepted watchpoint changes; enable resets do not consume an order. */
  order: number;
  type: 'link' | 'info' | 'error';
  timestamp: number;
  info: string;
}

export interface RuleTraceFrame {
  /** Absolute zero-based index in this calculator, before CLI time/step selection. */
  step: number;
  timestamp: number;
  iso: string;
  /** `null` is a rule-enable reset frame, matching the production calculator's absent `new`. */
  changed: string | null;
  status: Record<string, RuleTraceWatchpointStatus>;
}

export interface RuleTraceTopologyDrift {
  entryCount: number;
  missingWatchpointEntryCount: number;
  incompatibleLinkEntryCount: number;
  watchpoints: string[];
}

export interface RuleTraceSemanticDrift {
  entryCount: number;
  nodeInfoParseFailureCount: number;
  incompatibleLinkEntryCount: number;
  watchpoints: string[];
}

export interface CalculateRuleTraceInput {
  ruleId: string;
  nodes: Node[];
  entries: RuleLogEntry[];
  /** Bundle-compatible watchpoint ids. Omit to trace every current-graph watchpoint. */
  filter?: string[];
  /** Best-effort deviceGet value-list labels keyed by node id then raw value. */
  deviceGetLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface RuleTraceDeviceGetLabelResult {
  labelsByNodeId: Record<string, Record<string, string>>;
  specLookup: {
    requestedUrns: string[];
    failedUrns: string[];
    failureCount: number;
  };
  semanticProjection: {
    attemptedUrns: string[];
    failedUrns: string[];
    failureCount: number;
    catalogStatuses: Array<DeviceSpecSemanticCatalogStatus & { urn: string }>;
    catalogFallbackUrns: string[];
    catalogFallbackCount: number;
    valueLabelFallbackUrns: string[];
    valueLabelFallbackCatalogCount: number;
  };
}

const RULE_TRACE_VALUE_LABEL_CATALOGS: ReadonlySet<DeviceSpecSemanticCatalogStatus['catalog']> =
  new Set(['multi-language', 'property-value-normalization']);

export interface ResolveRuleTraceDeviceGetLabelsOptions {
  /** Test seam; defaults to the shared cached public MIoT spec loader. */
  loadSpec?: (urn: string) => Promise<DeviceSpec>;
  /** Test seam; defaults to the shared best-effort semantic projector. */
  projectSemantics?: (
    spec: DeviceSpec,
    options?: ProjectDeviceSpecSemanticsOptions,
  ) => Promise<SemanticDeviceSpecProjection>;
  /** Forwarded to the shared projector; timeout also bounds the default raw-spec loader. */
  semanticOptions?: ProjectDeviceSpecSemanticsOptions;
}

export interface RuleTraceCalculation {
  frames: RuleTraceFrame[];
  watchpoints: RuleTraceWatchpoint[];
  selectedWatchpoints: string[];
  topologyDrift: RuleTraceTopologyDrift;
  semanticDrift: RuleTraceSemanticDrift;
  matchingLogEntries: number;
}

/** Bundle id shape: `node:<id>`. */
export function ruleTraceNodeWatchpointId(nodeId: string): string {
  return `node:${nodeId}`;
}

/** Bundle id shape: `link:<src-node>.<pin>-><dst-node>.<pin>`. */
export function ruleTraceLinkWatchpointId(src: string, dst: string): string {
  return `link:${src}->${dst}`;
}

/** Enumerate node and output-edge watchpoints from the current graph in graph order. */
export function buildRuleTraceWatchpoints(nodes: Node[]): RuleTraceWatchpoint[] {
  const result: RuleTraceWatchpoint[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const nodeId = ruleTraceNodeWatchpointId(node.id);
    if (!seen.has(nodeId)) {
      seen.add(nodeId);
      result.push({ id: nodeId, type: 'node', nodeId: node.id });
    }
    const outputs = (node as { outputs?: Record<string, string[]> }).outputs ?? {};
    for (const [pin, targets] of Object.entries(outputs)) {
      if (!Array.isArray(targets)) continue;
      for (const dst of targets) {
        const src = `${node.id}.${pin}`;
        const id = ruleTraceLinkWatchpointId(src, dst);
        if (seen.has(id)) continue;
        seen.add(id);
        result.push({ id, type: 'link', src, dst });
      }
    }
  }
  return result;
}

/**
 * Reconstruct production-Bundle-style cumulative frames from already parsed logs.
 *
 * The calculation is deliberately current-graph scoped. Historical entries whose
 * node/edge no longer exists are reported as topology drift and are not projected
 * onto the current graph. A rule-enable entry clears accumulated state and emits a
 * reset frame; rule-disable entries do not emit frames.
 */
export function calculateRuleTrace(input: CalculateRuleTraceInput): RuleTraceCalculation {
  const watchpoints = buildRuleTraceWatchpoints(input.nodes);
  const available = new Set(watchpoints.map((entry) => entry.id));
  const selected =
    input.filter === undefined
      ? new Set(available)
      : new Set(input.filter.filter((entry) => available.has(entry)));
  const frames: RuleTraceFrame[] = [];
  const topologyWatchpoints = new Set<string>();
  const semanticWatchpoints = new Set<string>();
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  let missingWatchpointEntryCount = 0;
  let incompatibleLinkEntryCount = 0;
  let nodeInfoParseFailureCount = 0;
  let matchingLogEntries = 0;
  let status: Record<string, RuleTraceWatchpointStatus> = {};
  let order = 0;

  for (const entry of input.entries) {
    if (entry.graphId !== input.ruleId) continue;
    matchingLogEntries += 1;
    if (entry.rawType === 'r') {
      if (!isEnableEntry(entry)) continue;
      status = {};
      frames.push(makeFrame(frames.length, entry.timestamp, null, status));
      continue;
    }

    const watchpoint = logWatchpointId(entry);
    if (watchpoint === undefined) continue;
    if (!available.has(watchpoint)) {
      topologyWatchpoints.add(watchpoint);
      missingWatchpointEntryCount += 1;
      continue;
    }
    if (entry.rawType === 'l' && !isBundleCompatibleLink(entry, nodesById)) {
      topologyWatchpoints.add(watchpoint);
      semanticWatchpoints.add(watchpoint);
      incompatibleLinkEntryCount += 1;
      continue;
    }
    const translatedInfo =
      entry.rawType === 'i'
        ? bundleNodeInfo(
            nodesById.get(entry.nodeId ?? ''),
            entry.info ?? '',
            input.deviceGetLabels?.[entry.nodeId ?? ''],
          )
        : undefined;
    if (translatedInfo?.ok === false) {
      semanticWatchpoints.add(watchpoint);
      nodeInfoParseFailureCount += 1;
      continue;
    }
    if (!selected.has(watchpoint)) continue;

    status[watchpoint] = {
      order,
      type: traceEntryType(entry),
      timestamp: entry.timestamp,
      info: translatedInfo?.info ?? traceEntryInfo(entry),
    };
    order += 1;
    frames.push(makeFrame(frames.length, entry.timestamp, watchpoint, status));
  }

  return {
    frames,
    watchpoints,
    selectedWatchpoints: [...selected],
    topologyDrift: {
      entryCount: missingWatchpointEntryCount + incompatibleLinkEntryCount,
      missingWatchpointEntryCount,
      incompatibleLinkEntryCount,
      watchpoints: [...topologyWatchpoints],
    },
    semanticDrift: {
      entryCount: nodeInfoParseFailureCount + incompatibleLinkEntryCount,
      nodeInfoParseFailureCount,
      incompatibleLinkEntryCount,
      watchpoints: [...semanticWatchpoints],
    },
    matchingLogEntries,
  };
}

/** Resolve each unique deviceGet URN once and build the shared semantic value lookup by node. */
export async function resolveRuleTraceDeviceGetLabels(
  nodes: Node[],
  options: ResolveRuleTraceDeviceGetLabelsOptions = {},
): Promise<RuleTraceDeviceGetLabelResult> {
  const deviceGetNodes = nodes.filter(isDeviceGetNode);
  const requestedUrns = [
    ...new Set(deviceGetNodes.map((node) => node.cfg.urn).filter((urn) => urn.length > 0)),
  ];
  const loadSpec =
    options.loadSpec ??
    ((urn: string) =>
      getDeviceSpec(
        urn,
        options.semanticOptions?.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.semanticOptions.timeoutMs },
      ));
  const projectSemantics = options.projectSemantics ?? projectDeviceSpecSemantics;
  const projections = new Map<string, SemanticDeviceSpecProjection>();
  const failedUrns: string[] = [];
  const semanticFailedUrns: string[] = [];
  await Promise.all(
    requestedUrns.map(async (urn) => {
      try {
        const spec = await loadSpec(urn);
        try {
          const projection = await projectSemantics(spec, options.semanticOptions);
          projections.set(urn, projection);
        } catch {
          semanticFailedUrns.push(urn);
        }
      } catch {
        failedUrns.push(urn);
      }
    }),
  );
  const labelsByNodeId: Record<string, Record<string, string>> = {};
  for (const node of deviceGetNodes) {
    const valueList = projections
      .get(node.cfg.urn)
      ?.propertyNotify.find(
        (property) => property.siid === node.props.siid && property.piid === node.props.piid,
      )?.valueList;
    if (valueList === undefined) continue;
    labelsByNodeId[node.id] = Object.fromEntries(
      valueList.map((entry) => [String(entry.value), entry.description]),
    );
  }
  failedUrns.sort();
  semanticFailedUrns.sort();
  const catalogStatuses: Array<DeviceSpecSemanticCatalogStatus & { urn: string }> =
    requestedUrns.flatMap((urn) =>
      (projections.get(urn)?.catalogs ?? []).map((status) => ({ urn, ...status })),
    );
  const fallbackStatuses = catalogStatuses.filter((status) => status.status === 'fallback');
  const valueLabelFallbackStatuses = fallbackStatuses.filter((status) =>
    RULE_TRACE_VALUE_LABEL_CATALOGS.has(status.catalog),
  );
  return {
    labelsByNodeId,
    specLookup: { requestedUrns, failedUrns, failureCount: failedUrns.length },
    semanticProjection: {
      attemptedUrns: requestedUrns.filter((urn) => !failedUrns.includes(urn)),
      failedUrns: semanticFailedUrns,
      failureCount: semanticFailedUrns.length,
      catalogStatuses,
      catalogFallbackUrns: [...new Set(fallbackStatuses.map((status) => status.urn))],
      catalogFallbackCount: fallbackStatuses.length,
      valueLabelFallbackUrns: [...new Set(valueLabelFallbackStatuses.map((status) => status.urn))],
      valueLabelFallbackCatalogCount: valueLabelFallbackStatuses.length,
    },
  };
}

function isDeviceGetNode(node: Node): node is DeviceGetNode {
  if (node.type !== 'deviceGet' || node.cfg === null || typeof node.cfg !== 'object') {
    return false;
  }
  const cfg = node.cfg as Record<string, unknown>;
  const props = (node as { props?: unknown }).props;
  if (props === null || typeof props !== 'object') return false;
  const { siid, piid } = props as Record<string, unknown>;
  return (
    typeof cfg.urn === 'string' &&
    Number.isInteger(siid) &&
    Number.isFinite(siid) &&
    Number.isInteger(piid) &&
    Number.isFinite(piid)
  );
}

/** Find the first frame at or after `from` whose changed watchpoint is selected. */
export function findNextRuleTraceWatchpoint(
  frames: RuleTraceFrame[],
  from: number,
  watchpoints: readonly string[],
): RuleTraceFrame | undefined {
  const selected = new Set(watchpoints);
  for (let step = Math.max(0, from); step < frames.length; step += 1) {
    const frame = frames[step];
    if (frame?.changed !== null && frame?.changed !== undefined && selected.has(frame.changed)) {
      return frame;
    }
  }
  return undefined;
}

function makeFrame(
  step: number,
  timestamp: number,
  changed: string | null,
  status: Record<string, RuleTraceWatchpointStatus>,
): RuleTraceFrame {
  return {
    step,
    timestamp,
    iso: new Date(timestamp).toISOString(),
    changed,
    status: { ...status },
  };
}

function isEnableEntry(entry: RuleLogEntry): boolean {
  return (
    entry.ruleConfig !== null &&
    typeof entry.ruleConfig === 'object' &&
    !Array.isArray(entry.ruleConfig) &&
    (entry.ruleConfig as { enable?: unknown }).enable === true
  );
}

function logWatchpointId(entry: RuleLogEntry): string | undefined {
  if (entry.rawType === 'l') {
    if (entry.src === undefined || entry.dst === undefined) return undefined;
    return ruleTraceLinkWatchpointId(entry.src, entry.dst);
  }
  if (entry.nodeId === undefined) return undefined;
  return ruleTraceNodeWatchpointId(entry.nodeId);
}

function traceEntryType(entry: RuleLogEntry): RuleTraceWatchpointStatus['type'] {
  if (entry.rawType === 'l') return 'link';
  if (entry.rawType === 'e') return 'error';
  return 'info';
}

function traceEntryInfo(entry: RuleLogEntry): string {
  if (entry.rawType === 'l') {
    if (entry.linkValue === 'true') return '真';
    if (entry.linkValue === 'false') return '伪';
    if (entry.linkValue === 'null' || entry.linkValue === undefined) return '事件';
    return '未定义';
  }
  if (entry.rawType === 'e') {
    return `错误码: ${entry.errorCode ?? -1}, 错误信息: ${entry.errorMessage ?? '未知错误'}`;
  }
  return entry.info ?? '';
}

type BundleInfoResult = { ok: true; info: string } | { ok: false };

/** Reproduce the production Bundle node `getInfo` overrides without device/spec I/O. */
function bundleNodeInfo(
  node: Node | undefined,
  raw: string,
  deviceGetLabels: Readonly<Record<string, string>> | undefined,
): BundleInfoResult {
  if (node === undefined) return { ok: true, info: '未知信息' };
  try {
    switch (node.type) {
      case 'deviceOutput': {
        if (raw === 'success') return { ok: true, info: '执行成功' };
        const args = JSON.parse(raw) as unknown;
        if (!Array.isArray(args)) return { ok: false };
        return { ok: true, info: `命令发送，参数为：${args.join(',')}` };
      }
      case 'deviceGet':
        return { ok: true, info: `查询成功, 值为${deviceGetLabels?.[raw] ?? raw}` };
      case 'onlyNTimes': {
        const parsed = parseInfoObject(raw);
        if (parsed === undefined) return { ok: false };
        if ('n' in parsed) return { ok: true, info: `当前计数为${String(parsed.n)}` };
        if ('max' in parsed) return { ok: true, info: '已达到上限' };
        return { ok: true, info: '未知信息' };
      }
      case 'counter': {
        const parsed = parseInfoObject(raw);
        if (parsed === undefined) return { ok: false };
        return 'n' in parsed
          ? { ok: true, info: `当前计数为${String(parsed.n)}` }
          : { ok: true, info: '未知信息' };
      }
      case 'deviceInputSetVar': {
        const props = node.props as Record<string, unknown>;
        if ('piid' in props) return { ok: true, info: `变量被设置为：${raw}` };
        const values = JSON.parse(raw) as unknown;
        if (!Array.isArray(values)) return { ok: false };
        return {
          ok: true,
          info: `变量被设置为：${values.map((value) => JSON.stringify(value)).join(',')}`,
        };
      }
      case 'deviceGetSetVar':
      case 'varSetNumber':
      case 'varSetString':
        return { ok: true, info: `变量被设置为：${raw}` };
      case 'varGet':
        return { ok: true, info: `查询到的变量值为：${raw}` };
      default:
        return { ok: true, info: '未知信息' };
    }
  } catch {
    // Production wraps each parsed entry and silently drops getInfo failures.
    return { ok: false };
  }
}

function parseInfoObject(raw: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(raw) as unknown;
  return parsed !== null && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : undefined;
}

const EVENT_VALUE = ['null'] as const;
const STATE_VALUES = ['true', 'false'] as const;
const DUAL_VALUES = ['true', 'false', 'null'] as const;

/** Apply the Bundle's declared inputTypes/outputTypes checks for known pins. */
function isBundleCompatibleLink(entry: RuleLogEntry, nodesById: Map<string, Node>): boolean {
  if (entry.src === undefined || entry.dst === undefined || entry.linkValue === undefined)
    return false;
  const [srcNodeId, srcPin] = entry.src.split('.');
  const [dstNodeId, dstPin] = entry.dst.split('.');
  if (
    srcNodeId === undefined ||
    srcPin === undefined ||
    dstNodeId === undefined ||
    dstPin === undefined
  ) {
    return false;
  }
  const outputValues = bundlePinValues(nodesById.get(srcNodeId), 'output', srcPin);
  const inputValues = bundlePinValues(nodesById.get(dstNodeId), 'input', dstPin);
  return (
    (outputValues === undefined || outputValues.includes(entry.linkValue)) &&
    (inputValues === undefined || inputValues.includes(entry.linkValue))
  );
}

function bundlePinValues(
  node: Node | undefined,
  direction: 'input' | 'output',
  pin: string,
): readonly string[] | undefined {
  if (node === undefined) return undefined;
  if (direction === 'output') {
    switch (node.type) {
      case 'deviceInput':
        return pin === 'output' ? DUAL_VALUES : undefined;
      case 'timeRange':
      case 'logicOr':
      case 'logicAnd':
      case 'logicNot':
      case 'counter':
      case 'register':
      case 'statusLast':
      case 'varChange':
        return pin === 'output' ? DUAL_VALUES : undefined;
      case 'deviceGet':
      case 'varGet':
        return pin === 'output' || pin === 'output2' ? EVENT_VALUE : undefined;
      case 'modeSwitch':
        return hasPin(node.outputs, pin) ? EVENT_VALUE : undefined;
      case 'deviceOutput':
      case 'alarmClock':
      case 'delay':
      case 'signalOr':
      case 'condition':
      case 'loop':
      case 'onlyNTimes':
      case 'eventSequence':
      case 'onLoad':
      case 'deviceInputSetVar':
      case 'deviceGetSetVar':
      case 'varSetNumber':
      case 'varSetString':
        return hasPin(node.outputs, pin) ? EVENT_VALUE : undefined;
      default:
        return undefined;
    }
  }

  switch (node.type) {
    case 'logicOr':
    case 'logicAnd':
      return hasPin(node.inputs, pin) ? STATE_VALUES : undefined;
    case 'logicNot':
    case 'statusLast':
      return pin === 'input' ? STATE_VALUES : undefined;
    case 'condition':
      if (pin === 'trigger') return EVENT_VALUE;
      return pin === 'condition' ? STATE_VALUES : undefined;
    case 'signalOr':
      return hasPin(node.inputs, pin) ? EVENT_VALUE : undefined;
    case 'deviceOutput':
      return pin === 'trigger' ? EVENT_VALUE : undefined;
    case 'deviceGet':
    case 'delay':
    case 'modeSwitch':
    case 'eventSequence':
    case 'deviceGetSetVar':
    case 'varGet':
    case 'varSetNumber':
    case 'varSetString':
      return hasPin(node.inputs, pin) ? EVENT_VALUE : undefined;
    case 'loop':
    case 'onlyNTimes':
    case 'counter':
    case 'register':
      return hasPin(node.inputs, pin) ? EVENT_VALUE : undefined;
    default:
      return undefined;
  }
}

function hasPin(value: unknown, pin: string): boolean {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, pin);
}
