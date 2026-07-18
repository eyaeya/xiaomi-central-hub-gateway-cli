import { z } from 'zod';
import { Connection, NodeId, Position, hasContiguousNumberedPins } from './common.js';

export const LogicAndCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type LogicAndCfg = z.infer<typeof LogicAndCfg>;

export const LogicAndProps = z.object({}).strict();
export type LogicAndProps = z.infer<typeof LogicAndProps>;

// F74 (2026-05-30): gateway Pr.logicAnd accepts ANY dense `input<N>` set; the
// `--inputs N` c-shortcut emits them. See signal-or.ts.
export const LogicAndInputs = z
  .record(z.string().regex(/^input\d+$/), z.null())
  .refine((obj) => hasContiguousNumberedPins(obj, 'input', 2), {
    message: 'logicAnd inputs must form the contiguous range input0..input(N-1), with N >= 2',
  });
export type LogicAndInputs = z.infer<typeof LogicAndInputs>;

export const LogicAndOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type LogicAndOutputs = z.infer<typeof LogicAndOutputs>;

export const LogicAndNode = z
  .object({
    type: z.literal('logicAnd'),
    id: NodeId,
    cfg: LogicAndCfg,
    inputs: LogicAndInputs,
    outputs: LogicAndOutputs,
    props: LogicAndProps,
  })
  .strict();
export type LogicAndNode = z.infer<typeof LogicAndNode>;
