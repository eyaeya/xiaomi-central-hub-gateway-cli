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

function variableGraph(scope) {
  return {
    id: '123',
    nodes: [
      {
        id: 'modechange',
        type: 'varChange',
        cfg: {
          pos: { x: 0, y: 0, width: 532, height: 160 },
          name: 'varChange',
          version: 1,
        },
        inputs: {},
        outputs: { output: [] },
        props: {
          scope,
          id: 'mode',
          varType: 'number',
          preload: false,
          operator: '=',
          v1: 1,
        },
      },
    ],
  };
}

function propertyWriteGraph(value) {
  return {
    id: '172',
    nodes: [
      {
        id: 'propertywrite',
        type: 'deviceOutput',
        cfg: {
          urn,
          pos: { x: 0, y: 0, width: 684, height: 204 },
          name: 'deviceOutput',
          version: 1,
        },
        inputs: { trigger: null },
        outputs: { output: [] },
        props: { did: 'dummy-device', siid: 2, piid: 2, value },
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
          {
            iid: 2,
            type: 'urn:miot-spec-v2:property:ratio:00000007:issue172:1',
            description: 'Ratio',
            format: 'double',
            access: ['read', 'write'],
            'value-range': [0, 1, 0.25],
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

test('offline validation enforces current-rule scope without requiring a variable inventory', async (t) => {
  const paths = await fixture(t, 'reject');

  const foreign = runCli(
    ['rule', 'validate', '--stdin', '--no-next-hint'],
    paths,
    JSON.stringify(variableGraph('R999')),
  );
  assert.equal(foreign.status, 2, foreign.stderr);
  assert.equal(foreign.stderr, '');
  const foreignPayload = JSON.parse(foreign.stdout);
  assert.equal(foreignPayload.ok, false);
  assert.deepEqual(foreignPayload.summary, { errors: 1, warnings: 0 });
  assert.equal(foreignPayload.issues[0]?.path, 'nodes[0].props.scope');
  assert.match(foreignPayload.issues[0]?.message ?? '', /R999.*"global".*"R123"/);

  const local = parseSuccess(
    runCli(
      ['rule', 'validate', '--stdin', '--no-next-hint'],
      paths,
      JSON.stringify(variableGraph('R123')),
    ),
  );
  assert.deepEqual(local.issues, []);
  assert.equal(existsSync(paths.markerPath), false, 'offline scope validation invoked fetch');
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

test('--stdin --spec-aware applies the persisted property-write domain contract with a fake spec', async (t) => {
  const paths = await fixture(t, 'success');

  const valid = parseSuccess(
    runCli(
      ['rule', 'validate', '--stdin', '--spec-aware', '--no-next-hint'],
      paths,
      JSON.stringify(propertyWriteGraph(0.5)),
    ),
  );
  assert.deepEqual(valid.issues, []);

  const invalid = runCli(
    ['rule', 'validate', '--stdin', '--spec-aware', '--no-next-hint'],
    paths,
    JSON.stringify(propertyWriteGraph(0.3)),
  );
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(invalid.stderr, '');
  const payload = JSON.parse(invalid.stdout);
  assert.equal(payload.ok, false);
  assert.equal(
    payload.issues.some((entry) =>
      /property write piid=2.*not aligned.*step 0.25/i.test(entry.message),
    ),
    true,
    JSON.stringify(payload),
  );
  const requests = (await readFile(paths.markerPath, 'utf8')).trim().split('\n');
  assert.equal(requests.length, 2);
});

test('offline validate reports legacy modeled node ids without rejecting or rewriting them', async (t) => {
  const paths = await fixture(t, 'reject');
  const legacy = {
    id: 'legacy-rule',
    nodes: [
      {
        id: 'legacy-node',
        type: 'onLoad',
        cfg: {
          pos: { x: 0, y: 0, width: 320, height: 80 },
          name: 'onLoad',
          version: 1,
        },
        inputs: {},
        outputs: { output: ['legacy-sink.input'] },
        props: {},
      },
      {
        id: 'legacy-sink',
        type: 'delay',
        cfg: {
          pos: { x: 400, y: 0, width: 320, height: 80 },
          name: 'delay',
          version: 1,
          unit: 's',
          value: 1,
        },
        inputs: { input: null },
        outputs: { output: [] },
        props: { timeout: 1000 },
      },
    ],
  };
  const result = runCli(
    ['rule', 'validate', '--stdin', '--no-next-hint'],
    paths,
    JSON.stringify(legacy),
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.summary, { errors: 0, warnings: 3 });
  assert.deepEqual(
    payload.issues.map(({ path }) => path),
    ['nodes[0].id', 'nodes[1].id', 'nodes[0].outputs.output[0]'],
  );
  assert.match(payload.issues[0]?.message ?? '', /not editor-compatible/);
  assert.match(payload.issues[2]?.message ?? '', /legacy-node\.output -> legacy-sink\.input/);
  assert.equal(existsSync(paths.markerPath), false);
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
  assert.match(
    result.stdout,
    /deviceOutput property-write and action\.in \/ props\.ins contracts/i,
  );
});
