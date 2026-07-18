import { z } from 'zod';
import { Node, RuleSummary } from './rule.js';

export const BackupListRequest = z
  .object({
    from: z.string(),
  })
  .passthrough();
export type BackupListRequest = z.infer<typeof BackupListRequest>;

export const BackupItem = z
  .object({
    ts: z.string(),
    did: z.string(),
    fileName: z.string(),
    deviceName: z.string().optional(),
    modelName: z.string().optional(),
    self: z.boolean().optional(),
  })
  .passthrough();
export type BackupItem = z.infer<typeof BackupItem>;

export const BackupListResponse = z.union([
  z.array(BackupItem),
  z.object({ list: z.array(BackupItem) }).passthrough(),
]);
export type BackupListResponse = z.infer<typeof BackupListResponse>;

export const BackupCreateInput = z
  .object({
    from: z.string(),
    fileName: z.string(),
  })
  .passthrough();
export type BackupCreateInput = z.infer<typeof BackupCreateInput>;

export const BackupCreateRequest = z
  .object({
    from: z.string(),
    params: z.object({ fileName: z.string() }).passthrough(),
  })
  .passthrough();
export type BackupCreateRequest = z.infer<typeof BackupCreateRequest>;

export const BackupTargetInput = z
  .object({
    from: z.string(),
    backup: BackupItem,
  })
  .passthrough();
export type BackupTargetInput = z.infer<typeof BackupTargetInput>;

export const BackupTargetRequest = z
  .object({
    from: z.string(),
    params: BackupItem,
  })
  .passthrough();
export type BackupTargetRequest = z.infer<typeof BackupTargetRequest>;

export const BackupProgressInput = z
  .object({
    from: z.string(),
    progressId: z.number().int().nonnegative(),
  })
  .passthrough();
export type BackupProgressInput = z.infer<typeof BackupProgressInput>;

export const BackupProgressRequest = z
  .object({
    from: z.string(),
    params: z.object({ progress_id: z.number().int().nonnegative() }).passthrough(),
  })
  .passthrough();
export type BackupProgressRequest = z.infer<typeof BackupProgressRequest>;

export const BackupProgressResponse = z
  .object({
    progress: z.number(),
    speed: z.number().optional(),
    fileSize: z.number().optional(),
  })
  .passthrough();
export type BackupProgressResponse = z.infer<typeof BackupProgressResponse>;

export const BackupConfigRequest = z
  .object({
    from: z.string(),
  })
  .passthrough();
export type BackupConfigRequest = z.infer<typeof BackupConfigRequest>;

export const BackupConfigResponse = z
  .object({
    autoBackup: z.boolean(),
    autoBackupLimit: z.number().optional(),
  })
  .passthrough();
export type BackupConfigResponse = z.infer<typeof BackupConfigResponse>;

export const BackupSetConfigInput = z
  .object({
    from: z.string(),
    autoBackup: z.boolean(),
    autoBackupLimit: z.number().optional(),
  })
  .passthrough();
export type BackupSetConfigInput = z.infer<typeof BackupSetConfigInput>;

export const BackupSetConfigRequest = z
  .object({
    from: z.string(),
    params: z
      .object({
        autoBackup: z.boolean(),
        autoBackupLimit: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type BackupSetConfigRequest = z.infer<typeof BackupSetConfigRequest>;

export const BackupOperationResponse = z.union([
  z.object({ progress_id: z.number() }).passthrough(),
  z.object({ progressId: z.number() }).passthrough(),
  // The gateway uses exact `{}` for synchronous completion with no async
  // progress to poll. Keep this branch strict so malformed/unknown objects do
  // not fall through after the named progress variants reject them.
  z
    .object({})
    .strict(),
  z.boolean(),
  z.number(),
  z.string(),
  z.null(),
]);
export type BackupOperationResponse = z.infer<typeof BackupOperationResponse>;

// generateBackup is a state-coupled READ: it streams the previously
// `downloadBackup`-cached backup file back to the caller as the decoded
// `{ version, rules, variables }` payload — same shape that `loadBackup`
// consumes when restoring. Without a prior `download` the gateway returns
// `"backup file not exist, stat: null, err: 2"` (POSIX ENOENT).
// See [docs/api/backup.md](../../../../docs/api/backup.md) §generate.
export const BackupContentRule = z
  .object({
    id: z.string(),
    cfg: RuleSummary,
    nodes: z.array(Node),
  })
  .passthrough();
export type BackupContentRule = z.infer<typeof BackupContentRule>;

export const BackupContent = z
  .object({
    version: z.number(),
    rules: z.array(BackupContentRule),
    variables: z.record(z.unknown()),
  })
  .passthrough();
export type BackupContent = z.infer<typeof BackupContent>;
