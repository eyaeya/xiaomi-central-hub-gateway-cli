import { z } from 'zod';

// Deliberately read-compatible rather than editor-strict. Typed shortcut
// authoring applies the ASCII-alphanumeric editor contract separately; this
// schema must continue to parse existing/opaque graphs whose ids predate that
// guard so `rule view`, raw replay, and export never rewrite identities.
export const NodeId = z.string().min(1);
export type NodeId = z.infer<typeof NodeId>;

// The official canvas exposes the same cosmetic "simplified card" toggle on
// every executable node type (everything except the unmodelled `nop` note
// card). Keep the optional field in one shared shape, then spread it into each
// per-type cfg object before `.strict()` so no other unknown cfg keys become
// accepted accidentally.
export const SimplifiableCfgFields = {
  simplified: z.boolean().optional(),
} as const;

/** Shared continuity rule for dynamic pin records such as input0..inputN. */
export function hasContiguousNumberedPins(
  pins: Record<string, unknown>,
  prefix: string,
  minimum: number,
): boolean {
  const count = Object.keys(pins).length;
  if (count < minimum) return false;
  for (let index = 0; index < count; index += 1) {
    if (!Object.hasOwn(pins, `${prefix}${index}`)) return false;
  }
  return true;
}

// cfg.pos in baseline fixtures is always {x, y, width, height} (UI canvas geometry).
// Kept strict — if a future type adds fields, schema parse will surface it.
export const Position = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type Position = z.infer<typeof Position>;

// Expression cards (varSetNumber / varSetString) carry an extra `exprHeight`
// (the resizable expression-editor pane height) inside cfg.pos. Observed in a
// UI-authored rule (样例：手动创建复杂案例, 2026-05-29). Kept strict otherwise;
// only these two card types use this pos shape, so the base Position stays
// locked for every other node type.
export const ExprPosition = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    exprHeight: z.number().optional(),
  })
  .strict();
export type ExprPosition = z.infer<typeof ExprPosition>;

// F43 (2026-05-30) — shared element shape for varSetNumber / varSetString
// `props.elements`. Bundle Pr.varSetNumber / Pr.varSetString iterate each
// entry: `r.type === 'const'` → require `typeof r.value === 'string'`;
// `r.type === 'var'` → require `typeof r.scope === 'string'` and
// `typeof r.id === 'string'`. Any other shape was previously accepted by
// the loose `z.array(z.unknown())` and was rejected at the gateway with
// "Invalid element type/value/scope/var id".
const VarSetConstElement = z
  .object({
    type: z.literal('const'),
    value: z.string(),
  })
  .strict();
const VarSetVarElement = z
  .object({
    type: z.literal('var'),
    scope: z.string(),
    id: z.string(),
  })
  .strict();
export const VarSetElement = z.discriminatedUnion('type', [VarSetConstElement, VarSetVarElement]);
export type VarSetElement = z.infer<typeof VarSetElement>;

// F48 (2026-05-30) — every entry in `outputs[port]` must be a string of
// the form `<targetNodeId>.<targetPort>` (exactly one '.'). Verified
// against the live gateway via raw setGraph: a non-dot string returns
// `Invalid connection: <port>->badnotdot`, an object returns
// `Invalid connection: <port>->[object Object]`. The previous
// `z.array(z.unknown())` posture let both shapes parse silently and
// surfaced only as a setGraph round-trip failure with no zod path.
// Regex matches "any non-dot run, dot, any non-dot run" — Unicode-safe
// (node ids may carry CJK; verified separately that the gateway accepts
// arbitrary string ids).
export const Connection = z.string().regex(/^[^.]+\.[^.]+$/, {
  message:
    'connection must be "<targetNodeId>.<targetPort>" (exactly one dot, neither side empty) — gateway returns "Invalid connection: <port>-><entry>" otherwise',
});
export type Connection = z.infer<typeof Connection>;
