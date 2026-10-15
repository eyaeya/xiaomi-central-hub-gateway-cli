# Unified lighting calculator and v3.2.0 release

Date: 2026-10-15. User approved consolidating brightness modes and publishing.
This supersedes the interface/model/release-scope portions of the earlier
lighting-formula design; source audit observations remain historical facts.

## Interface and math

- Keep exactly two public modes: `temperature` and `brightness`.
- Standard brightness is the baseline: k=4.5/M. Brightness supports one
  dimensionless `speed` factor: k=4.5*speed/M, default 1, range [0.1,20].
  Smaller means gentler transitions; larger means steeper transitions. It is
  not a duration, loop interval or independent smoothing parameter.
- Brightness also accepts offsetMinutes [-180,180] (default 0, positive moves
  earlier) and invert (default false). Retain documented non-wrapping offset
  and polar numerical-extension boundaries. Temperature remains unchanged and
  rejects explicitly supplied brightness-only controls.
- Remove the unpublished brightness-beta mode, smoothness option and the
  M^0.7 slope model entirely from the runtime API. Reject obsolete inputs with
  actionable ConfigError rather than silently interpreting them differently.
- CLI flags: --speed, --offset-minutes, --invert on brightness only. JSON
  brightness parameters include normalized defaults; temperature parameters
  contain only latitude/min/max. Other preview/output/validation contracts
  remain unchanged. Core and preview must share the new mathematical model.
- Defaults must reproduce the previous standard brightness values, including
  noon correction. Verify changed speed behavior, offset, inversion and all
  established numerical/date/input boundaries. Keep offline/update exclusion.

## Agent and documentation

Offer temperature or brightness based on user intent, never ask standard vs
Beta. Use speed=1 unless the user requests gentler/steeper transitions; ask
about offset/inversion only when needed. Examples may explain 0.5 as gentler
and 2 as steeper, without inventing a duration interpretation or overpromising
physical device behavior. Update canonical/development/package Skill, READMEs,
API guide, AGENTS examples and ADR. Keep prior probe/acceptance records clearly
historical instead of rewriting previous results. No new runtime dependency.

## Release

Public workspace root/Core/CLI versions and Skill version are 3.2.0. Development
workspace stays private @xgg/* version 0.0.0 per existing workspace convention.
Use Public/xgg for GitHub PR/merge/tag/release and npm publication through the
existing verified release workflow. The user authorized publication; no extra
confirmation is required. Do not alter physical lights or production rules.

Before release: baseline and read-only discovery, root/Public full checks,
independent review, source/packaged Skill sync, tarball allow-list and isolated
install/SDK/CLI smoke, leak guard and commits. After release: verify merged PR,
tag/release/Actions, official registry latest for both packages, matching CLI
Core dependency, complete packument README byte equality with tarball README,
and real-browser default npm page version/README. Report CDN lag separately.
Update the existing local npm-global CLI to the published version and explicitly
sync its verified Skill to the existing shared Agent installation while
preserving unrelated customization; verify both through readback.
