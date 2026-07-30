import assert from 'node:assert/strict';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

const studyModuleUrl = new URL('../dist/usecases/habit-learning-study.js', import.meta.url).href;
const schemaModuleUrl = new URL('../dist/schemas/habit-learning-study.js', import.meta.url).href;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const QUESTION_ID = 'c'.repeat(64);
const STUDY_ID = '00000000-0000-4000-8000-000000000001';

test('defines the private artifact contract and writes every owned artifact with private modes', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-artifacts-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const studyPath = join(parent, 'study');
  const previousUmask = process.umask(0o000);

  try {
    const { HabitLearningPrivateArtifacts, createInitialHabitLearningStudySession } = await import(
      studyModuleUrl
    );
    const artifacts = new HabitLearningPrivateArtifacts({ path: studyPath });
    await artifacts.initialize();

    assert.equal(artifacts.paths.session, join(studyPath, 'session.json'));
    assert.equal(artifacts.paths.plan, join(studyPath, 'plan.json'));
    assert.equal(artifacts.paths.coverage, join(studyPath, 'coverage.json'));
    assert.equal(artifacts.paths.inventory, join(studyPath, 'inventory.private.json'));
    assert.equal(artifacts.paths.deviceMap, join(studyPath, 'device-map.private.json'));
    assert.equal(artifacts.paths.specs, join(studyPath, 'specs'));
    assert.equal(artifacts.paths.graph, join(studyPath, 'graphs', 'rule.json'));
    assert.equal(artifacts.paths.captureState, join(studyPath, 'state.json'));
    assert.equal(artifacts.paths.journal, join(studyPath, 'journal.ndjson'));
    assert.equal(artifacts.paths.gaps, join(studyPath, 'gaps.ndjson'));
    assert.equal(artifacts.paths.corrections, join(studyPath, 'corrections.ndjson'));
    assert.equal(artifacts.paths.profile, join(studyPath, 'profile.json'));
    assert.equal(artifacts.paths.profileMarkdown, join(studyPath, 'profile.md'));
    assert.equal(artifacts.paths.handoff, join(studyPath, 'handoff.md'));

    const session = createInitialHabitLearningStudySession({
      studyId: STUDY_ID,
      now: '2026-07-30T00:00:00.000Z',
    });
    await artifacts.writeSession(session);
    await artifacts.writeJson('plan', { planVersion: 1 });
    await artifacts.writeJson('coverage', { plannedSignals: 3 });
    await artifacts.writeJson('inventory', { privateDeviceCount: 2 });
    await artifacts.writeJson('deviceMap', {
      mapVersion: 1,
      devices: [
        {
          deviceKey: `device_${'d'.repeat(32)}`,
          did: 'private-did',
          name: 'Private device',
          model: 'vendor.sensor.v1',
          roomId: 'private-room',
          roomName: 'Private room',
        },
      ],
    });
    await artifacts.writeJson('graph', { ruleId: 'R1', output: [] });
    await artifacts.writeJson('profile', { privacy: { containsRawDeviceIdentifiers: false } });
    await artifacts.writeText('profileMarkdown', '# Private profile\n');
    await artifacts.writeText('handoff', '# Resume here\n');
    const specPath = await artifacts.writeSpec('urn:miot-spec-v2:device:synthetic:0000A001', {
      type: 'urn:miot-spec-v2:device:synthetic:0000A001',
    });
    await artifacts.studyStore.writeState({ version: 1, committedBatchSequence: 0 });
    await artifacts.studyStore.appendJournal([{ recordType: 'synthetic-batch' }]);
    await fs.writeFile(artifacts.paths.gaps, '{"kind":"synthetic"}\n', { mode: 0o600 });
    await artifacts.appendCorrections([{ correctionVersion: 1, correctionId: SHA_A }]);

    assert.equal(
      basename(specPath),
      `${await sha256('urn:miot-spec-v2:device:synthetic:0000A001')}.json`,
    );
    assert.deepEqual(await artifacts.readSpec('urn:miot-spec-v2:device:synthetic:0000A001'), {
      type: 'urn:miot-spec-v2:device:synthetic:0000A001',
    });
    assert.deepEqual(await artifacts.readSession(), session);
    assert.deepEqual(await artifacts.readJson('plan'), { planVersion: 1 });
    assert.equal((await artifacts.readJson('deviceMap')).devices[0].did, 'private-did');
    await assert.rejects(
      artifacts.writeJson('deviceMap', { gatewayLoginCode: '123456' }),
      /login-code field/,
    );
    assert.equal((await artifacts.readJson('deviceMap')).devices[0].did, 'private-did');
    assert.equal(await artifacts.readText('handoff'), '# Resume here\n');
    assert.deepEqual(await artifacts.readCorrections(), [
      { correctionVersion: 1, correctionId: SHA_A },
    ]);

    assert.equal((await fs.stat(studyPath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(artifacts.paths.specs)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(artifacts.paths.graphs)).mode & 0o777, 0o700);
    for (const path of [
      artifacts.paths.session,
      artifacts.paths.plan,
      artifacts.paths.coverage,
      artifacts.paths.inventory,
      artifacts.paths.deviceMap,
      artifacts.paths.graph,
      artifacts.paths.captureState,
      artifacts.paths.journal,
      artifacts.paths.gaps,
      artifacts.paths.corrections,
      artifacts.paths.profile,
      artifacts.paths.profileMarkdown,
      artifacts.paths.handoff,
      specPath,
    ]) {
      assert.equal((await fs.stat(path)).mode & 0o777, 0o600, path);
    }
  } finally {
    process.umask(previousUmask);
  }
});

