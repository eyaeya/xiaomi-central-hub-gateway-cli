import { z } from 'zod';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

export const ConditionCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type ConditionCfg = z.infer<typeof ConditionCfg>;

export const ConditionProps = z.object({}).strict();
export type ConditionProps = z.infer<typeof ConditionProps>;

export const ConditionInputs = z
  .object({
    trigger: z.null(),
    condition: z.null(),
  })
  .strict();
export type ConditionInputs = z.infer<typeof ConditionInputs>;

export const ConditionOutputs = z
  .object({
    met: z.array(Connection),
    unmet: z.array(Connection),
  })
  .strict();
export type ConditionOutputs = z.infer<typeof ConditionOutputs>;

export const ConditionNode = z
  .object({
    type: z.literal('condition'),
    id: NodeId,
    cfg: ConditionCfg,
    inputs: ConditionInputs,
    outputs: ConditionOutputs,
    props: ConditionProps,
  })
  .strict();
export type ConditionNode = z.infer<typeof ConditionNode>;
