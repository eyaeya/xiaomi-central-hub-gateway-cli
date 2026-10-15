# Automatic Skill update discovery

Date: 2026-10-15. Read-only probe before implementation.

- Base: public origin/main and v3.2.0 are commit
  `81ba7281cf68f563949a841460a6d55e4e88f14d`; installed CLI is 3.2.0.
  The new lighting formulas must remain intact.
- Existing automatic updater replaces the complete npm package and starts the new
  CLI with XGG_UPDATE_HANDOFF=1 before the pending query. It never copies external
  Skills. The handoff is the migration point for unmodified 3.2.0 installations.
- Existing explicit 3.2.0 update does not start a new command after installation.
  Its staged/active version/help smoke commands disable automatic updates. Those
  commands must stay free of external Skill writes; legacy explicit upgrades can
  repair on their first subsequent eligible query or a new-version xgg update.
- Local global shared Skill is a real directory; 47 observed secondary global
  registrations link to it. Resolve and deduplicate aliases, preserve the links.
  The shared Skill and package contain the same 10 files with digest
  `2e405173f7178df0e82d2a0be100cae1c8eac157f9c56631fa43465f0ebc313b`.
- The development .claude Skill has 29 files and no published content marker.
  Directory name alone is insufficient identity; it must not be overwritten.
- skills CLI lock metadata contains a Git tree hash, not xgg's content digest.
  It cannot substitute for whole-tree inspection. Updates can use the bundled
  Skill without contacting GitHub or installing/running another package.

Decision: use offline, bounded discovery of already-installed published xgg
Skills; validate source digest; preserve aliases; stage each complete replacement
and retain a recoverable backup before activation. Report customized originals
and failures explicitly. Repair on eligible foreground startup, including the
legacy update handoff, independently of registry cooldown. See ADR 0019.

## Lark-CLI comparison requested during implementation

Compared the locally installed `@larksuite/cli` 1.0.97 with its matching official
source tag, without running authentication, update or business operations.

- [Local drift check](https://github.com/larksuite/cli/blob/v1.0.97/internal/skillscheck/check.go): ordinary startup reads local Skill state and emits version/unknown-official notices; it does not replace Skills automatically. xgg retains the user's requested same-query synchronization.
- [Unified updater](https://github.com/larksuite/cli/blob/v1.0.97/internal/selfupdate/updater.go): discovers global registrations using `skills ls -g --json` and delegates installation to `skills add`. xgg uses its already-validated npm bundle directly so Skill synchronization adds no GitHub/npm request or new runtime dependency.
- [Selection policy](https://github.com/larksuite/cli/blob/v1.0.97/internal/skillscheck/sync.go): combines official and installed sets and remembers deliberately removed Skills. xgg manages one existing published Skill and creates no absent registrations.
- [State storage](https://github.com/larksuite/cli/blob/v1.0.97/internal/skillscheck/state.go): atomic state writes are useful, but do not prove directory rollback, customized-file backup or process-lock recovery. xgg verifies those behaviors independently.

Adopted the actionable-status idea: partial automatic results now name each path
and escaped reason on stderr, avoiding a redundant network update merely to learn
that an unmarked development copy is intentionally preserved. Keep the explicit
JSON result, customization backup notice and entrypoint reread instruction.

## Actual-home follow-up: unrelated configuration permissions

After publishing 3.2.1, an ordinary query really upgraded the local CLI and shared
10-file Skill from 3.2.0 to 3.2.1. However, the no-partial acceptance assertion
failed: optional discovery inferred a Skill below an unrelated GTK config
directory whose search permission was denied. No installed Skill was observed
there. Actual shared Skill equality and alias preservation passed.

Root cause: generic home/XDG directory discovery added every directory's
`skills/xgg-rule-authoring` candidate without first observing a skills root.
Decision for patch 3.2.2: require positive directory/link evidence for generic
`child/skills` discovery; skip inaccessible unrelated application roots. Known
Agent roots and explicitly supplied paths remain authoritative candidates and
still report permission failures. Once a generic skills root is observed, its
target failure is likewise reported. Do not modify unrelated user permissions.
