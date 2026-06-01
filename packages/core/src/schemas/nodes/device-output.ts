import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

export const DeviceOutputCfg = z
  .object({
    urn: z.string(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type DeviceOutputCfg = z.infer<typeof DeviceOutputCfg>;

const DeviceOutputVariableDtype = z.enum(['number', 'string', 'boolean']);

// The gateway requires numeric min/max/step on a variable ref **iff
// dtype === 'number'** (a number var write without them is rejected with
// "Invalid max"); boolean/string carry none. The earlier schema marked
// min/max/step `.optional()` (too lenient) and omitted them entirely from the
// action-ins variable (`.strict()` then rejected the legitimate gateway shape
// `{piid,scope,id,dtype:'number',min,max,step}`, dropping the whole node to
// UnknownNode). Optional fields + a dtype-conditional refine capture both.
const numberDtypeRequiresRange = (v: {
  dtype: string;
  min?: unknown;
  max?: unknown;
  step?: unknown;
}): boolean =>
  v.dtype !== 'number' ||
  (typeof v.min === 'number' && typeof v.max === 'number' && typeof v.step === 'number');
const NUMBER_RANGE_REFINE = {
  message:
    'number-dtype variable requires numeric min/max/step (the gateway rejects otherwise with "Invalid max/min/step")',
};

// gateway-side `Pr.deviceOutput` accepts any literal value type for action
// `ins[i].value` (it only checks existence). The UI form-renderer types the
// value per MIoT action input format (string/int/float/bool), so action wire
// shapes with numeric or boolean ins[i].value are normal.
const DeviceOutputActionInputLiteral = z
  .object({
    piid: z.number().int(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();

const DeviceOutputActionInputVariable = z
  .object({
    piid: z.number().int(),
    id: z.string(),
    scope: z.string(),
    dtype: DeviceOutputVariableDtype,
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
  })
  .strict()
  .refine(numberDtypeRequiresRange, NUMBER_RANGE_REFINE);

const DeviceOutputPropertyWriteLiteralProps = z
  .object({
    did: z.string(),
    siid: z.number().int(),
    piid: z.number().int(),
    // Two valid encodings for bool: integer 0/1 AND real JSON boolean true/false
    // (what the web UI emits when the user picks 开启/关闭). Both round-trip on
    // the gateway; either may appear in a UI-saved rule the CLI later reads.
    value: z.union([z.number(), z.string(), z.boolean()]),
  })
  .strict();

const DeviceOutputPropertyWriteVariableProps = z
  .object({
    did: z.string(),
    siid: z.number().int(),
    piid: z.number().int(),
    id: z.string(),
    scope: z.string(),
    dtype: DeviceOutputVariableDtype,
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
  })
  .strict()
  .refine(numberDtypeRequiresRange, NUMBER_RANGE_REFINE);

// Gateway accepts two deviceOutput shapes (confirmed in real-rule snapshots):
//   1. action-invoke:  {did, siid, aiid, ins[]}   (e.g. play-text, toggle)
//   2. property-write: {did, siid, piid, value}   (e.g. light.on, plug.on)
// property-write shape is required for devices that expose only writable
// properties and no actions (light/AC/purifier covers most home devices).
export const DeviceOutputActionProps = z
  .object({
    did: z.string(),
    siid: z.number().int(),
    aiid: z.number().int(),
    ins: z.array(z.union([DeviceOutputActionInputLiteral, DeviceOutputActionInputVariable])),
  })
  .strict();
export type DeviceOutputActionProps = z.infer<typeof DeviceOutputActionProps>;

export const DeviceOutputPropertyWriteProps = z.union([
  DeviceOutputPropertyWriteLiteralProps,
  DeviceOutputPropertyWriteVariableProps,
]);
export type DeviceOutputPropertyWriteProps = z.infer<typeof DeviceOutputPropertyWriteProps>;

export const DeviceOutputProps = z.union([DeviceOutputActionProps, DeviceOutputPropertyWriteProps]);
export type DeviceOutputProps = z.infer<typeof DeviceOutputProps>;

export const DeviceOutputInputs = z
  .object({
    trigger: z.null(),
  })
  .strict();
export type DeviceOutputInputs = z.infer<typeof DeviceOutputInputs>;

export const DeviceOutputOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type DeviceOutputOutputs = z.infer<typeof DeviceOutputOutputs>;

export const DeviceOutputNode = z
  .object({
    type: z.literal('deviceOutput'),
    id: NodeId,
    cfg: DeviceOutputCfg,
    inputs: DeviceOutputInputs,
    outputs: DeviceOutputOutputs,
    props: DeviceOutputProps,
  })
  .strict();
export type DeviceOutputNode = z.infer<typeof DeviceOutputNode>;
