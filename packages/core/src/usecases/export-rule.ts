import { getDevice } from '../resources/devices.js';
import type { ResourceDeps } from '../resources/index.js';
import { type RuleView, getRule, listRules } from '../resources/rules.js';
import type { DeviceSpec, MiotAction, MiotProperty, MiotService } from '../schemas/device-spec.js';
import { ConfigError, NotFoundError } from '../transport/errors.js';
import { getDeviceSpec } from './get-device-spec.js';

/**
 * One CLI invocation the exporter emits (in order). The shape is structured
 * so callers can render either a shell script or a JSON description without
 * re-parsing strings.
 */
export type ExportedCommand =
  | { kind: 'shell-prelude'; comment: string }
  | { kind: 'rule-set-body'; bodyJson: string; description: string }
  | { kind: 'node-add'; nodeId: string; type: string; flags: ExportFlag[]; comment: string }
  | { kind: 'edge-add'; from: string; to: string }
  | { kind: 'rule-enable' }
  | { kind: 'warning'; message: string };

export interface ExportFlag {
  name: string;
  /** When present, this flag carries a value (e.g. `--device-did <DID>`). */
  value?: string;
  /** True when the value must be wrapped in single quotes in shell rendering. */
  needsQuoting?: boolean;
}

export interface ExportedRule {
  ruleId: string;
  ruleName: string;
  /** Whether the source rule was enabled (affects whether we append rule enable). */
  enable: boolean;
  commands: ExportedCommand[];
  /** Warnings that should be surfaced to the user but don't block emission. */
  warnings: string[];
}

export interface ExportRuleInputs extends ResourceDeps {
  ruleId: string;
  /**
   * Optional rename applied to the exported clone. Lets one call clone a rule
   * to a new id (and optionally a new userData.name) without post-processing
   * the script with `sed`.
   *
   * - `targetId` only           → name becomes "[Cloned] <original>" by default
   * - `targetId` + `targetName` → both replaced verbatim
   * - `targetName` only         → only name replaced (id preserved — useful
   *                                for in-place rename via re-import)
   */
  rename?: RenameOptions;
  /**
   * F54 (2026-05-30) — when true, the exporter throws ConfigError if any
   * node carries a `cfg` key that the renderer would silently drop on
   * round-trip (e.g. UI-saved `cfg.simplified`). Default false; the
   * exporter then emits a `kind: 'warning'` command per dropped key so
   * the user can still re-import the script but is told what was lost.
   *
   * Turn this on in CI / agent-funnel paths where byte-identical
   * round-trip matters more than partial-export convenience.
   */
  strictRoundtrip?: boolean;
}

export interface RenameOptions {
  targetId?: string;
  targetName?: string;
}

/**
 * Reverse-translate a rule on the gateway into the `xgg` CLI command sequence
 * that would recreate it. Mirrors the forward path used by `xgg rule node
 * add` c-shortcuts so the output is round-trip-safe (modulo node id
 * randomisation, which we preserve verbatim via `--id`).
 */
export async function exportRule(input: ExportRuleInputs): Promise<ExportedRule> {
  // listRules + getRule mirrors viewRule's two-read shape but lets us be
  // explicit about the parallel fetches.
  const [rules, body] = await Promise.all([listRules(input), getRule(input.ruleId, input)]);
  const cfg = rules.find((r) => r.id === input.ruleId);
  if (cfg === undefined) {
    throw new NotFoundError(`rule not found: ${input.ruleId}`, { id: input.ruleId });
  }
  const view: RuleView = { id: input.ruleId, cfg, nodes: body.nodes };
  return exportRuleFromView(view, input, input.rename, input.strictRoundtrip);
}

/**
 * Same as `exportRule` but accepts an already-fetched RuleView — handy for
 * tests and for callers that already paid for the read.
 *
 * @param rename - When provided, the script will recreate the rule under a
 *   new id and/or name. See `RenameOptions` for the rules.
 */
