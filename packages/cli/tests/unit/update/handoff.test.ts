import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import type { maybeAutomaticUpdate } from '../../../src/update/automatic.js';
import {
  UpdateHandoffComplete,
  automaticUpdateHook,
  runUpdatedCli,
} from '../../../src/update/handoff.js';

const invocation = [
  'node',
  '/virtual/npm/bin/xgg',
  'device',
  'get',
  'sample device',
  '--source',
  'device',
];
let originalArgv: string[];

beforeEach(() => {
  originalArgv = process.argv;
  process.argv = [...invocation];
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function queryProgram() {
  const update = vi.fn<typeof maybeAutomaticUpdate>().mockResolvedValue(false);
  const handoff = vi.fn<typeof runUpdatedCli>().mockResolvedValue(0);
  const action = vi.fn();
  const program = new Command('xgg')
    .version('3.0.0')
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.hook('preAction', () => automaticUpdateHook('3.0.0', { update, handoff }));
  program
    .command('device')
    .command('get')
    .argument('<device-id>')
    .requiredOption('--source <source>')
    .action(action);
  return { program, update, handoff, action };
}

describe('Commander foreground update handoff', () => {
  it('awaits the update decision before allowing the original query to execute', async () => {
    const h = queryProgram();
    let completeCheck!: (updated: boolean) => void;
    h.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeCheck = resolve;
        }),
    );
    const parsing = h.program.parseAsync(process.argv);
    await vi.waitFor(() => expect(h.update).toHaveBeenCalledOnce());
    expect(h.action).not.toHaveBeenCalled();
    completeCheck(false);
    await parsing;
    expect(h.action).toHaveBeenCalledOnce();
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it('executes the original query once when there is no installed update', async () => {
    const h = queryProgram();
    await h.program.parseAsync(process.argv);
    expect(h.update).toHaveBeenCalledWith('3.0.0');
    expect(h.action).toHaveBeenCalledOnce();
    expect(h.handoff).not.toHaveBeenCalled();
  });

  it.each([0, 4, 130])(
    'hands the unchanged original argv to the new CLI once and propagates exit %s without replay',
    async (exitCode) => {
      const h = queryProgram();
      h.update.mockResolvedValue(true);
      h.handoff.mockResolvedValue(exitCode);
      const parsing = h.program.parseAsync(process.argv);
      await expect(parsing).rejects.toBeInstanceOf(UpdateHandoffComplete);
      await expect(parsing).rejects.toMatchObject({ exitCode });
      expect(h.handoff).toHaveBeenCalledOnce();
      expect(h.handoff).toHaveBeenCalledWith(invocation.slice(1));
      expect(h.action).not.toHaveBeenCalled();
      expect(h.update).toHaveBeenCalledOnce();
    },
  );

  it('does not fall back to the original action if the updated child cannot launch', async () => {
    const h = queryProgram();
    h.update.mockResolvedValue(true);
    h.handoff.mockRejectedValue(new Error('Updated child could not launch.'));
    await expect(h.program.parseAsync(process.argv)).rejects.toThrow(
      'Updated child could not launch.',
    );
    expect(h.action).not.toHaveBeenCalled();
    expect(h.handoff).toHaveBeenCalledOnce();
  });

  it.each([
    ['device', 'get'],
    ['device', 'get', 'sample-device'],
    ['device', 'get', 'sample-device', '--source', 'device', '--unknown-option'],
    ['device', 'unknown-command'],
    ['--help'],
    ['--version'],
    ['device', 'get', '--help'],
  ])('validates or handles help before doing updater or business work for %j', async (...args) => {
    const h = queryProgram();
    process.argv = invocation.slice(0, 2).concat(args);
    await expect(h.program.parseAsync(process.argv)).rejects.toBeDefined();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.handoff).not.toHaveBeenCalled();
    expect(h.action).not.toHaveBeenCalled();
  });
});

describe('updated process launch', () => {
  function childProcess() {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    return child;
  }

  it('inherits output streams, passes argv without shell interpolation, and disables recursive handoff', async () => {
    const child = childProcess();
    const args = invocation.slice(1);
    const pending = runUpdatedCli(args);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(process.execPath, args, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, XGG_UPDATE_HANDOFF: '1' },
    });
    child.emit('exit', 0, null);
    await expect(pending).resolves.toBe(0);
  });

  it('forwards termination and removes temporary parent signal listeners after the child exits', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const child = childProcess();
    const pending = runUpdatedCli(invocation.slice(1));
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
    process.emit('SIGINT');
    process.emit('SIGTERM');
    expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
    child.emit('exit', null, 'SIGINT');
    await expect(pending).resolves.toBe(130);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('sanitizes spawn errors and cleans up listeners rather than leaking subprocess diagnostics', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const child = childProcess();
    const pending = runUpdatedCli(invocation.slice(1));
    child.emit('error', new Error('secret diagnostic'));
    await expect(pending).rejects.toThrow('Updated CLI could not start');
    await expect(pending).rejects.not.toThrow('secret diagnostic');
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });
});
