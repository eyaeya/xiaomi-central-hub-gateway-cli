import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { __resetSpecCache } from '../dist/http-client.js';
import { applyRename, exportRuleFromView, renderExportedAsShell } from '../dist/index.js';

const baseUrl = 'http://gateway.invalid';
const startedAt = '2026-07-19T00:00:00.000Z';
const sourceId = '123';
const sourceScope = `R${sourceId}`;
const urn = 'urn:miot-spec-v2:device:test-device:0000A001:fixture:1';

function summary(id = sourceId) {
  return {
    id,
    enable: true,
    uiType: 'rule',
    userData: {
      name: 'variable clone fixture',
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: 1,
      version: 0,
    },
  };
}

function cfg(type) {
  return {
    name: type,
    version: 1,
    pos: { x: 0, y: 0, width: 200, height: 120 },
    ...(type.startsWith('device') ? { urn } : {}),
  };
}

const localVariables = {
  123: { type: 'number', value: 6, userData: { name: 'Numeric id' } },
  count: { type: 'number', value: 7, userData: { name: 'Count', color: 'blue' } },
  deviceTop: { type: 'number', value: 2, userData: { name: 'Device top' } },
  eventA: { type: 'number', value: 3, userData: { name: 'Event A' } },
  eventB: { type: 'string', value: 'b', userData: { name: 'Event B' } },
  inputTop: { type: 'number', value: 4, userData: { name: 'Input top' } },
  outputAction: { type: 'string', value: 'on', userData: { name: 'Output action' } },
  outputProp: { type: 'number', value: 5, userData: { name: 'Output prop' } },
  text: { type: 'string', value: 'captured', userData: { name: 'Text' } },
};

const spec = {
  type: urn,
  description: 'fixture',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:test-service:00007801:fixture:1',
      description: 'fixture service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:number-prop:00000001:fixture:1',
          description: 'number',
          format: 'uint8',
          access: ['read', 'write', 'notify'],
          'value-range': [0, 100, 1],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:string-prop:00000002:fixture:1',
          description: 'string',
          format: 'string',
          access: ['read', 'write'],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:event-number:00000003:fixture:1',
          description: 'event number',
          format: 'uint8',
          access: ['read', 'notify'],
        },
        {
          iid: 4,
          type: 'urn:miot-spec-v2:property:event-string:00000004:fixture:1',
          description: 'event string',
          format: 'string',
          access: ['read', 'notify'],
        },
      ],
      actions: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:action:test-action:00002801:fixture:1',
          description: 'action',
          in: [2],
          out: [],
        },
      ],
      events: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:event:test-event:00005001:fixture:1',
          description: 'event',
          arguments: [3, 4],
        },
      ],
    },
  ],
};

function device() {
  return {
    specV2Access: true,
    specV3Access: false,
    online: true,
    pushAvailable: true,
    name: 'fixture device',
    model: 'fixture.device.v1',
    modelName: 'fixture',
    urn,
    roomId: '1',
    roomName: 'room',
    icon: '',
  };
}

function fakeDeps(variableMap = localVariables) {
  const calls = [];
  return {
    calls,
    deps: {
      baseUrl,
      store: {
        read: async () => ({
          host: baseUrl,
          pid: 1,
          socketPath: '/tmp/unused.sock',
          agentStartedAt: startedAt,
          agentVersion: '0.1.4',
          lastValidatedAt: startedAt,
        }),
      },
      ipcClient: () => ({
        request: async (method, params) => {
          if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
          calls.push({ method, params });
          if (method === '/api/getVarList' && params.scope === sourceScope) {
            return structuredClone(variableMap);
          }
          if (method === '/api/getDevList') return { devList: { device: device() } };
          throw new Error(`unexpected RPC: ${method}`);
        },
        close: () => {},
      }),
    },
  };
}