export async function exportRuleFromView(
  view: RuleView,
  deps: ResourceDeps,
  rename?: RenameOptions,
  strictRoundtrip = false,
): Promise<ExportedRule> {
  const commands: ExportedCommand[] = [];
  const warnings: string[] = [];

  // Resolve final id + name from rename options. Auto-prepend "[Cloned] " is
  // a friendliness layer: if the caller provided a new id but no new name,
  // we change the name too so the clone is distinguishable on the gateway UI.
  const finalId = rename?.targetId ?? view.id;
  const finalName =
    rename?.targetName !== undefined
      ? rename.targetName
      : rename?.targetId !== undefined
        ? `[Cloned] ${view.cfg.userData.name}`
        : view.cfg.userData.name;

  // 1. Prelude + shell rule body so the script is self-contained.
  commands.push({
    kind: 'shell-prelude',
    comment: `Recreate rule ${finalId} ("${finalName}") from a gateway snapshot.`,
  });
  const shellCfg = {
    id: finalId,
    nodes: [] as unknown[],
    cfg: {
      id: finalId,
      uiType: view.cfg.uiType,
      enable: false,
      userData: { ...view.cfg.userData, name: finalName },
    },
  };
  commands.push({
    kind: 'rule-set-body',
    bodyJson: JSON.stringify(shellCfg, null, 2),
    description:
      'empty shell carrying the rule id, uiType and userData (enable=false; we re-enable at the end if needed)',
  });

  // 2. Per-node add commands. Some need device spec fetches (deviceInput /
  //    deviceOutput) to reverse siid+piid into property/action/event names —
  //    we cache by did so a rule with many nodes touching the same device
  //    only fetches once.
  const specCache = new Map<string, DeviceSpec>();
  for (const node of view.nodes) {
    const result = await renderNode(node, deps, specCache, warnings);
    if (result) commands.push(result);
    // F54 (2026-05-30) — diff the node's cfg against the renderer's
    // known keys. Anything else (e.g. UI-saved cfg.simplified, cfg.urn
    // on a non-device card) would silently drop on the script-replay
    // round-trip. Emit a warning (and in strict mode, throw) so the
    // caller knows exactly which keys were lost.
    const n = node as { id?: unknown; type?: unknown; cfg?: unknown };
    if (isRecord(n.cfg) && typeof n.id === 'string' && typeof n.type === 'string') {
      const dropped = unknownCfgKeys(n.cfg);
      if (dropped.length > 0) {
        const msg = `node ${n.id} (${n.type}) carries cfg keys the exporter drops on round-trip: ${dropped.join(', ')}`;
        if (strictRoundtrip) {
          throw new ConfigError(
            `${msg}. Pass without --strict-roundtrip to emit a warning and continue, or re-author via raw setGraph to preserve the extras.`,
            { nodeId: n.id, nodeType: n.type, dropped },
          );
        }
        warnings.push(msg);
      }
    }
  }

  // 3. Edge commands — derive from each node's outputs[pin] → ["nid.pin", ...].
  // Gateway stores the target as `nid.pin` (dot); CLI's parseEdgeRef expects
  // `nid:pin` (colon). Translate so `bash <(xgg rule export)` round-trips.
  for (const node of view.nodes) {
    const outputs = (node as { id: string; outputs?: Record<string, unknown> }).outputs ?? {};
    const srcId = (node as { id: string }).id;
    for (const [pin, targets] of Object.entries(outputs)) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        if (typeof target !== 'string') continue;
        const colonTarget = target.replace('.', ':');
        commands.push({ kind: 'edge-add', from: `${srcId}:${pin}`, to: colonTarget });
      }
    }
  }

  // 4. Re-enable if source was enabled.
  if (view.cfg.enable) commands.push({ kind: 'rule-enable' });

  // 5. Bubble up any per-node warnings (e.g. unknown node types we passed
  //    through as raw cfg) so the CLI can stderr them.
  for (const w of warnings) commands.push({ kind: 'warning', message: w });

  return {
    ruleId: finalId,
    ruleName: finalName,
    enable: view.cfg.enable,
    commands,
    warnings,
  };
}

async function renderNode(
  node: unknown,
  deps: ResourceDeps,
  specCache: Map<string, DeviceSpec>,
  warnings: string[],
): Promise<ExportedCommand | null> {
  const n = node as {
    id: string;
    type: string;
    cfg?: Record<string, unknown>;
    props?: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
  };
  switch (n.type) {
    case 'deviceInput':
      return renderDeviceInput(n, deps, specCache, warnings);
    case 'deviceGet':
      return renderDeviceGet(n, deps, specCache, warnings);
    case 'deviceInputSetVar':
    case 'deviceGetSetVar':
      return renderDeviceSetVar(n, deps, specCache, warnings);
    case 'deviceOutput':
      return renderDeviceOutput(n, deps, specCache, warnings);
    case 'onLoad':
    case 'condition':
      return simpleNode(n, n.type);
    case 'logicAnd':
    case 'logicOr':
    case 'signalOr':
      return logicGate(n, n.type);
    case 'logicNot':
      return simpleNode(n, n.type);
    case 'counter':
    case 'onlyNTimes':
      return counterNode(n, n.type);
    case 'delay':
    case 'statusLast':
      return durationNode(n, n.type, '--duration', 'timeout');
    case 'loop':
      return durationNode(n, 'loop', '--interval', 'interval');
    case 'timeRange':
      return renderTimeRange(n);
    case 'varChange':
      return renderVarChange(n);
    case 'varGet':
      return renderVarGet(n);
    case 'varSetNumber':
    case 'varSetString':
      return renderVarSet(n, n.type);
    case 'register':
      return simpleNode(n, 'register');
    case 'eventSequence':
      return durationNode(n, 'eventSequence', '--duration', 'timeout');
    case 'modeSwitch':
      return renderModeSwitch(n);
    case 'alarmClock':
      return renderAlarmClock(n);
    default:
      // Unknown / not-yet-supported type — leave a warning so the user knows
      // to hand-port that node. Returning null skips emitting any command
      // for this node.
      warnings.push(
        `node "${n.id}" (type "${n.type}") has no c-shortcut equivalent yet; recreate it manually with \`xgg rule node add --type ${n.type} --cfg '<JSON>'\``,
      );
      return {
        kind: 'warning',
        message: `unhandled node type "${n.type}" (id ${n.id})`,
      };
  }
}

