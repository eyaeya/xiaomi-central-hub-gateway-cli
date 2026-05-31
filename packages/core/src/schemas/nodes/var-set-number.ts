import { z } from 'zod';
import { Connection, ExprPosition, NodeId, VarSetElement } from './common.js';

// Fields derived from fixtures/responses/nodes/varSetNumber/*.json.
// Strict-where-known per M6 design: cfg/inputs/outputs key sets locked;
// props left strict but value-typed; port values left unknown (phase C will
// tighten after blind probe surfaces connected-port shape).

export const VarSetNumberCfg = z
  .object({
    urn: z.string().optional(),
    pos: ExprPosition,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type VarSetNumberCfg = z.infer<typeof VarSetNumberCfg>;

// F43 (2026-05-30) — `elements` is now strictly an array of
// {type:'const',value:string} | {type:'var',scope:string,id:string};
// see common.ts VarSetElement. The Mr.check math-expression grammar is
// still enforced separately by validate-graph's isValidVarSetNumberExpr.
export const VarSetNumberProps = z
  .object({
    scope: z.string(),
    id: z.string(),
    elements: z.array(VarSetElement),
  })
  .strict();
export type VarSetNumberProps = z.infer<typeof VarSetNumberProps>;

export const VarSetNumberInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type VarSetNumberInputs = z.infer<typeof VarSetNumberInputs>;

export const VarSetNumberOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type VarSetNumberOutputs = z.infer<typeof VarSetNumberOutputs>;

export const VarSetNumberNode = z
  .object({
    type: z.literal('varSetNumber'),
    id: NodeId,
    cfg: VarSetNumberCfg,
    inputs: VarSetNumberInputs,
    outputs: VarSetNumberOutputs,
    props: VarSetNumberProps,
  })
  .strict();
export type VarSetNumberNode = z.infer<typeof VarSetNumberNode>;
