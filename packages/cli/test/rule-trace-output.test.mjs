import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createIpcServer } from '@eyaeya/xgg-core';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const baseUrl = 'http://rule-trace-output.test';
const ruleId = 'rule-trace-output';
const agentStartedAt = '2026-07-20T00:00:00.000Z';

function endpointPath(root) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\xgg-trace-${process.pid}-${randomUUID()}`;
  return join(root, 'agent.sock');
}

function graphNodes() {
  return [
    {
      id: 'source',
      type: 'onLoad',
      cfg: { pos: { x: 0, y: 0, width: 100, height: 80 }, name: 'source', version: 1 },
      inputs: {},
      outputs: { output: ['sink.trigger'] },
      props: {},
    },
    {
      id: 'sink',
      type: 'onLoad',
      cfg: { pos: { x: 200, y: 0, width: 100, height: 80 }, name: 'sink', version: 1 },
      inputs: {},
      outputs: { output: [] },
      props: {},
    },
    {
      id: 'unused-get',
      type: 'deviceGet',
      cfg: {
        urn: 'urn:miot-spec-v2:device:test:0000A000:unused-trace:1',
        pos: { x: 400, y: 0, width: 100, height: 80 },
        name: 'unused-get',
        version: 1,
      },
      inputs: { input: null },
      outputs: { output: [], output2: [] },
      props: {
        did: 'cross-rule-sensitive-did',
        siid: 2,
        piid: 1,
        dtype: 'boolean',
        operator: '=',
        v1: true,
      },
    },
  ];
}

async function runCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    env: { ...process.env, XGG_AGENT_MODE: '0', XGG_NO_REFRESH_HINT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ signal, status }));
  });
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, stderr);
  assert.equal(stderr, '');
  return stdout;
}

test('rule trace emits stable bounded JSON and a compact explicit-boundary human view', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-rule-trace-output-'));
  const socketPath = endpointPath(root);
  const nodes = graphNodes();
  const summary = {
    id: ruleId,
    enable: true,
    uiType: 'test',
    userData: {
      name: 'trace fixture',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 0,
      version: 0,
    },
  };
  const lines = [
    `3|1000|r|${ruleId}|{"enable":true}`,
    `3|1001|l|${ruleId}|source.output|sink.trigger|null`,
    `3|1002|i|${ruleId}|sink|success`,
    `3|1003|i|${ruleId}|removed|success`,
    `3|1004|r|${ruleId}|{"enable":true}`,
    `3|1005|i|${ruleId}|sink|again`,
    'cross-rule-secret-not-a-parseable-log-line',
    '3|1006|i|other-rule|other|cross-rule-parsed-secret',
  ];
  const server = await createIpcServer({
    path: socketPath,
    handler: async ({ method, params }) => {
      if (method === '$ping') return { host: baseUrl, agentStartedAt };
      if (method === '/api/getGraphList') return [summary];
      if (method === '/api/getGraph') return { id: ruleId, nodes };
      if (method === '/api/getLog') return params.num === 0 ? lines.join('\n') : '';
      throw new Error(`unexpected RPC: ${method}`);
    },
  });
  const sessionFile = join(root, 'session.json');
  await writeFile(
    sessionFile,
    JSON.stringify({
      version: 2,
      sessions: {
        [baseUrl]: {
          host: baseUrl,
          pid: process.pid,
          socketPath,
          agentStartedAt,
          agentVersion: 'test',
          lastValidatedAt: agentStartedAt,
        },
      },
    }),
    { mode: 0o600 },
  );
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const common = ['--base-url', baseUrl, '--session-file', sessionFile];
  const json = JSON.parse(
    await runCli(['rule', 'trace', ruleId, '--max-steps', '2', '--next-from', '1', ...common]),
  );
  assert.equal(json.traceVersion, 1);
  assert.equal(json.totalSteps, 5);
  assert.equal(json.count, 2);
  assert.deepEqual(
    json.frames.map((frame) => frame.step),
    [3, 4],
  );
  assert.equal(json.navigation.next.step, 1);
  assert.equal(json.completeness.complete, false);
  assert.equal(json.completeness.provesCompleteExecution, false);
  assert.equal(json.completeness.fetch.stopReason, 'empty-block');
  assert.equal(json.completeness.fetch.blocksRead, 2);
  assert.equal(json.completeness.parse.unparsedLineCount, 1);
  assert.equal(json.completeness.parse.rawUnparsedLinesExposed, false);
  assert.equal(Object.hasOwn(json.completeness.parse, 'unparsedLineSamples'), false);
  assert.doesNotMatch(JSON.stringify(json), /cross-rule-secret|cross-rule-parsed-secret/);
  assert.doesNotMatch(JSON.stringify(json), /cross-rule-sensitive-did/);
  assert.deepEqual(json.completeness.semantic.specLookup, {
    requestedUrns: [],
    failedUrns: [],
    failureCount: 0,
  });
  assert.equal(
    json.completeness.reasonCodes.includes('device-get-spec-lookup-failed-raw-fallback'),
    false,
  );
  assert.equal(json.completeness.topology.driftEntryCount, 1);
  assert.equal(json.completeness.selection.truncatedByMaxSteps, true);
  assert.match(json.completeness.boundary, /not real-time device truth/);

  const bounded = JSON.parse(
    await runCli([
      'rule',
      'trace',
      ruleId,
      '--since',
      '1002',
      '--until',
      '1004',
      '--start-step',
      '2',
      '--end-step',
      '3',
      '--max-steps',
      '10',
      ...common,
    ]),
  );
  assert.deepEqual(
    bounded.frames.map((frame) => frame.step),
    [2, 3],
  );
  assert.equal(
    bounded.frames[0].status['link:source.output->sink.trigger'].info,
    '事件',
    'time selection must retain state accumulated before the selected window',
  );
  assert.deepEqual(bounded.frames[1].status, {}, 'enable entry resets accumulated state');

  const human = await runCli(['rule', 'trace', ruleId, '--node', 'sink', '--pretty', ...common]);
  assert.match(human, /client-derived; not device truth/);
  assert.match(human, /incomplete: gateway-retention-unknown/);
  assert.match(human, /node:sink/);
  assert.doesNotMatch(human, /link:source\.output/);
});
