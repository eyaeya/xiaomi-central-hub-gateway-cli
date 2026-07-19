import { z } from 'zod';
import { MIOT_COMPARISON_CONTRACT } from '../miot-comparison.js';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

// F40 (2026-05-30) — props are now a dtype-discriminated union mirroring
// the bundle's `Pr.deviceGet.checkWebNode` (identical shape to the
// `Pr.deviceInput` property branch). See device-input.ts for the full
// dtype × operator × v1 matrix and the probe trail.
// F14b (2026-05-28, UI-saved walk-02): web UI emits an extra
// `simplified` boolean on cfg (the "默认设置 / 高级设置" toggle).
export const DeviceGetCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type DeviceGetCfg = z.infer<typeof DeviceGetCfg>;

const propertyBase = {
  did: z.string(),
  siid: z.number().int(),
  piid: z.number().int(),
  preload: z.boolean().optional(),
};

const SafeInteger = z.number().refine(Number.isSafeInteger, 'Expected a safe integer');
const FiniteNumber = z.number().finite();

const DeviceGetBoolProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('boolean'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.boolean.equalityWireOperator),
    v1: z.boolean(),
  })
  .strict();

const DeviceGetStringProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('string'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.string.equalityWireOperator),
    v1: z.string().min(1),
  })
  .strict();

const DeviceGetIntIncludeProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('int'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.int.equalityWireOperator),
    v1: z.array(SafeInteger).min(1),
  })
  .strict();

const DeviceGetIntBetweenProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('int'),
    operator: z.literal('between'),
    v1: SafeInteger,
    v2: SafeInteger,
  })
  .strict()
  .refine(({ v1, v2 }) => v1 <= v2, {
    path: ['v2'],
    message: 'between requires v1 <= v2',
  });

const DeviceGetIntScalarProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('int'),
    operator: z.enum(MIOT_COMPARISON_CONTRACT.int.scalarWireOperators),
    v1: SafeInteger,
  })
  .strict();

const DeviceGetFloatBetweenProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('float'),
    operator: z.literal('between'),
    v1: FiniteNumber,
    v2: FiniteNumber,
  })
  .strict()
  .refine(({ v1, v2 }) => v1 <= v2, {
    path: ['v2'],
    message: 'between requires v1 <= v2',
  });

const DeviceGetFloatScalarProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('float'),
    operator: z.enum(MIOT_COMPARISON_CONTRACT.float.scalarWireOperators),
    v1: FiniteNumber,
  })
  .strict();

export const DeviceGetProps = z.union([
  DeviceGetBoolProps,
  DeviceGetStringProps,
  DeviceGetIntIncludeProps,
  DeviceGetIntBetweenProps,
  DeviceGetIntScalarProps,
  DeviceGetFloatBetweenProps,
  DeviceGetFloatScalarProps,
]);
export type DeviceGetProps = z.infer<typeof DeviceGetProps>;

export const DeviceGetInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type DeviceGetInputs = z.infer<typeof DeviceGetInputs>;

export const DeviceGetOutputs = z
  .object({
    output: z.array(Connection),
    output2: z.array(Connection),
  })
  .strict();
export type DeviceGetOutputs = z.infer<typeof DeviceGetOutputs>;

export const DeviceGetNode = z
  .object({
    type: z.literal('deviceGet'),
    id: NodeId,
    cfg: DeviceGetCfg,
    inputs: DeviceGetInputs,
    outputs: DeviceGetOutputs,
    props: DeviceGetProps,
  })
  .strict();
export type DeviceGetNode = z.infer<typeof DeviceGetNode>;
