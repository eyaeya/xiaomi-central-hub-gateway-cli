import { MiotSpecFetchError } from '../http-client.js';
import type { DeviceSpec, MiotProperty } from '../schemas/device-spec.js';
import {
  MIOT_COMPARISON_CONTRACT,
  type MiotComparisonDtype,
  hasMiotValueList,
  isMiotWireOperator,
  projectMiotComparisonDtype,
} from '../schemas/miot-comparison.js';
import { NodeUnion } from '../schemas/nodes/index.js';
import type { AvailableVariable } from '../schemas/variable.js';
import { ConfigError, NotFoundError, XggError } from '../transport/errors.js';
import { duplicateNodeIdIssues, findDuplicateNodeIds } from './graph-invariants.js';
import type { LintIssue } from './lint-graph.js';
import { checkNodeStrict } from './typed-schemas.js';
import { checkVarSetNumberExpr } from './var-expr-check.js';

export interface ValidateGraphInput {
  graph: {
    id: string;
    cfg?: { id?: string; enable?: boolean };
    nodes?: unknown[];
  };
  /**
   * Opt in to MIoT spec-aware checks. When omitted, validation is deterministic
   * and performs no external spec I/O. Callers that provide this callback own
   * its network/cache/fixture policy explicitly.
   */
  getDeviceSpec?: (urn: string) => Promise<DeviceSpec>;
  // F23 (2026-05-30): the official save() function fetches `listAvailVars(graphId)`
  // and verifies every variable reference points to a known var (else
  // "卡片变量丢失") and uses scope "global" / "R<graphId>" (else
  // "卡片变量有误"). When this callback is absent, the existence check is
  // skipped — the structural validate-graph still runs.
  listAvailVars?: (ruleId: string) => Promise<AvailableVariable[]>;
}

const NUMBER_VAR_OPERATORS = new Set(['>=', '<=', '=', '!=', '>', '<', 'between']);
// F38 (2026-05-29) — bundle Pr.varChange / Pr.varGet hard-require
// `operator === '='` for `varType === 'string'`. Save-flow parity:
// rule set / enable now run this on string-var comparison nodes.
const STRING_VAR_OPERATORS = new Set(['=']);

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.length === 0) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}
const WEB_VALIDATED_NODE_TYPES = new Set([
  'alarmClock',
  'condition',
  'counter',
  'delay',
  'deviceGet',
  'deviceGetSetVar',
  'deviceInput',
  'deviceInputSetVar',
  'deviceOutput',
  'eventSequence',
  'logicAnd',
  'logicNot',
  'logicOr',
  'loop',
  'modeSwitch',
  'nop',
  'onLoad',
  'onlyNTimes',
  'register',
  'signalOr',
  'statusLast',
  'timeRange',
  'varChange',
  'varGet',
  'varSetNumber',
  'varSetString',
]);

function issue(path: string, message: string): LintIssue {
  return { severity: 'error', path, message };
}

