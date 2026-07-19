import { z } from 'zod';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

export const RegisterCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type RegisterCfg = z.infer<typeof RegisterCfg>;

export const RegisterProps = z.object({}).strict();
export type RegisterProps = z.infer<typeof RegisterProps>;

export const RegisterInputs = z
  .object({
    setTrue: z.null(),
    setFalse: z.null(),
  })
  .strict();
export type RegisterInputs = z.infer<typeof RegisterInputs>;

export const RegisterOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type RegisterOutputs = z.infer<typeof RegisterOutputs>;

export const RegisterNode = z
  .object({
    type: z.literal('register'),
    id: NodeId,
    cfg: RegisterCfg,
    inputs: RegisterInputs,
    outputs: RegisterOutputs,
    props: RegisterProps,
  })
  .strict();
export type RegisterNode = z.infer<typeof RegisterNode>;
