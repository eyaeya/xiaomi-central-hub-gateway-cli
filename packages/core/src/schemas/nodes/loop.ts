import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const LoopCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
    unit: z.string(),
    value: z.number(),
  })
  .strict();
export type LoopCfg = z.infer<typeof LoopCfg>;

// F43 (2026-05-30) — bundle Pr.loop requires `Number.isInteger(interval)
// && interval >= 1` (milliseconds).
export const LoopProps = z
  .object({
    interval: z.number().int().min(1),
  })
  .strict();
export type LoopProps = z.infer<typeof LoopProps>;

export const LoopInputs = z
  .object({
    start: z.null(),
    stop: z.null(),
  })
  .strict();
export type LoopInputs = z.infer<typeof LoopInputs>;

export const LoopOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type LoopOutputs = z.infer<typeof LoopOutputs>;

export const LoopNode = z
  .object({
    type: z.literal('loop'),
    id: NodeId,
    cfg: LoopCfg,
    inputs: LoopInputs,
    outputs: LoopOutputs,
    props: LoopProps,
  })
  .strict();
export type LoopNode = z.infer<typeof LoopNode>;
