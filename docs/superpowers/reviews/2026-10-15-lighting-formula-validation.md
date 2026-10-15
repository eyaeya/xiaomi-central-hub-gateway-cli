# Offline lighting formula acceptance

Date: 2026-10-15. Scope: local implementation and packaging, no npm/GitHub
publication, no installed-global CLI/Skill replacement, no device/rule writes.

## Delivered

- Core `generateLightingFormula` and `xgg light formula` in development and Public
  trees: temperature, brightness and experimental brightness-beta; JSON,
  expression-only and pretty output; explicit-date daily preview.
- Required latitude/min/max, strict numeric/date/mode checks, Beta-specific
  controls, grammar validation, deterministic offline computation.
- Independently reconstructed source mathematics, noon fix, bounded polar
  numerical extension, shared floor semantics for formulas and previews.
- Agent recommendation and missing-parameter workflow in both Skill entrypoints,
  a dedicated reference and the packaged canonical Skill tree; documented native
  device units, range/step validation and separate rule application workflow.
- Source/discovery probes, design, ADR 0018, API guide and READMEs. Corrected the
  stale numeric-expression element-schema description in development docs.

## Checks and results

| Check | Result |
| --- | --- |
| Root `pnpm check` | Passed: 2054 unit tests; 333 contract tests passed, one existing skipped case; typecheck/lint, leak-guard tooling, fixture and probe checks passed |
| Public `pnpm check` | Passed: 772 Node tests and 392 Vitest tests; lint/build passed |
| Focused core | 61 development cases plus seven packaged suites: source vectors, original branches away from noon, independent expression evaluation, preview equality, seasonal/southern/polar cases, Beta controls and invalid input |
| Offline CLI | JSON/text/help/errors pass with fetch/HTTP/HTTPS/TCP trapped and automatic update enabled; updater allowlist excludes light commands |
| Independent implementation review | No blocking product defect found; targeted root tests 180/180 passed |
| Skill validation | Both quick validators and relative-link checks passed; canonical/package digest and bytes match |
| Skill forward scenarios | Simple light-on request avoided formula workflow; compute-only request ran without device/auth access; a step-100 K device request identified missing preferred range and quantization needs |
| `pnpm pack:release` | Core and CLI tarballs produced; both installed in an isolated ignored workspace |
| Installed package smoke | Version/help, all three calculators, 48-sample previews, expression-only equality, existing expr-check and Core SDK passed |
| Tarball contents | Lighting implementation and full Skill included; docs, probes, snapshots, fixtures and official frontend reference excluded |
| Diff and leakage | Diff whitespace checks and changed-file leak scans passed; commits retain the normal leak-guard hook |

The first Public full check caught the newly added reference missing from the
audited Skill file list. The list was updated; provenance wording in the caller
reference was simplified to satisfy its existing self-containment rule. The
focused check and entire Public check subsequently passed; no gate was disabled.

Installed smoke parameters: latitude 23.129; temperature 3200–5400 K; brightness
and Beta 10–100 percent; date 2026-10-15; default 30-minute preview spacing.
Noon results were 5375 K, 99 percent and 99 percent respectively. All preview
samples matched the generated expression. The explicit Core SDK import also
returned the expected brightness value.

Canonical Skill content digest:
`sha256-8db9ac0ed0fb4548373e727f438b0e723aa38aa7e1a5f3f64173cf3606d3bffd`.
Package version remains 3.1.0 solely because this is an unpublished source
change; these local tarballs are acceptance artifacts, not the public 3.1.0
release. The README and Skill identify the source-only availability.

## Evidence boundary

The gateway probe read existing rules and two device specs without mutation.
It establishes the integration surface, not execution of these formulas.
Local tests do not establish physical dimming, target gateway timing/timezone,
or accurate astronomical sunrise/sunset. Polar extension and Beta midnight
discontinuities remain explicitly documented. No live formula, temporary rule,
variable or light-state change was created, so no physical restoration was needed.
Private probe/session and install evidence remain in ignored `.xgg-local/`.