test('validates the complete resumable lifecycle and rejects rollback or identity drift', async () => {
  const { assertHabitLearningStudyTransition, createInitialHabitLearningStudySession } =
    await import(studyModuleUrl);
  const initial = createInitialHabitLearningStudySession({
    studyId: STUDY_ID,
    now: '2026-07-30T00:00:00.000Z',
  });
  const ruleDisabled = {
    ruleId: 'R100',
    expectedEnabled: false,
    semanticDigest: SHA_A,
    layoutDigest: SHA_B,
    lastReadbackAt: '2026-07-30T00:01:00.000Z',
  };

  const ready = assertHabitLearningStudyTransition(initial, {
    ...initial,
    phase: 'ready-disabled',
    revision: 1,
    rule: ruleDisabled,
    timestamps: {
      ...initial.timestamps,
      updatedAt: '2026-07-30T00:01:00.000Z',
      readyDisabledAt: '2026-07-30T00:01:00.000Z',
    },
  });
  const observing = assertHabitLearningStudyTransition(ready, {
    ...ready,
    phase: 'observing',
    revision: 2,
    rule: { ...ready.rule, expectedEnabled: true },
    timestamps: {
      ...ready.timestamps,
      updatedAt: '2026-07-30T00:02:00.000Z',
      observationStartedAt: '2026-07-30T00:02:00.000Z',
    },
  });
  const degraded = assertHabitLearningStudyTransition(observing, {
    ...observing,
    phase: 'observing-degraded',
    revision: 3,
    degradedReasonCodes: ['gateway-window-gapped'],
    timestamps: {
      ...observing.timestamps,
      updatedAt: '2026-07-30T00:03:00.000Z',
      degradedAt: '2026-07-30T00:03:00.000Z',
    },
  });
  const finishing = assertHabitLearningStudyTransition(degraded, {
    ...degraded,
    phase: 'finishing',
    revision: 4,
    timestamps: {
      ...degraded.timestamps,
      updatedAt: '2026-07-30T00:04:00.000Z',
      finishingStartedAt: '2026-07-30T00:04:00.000Z',
    },
    finish: {
      stage: 'final-capture-pending',
      attempts: 1,
      pendingClarifications: [],
    },
  });
  const captured = assertHabitLearningStudyTransition(finishing, {
    ...finishing,
    revision: 5,
    timestamps: {
      ...finishing.timestamps,
      updatedAt: '2026-07-30T00:05:00.000Z',
      finalCaptureCommittedAt: '2026-07-30T00:05:00.000Z',
    },
    finish: {
      ...finishing.finish,
      stage: 'disable-pending',
    },
  });
  const disabled = assertHabitLearningStudyTransition(captured, {
    ...captured,
    revision: 6,
    rule: {
      ...captured.rule,
      expectedEnabled: false,
      lastReadbackAt: '2026-07-30T00:06:00.000Z',
    },
    timestamps: {
      ...captured.timestamps,
      updatedAt: '2026-07-30T00:06:00.000Z',
      disableRequestedAt: '2026-07-30T00:05:30.000Z',
      disableReadbackAt: '2026-07-30T00:06:00.000Z',
    },
    finish: {
      ...captured.finish,
      stage: 'clarification-pending',
    },
  });
  const awaiting = assertHabitLearningStudyTransition(disabled, {
    ...disabled,
    phase: 'awaiting-clarification',
    revision: 7,
    timestamps: {
      ...disabled.timestamps,
      updatedAt: '2026-07-30T00:07:00.000Z',
      clarificationPreparedAt: '2026-07-30T00:07:00.000Z',
    },
    finish: {
      stage: 'awaiting-clarification',
      attempts: 1,
      pendingClarifications: [
        {
          questionId: QUESTION_ID,
          subject: 'device_canonical:region:A-1',
          createdAt: '2026-07-30T00:07:00.000Z',
        },
      ],
    },
  });
  const profilePending = assertHabitLearningStudyTransition(awaiting, {
    ...awaiting,
    revision: 8,
    timestamps: {
      ...awaiting.timestamps,
      updatedAt: '2026-07-30T00:08:00.000Z',
    },
    finish: {
      ...awaiting.finish,
      stage: 'profile-pending',
      pendingClarifications: [],
    },
  });
  const complete = assertHabitLearningStudyTransition(profilePending, {
    ...profilePending,
    phase: 'complete',
    revision: 9,
    timestamps: {
      ...profilePending.timestamps,
      updatedAt: '2026-07-30T00:09:00.000Z',
      profileWrittenAt: '2026-07-30T00:09:00.000Z',
      completedAt: '2026-07-30T00:09:00.000Z',
    },
    finish: {
      ...profilePending.finish,
      stage: 'complete',
    },
  });

  assert.equal(complete.phase, 'complete');
  assert.equal(complete.rule.expectedEnabled, false);
  assert.equal(complete.finish.stage, 'complete');
  assert.equal(complete.finish.pendingClarifications.length, 0);

  const firstHealthyCapture = assertHabitLearningStudyTransition(observing, {
    ...observing,
    revision: 3,
    timestamps: {
      ...observing.timestamps,
      updatedAt: '2026-07-30T00:02:30.000Z',
      lastHealthyCaptureAt: '2026-07-30T00:02:30.000Z',
    },
  });
  const secondHealthyCapture = assertHabitLearningStudyTransition(firstHealthyCapture, {
    ...firstHealthyCapture,
    revision: 4,
    timestamps: {
      ...firstHealthyCapture.timestamps,
      updatedAt: '2026-07-30T00:02:45.000Z',
      lastHealthyCaptureAt: '2026-07-30T00:02:45.000Z',
    },
  });
  assert.equal(secondHealthyCapture.timestamps.lastHealthyCaptureAt, '2026-07-30T00:02:45.000Z');
  assert.throws(
    () =>
      assertHabitLearningStudyTransition(secondHealthyCapture, {
        ...secondHealthyCapture,
        revision: 5,
        timestamps: {
          ...secondHealthyCapture.timestamps,
          updatedAt: '2026-07-30T00:03:00.000Z',
          lastHealthyCaptureAt: '2026-07-30T00:02:00.000Z',
        },
      }),
    /lastHealthyCaptureAt cannot regress/,
  );

  assert.throws(
    () =>
      assertHabitLearningStudyTransition(ready, {
        ...ready,
        phase: 'complete',
        revision: 2,
        timestamps: {
          ...ready.timestamps,
          updatedAt: '2026-07-30T00:02:00.000Z',
          completedAt: '2026-07-30T00:02:00.000Z',
        },
      }),
    /Invalid habit-learning phase transition|finish checkpoint is required/,
  );
  assert.throws(
    () =>
      assertHabitLearningStudyTransition(ready, {
        ...ready,
        revision: 3,
        timestamps: { ...ready.timestamps, updatedAt: '2026-07-30T00:02:00.000Z' },
      }),
    /revision must advance exactly once/,
  );
  assert.throws(
    () =>
      assertHabitLearningStudyTransition(ready, {
        ...ready,
        revision: 2,
        rule: { ...ready.rule, semanticDigest: 'd'.repeat(64) },
        timestamps: { ...ready.timestamps, updatedAt: '2026-07-30T00:02:00.000Z' },
      }),
    /semanticDigest is immutable/,
  );
  assert.throws(
    () =>
      assertHabitLearningStudyTransition(captured, {
        ...captured,
        revision: 6,
        timestamps: {
          ...captured.timestamps,
          updatedAt: '2026-07-30T00:06:00.000Z',
        },
        finish: { ...captured.finish, stage: 'final-capture-pending' },
      }),
    /finish stage cannot regress/,
  );
});

