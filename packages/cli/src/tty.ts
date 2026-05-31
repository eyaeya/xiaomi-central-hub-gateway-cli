/**
 * Shared TTY-aware ANSI helper. Originally inlined in
 * `commands/_mutation-guard.ts:107-114` for `printRefreshHint`; extracted so
 * `agent-hints.ts` can reuse the exact same colour discipline without a
 * circular import via `_mutation-guard.ts`.
 *
 * Contract: emit ANSI only when stream.isTTY is true AND `NO_COLOR` is
 * undefined. Defined-but-empty `NO_COLOR=""` still disables colour (per the
 * https://no-color.org spec: any presence of the env var disables colour).
 */
export function ttyBoldYellow(stream: NodeJS.WriteStream, s: string): string {
  if (!stream.isTTY) return s;
  if (process.env.NO_COLOR !== undefined) return s;
  return `\x1b[1;33m${s}\x1b[0m`;
}
