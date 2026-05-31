import { z } from 'zod';
import { AlarmClockNode } from './alarm-clock.js';
import { ConditionNode } from './condition.js';
import { CounterNode } from './counter.js';
import { DelayNode } from './delay.js';
import { DeviceGetSetVarNode } from './device-get-set-var.js';
import { DeviceGetNode } from './device-get.js';
import { DeviceInputSetVarNode } from './device-input-set-var.js';
import { DeviceInputNode } from './device-input.js';
import { DeviceOutputNode } from './device-output.js';
import { EventSequenceNode } from './event-sequence.js';
import { LogicAndNode } from './logic-and.js';
import { LogicNotNode } from './logic-not.js';
import { LogicOrNode } from './logic-or.js';
import { LoopNode } from './loop.js';
import { ModeSwitchNode } from './mode-switch.js';
import { OnLoadNode } from './on-load.js';
import { OnlyNTimesNode } from './only-n-times.js';
import { RegisterNode } from './register.js';
import { SignalOrNode } from './signal-or.js';
import { StatusLastNode } from './status-last.js';
import { TimeRangeNode } from './time-range.js';
import { UnknownNode } from './unknown.js';
import { VarChangeNode } from './var-change.js';
import { VarGetNode } from './var-get.js';
import { VarSetNumberNode } from './var-set-number.js';
import { VarSetStringNode } from './var-set-string.js';

// z.union (not discriminatedUnion) so UnknownNode can act as fallback for any
// type not yet modeled. Trade-off: O(n) parse vs O(1); negligible at n ≤ 25.
// UnknownNode MUST stay last — it matches any { type: string }.
export const NodeUnion = z.union([
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
  UnknownNode,
]);
export type NodeUnion = z.infer<typeof NodeUnion>;

export { AlarmClockNode } from './alarm-clock.js';
export { ConditionNode } from './condition.js';
export { CounterNode } from './counter.js';
export { DelayNode } from './delay.js';
export { DeviceGetNode } from './device-get.js';
export { DeviceGetSetVarNode } from './device-get-set-var.js';
export { DeviceInputNode } from './device-input.js';
export { DeviceInputSetVarNode } from './device-input-set-var.js';
export { DeviceOutputNode } from './device-output.js';
export { EventSequenceNode } from './event-sequence.js';
export { LogicAndNode } from './logic-and.js';
export { LogicNotNode } from './logic-not.js';
export { LogicOrNode } from './logic-or.js';
export { LoopNode } from './loop.js';
export { ModeSwitchNode } from './mode-switch.js';
export { OnLoadNode } from './on-load.js';
export { OnlyNTimesNode } from './only-n-times.js';
export { RegisterNode } from './register.js';
export { SignalOrNode } from './signal-or.js';
export { StatusLastNode } from './status-last.js';
export { TimeRangeNode } from './time-range.js';
export { VarChangeNode } from './var-change.js';
export { VarGetNode } from './var-get.js';
export { VarSetNumberNode } from './var-set-number.js';
export { VarSetStringNode } from './var-set-string.js';
export { UnknownNode } from './unknown.js';
export { NodeId, Position } from './common.js';