async function renderDeviceInput(
  n: { id: string; cfg?: Record<string, unknown>; props?: Record<string, unknown> },
  deps: ResourceDeps,
  specCache: Map<string, DeviceSpec>,
  warnings: string[],
): Promise<ExportedCommand> {
  const props = n.props ?? {};
  const did = String(props.did ?? '');
  if (!did) throw new ConfigError(`deviceInput node ${n.id} has no props.did`);
  const isEvent = props.eiid !== undefined;
  const isProperty = props.piid !== undefined;

  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: 'deviceInput' },
    { name: '--device-did', value: did },
    ...posFlagsFromCfg(n.cfg),
  ];

  if (isEvent) {
    const spec = await ensureSpec(did, deps, specCache);
    const eventName = findEventName(spec, Number(props.siid), Number(props.eiid));
    if (eventName === null) {
      warnings.push(
        `deviceInput node ${n.id}: event siid=${props.siid} eiid=${props.eiid} not found in device spec — exporting raw cfg fallback may be needed`,
      );
      flags.push({
        name: '--device-event',
        value: `<UNKNOWN_EVENT_siid${props.siid}_eiid${props.eiid}>`,
      });
    } else {
      flags.push({ name: '--device-event', value: eventName });
    }
  } else if (isProperty) {
    const spec = await ensureSpec(did, deps, specCache);
    const propertyName = findPropertyName(spec, Number(props.siid), Number(props.piid));
    if (propertyName === null) {
      warnings.push(
        `deviceInput node ${n.id}: property siid=${props.siid} piid=${props.piid} not found in device spec`,
      );
      flags.push({
        name: '--device-property',
        value: `<UNKNOWN_PROPERTY_siid${props.siid}_piid${props.piid}>`,
      });
    } else {
      flags.push({ name: '--device-property', value: propertyName });
    }
    const reverseOp = reverseOpSymbol(String(props.operator));
    if (reverseOp !== null) flags.push({ name: '--op', value: reverseOp });
    // Threshold reverse: scalar number / [v] array (int+include, M7 F14)
    // OR scalar boolean (bool wire, F14 REWRITTEN 2026-05-28). Boolean
    // round-trips through the CLI flag as `1`/`0`; the synthesizer
    // re-coerces via Boolean() to scalar true/false at re-author time.
    const v1 = props.v1;
    const threshold = Array.isArray(v1) ? v1[0] : v1;
    if (typeof threshold === 'number')
      flags.push({ name: '--threshold', value: String(threshold) });
    else if (typeof threshold === 'boolean')
      flags.push({ name: '--threshold', value: threshold ? '1' : '0' });
    // F49 (2026-05-30): `between` operator carries v2 on the wire —
    // round-trip via --threshold2 so the replayed script regenerates
    // the same range gate.
    if (props.operator === 'between' && typeof props.v2 === 'number') {
      flags.push({ name: '--threshold2', value: String(props.v2) });
    }
  } else {
    warnings.push(
      `deviceInput node ${n.id}: neither piid nor eiid in props; cannot infer trigger kind`,
    );
  }

  return {
    kind: 'node-add',
    nodeId: n.id,
    type: 'deviceInput',
    flags,
    comment: 'deviceInput trigger',
  };
}

// M14 task D — deviceGet exporter mirror. Same property-driven projection as
// deviceInput; differs in `--type deviceGet`, and the wire-shape distinction
// (input/output2 pins) lives in the synthesizer, not here.
async function renderDeviceGet(
  n: { id: string; cfg?: Record<string, unknown>; props?: Record<string, unknown> },
  deps: ResourceDeps,
  specCache: Map<string, DeviceSpec>,
  warnings: string[],
): Promise<ExportedCommand> {
  const props = n.props ?? {};
  const did = String(props.did ?? '');
  if (!did) throw new ConfigError(`deviceGet node ${n.id} has no props.did`);

  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: 'deviceGet' },
    { name: '--device-did', value: did },
    ...posFlagsFromCfg(n.cfg),
  ];

  const spec = await ensureSpec(did, deps, specCache);
  const propertyName = findPropertyName(spec, Number(props.siid), Number(props.piid));
  if (propertyName === null) {
    warnings.push(
      `deviceGet node ${n.id}: property siid=${props.siid} piid=${props.piid} not found in device spec`,
    );
    flags.push({
      name: '--device-property',
      value: `<UNKNOWN_PROPERTY_siid${props.siid}_piid${props.piid}>`,
    });
  } else {
    flags.push({ name: '--device-property', value: propertyName });
  }
  const reverseOp = reverseOpSymbol(String(props.operator));
  if (reverseOp !== null) flags.push({ name: '--op', value: reverseOp });
  const v1 = props.v1;
  const threshold = Array.isArray(v1) ? v1[0] : v1;
  if (typeof threshold === 'number') flags.push({ name: '--threshold', value: String(threshold) });
  else if (typeof threshold === 'boolean')
    flags.push({ name: '--threshold', value: threshold ? '1' : '0' });
  // F49 (2026-05-30) — between round-trip mirrors deviceInput above.
  if (props.operator === 'between' && typeof props.v2 === 'number') {
    flags.push({ name: '--threshold2', value: String(props.v2) });
  }

  return {
    kind: 'node-add',
    nodeId: n.id,
    type: 'deviceGet',
    flags,
    comment: 'deviceGet query',
  };
}

