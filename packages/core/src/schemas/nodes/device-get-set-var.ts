import { z } from 'zod';
import { Connection, NodeId, Position } from './common.js';

// Fields derived from fixtures/responses/nodes/deviceGetSetVar/*.json.
// Strict-where-known per M6 design: cfg/inputs/outputs key sets locked;
// props left strict but value-typed; port values left unknown (phase C will
// tighten after blind probe surfaces connected-port shape).

export const DeviceGetSetVarCfg = z
  .object({
    urn: z.string(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type DeviceGetSetVarCfg = z.infer<typeof DeviceGetSetVarCfg>;

// F22g (2026-05-28 frontend-validator audit): gateway-side
// `Pr.deviceGetSetVar` constrains dtype to `{number, boolean, string}`.
// Unlike deviceInputSetVar, this type has no event-mode (eiid) branch —
// gateway-Pr explicitly throws "Not a property" if piid is missing.
export const DeviceGetSetVarProps = z
  .object({
    did: z.string(),
    siid: z.number(),
    piid: z.number(),
    dtype: z.enum(['number', 'boolean', 'string']),
    scope: z.string(),
    id: z.string(),
    preload: z.boolean().optional(),
  })
  .strict();
export type DeviceGetSetVarProps = z.infer<typeof DeviceGetSetVarProps>;

export const DeviceGetSetVarInputs = z
  .object({
    input: z.null(),
  })
  .strict();
export type DeviceGetSetVarInputs = z.infer<typeof DeviceGetSetVarInputs>;

export const DeviceGetSetVarOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type DeviceGetSetVarOutputs = z.infer<typeof DeviceGetSetVarOutputs>;

export const DeviceGetSetVarNode = z
  .object({
    type: z.literal('deviceGetSetVar'),
    id: NodeId,
    cfg: DeviceGetSetVarCfg,
    inputs: DeviceGetSetVarInputs,
    outputs: DeviceGetSetVarOutputs,
    props: DeviceGetSetVarProps,
  })
  .strict();
export type DeviceGetSetVarNode = z.infer<typeof DeviceGetSetVarNode>;
