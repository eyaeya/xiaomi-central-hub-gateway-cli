import { z } from 'zod';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';
import { DurationUnitSchema, DurationValueSchema, refineDurationConsistency } from './duration.js';

export const DelayCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
    unit: DurationUnitSchema,
    value: DurationValueSchema,
  })
  .strict();
export type DelayCfg = z.infer<typeof DelayCfg>;

// bundle Pr.delay requires ONLY `Number.isInteger(timeout)` (milliseconds);
// there is NO `>= 1` / `> 0` guard (unlike statusLast / eventSequence). A live
// setGraph with `timeout: 0` is accepted, so an earlier `.min(1)` was stricter
// than the gateway and false-rejected imported/round-tripped rules with timeout 0.
export const DelayProps = z
  .object({
    timeout: z.number().int(),
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
  .strict()
  .superRefine((node, ctx) => {
    refineDurationConsistency(node.cfg, 'timeout', node.props.timeout, ctx);
  });
export type DelayNode = z.infer<typeof DelayNode>;