function sourceNodes() {
  return [
    {
      id: 'change',
      type: 'varChange',
      cfg: cfg('varChange'),
      inputs: {},
      outputs: { output: [] },
      props: {
        scope: sourceScope,
        id: 'count',
        varType: 'number',
        preload: true,
        operator: '>=',
        v1: 1,
      },
    },
    {
      id: 'get-global',
      type: 'varGet',
      cfg: cfg('varGet'),
      inputs: { input: null },
      outputs: { output: [], output2: [] },
      props: { scope: 'global', id: 'shared', varType: 'number', operator: '=', v1: 1 },
    },
    {
      id: 'set-number',
      type: 'varSetNumber',
      cfg: cfg('varSetNumber'),
      inputs: { input: null },
      outputs: { output: [] },
      props: {
        scope: sourceScope,
        id: 'count',
        elements: [
          { type: 'var', scope: sourceScope, id: 'count' },
          { type: 'const', value: '+' },
          { type: 'var', scope: 'global', id: 'shared' },
          { type: 'const', value: '+' },
          { type: 'var', scope: sourceScope, id: '123' },
          { type: 'const', value: '+$$R123.count' },
        ],
      },
    },
    {
      id: 'set-string',
      type: 'varSetString',
      cfg: cfg('varSetString'),
      inputs: { input: null },
      outputs: { output: [] },
      props: {
        scope: sourceScope,
        id: 'text',
        elements: [{ type: 'var', scope: sourceScope, id: 'text' }],
      },
    },
    {
      id: 'input-property',
      type: 'deviceInputSetVar',
      cfg: cfg('deviceInputSetVar'),
      inputs: {},
      outputs: { output: [] },
      props: {
        did: 'device',
        siid: 2,
        piid: 1,
        dtype: 'number',
        scope: sourceScope,
        id: 'inputTop',
      },
    },
    {
      id: 'input-event',
      type: 'deviceInputSetVar',
      cfg: cfg('deviceInputSetVar'),
      inputs: {},
      outputs: { output: [] },
      props: {
        did: 'device',
        siid: 2,
        eiid: 1,
        arguments: [
          { piid: 3, dtype: 'number', scope: sourceScope, id: 'eventA' },
          { piid: 4, dtype: 'string', scope: sourceScope, id: 'eventB' },
        ],
      },
    },
    {
      id: 'get-set',
      type: 'deviceGetSetVar',
      cfg: cfg('deviceGetSetVar'),
      inputs: { input: null },
      outputs: { output: [] },
      props: {
        did: 'device',
        siid: 2,
        piid: 1,
        dtype: 'number',
        scope: sourceScope,
        id: 'deviceTop',
      },
    },
    {
      id: 'output-property',
      type: 'deviceOutput',
      cfg: cfg('deviceOutput'),
      inputs: { trigger: null },
      outputs: { output: [] },
      props: {
        did: 'device',
        siid: 2,
        piid: 1,
        scope: sourceScope,
        id: 'outputProp',
        dtype: 'number',
        min: 0,
        max: 100,
        step: 1,
      },
    },
    {
      id: 'output-action',
      type: 'deviceOutput',
      cfg: cfg('deviceOutput'),
      inputs: { trigger: null },
      outputs: { output: [] },
      props: {
        did: 'device',
        siid: 2,
        aiid: 1,
        ins: [{ piid: 2, scope: sourceScope, id: 'outputAction', dtype: 'string' }],
      },
    },
  ];
}

function values(command, flagName) {
  return command.flags.filter((flag) => flag.name === flagName).map((flag) => flag.value);
}

function command(exported, nodeId) {
  return exported.commands.find((item) => item.kind === 'node-add' && item.nodeId === nodeId);
}

