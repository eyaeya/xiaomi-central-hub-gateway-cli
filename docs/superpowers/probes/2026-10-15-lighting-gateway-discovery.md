# Lighting formula integration: gateway discovery

Date: 2026-10-15. Scope: bounded, read-only prerequisite probe before implementing
an offline formula calculator. This probe did not create, change, enable,
disable, trigger, or delete any rule, variable, or device state.

Private command output and session metadata are retained only in the ignored
`.xgg-local/lighting-probe/` directory. No gateway address, device ID, household
name, login code, or credential is included here.

## Findings

| Finding | Observed behavior | Cause / interpretation | CLI impact | Decision lane |
|---|---|---|---|---|
| Live connection | The prior session returned exit 3. Explicit cloud gateway login succeeded; the returned status command confirmed a live daemon. | An expired gateway session is independent of still-valid cloud authorization. | Offline calculation must not require either form of authorization. | Reuse the private live session for this probe only; keep the calculator pure. |
| Existing numeric expression wire | Eight existing rules were read with `rule view`; thirteen `varSetNumber` nodes use `props: {scope, id, elements}` and ordered `const` / `var` fragments. A current example is a variable reference followed by the constant fragment ` + 1`. | The gateway already has a numeric expression card and the CLI already models its wire format. | Formula results can be supplied to existing expression authoring; no new RPC or node type is needed. | Reuse the current expression grammar and shortcut; do not invent a new card or mutate a live rule as a calculator side effect. |
| Documentation drift | `docs/api/nodes.md` still describes `elements` as `z.array(z.unknown())`; `schemas/nodes/var-set-number.ts` and `common.ts` strictly parse the `const` / `var` discriminated union. Current live nodes match that strict union. | The prose predates the F43 schema tightening. | Generated integration payloads must use the strict fragment shape. | Correct the prose alongside the calculator documentation; no schema expansion is required. |
| Available expression vocabulary | The existing frontend-derived probe and `usecases/var-expr-check.ts` list `cos`, `sin`, `pow`, `round`, `floor`, `ceil`, `min`, `max`, `hours`, `minutes`, and `seconds`. | Function names and argument counts belong to the gateway expression grammar, rather than JavaScript syntax. | Generated formulas must pass the existing grammar checker; use functions such as `pow(a,b)` instead of assuming arbitrary JavaScript is accepted. | Validate generated expressions locally. A successful static grammar check does not prove execution timing or device behavior. |
| Lighting properties differ | Current `device spec` reads show `philips.light.mono1` brightness is `uint8`, read/write, range `[1,100,1]`; `yeelink.light.lamp22` brightness is `uint8`, read/write/notify, range `[1,100,1]`, and color temperature is `uint32`, read/write/notify, range `[2700,6500,1]`. The Philips spec has no color-temperature property. | Device capabilities, notification support, units, and bounds depend on the selected target. | Do not assume every light supports color temperature, or that a calculator range equals the target property's range. In particular, a computed brightness of zero is outside these two brightness specs. | Inspect the selected target spec before applying any result; use range-aware validation and an explicit off branch if zero is meant to turn a light off. The calculator itself remains offline. |

## Evidence and limits

- Current read path: explicit cloud bootstrap → returned status command →
  `rule list`, `rule view`, `device list`, and two `device spec` reads, all with
  the same private session and returned base URL. All eight rule views and
  both device specs parsed successfully.
- Existing expression documentation:
  `docs/superpowers/probes/2026-05-28-varsetnumber-ui-dropdowns.md` records the
  official frontend function dropdown; this is historical grammar evidence,
  not a fresh runtime proof of every function.
- Current source contracts: `packages/core/src/schemas/nodes/var-set-number.ts`,
  `packages/core/src/schemas/nodes/common.ts`, and
  `packages/core/src/usecases/var-expr-check.ts`.
- This probe establishes live read compatibility and the existing integration
  surface. It does not execute the new formulas, verify clock/timezone behavior,
  prove periodic reevaluation, or demonstrate physical dimming. Those claims
  require a separately authorized runtime workflow with logs and readback.
