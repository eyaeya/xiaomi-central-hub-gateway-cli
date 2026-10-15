# ADR 0019: Synchronize installed Agent Skills with CLI updates

Accepted 2026-10-15. Supersedes ADR 0016's external-Skill exclusion.

Only updating npm's bundled Skill leaves Agent discovery copies indefinitely old.
Use the validated bundled directory as the offline update source for recognized
existing installations. Repair before eligible foreground queries and during the
new CLI handoff, independent of registry cooldown; preserve help/version and
device operations' existing automatic-update exclusions.

Whole-directory staging, verified replacement, per-target recovery and retained
backups protect local originals. Customized published copies receive the new
official Skill with a visible backup notice; unknown same-name Skills are not
managed. Root aliases are preserved and deduplicated. Failure is reported as a
partial Skill update while the CLI and pending business query remain usable.

The updater can change files, not already-loaded model context: report changed
entrypoint paths and require rereading before subsequent tasks. See the current
auto-skill-update specification for discovery scope and legacy explicit-update
migration boundaries. No additional runtime dependencies or GitHub access.

Patch 3.2.2 discovery clarification: generic home/XDG children require positive
directory/link evidence for their skills root. Inaccessible unrelated application
configuration is not a failed Skill. Known Agent roots, explicit paths, and errors
after observing a generic skills root remain reportable; no user permissions change.