async function renderDeviceSetVar(
  n: { id: string; type: string; cfg?: Record<string, unknown>; props?: Record<string, unknown> },
  deps: ResourceDeps,
  specCache: Map<string, DeviceSpec>,
  warnings: string[],
): Promise<ExportedCommand> {
  const props = n.props ?? {};
  const did = String(props.did ?? '');
  if (!did) throw new ConfigError(`${n.type} node ${n.id} has no props.did`);

  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: n.type },
    { name: '--device-did', value: did },
    ...posFlagsFromCfg(n.cfg),
  ];

  const spec = await ensureSpec(did, deps, specCache);
  // F50 (2026-05-30) — deviceInputSetVar can be event-mode
  // ({eiid, arguments: [...]}) in addition to property-mode ({piid,
  // dtype, scope, id}). Detect via the presence of `eiid` in props.
  // deviceGetSetVar is always property-mode per bundle.
  if (n.type === 'deviceInputSetVar' && typeof props.eiid === 'number') {
    const eventName = findEventName(spec, Number(props.siid), Number(props.eiid));
    if (eventName === null) {
      warnings.push(
        `deviceInputSetVar node ${n.id}: event siid=${props.siid} eiid=${props.eiid} not found in device spec`,
      );
      flags.push({
        name: '--device-event',
        value: `<UNKNOWN_EVENT_siid${props.siid}_eiid${props.eiid}>`,
      });
    } else {
      flags.push({ name: '--device-event', value: eventName });
    }
    // 1-arg event with scope/id route → carry --var-scope/--var-id.
    // 0-arg event (BLE button click) emits no var flags.
    // B4 / F65a (2026-05-30) — multi-arg events now round-trip via
    // repeated `--event-arg-var <piid>=<scope>.<id>` flags. Previously a
    // multi-arg setVar node was flagged as a lossy round-trip; the new
    // c-shortcut surface captures the full shape.
    const args = Array.isArray(props.arguments) ? props.arguments : [];
    if (args.length === 1) {
      const arg = args[0] as Record<string, unknown>;
      if (typeof arg.scope === 'string') flags.push({ name: '--var-scope', value: arg.scope });
      if (typeof arg.id === 'string') flags.push({ name: '--var-id', value: arg.id });
    } else if (args.length > 1) {
      for (const a of args) {
        const arg = a as Record<string, unknown>;
        if (
          typeof arg.piid === 'number' &&
          typeof arg.scope === 'string' &&
          typeof arg.id === 'string'
        ) {
          flags.push({
            name: '--event-arg-var',
            value: `${arg.piid}=${arg.scope}.${arg.id}`,
          });
        } else {
          warnings.push(
            `deviceInputSetVar node ${n.id}: event ${eventName ?? `eiid=${props.eiid}`} argument ${JSON.stringify(arg)} missing piid/scope/id — cannot round-trip via --event-arg-var`,
          );
        }
      }
    }
    return {
      kind: 'node-add',
      nodeId: n.id,
      type: n.type,
      flags,
      comment: n.type,
    };
  }
  const propertyName = findPropertyName(spec, Number(props.siid), Number(props.piid));
  if (propertyName === null) {
    warnings.push(
      `${n.type} node ${n.id}: property siid=${props.siid} piid=${props.piid} not found in device spec`,
    );
    flags.push({
      name: '--device-property',
      value: `<UNKNOWN_PROPERTY_siid${props.siid}_piid${props.piid}>`,
    });
  } else {
    flags.push({ name: '--device-property', value: propertyName });
  }

  if (typeof props.scope === 'string') flags.push({ name: '--var-scope', value: props.scope });
  if (typeof props.id === 'string') flags.push({ name: '--var-id', value: props.id });

  return {
    kind: 'node-add',
    nodeId: n.id,
    type: n.type,
    flags,
    comment: n.type,
  };
}

async function renderDeviceOutput(
  n: { id: string; cfg?: Record<string, unknown>; props?: Record<string, unknown> },
  deps: ResourceDeps,
  specCache: Map<string, DeviceSpec>,
  warnings: string[],
): Promise<ExportedCommand> {
  const props = n.props ?? {};
  const did = String(props.did ?? '');
  if (!did) throw new ConfigError(`deviceOutput node ${n.id} has no props.did`);
  const isAction = props.aiid !== undefined;

  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: 'deviceOutput' },
    { name: '--device-did', value: did },
    ...posFlagsFromCfg(n.cfg),
  ];

  if (isAction) {
    const spec = await ensureSpec(did, deps, specCache);
    const result = findActionName(spec, Number(props.siid), Number(props.aiid));
    if (result === null) {
      warnings.push(
        `deviceOutput node ${n.id}: action siid=${props.siid} aiid=${props.aiid} not found in device spec`,
      );
      flags.push({
        name: '--device-action',
        value: `<UNKNOWN_ACTION_siid${props.siid}_aiid${props.aiid}>`,
      });
    } else {
      flags.push({ name: '--device-action', value: result.actionName });
      const ins = Array.isArray(props.ins)
        ? (props.ins as Array<Record<string, unknown> & { piid: number }>)
        : [];
      if (ins.length > 0) {
        const params: Record<string, unknown> = {};
        for (const arg of ins) {
          const paramName =
            findPropertyName(spec, Number(props.siid), arg.piid) ?? `piid-${arg.piid}`;
          if (isDeviceOutputVariableRef(arg)) {
            params[paramName] = { $var: `${arg.scope}.${arg.id}` };
          } else {
            params[paramName] = arg.value;
          }
        }
        flags.push({ name: '--params', value: JSON.stringify(params), needsQuoting: true });
      }
    }
  } else if (props.piid !== undefined) {
    // F16 property-write shape
    const spec = await ensureSpec(did, deps, specCache);
    const propertyName = findPropertyName(spec, Number(props.siid), Number(props.piid));
    if (propertyName === null) {
      flags.push({
        name: '--device-property',
        value: `<UNKNOWN_PROPERTY_siid${props.siid}_piid${props.piid}>`,
      });
    } else {
      flags.push({ name: '--device-property', value: propertyName });
    }
    if (props.value !== undefined) flags.push({ name: '--value', value: String(props.value) });
    else if (isDeviceOutputVariableRef(props)) {
      flags.push({ name: '--value', value: `$${props.scope}.${props.id}`, needsQuoting: true });
    }
  } else {
    warnings.push(
      `deviceOutput node ${n.id}: neither aiid nor piid in props; cannot infer action kind`,
    );
  }

  return {
    kind: 'node-add',
    nodeId: n.id,
    type: 'deviceOutput',
    flags,
    comment: 'deviceOutput',
  };
}