test('clone snapshots referenced local variables, remaps every supported reference, and declares globals', async (t) => {
  __resetSpecCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(spec), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
    __resetSpecCache();
  });

  const fake = fakeDeps();
  const exported = await exportRuleFromView(
    { id: sourceId, cfg: summary(), nodes: sourceNodes() },
    fake.deps,
    { targetId: '456' },
  );

  assert.equal(exported.ruleId, '456');
  assert.equal(exported.ruleName, '[Cloned] variable clone fixture');
  assert.deepEqual(exported.externalVariables, [{ scope: 'global', id: 'shared' }]);
  assert.match(exported.warnings.join('\n'), /external variable dependency global\.shared/);

  const kinds = exported.commands.map((item) => item.kind);
  const firstVariable = kinds.indexOf('variable-create');
  const ruleShell = kinds.indexOf('rule-set-body');
  const firstNode = kinds.indexOf('node-add');
  assert.ok(kinds.indexOf('external-variable-dependency') < ruleShell);
  assert.ok(ruleShell < firstVariable);
  assert.ok(firstVariable < firstNode);
  assert.equal(exported.commands.find((item) => item.kind === 'rule-set-body')?.expectAbsent, true);

  const creates = exported.commands.filter((item) => item.kind === 'variable-create');
  assert.deepEqual(
    creates.map((item) => item.id),
    Object.keys(localVariables).sort(),
  );
  assert.equal(
    creates.every((item) => item.scope === 'R456'),
    true,
  );
  assert.deepEqual(
    creates.find((item) => item.id === 'count'),
    {
      kind: 'variable-create',
      scope: 'R456',
      id: 'count',
      type: 'number',
      value: 7,
      userData: { name: 'Count', color: 'blue' },
    },
  );

  assert.deepEqual(values(command(exported, 'change'), '--var-scope'), ['R456']);
  assert.deepEqual(values(command(exported, 'get-global'), '--var-scope'), ['global']);
  assert.deepEqual(values(command(exported, 'set-number'), '--expr'), [
    '$R456.count+$global.shared+$R456.123+$$$$R123.count',
  ]);
  assert.deepEqual(values(command(exported, 'set-string'), '--var-scope'), ['R456']);
  assert.deepEqual(values(command(exported, 'input-property'), '--var-scope'), ['R456']);
  assert.deepEqual(values(command(exported, 'input-event'), '--event-arg-var'), [
    '3=R456.eventA',
    '4=R456.eventB',
  ]);
  assert.deepEqual(values(command(exported, 'get-set'), '--var-scope'), ['R456']);
  assert.deepEqual(values(command(exported, 'output-property'), '--value'), ['$R456.outputProp']);
  assert.deepEqual(JSON.parse(values(command(exported, 'output-action'), '--params')[0]), {
    'string-prop': { $var: 'R456.outputAction' },
  });

  assert.deepEqual(
    fake.calls.map((call) => call.method),
    ['/api/getVarList', '/api/getDevList'],
  );
});

test('applyRename remaps an already-cloned export again while name-only changes leave scopes untouched', async () => {
  const fake = fakeDeps({
    123: localVariables['123'],
    count: localVariables.count,
    text: localVariables.text,
  });
  const nodes = sourceNodes().filter((node) =>
    ['change', 'set-number', 'set-string'].includes(node.id),
  );
  const base = await exportRuleFromView({ id: sourceId, cfg: summary(), nodes }, fake.deps);
  const firstClone = applyRename(base, { targetId: '456' });
  const cloned = applyRename(firstClone, { targetId: '789', targetName: 'second clone' });
  const renamed = applyRename(base, { targetName: 'same-id rename' });

  assert.equal(cloned.ruleId, '789');
  assert.equal(cloned.ruleName, 'second clone');
  assert.equal(cloned.commands.find((item) => item.kind === 'rule-set-body')?.expectAbsent, true);
  assert.equal(
    cloned.commands
      .filter((item) => item.kind === 'variable-create')
      .every((item) => item.scope === 'R789'),
    true,
  );
  assert.deepEqual(values(command(cloned, 'set-number'), '--expr'), [
    '$R789.count+$global.shared+$R789.123+$$$$R123.count',
  ]);
  assert.equal(renamed.ruleId, sourceId);
  assert.equal(renamed.ruleName, 'same-id rename');
  assert.equal(
    renamed.commands.find((item) => item.kind === 'rule-set-body')?.expectAbsent,
    undefined,
  );
  assert.equal(
    renamed.commands
      .filter((item) => item.kind === 'variable-create')
      .every((item) => item.scope === sourceScope),
    true,
  );
});

