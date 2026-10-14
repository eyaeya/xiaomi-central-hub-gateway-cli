# Staged updater installer verification — 2026-10-14

The installer was exercised in isolated temporary npm global prefixes. The user's
active global installation was not modified by these checks. Each source used the
real published `@eyaeya/xgg-cli@3.0.0` as its starting installation and the selected
`3.0.1` metadata and tarball as its update target; the new updater implementation
was invoked through its TypeScript source, without rebuilding the public package.

| Check | Observed result |
| --- | --- |
| npm official registry metadata and staged installation | Global detection passed; returned `previousVersion: 3.0.0`, `version: 3.0.1`; installed binary read back `3.0.1` |
| npmmirror metadata and staged installation | Global detection passed; returned `previousVersion: 3.0.0`, `version: 3.0.1`; installed binary read back `3.0.1` |
| Injected post-activation help-check failure with real filesystem/npm | Activation failed after directory replacement; backup restored; original binary read back `3.0.0`; error marked safe for source fallback |
| Staged and active CLI smoke checks | Exact CLI/core versions checked; both `--version` and `--help` executed with automatic updating disabled |
| Download provenance | npm lock CLI version, resolved tarball and SHA-512 integrity matched selected registry metadata before downloaded code execution |

The official and mirror runs independently used their respective registry for
metadata, tarball and dependencies, including the scoped `@eyaeya` registry
override. The installer uses nested dependencies and pins core to the same exact
release version, leaving a self-contained CLI directory after activation.

Unit verification uses only an in-memory filesystem and fake process runner. The
18 installer tests cover global versus source/local/linked/npx/pnpm detection,
integrity and core mismatch before execution, npm failure, both activation failure
points, failed rollback, cleanup failure after commit, no downgrade, concurrent
live-owner refusal, dead-owner recovery, incomplete-lock refusal, interrupted
rename recovery, malformed active manifests, invalid backups and insecure inputs.
Inherited npm force configuration is overridden with `--force=false`, preserving
engine-strict checks. Target Node-version environment overrides are removed.

Recovery preserves the previous directory as `.xgg-cli-previous`. If a process is
terminated between the two directory renames, the preserved CLI can be invoked
directly with `node <scope>/.xgg-cli-previous/dist/cli.js update`. It verifies npm's
actual global root, acquires the install lock, checks the backup before restoring,
and resumes updating. Live locks are never stolen; incomplete owner/reclaim
records require manual inspection rather than age-based deletion.

These network observations establish operation from this test environment only.
They do not prove that all mainland networks can reach either registry or that
the mirror has synchronized a release that has not yet been published.
