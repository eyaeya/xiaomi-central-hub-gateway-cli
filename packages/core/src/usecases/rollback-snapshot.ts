import { getBackupConfig, listBackups } from '../resources/backup.js';
import { listDevices } from '../resources/devices.js';
import type { ResourceDeps } from '../resources/index.js';
import { type RuleView, getRule, listRules } from '../resources/rules.js';
import { listScopes, listVariables } from '../resources/variables.js';
import type { BackupConfigResponse, BackupItem } from '../schemas/backup.js';
import type { Device } from '../schemas/device.js';
import type { VarEntry } from '../schemas/variable.js';
import { SchemaError } from '../transport/errors.js';

export const ROLLBACK_SNAPSHOT_VERSION = 1 as const;

export interface RollbackBackupContext {
  from: string;
  /** Present for target-specific operations such as backup load/delete. */
  target?: BackupItem;
}

export interface RollbackBackupState extends RollbackBackupContext {
  list: BackupItem[];
  config: BackupConfigResponse;
}

/**
 * Complete, replayable state captured before a mutation.
 *
 * This is intentionally distinct from `DumpAllResult`, which is a lightweight,
 * best-effort inventory. Every field here is required (except backup state for
 * non-backup mutations), and collection aborts on the first failed read.
 * `VarEntry` carries both the variable config (`type`/`userData`) and value.
 */
export interface RollbackSnapshot {
  kind: 'xgg-pre-write-rollback';
  schemaVersion: typeof ROLLBACK_SNAPSHOT_VERSION;
  devices: Record<string, Device>;
  rules: RuleView[];
  variables: Record<string, Record<string, VarEntry>>;
  backup?: RollbackBackupState;
  capturedAt: string;
}

export interface CollectRollbackSnapshotOptions {
  backup?: RollbackBackupContext;
}

/**
 * Read the gateway state needed to reconstruct rules and variables after a
 * failed mutation. Calls are sequential because the per-host agent does not
 * multiplex concurrent gateway requests.
 */
export async function collectRollbackSnapshot(
  deps: ResourceDeps,
  options: CollectRollbackSnapshotOptions = {},
): Promise<RollbackSnapshot> {
  const devices = await listDevices(deps);

  const summaries = await listRules(deps);
  const rules: RuleView[] = [];
  const seenRuleIds = new Set<string>();
  for (const cfg of summaries) {
    if (seenRuleIds.has(cfg.id)) {
      throw new SchemaError(`rollback snapshot contains duplicate rule id: ${cfg.id}`, {
        ruleId: cfg.id,
      });
    }
    seenRuleIds.add(cfg.id);
    const graph = await getRule(cfg.id, deps);
    if (graph.id !== cfg.id) {
      throw new SchemaError(
        `rollback snapshot rule id mismatch: requested ${cfg.id}, received ${graph.id}`,
        { requestedRuleId: cfg.id, receivedRuleId: graph.id },
      );
    }
    rules.push({ id: cfg.id, cfg, nodes: graph.nodes });
  }

  const scopes = await listScopes(deps);
  const variableEntries: Array<[string, Record<string, VarEntry>]> = [];
  const seenScopes = new Set<string>();
  for (const scope of scopes) {
    if (seenScopes.has(scope)) {
      throw new SchemaError(`rollback snapshot contains duplicate variable scope: ${scope}`, {
        scope,
      });
    }
    seenScopes.add(scope);
    variableEntries.push([scope, await listVariables(scope, deps)]);
  }
  // Object.fromEntries defines data properties even for a legacy scope named
  // `__proto__`; direct assignment to `{}` would silently lose that scope.
  const variables = Object.fromEntries(variableEntries);

  let backup: RollbackBackupState | undefined;
  if (options.backup !== undefined) {
    const list = await listBackups(options.backup.from, deps);
    const config = await getBackupConfig(options.backup.from, deps);
    backup = { ...options.backup, list, config };
  }

  return {
    kind: 'xgg-pre-write-rollback',
    schemaVersion: ROLLBACK_SNAPSHOT_VERSION,
    devices,
    rules,
    variables,
    ...(backup !== undefined && { backup }),
    capturedAt: new Date().toISOString(),
  };
}