// M14 task G — modeSwitch reverse: outputs has N `output<i>` pins; we
// emit `--outputs <N>` so a round-trip restores the pin count. Omit
// `--outputs 2` since 2 is the synthesizer default.
function renderModeSwitch(n: {
  id: string;
  cfg?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}): ExportedCommand {
  const outputCount = Object.keys(n.outputs ?? {}).length;
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: 'modeSwitch' },
    ...posFlagsFromCfg(n.cfg),
  ];
  if (outputCount !== 2) flags.push({ name: '--outputs', value: String(outputCount) });
  return {
    kind: 'node-add',
    nodeId: n.id,
    type: 'modeSwitch',
    flags,
    comment: `modeSwitch (${outputCount} outputs)`,
  };
}

function simpleNode(
  n: { id: string; cfg?: Record<string, unknown> },
  type: string,
): ExportedCommand {
  return {
    kind: 'node-add',
    nodeId: n.id,
    type,
    flags: [
      { name: '--id', value: n.id },
      { name: '--type', value: type },
      ...posFlagsFromCfg(n.cfg),
    ],
    comment: type,
  };
}

function logicGate(
  n: { id: string; cfg?: Record<string, unknown>; inputs?: Record<string, unknown> },
  type: string,
): ExportedCommand {
  const inputCount = Object.keys(n.inputs ?? {}).length || 2;
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: type },
    ...posFlagsFromCfg(n.cfg),
  ];
  if (inputCount !== 2) flags.push({ name: '--inputs', value: String(inputCount) });
  return { kind: 'node-add', nodeId: n.id, type, flags, comment: `${type} (${inputCount} inputs)` };
}

function counterNode(
  n: { id: string; cfg?: Record<string, unknown>; props?: Record<string, unknown> },
  type: string,
): ExportedCommand {
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: type },
    ...posFlagsFromCfg(n.cfg),
  ];
  if (typeof n.props?.n === 'number') flags.push({ name: '--threshold', value: String(n.props.n) });
  return { kind: 'node-add', nodeId: n.id, type, flags, comment: type };
}

function durationNode(
  n: { id: string; cfg?: Record<string, unknown>; props?: Record<string, unknown> },
  type: string,
  flagName: '--duration' | '--interval',
  propName: 'timeout' | 'interval',
): ExportedCommand {
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: type },
    ...posFlagsFromCfg(n.cfg),
  ];
  const duration = renderDurationFromCfgAndProps(n.cfg, n.props?.[propName]);
  if (duration !== null) flags.push({ name: flagName, value: duration });
  return { kind: 'node-add', nodeId: n.id, type, flags, comment: type };
}

function renderDurationFromCfgAndProps(
  cfg: Record<string, unknown> | undefined,
  rawMs: unknown,
): string | null {
  const ms = typeof rawMs === 'number' && Number.isFinite(rawMs) && rawMs > 0 ? rawMs : null;
  const cfgDuration = durationLiteralFromCfg(cfg);
  if (ms !== null && cfgDuration !== null && cfgDuration.ms === ms) {
    return cfgDuration.literal;
  }
  if (ms !== null && Number.isInteger(ms)) return `${ms}ms`;
  if (cfgDuration !== null) return cfgDuration.literal;
  return null;
}

function durationLiteralFromCfg(
  cfg: Record<string, unknown> | undefined,
): { literal: string; ms: number } | null {
  if (!cfg) return null;
  const unit = cfg.unit;
  const value = cfg.value;
  if (
    (unit !== 'ms' && unit !== 's' && unit !== 'm') ||
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return null;
  }
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : 60_000;
  return { literal: `${value}${unit}`, ms: value * multiplier };
}

function renderTimeRange(n: {
  id: string;
  cfg?: Record<string, unknown>;
  props?: Record<string, unknown>;
}): ExportedCommand {
  const props = n.props ?? {};
  const start = props.start as { hour: number; minute: number; second: number } | undefined;
  const end = props.end as { hour: number; minute: number; second: number } | undefined;
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: 'timeRange' },
    ...posFlagsFromCfg(n.cfg),
  ];
  if (start) flags.push({ name: '--start', value: hms(start) });
  if (end) flags.push({ name: '--end', value: hms(end) });
  addDayFilterFlags(flags, props.filter);
  return { kind: 'node-add', nodeId: n.id, type: 'timeRange', flags, comment: 'timeRange' };
}

