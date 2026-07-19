export const AGENT_MODE_SNAPSHOTS_DIR_REQUIRED_MESSAGE =
  'XGG_AGENT_MODE=1 requires --snapshots-dir <dir> (or XGG_SNAPSHOTS_DIR=<dir>) so every mutation is checkpointed into the agent workspace';

export const AGENT_MODE_NO_SNAPSHOT_FORBIDDEN_MESSAGE =
  'XGG_AGENT_MODE=1 forbids --no-snapshot: the pre-write checkpoint is the agent-mode audit trail';
