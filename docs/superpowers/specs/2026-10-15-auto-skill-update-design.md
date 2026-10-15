# CLI and installed Agent Skill automatic update

Release: 3.2.1, based on published 3.2.0. No new runtime dependency.
This supersedes the external-Skill exclusion of the 3.1.0 updater specification.

## Behavior

- A successful CLI installation synchronizes discovered external xgg-rule-authoring
  installations from the newly activated package, with no GitHub request.
- New CLI preAction repairs Skills before finite read queries, including when
  XGG_UPDATE_HANDOFF=1 was set by an unmodified 3.2.0 updater. Local repair does not
  wait for the registry's 24-hour cooldown and remains possible offline.
- XGG_AUTO_UPDATE=0 and CI suppress automatic repair. Help/version, login, mutations,
  daemon, streams, raw API and offline lighting formulas stay free of automatic writes.
  Explicit xgg update synchronizes even with no newer CLI; --check remains read-only.
- A legacy explicit update cannot invoke the new synchronizer in that same old
  process; its first subsequent eligible query or new-version update repairs it.
  Staged/active --help/--version smoke tests must never synchronize external Skills.
- Automatic repair only applies to verified npm-global installs. Do not synchronize
  from source, npx, pnpm links, local dependency trees or staging directories.

## Discovery and installation

- Discover already-present copies in conventional global Agent skills roots and
  supported custom configuration roots; bounded traversal, never a disk-wide scan.
  Project-local copies require explicit supported discovery/registration evidence.
  Custom targets can be supplied explicitly through XGG_SKILL_DIRS (path delimiter).
- Exact skill name and published build marker identify managed published copies.
  Unknown/unmarked same-name directories remain untouched with a clear report.
  Never replace a newer published Skill with an older package Skill.
  Resolve top-level aliases and update each real target once, preserving symlinks;
  reject internal symlinks, overlapping package/source paths and unsafe targets.
- Validate the entire bundled tree against its marker before any replacement.
  Copy all files including references; remove obsolete upstream files by replacing
  the directory, not merging files. No absent Agent registrations are created.
- Stage and verify bytes before activation, serialize concurrent replacements,
  recheck the target before renaming, retain a full recoverable old-tree backup,
  and restore the old directory on activation/readback failure. Interrupted state
  must be recoverable; never delete an uncertain backup or steal a live lock.
- Customized copies are backed up in full before installing the current official
  Skill. Report that customization was preserved in the backup and is not merged
  into the new active instructions. Unknown identity or unsafe filesystem state
  prevents mutation and is reported, never described as successful synchronization.
- One target's failure does not roll back a validated CLI or hide other target
  results. Report partial synchronization and retry local repair on eligible calls.

## Output and verification

- Automatic messages go to stderr; preserve business stdout and exit code. On a
  changed Skill report its path and ask the Agent to reread SKILL.md/relevant
  references before subsequent work. Disk replacement cannot erase already-loaded
  conversation text; do not claim model-context hot reload.
- Explicit update returns structured Skill results alongside the CLI result.
- Test injected filesystems, source integrity, custom backups, aliases, extra/deleted
  files, failures/recovery, concurrent attempts and read-only exclusions. Run root
  and Public checks, pack/smoke, independent review and unmodified 3.2.0 -> 3.2.1
  automatic upgrade with an actually old external Skill, then check full equality.
- Publish PR/release/npm and verify registry/README/default npm page separately.
  Local delivery must exercise ordinary-query automatic update, not a manual npm
  upgrade or a separate skills add command that masks the feature under test.
