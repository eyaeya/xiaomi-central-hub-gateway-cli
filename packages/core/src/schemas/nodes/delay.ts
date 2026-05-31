import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const DelayCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
    unit: z.string(),
    value: z.number(),
  })
  .strict();
export type DelayCfg = z.infer<typeof DelayCfg>;

// F43 (2026-05-30) — bundle Pr.delay requires
// `Number.isInteger(timeout) && timeout >= 1` (milliseconds);
// non-integer returns "Invalid timeout".
export const DelayProps = z
  .object({
    timeout: z.number().int().min(1),
  })
  .strict();
export type DelayProps = z.infer<typeof DelayProps>;

export const DelayInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type DelayInputs = z.infer<typeof DelayInputs>;

export const DelayOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type DelayOutputs = z.infer<typeof DelayOutputs>;

export const DelayNode = z
  .object({
    type: z.literal('delay'),
    id: NodeId,
    cfg: DelayCfg,
    inputs: DelayInputs,
    outputs: DelayOutputs,
    props: DelayProps,
  })
  .strict();
export type DelayNode = z.infer<typeof DelayNode>;