function renderVarChange(n: {
  id: string;
  cfg?: Record<string, unknown>;
  props?: Record<string, unknown>;
}): ExportedCommand {
  const props = n.props ?? {};
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: 'varChange' },
    ...posFlagsFromCfg(n.cfg),
    { name: '--var-scope', value: String(props.scope ?? '') },
    { name: '--var-id', value: String(props.id ?? '') },
    { name: '--var-type', value: String(props.varType ?? '') },
  ];
  const op = reverseVarChangeOp(String(props.operator ?? ''));
  if (op !== null) flags.push({ name: '--op', value: op });
  // F45 (2026-05-30): string-varType v1 round-trips through --var-value
  // (the F41 CLI surface). Without this, exporting a string-var rule
  // produced a script that re-imports failed with ConfigError "string-
  // varType requires --var-value" because we silently dropped the v1.
  // Number-varType continues to use --threshold (numeric path is unchanged).
  if (typeof props.v1 === 'number') flags.push({ name: '--threshold', value: String(props.v1) });
  else if (typeof props.v1 === 'string') flags.push({ name: '--var-value', value: props.v1 });
  if (typeof props.v2 === 'number') flags.push({ name: '--threshold2', value: String(props.v2) });
  return { kind: 'node-add', nodeId: n.id, type: 'varChange', flags, comment: 'varChange' };
}

// M14 task F — varSetNumber/varSetString exporter mirror. Walks the
// `elements: [{type:"const"|"var",...}]` array and reconstructs the
// user-facing `$expr` string. Round-trip note: const fragments with
// literal `$` are escaped to `$$`; var refs are always emitted as
// qualified `$<scope>.<id>` (never the default-scope shorthand) so the
// re-parsed result matches semantically without depending on a
// `--default-expr-scope` flag.
function renderVarSet(
  n: { id: string; cfg?: Record<string, unknown>; props?: Record<string, unknown> },
  type: 'varSetNumber' | 'varSetString',
): ExportedCommand {
  const props = n.props ?? {};
  const elements = Array.isArray(props.elements) ? props.elements : [];
  let exprStr = '';
  for (const raw of elements) {
    if (raw === null || typeof raw !== 'object') continue;
    const el = raw as Record<string, unknown>;
    if (el.type === 'const' && typeof el.value === 'string') {
      // Escape any literal '$' so the round-trip parse doesn't mistake it
      // for a var-ref prefix.
      exprStr += el.value.replace(/\$/g, '$$$$');
    } else if (el.type === 'var' && typeof el.scope === 'string' && typeof el.id === 'string') {
      exprStr += `$${el.scope}.${el.id}`;
    }
  }
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: type },
    ...posFlagsFromCfg(n.cfg),
    { name: '--var-scope', value: String(props.scope ?? '') },
    { name: '--var-id', value: String(props.id ?? '') },
    { name: '--expr', value: exprStr },
  ];
  return { kind: 'node-add', nodeId: n.id, type, flags, comment: type };
}

// M14 task E — varGet exporter mirror. Same prop projection as varChange,
// only the type literal differs. (No preload field; output2 added implicitly
// by the synthesizer.)
function renderVarGet(n: {
  id: string;
  cfg?: Record<string, unknown>;
  props?: Record<string, unknown>;
}): ExportedCommand {
  const props = n.props ?? {};
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: 'varGet' },
    ...posFlagsFromCfg(n.cfg),
    { name: '--var-scope', value: String(props.scope ?? '') },
    { name: '--var-id', value: String(props.id ?? '') },
    { name: '--var-type', value: String(props.varType ?? '') },
  ];
  const op = reverseVarChangeOp(String(props.operator ?? ''));
  if (op !== null) flags.push({ name: '--op', value: op });
  // F45 (2026-05-30): see renderVarChange for the string-varType
  // --var-value round-trip rationale.
  if (typeof props.v1 === 'number') flags.push({ name: '--threshold', value: String(props.v1) });
  else if (typeof props.v1 === 'string') flags.push({ name: '--var-value', value: props.v1 });
  if (typeof props.v2 === 'number') flags.push({ name: '--threshold2', value: String(props.v2) });
  return { kind: 'node-add', nodeId: n.id, type: 'varGet', flags, comment: 'varGet' };
}

function renderAlarmClock(n: {
  id: string;
  cfg?: Record<string, unknown>;
  props?: Record<string, unknown>;
}): ExportedCommand {
  const props = n.props ?? {};
  const flags: ExportFlag[] = [
    { name: '--id', value: n.id },
    { name: '--type', value: 'alarmClock' },
    ...posFlagsFromCfg(n.cfg),
  ];
  if (props.type === 'periodicAlarm') {
    flags.push({
      name: '--at',
      value: hms({
        hour: Number(props.hour ?? 0),
        minute: Number(props.minute ?? 0),
        second: Number(props.second ?? 0),
      }),
    });
  } else if (props.type === 'sunset') {
    // isSunset==true → sunset event; ==false → sunrise event (per schema)
    flags.push({ name: props.isSunset ? '--sunset' : '--sunrise' });
    if (typeof props.latitude === 'number')
      flags.push({ name: '--latitude', value: String(props.latitude) });
    if (typeof props.longitude === 'number')
      flags.push({ name: '--longitude', value: String(props.longitude) });
    const offsetSec = Number(props.offset ?? 0);
    if (offsetSec !== 0) flags.push({ name: '--offset-min', value: String(offsetSec / 60) });
  }
  addDayFilterFlags(flags, props.filter);
  return { kind: 'node-add', nodeId: n.id, type: 'alarmClock', flags, comment: 'alarmClock' };
}

