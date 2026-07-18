import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const urn = 'urn:miot-spec-v2:device:light:0000A001:issue26-cli:1';

function graph() {
  return {
    id: 'rule-issue-26-cli',
    nodes: [
      {
        id: 'capture',
        type: 'deviceGetSetVar',
        cfg: {
          urn,
          pos: { x: 0, y: 0, width: 566, height: 200 },
          name: 'deviceGetSetVar',
          version: 1,
        },
        inputs: { input: null },
        outputs: { output: [] },
        props: {
          did: 'dummy-device',
          siid: 2,
          piid: 1,
          dtype: 'number',
          scope: 'global',
          id: 'captured-value',
        },
      },
    ],
  };
}

function spec() {
  return {
    type: urn,
    description: 'Issue 26 CLI fixture',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:light:00007802:issue26:1',
        description: 'Light',
        properties: [
          {
            iid: 1,
            type: 'urn:miot-spec-v2:property:on:00000006:issue26:1',
            description: 'On',
            format: 'bool',
            access: ['read', 'notify'],
          },
        ],
      },
    ],
  };
}

async function fixture(t, fetchMode) {
  const dir = await mkdtemp(join(tmpdir(), 'xgg-rule-validate-offline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bodyPath = join(dir, 'graph.json');
  const hookPath = join(dir, 'stub-fetch.mjs');
  const markerPath = join(dir, 'fetch-calls.txt');
  const missingSessionPath = join(dir, 'does-not-exist', 'session.json');
  await writeFile(bodyPath, JSON.stringify(graph()));
  const fetchBody =
    fetchMode === 'success'
      ? `return new Response(${JSON.stringify(JSON.stringify(spec()))}, { status: 200, headers: { 'content-type': 'application/json' } });`
      : `throw new Error('unexpected external request: ' + String(url));`;
  await writeFile(
    hookPath,
    `import { appendFileSync } from 'node:fs';
const markerPath = ${JSON.stringify(markerPath)};
globalThis.fetch = async (url) => {
  appendFileSync(markerPath, String(url) + '\\n');
  ${fetchBody}
};
`,
  );
  return { bodyPath, hookPath, markerPath, missingSessionPath };
}

function runCli(args, fixturePaths, input) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(fixturePaths.hookPath).href}`,
      XGG_BASE_URL: 'http://gateway.invalid:8086',
      XGG_SESSION_FILE: fixturePaths.missingSessionPath,
      XGG_NO_NEXT_HINT: '1',
    },
  });
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('--body and --stdin remain offline even when daemon env is configured', async (t) => {
  const paths = await fixture(t, 'reject');

  const bodyPayload = parseSuccess(
    runCli(['rule', 'validate', '--body', paths.bodyPath, '--no-next-hint'], paths),
  );
  assert.equal(bodyPayload.ok, true);
  assert.equal(bodyPayload.specAware, false);
  assert.deepEqual(bodyPayload.issues, []);
  assert.equal(existsSync(paths.markerPath), false, '--body unexpectedly invoked fetch');

  const stdinPayload = parseSuccess(
    runCli(['rule', 'validate', '--stdin', '--no-next-hint'], paths, JSON.stringify(graph())),
  );
  assert.equal(stdinPayload.ok, true);
  assert.equal(stdinPayload.specAware, false);
  assert.deepEqual(stdinPayload.issues, []);
  assert.equal(existsSync(paths.markerPath), false, '--stdin unexpectedly invoked fetch');
});

test('--spec-aware is an explicit public-spec entry while local input stays daemon-free', async (t) => {
  const paths = await fixture(t, 'success');

  const payload = parseSuccess(
    runCli(['rule', 'validate', '--body', paths.bodyPath, '--spec-aware', '--no-next-hint'], paths),
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.specAware, true);
  assert.deepEqual(payload.issues, []);
  const requests = (await readFile(paths.markerPath, 'utf8')).trim().split('\n');
  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0]);
  assert.equal(requestUrl.hostname, 'miot-spec.org');
  assert.equal(requestUrl.searchParams.get('type'), urn);
});

test('validate help states the offline contract and explicit spec-aware option', () => {
  const result = spawnSync(process.execPath, [cliPath, 'rule', 'validate', '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--spec-aware/);
  assert.match(result.stdout, /--body\/--stdin perform deterministic local validation only/i);
  assert.match(result.stdout, /no session, daemon, or spec fetch/i);
  assert.match(result.stdout, /public MIoT registry I\/O/i);
});
