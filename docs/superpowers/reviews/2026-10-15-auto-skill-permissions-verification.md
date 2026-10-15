# v3.2.2 discovery-permission follow-up verification

Date: 2026-10-15. Base: released v3.2.1, merge
`068c5eb354d49115735eff96e6f12a05f6537d15`.

The first actual-home 3.2.0 -> 3.2.1 automatic upgrade changed the CLI and all 10
shared Skill files successfully and preserved the alias. Its no-partial assertion
failed because an unrelated GTK configuration directory denied search permission.
That failed acceptance is retained, not reclassified as a clean result. The probe
records the evidence and scope correction. No unrelated permissions were changed.

The patch requires positive skills-root evidence for generic directory discovery.
Known Agent roots and explicitly configured paths still report permission errors;
observed extra Agent roots remain supported. Independent review found no further
issue. Five new injected-filesystem cases cover each branch (32 Skill cases total).

Checks and final packed artifacts:

- Root pnpm check: 2110 unit and 333 contract passed; one existing contract skip.
  Typecheck, lint, tooling/leak, fixture and probe checks passed.
- Public pnpm check: 776 Node and 440 Vitest tests passed; lint/build passed.
- pack:release passed. Core 272 files and CLI 155 files satisfy the package allow
  lists; CLI contains the complete 10-file Skill and matching ^3.2.2 Core dependency.
- Canonical/package Skill digest:
  `d6506b90f00c10d9b19bcf407c2eda7704571c368a6ca3d734227569e806ec9d`.

Enhanced real-process acceptance: all 13 groups passed using unmodified,
SHA-512-verified official 3.2.0 packages and the final 3.2.2 tarballs. This repeats
same-query CLI + full external Skill replacement, aliases, full custom backup,
read-only exclusions, cooldown/offline repair, repeated-query idempotence, CI and
disable switches, explicit current repair and legacy explicit-upgrade behavior.
V8 again records old business calls=0, new business calls=1, update calls=1.

The fake HOME included an unrelated GTK directory with mode 000. The filesystem
really returned EACCES; this check was not skipped. With an intentionally unmarked
Skill copy present, partial output contained only that one legitimate issue.
After removing the test-only unmarked copy, explicit update returned current with
no issues and an ordinary query emitted no diagnostics. The GTK mode remained
000 throughout, proving the updater did not work around the test by changing it.

The root/private acceptance artifacts retain both failed actual-home evidence and
successful enhanced logs. Formal publication and the actual installed 3.2.1 ->
3.2.2 upgrade are separate post-publication delivery checks.
