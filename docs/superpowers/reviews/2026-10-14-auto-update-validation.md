# xgg 3.1.0 update validation

## Current source checks

- Root `pnpm check`: 1,957 unit tests and 333 contract tests passed (one pre-existing skipped contract), leak guard self-test / fixtures / probe checks passed.
- Public `pnpm check`: 759 Node tests and 388 Vitest unit/contract tests passed.
- Update behavior includes explicit check/install, origin and mirror failures, exact-version/SRI fallback, no downgrade, unsupported layout, live/dead lock owners, activation failure rollback, 24h/1h throttles, concurrent reservations and current-invocation handoff.
- Independent review identified inherited npm force=true bypassing engine-strict; fixed with explicit --force=false and regression coverage before publication.
- Complete Skill digest check and staged leak guard passed. No device mutation was performed.

## Real installation evidence (macOS / Node 24)

- Packed 3.1.0 CLI and Core installed into isolated npm prefix: version/help/check command passed; source checkout correctly reports installSupported=false while global install reports true.
- Both npm official and npmmirror completed real 3.0.0 → 3.0.1 package replacement, nested dependencies and executable readback. Real injected post-activation failure restored 3.0.0. Details in updater-installer-verification.md.
- Explicit new updater command was exercised against current public metadata by labeling the isolated bootstrap copy 3.0.0: result status=updated, executable readback 3.0.1.
- Automatic path used the same isolated bootstrap technique and npmmirror. The old status action was instrumented with an output sentinel: sentinel absent, exactly one JSON cloud-status result, command exit 0 and executable readback 3.0.1. No real auth file was read. This verifies actual replacement and no old-business execution; published 3.0.1 predates the new handoff notice, so the final 3.1.0 notice is additionally checked after publication.
- Tarballs exclude fixtures, snapshots, local configuration and official frontend references; bundled Skill included.

## Boundaries

The live source checks reflect this network, not universal mainland availability. Windows paths are covered through injected runtime tests, not a real Windows host. Existing daemons remain connected; no physical gateway reboot or implicit session replacement occurs. Interrupted replacement retains the documented recovery copy; a failed rollback requires recovery rather than another automatic install attempt.

The first full-test attempt overlapped a dist rebuild and was discarded. A later root test under concurrent full-suite load exceeded a pre-existing 50ms socket cleanup expectation; sequential complete rerun passed. Final results above are clean complete runs, not partial failing runs.