// Emit a `--pos x,y,width,height` flag when the source cfg carries a pos.
// F54 (2026-05-30) — cfg keys that some renderer in this file knows how
// to project back into CLI flags. Anything else (e.g. UI-saved
// cfg.simplified, cfg.urn on a non-device card, an unrecognized future
// field) silently drops on the script-replay round-trip; the F54 loop
// in exportRuleFromView surfaces those as warnings or (with
// strictRoundtrip) throws. Keep this set in sync with the cfg reads
// across the render* helpers.
const KNOWN_CFG_KEYS = new Set([
  'pos', // every renderer
  'name', // every renderer
  'version', // every renderer
  'urn', // device-shaped types
  'unit', // delay / loop / statusLast / eventSequence — duration unit
  'value', // delay / loop / statusLast / eventSequence — duration value
  'happenType', // alarmClock — UI scaffolding (re-rendered via --at etc.)
  'tempOffset', // alarmClock — same
]);

function unknownCfgKeys(cfg: Record<string, unknown>): string[] {
  return Object.keys(cfg)
    .filter((k) => !KNOWN_CFG_KEYS.has(k))
    .sort();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// Used by every node renderer so `xgg rule export | bash` round-trips also
// preserve the canvas layout (cosmetic but reduces visual diff to zero).
function posFlagsFromCfg(cfg: Record<string, unknown> | undefined): ExportFlag[] {
  if (!cfg) return [];
  const pos = cfg.pos as { x?: number; y?: number; width?: number; height?: number } | undefined;
  if (!pos) return [];
  const { x, y, width, height } = pos;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return [];
  }
  return [{ name: '--pos', value: `${x},${y},${width},${height}` }];
}

function hms(t: { hour: number; minute: number; second: number }): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
}

function addDayFilterFlags(flags: ExportFlag[], rawFilter: unknown): void {
  if (!rawFilter || typeof rawFilter !== 'object') return;
  const filter = rawFilter as { inHoliday?: boolean; day?: number[] };
  if (filter.inHoliday === false) flags.push({ name: '--weekday-only' });
  else if (filter.inHoliday === true) flags.push({ name: '--holiday-only' });
  else if (Array.isArray(filter.day)) flags.push({ name: '--days', value: filter.day.join(',') });
}

async function ensureSpec(
  did: string,
  deps: ResourceDeps,
  cache: Map<string, DeviceSpec>,
): Promise<DeviceSpec> {
  const cached = cache.get(did);
  if (cached) return cached;
  const device = await getDevice(did, deps);
  const spec = await getDeviceSpec(device.urn, {
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
  });
  cache.set(did, spec);
  return spec;
}

function findPropertyName(spec: DeviceSpec, siid: number, piid: number): string | null {
  for (const service of spec.services) {
    if (service.iid !== siid) continue;
    for (const property of service.properties ?? []) {
      if (property.iid === piid) {
        const segments = property.type.split(':');
        return segments[3] ?? null;
      }
    }
  }
  return null;
}

function findActionName(
  spec: DeviceSpec,
  siid: number,
  aiid: number,
): { service: MiotService; action: MiotAction; actionName: string } | null {
  for (const service of spec.services) {
    if (service.iid !== siid) continue;
    for (const action of service.actions ?? []) {
      if (action.iid === aiid) {
        const segments = action.type.split(':');
        const actionName = segments[3] ?? '';
        return { service, action, actionName };
      }
    }
  }
  return null;
}

function findEventName(spec: DeviceSpec, siid: number, eiid: number): string | null {
  for (const service of spec.services) {
    if (service.iid !== siid) continue;
    for (const event of service.events ?? []) {
      if (event.iid === eiid) {
        const segments = event.type.split(':');
        return segments[3] ?? null;
      }
    }
  }
  return null;
}

