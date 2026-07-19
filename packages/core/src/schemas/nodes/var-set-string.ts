import { z } from 'zod';
import {
  Connection,
  ExprPosition,
  NodeId,
  SimplifiableCfgFields,
  VarSetElement,
} from './common.js';

// Fields derived from fixtures/responses/nodes/varSetString/*.json.
// Strict-where-known per M6 design: cfg/inputs/outputs key sets locked;
// props left strict but value-typed; port values left unknown (phase C will
// tighten after blind probe surfaces connected-port shape).

export const VarSetStringCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string().optional(),
    pos: ExprPosition,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type VarSetStringCfg = z.infer<typeof VarSetStringCfg>;

// F43 (2026-05-30) — `elements` shares the discriminated-union schema
// with varSetNumber (see common.ts VarSetElement). No Mr.check on the
// string side — the gateway just concatenates.
export const VarSetStringProps = z
  .object({
    scope: z.string(),
    id: z.string(),
    elements: z.array(VarSetElement),
  })
  .strict();
export type VarSetStringProps = z.infer<typeof VarSetStringProps>;

export const VarSetStringInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type VarSetStringInputs = z.infer<typeof VarSetStringInputs>;

export const VarSetStringOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type VarSetStringOutputs = z.infer<typeof VarSetStringOutputs>;

export const VarSetStringNode = z
  .object({
    type: z.literal('varSetString'),
    id: NodeId,
    cfg: VarSetStringCfg,
    inputs: VarSetStringInputs,
    outputs: VarSetStringOutputs,
    props: VarSetStringProps,
  })
  .strict();
export type VarSetStringNode = z.infer<typeof VarSetStringNode>;
