import type { DeviceSpec } from '../schemas/device-spec.js';
import type { DeviceGetNode } from '../schemas/nodes/device-get.js';
import type { Node } from '../schemas/rule.js';
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
}

export interface ResolveRuleTraceDeviceGetLabelsOptions {
  /** Test seam; defaults to the shared cached public MIoT spec loader. */
  loadSpec?: (urn: string) => Promise<DeviceSpec>;
}

const BUNDLE_BOOLEAN_LABELS: Readonly<Record<string, { true: string; false: string }>> = {
  'urn:miot-spec-v2:property:air-cooler:000000EB': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:alarm:00000012': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:anion:00000025': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:anti-fake:00000130': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:arrhythmia:000000B4': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:auto-cleanup:00000124': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:auto-deodorization:00000125': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:auto-keep-warm:0000002B': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:automatic-feeding:000000F0': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:blow:000000CD': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:card-insertion-state:00000106': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:contact-state:0000007C': { true: '接触', false: '分离' },
  'urn:miot-spec-v2:property:current-physical-control-lock:00000099': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:delay:0000014F': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:deodorization:000000C6': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:dns-auto-mode:000000DC': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:driving-status:000000B9': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:dryer:00000027': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:eco:00000024': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:glimmer-full-color:00000089': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:guard-mode:000000B6': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:heater:00000026': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:heating:000000C7': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:horizontal-swing:00000017': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:hot-water-recirculation:0000011C': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:image-distortion-correction:0000010F': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:local-storage:0000011E': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:motion-detection:00000056': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:motion-state:0000007D': { true: '有人', false: '无人' },
  'urn:miot-spec-v2:property:motion-tracking:0000008A': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:motor-reverse:00000072': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:off-delay:00000053': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:on:00000006': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:physical-controls-locked:0000001D': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:plasma:00000132': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:preheat:00000103': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:seating-state:000000B8': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:silent-execution:000000FB': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:sleep-aid-mode:0000010B': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:sleep-mode:00000028': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:snore-state:0000012A': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:soft-wind:000000CF': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:speed-control:000000E8': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:submersion-state:0000007E': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:time-watermark:00000087': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:un-straight-blowing:00000100': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:uv:00000029': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:valve-switch:000000FE': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:ventilation:000000CE': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:vertical-swing:00000018': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wake-up-mode:00000107': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:water-pump:000000F2': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:watering:000000CC': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wdr-mode:00000088': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wet:0000002A': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wifi-band-combine:000000E0': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wifi-ssid-hidden:000000E3': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:wind-reverse:00000117': { true: '是', false: '否' },
};

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

/** Resolve each unique deviceGet URN once and build the Bundle value-list lookup by node. */
export async function resolveRuleTraceDeviceGetLabels(
  nodes: Node[],
  options: ResolveRuleTraceDeviceGetLabelsOptions = {},
): Promise<RuleTraceDeviceGetLabelResult> {
  const deviceGetNodes = nodes.filter(isDeviceGetNode);
  const requestedUrns = [
    ...new Set(deviceGetNodes.map((node) => node.cfg.urn).filter((urn) => urn.length > 0)),
  ];
  const loadSpec = options.loadSpec ?? ((urn: string) => getDeviceSpec(urn));
  const specs = new Map<string, DeviceSpec>();
  const failedUrns: string[] = [];
  await Promise.all(
    requestedUrns.map(async (urn) => {
      try {
        specs.set(urn, await loadSpec(urn));
      } catch {
        failedUrns.push(urn);
      }
    }),
  );
  const labelsByNodeId: Record<string, Record<string, string>> = {};
  for (const node of deviceGetNodes) {
    const spec = specs.get(node.cfg.urn);
    const property = spec?.services
      .find((service) => service.iid === node.props.siid)
      ?.properties?.find((entry) => entry.iid === node.props.piid);
    if (property?.access.includes('notify') !== true) continue;
    const booleanLabels =
      property.format === 'bool'
        ? (BUNDLE_BOOLEAN_LABELS[property.type.split(':').slice(0, 5).join(':')] ?? {
            true: 'true',
            false: 'false',
          })
        : undefined;
    const valueList =
      property['value-list'] ??
      (booleanLabels === undefined
        ? undefined
        : [
            { value: true, description: booleanLabels.true },
            { value: false, description: booleanLabels.false },
          ]);
    if (valueList === undefined) continue;
    labelsByNodeId[node.id] = Object.fromEntries(
      valueList.map((entry) => [String(entry.value), entry.description]),
    );
  }
  failedUrns.sort();
  return {
    labelsByNodeId,
    specLookup: { requestedUrns, failedUrns, failureCount: failedUrns.length },
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