function isDeviceOutputVariableRef(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { id: string; scope: string; dtype: string } {
  return (
    typeof value.id === 'string' &&
    typeof value.scope === 'string' &&
    typeof value.dtype === 'string'
  );
}

// Inverse of opSymbol() / MEMBERSHIP_OPS in rules.ts.
function reverseOpSymbol(operator: string): string | null {
  switch (operator) {
    case '>':
      return 'gt';
    case '<':
      return 'lt';
    case '=':
    case '==':
    case 'include':
      // gateway eq is `include` + array v1 (F14) — both translate to `eq`
      return 'eq';
    case '!=':
      return 'ne';
    case '>=':
      return 'gte';
    case '<=':
      return 'lte';
    // F49 (2026-05-30) — `between` operator round-trip.
    case 'between':
      return 'between';
    default:
      return null;
  }
}

function reverseVarChangeOp(operator: string): string | null {
  switch (operator) {
    case '>':
      return 'gt';
    case '<':
      return 'lt';
    case '=':
      return 'eq';
    case '!=':
      return 'ne';
    case '>=':
      return 'gte';
    case '<=':
      return 'lte';
    // F49 (2026-05-30) — same `between` round-trip on the varChange/varGet side.
    case 'between':
      return 'between';
    default:
      return null;
  }
}

/**
 * Apply a rename to an already-built ExportedRule (the form persisted via
 * `xgg rule export --format json > file.json`). Mirrors the rename logic
 * inside `exportRuleFromView` but operates on an `ExportedRule` rather than
 * a `RuleView`. Used by `xgg rule import --from-file`.
 *
 * Mutation is functional (returns a new object); the input is untouched.
 */
export function applyRename(exported: ExportedRule, rename: RenameOptions): ExportedRule {
  if (rename.targetId === undefined && rename.targetName === undefined) return exported;

  const finalId = rename.targetId ?? exported.ruleId;
  const finalName =
    rename.targetName !== undefined
      ? rename.targetName
      : rename.targetId !== undefined
        ? `[Cloned] ${exported.ruleName}`
        : exported.ruleName;

  const commands = exported.commands.map((cmd): ExportedCommand => {
    if (cmd.kind === 'shell-prelude') {
      return {
        ...cmd,
        comment: `Recreate rule ${finalId} ("${finalName}") from a gateway snapshot.`,
      };
    }
    if (cmd.kind === 'rule-set-body') {
      const body = JSON.parse(cmd.bodyJson) as {
        id: string;
        cfg: { id: string; userData: { name: string; [k: string]: unknown }; [k: string]: unknown };
        [k: string]: unknown;
      };
      body.id = finalId;
      body.cfg.id = finalId;
      body.cfg.userData = { ...body.cfg.userData, name: finalName };
      return { ...cmd, bodyJson: JSON.stringify(body, null, 2) };
    }
    return cmd;
  });

  return {
    ...exported,
    ruleId: finalId,
    ruleName: finalName,
    commands,
  };
}

/**
 * Render the structured commands as a runnable bash script. The script
 * assumes `xgg` is on PATH; for the dev worktree the user can swap to
 * `pnpm exec tsx packages/cli/src/cli.ts` via a one-line `XGG=...` envar
 * substitution at the top.
 */
export function renderExportedAsShell(
  exported: ExportedRule,
  opts: { baseUrl?: string; snapshotsDir?: string } = {},
): string {
  const lines: string[] = ['#!/usr/bin/env bash', 'set -euo pipefail', ''];
  lines.push(`# Auto-generated by \`xgg rule export ${exported.ruleId}\`.`);
  lines.push(`# Recreates rule "${exported.ruleName}" (id ${exported.ruleId}).`);
  lines.push('# Adjust XGG, BASE_URL and SNAPSHOTS_DIR for your environment.');
  lines.push('');
  lines.push('XGG="${XGG:-xgg}"');
  if (opts.baseUrl) lines.push(`BASE_URL="${opts.baseUrl}"`);
  else lines.push('BASE_URL="${BASE_URL:-http://192.168.x.x:8086}"');
  if (opts.snapshotsDir) lines.push(`SNAPSHOTS_DIR="${opts.snapshotsDir}"`);
  else lines.push('SNAPSHOTS_DIR="${SNAPSHOTS_DIR:-/tmp/xgg-export-snaps}"');
  const ruleId = exported.ruleId;
  lines.push('');

  for (const cmd of exported.commands) {
    switch (cmd.kind) {
      case 'shell-prelude':
        lines.push(`# ${cmd.comment}`);
        break;
      case 'rule-set-body': {
        const tmp = `/tmp/xgg-export-${ruleId}-shell.json`;
        lines.push(`# Rule shell: ${cmd.description}`);
        lines.push(`cat > ${tmp} <<'XGG_SHELL_EOF'`);
        lines.push(cmd.bodyJson);
        lines.push('XGG_SHELL_EOF');
        lines.push(
          `"$XGG" rule set --body ${tmp} --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"`,
        );
        lines.push('');
        break;
      }
      case 'node-add': {
        lines.push(`# ${cmd.comment}`);
        const flagsStr = renderFlagsForShell(cmd.flags);
        lines.push(
          `"$XGG" rule node add --rule-id ${ruleId} ${flagsStr} --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"`,
        );
        lines.push('');
        break;
      }
      case 'edge-add':
        lines.push(
          `"$XGG" rule edge add --rule-id ${ruleId} --from ${cmd.from} --to ${cmd.to} --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"`,
        );
        break;
      case 'rule-enable':
        lines.push('');
        lines.push(
          `"$XGG" rule enable ${ruleId} --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"`,
        );
        break;
      case 'warning':
        lines.push(`# WARNING: ${cmd.message}`);
        break;
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderFlagsForShell(flags: ExportFlag[]): string {
  return flags
    .map((f) => {
      if (f.value === undefined) return f.name;
      const v = f.needsQuoting
        ? `'${f.value.replace(/'/g, "'\\''")}'`
        : shellQuoteIfNeeded(f.value);
      return `${f.name} ${v}`;
    })
    .join(' ');
}

function shellQuoteIfNeeded(value: string): string {
  // Quote if the value contains shell-meaningful characters
  if (/^[\w./:@,+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
