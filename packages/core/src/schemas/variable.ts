import { z } from 'zod';

export const VarScopeListResponse = z.object({
  scopes: z.array(z.string()),
});
export type VarScopeListResponse = z.infer<typeof VarScopeListResponse>;

// F66-VarEntry-strict (2026-05-31) — read-side schema. Bundle ground
// truth (ai-config-v5.28b650.js):
//   - The UI maps listVar via `Object.keys(e).map(n => ({...e[n], scope,
//     id})).filter(e => wa(e.type))` where `wa(e) =
//     [Ea.string, Ea.number].includes(e)` (strict {number|string} only).
//     Boolean / other types are silently dropped by the UI.
//   - The UI never creates a variable without `userData:{name: a.trim()}`,
//     so listVar entries always carry that key on the read side.
//   - createVar / setVarValue gateway-side enforce typeof value ∈
//     {number, string} (gateway.6cbc85.js).
// Pre-F66 VariableConfig was `z.record(z.unknown())` — completely
// untyped. Tighten to a strict VarEntry that mirrors the UI's filter
// shape so resource readers get a typed return and ill-formed gateway
// responses surface as SchemaError instead of silent `unknown` leaks
// (xgg memory: `feedback-gate-on-agent-funnel-paths` — fail loud on
// the read path too).
export const VarEntry = z
  .object({
    type: z.enum(['number', 'string']),
    value: z
      .union([z.number(), z.string()])
      .refine((v) => typeof v !== 'number' || !Number.isNaN(v), 'value must not be NaN'),
    userData: z
      .object({
        name: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
export type VarEntry = z.infer<typeof VarEntry>;

export const VarListResponse = z.record(VarEntry);
export type VarListResponse = z.infer<typeof VarListResponse>;

// F66-VarEntry-strict + F66h fix (2026-05-31 live-probe): /api/getVarConfig
// returns ONLY `{type, userData}` — NOT a full VarEntry. The F66-VarEntry-
// strict draft assumed it returned a listVar-shaped entry (same as
// /api/getVarList[<id>]) but a live probe (xgg api /api/getVarConfig
// --params '{"scope":"global","id":"probetype"}') confirmed value is
// absent. The UI splits the two endpoints by design: getVarConfig =
// "metadata" (immutable for the var lifetime), getVarValue = "current
// reading". Mirror that split here.
export const VarConfigResponse = z
  .object({
    type: z.enum(['number', 'string']),
    userData: z
      .object({
        name: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
export type VarConfigResponse = z.infer<typeof VarConfigResponse>;

// F66-VarEntry-strict: /api/getVarValue returns `{value: number|string}`.
// NaN rejected for the same reason as setVarValue (gateway: "Invalid
// number").
export const VarValueResponse = z
  .object({
    value: z
      .union([z.number(), z.string()])
      .refine((v) => typeof v !== 'number' || !Number.isNaN(v), 'value must not be NaN'),
  })
  .passthrough();
export type VarValueResponse = z.infer<typeof VarValueResponse>;

// F66-VarUserData-relax (2026-05-31) — bundle ground truth:
//   - UI Da.createVar / Da.setVarConfig payloads only contain
//     `userData: {name: a.trim()}` (ai-config-v5.28b650.js — search
//     `va.createVar({}` and `setVarConfig({scope:t,id:n,userData:{name`).
//     Neither `lastUpdateTime` nor `version` is sent by the UI; both were
//     gateway-side ghost constraints xgg invented in M3.
//   - Gateway qr.createVar requires nothing of userData; qr.setVarConfig
//     only requires `userData !== undefined` (gateway.6cbc85.js:
//     `if (void 0 === e.userData) throw "No change provided"`).
//   - UI-side non-empty constraint: ai-config createVar wrapper does
//     `if (a.trim().length < 1) throw "变量名称不能为空"`.
// Net: relax to `{name}.passthrough()` with name required + non-empty
// (after .trim()). Extra fields tolerated for forward-compat.
const VarUserData = z
  .object({
    name: z
      .string()
      .refine((s) => s.trim().length >= 1, 'name must be non-empty (UI: "变量名称不能为空")'),
  })
  .passthrough();

// F58 (2026-05-30) — bundle ground truth:
//   - createVar wrapper:    `if (!["number","string"].includes(e.type)) throw "Invalid params.type"`
//                           followed by `if (e.type === "number" && "number" !== typeof e.value) throw...`
//   - setVarValue handler:  `if (!["number","string"].includes(typeof e.value)) throw "Invalid value type"`
//                           AND `if ("number" === typeof e.value && Number.isNaN(e.value)) throw "Invalid number"`
// VarScalar matches the typeof check; the per-request `type` cross-field
// constraint is asserted via .superRefine on VariableCreateRequest below.
// Reject NaN at the union level so the same shape works for both write
// paths (only setVarValue strictly checks it, but a NaN createVar value
// is also nonsensical).
const VarScalar = z
  .union([z.number(), z.string()])
  .refine((v) => typeof v !== 'number' || !Number.isNaN(v), {
    message: 'value must not be NaN (gateway setVarValue rejects with "Invalid number")',
  });

// F65b (2026-05-30) — both `scope` and `id` are constrained to non-empty
// alphanumeric (A-Za-z0-9). Live gateway rejects underscore / hyphen /
// dot / whitespace / unicode at the createVar entry point with
// `"Invalid id format"`; same constraint applies to scope per the
// gateway hint phrasing surfaced on the createVar error. Pre-flight
// rejection avoids the WS round-trip and gives a clearer error before
// any side-effect runs (matches feedback-gate-on-agent-funnel-paths —
// validation goes on the agent funnel write path).
//
// F63h compatibility: ensureScopeBootstrapped uses the ids
// `xggGlobalInit` / `xggRuleInit` and the scopes `global` / `R<digits>`
// (e.g. `R123`); all four are pure alphanumeric and pass this regex
// (regression test covers them).
const ALNUM_RE = /^[A-Za-z0-9]+$/;
const VarScopeName = z
  .string()
  .regex(
    ALNUM_RE,
    'scope must be alphanumeric (A-Za-z0-9 only, non-empty — gateway rejects hyphen/underscore/dot/whitespace with "Invalid id format")',
  );
export function isValidVariableScopeName(scope: string): boolean {
  return VarScopeName.safeParse(scope).success;
}

const VarId = z
  .string()
  .regex(
    ALNUM_RE,
    'id must be alphanumeric (A-Za-z0-9 only, non-empty — gateway rejects hyphen/underscore/dot/whitespace with "Invalid id format")',
  );

export const VariableCreateRequest = z
  .object({
    scope: VarScopeName,
    id: VarId,
    type: z.enum(['number', 'string']),
    value: VarScalar,
    userData: VarUserData,
  })
  .passthrough()
  .superRefine((req, ctx) => {
    // Bundle cross-field check: typeof value must agree with declared type.
    if (req.type === 'number' && typeof req.value !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'value must be a number when type === "number"',
      });
    }
    if (req.type === 'string' && typeof req.value !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'value must be a string when type === "string"',
      });
    }
  });
export type VariableCreateRequest = z.infer<typeof VariableCreateRequest>;

export const VariableDeleteRequest = z.union([
  z.object({ scope: VarScopeName, id: VarId }).passthrough(),
  z.object({ scope: VarScopeName, all: z.literal(true) }).passthrough(),
]);
export type VariableDeleteRequest = z.infer<typeof VariableDeleteRequest>;

export const VariableSetConfigRequest = z
  .object({
    scope: VarScopeName,
    id: VarId,
    userData: VarUserData,
  })
  .passthrough();
export type VariableSetConfigRequest = z.infer<typeof VariableSetConfigRequest>;

export const VariableSetValueRequest = z
  .object({
    scope: VarScopeName,
    id: VarId,
    value: VarScalar,
  })
  .passthrough();
export type VariableSetValueRequest = z.infer<typeof VariableSetValueRequest>;