// F24 KEYSTONE: if a node's `type` is modeled but it fails that type's strict
// schema, it only matched NodeUnion via the UnknownNode fallback. Reject with a
// UI-style 卡片配置有误 message naming the first failing field. Genuinely
// unmodeled future types (not in TYPED_SCHEMAS) are left alone — UnknownNode is
// a legitimate forward-compat path for them.
// F62 (2026-05-30): the map + strict-check primitive moved to ./typed-schemas
// so lint-graph can reuse them without dragging the rest of validate-graph in.
function checkStrictSchema(node: Record<string, unknown>, idx: number): LintIssue[] {
  const result = checkNodeStrict(node);
  if (result === null) return [];
  const type = String(node.type);
  const where = result.field ? ` at ${result.field}` : '';
  return [
    issue(
      `nodes[${idx}]`,
      `卡片配置有误: ${type} node failed its strict schema${where}: ${result.message}`,
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uiVarDtypeFromFormat(format: string): 'number' | 'string' {
  return format === 'string' ? 'string' : 'number';
}

function findProperty(spec: DeviceSpec, siid: number, piid: number): MiotProperty | undefined {
  const service = spec.services.find((s) => s.iid === siid);
  return service?.properties?.find((p) => p.iid === piid);
}

// F66e-2 (2026-05-31): mirror the bundle's `getEventData(e).find(piid)` chain
// for spec-aware event-mode arg checks. Returns the spec property whose iid
// the event lists in its `arguments` array (the bundle enriches each entry
// with the property's dtype before the qp() check).
function findEventArgProperty(
  spec: DeviceSpec,
  siid: number,
  eiid: number,
  piid: number,
): MiotProperty | undefined {
  const service = spec.services.find((s) => s.iid === siid);
  if (service === undefined) return undefined;
  const event = service.events?.find((e) => e.iid === eiid);
  if (event === undefined) return undefined;
  if (!Array.isArray(event.arguments) || !event.arguments.includes(piid)) return undefined;
  return service.properties?.find((p) => p.iid === piid);
}

function checkComparisonWire(
  node: Record<string, unknown>,
  props: Record<string, unknown>,
  path: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const dtype = props.dtype;
  const operator = props.operator;
  const v1 = props.v1;
  const v2 = props.v2;

  if (dtype === 'int') {
    if (typeof operator !== 'string' || !isMiotWireOperator(dtype, operator)) {
      issues.push(issue(`${path}.operator`, '卡片配置有误: Invalid operator'));
    }
    if (operator === 'include') {
      if (!Array.isArray(v1) || v1.some((v) => !Number.isInteger(v))) {
        issues.push(issue(`${path}.v1`, '卡片配置有误: Invalid v1'));
      }
    } else if (!Number.isInteger(v1)) {
      issues.push(issue(`${path}.v1`, '卡片配置有误: Invalid v1'));
    }
    if (operator === 'between' && !Number.isInteger(v2)) {
      issues.push(issue(`${path}.v2`, '卡片配置有误: Invalid v2'));
    }
  } else if (dtype === 'float') {
    if (typeof operator !== 'string' || !isMiotWireOperator(dtype, operator)) {
      issues.push(issue(`${path}.operator`, '卡片配置有误: Invalid operator'));
    }
    if (typeof v1 !== 'number' || Number.isNaN(v1)) {
      issues.push(issue(`${path}.v1`, '卡片配置有误: Invalid v1'));
    }
    if (operator === 'between' && (typeof v2 !== 'number' || Number.isNaN(v2))) {
      issues.push(issue(`${path}.v2`, '卡片配置有误: Invalid v2'));
    }
  } else if (dtype === 'boolean') {
    if (operator !== MIOT_COMPARISON_CONTRACT.boolean.equalityWireOperator) {
      issues.push(issue(`${path}.operator`, '卡片配置有误: Invalid operator'));
    }
    if (typeof v1 !== 'boolean') {
      issues.push(issue(`${path}.v1`, '卡片配置有误: Invalid v1'));
    }
  } else if (dtype === 'string') {
    if (operator !== MIOT_COMPARISON_CONTRACT.string.equalityWireOperator) {
      issues.push(issue(`${path}.operator`, '卡片配置有误: Invalid operator'));
    }
    if (typeof v1 !== 'string' || v1.length === 0) {
      issues.push(issue(`${path}.v1`, '卡片配置有误: Invalid v1'));
    }
  } else {
    issues.push(issue(`${path}.dtype`, '卡片配置有误: Invalid dtype'));
  }

  if (node.type === 'deviceGet') {
    const outputs = node.outputs;
    if (!isRecord(outputs) || !('output' in outputs)) {
      issues.push(issue('outputs.output', '卡片配置有误: No output'));
    }
    if (!isRecord(outputs) || !('output2' in outputs)) {
      issues.push(issue('outputs.output2', '卡片配置有误: No output2'));
    }
  }

  return issues;
}

// G-A/G-B (2026-05-29 save-flow parity): port nodeCheckTool.deviceInputSetVar /
// deviceGetSetVar field checks. siid must be a number ("请选择服务"). For
// property mode the var scope/id must be non-empty ("必须选择变量", the `qp`
// helper's first check). For deviceInputSetVar event mode each argument is
// validated per `checkSetVarEventArgs`. The dtype↔MIoT-format match (the second
// half of `qp`, `ka(format) !== dtype`) is the spec-dependent layer handled by
// checkAgainstSpec, not here.
function checkSetVarProps(
  props: Record<string, unknown>,
  path: string,
  type: 'deviceInputSetVar' | 'deviceGetSetVar',
): LintIssue[] {
  const out: LintIssue[] = [];
  if (!Number.isInteger(props.siid)) {
    out.push(issue(`${path}.siid`, '卡片配置有误: 请选择服务'));
    return out; // official returns immediately on a missing siid
  }
  if (type === 'deviceInputSetVar' && Number.isInteger(props.eiid)) {
    return checkSetVarEventArgs(props, path);
  }
  // property-mode (deviceInputSetVar with piid) or deviceGetSetVar (get-mode):
  // the official `qp` requires both var scope and id to be non-empty.
  if (isEmptyValue(props.scope) || isEmptyValue(props.id)) {
    out.push(issue(path, '卡片配置有误: 必须选择变量'));
  }
  return out;
}

// G-B: deviceInputSetVar event-mode — official arm maps each argument to
// `arg.piid ? qp({}, eventArg, arg) : {piid:"请选择属性"}`. So every argument
// needs a piid; when present, the captured var scope/id must be non-empty.
function checkSetVarEventArgs(props: Record<string, unknown>, path: string): LintIssue[] {
  const out: LintIssue[] = [];
  const args = props.arguments;
  if (!Array.isArray(args)) return out;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const apath = `${path}.arguments[${i}]`;
    if (!isRecord(a) || !Number.isInteger(a.piid)) {
      out.push(issue(`${apath}.piid`, '卡片配置有误: 请选择属性'));
      continue; // piid-less arg never reaches the qp scope/id check upstream
    }
    if (isEmptyValue(a.scope) || isEmptyValue(a.id)) {
      out.push(issue(apath, '卡片配置有误: 必须选择变量'));
    }
  }
  return out;
}

// G-C: deviceInput event-mode — official arm maps each argument to
// `arg.piid ? Up(...) : {piid:"请选择属性"}`. The structural piid-presence check
// is ported here. F66e-1 (2026-05-31) — the spec-independent half of `Up()`
// is also ported: `zp(n.v1)` triggers `输入不能为空`. A Bare arg row (just
// `{piid, dtype}`) hits this exact UI error because v1 is undefined. The
// per-arg int/float operator + v2 half remains spec-dependent and only fully
// covered for property mode (checkComparisonWire); see docs/api/nodes.md
// §deviceInput.
function checkDeviceInputEventArgs(props: Record<string, unknown>, path: string): LintIssue[] {
  const out: LintIssue[] = [];
  const args = props.arguments;
  if (!Array.isArray(args)) return out;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!isRecord(a) || !Number.isInteger(a.piid)) {
      out.push(issue(`${path}.arguments[${i}].piid`, '卡片配置有误: 请选择属性'));
      continue; // piid-less arg never reaches the Up() v1-emptiness check upstream
    }
    if (isEmptyValue(a.v1)) {
      out.push(issue(`${path}.arguments[${i}].v1`, '卡片配置有误: 输入不能为空'));
    }
  }
  return out;
}