test('clone fails closed for source=target, missing snapshots, missing variables, bad target scopes, and foreign scopes', async () => {
  const localNode = sourceNodes()[0];
  const fake = fakeDeps({});

  await assert.rejects(
    exportRuleFromView({ id: sourceId, cfg: summary(), nodes: [localNode] }, fake.deps),
    (error) => error?.code === 'CONFIG' && /missing local variable/.test(error.message),
  );

  await assert.rejects(
    exportRuleFromView(
      {
        id: sourceId,
        cfg: summary(),
        nodes: [{ ...localNode, props: { ...localNode.props, id: 'constructor' } }],
      },
      fake.deps,
    ),
    (error) => error?.code === 'CONFIG' && /missing local variable/.test(error.message),
  );

  await assert.rejects(
    exportRuleFromView(
      {
        id: sourceId,
        cfg: summary(),
        nodes: [
          {
            ...localNode,
            props: { ...localNode.props, scope: 'R999' },
          },
        ],
      },
      fake.deps,
    ),
    (error) =>
      error?.code === 'CONFIG' && /unsupported external variable scope/.test(error.message),
  );

  const complete = await exportRuleFromView(
    { id: sourceId, cfg: summary(), nodes: [localNode] },
    fakeDeps({ count: localVariables.count }).deps,
  );
  assert.throws(
    () => applyRename(complete, { targetId: sourceId }),
    (error) => error?.code === 'CONFIG' && /equals the source rule id/.test(error.message),
  );
  assert.throws(
    () => applyRename(complete, { targetId: 'bad-id' }),
    (error) => error?.code === 'CONFIG' && /not alphanumeric/.test(error.message),
  );

  const legacy = {
    ...complete,
    commands: complete.commands.filter((item) => item.kind !== 'variable-create'),
  };
  assert.throws(
    () => applyRename(legacy, { targetId: '456' }),
    (error) => error?.code === 'CONFIG' && /local variable snapshot/.test(error.message),
  );

  const legacyInvalidExpression = {
    ...complete,
    commands: [
      {
        kind: 'variable-create',
        scope: sourceScope,
        id: 'text',
        type: 'string',
        value: 'captured',
        userData: { name: 'Text' },
      },
      {
        kind: 'node-add',
        nodeId: 'legacy-string',
        type: 'varSetString',
        flags: [{ name: '--expr', value: `$${sourceScope}.text-foo` }],
        comment: 'legacy ambiguous expression',
      },
    ],
  };
  assert.throws(
    () => applyRename(legacyInvalidExpression, { targetId: '456' }),
    (error) => error?.code === 'CONFIG' && /invalid variable reference/.test(error.message),
  );

  const malformedLegacyFlags = [
    [{ name: '--var-scope', value: sourceScope }],
    [{ name: '--expr' }],
    [{ name: '--event-arg-var' }],
    [{ name: '--value' }],
    [{ name: '--params' }],
    [{ name: '--event-arg-var', value: 'not-a-route' }],
    [{ name: '--value', value: '$unqualified' }],
    [{ name: '--params', value: '{' }],
    [{ name: '--params', value: JSON.stringify({ text: { $var: 'bad-id' } }) }],
    [{ name: '--params', value: JSON.stringify({ text: { $var: 7 } }) }],
  ];
  for (const flags of malformedLegacyFlags) {
    const malformedLegacy = {
      ...complete,
      commands: [
        {
          kind: 'node-add',
          nodeId: 'legacy-malformed',
          type: 'deviceOutput',
          flags,
          comment: 'legacy malformed variable flag',
        },
      ],
    };
    assert.throws(
      () => applyRename(malformedLegacy, { targetId: '456' }),
      (error) => error?.code === 'CONFIG',
    );
  }
});

