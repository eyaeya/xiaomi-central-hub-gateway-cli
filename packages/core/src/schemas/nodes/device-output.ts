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
const DeviceOutputVariableRef = z
  .object({
    id: z.string(),
    scope: z.string(),
    dtype: DeviceOutputVariableDtype,
  })
  .strict();

// F22c (2026-05-28 frontend-validator audit): gateway-side `Pr.deviceOutput`
// accepts any literal value type for action `ins[i].value` (it only checks
// existence). The UI form-renderer types the value per MIoT action input
// format (string/int/float/bool), so action wire shapes with numeric or
// boolean ins[i].value are normal. Prior `z.string()` silently fell to
// UnknownNode for these — same bug class as F12 (property-write boolean).
const DeviceOutputActionInputLiteral = z
  .object({
    piid: z.number(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();

const DeviceOutputActionInputVariable = DeviceOutputVariableRef.extend({
  piid: z.number(),
}).strict();

const DeviceOutputPropertyWriteLiteralProps = z
  .object({
    did: z.string(),
    siid: z.number(),
    piid: z.number(),
    // Two valid encodings for bool: integer 0/1 (CLI's coerceValueForFormat
    // emits this; M7 F16 finding) AND real JSON boolean true/false
    // (F12 — what the web UI emits when the user picks 开启/关闭 from
    // the dropdown). Both round-trip on the gateway; either may appear
    // in a UI-saved rule that the CLI later reads. Accept all three.
    value: z.union([z.number(), z.string(), z.boolean()]),
  })
  .strict();

const DeviceOutputPropertyWriteVariableProps = DeviceOutputVariableRef.extend({
  did: z.string(),
  siid: z.number(),
  piid: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
}).strict();

// Gateway accepts two deviceOutput shapes (confirmed in real-rule snapshots):
//   1. action-invoke:  {did, siid, aiid, ins[]}   (e.g. play-text, toggle)
//   2. property-write: {did, siid, piid, value}   (e.g. light.on, plug.on)
// F16: property-write shape is required for devices that expose only writable
// properties and no actions (light/AC/purifier covers most home devices).
export const DeviceOutputActionProps = z
  .object({
    did: z.string(),
    siid: z.number(),
    aiid: z.number(),
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