test('serializes lifecycle checkpoints and rejects a stale concurrent transition', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-session-race-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const { HabitLearningPrivateArtifacts, createInitialHabitLearningStudySession } = await import(
    studyModuleUrl
  );
  const studyPath = join(parent, 'study');
  const first = new HabitLearningPrivateArtifacts({ path: studyPath });
  const second = new HabitLearningPrivateArtifacts({ path: studyPath });
  const initial = await first.writeSession(
    createInitialHabitLearningStudySession({
      studyId: STUDY_ID,
      now: '2026-07-30T00:00:00.000Z',
    }),
  );
  const baseReady = {
    ...initial,
    phase: 'ready-disabled',
    revision: 1,
    rule: {
      ruleId: 'R-race',
      expectedEnabled: false,
      semanticDigest: SHA_A,
      layoutDigest: SHA_B,
    },
    timestamps: {
      ...initial.timestamps,
      updatedAt: '2026-07-30T00:01:00.000Z',
      readyDisabledAt: '2026-07-30T00:01:00.000Z',
    },
  };
  const results = await Promise.allSettled([
    first.transitionSession(initial, {
      ...baseReady,
      rule: {
        ...baseReady.rule,
        lastReadbackAt: '2026-07-30T00:00:30.000Z',
      },
    }),
    second.transitionSession(initial, {
      ...baseReady,
      rule: {
        ...baseReady.rule,
        lastReadbackAt: '2026-07-30T00:00:45.000Z',
      },
    }),
  ]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  const rejected = results.find(({ status }) => status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.match(String(rejected.reason), /session changed concurrently/);
  assert.equal((await first.readSession()).revision, 1);
  await assert.rejects(
    first.writeSession({ ...initial, revision: 2 }),
    /use transitionSession for replacement/,
  );
});

test('schema requires phase recovery fields and never accepts authentication material', async () => {
  const { HabitLearningStudySessionSchema } = await import(schemaModuleUrl);
  const { assertNoGatewayLoginCode, createInitialHabitLearningStudySession } = await import(
    studyModuleUrl
  );
  const initial = createInitialHabitLearningStudySession({
    studyId: STUDY_ID,
    now: '2026-07-30T00:00:00.000Z',
  });

  assert.throws(
    () =>
      HabitLearningStudySessionSchema.parse({
        ...initial,
        phase: 'observing',
        rule: {
          ruleId: 'R1',
          expectedEnabled: true,
          semanticDigest: SHA_A,
          layoutDigest: SHA_B,
        },
      }),
    /observationStartedAt/,
  );
  assert.throws(
    () => HabitLearningStudySessionSchema.parse({ ...initial, loginCode: '123456' }),
    /Unrecognized key/,
  );
  assert.throws(() => assertNoGatewayLoginCode({ gatewayLoginCode: '123456' }), /login-code field/);
  assert.throws(() => assertNoGatewayLoginCode({ 登录码: '123456' }), /login-code field/);
  assert.throws(() => assertNoGatewayLoginCode('新的六位登录码是：123456'), /gateway login code/);
  assert.throws(() => assertNoGatewayLoginCode('login code is 123456'), /gateway login code/);
  assert.doesNotThrow(() => assertNoGatewayLoginCode({ deviceCode: '123456' }));
});

test('Git leak guard is pure and an injected unsafe result blocks creation', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-git-guard-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const studyPath = join(parent, 'must-not-exist');
  const {
    HabitLearningPrivateArtifacts,
    assessHabitLearningGitLeakRisk,
    assertHabitLearningGitLeakGuard,
  } = await import(studyModuleUrl);

  assert.deepEqual(
    assessHabitLearningGitLeakRisk({
      insideWorkTree: false,
      tracked: false,
      ignored: false,
    }),
    { safe: true, reason: 'outside-work-tree' },
  );
  assert.deepEqual(
    assessHabitLearningGitLeakRisk({
      insideWorkTree: true,
      tracked: false,
      ignored: true,
    }),
    { safe: true, reason: 'ignored-private-path' },
  );
  assert.throws(
    () =>
      assertHabitLearningGitLeakGuard({
        insideWorkTree: true,
        tracked: true,
        ignored: true,
      }),
    /tracked Git path/,
  );

  let inspectedPath;
  const artifacts = new HabitLearningPrivateArtifacts({
    path: studyPath,
    inspectGitExposure: (path) => {
      inspectedPath = path;
      return { insideWorkTree: true, tracked: false, ignored: false };
    },
  });
  await assert.rejects(artifacts.initialize(), /unignored Git path/);
  assert.equal(inspectedPath, studyPath);
  await assert.rejects(fs.access(studyPath, fsConstants.F_OK), { code: 'ENOENT' });
});

