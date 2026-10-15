# Lighting brightness unification discovery

Date: 2026-10-15. Follow-up scope: simplify the local brightness interface before
publication. The user approved one brightness mode and publication. This probe
precedes implementation; it changes no device, rule, or variable state.

## Findings and decisions

| Finding | Observed behavior | Cause / interpretation | CLI impact | Decision lane |
|---|---|---|---|---|
| Expression surface is unchanged | One existing rule was read successfully through the same private live daemon. Its numeric assignment still has `props: {scope, id, elements}` and ordered `const` / `var` fragments. | This is an offline mathematical and interface change, not a gateway protocol change. | Keep the existing grammar checker and expression integration. | No new RPC, card, schema expansion, or live rule write. |
| Standard and Beta defaults differ | For latitude `23.129`, range `10..100`, preview date `2026-10-15`, standard brightness gives 45 at 06:00 and 89 at 09:00; Beta defaults give 43 and 92. | Standard uses `k=4.5/M`; Beta uses `k=speed*smoothness/pow(M,0.7)`. The two defaults are distinct curves. | Consolidation needs an explicit baseline; it must not silently replace the standard default with Beta. | Retain the standard formula as the default brightness behavior. |
| Two old shape controls are redundant | In both the generated expression and preview implementation, Beta speed and smoothness appear only through their product. | Equal products give the same slope for a fixed date and latitude; there is no independent smoothing mechanism. | Separate speed and smoothness settings obscure what changes. | Remove smoothness and the separate `brightness-beta` mode. Expose a single dimensionless `--speed` multiplier on `brightness`, default `1`, range `[0.1,20]`. |
| Old exponent changes normalization | Beta divides its product by `M^0.7`; standard divides by `M`. | The multiplier relating Beta to standard varies with the date/latitude-dependent denominator. | Retaining exponent `0.7` would prevent a simple stable interpretation of speed relative to the standard curve. | Remove Beta exponent `0.7`. Unified brightness uses `k=4.5*speed/M`, where `M=max(1,min(H,43200-H))`. |
| Offset and inversion remain useful | Existing Beta time is `clockSeconds-43200+offsetMinutes*60`; inversion changes day weight `S` to `1-S`. | These affect timing and direction independently of transition speed. | Preserve the useful controls under the single brightness mode. | Brightness accepts `--offset-minutes` in `[-180,180]`, default `0`, and `--invert`, default false. Positive offset advances the curve; it does not wrap across midnight. |
| Temperature has a separate stable contract | Temperature currently uses standard `k=4.5/M` and rejects the brightness controls. | No temperature change was requested by consolidation. | Preserve temperature expressions, preview behavior, and option rejection. | Temperature remains unchanged; speed, offset, and invert are brightness-only. |

## Recorded offline baseline

Both source CLI commands exited zero before implementation:

```bash
pnpm --filter @xgg/cli exec tsx src/cli.ts light formula brightness \
  --latitude 23.129 --min 10 --max 100 --date 2026-10-15 --sample-minutes 60
pnpm --filter @xgg/cli exec tsx src/cli.ts light formula brightness-beta \
  --latitude 23.129 --min 10 --max 100 --date 2026-10-15 --sample-minutes 60
```

| Clock time | Standard brightness | Beta defaults (`speed=0.3`, `smoothness=0.9`) |
|---|---:|---:|
| 00:00 | 10 | 10 |
| 06:00 | 45 | 43 |
| 09:00 | 89 | 92 |
| 12:00 | 99 | 99 |
| 15:00 | 89 | 92 |
| 18:00 | 45 | 43 |
| 23:00 | 10 | 10 |

Normalized standard parameters were only latitude/min/max. Beta additionally
reported speed `0.3`, smoothness `0.9`, offsetMinutes `0`, and invert `false`.
The floor-based noon result of 99 is intentional existing behavior and must not
be changed merely to make the curve reach the requested maximum exactly.

## Evidence boundaries

- The existing live session was reused; no login restart was needed. The
  `rule view` returned exit zero and passed current parsing.
- Private output remains in ignored `.xgg-local/lighting-probe/` files with the
  `unification-` prefix. No address, device ID, household name, credential, or
  login code is included in this report.
- Source comparison: `packages/core/src/usecases/lighting-formula.ts` and
  `packages/cli/src/commands/light.ts`; prior contracts are recorded in
  `docs/api/lighting.md`, the lighting design, and ADR 0018. These documents
  require synchronization with the newly approved consolidated interface.
- This probe establishes the current baseline and unchanged gateway wire
  compatibility. It does not execute the generated formula on the gateway,
  verify periodic timing, or claim physical lamp behavior.
