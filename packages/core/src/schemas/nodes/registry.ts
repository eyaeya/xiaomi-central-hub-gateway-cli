import type { z } from 'zod';
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
  NopNode,
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
} from './index.js';

/**
 * Per-`type` schema lookup for the 25 executable node types plus `nop` note.
 *
 * Deliberately excludes `UnknownNode`: it is the `NodeUnion` fallback and only
 * requires `{ type: string, id }.passthrough()`, so running a cfg through it
 * (or through `NodeUnion.safeParse`, where it sits last) would accept almost
 * any "roughly shaped" payload and reduce a precheck to a no-op. Callers that
 * want a *specific* type's schema must look it up here; an unmodeled `type`
 * returns `undefined` so the caller can fall through to the gateway rather than
 * guess.
 *
 * Keys are the exact `type: z.literal(...)` discriminators on each schema.
 */
const KNOWN: Record<string, z.ZodTypeAny> = {
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
  nop: NopNode,
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

/**
 * Resolve the strict zod schema for a node `type`, or `undefined` when the type
 * is not one of the modeled types (caller should defer to the gateway).
 */
export function nodeSchemaForType(type: string): z.ZodTypeAny | undefined {
  return KNOWN[type];
}
