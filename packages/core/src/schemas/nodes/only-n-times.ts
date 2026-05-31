import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const OnlyNTimesCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type OnlyNTimesCfg = z.infer<typeof OnlyNTimesCfg>;

// F43 (2026-05-30) — bundle Pr.onlyNTimes mirrors counter:
// `Number.isInteger(n) && n >= 1`.
export const OnlyNTimesProps = z
  .object({
    n: z.number().int().min(1),
  })
  .strict();
export type OnlyNTimesProps = z.infer<typeof OnlyNTimesProps>;

export const OnlyNTimesInputs = z
  .object({
    input: z.null(),
    zero: z.null(),
  })
  .strict();
export type OnlyNTimesInputs = z.infer<typeof OnlyNTimesInputs>;

export const OnlyNTimesOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type OnlyNTimesOutputs = z.infer<typeof OnlyNTimesOutputs>;

export const OnlyNTimesNode = z
  .object({
    type: z.literal('onlyNTimes'),
    id: NodeId,
    cfg: OnlyNTimesCfg,
    inputs: OnlyNTimesInputs,
    outputs: OnlyNTimesOutputs,
    props: OnlyNTimesProps,
  })
  .strict();
export type OnlyNTimesNode = z.infer<typeof OnlyNTimesNode>;
