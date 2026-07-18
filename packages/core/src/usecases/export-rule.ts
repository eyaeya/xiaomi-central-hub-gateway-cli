import { getDevice } from '../resources/devices.js';
import type { AvailableVariable, ResourceDeps } from '../resources/index.js';
import {
  type RuleView,
  type VarSetExprElement,
  getRule,
  listRules,
  parseEventArgVarTarget,
  parseVarSetExpr,
} from '../resources/rules.js';
import { isMissingScopeError, listVariables } from '../resources/variables.js';
import type { DeviceSpec, MiotAction, MiotProperty, MiotService } from '../schemas/device-spec.js';
import {
  type MiotComparisonDtype,
  projectMiotComparisonDtype,
} from '../schemas/miot-comparison.js';
import { durationToMilliseconds, isDurationUnit } from '../schemas/nodes/duration.js';
import { isValidVariableIdentifier } from '../schemas/variable-identifier.js';
import { isValidVariableScopeName } from '../schemas/variable.js';
import { ConfigError, NotFoundError } from '../transport/errors.js';
import { getDeviceSpec as fetchDeviceSpec } from './get-device-spec.js';
import { scanVariableReference } from './variable-reference.js';

/**
 * One CLI invocation the exporter emits (in order). The shape is structured
 * so callers can render either a shell script or a JSON description without
 * re-parsing strings.
 */
export type ExportedCommand =
  | { kind: 'shell-prelude'; comment: string }
  | { kind: 'external-variable-dependency'; scope: 'global'; id: string }
  | {
      kind: 'variable-create';
      scope: string;
      id: string;
      type: 'number' | 'string';
      value: number | string;
      userData: { name: string; [key: string]: unknown };
    }
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
  /** Global variables remain external dependencies and are never recreated. */
  externalVariables: Array<{ scope: 'global'; id: string }>;
  /** Warnings that should be surfaced to the user but don't block emission. */
  warnings: string[];
}

export interface ExportRuleDeps extends ResourceDeps {
  /** Optional pure fake-spec seam for offline export/replay tests and embedders. */
  getDeviceSpec?: (urn: string) => Promise<DeviceSpec>;
}

