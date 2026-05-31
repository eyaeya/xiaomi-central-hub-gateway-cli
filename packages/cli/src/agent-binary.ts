/**
 * Resolve the `{binary, args}` pair the CLI must invoke to re-exec itself
 * into the hidden `agent serve` subcommand.
 *
 * In production `xgg` is launched as a built node script:
 *   process.execPath = /usr/local/bin/node
 *   process.argv[1]  = /path/to/dist/cli.js          → spawn `node /path/to/dist/cli.js …`
 *
 * In dev mode it runs under tsx (`pnpm dev` or `pnpm xgg`):
 *   process.execPath = /usr/local/bin/node
 *   process.argv[1]  = /path/to/src/cli.ts           → spawn `tsx /path/to/src/cli.ts …`
 *
 * The XGG_AGENT_BINARY / XGG_AGENT_ARGS env vars exist as an escape hatch
 * for unusual deployment shapes.
 */
export function resolveAgentBinary(): { binary: string; args: string[] } {
  if (process.env.XGG_AGENT_BINARY) {
    const extra = (process.env.XGG_AGENT_ARGS ?? '').split(/\s+/).filter(Boolean);
    return { binary: process.env.XGG_AGENT_BINARY, args: extra };
  }
  const entry = process.argv[1];
  if (!entry) {
    throw new Error('cannot resolve agent binary: process.argv[1] is empty');
  }
  if (entry.endsWith('.ts') || entry.endsWith('.mts')) {
    return { binary: 'tsx', args: [entry] };
  }
  return { binary: process.execPath, args: [entry] };
}
