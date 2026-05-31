// F29 — pin event/state color table + connection-legality predicate, ported
// from the rule-editor canvas. The official save() flow does NOT check edge pin
// colors; the canvas enforces it at wire-creation time. A cross-color wire
// (e.g. an event output into a state-only input) saves cleanly but is
// runtime-dead / wrong-semantics, so the CLI surfaces it via `rule lint`.
//
// Source of truth (reverse-engineered + verified):
//   - canvas connector classes `Qe = {event, status, both, ...}` and color map
//     `Ln` (event→PURPLE, status→green) in ai-config-v5.28b650.js;
//   - the connection predicate `connectTool.connect`: legal iff
//     `srcType === both || srcType === tgtType` (the SOURCE side is the only
//     wildcard — a dual target is NOT a wildcard);
//   - per-node-type `getIOTypeList` pin definitions.
//   Reverse-engineered from the official gateway rule-editor web canvas.
//   Empirically validated: 75 edges across 51 UI-authored rules, 0 cross-color.
//
// Terminology: the canvas calls the green level color `status`; we render it as
// `state` (the term used throughout docs/api/nodes.md and the CLI). `both` is
// rendered as `event|state`.

export type PinColor = 'event' | 'state' | 'event|state';
export type PinDirection = 'input' | 'output';

interface PinDef {
  name: string;
  color: PinColor;
}

const PIN_TABLE: Record<string, { inputs: PinDef[]; outputs: PinDef[] }> = {
  deviceInput: { inputs: [], outputs: [{ name: 'output', color: 'event|state' }] },
  deviceGet: {
    inputs: [{ name: 'input', color: 'event' }],
    outputs: [
      { name: 'output', color: 'event' },
      { name: 'output2', color: 'event' },
    ],
  },
  deviceOutput: {
    inputs: [{ name: 'trigger', color: 'event' }],
    outputs: [{ name: 'output', color: 'event' }],
  },
  alarmClock: { inputs: [], outputs: [{ name: 'output', color: 'event' }] },
  timeRange: { inputs: [], outputs: [{ name: 'output', color: 'event|state' }] },
  delay: {
    inputs: [{ name: 'input', color: 'event' }],
    outputs: [{ name: 'output', color: 'event' }],
  },
  statusLast: {
    inputs: [{ name: 'input', color: 'state' }],
    outputs: [{ name: 'output', color: 'event|state' }],
  },
  condition: {
    inputs: [
      { name: 'trigger', color: 'event' },
      { name: 'condition', color: 'state' },
    ],
    outputs: [
      { name: 'met', color: 'event' },
      { name: 'unmet', color: 'event' },
    ],
  },
  loop: {
    inputs: [
      { name: 'start', color: 'event' },
      { name: 'stop', color: 'event' },
    ],
    outputs: [{ name: 'output', color: 'event' }],
  },
  onlyNTimes: {
    inputs: [
      { name: 'input', color: 'event' },
      { name: 'zero', color: 'event' },
    ],
    outputs: [{ name: 'output', color: 'event' }],
  },
  counter: {
    inputs: [
      { name: 'input', color: 'event' },
      { name: 'zero', color: 'event' },
    ],
    outputs: [{ name: 'output', color: 'event|state' }],
  },
  signalOr: {
    inputs: [
      { name: 'input0', color: 'event' },
      { name: 'input1', color: 'event' },
    ],
    outputs: [{ name: 'output', color: 'event' }],
  },
  logicOr: {
    inputs: [
      { name: 'input0', color: 'state' },
      { name: 'input1', color: 'state' },
    ],
    outputs: [{ name: 'output', color: 'event|state' }],
  },
  logicAnd: {
    inputs: [
      { name: 'input0', color: 'state' },
      { name: 'input1', color: 'state' },
    ],
    outputs: [{ name: 'output', color: 'event|state' }],
  },
  logicNot: {
    inputs: [{ name: 'input', color: 'state' }],
    outputs: [{ name: 'output', color: 'event|state' }],
  },
  onLoad: { inputs: [], outputs: [{ name: 'output', color: 'event' }] },
  eventSequence: {
    inputs: [
      { name: 'input1', color: 'event' },
      { name: 'input2', color: 'event' },
    ],
    outputs: [{ name: 'output', color: 'event' }],
  },
  register: {
    inputs: [
      { name: 'setTrue', color: 'event' },
      { name: 'setFalse', color: 'event' },
    ],
    outputs: [{ name: 'output', color: 'event|state' }],
  },
  modeSwitch: {
    inputs: [{ name: 'input', color: 'event' }],
    outputs: [
      { name: 'output0', color: 'event' },
      { name: 'output1', color: 'event' },
    ],
  },
  deviceInputSetVar: { inputs: [], outputs: [{ name: 'output', color: 'event' }] },
  deviceGetSetVar: {
    inputs: [{ name: 'input', color: 'event' }],
    outputs: [{ name: 'output', color: 'event' }],
  },
  varChange: { inputs: [], outputs: [{ name: 'output', color: 'event|state' }] },
  varGet: {
    inputs: [{ name: 'input', color: 'event' }],
    outputs: [
      { name: 'output', color: 'event' },
      { name: 'output2', color: 'event' },
    ],
  },
  varSetNumber: {
    inputs: [{ name: 'input', color: 'event' }],
    outputs: [{ name: 'output', color: 'event' }],
  },
  varSetString: {
    inputs: [{ name: 'input', color: 'event' }],
    outputs: [{ name: 'output', color: 'event' }],
  },
};

/**
 * Resolve the event/state color of a pin. Returns `undefined` for an unknown
 * node type or an unresolvable pin name — callers MUST skip the legality check
 * in that case rather than treat it as a violation (forward-compat: a new card
 * type we haven't captured should not produce false positives).
 *
 * Handles two dynamic cases the static table can't express:
 *   - `deviceInput.output` is `event` in event-mode (`props.eiid`) and
 *     `event|state` (dual) in property-mode (`props.piid`);
 *   - dense numbered pins (`input<N>` / `output<N>`) beyond the declared set
 *     (e.g. a 3-input `logicOr`, `modeSwitch.output2`) resolve by prefix.
 */
export function resolvePinColor(
  type: string,
  pin: string,
  direction: PinDirection,
  props?: Record<string, unknown>,
): PinColor | undefined {
  const entry = PIN_TABLE[type];
  if (entry === undefined) return undefined;

  if (type === 'deviceInput' && direction === 'output' && pin === 'output') {
    if (props?.eiid !== undefined) return 'event';
    if (props?.piid !== undefined) return 'event|state';
  }

  const list = direction === 'output' ? entry.outputs : entry.inputs;
  const exact = list.find((p) => p.name === pin);
  if (exact !== undefined) return exact.color;

  const numbered = /^(input|output)\d+$/.exec(pin);
  const prefix = numbered?.[1];
  if (prefix !== undefined) {
    const base = list.find((p) => p.name.startsWith(prefix));
    if (base !== undefined) return base.color;
  }
  return undefined;
}

/**
 * The canvas connection-legality predicate (`connectTool.connect`):
 * a wire from a source-output color to a target-input color is legal iff the
 * source is the dual wildcard or the colors match exactly. The wildcard is
 * source-side only (asymmetric — a dual target is NOT a wildcard). Returns
 * `null` when either color is unknown so the caller skips the check.
 */
export function arePinColorsCompatible(
  src: PinColor | undefined,
  tgt: PinColor | undefined,
): boolean | null {
  if (src === undefined || tgt === undefined) return null;
  return src === 'event|state' || src === tgt;
}
