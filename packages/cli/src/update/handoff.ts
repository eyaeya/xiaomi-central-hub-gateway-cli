import { spawn } from 'node:child_process';
import { maybeAutomaticUpdate } from './automatic.js';

/** Internal control flow: prevents Commander dispatching the old version's action. */
export class UpdateHandoffComplete extends Error {
  constructor(readonly exitCode: number) {
    super('The updated CLI handled this command.');
  }
}

export async function runUpdatedCli(argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, XGG_UPDATE_HANDOFF: '1' },
    });
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', () => {
      cleanup();
      reject(new Error('Updated CLI could not start. Run xgg --version and retry the query.'));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : 1));
    });
  });
}

export async function automaticUpdateHook(
  currentVersion: string,
  deps = { update: maybeAutomaticUpdate, handoff: runUpdatedCli },
): Promise<void> {
  const updated = await deps.update(currentVersion);
  if (!updated) return;
  // No business action has run. Never fall back to old code after handing off,
  // even if the child fails: doing so could execute a command twice.
  const code = await deps.handoff(process.argv.slice(1));
  throw new UpdateHandoffComplete(code);
}
