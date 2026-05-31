import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const CounterCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type CounterCfg = z.infer<typeof CounterCfg>;

// F43 (2026-05-30) — bundle Pr.counter requires
// `Number.isInteger(n) && n >= 1`; non-integer or n=0 returns "Invalid n".
export const CounterProps = z
  .object({
    n: z.number().int().min(1),
  })
  .strict();
export type CounterProps = z.infer<typeof CounterProps>;

export const CounterInputs = z
  .object({
    input: z.null(),
    zero: z.null(),
  })
  .strict();
export type CounterInputs = z.infer<typeof CounterInputs>;

export const CounterOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type CounterOutputs = z.infer<typeof CounterOutputs>;

export const CounterNode = z
  .object({
    type: z.literal('counter'),
    id: NodeId,
    cfg: CounterCfg,
    inputs: CounterInputs,
    outputs: CounterOutputs,
    props: CounterProps,
  })
  .strict();
export type CounterNode = z.infer<typeof CounterNode>;