function checkKnownWebShape(node: Record<string, unknown>, idx: number): LintIssue[] {
  const issues: LintIssue[] = [];
  const base = `nodes[${idx}]`;

  if (!WEB_VALIDATED_NODE_TYPES.has(String(node.type))) return issues;
  if (!isRecord(node.cfg)) issues.push(issue(`${base}.cfg`, '卡片配置有误: Invalid cfg'));
  if (!isRecord(node.inputs)) issues.push(issue(`${base}.inputs`, '卡片配置有误: Invalid inputs'));
  if (!isRecord(node.outputs))
    issues.push(issue(`${base}.outputs`, '卡片配置有误: Invalid outputs'));
  if (!isRecord(node.props)) issues.push(issue(`${base}.props`, '卡片配置有误: Invalid props'));
  // The gateway requires Number.isInteger(cfg.version). A fractional version
  // passes the loose `z.number()` cfg schema but the gateway rejects setGraph
  // with "Invalid cfg.version". Mirror it on the funnel path.
  if (isRecord(node.cfg) && !Number.isInteger(node.cfg.version)) {
    issues.push(issue(`${base}.cfg.version`, '卡片配置有误: Invalid cfg.version (须为整数)'));
  }
  if (!isRecord(node.props)) return issues;

  switch (node.type) {
    case 'deviceInput':
      if ('piid' in node.props) {
        issues.push(...checkComparisonWire(node, node.props, `${base}.props`));
      } else if ('eiid' in node.props) {
        // G-C: nodeCheckTool.deviceInput event-mode per-argument piid presence.
        issues.push(...checkDeviceInputEventArgs(node.props, `${base}.props`));
      }
      break;
    case 'deviceGet':
      // deviceGet is property-only (no event/eiid mode — schema enforces piid).
      if ('piid' in node.props)
        issues.push(...checkComparisonWire(node, node.props, `${base}.props`));
      break;
    case 'deviceInputSetVar':
      issues.push(...checkSetVarProps(node.props, `${base}.props`, 'deviceInputSetVar'));
      break;
    case 'deviceGetSetVar':
      issues.push(...checkSetVarProps(node.props, `${base}.props`, 'deviceGetSetVar'));
      break;
    case 'deviceOutput':
      issues.push(...checkDeviceOutputProps(node.props, `${base}.props`));
      break;
    case 'varChange':
    case 'varGet':
      issues.push(...checkVarComparisonProps(node.props, `${base}.props`));
      break;
    case 'varSetNumber':
    case 'varSetString':
      issues.push(...checkVarSetProps(node.props, `${base}.props`, node.type));
      break;
    case 'alarmClock':
      issues.push(...checkAlarmClockProps(node.props, `${base}.props`));
      break;
    case 'timeRange':
      issues.push(...checkTimeRangeProps(node.props, `${base}.props`));
      break;
    case 'counter':
    case 'onlyNTimes':
      if (!Number.isInteger(node.props.n) || Number(node.props.n) < 1) {
        issues.push(issue(`${base}.props.n`, '卡片配置有误: Invalid n'));
      }
      break;
    case 'statusLast':
      // statusLast keeps the `> 0` guard: bundle Pr.statusLast throws on
      // `timeout <= 0`.
      if (!Number.isInteger(node.props.timeout) || Number(node.props.timeout) <= 0) {
        issues.push(issue(`${base}.props.timeout`, '卡片配置有误: Invalid timeout'));
      }
      break;
    case 'delay':
      // bundle Pr.delay requires only Number.isInteger; no `> 0` guard (a live
      // setGraph accepts timeout=0). Match the gateway.
      if (!Number.isInteger(node.props.timeout)) {
        issues.push(issue(`${base}.props.timeout`, '卡片配置有误: Invalid timeout'));
      }
      break;
    case 'loop':
      // bundle Pr.loop requires only Number.isInteger; no `> 0` guard. Match it.
      if (!Number.isInteger(node.props.interval)) {
        issues.push(issue(`${base}.props.interval`, '卡片配置有误: Invalid interval'));
      }
      break;
  }
  return issues;
}

