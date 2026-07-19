import { z } from 'zod';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

// Fields derived from fixtures/responses/nodes/varGet/*.json.
// F41 (2026-05-30): same varType-discriminated structure as VarChange,
// except `varGet` does NOT carry `preload` (the bundle's Pr.varGet
// validator has no preload check, the UI omits it for varGet cards).
// See var-change.ts for the per-varType operator allow-list rationale
// and probe trail.

export const VarGetCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type VarGetCfg = z.infer<typeof VarGetCfg>;

const VarGetNumberProps = z
  .object({
    scope: z.string(),
    id: z.string(),
    varType: z.literal('number'),
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

const VarGetStringProps = z
  .object({
    scope: z.string(),
    id: z.string(),
    varType: z.literal('string'),
    operator: z.literal('='),
    v1: z.string(),
  })
  .strict();

export const VarGetProps = z.union([VarGetNumberProps, VarGetStringProps]);
export type VarGetProps = z.infer<typeof VarGetProps>;

export const VarGetInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type VarGetInputs = z.infer<typeof VarGetInputs>;

export const VarGetOutputs = z
  .object({
    output: z.array(Connection),
    output2: z.array(Connection),
  })
  .strict();
export type VarGetOutputs = z.infer<typeof VarGetOutputs>;

export const VarGetNode = z
  .object({
    type: z.literal('varGet'),
    id: NodeId,
    cfg: VarGetCfg,
    inputs: VarGetInputs,
    outputs: VarGetOutputs,
    props: VarGetProps,
  })
  .strict();
export type VarGetNode = z.infer<typeof VarGetNode>;
