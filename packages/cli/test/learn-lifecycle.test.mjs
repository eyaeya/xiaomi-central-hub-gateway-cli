import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  createHabitLearningCorrection,
  createInMemoryMutationLeaseCoordinator,
  createInitialHabitLearningStudySession,
  createIpcServer,
  deriveHabitLearningHypotheses,
} from '@eyaeya/xgg-core';
import { __resetSpecCache } from '../../core/dist/http-client.js';
import {
  buildProfileAnalysisContract,
  describeHabitLearningProfileRegion,
  describeHabitLearningProfileValue,
  groupHabitLearningPointEventsByLocalDate,
  overlappingGapIds,
  parameterPairing,
  projectHabitLearningAutomationConstraints,
  resolveProfileGatewayWindow,
  runtimeCoverageReport,
} from '../dist/commands/learn-lifecycle.js';
import { buildProgram } from '../dist/program.js';

const baseUrl = 'http://learn-lifecycle.test';
const agentStartedAt = '2026-07-30T10:00:00.000Z';
const deviceUrn = 'urn:miot-spec-v2:device:switch:0000A003:habit-lifecycle-fixture:1';

// Fixtures reuse one registry URL while varying its semantics. Preserve cache
// behavior inside each test without allowing one fixture to seed the next.
beforeEach(__resetSpecCache);
afterEach(__resetSpecCache);

function endpointPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\xgg-learn-lifecycle-${process.pid}-${randomUUID()}`;
  }
  return join(root, 'agent.sock');
}

function fixtureDevice() {
  return {
    specV2Access: true,
    specV3Access: false,
    online: true,
    pushAvailable: true,
    name: 'Synthetic switch',
    model: 'fixture.synthetic-switch',
    modelName: 'Synthetic switch',
    urn: deviceUrn,
    roomId: 'fixture-room',
    roomName: 'Fixture room',
    icon: '',
  };
}

function fixtureSpec() {
  return {
    type: deviceUrn,
    description: 'Synthetic switch',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:switch:0000780C:habit-lifecycle-fixture:1',
        description: 'Switch',
        properties: [
          {
            iid: 1,
            type: 'urn:miot-spec-v2:property:on:00000006:habit-lifecycle-fixture:1',
            description: 'On',
            format: 'uint8',
            access: ['read', 'write', 'notify'],
            'value-range': [0, 1, 1],
            'value-list': [
              { value: 0, description: 'Off' },
              { value: 1, description: 'On' },
            ],
          },
        ],
        events: [
          {
            iid: 1,
            type: 'urn:miot-spec-v2:event:clicked:00005001:habit-lifecycle-fixture:1',
            description: 'Clicked',
            arguments: [],
          },
        ],
        actions: [],
      },
    ],
  };
}

async function startFakeGateway(t, { gatewayClockOffsetMs = 0, beforeGetDevList, onGetLog } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xgg-learn-lifecycle-'));
  const socketPath = endpointPath(root);
  const sessionFile = join(root, 'gateway-session.json');
  const studyDir = join(root, 'private-study');
  const calls = [];
  const rules = new Map();
  const scopes = new Map([['global', {}]]);
  const mutationLeases = createInMemoryMutationLeaseCoordinator();
  const logLines = [];
  let lastLogTimestamp = 0;
  let propertySample = 0;
  let failGetLog = false;
  let failGetLogAttempts = 0;
  let getLogCalls = 0;
  let deviceOverrides = {};
  const nextLogTimestamp = async () => {
    while (Date.now() + gatewayClockOffsetMs <= lastLogTimestamp) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    lastLogTimestamp = Date.now() + gatewayClockOffsetMs;
    return lastLogTimestamp;
  };

  const server = await createIpcServer({
    path: socketPath,
    mutationLeases,
    handler: async (request) => {
      calls.push(request);
      const params = request.params ?? {};
      switch (request.method) {
        case '$ping':
          return { host: baseUrl, agentStartedAt };
        case '/api/getDevList':
          await beforeGetDevList?.();
          return { devList: { syntheticDid: { ...fixtureDevice(), ...deviceOverrides } } };
        case '/api/getGraphList':
          return [...rules.values()].map(({ cfg }) => cfg);
        case '/api/getGraph': {
          const graph = rules.get(params.id);
          if (graph === undefined) throw new Error(`missing graph ${params.id}`);
          return { id: params.id, nodes: graph.nodes };
        }
        case '/api/setGraph':
          rules.set(params.id, {
            cfg: structuredClone(params.cfg),
            nodes: structuredClone(params.nodes),
          });
          return {};
        case '/api/changeGraphConfig': {
          const graph = rules.get(params.id);
          if (graph === undefined) throw new Error(`missing graph ${params.id}`);
          graph.cfg = structuredClone(params);
          logLines.push(
            `3|${await nextLogTimestamp()}|r|${params.id}|${JSON.stringify({ enable: params.enable })}`,
          );
          return {};
        }
        case '/api/getVarScopeList':
          return { scopes: [...scopes.keys()] };
        case '/api/getVarList':
          return structuredClone(scopes.get(params.scope) ?? {});
        case '/api/createVar': {
          const scope = scopes.get(params.scope) ?? {};
          scope[params.id] = {
            type: params.type,
            value: params.value,
            userData: structuredClone(params.userData),
          };
          scopes.set(params.scope, scope);
          return {};
        }
        case '/api/getLog': {
          getLogCalls += 1;
          if (failGetLog || failGetLogAttempts > 0) {
            if (failGetLogAttempts > 0) failGetLogAttempts -= 1;
            await onGetLog?.({ call: getLogCalls, failed: true });
            throw new Error('synthetic getLog failure');
          }
          await onGetLog?.({ call: getLogCalls, failed: false });
          if (params.num !== 0) return '';
          const entry = [...rules.entries()][0];
          if (entry === undefined) return logLines.join('\n');
          const [ruleId, graph] = entry;
          if (graph.cfg.enable === true) {
            const source = graph.nodes.find((node) => node.type === 'deviceInputSetVar');
            if (source !== undefined) {
              propertySample = propertySample === 0 ? 1 : 0;
              logLines.push(
                `3|${await nextLogTimestamp()}|i|${ruleId}|${source.id}|[${propertySample}]`,
              );
            }
          }
          return logLines.join('\n');
        }
        default:
          throw new Error(`unexpected IPC method: ${request.method}`);
      }
    },
  });
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
  return {
    calls,
    logLines,
    root,
    rules,
    sessionFile,
    studyDir,
    setDeviceOverrides(value) {
      deviceOverrides = { ...value };
    },
    setFailGetLog(value) {
      failGetLog = value;
    },
    setFailGetLogAttempts(value) {
      failGetLogAttempts = value;
    },
  };
}

async function captureStdout(run) {
  const original = process.stdout.write;
  let stdout = '';
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function reviewedPlanId(fake, extraArguments = []) {
  const output = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'plan',
        ...extraArguments,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  return output[0].plan.planId;
}

async function prepareAndEnableStudy(fake, { planArguments = [], startArguments = [] } = {}) {
  const planId = await reviewedPlanId(fake, planArguments);
  const prepared = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        ...startArguments,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(prepared[0].phase, 'ready-disabled');
  assert.equal(prepared[0].enabled, false);
  assert.equal(prepared[0].planId, planId);

  const enabled = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        '--enable',
        '--plan-id',
        planId,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(enabled[0].phase, 'observing');
  assert.equal(enabled[0].enabled, true);
  return { enabled: enabled[0], planId, prepared: prepared[0] };
}

test('runtime coverage preserves detailed baseline-only evidence without counting behavior', () => {
  const baselineSignal = 'a'.repeat(64);
  const missingSignal = 'b'.repeat(64);
  const excludedSignal = 'c'.repeat(64);
  const device = {
    did: 'device-one',
    name: 'Device one',
    model: 'fixture.model',
    urn: 'fixture.urn',
    roomId: 'room-one',
    roomName: 'Room one',
  };
  const plan = {
    deviceCoverage: [
      {
        did: device.did,
        roomId: device.roomId,
        roomName: device.roomName,
        status: 'partially-planned',
        reasonCodes: ['default-policy-excluded'],
      },
    ],
    signals: [
      {
        signalId: baselineSignal,
        device,
        included: true,
        observability: 'push-notify',
        reasonCodes: ['included-p0-behavior'],
      },
      {
        signalId: missingSignal,
        device,
        included: true,
        observability: 'event',
        reasonCodes: ['included-p0-behavior'],
      },
      {
        signalId: excludedSignal,
        device,
        included: false,
        observability: 'sample-only',
        reasonCodes: ['sample-only-not-behavior'],
      },
    ],
  };
  const report = runtimeCoverageReport(plan, {
    plannedSignalIds: [baselineSignal, missingSignal, excludedSignal],
    includedSignalIds: [baselineSignal, missingSignal],
    excludedSignalIds: [excludedSignal],
    expectedPreloadSignalIds: [baselineSignal],
    baselineSeenSignalIds: [baselineSignal],
    observedSignalIds: [baselineSignal],
    behaviorObservedSignalIds: [],
    baselineOnlySignalIds: [baselineSignal],
    stateAnchorOnlySignalIds: [baselineSignal],
    ambiguousSignalIds: [],
    missingSignalIds: [missingSignal],
  });

  assert.deepEqual(report.devices.behaviorObserved, { count: 0, ids: [] });
  assert.deepEqual(report.devices.baselineOnly, { count: 1, ids: [device.did] });
  assert.deepEqual(report.rooms.behaviorObserved, { count: 0, ids: [] });
  assert.deepEqual(report.rooms.baselineOnly, { count: 1, ids: [device.roomId] });
  assert.deepEqual(report.signals.behaviorObserved, { count: 0, ids: [] });
  assert.deepEqual(report.signals.baselineOnly, { count: 1, ids: [baselineSignal] });
  assert.deepEqual(report.signals.missing, { count: 1, ids: [missingSignal] });
  assert.deepEqual(report.signals.excluded.details, [
    {
      signalId: excludedSignal,
      reasonCodes: ['sample-only-not-behavior'],
    },
  ]);
  assert.deepEqual(report.devices.details[0].missingSignalIds, [missingSignal]);
  assert.equal(report.rooms.details[0].candidateSignalCount, 2);
});

test('learn lifecycle creates one safe graph, captures, disables, and writes an anonymous profile', async (t) => {
  const fake = await startFakeGateway(t);
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('type'), deviceUrn);
    return new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
    if (originalTimezone === undefined) Reflect.deleteProperty(process.env, 'TZ');
    else process.env.TZ = originalTimezone;
  });

  const { enabled: started, planId } = await prepareAndEnableStudy(fake, {
    startArguments: ['--duration-days', '1'],
  });
  assert.equal(started.ok, true);
  assert.equal(started.enabled, true);
  assert.equal(started.graph.outputCount, 0);
  assert.equal(fake.rules.size, 1);
  process.env.TZ = 'UTC';

  const [[ruleId, graph]] = [...fake.rules.entries()];
  assert.equal(graph.cfg.enable, true);
  assert.equal(graph.nodes.filter((node) => node.type === 'signalOr').length, 1);
  assert.equal(
    graph.nodes.some((node) => node.type === 'deviceOutput' || node.type === 'loop'),
    false,
  );
  assert.equal((await stat(fake.studyDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(fake.studyDir, 'session.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(fake.studyDir, 'pre-start.bak'))).mode & 0o777, 0o600);

  const callsBeforeFinish = fake.calls.length;
  const finished = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'finish',
        '--study-dir',
        fake.studyDir,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(finished.length, 1);
  assert.equal(finished[0].ok, true);
  assert.equal(finished[0].phase, 'complete');
  assert.equal(finished[0].ruleEnabled, false);
  assert.equal(fake.rules.get(ruleId).cfg.enable, false);

  const profileRaw = await readFile(join(fake.studyDir, 'profile.json'), 'utf8');
  const profile = JSON.parse(profileRaw);
  assert.equal(
    profile.timezone,
    'Asia/Shanghai',
    'profile projection must reuse the IANA timezone frozen at learn start',
  );
  assert.equal(profile.privacy.anonymizedDeviceKeys, true);
  assert.equal(profile.privacy.containsRawDeviceIdentifiers, false);
  assert.equal(profile.completeness.householdSizeInference, 'prohibited');
  assert.equal(profile.completeness.personIdentityInference, 'prohibited');
  assert.ok(profile.observations.length >= 1);
  assert.equal(
    profile.observations.some((observation) => observation.kind === 'event-count'),
    false,
    'property preload rows must remain state anchors rather than point behavior',
  );
  assert.equal(profile.completeness.observedSignalCount, 1);
  assert.ok(
    profile.observations.some(
      (observation) =>
        observation.kind === 'state-interval' && observation.value?.leftCensored === true,
    ),
    'the enable-time preload must be represented as a left-censored state anchor',
  );
  assert.ok(
    profile.observations.some(
      (observation) =>
        observation.kind === 'state-interval' &&
        [0, 1].includes(observation.value?.state?.rawValue) &&
        ['Off', 'On'].includes(observation.value?.state?.specLabel) &&
        observation.value?.state?.mappingAuthority === 'miot-spec-value-list',
    ),
    'state values must retain both the gateway raw value and MIoT value-list meaning',
  );
  assert.ok(profile.completeness.reasonCodes.includes('collector-start-to-finish-overlap-proven'));
  assert.doesNotMatch(profileRaw, /syntheticDid|Synthetic switch|fixture-room/);
  assert.ok(
    profile.hypotheses.every(
      (hypothesis) =>
        hypothesis.status === 'candidate-needs-user-confirmation' &&
        hypothesis.interpretationBoundary === 'does-not-identify-person-or-household-size' &&
        hypothesis.evidenceObservationIds.length > 0,
    ),
  );
  const privateMapPath = join(fake.studyDir, 'device-map.private.json');
  const privateMapRaw = await readFile(privateMapPath, 'utf8');
  const privateMap = JSON.parse(privateMapRaw);
  assert.equal((await stat(privateMapPath)).mode & 0o777, 0o600);
  assert.match(privateMapRaw, /syntheticDid|Synthetic switch|fixture-room/);
  assert.equal(privateMap.devices.length, 1);
  assert.ok(
    profile.observations.some(({ deviceKey }) => deviceKey === privateMap.devices[0].deviceKey),
  );
  assert.equal(
    privateMap.devices[0].sourceIds.length,
    privateMap.devices[0].signalIds.length,
    'the private authoring map must include zero-argument event sources as well as variable sources',
  );
  const coverage = JSON.parse(await readFile(join(fake.studyDir, 'coverage.json'), 'utf8'));
  assert.equal(coverage.reviewedPlanId, planId);
  assert.deepEqual(coverage.analysis, {
    timezone: 'Asia/Shanghai',
    baselineQuietMs: 2_000,
    baselineHardCapMs: 60_000,
    debounceMs: 5_000,
  });
  assert.equal(coverage.observed.devices.visible.count, 1);
  assert.equal(coverage.observed.devices.details.length, 1);
  assert.equal(coverage.observed.rooms.visible.count, 1);
  assert.equal(coverage.observed.rooms.details.length, 1);
  assert.equal(coverage.observed.signals.included.count, 2);
  assert.equal(coverage.observed.signals.expectedPreload.count, 1);
  assert.equal(coverage.observed.signals.baselineSeen.count, 1);
  assert.equal(coverage.observed.signals.behaviorObserved.count, 1);
  assert.equal(coverage.observed.signals.baselineOnly.count, 0);
  assert.equal(coverage.observed.signals.missing.count, 1);
  assert.deepEqual(
    coverage.observed.devices.behaviorObserved.ids,
    coverage.observed.devices.included.ids,
    'a device with a post-baseline transaction counts as behavior-observed',
  );
  await writeFile(join(fake.studyDir, 'handoff.md'), '# stale handoff\n', { mode: 0o600 });
  const repeatedFinish = await captureStdout(() =>
    buildProgram().parseAsync(['learn', 'finish', '--study-dir', fake.studyDir], {
      from: 'user',
    }),
  );
  assert.equal(repeatedFinish[0].phase, 'complete');
  const repairedHandoff = await readFile(join(fake.studyDir, 'handoff.md'), 'utf8');
  assert.match(repairedHandoff, /Phase: complete/);
  assert.match(repairedHandoff, /Private device map:/);

  const localProfile = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'profile',
        '--study-dir',
        fake.studyDir,
        '--minimum-completeness',
        'bounded',
        '--local-only',
      ],
      { from: 'user' },
    ),
  );
  assert.equal(localProfile[0].freshness.status, 'stale');
  assert.equal(localProfile[0].freshness.reusableForRuleAuthoring, false);
  assert.deepEqual(localProfile[0].freshness.reasons, ['live-drift-check-required']);

  const liveProfile = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'profile',
        '--study-dir',
        fake.studyDir,
        '--minimum-completeness',
        'bounded',
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(liveProfile[0].freshness.status, 'current');
  assert.equal(liveProfile[0].freshness.reusableForRuleAuthoring, true);

  const mutationMethods = fake.calls
    .filter(({ method }) =>
      ['/api/setGraph', '/api/createVar', '/api/changeGraphConfig'].includes(method),
    )
    .map(({ method }) => method);
  assert.ok(mutationMethods.includes('/api/setGraph'));
  assert.ok(mutationMethods.includes('/api/createVar'));
  assert.equal(
    mutationMethods.filter((method) => method === '/api/changeGraphConfig').length,
    2,
    'one explicit enable and one finish disable',
  );
  const disableIndex = fake.calls.findIndex(
    ({ method, params }) => method === '/api/changeGraphConfig' && params?.enable === false,
  );
  assert.ok(disableIndex > 0, 'finish must issue an explicit disable');
  assert.ok(
    fake.calls
      .slice(callsBeforeFinish, disableIndex)
      .some(({ method }) => method === '/api/getLog'),
    'the final log capture must commit before disable',
  );
  assert.equal(
    fake.calls.slice(disableIndex + 1).some(({ method }) => method === '/api/getLog'),
    false,
    'finish must not defer its final capture until after disable',
  );
  assert.ok(
    fake.calls.slice(disableIndex + 1).some(({ method }) => method === '/api/getGraphList'),
    'finish must read back the disabled rule configuration',
  );
  assert.ok(
    fake.calls.slice(disableIndex + 1).some(({ method }) => method === '/api/getGraph'),
    'finish must read back and revalidate the disabled graph',
  );
});

test('learn profile refreshes specs and refuses same-URN semantic drift and legacy provenance', async (t) => {
  const fake = await startFakeGateway(t);
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  let currentSpec = fixtureSpec();
  let fetchFails = false;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (fetchFails) return new Response('', { status: 503 });
    return new Response(JSON.stringify(currentSpec), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });
  await prepareAndEnableStudy(fake);
  const argumentsFor = (command) => [
    'learn',
    command,
    '--study-dir',
    fake.studyDir,
    '--base-url',
    baseUrl,
    '--session-file',
    fake.sessionFile,
  ];
  await captureStdout(() => buildProgram().parseAsync(argumentsFor('finish'), { from: 'user' }));
  const readProfile = () =>
    captureStdout(() =>
      buildProgram().parseAsync([...argumentsFor('profile'), '--minimum-completeness', 'bounded'], {
        from: 'user',
      }),
    );
  const [baseline] = await readProfile();
  assert.equal(baseline.freshness.reusableForRuleAuthoring, true);
  const requestsBeforeDrift = requests;
  currentSpec = fixtureSpec();
  currentSpec.services[0].properties[0]['value-list'] = [
    { value: 0, description: 'On' },
    { value: 1, description: 'Off' },
  ];
  const [drifted] = await readProfile();
  assert.equal(drifted.freshness.status, 'stale');
  assert.equal(drifted.freshness.reusableForRuleAuthoring, false);
  assert.deepEqual(drifted.freshness.reasons, ['plan-drift']);
  assert.ok(requests > requestsBeforeDrift, 'freshness must refresh a cached same-URN spec');

  fetchFails = true;
  const [unavailable] = await readProfile();
  assert.equal(unavailable.freshness.reusableForRuleAuthoring, false);
  assert.deepEqual(unavailable.freshness.reasons, ['plan-drift']);
  fetchFails = false;
  currentSpec = fixtureSpec();
  const profilePath = join(fake.studyDir, 'profile.json');
  const legacyProfile = JSON.parse(await readFile(profilePath, 'utf8'));
  Reflect.deleteProperty(legacyProfile, 'sourcePlanId');
  await writeFile(profilePath, JSON.stringify(legacyProfile), { mode: 0o600 });
  const [legacy] = await readProfile();
  assert.equal(legacy.freshness.reusableForRuleAuthoring, false);
  assert.deepEqual(legacy.freshness.reasons, ['source-plan-unavailable']);
});

test('learn start checks the canonical target behind a symlinked parent for Git exposure', async (t) => {
  if (process.platform === 'win32') {
    t.skip('directory symlink setup is platform-dependent on Windows');
    return;
  }
  const fake = await startFakeGateway(t);
  const repository = join(fake.root, 'exposure-repository');
  const unignoredDirectory = join(repository, 'unignored-private-data');
  await mkdir(unignoredDirectory, { recursive: true });
  const initialized = spawnSync('git', ['init', '--quiet', repository], {
    encoding: 'utf8',
  });
  assert.equal(initialized.status, 0, initialized.stderr);

  const alias = join(fake.root, 'outside-alias');
  await symlink(unignoredDirectory, alias, 'dir');
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        join(alias, 'study'),
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
    /Refusing unignored Git path/,
  );
  assert.equal(fake.rules.size, 0);
});

test('learn start stays disabled and resumes a frozen plan after an enable-ack crash', async (t) => {
  const fake = await startFakeGateway(t);
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  const output = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        '--duration-days',
        '1',
        '--name',
        'Synthetic frozen study',
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(output[0].phase, 'ready-disabled');
  assert.equal(output[0].enabled, false);
  assert.equal([...fake.rules.values()][0].cfg.enable, false);
  assert.equal(
    fake.calls.some(({ method }) => method === '/api/changeGraphConfig'),
    false,
  );
  const session = JSON.parse(await readFile(join(fake.studyDir, 'session.json'), 'utf8'));
  assert.equal(session.phase, 'ready-disabled');
  assert.equal(session.rule.expectedEnabled, false);

  [...fake.rules.values()][0].cfg.enable = true;
  const callsBeforeResume = fake.calls.length;
  const resumed = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        '--enable',
        '--plan-id',
        output[0].planId,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(resumed[0].phase, 'observing');
  assert.equal(resumed[0].enabled, true);
  assert.equal(
    fake.calls.slice(callsBeforeResume).some(({ method }) => method === '/api/changeGraphConfig'),
    false,
    'an already-enabled matching graph must be reconciled without a duplicate enable mutation',
  );
  const resumedSession = JSON.parse(await readFile(join(fake.studyDir, 'session.json'), 'utf8'));
  const resumedCoverage = JSON.parse(await readFile(join(fake.studyDir, 'coverage.json'), 'utf8'));
  assert.equal(resumedCoverage.durationDays, 1);
  assert.equal(resumedCoverage.plannedStartAt, resumedSession.timestamps.observationStartedAt);
  assert.equal(
    Date.parse(resumedCoverage.plannedEndAt) - Date.parse(resumedCoverage.plannedStartAt),
    24 * 60 * 60 * 1_000,
  );
});

test('learn start resumes partial local artifacts only from its durable private intent', async (t) => {
  const fake = await startFakeGateway(t);
  const studyDir = await mkdtemp(join(fake.root, 'partial-study-'));
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  const createdAt = new Date().toISOString();
  await writeFile(
    join(studyDir, 'start-intent.json'),
    `${JSON.stringify(
      {
        version: 1,
        ruleName: 'Recovered private study',
        durationDays: 1,
        timezone: 'Asia/Shanghai',
        includeContext: false,
        includeSensitive: false,
        excludedDeviceIds: [],
        excludedRoomIds: [],
        baselineQuietMs: 2_000,
        baselineHardCapMs: 60_000,
        debounceMs: 5_000,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(studyDir, 'session.json'),
    `${JSON.stringify(createInitialHabitLearningStudySession({ now: createdAt }), null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(studyDir, 'plan.json'), '{"partial":true}\n', { mode: 0o600 });

  const callsBeforeRejectedEnable = fake.calls.length;
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        studyDir,
        '--enable',
        '--plan-id',
        'a'.repeat(64),
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
    /allowed only when this invocation begins from a durable ready-disabled checkpoint/,
  );
  assert.equal(
    fake.calls.slice(callsBeforeRejectedEnable).length,
    0,
    'preparing recovery must stop before any gateway read or mutation when --enable is supplied',
  );

  const output = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        studyDir,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(output[0].phase, 'ready-disabled');
  const coverage = JSON.parse(await readFile(join(studyDir, 'coverage.json'), 'utf8'));
  const graph = JSON.parse(await readFile(join(studyDir, 'graphs', 'rule.json'), 'utf8'));
  assert.equal(coverage.durationDays, 1);
  assert.equal(graph.cfg.userData.name, 'Recovered private study');
  assert.equal((await stat(join(studyDir, 'start-intent.json'))).mode & 0o777, 0o600);
});

test('learn start freezes analysis settings and requires a reviewed, live-current plan before enable', async (t) => {
  const fake = await startFakeGateway(t);
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  let currentSpec = fixtureSpec();
  globalThis.fetch = async () =>
    new Response(JSON.stringify(currentSpec), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  const missingPlanStudy = join(fake.root, 'missing-reviewed-plan');
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        missingPlanStudy,
        '--enable',
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
    /--enable requires --plan-id/,
  );
  assert.equal(fake.rules.size, 0, 'review gate must run before gateway mutation');

  const reviewedPlan = await reviewedPlanId(fake);
  const unpreparedStudy = join(fake.root, 'unprepared-reviewed-plan');
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        unpreparedStudy,
        '--enable',
        '--plan-id',
        reviewedPlan,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
    /allowed only when this invocation begins from a durable ready-disabled checkpoint/,
  );
  assert.equal(
    fake.rules.size,
    0,
    'a reviewed plan still cannot collapse create-disabled and enable into one mutation flow',
  );

  const output = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        '--baseline-quiet-ms',
        '3000',
        '--baseline-hard-cap-ms',
        '45000',
        '--debounce-ms',
        '7000',
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(output[0].phase, 'ready-disabled');
  const coverage = JSON.parse(await readFile(join(fake.studyDir, 'coverage.json'), 'utf8'));
  assert.deepEqual(
    {
      baselineQuietMs: coverage.analysis.baselineQuietMs,
      baselineHardCapMs: coverage.analysis.baselineHardCapMs,
      debounceMs: coverage.analysis.debounceMs,
    },
    {
      baselineQuietMs: 3_000,
      baselineHardCapMs: 45_000,
      debounceMs: 7_000,
    },
  );
  assert.equal(typeof coverage.analysis.timezone, 'string');
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        '--enable',
        '--plan-id',
        output[0].planId,
        '--debounce-ms',
        '6000',
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
    /frozen plan/,
  );

  fake.setDeviceOverrides({ roomId: 'changed-room' });
  const callsBeforeDriftedEnable = fake.calls.length;
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        '--enable',
        '--plan-id',
        output[0].planId,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
    /live inventory or MIoT semantics changed/,
  );
  assert.equal(
    fake.calls
      .slice(callsBeforeDriftedEnable)
      .some(({ method }) => method === '/api/changeGraphConfig'),
    false,
    'live drift must abort before enable mutation',
  );
  assert.equal([...fake.rules.values()][0].cfg.enable, false);
  fake.setDeviceOverrides({});
  currentSpec = fixtureSpec();
  currentSpec.services[0].properties[0]['value-list'][0].description = 'Changed enum meaning';
  const callsBeforeSpecDrift = fake.calls.length;
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        '--enable',
        '--plan-id',
        output[0].planId,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
    /live inventory or MIoT semantics changed/,
  );
  assert.equal(
    fake.calls
      .slice(callsBeforeSpecDrift)
      .some(({ method }) => method === '/api/changeGraphConfig'),
    false,
    'a cached same-URN spec must not hide semantic drift before enable',
  );
});

test('learn start serializes concurrent lifecycle writers before planning or mutation', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  const originalWrite = process.stdout.write;
  let releaseInventory;
  let markInventoryStarted;
  const inventoryStarted = new Promise((resolve) => {
    markInventoryStarted = resolve;
  });
  const inventoryGate = new Promise((resolve) => {
    releaseInventory = resolve;
  });
  let firstInventory = true;
  const fake = await startFakeGateway(t, {
    beforeGetDevList: async () => {
      if (!firstInventory) return;
      firstInventory = false;
      markInventoryStarted();
      await inventoryGate;
    },
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  process.stdout.write = () => true;
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  const args = [
    'learn',
    'start',
    '--study-dir',
    fake.studyDir,
    '--base-url',
    baseUrl,
    '--session-file',
    fake.sessionFile,
  ];
  const first = buildProgram().parseAsync(args, { from: 'user' });
  await inventoryStarted;
  try {
    await assert.rejects(
      buildProgram().parseAsync(args, { from: 'user' }),
      /another live capture supervisor owns this study/,
    );
  } finally {
    releaseInventory();
  }
  await first;
  assert.equal(fake.rules.size, 1);
});

test('learn capture exits with an error after durably checkpointing an exhausted failure', async (t) => {
  const fake = await startFakeGateway(t);
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  await prepareAndEnableStudy(fake);
  fake.setFailGetLog(true);
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'capture',
        '--study-dir',
        fake.studyDir,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
    /durable gap\/state were preserved/,
  );
  const session = JSON.parse(await readFile(join(fake.studyDir, 'session.json'), 'utf8'));
  assert.equal(session.phase, 'observing-degraded');
  assert.ok(session.degradedReasonCodes.length > 0);
  assert.ok((await readFile(join(fake.studyDir, 'gaps.ndjson'), 'utf8')).length > 0);
});

test('learn capture follow survives a transient exhausted network poll and returns to observing', async (t) => {
  let stopAfterRecovery = false;
  const fake = await startFakeGateway(t, {
    onGetLog: async ({ failed }) => {
      if (stopAfterRecovery && !failed) process.emit('SIGINT');
    },
  });
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  await prepareAndEnableStudy(fake);
  fake.setFailGetLogAttempts(3);
  stopAfterRecovery = true;
  const output = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'capture',
        '--study-dir',
        fake.studyDir,
        '--follow',
        '--interval',
        '1',
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(output.length, 2);
  assert.equal(output[0].phase, 'observing-degraded');
  assert.equal(output[0].willRetry, true);
  assert.equal(output[0].capture.outcome, 'failed');
  assert.equal(output[1].phase, 'observing');
  assert.equal(output[1].capture.outcome, 'captured');
  const session = JSON.parse(await readFile(join(fake.studyDir, 'session.json'), 'utf8'));
  assert.equal(session.phase, 'observing');
  assert.deepEqual(session.degradedReasonCodes, []);
});

test('learn capture durably rejects an unexpectedly disabled or semantically drifted live graph', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  for (const scenario of [
    'unexpected-disable',
    'semantic-drift',
    'invalid-semantic-drift',
    'invalid-semantic-drift-follow',
  ]) {
    const fake = await startFakeGateway(t);
    await prepareAndEnableStudy(fake);
    const stateBefore = JSON.parse(await readFile(join(fake.studyDir, 'state.json'), 'utf8'));
    const graph = [...fake.rules.values()][0];
    const expectedCode =
      scenario === 'unexpected-disable' ? 'RULE_UNEXPECTEDLY_DISABLED' : 'SEMANTIC_GRAPH_DRIFT';
    if (scenario === 'unexpected-disable') {
      graph.cfg.enable = false;
    } else if (scenario === 'semantic-drift') {
      const source = graph.nodes.find((node) => node.type === 'deviceInputSetVar');
      assert.ok(source);
      source.props.preload = false;
    } else {
      const aggregatorIndex = graph.nodes.findIndex((node) => node.type === 'signalOr');
      assert.notEqual(aggregatorIndex, -1);
      graph.nodes.splice(aggregatorIndex, 1);
    }

    await assert.rejects(
      buildProgram().parseAsync(
        [
          'learn',
          'capture',
          '--study-dir',
          fake.studyDir,
          ...(scenario.endsWith('-follow') ? ['--follow', '--interval', '1'] : []),
          '--base-url',
          baseUrl,
          '--session-file',
          fake.sessionFile,
        ],
        { from: 'user' },
      ),
      /durable gap\/state were preserved/,
    );
    const session = JSON.parse(await readFile(join(fake.studyDir, 'session.json'), 'utf8'));
    const stateAfter = JSON.parse(await readFile(join(fake.studyDir, 'state.json'), 'utf8'));
    const gapRaw = await readFile(join(fake.studyDir, 'gaps.ndjson'), 'utf8');
    assert.equal(
      session.phase,
      expectedCode === 'SEMANTIC_GRAPH_DRIFT' ? 'finishing' : 'observing-degraded',
    );
    assert.deepEqual(session.degradedReasonCodes, [expectedCode]);
    if (expectedCode === 'SEMANTIC_GRAPH_DRIFT') {
      assert.equal(session.rule.expectedEnabled, false);
      assert.equal(session.finish.stage, 'clarification-pending');
      assert.equal(graph.cfg.enable, false, 'semantic drift must trigger a fail-safe disable');
    }
    assert.equal(
      stateAfter.committedBatchSequence,
      stateBefore.committedBatchSequence,
      'a rejected live graph must not commit a new evidence batch',
    );
    assert.match(gapRaw, new RegExp(expectedCode));
  }
});

test('learn finish closes disabled, valid-drifted, or invalid-drifted studies as bounded', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  for (const scenario of ['unexpected-disable', 'semantic-drift', 'invalid-semantic-drift']) {
    const fake = await startFakeGateway(t);
    await prepareAndEnableStudy(fake);
    const graph = [...fake.rules.values()][0];
    const expectedCode =
      scenario === 'unexpected-disable' ? 'RULE_UNEXPECTEDLY_DISABLED' : 'SEMANTIC_GRAPH_DRIFT';
    if (scenario === 'unexpected-disable') {
      graph.cfg.enable = false;
    } else if (scenario === 'semantic-drift') {
      const source = graph.nodes.find((node) => node.type === 'deviceInputSetVar');
      source.props.preload = false;
    } else {
      const aggregatorIndex = graph.nodes.findIndex((node) => node.type === 'signalOr');
      assert.notEqual(aggregatorIndex, -1);
      graph.nodes.splice(aggregatorIndex, 1);
    }

    const finished = await captureStdout(() =>
      buildProgram().parseAsync(
        [
          'learn',
          'finish',
          '--study-dir',
          fake.studyDir,
          '--base-url',
          baseUrl,
          '--session-file',
          fake.sessionFile,
        ],
        { from: 'user' },
      ),
    );
    assert.equal(finished[0].phase, 'complete');
    const session = JSON.parse(await readFile(join(fake.studyDir, 'session.json'), 'utf8'));
    const profile = JSON.parse(await readFile(join(fake.studyDir, 'profile.json'), 'utf8'));
    const gaps = await readFile(join(fake.studyDir, 'gaps.ndjson'), 'utf8');
    assert.equal(session.finish.lastErrorCode, expectedCode);
    assert.match(gaps, new RegExp(expectedCode));
    assert.notEqual(profile.completeness.status, 'sufficient');
    assert.equal(profile.completeness.collectorContinuity, 'gapped');
    assert.ok(profile.completeness.reasonCodes.includes('collector-gaps-present'));
    assert.equal(graph.cfg.enable, false);
  }
});

test('learn status reports a live supervisor heartbeat from the private owner file', async (t) => {
  const fake = await startFakeGateway(t);
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'start',
        '--study-dir',
        fake.studyDir,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  const heartbeatAt = new Date().toISOString();
  await writeFile(
    join(fake.studyDir, 'capture-supervisor.json'),
    `${JSON.stringify({
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      startedAt: heartbeatAt,
      heartbeatAt,
      lastOutcome: 'captured',
      nextPollAt: new Date(Date.now() + 60_000).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  const output = await captureStdout(() =>
    buildProgram().parseAsync(['learn', 'status', '--study-dir', fake.studyDir, '--local-only'], {
      from: 'user',
    }),
  );
  assert.equal(output[0].supervisor.active, true);
  assert.equal(output[0].supervisor.pid, process.pid);
  assert.equal(output[0].supervisor.heartbeatAt, heartbeatAt);
  assert.equal(output[0].supervisor.stale, false);
});

test('learn finish resumes after a crash between disable acknowledgement and readback', async (t) => {
  const fake = await startFakeGateway(t);
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  await prepareAndEnableStudy(fake, {
    startArguments: ['--duration-days', '1'],
  });
  const capture = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'capture',
        '--study-dir',
        fake.studyDir,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(capture[0].capture.outcome, 'captured');

  const sessionPath = join(fake.studyDir, 'session.json');
  const checkpoint = JSON.parse(await readFile(sessionPath, 'utf8'));
  const crashAt = new Date().toISOString();
  checkpoint.phase = 'finishing';
  checkpoint.revision += 1;
  checkpoint.finish = {
    stage: 'disable-readback-pending',
    attempts: 2,
    pendingClarifications: [],
  };
  checkpoint.timestamps = {
    ...checkpoint.timestamps,
    updatedAt: crashAt,
    finishingStartedAt: crashAt,
    finalCaptureCommittedAt: capture[0].capture.capturedAt,
    disableRequestedAt: crashAt,
  };
  await writeFile(sessionPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  const [[ruleId, graph]] = [...fake.rules.entries()];
  graph.cfg.enable = false;
  const callsBeforeResume = fake.calls.length;

  const resumed = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'finish',
        '--study-dir',
        fake.studyDir,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(resumed[0].phase, 'complete');
  assert.equal(fake.rules.get(ruleId).cfg.enable, false);
  assert.equal(
    fake.calls.slice(callsBeforeResume).some(({ method }) => method === '/api/changeGraphConfig'),
    false,
    'a resumed disable-readback checkpoint must not re-enable or redundantly mutate the rule',
  );
  assert.ok(
    fake.calls.slice(callsBeforeResume).some(({ method }) => method === '/api/getGraphList'),
    'resume must reconcile the live disabled state before profile generation',
  );
});

test('learn profile derives its evidence window from gateway time under either clock skew', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  for (const gatewayClockOffsetMs of [-120_000, 120_000]) {
    const fake = await startFakeGateway(t, { gatewayClockOffsetMs });
    await prepareAndEnableStudy(fake, {
      startArguments: ['--duration-days', '1'],
    });
    const finished = await captureStdout(() =>
      buildProgram().parseAsync(
        [
          'learn',
          'finish',
          '--study-dir',
          fake.studyDir,
          '--base-url',
          baseUrl,
          '--session-file',
          fake.sessionFile,
        ],
        { from: 'user' },
      ),
    );
    assert.equal(finished[0].phase, 'complete');
    const profile = JSON.parse(await readFile(join(fake.studyDir, 'profile.json'), 'utf8'));
    const capturedGatewayTimestamps = fake.logLines
      .filter((line) => !line.includes('{"enable":false}'))
      .map((line) => Number(line.split('|')[1]));
    assert.equal(profile.observedFrom, capturedGatewayTimestamps[0]);
    assert.ok(profile.observedUntil >= Math.max(...capturedGatewayTimestamps) + 1);
  }
});

test('profile evidence window never projects collector wall-clock time into gateway evidence', () => {
  const ruleId = 'quiet-study';
  const gatewayStart = 1_800_000_000_000;
  const localStart = Date.parse('2026-07-30T00:00:00.000Z');
  const quietPeriodMs = 6 * 60 * 60 * 1_000;
  const enable = {
    version: 3,
    timestamp: gatewayStart,
    rawType: 'r',
    graphId: ruleId,
    ruleConfig: { enable: true },
  };
  const window = resolveProfileGatewayWindow(
    {
      entries: [enable],
      gaps: [],
      batches: [
        {
          capturedAt: new Date(localStart).toISOString(),
          entries: [enable],
        },
        {
          capturedAt: new Date(localStart + quietPeriodMs).toISOString(),
          entries: [],
        },
      ],
    },
    ruleId,
  );
  assert.equal(window.start, gatewayStart);
  assert.equal(window.end, gatewayStart + 1);
});

test('a bounded midday gap does not suppress repeated direct morning evidence', () => {
  const gap = {
    gapId: 'midday-gap',
    start: Date.parse('2026-07-28T12:00:00+08:00'),
    end: Date.parse('2026-07-28T12:30:00+08:00'),
  };
  const episode = (id, signalKey, start, end) => ({
    observationId: id.repeat(64),
    kind: 'episode',
    deviceKey: `device_${'a'.repeat(32)}`,
    signalKey,
    observedFrom: Date.parse(start),
    observedUntil: Date.parse(end),
    value: {
      leftCensored: false,
      rightCensored: false,
      ambiguous: false,
    },
    count: { min: 1, max: 1 },
    evidenceRefs: [`episode:${id}`],
    gapIds: overlappingGapIds([gap], Date.parse(start), Date.parse(end)),
    certainty: 'direct',
  });
  const observations = [
    episode('1', 'motion', '2026-07-28T08:00:00+08:00', '2026-07-28T08:01:00+08:00'),
    episode('2', 'light', '2026-07-28T08:03:00+08:00', '2026-07-28T08:04:00+08:00'),
    episode('3', 'motion', '2026-07-29T08:05:00+08:00', '2026-07-29T08:06:00+08:00'),
    episode('4', 'light', '2026-07-29T08:08:00+08:00', '2026-07-29T08:09:00+08:00'),
  ];
  assert.ok(observations.every(({ gapIds }) => gapIds.length === 0));
  assert.deepEqual(
    overlappingGapIds(
      [gap],
      Date.parse('2026-07-28T11:59:00+08:00'),
      Date.parse('2026-07-28T12:01:00+08:00'),
    ),
    ['midday-gap'],
  );
  const hypotheses = deriveHabitLearningHypotheses({
    observations,
    timezone: 'Asia/Shanghai',
  });
  assert.ok(hypotheses.some(({ subject }) => subject === 'device-use-pattern'));
});

test('profile value semantics preserve units and mark Zone labels as inferred numbering', () => {
  const illumination = describeHabitLearningProfileValue(
    {
      capabilityUrn: 'urn:miot-spec-v2:property:illumination',
      capabilityDescription: 'Illumination',
      unit: 'lux',
      valueRange: { min: 0, max: 100_000, step: 1 },
      regionIdentifier: false,
    },
    42,
  );
  assert.equal(illumination.rawValue, 42);
  assert.equal(illumination.unit, 'lux');
  assert.deepEqual(illumination.valueRange, {
    min: 0,
    max: 100_000,
    step: 1,
  });

  const zone = describeHabitLearningProfileValue(
    {
      capabilityUrn: 'urn:miot-spec-v2:property:zone-id',
      capabilityDescription: 'Zone ID',
      regionIdentifier: true,
    },
    4,
  );
  assert.equal(zone.rawZoneId, 4);
  assert.equal(zone.derivedLabel, 'Zone-4');
  assert.equal(zone.regionIdentifier, true);
  assert.equal(zone.mappingAuthority, 'inferred-numbering');
  assert.equal(
    Object.values(zone).includes('userConfirmed'),
    false,
    'numeric Zone labels must not be upgraded to user-confirmed meaning',
  );
  assert.deepEqual(
    describeHabitLearningProfileRegion(
      {
        capabilityUrn: 'urn:miot-spec-v2:property:occupancy-status',
        capabilityDescription: 'occupancy-status',
        valueList: [
          { value: 0, description: 'NoShow' },
          { value: 1, description: 'Show' },
        ],
        regionIdentifier: false,
        sourceDtype: 'int',
        partition: { label: 'A-4', mapBank: 'A' },
      },
      1,
    ),
    {
      label: 'A-4',
      mapBank: 'A',
      activity: 'active',
      mappingAuthority: 'planner-model-partition',
    },
  );
});

test('point events are retained as per-source local-day buckets across the frozen timezone', () => {
  const observations = [
    {
      sourceId: 'button-clicked',
      observedAt: Date.parse('2026-07-28T15:59:00.000Z'),
      marker: 'day-one',
    },
    {
      sourceId: 'button-clicked',
      observedAt: Date.parse('2026-07-28T16:01:00.000Z'),
      marker: 'day-two-first',
    },
    {
      sourceId: 'button-clicked',
      observedAt: Date.parse('2026-07-28T17:00:00.000Z'),
      marker: 'day-two-second',
    },
    {
      sourceId: 'other-event',
      observedAt: Date.parse('2026-07-28T16:02:00.000Z'),
      marker: 'other-source',
    },
  ];
  const buckets = groupHabitLearningPointEventsByLocalDate(observations, 'Asia/Shanghai');
  assert.deepEqual(
    buckets.map(({ sourceId, localDate, observations: entries }) => ({
      sourceId,
      localDate,
      markers: entries.map(({ marker }) => marker),
    })),
    [
      {
        sourceId: 'button-clicked',
        localDate: '2026-07-28',
        markers: ['day-one'],
      },
      {
        sourceId: 'button-clicked',
        localDate: '2026-07-29',
        markers: ['day-two-first', 'day-two-second'],
      },
      {
        sourceId: 'other-event',
        localDate: '2026-07-29',
        markers: ['other-source'],
      },
    ],
  );
});

test('CLI analysis metadata carries partition state semantics into translated topology', () => {
  const serviceUrn = 'urn:miot-spec-v2:service:occupancy-sensor';
  const device = {
    did: 'synthetic-partition-device',
    name: 'Synthetic partition sensor',
    model: 'fixture.partition',
    urn: 'urn:miot-spec-v2:device:occupancy-sensor',
    roomId: 'fixture-room',
    roomName: 'Fixture room',
  };
  const signal = (signalId, label, piid) => ({
    signalId,
    included: true,
    device,
    selector: {
      kind: 'property',
      siid: 6,
      piid,
      sourceDtype: 'int',
    },
    semantics: {
      serviceUrn,
      serviceDescription: 'Occupancy sensor',
      capabilityUrn: 'urn:miot-spec-v2:property:occupancy-status',
      capabilityDescription: 'Occupancy status',
      valueList: [
        { value: 0, description: 'NoShow' },
        { value: 1, description: 'Show' },
      ],
    },
    partition: {
      label,
      semanticStatus: 'opaque-user-confirmation-required',
    },
  });
  const plan = {
    signals: [signal('signal-a4', 'A-4', 4), signal('signal-a5', 'A-5', 5)],
  };
  const compilation = {
    localVariables: [
      { sourceId: 'source-a4', signalId: 'signal-a4', selector: { kind: 'property' } },
      { sourceId: 'source-a5', signalId: 'signal-a5', selector: { kind: 'property' } },
    ],
    sourceMap: {
      ruleId: 'synthetic-rule',
      sources: [
        { sourceId: 'source-a4', kind: 'property', nodeId: 'node-a4' },
        { sourceId: 'source-a5', kind: 'property', nodeId: 'node-a5' },
      ],
    },
    rule: {
      nodes: [
        { id: 'node-a4', props: { preload: true } },
        { id: 'node-a5', props: { preload: true } },
      ],
    },
  };
  const contract = buildProfileAnalysisContract(plan, compilation, Buffer.alloc(32, 12));
  const metadataA4 = contract.metadataBySource.get('source-a4');
  const metadataA5 = contract.metadataBySource.get('source-a5');
  assert.equal(metadataA4.sourceDtype, 'int');
  assert.deepEqual(metadataA4.partition, { label: 'A-4', mapBank: 'A' });
  assert.deepEqual(metadataA5.partition, { label: 'A-5', mapBank: 'A' });
  const deviceKey = contract.sources[0].deviceKey;
  const state = (id, metadata, start, end) => ({
    observationId: id.repeat(64),
    kind: 'state-interval',
    deviceKey,
    signalKey: metadata.signalKey,
    observedFrom: Date.parse(start),
    observedUntil: Date.parse(end),
    value: {
      state: describeHabitLearningProfileValue(metadata, 1),
      region: describeHabitLearningProfileRegion(metadata, 1),
      firstObservedAt: Date.parse(start),
      lastObservedAt: Date.parse(start),
      observationCount: 1,
      leftCensored: false,
      rightCensored: false,
      endedBy: 'change',
    },
    count: { min: 1, max: 1 },
    evidenceRefs: [`state:${id}`],
    gapIds: [],
    certainty: 'direct',
  });
  const observations = [
    state('1', metadataA4, '2026-07-28T22:00:00+08:00', '2026-07-28T22:00:10+08:00'),
    state('2', metadataA5, '2026-07-28T22:01:00+08:00', '2026-07-28T22:01:10+08:00'),
    state('3', metadataA4, '2026-07-29T22:03:00+08:00', '2026-07-29T22:03:10+08:00'),
    state('4', metadataA5, '2026-07-29T22:04:00+08:00', '2026-07-29T22:04:10+08:00'),
  ];
  const correction = (fixture, label, meaning, recordedAt) =>
    createHabitLearningCorrection({
      recordedAt,
      asOf: Date.parse('2026-07-27T00:00:00+08:00'),
      subject: { kind: 'region-label', deviceKey, label, mapBank: 'A' },
      value: { meaning },
      source: 'user-mi-home-app',
      correctionIdMaterial: { fixture },
    });
  const corrections = [
    correction('cli-a4', 'A-4', 'bed', Date.parse('2026-07-27T10:00:00+08:00')),
    correction('cli-a5', 'A-5', 'corridor', Date.parse('2026-07-27T10:01:00+08:00')),
  ];
  const topology = deriveHabitLearningHypotheses({
    observations,
    corrections,
    correctionKnownAt: Date.parse('2026-07-30T00:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  }).find(({ subject }) => subject === 'region-topology');
  assert.ok(topology);
  assert.match(topology.statement, /"bed" \(raw "A-4"\) followed by "corridor" \(raw "A-5"\)/);
  assert.deepEqual(
    topology.confirmationCorrectionIds,
    corrections.map(({ correctionId }) => correctionId).sort(),
  );
});

test('automation-constraint corrections project into the dedicated profile layer', () => {
  const canonical = createHabitLearningCorrection({
    recordedAt: 100,
    asOf: 50,
    subject: { kind: 'automation-constraint', constraintKey: 'quiet-hours' },
    value: {
      kind: 'exclude-time-window',
      description: 'Do not author automatic bedroom actions after midnight.',
    },
    source: 'user-direct',
    correctionIdMaterial: { fixture: 'canonical-constraint' },
  });
  const legacy = createHabitLearningCorrection({
    recordedAt: 101,
    asOf: 50,
    subject: { kind: 'automation-constraint', constraintKey: 'confirm-before-curtain-action' },
    value: true,
    source: 'user-direct',
    correctionIdMaterial: { fixture: 'legacy-constraint' },
  });
  const projected = projectHabitLearningAutomationConstraints({
    corrections: [canonical, legacy],
    asOf: 200,
    knownAt: 200,
  });
  assert.equal(projected.length, 2);
  assert.ok(
    projected.some(
      ({ kind, correctionIds }) =>
        kind === 'exclude-time-window' && correctionIds[0] === canonical.correctionId,
    ),
  );
  assert.ok(
    projected.some(
      ({ kind, correctionIds }) =>
        kind === 'require-user-confirmation' && correctionIds[0] === legacy.correctionId,
    ),
  );

  const invalid = createHabitLearningCorrection({
    recordedAt: 102,
    asOf: 50,
    subject: { kind: 'automation-constraint', constraintKey: 'ambiguous-object' },
    value: { window: 'midnight' },
    source: 'user-direct',
    correctionIdMaterial: { fixture: 'invalid-constraint' },
  });
  assert.throws(
    () =>
      projectHabitLearningAutomationConstraints({
        corrections: [invalid],
        asOf: 200,
        knownAt: 200,
      }),
    /automation-constraint object/,
  );
});

test('parameter pairing uses a shared primary argument instead of a Zone-only heuristic', () => {
  const serviceUrn = 'urn:miot-spec-v2:service:job';
  const argument = {
    piid: 7,
    urn: 'urn:miot-spec-v2:property:task-id',
    description: 'Task ID',
  };
  const started = parameterPairing(
    {
      semantics: {
        serviceUrn,
        capabilityUrn: 'urn:miot-spec-v2:event:started',
        capabilityDescription: 'Started',
      },
    },
    argument,
  );
  const stopped = parameterPairing(
    {
      semantics: {
        serviceUrn,
        capabilityUrn: 'urn:miot-spec-v2:event:stopped',
        capabilityDescription: 'Stopped',
      },
    },
    argument,
  );
  assert.equal(started.phase, 'start');
  assert.equal(stopped.phase, 'end');
  assert.equal(started.channelKey, stopped.channelKey);
  assert.match(started.channelKey, /argument:7$/);
});

test('learn clarify defaults as-of to confirmation time, not observation start', async (t) => {
  const studyDir = await mkdtemp(join(tmpdir(), 'xgg-learn-clarify-'));
  t.after(() => rm(studyDir, { recursive: true, force: true }));
  const createdAt = '2026-07-29T00:00:00.000Z';
  const clarificationPreparedAt = new Date().toISOString();
  await writeFile(
    join(studyDir, 'session.json'),
    `${JSON.stringify(
      {
        sessionVersion: 1,
        studyId: randomUUID(),
        phase: 'awaiting-clarification',
        revision: 5,
        rule: {
          ruleId: 'synthetic-rule',
          expectedEnabled: false,
          semanticDigest: 'a'.repeat(64),
          layoutDigest: 'b'.repeat(64),
          lastReadbackAt: clarificationPreparedAt,
        },
        timestamps: {
          createdAt,
          updatedAt: clarificationPreparedAt,
          finalCaptureCommittedAt: clarificationPreparedAt,
          disableRequestedAt: clarificationPreparedAt,
          disableReadbackAt: clarificationPreparedAt,
          clarificationPreparedAt,
        },
        degradedReasonCodes: [],
        finish: {
          stage: 'awaiting-clarification',
          attempts: 1,
          pendingClarifications: [
            {
              questionId: 'c'.repeat(64),
              subject: 'synthetic region question',
              createdAt: clarificationPreparedAt,
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(studyDir, 'plan.json'), '{"signals":[]}\n', { mode: 0o600 });

  const output = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'clarify',
        '--study-dir',
        studyDir,
        '--subject',
        '{"kind":"profile-field","field":"current-region-map"}',
        '--value',
        '{"status":"confirmed-current"}',
      ],
      { from: 'user' },
    ),
  );
  assert.equal(output[0].ok, true);
  const correction = JSON.parse(
    (await readFile(join(studyDir, 'corrections.ndjson'), 'utf8')).trim(),
  );
  assert.equal(correction.asOf, correction.recordedAt);
  assert.ok(correction.asOf > Date.parse(createdAt));
});

test('learn clarify validates supersedes before the append-only journal is changed', async (t) => {
  const studyDir = await mkdtemp(join(tmpdir(), 'xgg-learn-clarify-supersedes-'));
  t.after(() => rm(studyDir, { recursive: true, force: true }));
  const now = new Date().toISOString();
  await writeFile(
    join(studyDir, 'session.json'),
    `${JSON.stringify(
      {
        sessionVersion: 1,
        studyId: randomUUID(),
        phase: 'awaiting-clarification',
        revision: 5,
        rule: {
          ruleId: 'synthetic-rule',
          expectedEnabled: false,
          semanticDigest: 'a'.repeat(64),
          layoutDigest: 'b'.repeat(64),
          lastReadbackAt: now,
        },
        timestamps: {
          createdAt: '2026-07-29T00:00:00.000Z',
          updatedAt: now,
          finalCaptureCommittedAt: now,
          disableRequestedAt: now,
          disableReadbackAt: now,
          clarificationPreparedAt: now,
        },
        degradedReasonCodes: [],
        finish: {
          stage: 'awaiting-clarification',
          attempts: 1,
          pendingClarifications: [
            {
              questionId: 'c'.repeat(64),
              subject: 'synthetic region question',
              createdAt: now,
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(studyDir, 'plan.json'), '{"signals":[]}\n', { mode: 0o600 });

  const first = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'clarify',
        '--study-dir',
        studyDir,
        '--subject',
        '{"kind":"profile-field","field":"current-region-map"}',
        '--value',
        '{"status":"confirmed-current"}',
      ],
      { from: 'user' },
    ),
  );
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'clarify',
        '--study-dir',
        studyDir,
        '--subject',
        '{"kind":"profile-field","field":"different-subject"}',
        '--value',
        '{"status":"must-not-append"}',
        '--supersedes',
        first[0].correctionId,
      ],
      { from: 'user' },
    ),
    /different subject|supersed/i,
  );
  const lines = (await readFile(join(studyDir, 'corrections.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).correctionId, first[0].correctionId);
});

test('finish, clarify, and finish again preserves the user semantic translation in profile', async (t) => {
  const fake = await startFakeGateway(t);
  const originalFetch = globalThis.fetch;
  const originalNoRefresh = process.env.XGG_NO_REFRESH_HINT;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixtureSpec()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  process.env.XGG_NO_REFRESH_HINT = '1';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalNoRefresh === undefined) Reflect.deleteProperty(process.env, 'XGG_NO_REFRESH_HINT');
    else process.env.XGG_NO_REFRESH_HINT = originalNoRefresh;
  });

  await prepareAndEnableStudy(fake);
  const planPath = join(fake.studyDir, 'plan.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const signal = plan.signals.find(({ included }) => included);
  signal.device.name = '测试灯';
  signal.partition = {
    label: 'A-1',
    semanticStatus: 'opaque-user-confirmation-required',
  };
  plan.partitionClarifications = [
    {
      did: signal.device.did,
      deviceName: signal.device.name,
      roomName: signal.device.roomName,
      labels: [{ label: 'A-1', siid: signal.selector.siid, piid: signal.selector.piid }],
      askAfterObservation: true,
      sourceOfTruth: 'Mi Home app',
    },
  ];
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });

  const firstFinish = await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'finish',
        '--study-dir',
        fake.studyDir,
        '--base-url',
        baseUrl,
        '--session-file',
        fake.sessionFile,
      ],
      { from: 'user' },
    ),
  );
  assert.equal(firstFinish[0].phase, 'awaiting-clarification');
  const question = firstFinish[0].questions[0];
  const clarificationMapPath = join(fake.studyDir, 'device-map.private.json');
  const clarificationMap = JSON.parse(await readFile(clarificationMapPath, 'utf8'));
  assert.equal((await stat(clarificationMapPath)).mode & 0o777, 0o600);
  assert.ok(
    clarificationMap.devices.some(({ deviceKey }) => deviceKey === question.deviceKey),
    'each anonymous clarification target must be resolvable through the private device map',
  );
  assert.equal(firstFinish[0].privateDeviceMapFile, clarificationMapPath);
  assert.deepEqual(
    question.unresolvedRegions.map(({ label }) => label),
    ['A-1'],
  );

  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'clarify',
        '--study-dir',
        fake.studyDir,
        '--subject',
        JSON.stringify({
          kind: 'region-label',
          deviceKey: question.deviceKey,
          label: 'A-1',
          mapBank: 'A',
        }),
        '--value',
        '{"did":"syntheticDid"}',
      ],
      { from: 'user' },
    ),
    /raw device identifier|correction keys/,
  );
  await assert.rejects(
    buildProgram().parseAsync(
      [
        'learn',
        'clarify',
        '--study-dir',
        fake.studyDir,
        '--subject',
        JSON.stringify({
          kind: 'region-label',
          deviceKey: question.deviceKey,
          label: 'A-1',
          mapBank: 'A',
        }),
        '--value',
        '{"meaning":"测试灯旁边"}',
      ],
      { from: 'user' },
    ),
    /raw device identifier/,
  );
  await assert.rejects(readFile(join(fake.studyDir, 'corrections.ndjson'), 'utf8'), /ENOENT/);

  await captureStdout(() =>
    buildProgram().parseAsync(
      [
        'learn',
        'clarify',
        '--study-dir',
        fake.studyDir,
        '--subject',
        JSON.stringify({
          kind: 'region-label',
          deviceKey: question.deviceKey,
          label: 'A-1',
          mapBank: 'A',
        }),
        '--value',
        '{"meaning":"desk-side area"}',
      ],
      { from: 'user' },
    ),
  );
  const completed = await captureStdout(() =>
    buildProgram().parseAsync(['learn', 'finish', '--study-dir', fake.studyDir], { from: 'user' }),
  );
  assert.equal(completed[0].phase, 'complete');
  const profile = JSON.parse(await readFile(join(fake.studyDir, 'profile.json'), 'utf8'));
  assert.equal(profile.userConfirmed.length, 1);
  assert.equal(profile.userConfirmed[0].subject.label, 'A-1');
  assert.equal(profile.userConfirmed[0].value.meaning, 'desk-side area');
});
