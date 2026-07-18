import { z } from 'zod';
import { Connection, NodeId, Position, hasContiguousNumberedPins } from './common.js';

export const LogicOrCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type LogicOrCfg = z.infer<typeof LogicOrCfg>;

export const LogicOrProps = z.object({}).strict();
export type LogicOrProps = z.infer<typeof LogicOrProps>;

// F74 (2026-05-30): gateway Pr.logicOr accepts ANY dense `input<N>` set; the
// `--inputs N` c-shortcut emits them. See signal-or.ts.
export const LogicOrInputs = z
  .record(z.string().regex(/^input\d+$/), z.null())
  .refine((obj) => hasContiguousNumberedPins(obj, 'input', 2), {
    message: 'logicOr inputs must form the contiguous range input0..input(N-1), with N >= 2',
  });
export type LogicOrInputs = z.infer<typeof LogicOrInputs>;

export const LogicOrOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type LogicOrOutputs = z.infer<typeof LogicOrOutputs>;

export const LogicOrNode = z
  .object({
    type: z.literal('logicOr'),
    id: NodeId,
    cfg: LogicOrCfg,
    inputs: LogicOrInputs,
    outputs: LogicOrOutputs,
    props: LogicOrProps,
  })
  .strict();
export type LogicOrNode = z.infer<typeof LogicOrNode>;