// F22e (2026-05-29 audit): nodeCheckTool.alarmClock save-time checks.
// Sunset-mode requires lat ∈ [-90,90], lng ∈ [-180,180], integer offset.
// Both modes reject `filter.day: []` (empty array selecting zero weekdays
// → rule never fires; UI form shows "至少选择一天").
function checkAlarmClockProps(props: Record<string, unknown>, path: string): LintIssue[] {
  const out: LintIssue[] = [];
  if (props.type === 'sunset') {
    if (typeof props.latitude !== 'number' || props.latitude < -90 || props.latitude > 90) {
      out.push(issue(`${path}.latitude`, '卡片配置有误: 经纬度超出范围'));
    }
    if (typeof props.longitude !== 'number' || props.longitude < -180 || props.longitude > 180) {
      out.push(issue(`${path}.longitude`, '卡片配置有误: 经纬度超出范围'));
    }
    if (!Number.isInteger(props.offset)) {
      out.push(issue(`${path}.offset`, '卡片配置有误: offset 必须为整数'));
    }
  }
  const filter = props.filter;
  if (isRecord(filter) && Array.isArray(filter.day) && filter.day.length === 0) {
    out.push(issue(`${path}.filter.day`, '卡片配置有误: 至少选择一天'));
  }
  return out;
}

// F23 (2026-05-30) — port the variable-existence + scope-whitelist check
// that lives in the UI's `save()` function (NOT in nodeCheckTool). For each
// var card, walk every {scope,id} the card references and verify:
//   1. scope is "global" or "R<ruleId>" (the local-rule convention from F21),
//      else "卡片变量有误";
//   2. the exact (scope,id) tuple is in `listAvailVars(ruleId)`, else
//      "卡片变量丢失". Same-named variables in the other legal scope do not
//      satisfy this check.
// This catches a class of authoring bugs that the per-card `nodeCheckTool`
// port did not — e.g., a varSetNumber whose target variable was deleted
// after the rule was authored.
type VarRef = { scope: string; id: string; path: string };

