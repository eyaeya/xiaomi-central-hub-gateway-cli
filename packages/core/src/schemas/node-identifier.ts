import { randomUUID } from 'node:crypto';

/**
 * Canonical node-id grammar for nodes newly authored through typed shortcuts.
 *
 * The pinned gateway Bundle's `Ur.checkWebNode` rejects characters outside
 * its ASCII identifier class before the editor validates any card-specific
 * fields. Keep the persisted/read schema more permissive: older gateway
 * graphs and opaque future cards must remain viewable and exportable without
 * xgg rewriting their identities or edge endpoints.
 */
export const EDITOR_NODE_ID_PATTERN = /^[A-Za-z0-9]+$/;
export const EDITOR_NODE_ID_CONSTRAINT =
  'must be non-empty ASCII alphanumeric [A-Za-z0-9]+ (no hyphen, underscore, dot, whitespace, or Unicode)';

export function isEditorCompatibleNodeId(value: unknown): value is string {
  return typeof value === 'string' && EDITOR_NODE_ID_PATTERN.test(value);
}

export function editorNodeIdCompatibilityMessage(id: string): string {
  return `node id ${JSON.stringify(id)} is not editor-compatible: expected non-empty ASCII alphanumeric [A-Za-z0-9]+. The id and its edge endpoints are preserved for compatibility; modeled typed replay requires the explicit legacy-id opt-in, while opaque cards keep their raw tuple, unless an atomic whole-graph migration is performed.`;
}

/** Mint a collision-resistant editor-compatible id for a newly typed node. */
export function createEditorCompatibleNodeId(): string {
  return `n${randomUUID().replaceAll('-', '')}`;
}
