/**
 * Gateway methods proven to mutate state by typed core call sites.
 *
 * This is deliberately shared by the client-side intent guard and the daemon:
 * a raw caller cannot bypass mutation serialization by labelling a known write
 * as a read. Unknown/future methods still require an explicit `kind: "write"`
 * to receive mutation semantics.
 */
export const KNOWN_GATEWAY_WRITE_METHODS: readonly string[] = Object.freeze([
  '/api/changeGraphConfig',
  '/api/createBackup',
  '/api/createVar',
  '/api/deleteBackup',
  '/api/deleteGraph',
  '/api/deleteVar',
  '/api/downloadBackup',
  '/api/loadBackup',
  '/api/setBackupConfig',
  '/api/setGraph',
  '/api/setVarConfig',
  '/api/setVarValue',
]);

export function isKnownGatewayWriteMethod(method: string): boolean {
  return KNOWN_GATEWAY_WRITE_METHODS.includes(method);
}