function collectVarRefs(node: Record<string, unknown>): VarRef[] {
  const refs: VarRef[] = [];
  const type = String(node.type);
  const props = node.props as Record<string, unknown> | undefined;
  if (!isRecord(props)) return refs;

  const pushTopProps = () => {
    if (typeof props.scope === 'string' && typeof props.id === 'string') {
      refs.push({ scope: props.scope, id: props.id, path: 'props' });
    }
  };

  if (type === 'varChange' || type === 'varGet') {
    pushTopProps();
  } else if (type === 'varSetNumber' || type === 'varSetString') {
    pushTopProps();
    const elements = props.elements;
    if (Array.isArray(elements)) {
      for (let i = 0; i < elements.length; i += 1) {
        const el = elements[i];
        if (
          isRecord(el) &&
          el.type === 'var' &&
          typeof el.scope === 'string' &&
          typeof el.id === 'string'
        ) {
          refs.push({ scope: el.scope, id: el.id, path: `props.elements[${i}]` });
        }
      }
    }
  } else if (type === 'deviceInputSetVar' || type === 'deviceGetSetVar') {
    pushTopProps();
    // Event-mode arguments[i] may carry per-arg var refs (F22d).
    const args = props.arguments;
    if (Array.isArray(args)) {
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (isRecord(a) && typeof a.scope === 'string' && typeof a.id === 'string') {
          refs.push({ scope: a.scope, id: a.id, path: `props.arguments[${i}]` });
        }
      }
    }
  } else if (type === 'deviceOutput') {
    // Property-write variable-ref shape: scope/id/dtype merged at props
    // top-level (no `value` field). Action-mode: ins[i] may carry var refs.
    if (typeof props.scope === 'string' && typeof props.id === 'string') {
      refs.push({ scope: props.scope, id: props.id, path: 'props' });
    }
    const ins = props.ins;
    if (Array.isArray(ins)) {
      for (let i = 0; i < ins.length; i += 1) {
        const item = ins[i];
        if (isRecord(item) && typeof item.scope === 'string' && typeof item.id === 'string') {
          refs.push({ scope: item.scope, id: item.id, path: `props.ins[${i}]` });
        }
      }
    }
  }
  return refs;
}

function checkVarRefs(
  node: Record<string, unknown>,
  idx: number,
  ruleId: string,
  availableByScope: Map<string, Set<string>> | null,
): LintIssue[] {
  const out: LintIssue[] = [];
  const localScope = `R${ruleId}`;
  for (const ref of collectVarRefs(node)) {
    const base = `nodes[${idx}].${ref.path}`;
    if (ref.scope !== 'global' && ref.scope !== localScope) {
      out.push(
        issue(
          `${base}.scope`,
          `卡片变量有误: ${ref.scope} is neither "global" nor "${localScope}"`,
        ),
      );
      continue; // matches UI: scope error short-circuits this ref
    }
    // Scope visibility is a graph-local invariant and does not require a
    // gateway variable inventory, so offline --body/--stdin validation must
    // enforce it too. Existence remains an online-only check because an
    // offline graph intentionally has no authoritative variable list.
    if (availableByScope !== null && availableByScope.get(ref.scope)?.has(ref.id) !== true) {
      out.push(issue(base, `卡片变量丢失: ${ref.scope}.${ref.id}`));
    }
  }
  return out;
}

// F22f (2026-05-29 audit): nodeCheckTool.timeRange save-time checks. Field
// presence (start/end.hour/minute/second) is already caught by the strict
// timeRange schema; only `filter.day: []` is the validator-level gap.
function checkTimeRangeProps(props: Record<string, unknown>, path: string): LintIssue[] {
  const out: LintIssue[] = [];
  const filter = props.filter;
  if (isRecord(filter) && Array.isArray(filter.day) && filter.day.length === 0) {
    out.push(issue(`${path}.filter.day`, '卡片配置有误: 至少选择一天'));
  }
  return out;
}

// Variable-ref shape in deviceOutput property/action input: { scope, id, dtype }
// merged at the props/ins[] top-level. See docs/api/nodes.md §deviceOutput.
function isVarValueShape(n: Record<string, unknown>): boolean {
  return 'scope' in n && 'id' in n && 'dtype' in n;
}

function checkLiteralOrVarValue(
  container: Record<string, unknown>,
  path: string,
  valueKey = 'value',
): LintIssue[] {
  const out: LintIssue[] = [];
  if (isVarValueShape(container)) {
    if (isEmptyValue(container.id)) {
      out.push(issue(`${path}.id`, '卡片配置有误: 变量不能为空'));
    }
  } else if (isEmptyValue(container[valueKey])) {
    out.push(issue(`${path}.${valueKey}`, '卡片配置有误: 输入不能为空'));
  }
  return out;
}

function checkDeviceOutputProps(props: Record<string, unknown>, path: string): LintIssue[] {
  const out: LintIssue[] = [];
  if (!Number.isInteger(props.siid)) {
    out.push(issue(`${path}.siid`, '卡片配置有误: 请选择服务'));
    return out;
  }
  if (Number.isInteger(props.piid)) {
    out.push(...checkLiteralOrVarValue(props, path));
  }
  if (Number.isInteger(props.aiid)) {
    const ins = props.ins;
    if (Array.isArray(ins)) {
      for (let i = 0; i < ins.length; i += 1) {
        const item = ins[i];
        if (isRecord(item)) {
          out.push(...checkLiteralOrVarValue(item, `${path}.ins[${i}]`));
        }
      }
    }
  }
  return out;
}

