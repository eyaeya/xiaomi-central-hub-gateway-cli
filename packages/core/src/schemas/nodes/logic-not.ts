import { z } from 'zod';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

export const LogicNotCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type LogicNotCfg = z.infer<typeof LogicNotCfg>;

export const LogicNotProps = z.object({}).strict();
export type LogicNotProps = z.infer<typeof LogicNotProps>;

export const LogicNotInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type LogicNotInputs = z.infer<typeof LogicNotInputs>;

export const LogicNotOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type LogicNotOutputs = z.infer<typeof LogicNotOutputs>;

export const LogicNotNode = z
  .object({
    type: z.literal('logicNot'),
    id: NodeId,
    cfg: LogicNotCfg,
    inputs: LogicNotInputs,
    outputs: LogicNotOutputs,
    props: LogicNotProps,
  })
  .strict();
export type LogicNotNode = z.infer<typeof LogicNotNode>;
