import { z } from 'zod';
import { Connection, NodeId, Position, hasContiguousNumberedPins } from './common.js';

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
// the modeSwitch F6 widening: a record keyed by `input\d+` whose keys form
// the exact range input0..input(N-1), with the c-shortcut minimum of two.
export const SignalOrInputs = z
  .record(z.string().regex(/^input\d+$/), z.null())
  .refine((obj) => hasContiguousNumberedPins(obj, 'input', 2), {
    message: 'signalOr inputs must form the contiguous range input0..input(N-1), with N >= 2',
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
