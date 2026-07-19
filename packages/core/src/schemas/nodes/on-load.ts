import { z } from 'zod';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

export const OnLoadCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type OnLoadCfg = z.infer<typeof OnLoadCfg>;

export const OnLoadProps = z.object({}).strict();
export type OnLoadProps = z.infer<typeof OnLoadProps>;

export const OnLoadInputs = z.object({}).strict();
export type OnLoadInputs = z.infer<typeof OnLoadInputs>;

export const OnLoadOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type OnLoadOutputs = z.infer<typeof OnLoadOutputs>;

export const OnLoadNode = z
  .object({
    type: z.literal('onLoad'),
    id: NodeId,
    cfg: OnLoadCfg,
    inputs: OnLoadInputs,
    outputs: OnLoadOutputs,
    props: OnLoadProps,
  })
  .strict();
export type OnLoadNode = z.infer<typeof OnLoadNode>;