function checkVarComparisonProps(props: Record<string, unknown>, path: string): LintIssue[] {
  const out: LintIssue[] = [];
  if (isEmptyValue(props.scope) || isEmptyValue(props.id) || isEmptyValue(props.varType)) {
    out.push(issue(path, '卡片配置有误: 未选择变量'));
    return out;
  }
  if (!['number', 'string'].includes(String(props.varType))) {
    out.push(issue(`${path}.varType`, '卡片配置有误: Invalid var type'));
    return out;
  }
  if (isEmptyValue(props.operator)) {
    out.push(issue(`${path}.operator`, '卡片配置有误: 请选择对比方式'));
    return out;
  }
  if (props.varType === 'number' && !NUMBER_VAR_OPERATORS.has(String(props.operator))) {
    out.push(issue(`${path}.operator`, '卡片配置有误: Invalid operator'));
  }
  if (props.varType === 'string' && !STRING_VAR_OPERATORS.has(String(props.operator))) {
    out.push(issue(`${path}.operator`, '卡片配置有误: Invalid operator'));
  }
  if (isEmptyValue(props.v1)) {
    out.push(issue(`${path}.v1`, '卡片配置有误: 输入不能为空'));
    return out;
  }
  // F41 (2026-05-30) — bundle Pr.varChange / Pr.varGet require v1 typeof
  // to match varType. number varType also rejects NaN.
  if (props.varType === 'number') {
    if (typeof props.v1 !== 'number' || Number.isNaN(props.v1)) {
      out.push(issue(`${path}.v1`, '卡片配置有误: Invalid v1'));
    }
    if (
      props.operator === 'between' &&
      props.v2 !== undefined &&
      (typeof props.v2 !== 'number' || Number.isNaN(props.v2))
    ) {
      out.push(issue(`${path}.v2`, '卡片配置有误: Invalid v2'));
    }
  } else if (props.varType === 'string' && typeof props.v1 !== 'string') {
    out.push(issue(`${path}.v1`, '卡片配置有误: Invalid v1'));
  }
  if (props.operator === 'between' && isEmptyValue(props.v2)) {
    out.push(issue(`${path}.v2`, '卡片配置有误: 输入不能为空'));
  }
  return out;
}

function checkVarSetProps(
  props: Record<string, unknown>,
  path: string,
  type: 'varSetNumber' | 'varSetString',
): LintIssue[] {
  const out: LintIssue[] = [];
  if (isEmptyValue(props.scope) || isEmptyValue(props.id)) {
    out.push(issue(path, '卡片配置有误: 未选择变量'));
    return out;
  }
  const elements = props.elements;
  if (!Array.isArray(elements) || elements.length === 0) {
    out.push(issue(`${path}.elements`, '卡片配置有误: 未输入内容'));
    return out;
  }
  // G-D (2026-05-29 save-flow parity): varSetNumber runs the official
  // arithmetic-expression grammar check (`Jr.yg.check`, ported faithfully in
  // var-expr-check.ts). varSetString is plain concat — no grammar check (the
  // official nodeCheckTool.varSetString arm omits it). F68 (2026-05-31): surface
  // the *specific* failure (kind + assembled template) instead of the gateway's
  // blanket `运算式不合法`, so authors see why it was rejected.
  if (type === 'varSetNumber') {
    const exprResult = checkVarSetNumberExpr(elements);
    if (!exprResult.ok) {
      out.push(
        issue(
          `${path}.elements`,
          `卡片配置有误: 运算式不合法 — ${exprResult.message}（表达式: "${exprResult.template}"）`,
        ),
      );
    }
  }
  return out;
}

