import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const AlarmClockCfg = z
  .object({
    urn: z.string().optional(),
    pos: Position,
    name: z.string(),
    version: z.number(),
    happenType: z.string(),
    tempOffset: z.number(),
  })
  .strict();
export type AlarmClockCfg = z.infer<typeof AlarmClockCfg>;

// M10 F32/F33: alarmClock has two distinct props shapes. The previous
// single-shape schema (strict + required hour/minute/second + filter:{})
// only matched the periodicAlarm form and silently fell through to
// UnknownNode for the sunset form, masking F33 (lat/long fields).
//
//   periodicAlarm: { type, isSunset:false, hour, minute, second, filter }
//   sunset:        { type, isSunset, offset, latitude, longitude, filter }
//
// Filter mirrors TimeRange's tri-form (every-day / inHoliday / day[]).
const AlarmClockFilter = z.union([
  z.object({}).strict(),
  z.object({ inHoliday: z.boolean() }).strict(),
  z.object({ day: z.array(z.number().int().min(0).max(6)) }).strict(),
]);

// F43 (2026-05-30) — bundle Pr.alarmClock enforces:
//   periodicAlarm: hour/minute/second `Number.isInteger` + in-range
//     (hour 0..23, minute/second 0..59); probe responses are
//     "Invalid hour"/"Hour out of range" etc.
//   sunset: offset must be `Number.isInteger` (verified Pr probe);
//     latitude/longitude in -90..90 / -180..180.
const AlarmClockPeriodicProps = z
  .object({
    type: z.literal('periodicAlarm'),
    isSunset: z.boolean(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    second: z.number().int().min(0).max(59),
    filter: AlarmClockFilter,
  })
  .strict();

const AlarmClockSunsetProps = z
  .object({
    type: z.literal('sunset'),
    isSunset: z.boolean(),
    offset: z.number().int(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    filter: AlarmClockFilter,
  })
  .strict();

export const AlarmClockProps = z.union([AlarmClockPeriodicProps, AlarmClockSunsetProps]);
export type AlarmClockProps = z.infer<typeof AlarmClockProps>;

export const AlarmClockInputs = z.object({}).strict();
export type AlarmClockInputs = z.infer<typeof AlarmClockInputs>;

export const AlarmClockOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type AlarmClockOutputs = z.infer<typeof AlarmClockOutputs>;

export const AlarmClockNode = z
  .object({
    type: z.literal('alarmClock'),
    id: NodeId,
    cfg: AlarmClockCfg,
    inputs: AlarmClockInputs,
    outputs: AlarmClockOutputs,
    props: AlarmClockProps,
  })
  .strict();
export type AlarmClockNode = z.infer<typeof AlarmClockNode>;
