import { z } from 'zod';
import { MIOT_COMPARISON_CONTRACT } from '../miot-comparison.js';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

// Fields derived from fixtures/responses/nodes/deviceInput/baseline-full.json.
// Strict-where-known per M6 design: cfg/inputs/outputs key sets locked.
// F40 (2026-05-30) — props are now a dtype-discriminated union mirroring
// the bundle's `Pr.deviceInput.checkWebNode`:
//   dtype "boolean": operator "=" only,         v1 typeof === "boolean"
//   dtype "string":  operator "=" only,         v1 typeof === "string"
//   dtype "int":     operators >, <, >=, <=, =, !=, between, include
//                    include → v1 array of integers
//                    between → v1 integer + v2 integer
//                    else    → v1 integer
//   dtype "float":   operators >, <, between ONLY (NOT >=, <=, =, !=, include)
//                    between → v1 number + v2 number
//                    else    → v1 number
// Verified end-to-end against the live gateway on 2026-05-30 (probe doc
// 2026-05-30-f38-discovery.md adds F40 float-operator findings).

// F14b (2026-05-28, UI-saved): web UI emits optional `cfg.simplified`
// (the 默认设置 / 高级设置 toggle), now shared by every modeled cfg.
export const DeviceInputCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type DeviceInputCfg = z.infer<typeof DeviceInputCfg>;

const propertyBase = {
  did: z.string(),
  siid: z.number().int(),
  piid: z.number().int(),
  // Legacy gateway graphs may omit this field. Typed authoring canonicalises
  // omission to the official new-card default (`false`) while preserving both
  // explicit boolean values on read/export.
  preload: z.boolean().optional(),
};

const SafeInteger = z.number().refine(Number.isSafeInteger, 'Expected a safe integer');
const FiniteNumber = z.number().finite();

const DeviceInputBoolProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('boolean'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.boolean.equalityWireOperator),
    v1: z.boolean(),
  })
  .strict();

const DeviceInputStringProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('string'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.string.equalityWireOperator),
    v1: z.string().min(1),
  })
  .strict();

const DeviceInputIntIncludeProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('int'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.int.equalityWireOperator),
    v1: z.array(SafeInteger).min(1),
  })
  .strict();

const DeviceInputIntBetweenProps = z
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

const DeviceInputIntScalarProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('int'),
    operator: z.enum(MIOT_COMPARISON_CONTRACT.int.scalarWireOperators),
    v1: SafeInteger,
  })
  .strict();

const DeviceInputFloatBetweenProps = z
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

const DeviceInputFloatScalarProps = z
  .object({
    ...propertyBase,
    dtype: z.literal('float'),
    operator: z.enum(MIOT_COMPARISON_CONTRACT.float.scalarWireOperators),
    v1: FiniteNumber,
  })
  .strict();

const DeviceInputPropertyProps = z.union([
  DeviceInputBoolProps,
  DeviceInputStringProps,
  DeviceInputIntIncludeProps,
  DeviceInputIntBetweenProps,
  DeviceInputIntScalarProps,
  DeviceInputFloatBetweenProps,
  DeviceInputFloatScalarProps,
]);

// Event-driven shape (M9 F11 — BLE button / motion / etc.):
// `{did, siid, eiid, arguments: [...]}`. `arguments` is mandatory even
// when empty because the gateway iterates it unconditionally.
//
// F59 (2026-05-30) — each event arg has a per-element shape verified by
// bundle Pr.deviceInput (event branch): every element requires
// `Number.isInteger(piid)` AND `dtype ∈ {int|float|string|boolean}`.
// When the element ALSO declares `operator`, the bundle reproduces the
// per-dtype operator + v1 type matrix from the top-level property
// branch (F40): bool/string → operator '=' with matching v1 typeof;
// int → 8-op vocab with v1 int (or array for include, +v2 for between);
// float → {>, <, between} only with v1 number (+v2 for between).
// Elements without an `operator` field are accepted with just piid+dtype.
const DeviceInputEventArgBase = { piid: z.number().int() };

const DeviceInputEventArgBare = z
  .object({ ...DeviceInputEventArgBase, dtype: z.enum(['int', 'float', 'boolean', 'string']) })
  .strict();
const DeviceInputEventArgBool = z
  .object({
    ...DeviceInputEventArgBase,
    dtype: z.literal('boolean'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.boolean.equalityWireOperator),
    v1: z.boolean(),
  })
  .strict();
const DeviceInputEventArgString = z
  .object({
    ...DeviceInputEventArgBase,
    dtype: z.literal('string'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.string.equalityWireOperator),
    v1: z.string().min(1),
  })
  .strict();
const DeviceInputEventArgIntInclude = z
  .object({
    ...DeviceInputEventArgBase,
    dtype: z.literal('int'),
    operator: z.literal(MIOT_COMPARISON_CONTRACT.int.equalityWireOperator),
    v1: z.array(SafeInteger).min(1),
  })
  .strict();
const DeviceInputEventArgIntBetween = z
  .object({
    ...DeviceInputEventArgBase,
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
const DeviceInputEventArgIntScalar = z
  .object({
    ...DeviceInputEventArgBase,
    dtype: z.literal('int'),
    operator: z.enum(MIOT_COMPARISON_CONTRACT.int.scalarWireOperators),
    v1: SafeInteger,
  })
  .strict();
const DeviceInputEventArgFloatBetween = z
  .object({
    ...DeviceInputEventArgBase,
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
const DeviceInputEventArgFloatScalar = z
  .object({
    ...DeviceInputEventArgBase,
    dtype: z.literal('float'),
    operator: z.enum(MIOT_COMPARISON_CONTRACT.float.scalarWireOperators),
    v1: FiniteNumber,
  })
  .strict();
const DeviceInputEventArgument = z.union([
  DeviceInputEventArgBare,
  DeviceInputEventArgBool,
  DeviceInputEventArgString,
  DeviceInputEventArgIntInclude,
  DeviceInputEventArgIntBetween,
  DeviceInputEventArgIntScalar,
  DeviceInputEventArgFloatBetween,
  DeviceInputEventArgFloatScalar,
]);

const DeviceInputEventProps = z
  .object({
    did: z.string(),
    siid: z.number().int(),
    eiid: z.number().int(),
    // Optional: the gateway guards event filters with `"arguments" in props`, so
    // an event trigger with no arguments (= "match any value of this event") is
    // valid; requiring them false-rejected that shape.
    arguments: z.array(DeviceInputEventArgument).optional(),
  })
  .strict()
  .superRefine((props, ctx) => {
    const seen = new Set<number>();
    for (const [index, arg] of (props.arguments ?? []).entries()) {
      if (seen.has(arg.piid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['arguments', index, 'piid'],
          message: `duplicate event argument piid ${arg.piid}`,
        });
      }
      seen.add(arg.piid);
    }
  });

export const DeviceInputProps = z.union([DeviceInputPropertyProps, DeviceInputEventProps]);
export type DeviceInputProps = z.infer<typeof DeviceInputProps>;

export const DeviceInputInputs = z.object({}).strict();
export type DeviceInputInputs = z.infer<typeof DeviceInputInputs>;

export const DeviceInputOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type DeviceInputOutputs = z.infer<typeof DeviceInputOutputs>;

export const DeviceInputNode = z
  .object({
    type: z.literal('deviceInput'),
    id: NodeId,
    cfg: DeviceInputCfg,
    inputs: DeviceInputInputs,
    outputs: DeviceInputOutputs,
    props: DeviceInputProps,
  })
  .strict();
export type DeviceInputNode = z.infer<typeof DeviceInputNode>;