test('shell preflights every local variable and a later conflict performs no create or rule write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-variable-clone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = join(root, 'calls.jsonl');
  const successCapture = join(root, 'success-calls.jsonl');
  const fakeXgg = join(root, 'fake-xgg.mjs');
  await writeFile(
    fakeXgg,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.XGG_CAPTURE, JSON.stringify(args) + '\\n');
const id = args[args.indexOf('--id') + 1];
if (process.env.XGG_CONFLICT === '1' && args[0] === 'variable' && args[1] === 'create' && args.includes('--check-only') && id === 'z') process.exit(9);
`,
  );
  await chmod(fakeXgg, 0o700);

  const script = renderExportedAsShell({
    ruleId: '456',
    ruleName: 'conflict fixture',
    enable: false,
    externalVariables: [],
    commands: [
      { kind: 'shell-prelude', comment: 'fixture' },
      // Deliberately adversarial import order: the renderer must normalize
      // variable preflight/preparation ahead of this rule body.
      {
        kind: 'rule-set-body',
        bodyJson: JSON.stringify({ id: '456', nodes: [], cfg: summary('456') }),
        description: 'empty rule',
      },
      {
        kind: 'variable-create',
        scope: 'R456',
        id: 'a',
        type: 'number',
        value: 7,
        userData: { name: 'A' },
      },
      {
        kind: 'variable-create',
        scope: 'R456',
        id: 'z',
        type: 'number',
        value: 8,
        userData: { name: 'Z' },
      },
    ],
    warnings: [],
  });
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      XGG: fakeXgg,
      XGG_CAPTURE: capture,
      XGG_CONFLICT: '1',
      TMPDIR: root,
    },
  });
  assert.equal(result.status, 9);
  const calls = (await readFile(capture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((args) => args[args.indexOf('--id') + 1]),
    ['a', 'z'],
  );
  assert.equal(
    calls.every((args) => args.includes('--if-compatible')),
    true,
  );
  assert.equal(
    calls.every((args) => args.includes('--check-only')),
    true,
  );
  assert.equal(
    calls.some((args) => args[0] === 'rule'),
    false,
  );

  const success = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      XGG: fakeXgg,
      XGG_CAPTURE: successCapture,
      XGG_CONFLICT: '0',
      TMPDIR: root,
    },
  });
  assert.equal(success.status, 0, success.stderr);
  const successCalls = (await readFile(successCapture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    successCalls.map((args) =>
      args[0] === 'variable'
        ? `${args.includes('--check-only') ? 'check' : 'create'}:${args[args.indexOf('--id') + 1]}`
        : `${args[0]}:${args[1]}`,
    ),
    ['check:a', 'check:z', 'create:a', 'create:z', 'rule:set'],
  );
  assert.equal(successCalls.at(-1).includes('--expect-absent'), false);
});

test('create-only clone guards and creates an absent rule before variable writes and stops on a late target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'xgg-create-only-clone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeXgg = join(root, 'fake-xgg.mjs');
  await writeFile(
    fakeXgg,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.XGG_CAPTURE, JSON.stringify(args) + '\\n');
if (process.env.XGG_LATE_TARGET === '1' && args[0] === 'rule' && args[1] === 'set' && args.includes('--expect-absent')) process.exit(17);
`,
  );
  await chmod(fakeXgg, 0o700);

  const source = {
    ruleId: '123',
    ruleName: 'source fixture',
    enable: false,
    externalVariables: [],
    commands: [
      { kind: 'shell-prelude', comment: 'fixture' },
      {
        kind: 'rule-set-body',
        bodyJson: JSON.stringify({ id: '123', nodes: [], cfg: summary('123') }),
        description: 'empty rule',
      },
      {
        kind: 'variable-create',
        scope: 'R123',
        id: 'a',
        type: 'number',
        value: 7,
        userData: { name: 'A' },
      },
      {
        kind: 'variable-create',
        scope: 'R123',
        id: 'z',
        type: 'number',
        value: 8,
        userData: { name: 'Z' },
      },
    ],
    warnings: [],
  };
  const clone = applyRename(source, { targetId: '456' });
  const script = renderExportedAsShell(clone);

  const lateCapture = join(root, 'late.jsonl');
  const late = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      XGG: fakeXgg,
      XGG_CAPTURE: lateCapture,
      XGG_LATE_TARGET: '1',
      TMPDIR: root,
    },
  });
  assert.equal(late.status, 17);
  const lateCalls = (await readFile(lateCapture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lateCalls.map((args) =>
      args[0] === 'variable'
        ? `${args.includes('--check-only') ? 'check' : 'create'}:${args[args.indexOf('--id') + 1]}`
        : `${args[0]}:${args[1]}`,
    ),
    ['check:a', 'check:z', 'rule:set'],
  );
  assert.equal(lateCalls.at(-1).includes('--expect-absent'), true);
  assert.equal(
    lateCalls.some((args) => args[0] === 'variable' && !args.includes('--check-only')),
    false,
  );

  const successCapture = join(root, 'success.jsonl');
  const success = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      XGG: fakeXgg,
      XGG_CAPTURE: successCapture,
      XGG_LATE_TARGET: '0',
      TMPDIR: root,
    },
  });
  assert.equal(success.status, 0, success.stderr);
  const successCalls = (await readFile(successCapture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    successCalls.map((args) =>
      args[0] === 'variable'
        ? `${args.includes('--check-only') ? 'check' : 'create'}:${args[args.indexOf('--id') + 1]}`
        : `${args[0]}:${args[1]}`,
    ),
    ['check:a', 'check:z', 'rule:set', 'create:a', 'create:z'],
  );
  assert.equal(successCalls[2].includes('--expect-absent'), true);

  const noVariables = applyRename(
    { ...source, commands: source.commands.filter((item) => item.kind !== 'variable-create') },
    { targetId: '789' },
  );
  const noVariablesCapture = join(root, 'no-variables.jsonl');
  const noVariablesResult = spawnSync('bash', ['-c', renderExportedAsShell(noVariables)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      XGG: fakeXgg,
      XGG_CAPTURE: noVariablesCapture,
      XGG_LATE_TARGET: '0',
      TMPDIR: root,
    },
  });
  assert.equal(noVariablesResult.status, 0, noVariablesResult.stderr);
  const noVariableCalls = (await readFile(noVariablesCapture, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(noVariableCalls.length, 1);
  assert.deepEqual(noVariableCalls[0].slice(0, 2), ['rule', 'set']);
  assert.equal(noVariableCalls[0].includes('--expect-absent'), true);
});