test('refuses symlink directories and files without modifying their targets', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-artifact-symlink-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const { HabitLearningPrivateArtifacts } = await import(studyModuleUrl);

  const studyWithLinkedSpecs = join(parent, 'linked-specs-study');
  const specsTarget = join(parent, 'specs-target');
  await fs.mkdir(studyWithLinkedSpecs);
  await fs.mkdir(specsTarget);
  await fs.symlink(specsTarget, join(studyWithLinkedSpecs, 'specs'));
  await assert.rejects(
    new HabitLearningPrivateArtifacts({ path: studyWithLinkedSpecs }).initialize(),
    /symbolic-link habit-learning specs directory/,
  );
  assert.deepEqual(await fs.readdir(specsTarget), []);

  const studyPath = join(parent, 'study');
  const artifacts = new HabitLearningPrivateArtifacts({ path: studyPath });
  await artifacts.initialize();
  const deviceMapTarget = join(parent, 'device-map-target.json');
  await fs.writeFile(deviceMapTarget, '{"keep":true}\n', { mode: 0o600 });
  await fs.symlink(deviceMapTarget, artifacts.paths.deviceMap);
  await assert.rejects(artifacts.writeJson('deviceMap', { replace: true }), /symbolic-link/);
  assert.equal(await fs.readFile(deviceMapTarget, 'utf8'), '{"keep":true}\n');

  const correctionTarget = join(parent, 'correction-target.ndjson');
  await fs.writeFile(correctionTarget, '{"keep":true}\n', { mode: 0o600 });
  await fs.symlink(correctionTarget, artifacts.paths.corrections);
  await assert.rejects(artifacts.appendCorrections([{ correctionId: SHA_A }]), /symbolic-link/);
  assert.equal(await fs.readFile(correctionTarget, 'utf8'), '{"keep":true}\n');
});

test('atomic replacement publishes complete JSON and cleans temporary files', async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'xgg-habit-artifact-atomic-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const { HabitLearningPrivateArtifacts } = await import(studyModuleUrl);
  const artifacts = new HabitLearningPrivateArtifacts({ path: join(parent, 'study') });
  await artifacts.writeJson('plan', { sequence: 1 });

  const originalRename = fs.rename;
  let inspected = false;
  fs.rename = async (from, to) => {
    if (to === artifacts.paths.plan) {
      inspected = true;
      assert.equal((await fs.stat(from)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await fs.readFile(from, 'utf8')), { sequence: 2 });
      assert.deepEqual(JSON.parse(await fs.readFile(to, 'utf8')), { sequence: 1 });
    }
    return originalRename.call(fs, from, to);
  };

  try {
    await artifacts.writeJson('plan', { sequence: 2 });
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(inspected, true);
  assert.deepEqual(await artifacts.readJson('plan'), { sequence: 2 });
  assert.deepEqual(
    (await fs.readdir(artifacts.paths.study)).filter((entry) => entry.endsWith('.tmp')),
    [],
  );
});

async function sha256(value) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
