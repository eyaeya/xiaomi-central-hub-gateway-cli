import { z } from 'zod';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

// Fields derived from fixtures/responses/nodes/varChange/*.json.
// F41 (2026-05-30): props are now a varType-discriminated z.union
// mirroring the bundle's `Pr.varChange.checkWebNode`:
//   varType "number" → operator ∈ {>=, <=, =, !=, >, <, between}
//                      v1 typeof number (NOT NaN)
//                      v2 (required for between) typeof number (NOT NaN)
//   varType "string" → operator "=" only, v1 typeof string
// Pre-F41 v1 was hardcoded z.number(), so the schema accepted bogus
// `varType:'string' + v1:0` shapes the gateway would later reject and
// rejected the actually-valid `varType:'string' + v1:'foo'` shape.
// F38 (2026-05-29) probe + F38.B real-gateway probe confirmed the
// string allow-list (confirmed against the real gateway).

export const VarChangeCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type VarChangeCfg = z.infer<typeof VarChangeCfg>;

const VarChangeNumberProps = z
  .object({
    scope: z.string(),
    id: z.string(),
    varType: z.literal('number'),
    preload: z.boolean(),
    operator: z.enum(['>=', '<=', '=', '!=', '>', '<', 'between']),
    v1: z.number().refine((v) => !Number.isNaN(v), { message: 'Invalid v1: NaN' }),
    v2: z
      .number()
      .refine((v) => !Number.isNaN(v), { message: 'Invalid v2: NaN' })
      .optional(),
  })
  .strict()
  .refine((p) => p.operator !== 'between' || p.v2 !== undefined, {
    message: 'v2 is required when operator is "between"',
    path: ['v2'],
  });

const VarChangeStringProps = z
  .object({
    scope: z.string(),
    id: z.string(),
    varType: z.literal('string'),
    preload: z.boolean(),
    operator: z.literal('='),
    v1: z.string(),
  })
  .strict();

export const VarChangeProps = z.union([VarChangeNumberProps, VarChangeStringProps]);
export type VarChangeProps = z.infer<typeof VarChangeProps>;

export const VarChangeInputs = z.object({}).strict();
export type VarChangeInputs = z.infer<typeof VarChangeInputs>;

export const VarChangeOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type VarChangeOutputs = z.infer<typeof VarChangeOutputs>;

export const VarChangeNode = z
  .object({
    type: z.literal('varChange'),
    id: NodeId,
    cfg: VarChangeCfg,
    inputs: VarChangeInputs,
    outputs: VarChangeOutputs,
    props: VarChangeProps,
  })
  .strict();
export type VarChangeNode = z.infer<typeof VarChangeNode>;
