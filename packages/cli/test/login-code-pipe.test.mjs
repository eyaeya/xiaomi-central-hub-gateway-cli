import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ConfigError } from '@eyaeya/xgg-core';
import { agentCommand, readOneShotLoginCode } from '../dist/commands/agent.js';

test('agent child reads a split login code once and closes the pipe', async () => {
  const input = Readable.from([Buffer.from('654'), Buffer.from('321')]);

  assert.equal(await readOneShotLoginCode(input), '654321');
  assert.equal(input.destroyed, true);
});

test('agent serve passes the one-shot pipe code into the existing startup flow', async () => {
  let observedPasscode;
  let startupOptions;
  const command = agentCommand({
    input: Readable.from([Buffer.from('456'), Buffer.from('789')]),
    startAgent: async (options) => {
      observedPasscode = options.passcode;
      startupOptions = options;
      return {
        socketPath: '/tmp/xgg-agent-command-test.sock',
        stop: async () => {},
        done: Promise.resolve(),
      };
    },
  });

  await command.parseAsync(['node', 'xgg-agent', 'serve', '--host', 'http://192.0.2.10:8086']);

  assert.equal(observedPasscode, '456789');
  assert.equal(startupOptions.passcode, '');
  assert.equal(startupOptions.host, 'http://192.0.2.10:8086');
});

test('agent child rejects empty, malformed, and overlong pipe payloads', async () => {
  for (const payload of ['', '12345', '123456789', '12a456']) {
    await assert.rejects(
      readOneShotLoginCode(Readable.from([Buffer.from(payload)])),
      (error) =>
        error instanceof ConfigError &&
        error.message === 'agent serve: login code pipe must contain 6–8 digits',
    );
  }
});