export interface ExportRuleInputs extends ExportRuleDeps {
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
  deps: ExportRuleDeps,
  rename?: RenameOptions,
  strictRoundtrip = false,
): Promise<ExportedRule> {
  const commands: ExportedCommand[] = [];
  const nodeWarnings: string[] = [];
  const variablePlan = await prepareVariablePlan(view, deps);

  // Always build the source-id representation first. applyRename() is the
  // single rename/remap funnel for both live export --target-id and the
  // offline `rule import --target-id` path, so the two cannot drift apart.
  commands.push({
    kind: 'shell-prelude',
    comment: `Recreate rule ${view.id} ("${view.cfg.userData.name}") from a gateway snapshot.`,
  });
  commands.push(...variablePlan.dependencyCommands);
  commands.push(...variablePlan.createCommands);

  // Variable preparation deliberately precedes even the empty graph write.
  // Replay-safe variable creation retains an exact compatible target but
  // rejects every mismatch without overwriting it, so a conflict aborts
  // before this script can touch the rule body.
  const shellCfg = {
    id: view.id,
    nodes: [] as unknown[],
    cfg: {
      id: view.id,
      uiType: view.cfg.uiType,
      enable: false,
      userData: { ...view.cfg.userData },
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
    const result = await renderNode(node, deps, specCache, nodeWarnings);
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
        nodeWarnings.push(msg);
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
  for (const w of nodeWarnings) commands.push({ kind: 'warning', message: w });

  const exported: ExportedRule = {
    ruleId: view.id,
    ruleName: view.cfg.userData.name,
    enable: view.cfg.enable,
    commands,
    externalVariables: variablePlan.externalVariables,
    warnings: [...variablePlan.warnings, ...nodeWarnings],
  };
  return rename === undefined ? exported : applyRename(exported, rename);
}

interface VariableReference extends AvailableVariable {
  paths: string[];
}

interface VariablePlan {
  dependencyCommands: ExportedCommand[];
  createCommands: ExportedCommand[];
  externalVariables: Array<{ scope: 'global'; id: string }>;
  warnings: string[];
}

async function prepareVariablePlan(view: RuleView, deps: ResourceDeps): Promise<VariablePlan> {
  const sourceScope = `R${view.id}`;
  const references = collectVariableReferences(view.nodes);
  const unknown = references.filter((ref) => ref.scope !== sourceScope && ref.scope !== 'global');
  if (unknown.length > 0) {
    throw new ConfigError(
      `rule ${view.id} references unsupported external variable scope(s): ${unknown
        .map((ref) => `${ref.scope}.${ref.id}`)
        .join(
          ', ',
        )}. Export only recognizes "global" as external and "${sourceScope}" as rule-local; refusing to guess or rewrite another scope.`,
      { references: unknown },
    );
  }

  const externalVariables = references
    .filter((ref) => ref.scope === 'global')
    .map((ref) => ({ scope: 'global' as const, id: ref.id }));
  const warnings = externalVariables.map(
    ({ scope, id }) =>
      `external variable dependency ${scope}.${id} is not recreated; it must already exist with a compatible type/value before replay`,
  );
  const dependencyCommands: ExportedCommand[] = externalVariables.map(({ scope, id }) => ({
    kind: 'external-variable-dependency',
    scope,
    id,
  }));

  const localReferences = references.filter((ref) => ref.scope === sourceScope);
  if (localReferences.length === 0) {
    return { dependencyCommands, createCommands: [], externalVariables, warnings };
  }
  if (!isValidVariableScopeName(sourceScope)) {
    throw new ConfigError(
      `rule-local variable scope "${sourceScope}" cannot be recreated because gateway variable scopes must be alphanumeric`,
      { ruleId: view.id, scope: sourceScope },
    );
  }

  let sourceVariables: Awaited<ReturnType<typeof listVariables>>;
  try {
    sourceVariables = await listVariables(sourceScope, deps);
  } catch (error) {
    if (isMissingScopeError(error)) {
      throw new ConfigError(
        `rule ${view.id} references local variables but source scope "${sourceScope}" does not exist`,
        { ruleId: view.id, scope: sourceScope, variables: localReferences.map((ref) => ref.id) },
      );
    }
    throw error;
  }

  const createCommands: ExportedCommand[] = [];
  for (const ref of localReferences) {
    const entry = Object.hasOwn(sourceVariables, ref.id) ? sourceVariables[ref.id] : undefined;
    if (entry === undefined) {
      throw new ConfigError(
        `rule ${view.id} references missing local variable ${sourceScope}.${ref.id}; refusing to emit a clone that cannot replay`,
        { ruleId: view.id, scope: sourceScope, id: ref.id, paths: ref.paths },
      );
    }
    if (
      (entry.type === 'number' && typeof entry.value !== 'number') ||
      (entry.type === 'string' && typeof entry.value !== 'string')
    ) {
      throw new ConfigError(
        `local variable ${sourceScope}.${ref.id} has type "${entry.type}" but a ${typeof entry.value} value; it cannot be recreated safely`,
        { scope: sourceScope, id: ref.id, type: entry.type, valueType: typeof entry.value },
      );
    }
    createCommands.push({
      kind: 'variable-create',
      scope: sourceScope,
      id: ref.id,
      type: entry.type,
      value: entry.value,
      userData: { ...entry.userData },
    });
  }

  return { dependencyCommands, createCommands, externalVariables, warnings };
}

function collectVariableReferences(nodes: readonly unknown[]): VariableReference[] {
  const refs = new Map<string, VariableReference>();
  const add = (candidate: unknown, path: string): void => {
    if (!isRecord(candidate)) return;
    const { scope, id } = candidate;
    if (typeof scope !== 'string' || typeof id !== 'string') return;
    const key = `${scope}\u0000${id}`;
    const prior = refs.get(key);
    if (prior === undefined) refs.set(key, { scope, id, paths: [path] });
    else prior.paths.push(path);
  };

  for (const rawNode of nodes) {
    if (!isRecord(rawNode) || typeof rawNode.type !== 'string') continue;
    const props = isRecord(rawNode.props) ? rawNode.props : {};
    const nodePath = `node ${typeof rawNode.id === 'string' ? rawNode.id : '<unknown>'}`;
    switch (rawNode.type) {
      case 'varChange':
      case 'varGet':
      case 'varSetNumber':
      case 'varSetString':
        add(props, `${nodePath}.props`);
        if (rawNode.type === 'varSetNumber' || rawNode.type === 'varSetString') {
          const elements = Array.isArray(props.elements) ? props.elements : [];
          for (const [index, element] of elements.entries()) {
            if (isRecord(element) && element.type === 'var') {
              add(element, `${nodePath}.props.elements[${index}]`);
            }
          }
        }
        break;
      case 'deviceInputSetVar': {
        add(props, `${nodePath}.props`);
        const args = Array.isArray(props.arguments) ? props.arguments : [];
        for (const [index, arg] of args.entries()) {
          add(arg, `${nodePath}.props.arguments[${index}]`);
        }
        break;
      }
      case 'deviceGetSetVar':
        add(props, `${nodePath}.props`);
        break;
      case 'deviceOutput': {
        if (isDeviceOutputVariableRef(props)) add(props, `${nodePath}.props`);
        const ins = Array.isArray(props.ins) ? props.ins : [];
        for (const [index, arg] of ins.entries()) {
          if (isRecord(arg) && isDeviceOutputVariableRef(arg)) {
            add(arg, `${nodePath}.props.ins[${index}]`);
          }
        }
        break;
      }
    }
  }

  return [...refs.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id),
  );
}

async function renderNode(
  node: unknown,
  deps: ExportRuleDeps,
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

// Operators the CLI's `--event-filter <piid><op><v1>` parser accepts.
// between/include event-arg filters fall outside this set and are surfaced as a
// warning rather than silently dropped.
const EVENT_FILTER_OPS = new Set(['=', '!=', '>', '<', '>=', '<=']);

function asMiotComparisonDtype(value: unknown): MiotComparisonDtype | null {
  if (value === 'int' || value === 'float' || value === 'boolean' || value === 'string') {
    return value;
  }
  return null;
}

function appendPropertyComparisonFlags(
  flags: ExportFlag[],
  props: Record<string, unknown>,
  projectedDtype: MiotComparisonDtype,
  nodeType: 'deviceInput' | 'deviceGet',
  nodeId: string,
  warnings: string[],
): void {
  if (props.dtype !== projectedDtype) {
    warnings.push(
      `${nodeType} node ${nodeId}: source dtype "${String(props.dtype)}" differs from the current MIoT spec projection "${projectedDtype}"; replay uses the current spec projection`,
    );
  }

  const reverseOp = reverseOpSymbol(String(props.operator));
  if (reverseOp !== null) flags.push({ name: '--op', value: reverseOp });

  if (projectedDtype === 'string') {
    if (typeof props.v1 === 'string' && props.v1.length > 0) {
      flags.push({ name: '--property-value', value: props.v1 });
    } else {
      warnings.push(
        `${nodeType} node ${nodeId}: string comparison v1 must be a non-empty string; export leaves out --property-value so replay fails instead of changing semantics`,
      );
    }
    return;
  }

  const v1 = props.v1;
  const threshold = Array.isArray(v1) ? v1[0] : v1;
  if (Array.isArray(v1) && v1.length > 1) {
    warnings.push(
      `${nodeType} node ${nodeId}: include() v1 has ${v1.length} values [${v1.join(',')}]; --threshold round-trips only the first (${String(v1[0])}). Re-author the rule to preserve the full membership set.`,
    );
  }
  if (typeof threshold === 'number') {
    flags.push({ name: '--threshold', value: String(threshold) });
  } else if (typeof threshold === 'boolean') {
    flags.push({ name: '--threshold', value: threshold ? '1' : '0' });
  }
  if (props.operator === 'between' && typeof props.v2 === 'number') {
    flags.push({ name: '--threshold2', value: String(props.v2) });
  }
}

async function renderDeviceInput(
  n: { id: string; cfg?: Record<string, unknown>; props?: Record<string, unknown> },
  deps: ExportRuleDeps,
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
    // Round-trip per-arg event filters via --event-filter. Pre-fix these were
    // silently dropped, so the replayed rule fired on ANY value of the event
    // instead of the captured filter. Args without an operator are "match any".
    const eventArgs = props.arguments;
    if (Array.isArray(eventArgs)) {
      for (const arg of eventArgs) {
        if (!isRecord(arg) || typeof arg.piid !== 'number' || !('operator' in arg)) continue;
        const op = String(arg.operator);
        if (!EVENT_FILTER_OPS.has(op)) {
          warnings.push(
            `deviceInput node ${n.id}: event arg piid=${arg.piid} uses operator "${op}" which --event-filter cannot express (only =, !=, >, <, >=, <=); the filter was dropped on export`,
          );
          continue;
        }
        const v1 = arg.v1;
        const val = typeof v1 === 'boolean' ? (v1 ? '1' : '0') : String(v1);
        flags.push({ name: '--event-filter', value: `${arg.piid}${op}${val}` });
      }
    }
  } else if (isProperty) {
    const spec = await ensureSpec(did, deps, specCache);
    const sourceSiid = Number(props.siid);
    const propertyDetails = findPropertyDetails(spec, sourceSiid, Number(props.piid));
    if (Number.isSafeInteger(sourceSiid) && sourceSiid > 0) {
      // Property short names may repeat across services. Preserve the source
      // service even when today's spec happens to be unambiguous so replay
      // cannot select another service after a spec update.
      flags.push({ name: '--device-siid', value: String(sourceSiid) });
    }
    if (propertyDetails === null) {
      warnings.push(
        `deviceInput node ${n.id}: property siid=${props.siid} piid=${props.piid} not found in device spec`,
      );
      flags.push({
        name: '--device-property',
        value: `<UNKNOWN_PROPERTY_siid${props.siid}_piid${props.piid}>`,
      });
    } else {
      flags.push({ name: '--device-property', value: propertyDetails.propertyName });
    }
    const projectedDtype =
      propertyDetails === null
        ? asMiotComparisonDtype(props.dtype)
        : projectMiotComparisonDtype(propertyDetails.property);
    if (projectedDtype === null) {
      warnings.push(
        `deviceInput node ${n.id}: comparison dtype "${String(props.dtype)}" is unknown; comparison flags were omitted`,
      );
    } else {
      appendPropertyComparisonFlags(flags, props, projectedDtype, 'deviceInput', n.id, warnings);
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
  deps: ExportRuleDeps,
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
  const sourceSiid = Number(props.siid);
  const propertyDetails = findPropertyDetails(spec, sourceSiid, Number(props.piid));
  if (Number.isSafeInteger(sourceSiid) && sourceSiid > 0) {
    flags.push({ name: '--device-siid', value: String(sourceSiid) });
  }
  if (propertyDetails === null) {
    warnings.push(
      `deviceGet node ${n.id}: property siid=${props.siid} piid=${props.piid} not found in device spec`,
    );
    flags.push({
      name: '--device-property',
      value: `<UNKNOWN_PROPERTY_siid${props.siid}_piid${props.piid}>`,
    });
  } else {
    flags.push({ name: '--device-property', value: propertyDetails.propertyName });
  }
  const projectedDtype =
    propertyDetails === null
      ? asMiotComparisonDtype(props.dtype)
      : projectMiotComparisonDtype(propertyDetails.property);
  if (projectedDtype === null) {
    warnings.push(
      `deviceGet node ${n.id}: comparison dtype "${String(props.dtype)}" is unknown; comparison flags were omitted`,
    );
  } else {
    appendPropertyComparisonFlags(flags, props, projectedDtype, 'deviceGet', n.id, warnings);
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
  deps: ExportRuleDeps,
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
  deps: ExportRuleDeps,
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
  const ms =
    typeof rawMs === 'number' && Number.isFinite(rawMs) && Number.isInteger(rawMs) ? rawMs : null;
  const cfgDuration = durationLiteralFromCfg(cfg);
  if (ms !== null && cfgDuration !== null && cfgDuration.ms === ms) {
    return cfgDuration.literal;
  }
  if (ms !== null) return `${ms}ms`;
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
    !isDurationUnit(unit) ||
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    return null;
  }
  const ms = durationToMilliseconds(value, unit);
  if (!Number.isFinite(ms) || !Number.isInteger(ms)) return null;
  return { literal: `${value}${unit}`, ms };
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
  const canonicalElements: VarSetExprElement[] = [];
  let exprStr = '';
  for (const [index, raw] of elements.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigError(
        `cannot export ${type} node ${n.id}: props.elements[${index}] is not a const or variable element`,
        { nodeId: n.id, nodeType: type, elementIndex: index },
      );
    }
    const el = raw as Record<string, unknown>;
    if (el.type === 'const' && typeof el.value === 'string') {
      // Escape any literal '$' so the round-trip parse doesn't mistake it
      // for a var-ref prefix.
      exprStr += el.value.replace(/\$/g, '$$$$');
      if (el.value.length > 0) {
        const previous = canonicalElements[canonicalElements.length - 1];
        if (previous?.type === 'const') previous.value += el.value;
        else canonicalElements.push({ type: 'const', value: el.value });
      }
    } else if (el.type === 'var' && typeof el.scope === 'string' && typeof el.id === 'string') {
      exprStr += `$${el.scope}.${el.id}`;
      canonicalElements.push({ type: 'var', scope: el.scope, id: el.id });
    } else {
      throw new ConfigError(
        `cannot export ${type} node ${n.id}: props.elements[${index}] is not a valid const or variable element`,
        { nodeId: n.id, nodeType: type, elementIndex: index },
      );
    }
  }
  let reparsed: VarSetExprElement[];
  try {
    reparsed = parseVarSetExpr(exprStr);
  } catch {
    throw losslessVarSetExportError(n.id, type);
  }
  if (!sameVarSetElements(canonicalElements, reparsed)) {
    throw losslessVarSetExportError(n.id, type);
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

function sameVarSetElements(
  expected: readonly VarSetExprElement[],
  actual: readonly VarSetExprElement[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((element, index) => {
      const other = actual[index];
      if (element.type === 'const') {
        return other?.type === 'const' && other.value === element.value;
      }
      return other?.type === 'var' && other.scope === element.scope && other.id === element.id;
    })
  );
}

function losslessVarSetExportError(
  nodeId: string,
  nodeType: 'varSetNumber' | 'varSetString',
): ConfigError {
  return new ConfigError(
    `cannot export ${nodeType} node ${nodeId} losslessly: its variable and constant element boundaries are ambiguous in --expr; add an explicit separator in the source rule before exporting`,
    { nodeId, nodeType },
  );
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
  // Only emit --days for a NON-empty day array. An empty `filter.day: []`
  // (already invalid per validate-graph's "至少选择一天") otherwise produced
  // `--days ''`, which re-imports as `[NaN]` and makes buildDayFilter throw — a
  // round-trip crash. Skipping it keeps the replay parseable.
  else if (Array.isArray(filter.day) && filter.day.length > 0)
    flags.push({ name: '--days', value: filter.day.join(',') });
}

async function ensureSpec(
  did: string,
  deps: ExportRuleDeps,
  cache: Map<string, DeviceSpec>,
): Promise<DeviceSpec> {
  const cached = cache.get(did);
  if (cached) return cached;
  const device = await getDevice(did, deps);
  const spec =
    deps.getDeviceSpec !== undefined
      ? await deps.getDeviceSpec(device.urn)
      : await fetchDeviceSpec(device.urn, {
          ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
        });
  cache.set(did, spec);
  return spec;
}

function findPropertyDetails(
  spec: DeviceSpec,
  siid: number,
  piid: number,
): { property: MiotProperty; propertyName: string } | null {
  for (const service of spec.services) {
    if (service.iid !== siid) continue;
    for (const property of service.properties ?? []) {
      if (property.iid === piid) {
        const segments = property.type.split(':');
        const propertyName = segments[3];
        return propertyName === undefined ? null : { property, propertyName };
      }
    }
  }
  return null;
}

function findPropertyName(spec: DeviceSpec, siid: number, piid: number): string | null {
  return findPropertyDetails(spec, siid, piid)?.propertyName ?? null;
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

  if (rename.targetId === exported.ruleId) {
    throw new ConfigError(
      `--target-id "${rename.targetId}" equals the source rule id. Omit --target-id for an in-place replay, or choose a distinct id for a clone; xgg will not silently treat source=target as a clone.`,
      { sourceId: exported.ruleId, targetId: rename.targetId },
    );
  }

  const finalId = rename.targetId ?? exported.ruleId;
  const finalName =
    rename.targetName !== undefined
      ? rename.targetName
      : rename.targetId !== undefined
        ? `[Cloned] ${exported.ruleName}`
        : exported.ruleName;

  const sourceScope = `R${exported.ruleId}`;
  const targetScope = `R${finalId}`;
  if (rename.targetId !== undefined) {
    assertRenameHasCompleteVariablePlan(exported, sourceScope, targetScope);
  }

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
    if (rename.targetId !== undefined && cmd.kind === 'variable-create') {
      return { ...cmd, scope: cmd.scope === sourceScope ? targetScope : cmd.scope };
    }
    if (rename.targetId !== undefined && cmd.kind === 'node-add') {
      return {
        ...cmd,
        flags: cmd.flags.map((flag) => remapVariableFlag(flag, sourceScope, targetScope)),
      };
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

function assertRenameHasCompleteVariablePlan(
  exported: ExportedRule,
  sourceScope: string,
  targetScope: string,
): void {
  const refs = collectCommandVariableReferences(exported.commands);
  const unknown = refs.filter((ref) => ref.scope !== sourceScope && ref.scope !== 'global');
  if (unknown.length > 0) {
    throw new ConfigError(
      `cannot clone export for rule ${exported.ruleId}: unsupported external variable scope(s) ${unknown
        .map((ref) => `${ref.scope}.${ref.id}`)
        .join(', ')}. Only ${sourceScope} is remapped; global remains external.`,
      { sourceRuleId: exported.ruleId, references: unknown },
    );
  }

  const localDefinitions = new Set(
    exported.commands
      .filter(
        (command): command is Extract<ExportedCommand, { kind: 'variable-create' }> =>
          command.kind === 'variable-create' && command.scope === sourceScope,
      )
      .map((command) => command.id),
  );
  const externalDeclarations = new Set(
    exported.commands
      .filter(
        (command): command is Extract<ExportedCommand, { kind: 'external-variable-dependency' }> =>
          command.kind === 'external-variable-dependency',
      )
      .map((command) => command.id),
  );
  const missingLocal = refs.filter(
    (ref) => ref.scope === sourceScope && !localDefinitions.has(ref.id),
  );
  if (missingLocal.length > 0) {
    throw new ConfigError(
      `cannot clone export for rule ${exported.ruleId}: local variable snapshot(s) are missing for ${missingLocal
        .map((ref) => `${sourceScope}.${ref.id}`)
        .join(', ')}. Re-export from the source gateway before using --target-id.`,
      { sourceRuleId: exported.ruleId, references: missingLocal },
    );
  }
  const undeclaredGlobals = refs.filter(
    (ref) => ref.scope === 'global' && !externalDeclarations.has(ref.id),
  );
  if (undeclaredGlobals.length > 0) {
    throw new ConfigError(
      `cannot clone export for rule ${exported.ruleId}: global dependencies are not explicit for ${undeclaredGlobals
        .map((ref) => `global.${ref.id}`)
        .join(', ')}. Re-export from the source gateway before using --target-id.`,
      { sourceRuleId: exported.ruleId, references: undeclaredGlobals },
    );
  }
  if (localDefinitions.size > 0 && !isValidVariableScopeName(targetScope)) {
    throw new ConfigError(
      `target rule id "${targetScope.slice(1)}" cannot host cloned local variables because scope "${targetScope}" is not alphanumeric`,
      { targetRuleId: targetScope.slice(1), targetScope },
    );
  }
}

function collectCommandVariableReferences(
  commands: readonly ExportedCommand[],
): VariableReference[] {
  const refs = new Map<string, VariableReference>();
  const add = (scope: string, id: string, path: string): void => {
    const key = `${scope}\u0000${id}`;
    const prior = refs.get(key);
    if (prior === undefined) refs.set(key, { scope, id, paths: [path] });
    else prior.paths.push(path);
  };

  for (const command of commands) {
    if (command.kind !== 'node-add') continue;
    const scopeFlags = command.flags.filter((flag) => flag.name === '--var-scope');
    const idFlags = command.flags.filter((flag) => flag.name === '--var-id');
    if (scopeFlags.length > 0 || idFlags.length > 0) {
      const scope = scopeFlags[0]?.value;
      const id = idFlags[0]?.value;
      if (
        scopeFlags.length !== 1 ||
        idFlags.length !== 1 ||
        scope === undefined ||
        id === undefined
      ) {
        throw new ConfigError(
          `cannot clone exported node ${command.nodeId} safely: --var-scope and --var-id must appear exactly once as a pair`,
          { nodeId: command.nodeId },
        );
      }
      assertValidCloneVariableReference(scope, id, `node ${command.nodeId}`);
      add(scope, id, `node ${command.nodeId}`);
    }

    for (const flag of command.flags) {
      if (flag.value === undefined) {
        if (
          flag.name === '--expr' ||
          flag.name === '--event-arg-var' ||
          flag.name === '--value' ||
          flag.name === '--params'
        ) {
          throw new ConfigError(
            `cannot clone exported node ${command.nodeId} safely: ${flag.name} requires a value`,
            { nodeId: command.nodeId, flag: flag.name },
          );
        }
        continue;
      }
      if (flag.name === '--expr') {
        for (const ref of qualifiedExpressionReferences(flag.value)) {
          add(ref.scope, ref.id, `node ${command.nodeId} --expr`);
        }
      } else if (flag.name === '--event-arg-var') {
        const ref = parseEventArgumentVariable(flag.value);
        if (ref !== null) add(ref.scope, ref.id, `node ${command.nodeId} --event-arg-var`);
      } else if (flag.name === '--value') {
        const ref = parseDollarVariableReference(flag.value);
        if (ref !== null) add(ref.scope, ref.id, `node ${command.nodeId} --value`);
      } else if (flag.name === '--params') {
        for (const ref of variableReferencesInParams(flag.value)) {
          add(ref.scope, ref.id, `node ${command.nodeId} --params`);
        }
      }
    }
  }
  return [...refs.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id),
  );
}

function remapVariableFlag(flag: ExportFlag, sourceScope: string, targetScope: string): ExportFlag {
  if (flag.value === undefined) return flag;
  if (flag.name === '--var-scope' && flag.value === sourceScope) {
    return { ...flag, value: targetScope };
  }
  if (flag.name === '--expr') {
    return { ...flag, value: remapExpressionScope(flag.value, sourceScope, targetScope) };
  }
  if (flag.name === '--event-arg-var') {
    const ref = parseEventArgumentVariable(flag.value);
    if (ref?.scope === sourceScope) {
      return { ...flag, value: `${ref.prefix}${targetScope}.${ref.id}` };
    }
  }
  if (flag.name === '--value') {
    const ref = parseDollarVariableReference(flag.value);
    if (ref?.scope === sourceScope) return { ...flag, value: `$${targetScope}.${ref.id}` };
  }
  if (flag.name === '--params') {
    return { ...flag, value: remapParamsScope(flag.value, sourceScope, targetScope) };
  }
  return flag;
}

function qualifiedExpressionReferences(input: string): Array<{ scope: string; id: string }> {
  const refs: Array<{ scope: string; id: string }> = [];
  scanQualifiedExpression(input, (scope, id) => {
    refs.push({ scope, id });
    return scope;
  });
  return refs;
}

function remapExpressionScope(input: string, sourceScope: string, targetScope: string): string {
  return scanQualifiedExpression(input, (scope) => (scope === sourceScope ? targetScope : scope));
}

function scanQualifiedExpression(
  input: string,
  mapScope: (scope: string, id: string) => string,
): string {
  let output = '';
  let index = 0;
  while (index < input.length) {
    if (input[index] !== '$') {
      output += input[index];
      index += 1;
      continue;
    }
    const token = scanVariableReference(input, index);
    const raw = input.slice(index, index + token.consumed);
    if (token.kind === 'invalid') {
      throw new ConfigError(
        `cannot clone exported --expr safely: invalid variable reference at offset ${index}; re-export from the current xgg version or replay without --target-id`,
        { offset: index },
      );
    }
    if (token.kind === 'escape') {
      output += raw;
      index += token.consumed;
      continue;
    }
    const mappedScope = mapScope(token.scope, token.id);
    const wasQualified = raw.slice(1).includes('.');
    output += mappedScope === token.scope && !wasQualified ? raw : `$${mappedScope}.${token.id}`;
    index += token.consumed;
  }
  return output;
}

function parseEventArgumentVariable(
  value: string,
): { prefix: string; scope: string; id: string } | null {
  const { piid, scope, id } = parseEventArgVarTarget(value);
  return { prefix: `${piid}=`, scope, id };
}

function parseDollarVariableReference(value: string): { scope: string; id: string } | null {
  if (!value.startsWith('$')) return null;
  const token = scanVariableReference(value, 0);
  if (
    token.kind !== 'reference' ||
    token.consumed !== value.length ||
    !value.slice(1).includes('.')
  ) {
    throw new ConfigError(
      'cannot clone exported --value safely: a dollar-prefixed value must be one complete $<scope>.<id> reference',
    );
  }
  return { scope: token.scope, id: token.id };
}

function variableReferencesInParams(value: string): Array<{ scope: string; id: string }> {
  const parsed = parseCloneParams(value);
  const refs: Array<{ scope: string; id: string }> = [];
  for (const [key, raw] of Object.entries(parsed)) {
    const ref = parseCloneParamVariable(raw, key);
    if (ref !== null) refs.push(ref);
  }
  return refs;
}

function remapParamsScope(value: string, sourceScope: string, targetScope: string): string {
  const parsed = parseCloneParams(value);
  for (const [key, raw] of Object.entries(parsed)) {
    const ref = parseCloneParamVariable(raw, key);
    if (ref !== null) {
      (raw as Record<string, unknown>).$var =
        `${ref.scope === sourceScope ? targetScope : ref.scope}.${ref.id}`;
    }
  }
  return JSON.stringify(parsed);
}

function parseCloneParams(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError('cannot clone exported --params safely: it must contain valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new ConfigError('cannot clone exported --params safely: it must be a JSON object');
  }
  return parsed;
}

function parseCloneParamVariable(
  value: unknown,
  key: string,
): { scope: string; id: string } | null {
  if (value === null || typeof value !== 'object') return null;
  if (!isRecord(value) || !Object.hasOwn(value, '$var') || typeof value.$var !== 'string') {
    throw new ConfigError(
      `cannot clone exported --params safely: parameter ${key} must be a scalar or a {$var:<scope>.<id>} object`,
      { parameter: key },
    );
  }
  const marker = value.$var.startsWith('$') ? value.$var : `$${value.$var}`;
  const ref = parseDollarVariableReference(marker);
  if (ref === null) {
    throw new ConfigError(
      `cannot clone exported --params safely: parameter ${key} has an invalid variable marker`,
      { parameter: key },
    );
  }
  return ref;
}

function assertValidCloneVariableReference(scope: string, id: string, path: string): void {
  if (!isValidVariableIdentifier(scope) || !isValidVariableIdentifier(id)) {
    throw new ConfigError(
      `cannot clone exported ${path} safely: variable scope and id must be non-empty ASCII alphanumeric identifiers`,
      { path },
    );
  }
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
  lines.push(...renderShellComment(`Auto-generated by \`xgg rule export ${exported.ruleId}\`.`));
  lines.push(
    ...renderShellComment(`Recreates rule "${exported.ruleName}" (id ${exported.ruleId}).`),
  );
  lines.push(...renderShellComment('Adjust XGG, BASE_URL and SNAPSHOTS_DIR for your environment.'));
  lines.push('');
  lines.push('XGG="${XGG:-xgg}"');
  if (opts.baseUrl) lines.push(`BASE_URL=${shellQuote(opts.baseUrl)}`);
  else lines.push('BASE_URL="${BASE_URL:-http://192.168.x.x:8086}"');
  if (opts.snapshotsDir) lines.push(`SNAPSHOTS_DIR=${shellQuote(opts.snapshotsDir)}`);
  else lines.push('SNAPSHOTS_DIR="${SNAPSHOTS_DIR:-/tmp/xgg-export-snaps}"');
  const ruleId = shellQuote(exported.ruleId);
  let bodyFileInitialized = false;
  lines.push('');

  const variableCreates = exported.commands.filter(
    (command): command is Extract<ExportedCommand, { kind: 'variable-create' }> =>
      command.kind === 'variable-create',
  );
  for (const command of exported.commands) {
    if (command.kind === 'shell-prelude') {
      lines.push(...renderShellComment(command.comment));
    } else if (command.kind === 'external-variable-dependency') {
      lines.push(
        ...renderShellComment(
          `EXTERNAL VARIABLE: ${command.scope}.${command.id} must already exist with a compatible type/value; this script does not create or modify global variables.`,
        ),
      );
    }
  }
  if (variableCreates.length > 0) {
    lines.push(
      ...renderShellComment(
        'Preflight the complete local-variable plan before any createVar call. Stable target conflicts therefore leave both variables and the rule body untouched; each later create repeats the compatibility check to stay safe under races.',
      ),
    );
    for (const command of variableCreates) {
      lines.push(renderVariableCreateInvocation(command, true));
    }
    lines.push('');
    for (const command of variableCreates) {
      lines.push(
        ...renderShellComment(
          `Prepare rule-local variable ${command.scope}.${command.id} from the source snapshot's current value. A byte-for-value compatible target is retained; any mismatch fails and is never overwritten.`,
        ),
      );
      lines.push(renderVariableCreateInvocation(command, false));
      lines.push('');
    }
  }

  for (const cmd of exported.commands) {
    switch (cmd.kind) {
      case 'shell-prelude':
      case 'external-variable-dependency':
      case 'variable-create':
        break;
      case 'rule-set-body': {
        if (!bodyFileInitialized) {
          lines.push('RULE_BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/xgg-export.XXXXXXXX")"');
          lines.push('trap \'rm -f -- "$RULE_BODY_FILE"\' EXIT');
          bodyFileInitialized = true;
        }
        const delimiter = chooseHeredocDelimiter(cmd.bodyJson);
        lines.push(...renderShellComment(`Rule shell: ${cmd.description}`));
        lines.push(`cat > "$RULE_BODY_FILE" <<'${delimiter}'`);
        lines.push(cmd.bodyJson);
        lines.push(delimiter);
        lines.push(
          '"$XGG" rule set --body "$RULE_BODY_FILE" --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"',
        );
        lines.push('');
        break;
      }
      case 'node-add': {
        lines.push(...renderShellComment(cmd.comment));
        const flagsStr = renderFlagsForShell(cmd.flags);
        lines.push(
          `"$XGG" rule node add --rule-id ${ruleId} ${flagsStr} --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"`,
        );
        lines.push('');
        break;
      }
      case 'edge-add':
        lines.push(
          `"$XGG" rule edge add --rule-id ${ruleId} --from ${shellQuote(cmd.from)} --to ${shellQuote(cmd.to)} --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"`,
        );
        break;
      case 'rule-enable':
        lines.push('');
        lines.push(
          `"$XGG" rule enable ${ruleId} --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"`,
        );
        break;
      case 'warning':
        lines.push(...renderShellComment(`WARNING: ${cmd.message}`));
        break;
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderVariableCreateInvocation(
  command: Extract<ExportedCommand, { kind: 'variable-create' }>,
  checkOnly: boolean,
): string {
  return `"$XGG" variable create --scope ${shellQuote(command.scope)} --id ${shellQuote(command.id)} --type ${shellQuote(command.type)} --value ${shellQuote(String(command.value))} --name ${shellQuote(command.userData.name)} --if-compatible${checkOnly ? ' --check-only' : ''} --allow-unknown-scope --snapshots-dir "$SNAPSHOTS_DIR" --base-url "$BASE_URL"`;
}

function renderFlagsForShell(flags: ExportFlag[]): string {
  return flags
    .map((f) => {
      const name = shellQuote(f.name);
      if (f.value === undefined) return name;
      return `${name} ${shellQuote(f.value)}`;
    })
    .join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function renderShellComment(value: string): string[] {
  const visible = Array.from(value, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    const isUnsafeControl =
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      codePoint === 0x7f;
    return isUnsafeControl ? `\\x${codePoint.toString(16).padStart(2, '0')}` : char;
  }).join('');
  // A trailing space prevents a user-provided final backslash from escaping
  // the newline before Bash identifies the next generated line as a comment.
  return visible
    .replaceAll('\r', '\\r')
    .split('\n')
    .map((line) => `# ${line} `);
}

function chooseHeredocDelimiter(body: string): string {
  const occupiedLines = new Set(body.split('\n').map((line) => line.replace(/\r$/, '')));
  let delimiter = 'XGG_SHELL_EOF';
  while (occupiedLines.has(delimiter)) delimiter += '_';
  return delimiter;
}
