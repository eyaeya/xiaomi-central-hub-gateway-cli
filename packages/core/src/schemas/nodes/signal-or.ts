import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const SignalOrCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type SignalOrCfg = z.infer<typeof SignalOrCfg>;

export const SignalOrProps = z.object({}).strict();
export type SignalOrProps = z.infer<typeof SignalOrProps>;

// F74 (2026-05-30): gateway Pr.signalOr accepts ANY dense `input<N>` set
// (input0, input1, input2, …); the `--inputs N` c-shortcut emits them. Mirror
// the modeSwitch F6 widening: a record keyed by `input\d+` with at least
// input0 + input1 present (the c-shortcut minimum).
export const SignalOrInputs = z
  .record(z.string().regex(/^input\d+$/), z.null())
  .refine((obj) => 'input0' in obj && 'input1' in obj, {
    message: 'signalOr inputs must include at least input0 and input1',
  });
export type SignalOrInputs = z.infer<typeof SignalOrInputs>;

export const SignalOrOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type SignalOrOutputs = z.infer<typeof SignalOrOutputs>;

export const SignalOrNode = z
  .object({
    type: z.literal('signalOr'),
    id: NodeId,
    cfg: SignalOrCfg,
    inputs: SignalOrInputs,
    outputs: SignalOrOutputs,
    props: SignalOrProps,
  })
  .strict();
export type SignalOrNode = z.infer<typeof SignalOrNode>;
