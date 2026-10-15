# v3.2.1 automatic Agent Skill update verification

Date: 2026-10-15. Base: published v3.2.0 at
`81ba7281cf68f563949a841460a6d55e4e88f14d`. The existing lighting formulas remain
available. No gateway, cloud credential, login or physical-device operation was
needed for this distribution change.

## Automated checks

- Root `pnpm check`: 2105 unit tests and 333 contract tests passed; one existing
  contract skip. Typecheck, lint, leak-guard self-test, fixtures and probes passed.
- Public `pnpm check`: 776 Node tests and 435 Vitest tests passed; lint/build passed.
- Skill synchronizer: 27 injected-filesystem cases. Automatic update: 98 cases.
  Service and handoff tests cover current-version repair, partial results,
  rollback and the legacy migration boundary.
- Independent review found and closed four path/recovery issues: dangling alias
  recovery, arbitrary custom-layout backup permissions, relative aliases below
  symlinked ancestors, and ordinary configuration files causing ENOTDIR.
- `pnpm pack:release` passed. Core contains 272 entries, CLI 155 including all
  10 Skill files. Only allow-listed package content is present; no reference
  frontend, fixtures, snapshots or private material enters either tarball.
- Canonical and packaged Skill trees match build
  `c4935a203d646c4a3f1a9b77e5527c77ef6a7f456679fcadfa153168bae51770`.

## Real-process migration

The harness downloaded the official CLI/Core 3.2.0 tarballs and checked their
SHA-512 integrity. It installed those unmodified packages into an isolated npm
prefix with an actually old external Skill. A local HTTPS registry served the
new packed artifacts; dependencies retained their official integrity checks.
No manual Skill installation was performed after the trigger.

All 11 acceptance groups passed:

1. One ordinary `cloud status` invocation upgraded CLI 3.2.0 to 3.2.1 and updated
   shared and customized external Skill copies before the new business action.
   Full relative file lists and per-file SHA-256 hashes match the 10-file bundle.
2. Top-level aliases stayed intact; an unmarked same-name copy stayed untouched.
3. V8 coverage recorded zero old business calls, one new business call and one
   update invocation. The pending query was not replayed.
4. The customized original, including its extra files, remained in a full backup.
5. Reread, backup and partial-failure notices went to stderr; stdout was exactly
   the normal unauthenticated status JSON.
6. A second query performed no network check, download or Skill rewrite.
7. Help/version, update --check and the 3.2 lighting formula remained read-only
   with respect to external Skills.
8. Offline local repair worked inside the registry's 24-hour cooldown.
9. CI and XGG_AUTO_UPDATE=0 disabled automatic repair; explicit current-version
   update repaired an old copy.
10. The unmarked copy appeared as an individual partial-result issue.
11. The unmodified legacy explicit update path first repaired Skills on its
    subsequent eligible new-CLI query, matching the documented boundary.

The npm installation smoke checks included --version, --help and offline
brightness formulas. No credentials were loaded: cloud status used a deliberately
absent auth file. This proves the tested migration and filesystem behavior, not
all Agent runtimes' ability to refresh already-loaded model context. Updated
entrypoint paths are reported so the Agent can reread them.

## Comparison

The user-requested Lark-CLI comparison is recorded in the discovery probe with
versioned official-source links. Adopted actionable per-path partial notices;
kept bundled offline synchronization and explicit reread instructions.

Publication, registry/page readback and the actual local automatic upgrade are
separate delivery checks, performed after this pre-publication verification.
