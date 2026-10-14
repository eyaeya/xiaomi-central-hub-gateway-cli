import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectInstall } from './install.js';
import { runUpdate } from './service.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Only finite reads. This list is intentionally explicit: new commands do not opt in.
const READ_COMMANDS = new Set([
  'status',
  'device list',
  'device get',
  'device spec',
  'rule list',
  'rule view',
  'rule get',
  'variable list',
  'variable get',
  'variable get-value',
  'backup list',
  'cloud status',
  'cloud home list',
  'cloud device list',
  'cloud device spec',
  'cloud device get',
  'cloud scene list',
  'cloud consumable list',
]);

export function isAutomaticUpdateEligible(argv: string[], env: NodeJS.ProcessEnv): boolean {
  if (
    env.XGG_UPDATE_HANDOFF === '1' ||
    env.XGG_AUTO_UPDATE === '0' ||
    (env.CI && env.CI !== '0' && env.CI !== 'false')
  )
    return false;
  if (argv.some((arg) => /^(?:--help|--version|-h|-V|--follow|--watch)(?:=|$)/.test(arg)))
    return false;
  // Options and positional IDs follow the command; only compare the leading command tokens.
  return [1, 2, 3].some((length) => READ_COMMANDS.has(argv.slice(0, length).join(' ')));
}

export interface AutomaticDependencies {
  fs: Pick<typeof fs, 'mkdir' | 'readFile' | 'writeFile' | 'rename' | 'readdir' | 'unlink'>;
  now: () => number;
  stateRoot: string;
  packageRoot: string;
  detect: typeof detectInstall;
  run: typeof runUpdate;
  notify: (message: string) => void;
}

interface State {
  attemptedAt: number;
  succeededAt?: number | undefined;
}

async function readState(file: string, deps: AutomaticDependencies): Promise<State> {
  try {
    const state = JSON.parse(await deps.fs.readFile(file, 'utf8')) as State;
    return {
      attemptedAt: Number.isFinite(state.attemptedAt) ? state.attemptedAt : 0,
      succeededAt: Number.isFinite(state.succeededAt) ? state.succeededAt : undefined,
    };
  } catch {
    return { attemptedAt: 0 };
  }
}

function due(state: State, now: number): boolean {
  // Future timestamps (clock moved backwards) do not suppress updates indefinitely.
  if (state.succeededAt && now >= state.succeededAt && now - state.succeededAt < DAY) return false;
  return !state.attemptedAt || now < state.attemptedAt || now - state.attemptedAt >= HOUR;
}

/** Called by Commander preAction after validation, before a finite query runs. */
export async function maybeAutomaticUpdate(
  currentVersion: string,
  argv = process.argv.slice(2),
  env = process.env,
  overrides: Partial<AutomaticDependencies> = {},
): Promise<boolean> {
  if (!isAutomaticUpdateEligible(argv, env)) return false;
  const deps: AutomaticDependencies = {
    fs,
    now: Date.now,
    stateRoot: path.join(homedir(), '.xgg', 'updates'),
    packageRoot: fileURLToPath(new URL('../../', import.meta.url)),
    detect: detectInstall,
    run: runUpdate,
    notify: (message) => process.stderr.write(`${message}\n`),
    ...overrides,
  };
  try {
    const key = createHash('sha256')
      .update(path.resolve(deps.packageRoot))
      .digest('hex')
      .slice(0, 24);
    const stateFile = path.join(deps.stateRoot, `${key}.json`);
    const now = deps.now();
    const oldState = await readState(stateFile, deps);
    if (!due(oldState, now)) return false;
    const installation = await deps.detect();
    if (!installation.supported) return false;
    await deps.fs.mkdir(deps.stateRoot, { recursive: true, mode: 0o700 });
    // Exclusive per-hour reservation requires no stale PID lock stealing. A crashed
    // attempt naturally expires after the failure backoff. Keep reservations until aged out.
    const reservation = `${key}-${Math.floor(now / HOUR)}.claim`;
    await deps.fs.writeFile(path.join(deps.stateRoot, reservation), '', {
      flag: 'wx',
      mode: 0o600,
    });
    const state = await readState(stateFile, deps);
    if (!due(state, now)) return false;
    const save = async (value: State) => {
      const temp = `${stateFile}.${process.pid}.tmp`;
      await deps.fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await deps.fs.rename(temp, stateFile);
    };
    await save({ ...state, attemptedAt: now });
    // Cleanup is bounded to this installation's expired reservations only.
    const entries = await deps.fs.readdir(deps.stateRoot);
    for (const entry of entries) {
      if (entry.startsWith(`${key}-`) && entry.endsWith('.claim')) {
        const bucket = Number(entry.slice(key.length + 1, -6));
        if (Number.isInteger(bucket) && bucket * HOUR < now - 2 * DAY) {
          await deps.fs.unlink(path.join(deps.stateRoot, entry)).catch(() => {});
        }
      }
    }
    try {
      const result = await deps.run(currentVersion, { registry: env.XGG_UPDATE_REGISTRY });
      // An installed update remains installed even if saving its throttle fails.
      await save({ attemptedAt: now, succeededAt: deps.now() }).catch(() => {});
      return result.status === 'updated';
    } catch {
      deps.notify(
        '[xgg update] Update deferred; continuing with the installed version. Run xgg update --check for details.',
      );
    }
  } catch {
    // State permissions, a competing foreground process or npm detection failure
    // must never turn an pending device read into a command failure.
  }
  return false;
}