async function checkAgainstSpec(
  node: Record<string, unknown>,
  idx: number,
  specForUrn: (urn: string) => Promise<DeviceSpec>,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  if (
    !['deviceInput', 'deviceGet', 'deviceInputSetVar', 'deviceGetSetVar'].includes(
      String(node.type),
    )
  ) {
    return issues;
  }
  if (!isRecord(node.cfg) || typeof node.cfg.urn !== 'string' || !isRecord(node.props)) {
    return issues;
  }
  const props = node.props;
  if (!Number.isInteger(props.siid)) return issues;

  // F66e-2 (2026-05-31): deviceInputSetVar event-mode runs a per-arg dtype
  // check against the spec; defer to a dedicated helper because the dtype
  // mapping (ka()) is the "variable" variant (int/float/bool → "number"),
  // not the property-mode UI dtype.
  const isEventMode = Number.isInteger(props.eiid) && !Number.isInteger(props.piid);
  const isDeviceInputEvent = node.type === 'deviceInput' && isEventMode;
  const isSetVarEvent = node.type === 'deviceInputSetVar' && isEventMode;
  if (!isDeviceInputEvent && !isSetVarEvent && !Number.isInteger(props.piid)) return issues;

  let spec: DeviceSpec;
  try {
    spec = await specForUrn(node.cfg.urn);
  } catch (e) {
    const specPath = `nodes[${idx}].cfg.urn`;
    // A missing registry entry means there is no external evidence to compare
    // against. Keep the structural result usable, but make the skipped coverage
    // visible instead of silently passing it.
    if (e instanceof MiotSpecFetchError && e.status === 404) {
      return [
        {
          severity: 'warn',
          path: specPath,
          message: `MIoT spec not found (HTTP 404) for ${node.cfg.urn}; spec-aware checks skipped`,
        },
      ];
    }
    // Registry transport/HTTP failures and malformed spec content are external
    // validation failures, not graph-shape failures. Return them as their own
    // issue so callers receive every local schema/expression diagnostic too.
    // Keep programmer errors from arbitrary injected callbacks throwable.
    if (e instanceof XggError && (e.code === 'NETWORK' || e.code === 'SCHEMA')) {
      const status =
        e instanceof MiotSpecFetchError && e.status !== undefined ? ` HTTP ${e.status}` : '';
      return [
        issue(
          specPath,
          `MIoT spec-aware validation failed [${e.code}${status}] for ${node.cfg.urn}: ${e.message}`,
        ),
      ];
    }
    throw e;
  }
  const base = `nodes[${idx}].props`;

  if (isDeviceInputEvent || isSetVarEvent) {
    return checkEventArgsAgainstSpec(
      node,
      spec,
      base,
      isSetVarEvent
        ? (property) => uiVarDtypeFromFormat(property.format)
        : projectMiotComparisonDtype,
    );
  }

  const property = findProperty(spec, props.siid as number, props.piid as number);
  if (property === undefined) {
    issues.push(
      issue(
        base,
        `卡片配置有误: property siid=${props.siid} piid=${props.piid} not found in ${node.cfg.urn}`,
      ),
    );
    return issues;
  }

  // deviceInput / deviceGet get NO dtype↔format check. The gateway's web UI save
  // validator only checks v1-presence + (for int/float dtype) operator/v2; it
  // never compares the node dtype to the spec format. The `变量类型不匹配`
  // mismatch rule is used ONLY by the variable-capture nodes; the gateway
  // checkWebNode doesn't consult the spec either. Erroring on a
  // deviceInput/deviceGet dtype mismatch made this stricter than the UI Save
  // button and false-rejected legitimate UI-exported rules (esp. the value-list
  // float→int case). Mirror the UI: only the setVar nodes carry this check.
  if (node.type === 'deviceInputSetVar' || node.type === 'deviceGetSetVar') {
    const expected = uiVarDtypeFromFormat(property.format);
    if (props.dtype !== expected) {
      issues.push(
        issue(
          `${base}.dtype`,
          `卡片配置有误: MIoT property ${property.type} uses format ${property.format}, so web UI expects variable dtype "${expected}" (got "${String(props.dtype)}")`,
        ),
      );
    }
  }

  return issues;
}

// F66e-2 (2026-05-31): port the spec-driven `ka(t.dtype) !== n.dtype` branch
// of bundle qp() (ai-config-v5.28b650.js:10373) for deviceInputSetVar event-
// mode, and the analogous property-dtype check for deviceInput event-mode.
// Each arg with a numeric piid is looked up in the event's `arguments` list;
// the spec property's MIoT format dictates the expected arg.dtype. Mirrors
// the bundle's two-step fall-through: when the event isn't in the spec (e.g.
// firmware predates the rule), `getEventData(e).length < 1` causes the UI to
// return no errors — we do the same here so spec/firmware drift doesn't
// surface as a spurious dtype mismatch. Args without piid are caught upstream
// (`请选择属性`).
function checkEventArgsAgainstSpec(
  node: Record<string, unknown>,
  spec: DeviceSpec,
  base: string,
  propertyToDtype: (property: MiotProperty) => MiotComparisonDtype | 'number' | 'string',
): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!isRecord(node.props)) return issues;
  const props = node.props;
  const args = props.arguments;
  if (!Array.isArray(args)) return issues;
  const siid = props.siid as number;
  const eiid = props.eiid as number;
  // Bundle parity: if the event row isn't in the spec (`getEventData(e).length < 1`),
  // the UI silently passes; do the same to avoid false positives on stale specs.
  const service = spec.services.find((s) => s.iid === siid);
  const event = service?.events?.find((e) => e.iid === eiid);
  if (event === undefined || !Array.isArray(event.arguments)) return issues;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!isRecord(a) || !Number.isInteger(a.piid)) continue;
    const argPath = `${base}.arguments[${i}]`;
    const property = findEventArgProperty(spec, siid, eiid, a.piid as number);
    if (property === undefined) continue; // bundle skips piids absent from the event
    const expected = propertyToDtype(property);
    if (a.dtype !== expected) {
      const source =
        property.format === 'float' && hasMiotValueList(property)
          ? 'format float with a non-empty value-list'
          : `format ${property.format}`;
      issues.push(
        issue(
          argPath,
          `卡片配置有误: 变量类型不匹配: MIoT property piid=${a.piid} uses ${source}, so web UI expects dtype "${expected}" (got "${String(a.dtype)}")`,
        ),
      );
    }
  }
  return issues;
}

