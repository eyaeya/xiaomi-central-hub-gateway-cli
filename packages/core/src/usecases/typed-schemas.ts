// F24 KEYSTONE (2026-05-30) — per-type strict schema map. Originally lived
// inside validate-graph.ts; F62 (2026-05-30) lifted it to its own module so
// lint-graph.ts can reuse the same map without taking a dependency edge on
// validate-graph (a usecase importing another usecase is the loop we want to
// avoid).
//
// Why this map exists: schemas/nodes/index.ts NodeUnion ends in a permissive
// `UnknownNode` ({type,id}.passthrough()) so a MODELED type whose props
// shape is malformed silently parses as UnknownNode. validateGraph and
// lintGraph BOTH re-check each node against its SPECIFIC schema to reject
// the fall-through. The 25 strict schemas already encode the official Ur
// base checks (props/inputs/outputs/cfg.version presence) + per-card pin
// and field presence, so a single re-validate collapses a whole class of
// structural gaps.
//
// Forward-compat invariant: types NOT in this map are LEGITIMATELY allowed
// to pass through as UnknownNode — newer gateway firmware may add types
// before the schema package is updated, and treating those as errors would
// turn every firmware bump into a CLI break. Callers handle the
// type-not-modeled case themselves (lint emits a warn; validate skips).

import {
  AlarmClockNode,
  ConditionNode,
  CounterNode,
  DelayNode,
  DeviceGetNode,
  DeviceGetSetVarNode,
  DeviceInputNode,
  DeviceInputSetVarNode,
  DeviceOutputNode,
  EventSequenceNode,
  LogicAndNode,
  LogicNotNode,
  LogicOrNode,
  LoopNode,
  ModeSwitchNode,
  OnLoadNode,
  OnlyNTimesNode,
  RegisterNode,
  SignalOrNode,
  StatusLastNode,
  TimeRangeNode,
  VarChangeNode,
  VarGetNode,
  VarSetNumberNode,
  VarSetStringNode,
} from '../schemas/nodes/index.js';

export interface SafeParseLike {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues?: Array<{ path?: unknown[]; message?: string }> };
  };
}

export const TYPED_SCHEMAS: Record<string, SafeParseLike> = {
  alarmClock: AlarmClockNode,
  condition: ConditionNode,
  counter: CounterNode,
  delay: DelayNode,
  deviceGet: DeviceGetNode,
  deviceGetSetVar: DeviceGetSetVarNode,
  deviceInput: DeviceInputNode,
  deviceInputSetVar: DeviceInputSetVarNode,
  deviceOutput: DeviceOutputNode,
  eventSequence: EventSequenceNode,
  logicAnd: LogicAndNode,
  logicNot: LogicNotNode,
  logicOr: LogicOrNode,
  loop: LoopNode,
  modeSwitch: ModeSwitchNode,
  onLoad: OnLoadNode,
  onlyNTimes: OnlyNTimesNode,
  register: RegisterNode,
  signalOr: SignalOrNode,
  statusLast: StatusLastNode,
  timeRange: TimeRangeNode,
  varChange: VarChangeNode,
  varGet: VarGetNode,
  varSetNumber: VarSetNumberNode,
  varSetString: VarSetStringNode,
};

export interface StrictSchemaIssue {
  /** Dot-joined zod issue path inside the node (e.g. `props.arguments`). */
  field: string;
  /** First zod issue's message (the actionable one). */
  message: string;
}

/**
 * If `node.type` is a modeled type AND its strict schema rejects the node,
 * return the first failing zod issue's path+message. Returns `null` for:
 *   - unmodeled types (forward-compat path; caller decides whether to warn);
 *   - modeled types that parse cleanly.
 *
 * Callers compose their own user-facing message (lint vs validate use
 * different prefixes — `卡片配置有误` for the save-time validator,
 * `node failed its strict schema` for the lint pass).
 */
export function checkNodeStrict(node: Record<string, unknown>): StrictSchemaIssue | null {
  const type = String(node.type);
  const schema = TYPED_SCHEMAS[type];
  if (schema === undefined) return null;
  const parsed = schema.safeParse(node);
  if (parsed.success) return null;
  const firstIssue = parsed.error?.issues?.[0];
  const field = Array.isArray(firstIssue?.path) ? firstIssue.path.join('.') : '';
  const message = firstIssue?.message ?? 'shape mismatch';
  return { field, message };
}
