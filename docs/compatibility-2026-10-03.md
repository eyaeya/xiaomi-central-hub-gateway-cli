# 2026-10-03 compatibility review

The CLI remains compatible with the tested gateway's current Geek Edition interface for the operations below. This is a result for one live gateway, not a claim that every latest or staged firmware release is supported. Its complete device firmware and central-software version could not be retrieved or confirmed.

The served official editor is v1.6.1, with HTML build tag `2026-04-08 14:16:59`. Its EC-JPAKE handshake, encrypted WebSocket framing and exposed API names match the project's modeled interface. Editor metadata is not a firmware version.

## Live evidence

- Login, inventory, all six rule reads and official-format local backup succeeded.
- All six existing rules passed spec-aware validation with zero errors and strict export. Five were warning-free. One disabled legacy graph had 76 node/edge ID compatibility warnings; identifiers were preserved and its state was not changed.
- Strict topology/reachability lint had the same warning boundary and no errors.
- A temporary rule used `onLoad -> varGet` to select between two string-variable writes. With input 0, readback was `unmet`; with input 1, readback was `met`. Validation and strict lint were clean, and logs/trace contained the corresponding execution records.
- The temporary rule and its local variables were removed. Official-format backups before and after the probe were byte-identical (six rules and 91 variables).
- Trace is a bounded projection of retained logs. Its completeness metadata reported unknown retention, unavailable historical topology and the configured scan limit; it does not prove complete historical execution.

MIoT requests initially failed because the workstation's normal DNS lookup for `miot-spec.org` timed out. A fresh public DNS lookup and a process-only address override allowed requests to the original HTTPS hostname, with certificate verification retained. The successful spec-aware checks used freshly fetched official definitions, not old cached fixtures. No system DNS, gateway configuration or persistent endpoint was changed. Normal DNS subsequently recovered. The independently installed v2.1.1 then repeated spec-aware validation on all six rules through the normal network path, again with zero errors and the same legacy-ID warnings.

Raw household inventories, rule contents, credentials, snapshots and downloaded official bundles remain private and are not release assets.

## Fixes in v2.1.1

1. **Ambiguous writes and CLI crash.** An encrypted test gateway accepted a write and disconnected before acknowledging it. The previous client could crash on an unhandled readline `EPIPE`, or surface an ordinary network/authentication failure. Submitted writes now return `NOT_CONFIRMED`; the mutation fence remains in place. Explicit gateway rejection and failures before submission retain their distinct semantics. Inspect live state before retrying.
2. **Learning profile drift.** A same-URN change from `0=Off, 1=On` to `0=On, 1=Off` previously left an old profile reusable. Profiles now record and compare the full source plan fingerprint, and live profile/pre-enable checks refresh MIoT definitions. Changed capability semantics invalidate reuse. Legacy profiles without this provenance remain readable but cannot authorize rule authoring.
3. **Schedule export safety.** Empty `filter.day` arrays previously disappeared during export, turning an invalid selected-day schedule into every-day execution on replay. Both strict and permissive exports now reject that conversion. Normal day filters retain their behavior, and additional rule-level configuration fields are preserved in the disabled replay envelope.

4. **Concurrent login/session updates on macOS.** Native filesystem contention reproduced `EINVAL` when publishing an owner record into a removed/replaced lock directory. Owner publication retries this error only when the directory identity confirms that race; a persistent error on the same directory remains visible.

The fixes address reproduced client defects; this review does not attribute them to a particular firmware update. Real device actions, destructive backup restore, firmware installation and long-duration household learning were not exercised.

## Reproducible checks

The final clean-checkout `pnpm check` passed lint, build and all 733 tests. `pnpm audit --prod` reported zero known vulnerabilities across 14 production dependencies.

Run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm pack:release` from a clean checkout. Smoke-test both tarballs in an isolated installation and verify their version, CLI help, dependency pairing and allowed package contents. Focused regressions cover encrypted connection loss, explicit rejection, no-send failure, both schedule exporters, normal schedule replay, legacy profile handling and fresh-spec failure/drift.

## npm publication follow-up

npm accepted both v2.1.1 package uploads, but explicitly reported that package processing could take a few minutes. The release workflow waited only about one minute, so it failed first while confirming core visibility and then, on retry, while confirming CLI visibility. This was a confirmation-window failure after accepted publication; the build and package smoke tests had passed.

The workflow now uses a bounded ten-minute confirmation window with limited per-request time, exact package/dependency checks and diagnostic progress. The helper is embedded in the workflow so dispatching it for an older release tag does not depend on a new helper file being present in that tag. Published versions remain immutable.
