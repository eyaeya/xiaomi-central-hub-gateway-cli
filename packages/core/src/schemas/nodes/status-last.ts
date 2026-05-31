import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const StatusLastCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
    unit: z.string(),
    value: z.number(),
  })
  .strict();
export type StatusLastCfg = z.infer<typeof StatusLastCfg>;

// F43 (2026-05-30) — bundle Pr.statusLast requires
// `Number.isInteger(timeout) && timeout >= 1` (milliseconds).
export const StatusLastProps = z
  .object({
    timeout: z.number().int().min(1),
  })
  .strict();
export type StatusLastProps = z.infer<typeof StatusLastProps>;

export const StatusLastInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type StatusLastInputs = z.infer<typeof StatusLastInputs>;

export const StatusLastOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type StatusLastOutputs = z.infer<typeof StatusLastOutputs>;

export const StatusLastNode = z
  .object({
    type: z.literal('statusLast'),
    id: NodeId,
    cfg: StatusLastCfg,
    inputs: StatusLastInputs,
    outputs: StatusLastOutputs,
    props: StatusLastProps,
  })
  .strict();
export type StatusLastNode = z.infer<typeof StatusLastNode>;
