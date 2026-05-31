import { z } from 'zod';

export const MiotPropertyAccessSchema = z.enum(['read', 'write', 'notify']);

// URN namespace regex — accepts both `miot-spec-v2` and vendor-extended
// namespaces (e.g. `linp-spec`, `izq-spec`) observed in real-gateway specs.
// F10 fix: third-party brands embed vendor service/property URNs alongside
// standard miot-spec-v2 ones; the schema must accept them.
const URN_NS = '(miot-spec-v2|[a-z][a-z0-9-]*-spec)';

export const MiotPropertySchema = z
  .object({
    iid: z.number().int().positive(),
    type: z.string().regex(new RegExp(`^urn:${URN_NS}:property:`)),
    description: z.string(),
    format: z.enum([
      'bool',
      'uint8',
      'uint16',
      'uint32',
      'int8',
      'int16',
      'int32',
      'int64',
      'float',
      'string',
    ]),
    // F10 fix: BLE/vendor devices use `access: []` + a sibling `gatt-access`
    // field. The empty array still satisfies the contract that `access` is
    // present-and-of-the-right-type, just empty.
    access: z.array(MiotPropertyAccessSchema),
    unit: z.string().optional(),
    'value-range': z.tuple([z.number(), z.number(), z.number()]).optional(),
    'value-list': z.array(z.object({ value: z.number(), description: z.string() })).optional(),
  })
  .passthrough();

export const MiotActionSchema = z
  .object({
    iid: z.number().int().positive(),
    type: z.string().regex(new RegExp(`^urn:${URN_NS}:action:`)),
    description: z.string(),
    in: z.array(z.number().int()),
    out: z.array(z.number().int()),
  })
  .passthrough();

export const MiotEventSchema = z
  .object({
    iid: z.number().int().positive(),
    type: z.string().regex(new RegExp(`^urn:${URN_NS}:event:`)),
    description: z.string(),
    arguments: z.array(z.number().int()).optional(),
  })
  .passthrough();

export const MiotServiceSchema = z
  .object({
    iid: z.number().int().positive(),
    type: z.string().regex(new RegExp(`^urn:${URN_NS}:service:`)),
    description: z.string(),
    properties: z.array(MiotPropertySchema).optional(),
    actions: z.array(MiotActionSchema).optional(),
    events: z.array(MiotEventSchema).optional(),
  })
  .passthrough();

export const DeviceSpecSchema = z
  .object({
    type: z.string().regex(new RegExp(`^urn:${URN_NS}:device:`)),
    description: z.string(),
    services: z.array(MiotServiceSchema).min(1),
  })
  .passthrough();

export type DeviceSpec = z.infer<typeof DeviceSpecSchema>;
export type MiotService = z.infer<typeof MiotServiceSchema>;
export type MiotProperty = z.infer<typeof MiotPropertySchema>;
export type MiotAction = z.infer<typeof MiotActionSchema>;
export type MiotEvent = z.infer<typeof MiotEventSchema>;