export async function validateGraph(input: ValidateGraphInput): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const nodes = input.graph.nodes;
  if (input.graph.cfg !== undefined) {
    if (input.graph.cfg.id !== input.graph.id) {
      issues.push(issue('cfg.id', '卡片配置有误: cfg.id and id not matching'));
    }
    if (typeof input.graph.cfg.enable !== 'boolean') {
      issues.push(issue('cfg.enable', '卡片配置有误: Invalid cfg.enable'));
    }
  }
  if (nodes === undefined) return issues;
  if (!Array.isArray(nodes)) return [issue('nodes', '卡片配置有误: Invalid nodes')];
  issues.push(...duplicateNodeIdIssues(findDuplicateNodeIds(nodes)));

  let specForUrn: ((urn: string) => Promise<DeviceSpec>) | undefined;
  const getDeviceSpec = input.getDeviceSpec;
  if (getDeviceSpec !== undefined) {
    const specCache = new Map<string, Promise<DeviceSpec>>();
    specForUrn = (urn: string) => {
      let cached = specCache.get(urn);
      if (cached === undefined) {
        cached = getDeviceSpec(urn);
        specCache.set(urn, cached);
      }
      return cached;
    };
  }

  // F23 — fetch the available-vars list once for the whole graph if a
  // callback is provided. Keep the two legal scopes separate so global.foo
  // cannot stand in for R<ruleId>.foo (or vice versa).
  let availableByScope: Map<string, Set<string>> | null = null;
  if (input.listAvailVars !== undefined) {
    try {
      const variables = await input.listAvailVars(input.graph.id);
      availableByScope = new Map<string, Set<string>>();
      for (const variable of variables) {
        let ids = availableByScope.get(variable.scope);
        if (ids === undefined) {
          ids = new Set<string>();
          availableByScope.set(variable.scope, ids);
        }
        ids.add(variable.id);
      }
    } catch (e) {
      // F39 (2026-05-30) — narrow the catch. Mirrors
      // listAvailVarsForRule (variables.ts:54-58) and the specForUrn
      // catch above: only NotFoundError (rule scope missing) is
      // soft-skipped, so the agent still degrades gracefully on stale
      // rule ids but transport/schema/auth failures surface instead
      // of silently disabling the var-existence check.
      if (!(e instanceof NotFoundError)) throw e;
      availableByScope = null;
    }
  }

  for (let idx = 0; idx < nodes.length; idx += 1) {
    const parsed = NodeUnion.safeParse(nodes[idx]);
    if (!parsed.success) {
      issues.push(
        issue(
          `nodes[${idx}]`,
          `卡片配置有误: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
        ),
      );
      continue;
    }
    const node = parsed.data as Record<string, unknown>;
    // Precise per-card checks first — they produce the exact UI messages
    // (请选择对比方式 / 未选择变量 / 输入不能为空 …).
    const localPerCard: LintIssue[] = [];
    localPerCard.push(...checkKnownWebShape(node, idx));
    localPerCard.push(...checkVarRefs(node, idx, input.graph.id, availableByScope));
    issues.push(...localPerCard);
    // F24 KEYSTONE backstop: only when the precise checks found nothing, run
    // the strict per-type schema to catch the structural fall-throughs they
    // don't cover (missing pins, wiped props, etc.). Avoids shadowing the
    // nicer per-card messages while still rejecting every UnknownNode
    // fall-through for a modeled type.
    // Keep external spec diagnostics out of this decision: a timeout/5xx must
    // never suppress local strict-schema coverage for the same node.
    if (localPerCard.length === 0) {
      issues.push(...checkStrictSchema(node, idx));
    }
    if (specForUrn !== undefined) {
      issues.push(...(await checkAgainstSpec(node, idx, specForUrn)));
    }
  }

  return issues;
}

export async function validateGraphOrThrow(input: ValidateGraphInput): Promise<void> {
  const issues = await validateGraph(input);
  const first = issues.find((i) => i.severity === 'error');
  if (first !== undefined) {
    throw new ConfigError(`${first.message} (${first.path})`, { issues });
  }
}
