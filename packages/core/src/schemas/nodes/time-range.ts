import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const TimeRangeCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
    // UI save of a timeRange card writes this cosmetic flag even when the
    // c-shortcut-created wire omitted it.
    simplified: z.boolean().optional(),
  })
  .strict();
export type TimeRangeCfg = z.infer<typeof TimeRangeCfg>;

// F43 (2026-05-30) — bundle Pr.timeRange enforces
// `Number.isInteger(start/end.hour/minute/second)` + in-range (hour
// 0..23, minute/second 0..59) on every component. Probe response:
// "Invalid node parameter:<id>,Start.hour out of range".
const TimePoint = z
  .object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    second: z.number().int().min(0).max(59),
  })
  .strict();

// M10 F32 (probe): docs/api/nodes.md lists three filter forms — `{}` (every
// day) / `{inHoliday: bool}` (workdays vs holidays) / `{day: [0..6]}`
// (custom set of weekdays). All rule sample uses `{inHoliday: false}` and
// the previous `z.object({}).strict()` rejected it (silently masked by
// NodeUnion → UnknownNode fallback).
const TimeRangeFilter = z.union([
  z.object({}).strict(),
  z.object({ inHoliday: z.boolean() }).strict(),
  z.object({ day: z.array(z.number().int().min(0).max(6)) }).strict(),
]);

export const TimeRangeProps = z
  .object({
    start: TimePoint,
    end: TimePoint,
    filter: TimeRangeFilter,
  })
  .strict();
export type TimeRangeProps = z.infer<typeof TimeRangeProps>;

export const TimeRangeInputs = z.object({}).strict();
export type TimeRangeInputs = z.infer<typeof TimeRangeInputs>;

export const TimeRangeOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type TimeRangeOutputs = z.infer<typeof TimeRangeOutputs>;

export const TimeRangeNode = z
  .object({
    type: z.literal('timeRange'),
    id: NodeId,
    cfg: TimeRangeCfg,
    inputs: TimeRangeInputs,
    outputs: TimeRangeOutputs,
    props: TimeRangeProps,
  })
  .strict();
export type TimeRangeNode = z.infer<typeof TimeRangeNode>;
