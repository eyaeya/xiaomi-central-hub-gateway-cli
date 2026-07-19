import { z } from 'zod';
import { Connection, NodeId, Position, SimplifiableCfgFields } from './common.js';

// Fields derived from fixtures/responses/nodes/deviceInputSetVar/*.json.
// Strict-where-known per M6 design: cfg/inputs/outputs key sets locked;
// props left strict but value-typed; port values left unknown (phase C will
// tighten after blind probe surfaces connected-port shape).

export const DeviceInputSetVarCfg = z
  .object({
    ...SimplifiableCfgFields,
    urn: z.string(),
    pos: Position,
    name: z.string(),
    version: z.number(),
  })
  .strict();
export type DeviceInputSetVarCfg = z.infer<typeof DeviceInputSetVarCfg>;

// F22g (2026-05-28 frontend-validator audit): gateway-side `Pr.deviceInputSetVar`
// accepts `dtype ∈ {number, boolean, string}` only. Tighten from prior
// `z.string()`. The UI's nodeCheckTool further restricts this to the value
// `ka(propFormat)` returns (bool MIoT → "number" per F19), but the schema
// stays at the gateway-side vocab to allow `--no-validate` raw probes.
const SetVarDtype = z.enum(['number', 'boolean', 'string']);

// Property-mode setVar: when a property's value crosses a notify threshold,
// copy the value into a gateway variable. Same shape as the F19 c-shortcut
// already emits.
const DeviceInputSetVarPropertyProps = z
  .object({
    did: z.string(),
    siid: z.number().int(),
    piid: z.number().int(),
    dtype: SetVarDtype,
    scope: z.string(),
    id: z.string(),
    preload: z.boolean().optional(),
  })
  .strict();

// F22d (2026-05-28 frontend-validator audit): event-mode setVar — when an
// MIoT event arrives (e.g. BLE button click), copy each event-argument into
// a gateway variable. Gateway-side check requires `eiid` integer and an
// `arguments` array of {piid, dtype} with optional `scope`/`id` per item.
// F61 (2026-05-30 user-physical-test): `arguments` must be non-empty.
//   - Bundle `Pr.deviceInputSetVar.checkWebNode` (server-side) does accept
//     empty arrays — that was the F22d-era basis for the old "0-arg is
//     legal" comment, which was wrong on the UI/semantic axis.
//   - Bundle `ai-config-v5` (the renderer for this card type — class `Bs`
//     in the minified source) defines:
//       getAvailableSpecs(e) = e.filter(s =>
//         !isNumber(s.eiid) || s.arguments?.length > 0
//       )
//     and feeds `getAvailableSpecs([].concat(i.event, i.propertyNotify))`
//     into the service dropdown. Every spec event whose own
//     `arguments.length === 0` is dropped from the choice list, so a
//     persisted node pointing at such an eiid resolves to the
//     `"原已选功能丢失"` (`data-loss`) sentinel in the UI.
//   - Semantically the node copies event-args into vars — a 0-arg event
//     has nothing to copy, so accepting `arguments:[]` lets an agent
//     produce a no-op node that the UI can't even re-edit.
// Net: `arguments` carries at least one capture. Property-mode is the
// right form for a "device → variable" wire that doesn't need an event.
// The gateway event-arg check is `if ("scope" in t) { id must be string }`,
// so a `scope` without an `id` is rejected ("Invalid var id"). The reverse
// (id without scope) and a bare {piid,dtype} capture are NOT rejected, so we
// only enforce the scope→id direction (no stricter than the gateway).
const DeviceInputSetVarArgument = z
  .object({
    piid: z.number().int(),
    dtype: SetVarDtype,
    scope: z.string().optional(),
    id: z.string().optional(),
  })
  .strict()
  .refine((a) => a.scope === undefined || typeof a.id === 'string', {
    message: 'event arg with a scope must also carry id (gateway: "Invalid var id")',
    path: ['id'],
  });

const DeviceInputSetVarEventProps = z
  .object({
    did: z.string(),
    siid: z.number().int(),
    eiid: z.number().int(),
    arguments: z.array(DeviceInputSetVarArgument).min(1, {
      message:
        'event-mode deviceInputSetVar requires at least one argument capture; UI drops 0-arg events from the spec list (renders as "原已选功能丢失")',
    }),
  })
  .strict();

export const DeviceInputSetVarProps = z.union([
  DeviceInputSetVarPropertyProps,
  DeviceInputSetVarEventProps,
]);
export type DeviceInputSetVarProps = z.infer<typeof DeviceInputSetVarProps>;

export const DeviceInputSetVarInputs = z.object({}).strict();
export type DeviceInputSetVarInputs = z.infer<typeof DeviceInputSetVarInputs>;

export const DeviceInputSetVarOutputs = z
  .object({
    output: z.array(Connection),
  })
  .strict();
export type DeviceInputSetVarOutputs = z.infer<typeof DeviceInputSetVarOutputs>;

export const DeviceInputSetVarNode = z
  .object({
    type: z.literal('deviceInputSetVar'),
    id: NodeId,
    cfg: DeviceInputSetVarCfg,
    inputs: DeviceInputSetVarInputs,
    outputs: DeviceInputSetVarOutputs,
    props: DeviceInputSetVarProps,
  })
  .strict();
export type DeviceInputSetVarNode = z.infer<typeof DeviceInputSetVarNode>;
