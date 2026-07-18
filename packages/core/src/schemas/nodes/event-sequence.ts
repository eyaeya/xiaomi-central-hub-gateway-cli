import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';
import { DurationUnitSchema, DurationValueSchema, refineDurationConsistency } from './duration.js';

export const EventSequenceCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
    unit: DurationUnitSchema,
    value: DurationValueSchema,
  })
  .strict();
export type EventSequenceCfg = z.infer<typeof EventSequenceCfg>;

// F43 (2026-05-30) — bundle Pr.eventSequence requires
// `Number.isInteger(timeout) && timeout >= 1` (milliseconds).
export const EventSequenceProps = z
  .object({
    timeout: z.number().int().min(1),
  })
  .strict();
export type EventSequenceProps = z.infer<typeof EventSequenceProps>;

export const EventSequenceInputs = z
  .object({
    input1: z.null(),
    input2: z.null(),
  })
  .strict();
export type EventSequenceInputs = z.infer<typeof EventSequenceInputs>;

export const EventSequenceOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type EventSequenceOutputs = z.infer<typeof EventSequenceOutputs>;

export const EventSequenceNode = z
  .object({
    type: z.literal('eventSequence'),
    id: NodeId,
    cfg: EventSequenceCfg,
    inputs: EventSequenceInputs,
    outputs: EventSequenceOutputs,
    props: EventSequenceProps,
  })
  .strict()
  .superRefine((node, ctx) => {
    refineDurationConsistency(node.cfg, 'timeout', node.props.timeout, ctx);
  });
export type EventSequenceNode = z.infer<typeof EventSequenceNode>;
