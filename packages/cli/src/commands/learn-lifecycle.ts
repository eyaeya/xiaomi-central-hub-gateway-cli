import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type CompiledHabitLearningRule,
  ConfigError,
  type HabitLearningAnalysisGap,
  type HabitLearningAnalysisSourceSemantics,
  type HabitLearningAnonymousDeviceKey,
  type HabitLearningAutomationConstraintInput,
  type HabitLearningCaptureBatchRecord,
  type HabitLearningCaptureGapRecord,
  HabitLearningCaptureSupervisor,
  type HabitLearningCorrection,
  type HabitLearningJsonValue,
  type HabitLearningObservedRegion,
  type HabitLearningObservedSignalCoverage,
  type HabitLearningPlan,
  HabitLearningPrivateArtifacts,
  type HabitLearningProfile,
  type HabitLearningProfileHypothesisInput,
  type HabitLearningProfileObservationInput,
  type HabitLearningRegionClarificationQuestion,
  type HabitLearningStudySession,
  assertCompiledHabitLearningRule,
  assessHabitLearningProfileCompleteness,
  buildHabitLearningProfileEvidence,
  buildHabitLearningRegionClarificationQuestions,
  compileHabitLearningRule,
  createHabitLearningCorrection,
  createInitialHabitLearningStudySession,
  createRule,
  createStore,
  createVariable,
  deriveHabitLearningAnonymousDeviceKey,
  deriveHabitLearningHypotheses,
  disableRule,
  dumpBeforeWrite,
  enableRule,
  evaluateHabitLearningProfileFreshness,
  exportLocalBackup,
  fetchRuleLogs,
  freezeHabitLearningSourceMap,
  generateHabitLearningProfile,
  getDeviceSpec,
  getRule,
  habitLearningRuleLayoutDigest,
  habitLearningRuleSemanticDigest,
  isMissingScopeError,
  lintGraph,
  listAvailVarsForRule,
  listDevices,
  listRules,
  listVariables,
  normalizeHabitLearningObservations,
  planHabitLearning,
  resolveHabitLearningCorrectionsAsOf,
  setGraph,
  validateGraph,
} from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import { parseJsonInput, parsePositiveTimerMs } from '../local-input.js';
import { emit } from '../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
  runMutationWorkflow,
} from './_mutation-guard.js';
import { collectHabitLearningPlannerInputs } from './learn-inputs.js';

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CAPTURE_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_PROFILE_EXPIRY_MS = 30 * DAY_MS;
const STUDY_ARTIFACT_VERSION = 1;
const FOLLOW_OWNER_FILE = 'capture-supervisor.json';
const PROFILE_SECRET_FILE = '.capture-hmac.key';
const START_INTENT_FILE = 'start-intent.json';
const DEFAULT_STUDY_NAME = '家庭生活习惯学习';
const DEFAULT_STUDY_DURATION_DAYS = 7;
const DEFAULT_BASELINE_QUIET_MS = 2_000;
const DEFAULT_BASELINE_HARD_CAP_MS = 60_000;
const DEFAULT_EPISODE_DEBOUNCE_MS = 5_000;

interface CommonGatewayOptions {
  studyDir: string;
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
}

interface StartOptions extends CommonGatewayOptions {
  name: string;
  durationDays: string;
  includeContext?: boolean;
  includeSensitive?: boolean;
  planId?: string;
  baselineQuietMs: string;
  baselineHardCapMs: string;
  debounceMs: string;
  excludeDevice?: string[];
  excludeRoom?: string[];
  enable?: boolean;
  snapshotsDir?: string;
  refreshHint?: boolean;
}

interface CaptureOptions extends CommonGatewayOptions {
  follow?: boolean;
  interval: string;
}

interface StatusOptions extends CommonGatewayOptions {
  localOnly?: boolean;
}

interface ClarifyOptions {
  studyDir: string;
  subject: string;
  value: string;
  source: 'user-mi-home-app' | 'user-direct' | 'user-import';
  asOf?: string;
  supersedes?: string;
  pretty?: boolean;
}

interface FinishOptions extends CommonGatewayOptions {
  snapshotsDir?: string;
  refreshHint?: boolean;
}

interface ProfileOptions extends CommonGatewayOptions {
  minimumCompleteness: 'sufficient' | 'bounded';
  localOnly?: boolean;
}

interface StudyStartIntent {
  version: 1;
  ruleName: string;
  durationDays: number;
  timezone: string;
  includeContext: boolean;
  includeSensitive: boolean;
  excludedDeviceIds: string[];
  excludedRoomIds: string[];
  baselineQuietMs: number;
  baselineHardCapMs: number;
  debounceMs: number;
}

interface StudyCoverageArtifact {
  artifactVersion: typeof STUDY_ARTIFACT_VERSION;
  plannedStartAt: string;
  plannedEndAt: string;
  durationDays: number;
  reviewedPlanId?: string;
  analysis: {
    timezone: string;
    baselineQuietMs: number;
    baselineHardCapMs: number;
    debounceMs: number;
  };
  specFetch: {
    attemptedDeviceCount: number;
    loadedDeviceCount: number;
    failedDeviceCount: number;
  };
  specFailures: Array<{
    urn: string;
    code: string;
  }>;
  compilation: {
    compileVersion: number;
    planId: string;
    planGraphId: string;
    localVariables: CompiledHabitLearningRule['localVariables'];
    sourceMap: CompiledHabitLearningRule['sourceMap'];
    digests: CompiledHabitLearningRule['digests'];
  };
  observed?: {
    generatedAt: string;
    devices: RuntimeDeviceCoverage;
    rooms: RuntimeRoomCoverage;
    signals: RuntimeSignalCoverage;
    gapCount: number;
  };
}

interface CoverageIdSet {
  count: number;
  ids: string[];
}

interface CoverageExcludedSignalSet extends CoverageIdSet {
  details: Array<{
    signalId: string;
    reasonCodes: string[];
  }>;
}

interface RuntimeSignalCoverage {
  observable: CoverageIdSet;
  included: CoverageIdSet;
  expectedPreload: CoverageIdSet;
  baselineSeen: CoverageIdSet;
  behaviorObserved: CoverageIdSet;
  baselineOnly: CoverageIdSet;
  stateAnchorOnly: CoverageIdSet;
  ambiguous: CoverageIdSet;
  missing: CoverageIdSet;
  excluded: CoverageExcludedSignalSet;
}

interface RuntimeDeviceCoverage {
  visible: CoverageIdSet;
  included: CoverageIdSet;
  excluded: CoverageIdSet & {
    details: Array<{
      deviceId: string;
      reasonCodes: string[];
    }>;
  };
  behaviorObserved: CoverageIdSet;
  baselineOnly: CoverageIdSet;
  ambiguous: CoverageIdSet;
  missing: CoverageIdSet;
  details: Array<{
    deviceId: string;
    roomId: string;
    status: HabitLearningPlan['deviceCoverage'][number]['status'];
    observableSignalIds: string[];
    includedSignalIds: string[];
    behaviorObservedSignalIds: string[];
    baselineSeenSignalIds: string[];
    baselineOnlySignalIds: string[];
    ambiguousSignalIds: string[];
    missingSignalIds: string[];
    excludedSignals: Array<{
      signalId: string;
      reasonCodes: string[];
    }>;
  }>;
}

interface RuntimeRoomCoverage {
  visible: CoverageIdSet;
  included: CoverageIdSet;
  excluded: CoverageIdSet;
  behaviorObserved: CoverageIdSet;
  baselineOnly: CoverageIdSet;
  ambiguous: CoverageIdSet;
  missing: CoverageIdSet;
  details: Array<{
    roomId: string;
    roomName: string;
    deviceCount: number;
    candidateSignalCount: number;
    includedSignalCount: number;
    behaviorObservedSignalCount: number;
    baselineSeenSignalCount: number;
    baselineOnlySignalCount: number;
    ambiguousSignalCount: number;
    missingSignalCount: number;
    excludedSignals: Array<{
      signalId: string;
      reasonCodes: string[];
    }>;
  }>;
}

interface CaptureJournalData {
  batches: HabitLearningCaptureBatchRecord[];
  gaps: HabitLearningCaptureGapRecord[];
  entries: HabitLearningCaptureBatchRecord['entries'];
}

interface FollowOwner {
  version: 1;
  token: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  lastOutcome?: string;
  nextPollAt?: string;
}

export function attachHabitLearningLifecycle(command: Command): void {
  attachStart(command);
  attachCapture(command);
  attachStatus(command);
  attachClarify(command);
  attachFinish(command);
  attachProfile(command);
}

function attachStart(command: Command): void {
  const sub = command
    .command('start')
    .description(
      'Create or resume one private, disabled, observation-only study graph; enable only with --enable',
    )
    .requiredOption('--study-dir <path>', 'private ignored/out-of-repository study directory')
    .option('--name <name>', 'rule name shown in Mi Home', DEFAULT_STUDY_NAME)
    .option(
      '--duration-days <days>',
      'planned observation duration from 1 to 7 days',
      String(DEFAULT_STUDY_DURATION_DAYS),
    )
    .option('--include-context', 'include general P1 environmental context signals')
    .option(
      '--include-sensitive',
      'include eligible sensitive signals (never restricted IDs/media)',
    )
    .option('--plan-id <sha256>', 'reviewed plan ID required before --enable')
    .option(
      '--baseline-quiet-ms <ms>',
      'quiet window after enable used to classify preload rows',
      String(DEFAULT_BASELINE_QUIET_MS),
    )
    .option(
      '--baseline-hard-cap-ms <ms>',
      'maximum preload-classification window after enable',
      String(DEFAULT_BASELINE_HARD_CAP_MS),
    )
    .option(
      '--debounce-ms <ms>',
      'inactive gap merged inside one parameter episode',
      String(DEFAULT_EPISODE_DEBOUNCE_MS),
    )
    .option('--exclude-device <did...>', 'exclude one or more device IDs')
    .option('--exclude-room <room-id...>', 'exclude one or more room IDs')
    .option('--enable', 'explicitly enable only after create, validation, and live readback')
    .option('--snapshots-dir <path>', 'pre-write snapshot directory (default: study/snapshots)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'gateway and MIoT request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addRefreshHintFlag(sub)
    .addHelpText(
      'after',
      `
The command writes an official local backup before the first gateway mutation.
It creates exactly one rule, no physical outputs, no loop, and rule-local
capture variables. Without --enable the verified graph remains disabled.

Example:
  $ xgg learn start --study-dir .xgg-private/habit-learning/home-2026-07
  $ xgg learn start --study-dir .xgg-private/habit-learning/home-2026-07 --enable --plan-id <reviewed-plan-id>`,
    )
    .action(
      wrap('learn.start', async (options: StartOptions) => {
        if (options.enable === true && options.planId === undefined) {
          throw new ConfigError(
            '--enable requires --plan-id from a reviewed `xgg learn plan` result or the preceding disabled start result',
          );
        }
        if (options.planId !== undefined && !/^[a-f0-9]{64}$/.test(options.planId.trim())) {
          throw new ConfigError('--plan-id must be a lowercase SHA-256 digest');
        }
        const artifacts = createArtifacts(options.studyDir);
        await artifacts.initialize();
        const lifecycleLease = await acquireFollowLease(artifacts.paths.study);
        try {
          const deps = gatewayDeps(options);
          const snapshotsDir = options.snapshotsDir ?? join(artifacts.paths.study, 'snapshots');
          assertAgentModeOrSnapshotsDir({ snapshotsDir });

          let session = await artifacts.readSession();
          let startIntent = await readStartIntent(artifacts.paths.study);
          if (options.enable === true && session?.phase !== 'ready-disabled') {
            throw new ConfigError(
              'start --enable is allowed only when this invocation begins from a durable ready-disabled checkpoint; rerun without --enable to finish disabled creation/readback, review its planId, then invoke start --enable separately',
              { phaseAtInvocation: session?.phase ?? 'missing' },
            );
          }
          let plan: HabitLearningPlan;
          let compilation: CompiledHabitLearningRule;
          let coverage: StudyCoverageArtifact;
          let inventory: Awaited<ReturnType<typeof listDevices>> | undefined;

          if (session === undefined) {
            if (startIntent === undefined) {
              startIntent = startIntentFromOptions(options);
              await writeStartIntent(artifacts.paths.study, startIntent);
            } else {
              assertFrozenStartOptions(options, startIntent);
            }
            const now = new Date().toISOString();
            session = await artifacts.writeSession(createInitialHabitLearningStudySession({ now }));
          } else {
            if (
              session.phase !== 'preparing' &&
              !(session.phase === 'ready-disabled' && options.enable === true)
            ) {
              throw new ConfigError(
                `study is already in phase ${session.phase}; use learn capture/status/finish instead`,
                { phase: session.phase },
              );
            }
            if (startIntent !== undefined) assertFrozenStartOptions(options, startIntent);
          }

          const persisted = await loadCompilationArtifacts(artifacts, {
            allowIncomplete: startIntent !== undefined && session.rule === undefined,
          });
          if (startIntent === undefined) {
            if (persisted === undefined) {
              throw new ConfigError(
                'study has no durable start intent; preserve the partial artifacts and restart in a new private directory',
              );
            }
            startIntent = startIntentFromArtifacts(
              persisted.plan,
              persisted.coverage,
              persisted.compilation,
            );
            assertFrozenStartOptions(options, startIntent);
            await writeStartIntent(artifacts.paths.study, startIntent);
          }
          assertStartArtifactsMatchIntent(startIntent, persisted);
          if (persisted === undefined) {
            inventory = await listDevices(deps);
            const collected = await collectHabitLearningPlannerInputs(inventory, deps.timeoutMs);
            plan = planHabitLearning({
              devices: collected.devices,
              includeContext: startIntent.includeContext,
              includeSensitive: startIntent.includeSensitive,
              excludedDeviceIds: startIntent.excludedDeviceIds,
              excludedRoomIds: startIntent.excludedRoomIds,
            });
            const ruleId = session.rule?.ruleId ?? String(Date.now());
            compilation = compileHabitLearningRule({
              plan,
              ruleId,
              ruleName: startIntent.ruleName,
            });
            assertCompiledHabitLearningRule(compilation);
            const plannedStart = new Date(session.timestamps.createdAt);
            coverage = {
              artifactVersion: STUDY_ARTIFACT_VERSION,
              plannedStartAt: plannedStart.toISOString(),
              plannedEndAt: new Date(
                plannedStart.getTime() + startIntent.durationDays * DAY_MS,
              ).toISOString(),
              durationDays: startIntent.durationDays,
              analysis: {
                timezone: startIntent.timezone,
                baselineQuietMs: startIntent.baselineQuietMs,
                baselineHardCapMs: startIntent.baselineHardCapMs,
                debounceMs: startIntent.debounceMs,
              },
              specFetch: {
                attemptedDeviceCount: collected.attemptedDeviceCount,
                loadedDeviceCount: collected.loadedDeviceCount,
                failedDeviceCount: collected.specFailures.length,
              },
              specFailures: collected.specFailures.map(({ urn, code }) => ({ urn, code })),
              compilation: compilationArtifact(compilation),
            };

            await artifacts.writeJson('inventory', inventory);
            for (const [urn, spec] of collected.specsByUrn) {
              await artifacts.writeSpec(urn, spec);
            }
            await artifacts.writeJson('plan', plan);
            await artifacts.writeJson('coverage', coverage);
            await artifacts.writeJson('graph', compilation.rule);

            if (session.rule === undefined) {
              session = await transition(artifacts, session, {
                rule: {
                  ruleId: compilation.rule.id,
                  expectedEnabled: false,
                  semanticDigest: compilation.digests.semantic,
                  layoutDigest: compilation.digests.layout,
                },
              });
            }
            await writeHandoff(artifacts, session, coverage);
          } else {
            ({ plan, compilation, coverage } = persisted);
          }

          if (session.rule === undefined) {
            session = await transition(artifacts, session, {
              rule: {
                ruleId: compilation.rule.id,
                expectedEnabled: false,
                semanticDigest: compilation.digests.semantic,
                layoutDigest: compilation.digests.layout,
              },
            });
            await writeHandoff(artifacts, session, coverage);
          } else {
            const rule = requiredRule(session);
            if (
              rule.ruleId !== compilation.rule.id ||
              rule.semanticDigest !== compilation.digests.semantic ||
              rule.layoutDigest !== compilation.digests.layout
            ) {
              throw new ConfigError(
                'frozen compilation artifacts do not match the durable study rule reference',
              );
            }
          }

          if (options.enable === true) {
            assertReviewedPlanId(options.planId, plan.planId);
          }

          if (session.phase === 'preparing') {
            const officialBackup = join(artifacts.paths.study, 'pre-start.bak');
            if (!(await pathExists(officialBackup))) {
              await exportLocalBackup(officialBackup, deps);
            }

            const snapshot = await runMutationWorkflow('learn.start', deps, async () => {
              const snapshotPath = await dumpBeforeWrite({
                ...deps,
                snapshotsDir,
              });
              await reconcileStudyGraph(compilation, deps);
              return snapshotPath;
            });

            const readback = await inspectLiveRule(compilation, deps);
            if (readback.enabled) {
              throw new ConfigError(
                'study graph unexpectedly enabled before explicit enable checkpoint',
                { ruleId: compilation.rule.id },
              );
            }
            session = await transition(artifacts, session, {
              phase: 'ready-disabled',
              rule: {
                ...requiredRule(session),
                expectedEnabled: false,
                lastReadbackAt: new Date().toISOString(),
              },
              timestamps: {
                readyDisabledAt: new Date().toISOString(),
              },
            });
            await writeHandoff(artifacts, session, coverage);

            if (options.enable !== true) {
              emit(
                {
                  ok: true,
                  phase: session.phase,
                  enabled: false,
                  studyDir: artifacts.paths.study,
                  ruleId: compilation.rule.id,
                  graph: {
                    sourceCount: plan.graph.sourceCount,
                    nodeCount: compilation.rule.nodes.length,
                    outputCount: 0,
                  },
                  backup: officialBackup,
                  snapshot,
                  planId: plan.planId,
                  next: `xgg learn start --study-dir ${shellDisplayPath(artifacts.paths.study)} --enable --plan-id ${plan.planId}`,
                },
                { pretty: options.pretty === true },
              );
              printRefreshHint(options, {
                baseUrl: deps.baseUrl,
                context: `habit-learning rule ${compilation.rule.id} (verified disabled)`,
              });
              return;
            }
          }

          if (session.phase !== 'ready-disabled') {
            throw new ConfigError(`cannot enable study from phase ${session.phase}`);
          }
          const currentPlan = await planFromLiveGateway(deps, startIntent);
          if (
            currentPlan.planId !== plan.planId ||
            currentPlan.inventory.inventoryHash !== plan.inventory.inventoryHash
          ) {
            throw new ConfigError(
              'live inventory or MIoT semantics changed after plan review; refusing to enable the frozen study',
              {
                reviewedPlanId: plan.planId,
                livePlanId: currentPlan.planId,
                inventoryChanged:
                  currentPlan.inventory.inventoryHash !== plan.inventory.inventoryHash,
              },
            );
          }
          coverage = {
            ...coverage,
            reviewedPlanId: plan.planId,
          };
          await artifacts.writeJson('coverage', coverage);
          const beforeEnable = await inspectLiveRule(compilation, deps);
          if (!beforeEnable.semanticMatch || !beforeEnable.layoutMatch) {
            throw new ConfigError('study graph drifted before enable; refusing to resume');
          }
          let snapshot: string | undefined;
          if (!beforeEnable.enabled) {
            snapshot = await runMutationWorkflow('learn.start.enable', deps, async () => {
              const snapshotPath = await dumpBeforeWrite({ ...deps, snapshotsDir });
              await enableRule(compilation.rule.id, deps, { getDeviceSpec });
              return snapshotPath;
            });
          }
          await assertLiveRuleMatches(compilation, deps, true);
          const observationStartedAt =
            beforeEnable.enabled && coverage.plannedStartAt !== session.timestamps.createdAt
              ? coverage.plannedStartAt
              : new Date().toISOString();
          coverage = {
            ...coverage,
            plannedStartAt: observationStartedAt,
            plannedEndAt: new Date(
              Date.parse(observationStartedAt) + coverage.durationDays * DAY_MS,
            ).toISOString(),
          };
          await artifacts.writeJson('coverage', coverage);
          const supervisor = captureSupervisor(artifacts, compilation, deps);
          let initialCapture: Awaited<ReturnType<HabitLearningCaptureSupervisor['captureOnce']>>;
          let tailRecovery: Awaited<
            ReturnType<HabitLearningCaptureSupervisor['recoverPartialTails']>
          >;
          session = await transition(artifacts, session, {
            phase: 'observing',
            rule: {
              ...requiredRule(session),
              expectedEnabled: true,
              lastReadbackAt: observationStartedAt,
            },
            timestamps: { observationStartedAt },
          });
          tailRecovery = await supervisor.recoverPartialTails();
          initialCapture = await supervisor.captureOnce();
          session = await applyCaptureOutcome(artifacts, session, initialCapture);
          session = await failSafeDisableSemanticDrift({
            artifacts,
            compilation,
            coverage,
            deps,
            result: initialCapture,
            session,
            snapshotsDir,
          });
          await writeHandoff(artifacts, session, coverage);
          if (initialCapture.outcome !== 'captured') {
            throw new ConfigError(
              'initial capture did not commit; durable gap/state were preserved and confirmed semantic drift was fail-safe disabled',
              {
                phase: session.phase,
                ruleId: compilation.rule.id,
                tailRecovery,
                capture: publicCaptureResult(initialCapture),
                next:
                  session.phase === 'finishing'
                    ? `xgg learn finish --study-dir ${shellDisplayPath(artifacts.paths.study)}`
                    : `xgg learn capture --study-dir ${shellDisplayPath(artifacts.paths.study)}`,
              },
            );
          }
          emit(
            {
              ok: true,
              phase: session.phase,
              enabled: true,
              studyDir: artifacts.paths.study,
              ruleId: compilation.rule.id,
              graph: {
                sourceCount: plan.graph.sourceCount,
                nodeCount: compilation.rule.nodes.length,
                outputCount: 0,
              },
              tailRecovery,
              capture: publicCaptureResult(initialCapture),
              snapshot,
              plannedEndAt: coverage.plannedEndAt,
              next: `xgg learn capture --study-dir ${shellDisplayPath(artifacts.paths.study)} --follow`,
            },
            { pretty: options.pretty === true },
          );
          printRefreshHint(options, {
            baseUrl: deps.baseUrl,
            context: `habit-learning rule ${compilation.rule.id} (enabled after readback)`,
          });
        } finally {
          await releaseFollowLease(lifecycleLease);
        }
      }),
    );
}

function attachCapture(command: Command): void {
  command
    .command('capture')
    .description('Persist one incremental log window, or supervise repeated capture in foreground')
    .requiredOption('--study-dir <path>', 'private study directory')
    .option('--follow', 'keep capturing until SIGINT/SIGTERM; enforces one supervisor process')
    .option(
      '--interval <ms>',
      'follow-mode poll and heartbeat interval',
      String(DEFAULT_CAPTURE_INTERVAL_MS),
    )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      `
Each successful batch is fsynced before its checkpoint advances. Follow mode
writes a private PID/heartbeat owner and refuses a second live supervisor.

Example:
  $ xgg learn capture --study-dir .xgg-private/habit-learning/home-2026-07 --follow`,
    )
    .action(
      wrap('learn.capture', async (options: CaptureOptions) => {
        const artifacts = createArtifacts(options.studyDir);
        const session = await requireStudySession(artifacts);
        assertCapturablePhase(session);
        const persisted = await requireCompilationArtifacts(artifacts);
        const deps = gatewayDeps(options);
        const intervalMs = parsePositiveTimerMs(options.interval, '--interval');
        const supervisor = captureSupervisor(artifacts, persisted.compilation, deps);

        if (options.follow !== true) {
          const lease = await acquireFollowLease(artifacts.paths.study);
          try {
            const lockedSession = await requireStudySession(artifacts);
            assertCapturablePhase(lockedSession);
            const tailRecovery = await supervisor.recoverPartialTails();
            const result = await supervisor.captureOnce();
            let nextSession = await applyCaptureOutcome(artifacts, lockedSession, result);
            nextSession = await failSafeDisableSemanticDrift({
              artifacts,
              compilation: persisted.compilation,
              coverage: persisted.coverage,
              deps,
              result,
              session: nextSession,
              snapshotsDir: join(artifacts.paths.study, 'snapshots'),
            });
            if (result.outcome !== 'captured') {
              throw new ConfigError(
                'capture did not commit; durable gap/state were preserved and confirmed semantic drift was fail-safe disabled',
                {
                  phase: nextSession.phase,
                  tailRecovery,
                  capture: publicCaptureResult(result),
                  next:
                    nextSession.phase === 'finishing'
                      ? `xgg learn finish --study-dir ${shellDisplayPath(artifacts.paths.study)}`
                      : `xgg learn capture --study-dir ${shellDisplayPath(artifacts.paths.study)}`,
                },
              );
            }
            emit(
              {
                ok: true,
                phase: nextSession.phase,
                tailRecovery,
                capture: publicCaptureResult(result),
              },
              { pretty: options.pretty === true },
            );
          } finally {
            await releaseFollowLease(lease);
          }
          return;
        }

        const lease = await acquireFollowLease(artifacts.paths.study);
        let currentSession = await requireStudySession(artifacts);
        assertCapturablePhase(currentSession);
        let stopping = false;
        const stop = (): void => {
          stopping = true;
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          const tailRecovery = await supervisor.recoverPartialTails();
          while (!stopping) {
            const result = await supervisor.captureOnce();
            currentSession = await applyCaptureOutcome(artifacts, currentSession, result);
            currentSession = await failSafeDisableSemanticDrift({
              artifacts,
              compilation: persisted.compilation,
              coverage: persisted.coverage,
              deps,
              result,
              session: currentSession,
              snapshotsDir: join(artifacts.paths.study, 'snapshots'),
            });
            const nextPollAt = new Date(Date.now() + intervalMs).toISOString();
            await updateFollowLease(lease, {
              heartbeatAt: new Date().toISOString(),
              lastOutcome: result.outcome,
              nextPollAt,
            });
            if (result.outcome !== 'captured') {
              if (captureFailureStopsFollow(result)) {
                throw new ConfigError(
                  'capture supervisor encountered a non-recoverable failure; durable gap/state were preserved and confirmed semantic drift was fail-safe disabled',
                  {
                    phase: currentSession.phase,
                    tailRecovery,
                    capture: publicCaptureResult(result),
                    next:
                      currentSession.phase === 'finishing'
                        ? `xgg learn finish --study-dir ${shellDisplayPath(artifacts.paths.study)}`
                        : `xgg learn capture --study-dir ${shellDisplayPath(artifacts.paths.study)} --follow`,
                  },
                );
              }
              emit(
                {
                  ok: true,
                  phase: currentSession.phase,
                  degraded: true,
                  willRetry: true,
                  tailRecovery,
                  capture: publicCaptureResult(result),
                  nextPollAt,
                },
                { pretty: options.pretty === true },
              );
              if (stopping) break;
              await interruptibleDelay(intervalMs, () => stopping);
              continue;
            }
            emit(
              {
                ok: true,
                phase: currentSession.phase,
                tailRecovery,
                capture: publicCaptureResult(result),
                nextPollAt,
              },
              { pretty: options.pretty === true },
            );
            if (stopping) break;
            await interruptibleDelay(intervalMs, () => stopping);
          }
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          await releaseFollowLease(lease);
        }
      }),
    );
}

function attachStatus(command: Command): void {
  command
    .command('status')
    .description('Inspect local lifecycle/capture health and optionally compare the live graph')
    .requiredOption('--study-dir <path>', 'private study directory')
    .option('--local-only', 'do not contact the gateway')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .action(
      wrap('learn.status', async (options: StatusOptions) => {
        const artifacts = createArtifacts(options.studyDir);
        const session = await requireStudySession(artifacts);
        const persisted = await loadCompilationArtifacts(artifacts);
        const capture =
          persisted === undefined
            ? undefined
            : await captureSupervisor(
                artifacts,
                persisted.compilation,
                options.localOnly === true ? undefined : gatewayDeps(options),
              ).status();
        const followOwner = await readFollowOwner(join(artifacts.paths.study, FOLLOW_OWNER_FILE));
        let live:
          | {
              reachable: true;
              enabled: boolean;
              semanticMatch: boolean;
              layoutMatch: boolean;
            }
          | undefined;
        if (options.localOnly !== true && persisted !== undefined) {
          const inspected = await inspectLiveRule(persisted.compilation, gatewayDeps(options));
          live = {
            reachable: true,
            enabled: inspected.enabled,
            semanticMatch: inspected.semanticMatch,
            layoutMatch: inspected.layoutMatch,
          };
        }
        emit(
          {
            ok: true,
            phase: session.phase,
            studyId: session.studyId,
            revision: session.revision,
            expectedEnabled: session.rule?.expectedEnabled,
            plannedEndAt: persisted?.coverage.plannedEndAt,
            finishStage: session.finish?.stage,
            pendingClarificationCount: session.finish?.pendingClarifications.length ?? 0,
            supervisor:
              followOwner === undefined
                ? { active: false }
                : {
                    active: processIsAlive(followOwner.pid),
                    pid: followOwner.pid,
                    startedAt: followOwner.startedAt,
                    heartbeatAt: followOwner.heartbeatAt,
                    lastOutcome: followOwner.lastOutcome,
                    nextPollAt: followOwner.nextPollAt,
                    stale: followOwnerIsStale(followOwner),
                  },
            capture,
            live,
            studyDir: artifacts.paths.study,
          },
          { pretty: options.pretty === true },
        );
      }),
    );
}

function attachClarify(command: Command): void {
  command
    .command('clarify')
    .description('Append one user-confirmed correction without rewriting earlier answers')
    .requiredOption('--study-dir <path>', 'private study directory')
    .requiredOption(
      '--subject <json>',
      'correction subject JSON, e.g. {"kind":"region-label","deviceKey":"device_...","label":"A-4","mapBank":"A"}',
    )
    .requiredOption('--value <json>', 'confirmed JSON value, e.g. {"meaning":"床"}')
    .option(
      '--source <source>',
      'user-mi-home-app | user-direct | user-import',
      parseCorrectionSource,
      'user-mi-home-app',
    )
    .option('--as-of <time>', 'effective epoch milliseconds or ISO timestamp (default: now)')
    .option('--supersedes <id>', 'prior correction ID for the same subject')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      `
Example:
  $ xgg learn clarify --study-dir .xgg-private/habit-learning/home \\
      --subject '{"kind":"region-label","deviceKey":"device_...","label":"A-4","mapBank":"A"}' \\
      --value '{"meaning":"床"}'`,
    )
    .action(
      wrap('learn.clarify', async (options: ClarifyOptions) => {
        const artifacts = createArtifacts(options.studyDir);
        await artifacts.initialize();
        const lease = await acquireFollowLease(artifacts.paths.study);
        try {
          const session = await requireStudySession(artifacts);
          if (session.phase !== 'awaiting-clarification') {
            throw new ConfigError(
              `clarifications are accepted only in awaiting-clarification (current: ${session.phase})`,
            );
          }
          const plan = await artifacts.readJson<HabitLearningPlan>('plan');
          if (plan === undefined) {
            throw new ConfigError('study plan is unavailable; refusing to append a clarification');
          }
          const now = Date.now();
          const subject = parseJsonInput<
            Parameters<typeof createHabitLearningCorrection>[0]['subject']
          >(options.subject, '--subject');
          const value = parseJsonInput<HabitLearningJsonValue>(options.value, '--value');
          assertPublicCorrectionPrivacy(subject, value, plan);
          assertAutomationConstraintCorrectionValue(subject, value);
          const correction = createHabitLearningCorrection({
            recordedAt: now,
            asOf: options.asOf === undefined ? now : parseTimestamp(options.asOf, '--as-of'),
            subject,
            value,
            source: options.source,
            ...(options.supersedes !== undefined && { supersedes: options.supersedes }),
            correctionIdMaterial: {
              studyId: session.studyId,
              nonce: randomUUID(),
            },
          });
          const existing = await artifacts.readCorrections<HabitLearningCorrection>();
          assertCorrectionJournalPrivacy(existing, plan);
          resolveHabitLearningCorrectionsAsOf({
            corrections: [...existing, correction],
            asOf: Number.MAX_SAFE_INTEGER,
            knownAt: Number.MAX_SAFE_INTEGER,
          });
          await artifacts.appendCorrections([{ ...correction }]);
          emit(
            {
              ok: true,
              correctionId: correction.correctionId,
              recordedAt: correction.recordedAt,
              next: `xgg learn finish --study-dir ${shellDisplayPath(artifacts.paths.study)}`,
            },
            { pretty: options.pretty === true },
          );
        } finally {
          await releaseFollowLease(lease);
        }
      }),
    );
}

function attachFinish(command: Command): void {
  const sub = command
    .command('finish')
    .description(
      'Final-capture, disable/read back the study rule, clarify opaque regions, then write a profile',
    )
    .requiredOption('--study-dir <path>', 'private study directory')
    .option('--snapshots-dir <path>', 'pre-disable snapshot directory (default: study/snapshots)')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output');
  addRefreshHintFlag(sub).action(
    wrap('learn.finish', async (options: FinishOptions) => {
      const artifacts = createArtifacts(options.studyDir);
      await artifacts.initialize();
      const writerLease = await acquireFollowLease(artifacts.paths.study);
      try {
        let session = await requireStudySession(artifacts);
        const persisted = await requireCompilationArtifacts(artifacts);
        const snapshotsDir = options.snapshotsDir ?? join(artifacts.paths.study, 'snapshots');
        let deps: ReturnType<typeof gatewayDeps> | undefined;
        const requireGatewayDeps = (): ReturnType<typeof gatewayDeps> => {
          assertAgentModeOrSnapshotsDir({ snapshotsDir });
          deps ??= gatewayDeps(options);
          return deps;
        };

        if (session.phase === 'complete') {
          const profile = await artifacts.readJson<HabitLearningProfile>('profile');
          await writeHandoff(artifacts, session, persisted.coverage);
          emit(
            {
              ok: true,
              phase: 'complete',
              profileId: profile?.profileId,
              studyDir: artifacts.paths.study,
            },
            { pretty: options.pretty === true },
          );
          return;
        }
        if (
          !['observing', 'observing-degraded', 'finishing', 'awaiting-clarification'].includes(
            session.phase,
          )
        ) {
          throw new ConfigError(`cannot finish study from phase ${session.phase}`);
        }
        if (session.phase === 'observing' || session.phase === 'observing-degraded') {
          requireGatewayDeps();
          const now = new Date().toISOString();
          session = await transition(artifacts, session, {
            phase: 'finishing',
            finish: {
              stage: 'final-capture-pending',
              attempts: 0,
              pendingClarifications: [],
            },
            timestamps: { finishingStartedAt: now },
          });
        }

        if (session.finish?.stage === 'final-capture-pending') {
          const liveDeps = requireGatewayDeps();
          const supervisor = captureSupervisor(artifacts, persisted.compilation, liveDeps);
          await supervisor.recoverPartialTails();
          const result = await supervisor.captureOnce();
          if (result.outcome !== 'captured') {
            if (
              (result.code === 'RULE_UNEXPECTEDLY_DISABLED' ||
                result.code === 'SEMANTIC_GRAPH_DRIFT') &&
              result.gapPersisted
            ) {
              session = await transition(artifacts, session, {
                phase: 'finishing',
                finish: {
                  ...requiredFinish(session),
                  stage:
                    result.code === 'RULE_UNEXPECTEDLY_DISABLED'
                      ? 'disable-readback-pending'
                      : 'disable-pending',
                  attempts: requiredFinish(session).attempts + 1,
                  lastErrorCode: result.code,
                },
                degradedReasonCodes: [...new Set([...session.degradedReasonCodes, result.code])],
              });
            } else {
              session = await transition(artifacts, session, {
                finish: {
                  ...requiredFinish(session),
                  attempts: requiredFinish(session).attempts + 1,
                  lastErrorCode: result.code,
                },
              });
              throw new ConfigError(
                'final capture did not commit; study rule remains enabled and finish is resumable',
                { captureCode: result.code, finishStage: session.finish?.stage },
              );
            }
          } else {
            session = await transition(artifacts, session, {
              finish: {
                ...requiredFinish(session),
                stage: 'disable-pending',
                attempts: requiredFinish(session).attempts + 1,
                lastErrorCode: undefined,
              },
              timestamps: { finalCaptureCommittedAt: result.capturedAt },
            });
          }
        }

        if (session.finish?.stage === 'disable-pending') {
          const liveDeps = requireGatewayDeps();
          await runMutationWorkflow('learn.finish.disable', liveDeps, async () => {
            await dumpBeforeWrite({ ...liveDeps, snapshotsDir });
            await disableRule(persisted.compilation.rule.id, liveDeps);
          });
          const now = new Date().toISOString();
          session = await transition(artifacts, session, {
            finish: {
              ...requiredFinish(session),
              stage: 'disable-readback-pending',
              attempts: requiredFinish(session).attempts + 1,
            },
            timestamps: { disableRequestedAt: now },
          });
        }

        if (session.finish?.stage === 'disable-readback-pending') {
          const liveDeps = requireGatewayDeps();
          let inspected = await inspectLiveRule(persisted.compilation, liveDeps);
          if (inspected.enabled) {
            await runMutationWorkflow('learn.finish.disable', liveDeps, async () => {
              await dumpBeforeWrite({ ...liveDeps, snapshotsDir });
              await disableRule(persisted.compilation.rule.id, liveDeps);
            });
            inspected = await inspectLiveRule(persisted.compilation, liveDeps);
          }
          if (inspected.enabled) {
            throw new ConfigError(
              'study rule still reads enabled; refusing clarification/profile phase',
            );
          }
          if (
            !inspected.semanticMatch &&
            session.finish?.lastErrorCode !== 'SEMANTIC_GRAPH_DRIFT'
          ) {
            throw new ConfigError('study graph semantic digest drifted before finish', {
              ruleId: persisted.compilation.rule.id,
            });
          }
          const now = new Date().toISOString();
          session = await transition(artifacts, session, {
            rule: {
              ...requiredRule(session),
              expectedEnabled: false,
              lastReadbackAt: now,
            },
            finish: {
              ...requiredFinish(session),
              stage: 'clarification-pending',
            },
            timestamps: { disableReadbackAt: now },
          });
          printRefreshHint(options, {
            baseUrl: liveDeps.baseUrl,
            context: `habit-learning rule ${persisted.compilation.rule.id} (disabled and read back)`,
          });
        }

        if (
          session.finish?.stage === 'clarification-pending' ||
          session.finish?.stage === 'awaiting-clarification'
        ) {
          const secret = await readProfileSecret(artifacts);
          await writePrivateDeviceMap({
            artifacts,
            plan: persisted.plan,
            compilation: persisted.compilation,
            secret,
            generatedAt: Date.now(),
          });
          const questions = await buildClarificationQuestions(artifacts, persisted, session);
          if (questions.length > 0) {
            const now = new Date().toISOString();
            session = await transition(artifacts, session, {
              phase: 'awaiting-clarification',
              finish: {
                ...requiredFinish(session),
                stage: 'awaiting-clarification',
                pendingClarifications: questions.map((question) => ({
                  questionId: question.questionId,
                  subject: JSON.stringify({
                    deviceKey: question.deviceKey,
                    unresolvedRegionCount: question.unresolvedRegions.length,
                  }),
                  createdAt: now,
                })),
              },
              timestamps: {
                clarificationPreparedAt: session.timestamps.clarificationPreparedAt ?? now,
              },
            });
            await writeHandoff(artifacts, session, persisted.coverage);
            emit(
              {
                ok: true,
                phase: session.phase,
                ruleEnabled: false,
                requiresClarification: true,
                questions,
                privateDeviceMapFile: artifacts.paths.deviceMap,
                instructions:
                  "Open Mi Home, confirm every opaque region meaning/map bank, append one learn clarify correction per label, then rerun learn finish. If the user confirms a mapping already applied during the study, pass that label's firstObservedAt as --as-of; otherwise omit --as-of so the answer applies only from confirmation time.",
              },
              { pretty: options.pretty === true },
            );
            return;
          }
          const now = new Date().toISOString();
          session = await transition(artifacts, session, {
            phase: 'awaiting-clarification',
            finish: {
              ...requiredFinish(session),
              stage: 'profile-pending',
              pendingClarifications: [],
            },
            timestamps: {
              clarificationPreparedAt: session.timestamps.clarificationPreparedAt ?? now,
            },
          });
        }

        if (session.finish?.stage !== 'profile-pending') {
          throw new ConfigError(`unexpected finish stage: ${session.finish?.stage ?? 'missing'}`);
        }
        const profile = await buildProfile(artifacts, persisted, session);
        await artifacts.writeJson('profile', profile);
        await artifacts.writeText('profileMarkdown', renderProfileMarkdown(profile));
        const completedAt = new Date().toISOString();
        session = await transition(artifacts, session, {
          phase: 'complete',
          finish: {
            ...requiredFinish(session),
            stage: 'complete',
            pendingClarifications: [],
          },
          timestamps: {
            profileWrittenAt: completedAt,
            completedAt,
          },
        });
        await writeHandoff(artifacts, session, persisted.coverage);
        emit(
          {
            ok: true,
            phase: session.phase,
            ruleEnabled: false,
            profileId: profile.profileId,
            completeness: profile.completeness,
            profileFile: artifacts.paths.profile,
            markdownFile: artifacts.paths.profileMarkdown,
            privateDeviceMapFile: artifacts.paths.deviceMap,
            next: `xgg learn profile --study-dir ${shellDisplayPath(artifacts.paths.study)} --minimum-completeness bounded`,
          },
          { pretty: options.pretty === true },
        );
      } finally {
        await releaseFollowLease(writerLease);
      }
    }),
  );
}

function attachProfile(command: Command): void {
  command
    .command('profile')
    .description(
      'Read the anonymized profile and evaluate whether it is fresh enough for authoring',
    )
    .requiredOption('--study-dir <path>', 'private completed study directory')
    .option(
      '--minimum-completeness <level>',
      'sufficient | bounded',
      parseMinimumCompleteness,
      'sufficient',
    )
    .option(
      '--local-only',
      'inspect without gateway drift checks; the result is never reusable for authoring',
    )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'gateway and MIoT request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .action(
      wrap('learn.profile', async (options: ProfileOptions) => {
        const artifacts = createArtifacts(options.studyDir);
        const session = await requireStudySession(artifacts);
        const profile = await artifacts.readJson<HabitLearningProfile>('profile');
        if (profile === undefined) {
          throw new ConfigError(
            `study phase ${session.phase} has no profile; finish clarifications first`,
          );
        }
        let currentSemanticDigest: string | undefined;
        let currentInventoryHash: string | undefined;
        let currentPlanId: string | undefined;
        if (options.localOnly !== true) {
          const persisted = await requireCompilationArtifacts(artifacts);
          const deps = gatewayDeps(options);
          const [live, inventory] = await Promise.all([
            inspectLiveRule(persisted.compilation, deps),
            listDevices(deps),
          ]);
          const collected = await collectHabitLearningPlannerInputs(
            inventory,
            deps.timeoutMs,
            'reload',
          );
          const currentPlan = planHabitLearning({
            devices: collected.devices,
            includeContext: persisted.plan.policy.includeContext,
            includeSensitive: persisted.plan.policy.includeSensitive,
            excludedDeviceIds: persisted.plan.policy.excludedDeviceIds,
            excludedRoomIds: persisted.plan.policy.excludedRoomIds,
          });
          currentSemanticDigest = live.semanticDigest;
          currentInventoryHash = currentPlan.inventory.inventoryHash;
          currentPlanId = currentPlan.planId;
        }
        const freshness = evaluateHabitLearningProfileFreshness({
          profile,
          evaluatedAt: Math.max(Date.now(), profile.generatedAt),
          minimumCompleteness: options.minimumCompleteness,
          ...(currentSemanticDigest !== undefined && { currentSemanticDigest }),
          ...(currentInventoryHash !== undefined && { currentInventoryHash }),
          ...(currentPlanId !== undefined && { currentPlanId }),
        });
        emit(
          {
            ok: true,
            studyId: session.studyId,
            phase: session.phase,
            freshness,
            profile,
          },
          { pretty: options.pretty === true },
        );
      }),
    );
}

function createArtifacts(path: string): HabitLearningPrivateArtifacts {
  return new HabitLearningPrivateArtifacts({
    path,
    inspectGitExposure,
  });
}

function gatewayDeps(options: {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
}): {
  baseUrl: string;
  store: ReturnType<typeof createStore>;
  timeoutMs: number;
} {
  const baseUrl = options.baseUrl ?? process.env.XGG_BASE_URL;
  if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
  const timeoutMs = parsePositiveTimerMs(options.timeout, '--timeout');
  const store = createStore(
    options.sessionFile
      ? { sessionFile: options.sessionFile }
      : process.env.XGG_SESSION_FILE
        ? { sessionFile: process.env.XGG_SESSION_FILE }
        : {},
  );
  return { baseUrl, store, timeoutMs };
}

async function inspectGitExposure(studyPath: string): Promise<{
  insideWorkTree: boolean;
  tracked: boolean;
  ignored: boolean;
}> {
  let probe = resolve(studyPath);
  const missingSegments: string[] = [];
  while (!(await pathExists(probe))) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missingSegments.unshift(relative(parent, probe));
    probe = parent;
  }
  let canonicalProbe: string;
  try {
    canonicalProbe = await realpath(probe);
  } catch (error) {
    throw new ConfigError('unable to resolve the private study path safely', {
      cause: commandFailureSummary(error),
    });
  }
  const canonicalStudyPath = resolve(canonicalProbe, ...missingSegments);
  let root: string;
  try {
    const result = await execFileAsync(
      'git',
      ['-C', canonicalProbe, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
      },
    );
    root = await realpath(result.stdout.trim());
  } catch (error) {
    if (isConfirmedOutsideGitWorkTree(error)) {
      return { insideWorkTree: false, tracked: false, ignored: false };
    }
    throw new ConfigError('unable to verify whether the private study path is Git-exposed', {
      cause: commandFailureSummary(error),
    });
  }
  const rel = relative(root, canonicalStudyPath);
  const insideWorkTree =
    rel === '' ||
    (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      rel !== '..' &&
      !isAbsolute(rel));
  if (!insideWorkTree) return { insideWorkTree: false, tracked: false, ignored: false };

  let tracked = false;
  try {
    const result = await execFileAsync('git', ['-C', root, 'ls-files', '--', rel], {
      encoding: 'utf8',
    });
    tracked = result.stdout.trim().length > 0;
  } catch {
    tracked = true;
  }
  let ignored = false;
  const ignoreProbe = join(canonicalStudyPath, '.xgg-private-probe');
  try {
    await execFileAsync('git', [
      '-C',
      root,
      'check-ignore',
      '--no-index',
      '--quiet',
      '--',
      ignoreProbe,
    ]);
    ignored = true;
  } catch {
    try {
      await execFileAsync('git', [
        '-C',
        root,
        'check-ignore',
        '--no-index',
        '--quiet',
        '--',
        canonicalStudyPath,
      ]);
      ignored = true;
    } catch {
      ignored = false;
    }
  }
  return { insideWorkTree, tracked, ignored };
}

function parseDurationDays(raw: string): number {
  if (!/^[1-7]$/.test(raw)) {
    throw new ConfigError('--duration-days must be an integer from 1 through 7');
  }
  return Number(raw);
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ConfigError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function assertAnalysisWindow(input: {
  baselineQuietMs: number;
  baselineHardCapMs: number;
}): void {
  if (input.baselineQuietMs > input.baselineHardCapMs) {
    throw new ConfigError(
      '--baseline-quiet-ms must be less than or equal to --baseline-hard-cap-ms',
    );
  }
}

function analysisOptionsFromStart(options: StartOptions): {
  baselineQuietMs: number;
  baselineHardCapMs: number;
  debounceMs: number;
} {
  const analysis = {
    baselineQuietMs: parsePositiveTimerMs(options.baselineQuietMs, '--baseline-quiet-ms'),
    baselineHardCapMs: parsePositiveTimerMs(options.baselineHardCapMs, '--baseline-hard-cap-ms'),
    debounceMs: parsePositiveTimerMs(options.debounceMs, '--debounce-ms'),
  };
  assertAnalysisWindow(analysis);
  return analysis;
}

function profileAnalysisOptions(coverage: StudyCoverageArtifact): {
  timezone: string;
  baselineQuietMs: number;
  baselineHardCapMs: number;
  debounceMs: number;
} {
  const analysis = {
    timezone: requireIanaTimezone(coverage.analysis?.timezone, 'coverage analysis timezone'),
    baselineQuietMs: positiveSafeInteger(
      coverage.analysis?.baselineQuietMs ?? DEFAULT_BASELINE_QUIET_MS,
      'coverage analysis baselineQuietMs',
    ),
    baselineHardCapMs: positiveSafeInteger(
      coverage.analysis?.baselineHardCapMs ?? DEFAULT_BASELINE_HARD_CAP_MS,
      'coverage analysis baselineHardCapMs',
    ),
    debounceMs: positiveSafeInteger(
      coverage.analysis?.debounceMs ?? DEFAULT_EPISODE_DEBOUNCE_MS,
      'coverage analysis debounceMs',
    ),
  };
  assertAnalysisWindow(analysis);
  return analysis;
}

function assertReviewedPlanId(provided: string | undefined, expected: string): void {
  if (provided === undefined) {
    throw new ConfigError(
      '--enable requires --plan-id from a reviewed `xgg learn plan` result or the preceding disabled start result',
      { expectedPlanId: expected },
    );
  }
  const normalized = provided.trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new ConfigError('--plan-id must be a lowercase SHA-256 digest');
  }
  if (normalized !== expected) {
    throw new ConfigError('reviewed --plan-id does not match the frozen study plan', {
      expectedPlanId: expected,
      providedPlanId: normalized,
    });
  }
}

async function planFromLiveGateway(
  deps: ReturnType<typeof gatewayDeps>,
  intent: StudyStartIntent,
): Promise<HabitLearningPlan> {
  const inventory = await listDevices(deps);
  const collected = await collectHabitLearningPlannerInputs(inventory, deps.timeoutMs, 'reload');
  return planHabitLearning({
    devices: collected.devices,
    includeContext: intent.includeContext,
    includeSensitive: intent.includeSensitive,
    excludedDeviceIds: intent.excludedDeviceIds,
    excludedRoomIds: intent.excludedRoomIds,
  });
}

function assertFrozenStartOptions(options: StartOptions, intent: StudyStartIntent): void {
  const conflicts: string[] = [];
  const requestedDuration = parseDurationDays(options.durationDays);
  if (
    options.durationDays !== String(DEFAULT_STUDY_DURATION_DAYS) &&
    requestedDuration !== intent.durationDays
  ) {
    conflicts.push('--duration-days');
  }
  if (options.includeContext === true && !intent.includeContext) {
    conflicts.push('--include-context');
  }
  if (options.includeSensitive === true && !intent.includeSensitive) {
    conflicts.push('--include-sensitive');
  }
  if (
    options.excludeDevice !== undefined &&
    !sameStringSet(options.excludeDevice, intent.excludedDeviceIds)
  ) {
    conflicts.push('--exclude-device');
  }
  if (
    options.excludeRoom !== undefined &&
    !sameStringSet(options.excludeRoom, intent.excludedRoomIds)
  ) {
    conflicts.push('--exclude-room');
  }
  if (options.name !== DEFAULT_STUDY_NAME && options.name !== intent.ruleName) {
    conflicts.push('--name');
  }
  const requestedAnalysis = analysisOptionsFromStart(options);
  if (
    options.baselineQuietMs !== String(DEFAULT_BASELINE_QUIET_MS) &&
    requestedAnalysis.baselineQuietMs !== intent.baselineQuietMs
  ) {
    conflicts.push('--baseline-quiet-ms');
  }
  if (
    options.baselineHardCapMs !== String(DEFAULT_BASELINE_HARD_CAP_MS) &&
    requestedAnalysis.baselineHardCapMs !== intent.baselineHardCapMs
  ) {
    conflicts.push('--baseline-hard-cap-ms');
  }
  if (
    options.debounceMs !== String(DEFAULT_EPISODE_DEBOUNCE_MS) &&
    requestedAnalysis.debounceMs !== intent.debounceMs
  ) {
    conflicts.push('--debounce-ms');
  }
  if (conflicts.length > 0) {
    throw new ConfigError(
      'study already has a frozen plan; resume without changing planning options',
      { conflictingOptions: conflicts },
    );
  }
}

function startIntentFromOptions(options: StartOptions): StudyStartIntent {
  const analysis = analysisOptionsFromStart(options);
  return {
    version: 1,
    ruleName: requireNonEmptyTrimmed(options.name, '--name'),
    durationDays: parseDurationDays(options.durationDays),
    timezone: currentIanaTimezone(),
    includeContext: options.includeContext === true,
    includeSensitive: options.includeSensitive === true,
    excludedDeviceIds: uniqueSorted(options.excludeDevice ?? []),
    excludedRoomIds: uniqueSorted(options.excludeRoom ?? []),
    ...analysis,
  };
}

function startIntentFromArtifacts(
  plan: HabitLearningPlan,
  coverage: StudyCoverageArtifact,
  compilation: CompiledHabitLearningRule,
): StudyStartIntent {
  return {
    version: 1,
    ruleName: compilation.rule.cfg.userData.name,
    durationDays: coverage.durationDays,
    timezone: requireIanaTimezone(coverage.analysis?.timezone, 'coverage analysis timezone'),
    includeContext: plan.policy.includeContext,
    includeSensitive: plan.policy.includeSensitive,
    excludedDeviceIds: uniqueSorted(plan.policy.excludedDeviceIds),
    excludedRoomIds: uniqueSorted(plan.policy.excludedRoomIds),
    baselineQuietMs: coverage.analysis?.baselineQuietMs ?? DEFAULT_BASELINE_QUIET_MS,
    baselineHardCapMs: coverage.analysis?.baselineHardCapMs ?? DEFAULT_BASELINE_HARD_CAP_MS,
    debounceMs: coverage.analysis?.debounceMs ?? DEFAULT_EPISODE_DEBOUNCE_MS,
  };
}

function assertStartArtifactsMatchIntent(
  intent: StudyStartIntent,
  persisted:
    | {
        plan: HabitLearningPlan;
        compilation: CompiledHabitLearningRule;
        coverage: StudyCoverageArtifact;
      }
    | undefined,
): void {
  if (persisted === undefined) return;
  const actual = startIntentFromArtifacts(
    persisted.plan,
    persisted.coverage,
    persisted.compilation,
  );
  if (JSON.stringify(actual) !== JSON.stringify(intent)) {
    throw new ConfigError(
      'frozen compilation artifacts do not match the durable study start intent',
    );
  }
}

function parseStartIntent(value: unknown): StudyStartIntent {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.ruleName !== 'string' ||
    !Number.isSafeInteger(value.durationDays) ||
    typeof value.timezone !== 'string' ||
    typeof value.includeContext !== 'boolean' ||
    typeof value.includeSensitive !== 'boolean' ||
    !isStringArray(value.excludedDeviceIds) ||
    !isStringArray(value.excludedRoomIds) ||
    !Number.isSafeInteger(value.baselineQuietMs) ||
    !Number.isSafeInteger(value.baselineHardCapMs) ||
    !Number.isSafeInteger(value.debounceMs)
  ) {
    throw new ConfigError('private study start-intent.json is malformed');
  }
  const parsed: StudyStartIntent = {
    version: 1,
    ruleName: requireNonEmptyTrimmed(value.ruleName, 'start intent ruleName'),
    durationDays: parseDurationDays(String(value.durationDays)),
    timezone: requireIanaTimezone(value.timezone, 'start intent timezone'),
    includeContext: value.includeContext,
    includeSensitive: value.includeSensitive,
    excludedDeviceIds: uniqueSorted(value.excludedDeviceIds),
    excludedRoomIds: uniqueSorted(value.excludedRoomIds),
    baselineQuietMs: positiveSafeInteger(value.baselineQuietMs, 'start intent baselineQuietMs'),
    baselineHardCapMs: positiveSafeInteger(
      value.baselineHardCapMs,
      'start intent baselineHardCapMs',
    ),
    debounceMs: positiveSafeInteger(value.debounceMs, 'start intent debounceMs'),
  };
  assertAnalysisWindow(parsed);
  if (
    !sameStringArray(parsed.excludedDeviceIds, value.excludedDeviceIds) ||
    !sameStringArray(parsed.excludedRoomIds, value.excludedRoomIds)
  ) {
    throw new ConfigError('private study start intent exclusions must be unique and sorted');
  }
  return parsed;
}

async function readStartIntent(studyPath: string): Promise<StudyStartIntent | undefined> {
  const path = join(studyPath, START_INTENT_FILE);
  const raw = await readPrivateRegularText(path);
  if (raw === undefined) return undefined;
  try {
    return parseStartIntent(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('private study start-intent.json is invalid JSON', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeStartIntent(studyPath: string, intent: StudyStartIntent): Promise<void> {
  const path = join(studyPath, START_INTENT_FILE);
  const existing = await readStartIntent(studyPath);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(intent)) {
      throw new ConfigError('private study start intent already exists with different options');
    }
    return;
  }
  await writePrivateAtomic(path, `${JSON.stringify(intent, null, 2)}\n`);
  const readback = await readStartIntent(studyPath);
  if (JSON.stringify(readback) !== JSON.stringify(intent)) {
    throw new ConfigError('private study start intent readback failed');
  }
}

function requireNonEmptyTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ConfigError(`${label} must not be empty`);
  return trimmed;
}

function requireIanaTimezone(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ConfigError(`${label} must be a frozen IANA timezone`);
  }
  const trimmed = requireNonEmptyTrimmed(value, label);
  if (trimmed.length > 128) {
    throw new ConfigError(`${label} must be at most 128 characters`);
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    throw new ConfigError(`${label} is not a recognized IANA timezone`);
  }
}

function currentIanaTimezone(): string {
  return requireIanaTimezone(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'current host timezone',
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  const normalized = values.map((value, index) =>
    requireNonEmptyTrimmed(value, `list item ${index}`),
  );
  return [...new Set(normalized)].sort();
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...new Set(left)].sort().join('\0') === [...new Set(right)].sort().join('\0')
  );
}

function parseCorrectionSource(raw: string): 'user-mi-home-app' | 'user-direct' | 'user-import' {
  if (raw === 'user-mi-home-app' || raw === 'user-direct' || raw === 'user-import') return raw;
  throw new ConfigError('--source must be user-mi-home-app, user-direct, or user-import');
}

function parseMinimumCompleteness(raw: string): 'sufficient' | 'bounded' {
  if (raw === 'sufficient' || raw === 'bounded') return raw;
  throw new ConfigError('--minimum-completeness must be sufficient or bounded');
}

function parseTimestamp(raw: string, flag: string): number {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${flag} must be epoch milliseconds or an ISO timestamp`);
  }
  return value;
}

function compilationArtifact(
  compilation: CompiledHabitLearningRule,
): StudyCoverageArtifact['compilation'] {
  return {
    compileVersion: compilation.compileVersion,
    planId: compilation.planId,
    planGraphId: compilation.planGraphId,
    localVariables: compilation.localVariables,
    sourceMap: compilation.sourceMap,
    digests: compilation.digests,
  };
}

async function loadCompilationArtifacts(
  artifacts: HabitLearningPrivateArtifacts,
  options: { allowIncomplete?: boolean } = {},
): Promise<
  | {
      plan: HabitLearningPlan;
      compilation: CompiledHabitLearningRule;
      coverage: StudyCoverageArtifact;
    }
  | undefined
> {
  const [plan, rule, coverage] = await Promise.all([
    artifacts.readJson<HabitLearningPlan>('plan'),
    artifacts.readJson<CompiledHabitLearningRule['rule']>('graph'),
    artifacts.readJson<StudyCoverageArtifact>('coverage'),
  ]);
  if (plan === undefined && rule === undefined && coverage === undefined) return undefined;
  if (plan === undefined || rule === undefined || coverage === undefined) {
    if (options.allowIncomplete === true) return undefined;
    throw new ConfigError('study compilation artifacts are incomplete; preserve them for recovery');
  }
  if (coverage.artifactVersion !== STUDY_ARTIFACT_VERSION) {
    throw new ConfigError(`unsupported study artifact version: ${coverage.artifactVersion}`);
  }
  const compilation: CompiledHabitLearningRule = {
    compileVersion: coverage.compilation
      .compileVersion as CompiledHabitLearningRule['compileVersion'],
    planId: coverage.compilation.planId,
    planGraphId: coverage.compilation.planGraphId,
    rule,
    localVariables: coverage.compilation.localVariables,
    sourceMap: freezeHabitLearningSourceMap(coverage.compilation.sourceMap),
    digests: coverage.compilation.digests,
  };
  assertCompiledHabitLearningRule(compilation);
  return { plan, compilation, coverage };
}

async function requireCompilationArtifacts(artifacts: HabitLearningPrivateArtifacts): Promise<{
  plan: HabitLearningPlan;
  compilation: CompiledHabitLearningRule;
  coverage: StudyCoverageArtifact;
}> {
  const persisted = await loadCompilationArtifacts(artifacts);
  if (persisted === undefined) {
    throw new ConfigError('study has no compiled graph; run learn start first');
  }
  return persisted;
}

async function requireStudySession(
  artifacts: HabitLearningPrivateArtifacts,
): Promise<HabitLearningStudySession> {
  const session = await artifacts.readSession();
  if (session === undefined) {
    throw new ConfigError('study session not found; run learn start first');
  }
  return session;
}

function requiredRule(
  session: HabitLearningStudySession,
): NonNullable<HabitLearningStudySession['rule']> {
  if (session.rule === undefined) throw new ConfigError('study session has no rule reference');
  return session.rule;
}

function requiredFinish(
  session: HabitLearningStudySession,
): NonNullable<HabitLearningStudySession['finish']> {
  if (session.finish === undefined) throw new ConfigError('study session has no finish checkpoint');
  return session.finish;
}

async function transition(
  artifacts: HabitLearningPrivateArtifacts,
  previous: HabitLearningStudySession,
  patch: {
    phase?: HabitLearningStudySession['phase'];
    rule?: HabitLearningStudySession['rule'];
    finish?: HabitLearningStudySession['finish'];
    timestamps?: Partial<HabitLearningStudySession['timestamps']>;
    degradedReasonCodes?: string[];
  },
): Promise<HabitLearningStudySession> {
  const now = new Date().toISOString();
  return artifacts.transitionSession(previous, {
    ...previous,
    phase: patch.phase ?? previous.phase,
    revision: previous.revision + 1,
    ...(patch.rule !== undefined && { rule: patch.rule }),
    ...(patch.finish !== undefined && { finish: patch.finish }),
    timestamps: {
      ...previous.timestamps,
      ...patch.timestamps,
      updatedAt: now,
    },
    degradedReasonCodes: patch.degradedReasonCodes ?? previous.degradedReasonCodes,
  });
}

async function reconcileStudyGraph(
  compilation: CompiledHabitLearningRule,
  deps: ReturnType<typeof gatewayDeps>,
): Promise<void> {
  const summaries = await listRules(deps);
  const existing = summaries.find(({ id }) => id === compilation.rule.id);
  if (existing === undefined) {
    await createRule(
      {
        ...compilation.rule,
        nodes: [],
        cfg: {
          ...compilation.rule.cfg,
          enable: false,
        },
      },
      deps,
      { skipScopeBootstrap: true },
    );
  } else if (existing.enable) {
    throw new ConfigError(
      'refusing to resume a preparing study whose partially-created rule is enabled',
      { ruleId: compilation.rule.id },
    );
  }

  let liveVariables: Awaited<ReturnType<typeof listVariables>>;
  try {
    liveVariables = await listVariables(`R${compilation.rule.id}`, deps);
  } catch (error) {
    if (!isMissingScopeError(error)) throw error;
    liveVariables = {};
  }
  for (const declaration of compilation.localVariables) {
    const current = liveVariables[declaration.request.id];
    if (current === undefined) {
      await createVariable(declaration.request, deps);
      continue;
    }
    if (current.type !== declaration.request.type) {
      throw new ConfigError(`existing study variable ${declaration.request.id} has the wrong type`);
    }
  }

  await setGraph(compilation.rule, deps, {
    getDeviceSpec,
    listAvailVars: (ruleId) => listAvailVarsForRule(ruleId, deps),
  });
}

async function inspectLiveRule(
  compilation: CompiledHabitLearningRule,
  deps: ReturnType<typeof gatewayDeps>,
): Promise<{
  enabled: boolean;
  semanticDigest: string;
  semanticMatch: boolean;
  layoutMatch: boolean;
}> {
  const [summaries, graph] = await Promise.all([
    listRules(deps),
    getRule(compilation.rule.id, deps),
  ]);
  const cfg = summaries.find(({ id }) => id === compilation.rule.id);
  if (cfg === undefined) throw new ConfigError(`study rule ${compilation.rule.id} is missing`);
  const live = {
    id: compilation.rule.id,
    nodes: graph.nodes,
    cfg,
  };
  const semanticDigest = habitLearningRuleSemanticDigest(
    live,
    compilation.localVariables,
    compilation.sourceMap,
  );
  const semanticMatch = semanticDigest === compilation.digests.semantic;
  const layoutMatch = habitLearningRuleLayoutDigest(live) === compilation.digests.layout;
  if (!semanticMatch) {
    return {
      enabled: cfg.enable,
      semanticDigest,
      semanticMatch,
      layoutMatch,
    };
  }
  const lintIssues = lintGraph({ graph: live, strict: true });
  const validationIssues = await validateGraph({
    graph: live,
    getDeviceSpec,
    listAvailVars: (ruleId) => listAvailVarsForRule(ruleId, deps),
  });
  const blocking = [...lintIssues, ...validationIssues].filter(
    ({ severity }) => severity === 'error',
  );
  if (blocking.length > 0) {
    throw new ConfigError('live habit-learning graph failed validation', {
      issues: blocking,
    });
  }
  return {
    enabled: cfg.enable,
    semanticDigest,
    semanticMatch,
    layoutMatch,
  };
}

async function assertLiveRuleMatches(
  compilation: CompiledHabitLearningRule,
  deps: ReturnType<typeof gatewayDeps>,
  expectedEnabled: boolean,
): Promise<void> {
  const inspected = await inspectLiveRule(compilation, deps);
  if (inspected.enabled !== expectedEnabled) {
    throw new ConfigError(
      `study rule enable readback mismatch: expected ${expectedEnabled}, got ${inspected.enabled}`,
    );
  }
  if (!inspected.semanticMatch) {
    throw new ConfigError('study rule semantic digest readback mismatch');
  }
  if (!inspected.layoutMatch) {
    throw new ConfigError('study rule layout digest readback mismatch');
  }
}

function captureSupervisor(
  artifacts: HabitLearningPrivateArtifacts,
  compilationOrRuleId: CompiledHabitLearningRule | string,
  deps?: ReturnType<typeof gatewayDeps>,
): HabitLearningCaptureSupervisor {
  const ruleId =
    typeof compilationOrRuleId === 'string' ? compilationOrRuleId : compilationOrRuleId.rule.id;
  return new HabitLearningCaptureSupervisor({
    store: artifacts.studyStore,
    studyRuleIds: [ruleId],
    fetch: async ({ maxBlocks }) => {
      if (deps === undefined) {
        throw new ConfigError('local-only status cannot fetch gateway logs');
      }
      if (typeof compilationOrRuleId === 'string') {
        throw new ConfigError('live capture requires the frozen study compilation');
      }
      const live = await inspectLiveRule(compilationOrRuleId, deps);
      if (!live.enabled) {
        throw Object.assign(new Error('study rule is unexpectedly disabled'), {
          code: 'RULE_UNEXPECTEDLY_DISABLED',
        });
      }
      if (!live.semanticMatch) {
        throw Object.assign(new Error('study rule semantic graph drifted'), {
          code: 'SEMANTIC_GRAPH_DRIFT',
        });
      }
      const fetched = await fetchRuleLogs({ ...deps, maxBlocks });
      return {
        rawLines: fetched.rawLines,
        blocksRead: fetched.blocksRead,
        stopReason: fetched.stopReason,
      };
    },
  });
}

function assertCapturablePhase(session: HabitLearningStudySession): void {
  if (session.phase !== 'observing' && session.phase !== 'observing-degraded') {
    throw new ConfigError(
      `capture requires an enabled observing study (current phase: ${session.phase})`,
    );
  }
  if (session.rule?.expectedEnabled !== true) {
    throw new ConfigError('capture checkpoint does not expect the study rule to be enabled');
  }
}

async function applyCaptureOutcome(
  artifacts: HabitLearningPrivateArtifacts,
  session: HabitLearningStudySession,
  result: Awaited<ReturnType<HabitLearningCaptureSupervisor['captureOnce']>>,
): Promise<HabitLearningStudySession> {
  if (result.outcome === 'captured') {
    const phase = session.phase === 'observing-degraded' ? 'observing' : session.phase;
    return transition(artifacts, session, {
      phase,
      timestamps: { lastHealthyCaptureAt: result.capturedAt },
      degradedReasonCodes: [],
    });
  }
  const phase = session.phase === 'observing' ? 'observing-degraded' : session.phase;
  return transition(artifacts, session, {
    phase,
    timestamps: {
      ...(session.timestamps.degradedAt === undefined && {
        degradedAt: result.occurredAt,
      }),
    },
    degradedReasonCodes: [result.code],
  });
}

async function failSafeDisableSemanticDrift(input: {
  artifacts: HabitLearningPrivateArtifacts;
  compilation: CompiledHabitLearningRule;
  coverage: StudyCoverageArtifact;
  deps: ReturnType<typeof gatewayDeps>;
  result: Awaited<ReturnType<HabitLearningCaptureSupervisor['captureOnce']>>;
  session: HabitLearningStudySession;
  snapshotsDir: string;
}): Promise<HabitLearningStudySession> {
  if (input.result.outcome === 'captured' || input.result.code !== 'SEMANTIC_GRAPH_DRIFT') {
    return input.session;
  }

  assertAgentModeOrSnapshotsDir({ snapshotsDir: input.snapshotsDir });
  const finishingStartedAt = new Date().toISOString();
  let session = await transition(input.artifacts, input.session, {
    phase: 'finishing',
    finish: {
      stage: 'disable-pending',
      attempts: 0,
      lastErrorCode: input.result.code,
      pendingClarifications: [],
    },
    timestamps: { finishingStartedAt },
    degradedReasonCodes: [...new Set([...input.session.degradedReasonCodes, input.result.code])],
  });
  await runMutationWorkflow('learn.capture.semantic-drift-disable', input.deps, async () => {
    await dumpBeforeWrite({ ...input.deps, snapshotsDir: input.snapshotsDir });
    await disableRule(input.compilation.rule.id, input.deps);
  });

  const disableRequestedAt = new Date().toISOString();
  session = await transition(input.artifacts, session, {
    finish: {
      ...requiredFinish(session),
      stage: 'disable-readback-pending',
      attempts: requiredFinish(session).attempts + 1,
    },
    timestamps: { disableRequestedAt },
  });
  const inspected = await inspectLiveRule(input.compilation, input.deps);
  if (inspected.enabled) {
    throw new ConfigError(
      'semantic drift was recorded but the fail-safe disable readback is still enabled; run learn finish immediately',
      {
        ruleId: input.compilation.rule.id,
        finishStage: session.finish?.stage,
      },
    );
  }

  const disableReadbackAt = new Date().toISOString();
  session = await transition(input.artifacts, session, {
    rule: {
      ...requiredRule(session),
      expectedEnabled: false,
      lastReadbackAt: disableReadbackAt,
    },
    finish: {
      ...requiredFinish(session),
      stage: 'clarification-pending',
    },
    timestamps: { disableReadbackAt },
  });
  await writeHandoff(input.artifacts, session, input.coverage);
  return session;
}

function publicCaptureResult(
  result: Awaited<ReturnType<HabitLearningCaptureSupervisor['captureOnce']>>,
): Record<string, unknown> {
  if (result.outcome === 'captured') {
    return {
      outcome: result.outcome,
      sequence: result.sequence,
      capturedAt: result.capturedAt,
      phase: result.phase,
      studyEntries: result.studyEntries,
      attempts: result.attempts,
      completenessReasons: result.completenessReasons,
      gapsAdded: result.gapsAdded,
      recoveredBatchCount: result.recoveredBatchIds.length,
    };
  }
  return {
    outcome: result.outcome,
    kind: result.kind,
    code: result.code,
    attempts: result.attempts,
    occurredAt: result.occurredAt,
    gapPersisted: result.gapPersisted,
    recoveryRequired: result.recoveryRequired,
    recoveredBatchCount: result.recoveredBatchIds.length,
  };
}

function captureFailureStopsFollow(
  result: Exclude<
    Awaited<ReturnType<HabitLearningCaptureSupervisor['captureOnce']>>,
    { outcome: 'captured' }
  >,
): boolean {
  return (
    result.kind === 'persistence' ||
    result.recoveryRequired ||
    result.code === 'RULE_UNEXPECTEDLY_DISABLED' ||
    result.code === 'SEMANTIC_GRAPH_DRIFT'
  );
}

async function readCaptureJournal(
  artifacts: HabitLearningPrivateArtifacts,
  ruleId: string,
): Promise<CaptureJournalData> {
  const supervisor = captureSupervisor(artifacts, ruleId);
  const integrity = await supervisor.verifyEvidenceIntegrity();
  const batches: HabitLearningCaptureBatchRecord[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = await supervisor.readBatches({
      afterSequence,
      limit: 256,
    });
    if (page.committedBatchSequence !== integrity.committedBatchSequence) {
      throw new ConfigError('capture evidence changed during analysis; retry after writers stop');
    }
    batches.push(...page.batches);
    if (page.complete) break;
    if (page.nextAfterSequence <= afterSequence) {
      throw new ConfigError('capture history pagination did not advance');
    }
    afterSequence = page.nextAfterSequence;
  }
  if (batches.length !== integrity.verifiedBatchCount) {
    throw new ConfigError(
      `authenticated capture traversal expected ${integrity.verifiedBatchCount} batches, got ${batches.length}`,
    );
  }

  const gaps: HabitLearningCaptureGapRecord[] = [];
  let gapOffset = 0;
  let expectedGapCount: number | undefined;
  for (;;) {
    const page = await supervisor.readGaps({
      offset: gapOffset,
      limit: 256,
    });
    expectedGapCount ??= page.totalGapCount;
    if (page.totalGapCount !== expectedGapCount) {
      throw new ConfigError(
        'capture gap evidence changed during analysis; retry after writers stop',
      );
    }
    gaps.push(...page.gaps);
    if (page.complete) break;
    if (page.nextOffset <= gapOffset) {
      throw new ConfigError('capture gap history pagination did not advance');
    }
    gapOffset = page.nextOffset;
  }
  if (gaps.length !== expectedGapCount) {
    throw new ConfigError(
      `authenticated capture traversal expected ${expectedGapCount ?? 0} gaps, got ${gaps.length}`,
    );
  }
  const finalIntegrity = await supervisor.verifyEvidenceIntegrity();
  if (
    finalIntegrity.committedBatchSequence !== integrity.committedBatchSequence ||
    finalIntegrity.verifiedBatchCount !== integrity.verifiedBatchCount
  ) {
    throw new ConfigError('capture evidence changed during analysis; retry after writers stop');
  }
  return {
    batches,
    gaps,
    entries: batches.flatMap((batch: HabitLearningCaptureBatchRecord) => batch.entries),
  };
}

async function readProfileSecret(artifacts: HabitLearningPrivateArtifacts): Promise<Uint8Array> {
  const path = join(artifacts.paths.study, PROFILE_SECRET_FILE);
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    throw new ConfigError('capture key is unavailable; complete at least one successful capture');
  }
  const secret = await readFile(path);
  if (secret.byteLength < 32) throw new ConfigError('capture key is invalid');
  return secret;
}

async function writePrivateDeviceMap(input: {
  artifacts: HabitLearningPrivateArtifacts;
  plan: HabitLearningPlan;
  compilation: CompiledHabitLearningRule;
  secret: Uint8Array;
  generatedAt: number;
}): Promise<void> {
  const signalsByDevice = new Map<string, HabitLearningPlan['signals']>();
  for (const signal of input.plan.signals) {
    if (!signal.included) continue;
    const signals = signalsByDevice.get(signal.device.did) ?? [];
    signals.push(signal);
    signalsByDevice.set(signal.device.did, signals);
  }
  const sourceIdsBySignal = new Map<string, string[]>();
  for (const declaration of input.compilation.localVariables) {
    const sourceIds = sourceIdsBySignal.get(declaration.signalId) ?? [];
    sourceIds.push(declaration.sourceId);
    sourceIdsBySignal.set(declaration.signalId, sourceIds);
  }
  const plannedSignalIds = new Set(input.plan.signals.map(({ signalId }) => signalId));
  for (const source of input.compilation.sourceMap.sources) {
    if (!plannedSignalIds.has(source.sourceId)) continue;
    const sourceIds = sourceIdsBySignal.get(source.sourceId) ?? [];
    sourceIds.push(source.sourceId);
    sourceIdsBySignal.set(source.sourceId, sourceIds);
  }
  const devices = [...signalsByDevice.values()]
    .flatMap((signals) => {
      const first = signals[0];
      if (first === undefined) return [];
      const signalIds = [...new Set(signals.map(({ signalId }) => signalId))].sort();
      const sourceIds = [
        ...new Set(signalIds.flatMap((signalId) => sourceIdsBySignal.get(signalId) ?? [])),
      ].sort();
      return [
        {
          deviceKey: deriveHabitLearningAnonymousDeviceKey({
            secret: input.secret,
            did: first.device.did,
          }),
          did: first.device.did,
          name: first.device.name,
          model: first.device.model,
          urn: first.device.urn,
          roomId: first.device.roomId,
          roomName: first.device.roomName,
          signalIds,
          sourceIds,
        },
      ];
    })
    .sort((left, right) => left.deviceKey.localeCompare(right.deviceKey));
  await input.artifacts.writeJson('deviceMap', {
    version: 1,
    generatedAt: new Date(input.generatedAt).toISOString(),
    sourceSemanticDigest: input.compilation.digests.semantic,
    sourceInventoryHash: input.plan.inventory.inventoryHash,
    devices,
  });
}

function assertCorrectionJournalPrivacy(
  corrections: readonly HabitLearningCorrection[],
  plan: HabitLearningPlan,
): void {
  for (const correction of corrections) {
    assertPublicCorrectionPrivacy(correction.subject, correction.value, plan);
  }
}

function assertPublicCorrectionPrivacy(
  subject: unknown,
  value: unknown,
  plan: HabitLearningPlan,
): void {
  const identifiers = correctionSensitiveIdentifiers(plan);
  const sensitiveKey = /^(?:did|device[-_]?id|device[-_]?name|model|urn|room[-_]?id)$/i;
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      const normalized = candidate.trim().toLowerCase();
      for (const identifier of identifiers) {
        if (
          normalized === identifier.value ||
          (identifier.allowSubstring &&
            identifier.value.length >= sensitiveIdentifierSubstringThreshold(identifier.value) &&
            normalized.includes(identifier.value))
        ) {
          throw new ConfigError(
            'correction would expose a raw device identifier or frozen device name in the public profile',
          );
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      if (sensitiveKey.test(key)) {
        throw new ConfigError(
          'correction keys must not embed raw device identifiers in the public profile',
        );
      }
      visit(entry);
    }
  };
  visit(subject);
  visit(value);
}

function sensitiveIdentifierSubstringThreshold(value: string): number {
  return /\p{Script=Han}/u.test(value) ? 2 : 4;
}

function correctionSensitiveIdentifiers(plan: HabitLearningPlan): Array<{
  value: string;
  allowSubstring: boolean;
}> {
  const values = new Map<string, boolean>();
  for (const signal of plan.signals) {
    const device = signal.device;
    for (const value of [device.did, device.model, device.urn, device.roomId]) {
      const normalized = value.trim().toLowerCase();
      if (normalized.length > 0) values.set(normalized, true);
    }
    const name = device.name.trim().toLowerCase();
    if (name.length > 0) values.set(name, true);
  }
  return [...values]
    .map(([value, allowSubstring]) => ({ value, allowSubstring }))
    .sort((left, right) => right.value.length - left.value.length);
}

type HabitLearningCorrectionSubject = Parameters<
  typeof createHabitLearningCorrection
>[0]['subject'];

const USER_AUTOMATION_CONSTRAINT_KINDS = new Set<HabitLearningAutomationConstraintInput['kind']>([
  'exclude-device',
  'exclude-room',
  'exclude-time-window',
  'prohibit-action',
  'privacy-boundary',
  'require-user-confirmation',
]);

function assertAutomationConstraintCorrectionValue(
  subject: HabitLearningCorrectionSubject,
  value: HabitLearningJsonValue,
): void {
  if (subject.kind !== 'automation-constraint') return;
  parseUserAutomationConstraintValue(subject.constraintKey, value);
}

export function projectHabitLearningAutomationConstraints(input: {
  corrections: readonly HabitLearningCorrection[];
  asOf: number;
  knownAt: number;
}): HabitLearningAutomationConstraintInput[] {
  return resolveHabitLearningCorrectionsAsOf(input)
    .flatMap((confirmation) => {
      if (confirmation.subject.kind !== 'automation-constraint') return [];
      const projected = parseUserAutomationConstraintValue(
        confirmation.subject.constraintKey,
        confirmation.value,
      );
      if (projected === undefined) return [];
      return [
        {
          constraintId: stableDigest({
            kind: 'user-automation-constraint',
            constraintKey: confirmation.subject.constraintKey,
            correctionId: confirmation.correctionId,
            projected,
          }),
          ...projected,
          source: 'user-confirmed' as const,
          correctionIds: [confirmation.correctionId],
        },
      ];
    })
    .sort((left, right) => left.constraintId.localeCompare(right.constraintId));
}

function parseUserAutomationConstraintValue(
  constraintKey: string,
  value: HabitLearningJsonValue,
): Pick<HabitLearningAutomationConstraintInput, 'kind' | 'description' | 'deviceKey'> | undefined {
  if (value === false) return undefined;
  if (value === true) {
    return {
      kind: 'require-user-confirmation',
      description: `User confirmed automation constraint "${constraintKey}"; clarify its exact operational boundary before authoring a rule.`,
    };
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return {
      kind: 'require-user-confirmation',
      description: value.trim(),
    };
  }
  if (!isRecord(value)) {
    throw new ConfigError(
      'automation-constraint value must be false, true, a non-empty description, or an object with kind and description',
    );
  }
  const allowedKeys = new Set(['kind', 'description', 'deviceKey']);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (
    typeof value.kind !== 'string' ||
    !USER_AUTOMATION_CONSTRAINT_KINDS.has(
      value.kind as HabitLearningAutomationConstraintInput['kind'],
    ) ||
    typeof value.description !== 'string' ||
    value.description.trim().length === 0 ||
    value.description.trim().length > 2_000 ||
    unknownKeys.length > 0
  ) {
    throw new ConfigError(
      'automation-constraint object must contain only a supported kind, a non-empty description, and optional anonymous deviceKey',
    );
  }
  if (
    value.deviceKey !== undefined &&
    (typeof value.deviceKey !== 'string' || !/^device_[a-f0-9]{32}$/.test(value.deviceKey))
  ) {
    throw new ConfigError('automation-constraint deviceKey must be an anonymous device_ key');
  }
  return {
    kind: value.kind as HabitLearningAutomationConstraintInput['kind'],
    description: value.description.trim(),
    ...(typeof value.deviceKey === 'string' && { deviceKey: value.deviceKey }),
  };
}

async function buildClarificationQuestions(
  artifacts: HabitLearningPrivateArtifacts,
  persisted: Awaited<ReturnType<typeof requireCompilationArtifacts>>,
  session: HabitLearningStudySession,
): Promise<HabitLearningRegionClarificationQuestion[]> {
  const secret = await readProfileSecret(artifacts);
  const journal = await readCaptureJournal(artifacts, persisted.compilation.rule.id);
  const gatewayWindow = resolveProfileGatewayWindow(journal, persisted.compilation.rule.id);
  const observationStartedAt = gatewayWindow.start;
  const observationEndedAt = gatewayWindow.end;
  const observations = normalizeHabitLearningObservations(
    journal.entries,
    persisted.compilation.sourceMap,
  ).filter(
    ({ observedAt }) => observedAt >= observationStartedAt && observedAt < observationEndedAt,
  );
  const signalById = new Map(persisted.plan.signals.map((signal) => [signal.signalId, signal]));
  const sourceToSignal = sourceToSignalMap(persisted.compilation);
  const regions: HabitLearningObservedRegion[] = [];
  const seenRegionEvidence = new Set<string>();

  for (const clarification of persisted.plan.partitionClarifications) {
    const deviceKey = deriveHabitLearningAnonymousDeviceKey({
      secret,
      did: clarification.did,
    });
    for (const label of clarification.labels) {
      const matchingSignal = persisted.plan.signals.find(
        (signal) =>
          signal.device.did === clarification.did &&
          signal.partition?.label === label.label &&
          signal.included,
      );
      const matches = observations.filter(
        (observation) =>
          matchingSignal !== undefined &&
          sourceToSignal.get(observation.sourceId) === matchingSignal.signalId,
      );
      const evidence =
        matches.length > 0
          ? matches
          : [
              {
                observedAt: Date.parse(
                  session.timestamps.observationStartedAt ?? session.timestamps.createdAt,
                ),
                sourceId: matchingSignal?.signalId ?? `${label.siid}:${label.piid}`,
              },
            ];
      for (const [index, observation] of evidence.entries()) {
        const observationId = stableDigest({
          kind: matches.length > 0 ? 'region-observation' : 'planned-region',
          deviceKey,
          label: label.label,
          observedAt: observation.observedAt,
          index,
        });
        if (seenRegionEvidence.has(observationId)) continue;
        seenRegionEvidence.add(observationId);
        regions.push({
          deviceKey,
          label: label.label,
          ...(label.label.startsWith('A-') && { mapBank: 'A' }),
          ...(label.label.startsWith('B-') && { mapBank: 'B' }),
          observedAt: observation.observedAt,
          observationId,
        });
      }
    }
  }

  for (const observation of observations) {
    const signalId = sourceToSignal.get(observation.sourceId);
    const signal = signalId === undefined ? undefined : signalById.get(signalId);
    if (signal?.selector.kind !== 'event' || typeof observation.value !== 'number') continue;
    const declaration = persisted.compilation.localVariables.find(
      ({ sourceId }) => sourceId === observation.sourceId,
    );
    const selector = declaration?.selector;
    if (selector?.kind !== 'event-argument') continue;
    const argument = signal.selector.arguments.find(({ piid }) => piid === selector.piid);
    if (
      argument === undefined ||
      !/(?:zone|region).*(?:id|identifier)/i.test(`${argument.description} ${argument.urn}`) ||
      !Number.isInteger(observation.value) ||
      observation.value < 1 ||
      observation.value > 64
    ) {
      continue;
    }
    const deviceKey = deriveHabitLearningAnonymousDeviceKey({
      secret,
      did: signal.device.did,
    });
    const label = `Zone-${observation.value}`;
    const observationId = stableDigest({
      kind: 'runtime-zone-id',
      deviceKey,
      label,
      observedAt: observation.observedAt,
      entryIndex: observation.entryIndex,
    });
    if (seenRegionEvidence.has(observationId)) continue;
    seenRegionEvidence.add(observationId);
    regions.push({
      deviceKey,
      label,
      observedAt: observation.observedAt,
      observationId,
    });
  }

  const corrections = await artifacts.readCorrections<HabitLearningCorrection>();
  const asOf = Math.max(Date.now(), ...observations.map(({ observedAt }) => observedAt));
  return buildHabitLearningRegionClarificationQuestions({
    regions,
    corrections,
    asOf,
    knownAt: Date.now(),
  });
}

async function buildProfile(
  artifacts: HabitLearningPrivateArtifacts,
  persisted: Awaited<ReturnType<typeof requireCompilationArtifacts>>,
  session: HabitLearningStudySession,
): Promise<HabitLearningProfile> {
  const secret = await readProfileSecret(artifacts);
  const journal = await readCaptureJournal(artifacts, persisted.compilation.rule.id);
  const gatewayWindow = resolveProfileGatewayWindow(journal, persisted.compilation.rule.id);
  const profileObservedFrom = gatewayWindow.start;
  const profileObservedUntil = gatewayWindow.end;
  const continuityEvidence = provesStartToFinishContinuity(journal, session)
    ? ('continuous' as const)
    : ('unknown' as const);
  const normalized = normalizeHabitLearningObservations(
    journal.entries,
    persisted.compilation.sourceMap,
  );
  const analysisContract = buildProfileAnalysisContract(
    persisted.plan,
    persisted.compilation,
    secret,
  );
  const analysisOptions = profileAnalysisOptions(persisted.coverage);
  const timezone = analysisOptions.timezone;
  const gaps = captureAnalysisGaps(journal, profileObservedFrom, profileObservedUntil);
  const evidence = buildHabitLearningProfileEvidence({
    entries: journal.entries,
    observations: normalized,
    sources: analysisContract.sources,
    planSignals: persisted.plan.signals.map(({ signalId, included }) => ({
      signalId,
      included,
    })),
    range: {
      start: profileObservedFrom,
      end: profileObservedUntil,
    },
    gaps,
    baseline: {
      ruleId: persisted.compilation.rule.id,
      quietPeriodMs: analysisOptions.baselineQuietMs,
      hardCapMs: analysisOptions.baselineHardCapMs,
      enableBoundary: gatewayWindow.enableBoundary,
    },
    debounceMs: analysisOptions.debounceMs,
    continuityEvidence,
    completenessReasonCodes: [
      ...(continuityEvidence === 'continuous'
        ? ['collector-start-to-finish-overlap-proven']
        : ['collector-start-to-finish-not-proven']),
    ],
  });
  const completeness = assessHabitLearningProfileCompleteness({
    ...evidence.completenessInput,
    reasonCodes: [
      ...(evidence.completenessInput.reasonCodes ?? []),
      ...(evidence.baseline.ambiguousSourceIds.length > 0 ? ['preload-baseline-ambiguous'] : []),
      ...(evidence.baseline.missingSourceIds.length > 0 ? ['preload-baseline-missing'] : []),
      ...(evidence.unpairedParameterEvents.length > 0 ? ['parameter-events-unpaired'] : []),
    ],
  });
  const completenessWithCaptureGaps =
    journal.gaps.length === 0
      ? completeness
      : {
          ...completeness,
          status:
            completeness.status === 'insufficient'
              ? ('insufficient' as const)
              : ('bounded' as const),
          collectorContinuity: 'gapped' as const,
          gapCount: journal.gaps.length,
          reasonCodes: [...new Set([...completeness.reasonCodes, 'collector-gaps-present'])].sort(),
        };
  const profileObservations: HabitLearningProfileObservationInput[] = [];

  for (const interval of evidence.stateIntervals) {
    const metadata = analysisContract.metadataBySource.get(interval.sourceId);
    if (metadata === undefined) continue;
    const localGapIds = overlappingGapIds(gaps, interval.start, interval.end);
    const rawState = interval.value as HabitLearningJsonValue;
    const describedState = describeHabitLearningProfileValue(metadata, rawState);
    const region = describeHabitLearningProfileRegion(metadata, rawState);
    profileObservations.push({
      observationId: interval.intervalId,
      kind: 'state-interval',
      deviceKey: interval.deviceKey,
      signalKey: metadata.signalKey,
      observedFrom: interval.start,
      observedUntil: interval.end,
      value: {
        state: describedState,
        ...(region !== undefined && { region }),
        firstObservedAt: interval.firstObservedAt,
        lastObservedAt: interval.lastObservedAt,
        observationCount: interval.observationCount,
        leftCensored: interval.leftCensored,
        rightCensored: interval.rightCensored,
        endedBy: interval.endedBy,
      },
      count: {
        min: interval.observationCount,
        max: interval.observationCount,
      },
      evidenceRefs: interval.rawRefs,
      gapIds: localGapIds,
      certainty:
        localGapIds.length === 0 && !interval.leftCensored && !interval.rightCensored
          ? 'direct'
          : 'bounded',
    });
  }

  const eligiblePointEvents = evidence.pointEvents.filter((observation) => {
    const metadata = analysisContract.metadataBySource.get(observation.sourceId);
    return metadata?.role === 'event-primary';
  });
  for (const { sourceId, localDate, observations } of groupHabitLearningPointEventsByLocalDate(
    eligiblePointEvents,
    timezone,
  )) {
    const metadata = analysisContract.metadataBySource.get(sourceId);
    const first = observations[0];
    const last = observations.at(-1);
    if (metadata === undefined || first === undefined || last === undefined) continue;
    const evidenceRefs = observations.map(({ provenance }) => provenance.rawRef);
    const values = observations.map(({ value }) => value as HabitLearningJsonValue);
    const localGapIds = overlappingGapIds(
      gaps,
      first.observedAt,
      safeExclusivePointEnd(last.observedAt),
    );
    profileObservations.push({
      observationId: stableDigest({
        kind: 'daily-event-count',
        sourceId,
        localDate,
        evidenceRefs,
      }),
      kind: 'event-count',
      deviceKey: first.deviceKey,
      signalKey: metadata.signalKey,
      observedFrom: first.observedAt,
      observedUntil: last.observedAt,
      value: {
        bucket: 'local-day',
        localDate,
        firstObservedAt: first.observedAt,
        lastObservedAt: last.observedAt,
        event: {
          capabilityUrn: metadata.capabilityUrn,
          capabilityDescription: metadata.capabilityDescription,
          semanticAuthority: 'miot-spec',
        },
        firstParameter: describeHabitLearningProfileValue(metadata, values[0] ?? null),
        lastParameter: describeHabitLearningProfileValue(metadata, values.at(-1) ?? null),
        distinctParameterCount: new Set(values.map((value) => JSON.stringify(value))).size,
      },
      count: { min: observations.length, max: observations.length },
      evidenceRefs,
      gapIds: localGapIds,
      certainty: localGapIds.length === 0 ? 'direct' : 'bounded',
    });
  }

  const eventAttributes = new Map<string, typeof evidence.classifiedObservations>();
  for (const observation of evidence.classifiedObservations) {
    const metadata = analysisContract.metadataBySource.get(observation.sourceId);
    if (metadata?.role !== 'event-attribute' || observation.classification !== 'behavior') {
      continue;
    }
    const current = eventAttributes.get(observation.sourceId) ?? [];
    current.push(observation);
    eventAttributes.set(observation.sourceId, current);
  }
  for (const [sourceId, observations] of eventAttributes) {
    const metadata = analysisContract.metadataBySource.get(sourceId);
    const first = observations[0];
    const last = observations.at(-1);
    if (metadata === undefined || first === undefined || last === undefined) continue;
    const values = observations.map(({ value }) => value as HabitLearningJsonValue);
    const evidenceRefs = observations.map(({ provenance }) => provenance.rawRef);
    const localGapIds = overlappingGapIds(
      gaps,
      first.observedAt,
      safeExclusivePointEnd(last.observedAt),
    );
    profileObservations.push({
      observationId: stableDigest({
        kind: 'event-attribute',
        sourceId,
        evidenceRefs,
        values,
      }),
      kind: 'value-summary',
      deviceKey: first.deviceKey,
      signalKey: metadata.signalKey,
      observedFrom: first.observedAt,
      observedUntil: last.observedAt,
      value: {
        role: 'event-attribute',
        first: describeHabitLearningProfileValue(metadata, values[0] ?? null),
        last: describeHabitLearningProfileValue(metadata, values.at(-1) ?? null),
        distinctCount: new Set(values.map((value) => JSON.stringify(value))).size,
        sampleCount: values.length,
      },
      count: { min: values.length, max: values.length },
      evidenceRefs,
      gapIds: localGapIds,
      certainty: localGapIds.length === 0 ? 'direct' : 'bounded',
    });
  }

  for (const episode of evidence.parameterEpisodes) {
    const channelMetadata = analysisContract.metadataByChannel.get(
      analysisChannelKey(episode.deviceKey, episode.channelKey),
    );
    const localGapIds = overlappingGapIds(gaps, episode.start, episode.end);
    profileObservations.push({
      observationId: episode.episodeId,
      kind: 'episode',
      deviceKey: episode.deviceKey,
      signalKey: channelMetadata?.signalKey ?? episode.channelKey.slice(0, 256),
      observedFrom: episode.start,
      observedUntil: episode.end,
      value: {
        parameterValue: episode.parameterValue,
        parameterSemantic:
          channelMetadata === undefined
            ? {
                rawValue: episode.parameterValue,
                valueAuthority: 'raw-gateway-log',
              }
            : describeHabitLearningProfileValue(channelMetadata, episode.parameterValue),
        spanMs: episode.spanMs,
        observedActiveMs: episode.observedActiveMs,
        debouncedInactiveMs: episode.debouncedInactiveMs,
        debounceMs: episode.debounceMs,
        leftCensored: episode.leftCensored,
        rightCensored: episode.rightCensored,
        ambiguous: episode.ambiguous,
      },
      count: { min: 1, max: 1 },
      evidenceRefs: episode.rawRefs,
      gapIds: localGapIds,
      certainty: episode.ambiguous
        ? 'ambiguous'
        : localGapIds.length === 0 && !episode.leftCensored && !episode.rightCensored
          ? 'direct'
          : 'bounded',
    });
  }

  await artifacts.writeJson('coverage', {
    ...persisted.coverage,
    observed: {
      generatedAt: new Date().toISOString(),
      ...runtimeCoverageReport(persisted.plan, evidence.coverage),
      gapCount: journal.gaps.length,
    },
  } satisfies StudyCoverageArtifact);

  const corrections = await artifacts.readCorrections<HabitLearningCorrection>();
  assertCorrectionJournalPrivacy(corrections, persisted.plan);
  const generatedAt = Math.max(Date.now(), profileObservedUntil);
  const hypotheses = deriveHabitLearningHypotheses({
    observations: profileObservations,
    timezone,
    completeness: completenessWithCaptureGaps,
    corrections,
    correctionKnownAt: generatedAt,
  });
  const userAutomationConstraints = projectHabitLearningAutomationConstraints({
    corrections,
    asOf: generatedAt,
    knownAt: generatedAt,
  });
  await writePrivateDeviceMap({
    artifacts,
    plan: persisted.plan,
    compilation: persisted.compilation,
    secret,
    generatedAt,
  });
  return generateHabitLearningProfile({
    sourceSemanticDigest: persisted.compilation.digests.semantic,
    sourceInventoryHash: persisted.plan.inventory.inventoryHash,
    sourcePlanId: persisted.plan.planId,
    generatedAt,
    observedFrom: profileObservedFrom,
    observedUntil: profileObservedUntil,
    timezone,
    expiresAfterMs: DEFAULT_PROFILE_EXPIRY_MS,
    observations: profileObservations,
    hypotheses,
    corrections,
    correctionAsOf: generatedAt,
    correctionKnownAt: generatedAt,
    automationConstraints: [
      {
        constraintId: stableDigest('household-size-inference-prohibited'),
        kind: 'privacy-boundary',
        description:
          'Sensor people-count values must not be interpreted as household resident count or identity.',
        source: 'safety-default',
        correctionIds: [],
      },
      {
        constraintId: stableDigest('person-identity-inference-prohibited'),
        kind: 'privacy-boundary',
        description:
          'Observations do not identify a person; ask the user before assigning person-specific meaning.',
        source: 'safety-default',
        correctionIds: [],
      },
      ...userAutomationConstraints,
    ],
    completeness: completenessWithCaptureGaps,
  });
}

type HabitLearningPlanSignal = HabitLearningPlan['signals'][number];

export interface HabitLearningProfileValueMetadata {
  capabilityUrn: string;
  capabilityDescription: string;
  unit?: string;
  valueRange?: {
    min: number;
    max: number;
    step: number;
  };
  valueList?: Array<{
    value: number;
    description: string;
  }>;
  regionIdentifier: boolean;
  sourceDtype?: 'boolean' | 'float' | 'int' | 'string';
  partition?: {
    label: string;
    mapBank?: string;
  };
}

interface ProfileAnalysisMetadata extends HabitLearningProfileValueMetadata {
  role: 'state' | 'event-primary' | 'event-attribute' | 'parameter-boundary';
  signalKey: string;
}

export function buildProfileAnalysisContract(
  plan: HabitLearningPlan,
  compilation: CompiledHabitLearningRule,
  secret: Uint8Array,
): {
  sources: HabitLearningAnalysisSourceSemantics[];
  metadataBySource: Map<string, ProfileAnalysisMetadata>;
  metadataByChannel: Map<string, ProfileAnalysisMetadata>;
} {
  const signalById = new Map(plan.signals.map((signal) => [signal.signalId, signal]));
  const signalIdBySource = sourceToSignalMap(compilation);
  const declarationBySource = new Map(
    compilation.localVariables.map((declaration) => [declaration.sourceId, declaration]),
  );
  const parameterSourcesBySignal = new Map<string, string[]>();
  for (const declaration of compilation.localVariables) {
    if (declaration.selector.kind !== 'event-argument') continue;
    const current = parameterSourcesBySignal.get(declaration.signalId) ?? [];
    current.push(declaration.sourceId);
    parameterSourcesBySignal.set(declaration.signalId, current);
  }
  for (const sourceIds of parameterSourcesBySignal.values()) {
    sourceIds.sort((left, right) => {
      const leftSelector = declarationBySource.get(left)?.selector;
      const rightSelector = declarationBySource.get(right)?.selector;
      const leftIndex =
        leftSelector?.kind === 'event-argument' ? leftSelector.valueIndex : Number.MAX_SAFE_INTEGER;
      const rightIndex =
        rightSelector?.kind === 'event-argument'
          ? rightSelector.valueIndex
          : Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || left.localeCompare(right);
    });
  }

  const pairingCandidates = new Map<
    string,
    {
      phase: 'start' | 'end';
      channelKey: string;
      deviceKey: HabitLearningAnonymousDeviceKey;
    }
  >();
  const phasesByChannel = new Map<string, Set<'start' | 'end'>>();
  for (const source of compilation.sourceMap.sources) {
    if (source.kind !== 'parameter-event') continue;
    const signalId = signalIdBySource.get(source.sourceId);
    const signal = signalId === undefined ? undefined : signalById.get(signalId);
    const declaration = declarationBySource.get(source.sourceId);
    const selector = declaration?.selector;
    if (signal?.selector.kind !== 'event' || selector?.kind !== 'event-argument') {
      continue;
    }
    const argument = signal.selector.arguments.find(({ piid }) => piid === selector.piid);
    const primarySource = parameterSourcesBySignal.get(signal.signalId)?.[0];
    const pairing =
      argument === undefined || primarySource !== source.sourceId
        ? undefined
        : parameterPairing(signal, argument);
    if (pairing === undefined) continue;
    const deviceKey = deriveHabitLearningAnonymousDeviceKey({
      secret,
      did: signal.device.did,
    });
    pairingCandidates.set(source.sourceId, {
      ...pairing,
      deviceKey,
    });
    const key = analysisChannelKey(deviceKey, pairing.channelKey);
    const phases = phasesByChannel.get(key) ?? new Set<'start' | 'end'>();
    phases.add(pairing.phase);
    phasesByChannel.set(key, phases);
  }

  const sources: HabitLearningAnalysisSourceSemantics[] = [];
  const metadataBySource = new Map<string, ProfileAnalysisMetadata>();
  const metadataByChannel = new Map<string, ProfileAnalysisMetadata>();
  for (const source of compilation.sourceMap.sources) {
    const signalId = signalIdBySource.get(source.sourceId);
    const signal = signalId === undefined ? undefined : signalById.get(signalId);
    if (signalId === undefined || signal === undefined) {
      throw new ConfigError(`analysis source ${source.sourceId} has no planned signal`);
    }
    const deviceKey = deriveHabitLearningAnonymousDeviceKey({
      secret,
      did: signal.device.did,
    });
    if (source.kind === 'property') {
      const sourceNode = compilation.rule.nodes.find(({ id }) => id === source.nodeId);
      const preloadNodeId =
        sourceNode !== undefined && isRecord(sourceNode.props) && sourceNode.props.preload === true
          ? source.nodeId
          : undefined;
      sources.push({
        sourceId: source.sourceId,
        signalId,
        deviceKey,
        included: signal.included,
        analysisKind: 'persistent-property',
        ...(preloadNodeId !== undefined && { preloadNodeId }),
      });
      metadataBySource.set(source.sourceId, {
        role: 'state',
        signalKey: profileSignalKey(signal),
        ...(signal.selector.kind === 'property' && {
          sourceDtype: signal.selector.sourceDtype,
        }),
        ...(signal.partition !== undefined && {
          partition: {
            label: signal.partition.label,
            ...(/^[AB]-\d{1,2}$/.test(signal.partition.label) && {
              mapBank: signal.partition.label.slice(0, 1),
            }),
          },
        }),
        ...profileValueMetadata(signal),
      });
      continue;
    }
    if (source.kind === 'zero-argument-event') {
      sources.push({
        sourceId: source.sourceId,
        signalId,
        deviceKey,
        included: signal.included,
        analysisKind: 'point-event',
      });
      metadataBySource.set(source.sourceId, {
        role: 'event-primary',
        signalKey: profileSignalKey(signal),
        ...profileValueMetadata(signal),
      });
      continue;
    }

    const declaration = declarationBySource.get(source.sourceId);
    const selector = declaration?.selector;
    if (signal.selector.kind !== 'event' || selector?.kind !== 'event-argument') {
      throw new ConfigError(`parameter source ${source.sourceId} has no event argument mapping`);
    }
    const argument = signal.selector.arguments.find(({ piid }) => piid === selector.piid);
    if (argument === undefined) {
      throw new ConfigError(`parameter source ${source.sourceId} has no argument semantics`);
    }
    const candidate = pairingCandidates.get(source.sourceId);
    const paired =
      candidate !== undefined &&
      phasesByChannel.get(analysisChannelKey(candidate.deviceKey, candidate.channelKey))?.size ===
        2;
    if (candidate !== undefined && paired) {
      sources.push({
        sourceId: source.sourceId,
        signalId,
        deviceKey,
        included: signal.included,
        analysisKind: candidate.phase === 'start' ? 'parameter-event-start' : 'parameter-event-end',
        channelKey: candidate.channelKey,
      });
      const metadata = {
        role: 'parameter-boundary' as const,
        signalKey: profileSignalKey(signal, argument.description),
        ...profileValueMetadata(signal, argument),
      };
      metadataBySource.set(source.sourceId, metadata);
      metadataByChannel.set(analysisChannelKey(deviceKey, candidate.channelKey), metadata);
      continue;
    }

    const primarySource = parameterSourcesBySignal.get(signal.signalId)?.[0];
    sources.push({
      sourceId: source.sourceId,
      signalId,
      deviceKey,
      included: signal.included,
      analysisKind: 'point-event',
    });
    metadataBySource.set(source.sourceId, {
      role: primarySource === source.sourceId ? 'event-primary' : 'event-attribute',
      signalKey: profileSignalKey(signal, argument.description),
      ...profileValueMetadata(signal, argument),
    });
  }
  return { sources, metadataBySource, metadataByChannel };
}

export function parameterPairing(
  signal: HabitLearningPlanSignal,
  argument: Extract<HabitLearningPlanSignal['selector'], { kind: 'event' }>['arguments'][number],
): { phase: 'start' | 'end'; channelKey: string } | undefined {
  const eventName = `${signal.semantics.capabilityUrn} ${signal.semantics.capabilityDescription}`
    .toLowerCase()
    .replaceAll('_', '-');
  const pairs: Array<{
    family: string;
    start: RegExp;
    end: RegExp;
  }> = [
    {
      family: 'zone-show',
      start: /(?:^|[^a-z])(?:zone|region)-?show(?:$|[^a-z])/,
      end: /(?:^|[^a-z])(?:zone|region)-?(?:no-?show|noshow)(?:$|[^a-z])/,
    },
    {
      family: 'region-entry',
      start: /(?:^|[^a-z])(?:enter|entry|arrive|arrival)(?:$|[^a-z])/,
      end: /(?:^|[^a-z])(?:leave|left|exit|depart|departure)(?:$|[^a-z])/,
    },
    {
      family: 'activity-run',
      start: /(?:^|[^a-z])(?:start|started|begin|began)(?:$|[^a-z])/,
      end: /(?:^|[^a-z])(?:stop|stopped|end|ended|finish|finished)(?:$|[^a-z])/,
    },
    {
      family: 'open-state',
      start: /(?:^|[^a-z])(?:open|opened)(?:$|[^a-z])/,
      end: /(?:^|[^a-z])(?:close|closed)(?:$|[^a-z])/,
    },
  ];
  for (const pair of pairs) {
    // Check the negative/end form first because "noshow" contains "show".
    if (pair.end.test(eventName)) {
      return {
        phase: 'end',
        channelKey: `${signal.semantics.serviceUrn}|${pair.family}|argument:${argument.piid}`,
      };
    }
    if (pair.start.test(eventName)) {
      return {
        phase: 'start',
        channelKey: `${signal.semantics.serviceUrn}|${pair.family}|argument:${argument.piid}`,
      };
    }
  }
  return undefined;
}

function profileSignalKey(signal: HabitLearningPlanSignal, argument?: string): string {
  const key = [
    signal.semantics.serviceDescription,
    signal.semantics.capabilityDescription,
    argument,
    signal.partition?.label,
  ]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join('.');
  return (key || signal.signalId).slice(0, 256);
}

function profileValueMetadata(
  signal: HabitLearningPlanSignal,
  argument?: Extract<HabitLearningPlanSignal['selector'], { kind: 'event' }>['arguments'][number],
): HabitLearningProfileValueMetadata {
  const source = argument ?? signal.semantics;
  return {
    capabilityUrn: argument?.urn ?? signal.semantics.capabilityUrn,
    capabilityDescription: argument?.description ?? signal.semantics.capabilityDescription,
    ...(source.unit !== undefined && { unit: source.unit }),
    ...(source.valueRange !== undefined && {
      valueRange: { ...source.valueRange },
    }),
    ...(source.valueList !== undefined && {
      valueList: source.valueList.map((entry) => ({ ...entry })),
    }),
    regionIdentifier: argument !== undefined && isRegionIdentifierArgument(argument),
  };
}

function isRegionIdentifierArgument(
  argument: Extract<HabitLearningPlanSignal['selector'], { kind: 'event' }>['arguments'][number],
): boolean {
  const semantic = `${argument.urn} ${argument.description}`;
  return (
    /(?:zone|region|partition)[^a-z0-9]*(?:id|identifier|index|number)/i.test(semantic) ||
    /(?:id|identifier|index|number)[^a-z0-9]*(?:zone|region|partition)/i.test(semantic)
  );
}

export function describeHabitLearningProfileValue(
  metadata: HabitLearningProfileValueMetadata,
  rawValue: HabitLearningJsonValue,
): HabitLearningJsonValue {
  const described: Record<string, HabitLearningJsonValue> = {
    rawValue,
    valueAuthority: 'raw-gateway-log',
    capabilityUrn: metadata.capabilityUrn,
    capabilityDescription: metadata.capabilityDescription,
    semanticAuthority: 'miot-spec',
  };
  if (metadata.unit !== undefined) described.unit = metadata.unit;
  if (metadata.regionIdentifier) described.regionIdentifier = true;
  if (metadata.valueRange !== undefined) {
    described.valueRange = { ...metadata.valueRange };
  }
  if (typeof rawValue === 'number') {
    const listed = metadata.valueList?.find(({ value }) => value === rawValue);
    if (listed !== undefined) {
      described.specLabel = listed.description;
      described.mappingAuthority = 'miot-spec-value-list';
    }
    if (
      metadata.regionIdentifier &&
      Number.isInteger(rawValue) &&
      rawValue >= 1 &&
      rawValue <= 64
    ) {
      described.rawZoneId = rawValue;
      described.derivedLabel = `Zone-${rawValue}`;
      described.mappingAuthority = 'inferred-numbering';
    }
  }
  return described;
}

export function describeHabitLearningProfileRegion(
  metadata: HabitLearningProfileValueMetadata,
  rawValue: HabitLearningJsonValue,
):
  | {
      label: string;
      mapBank?: string;
      activity: 'active' | 'inactive' | 'unknown';
      mappingAuthority: 'planner-model-partition';
    }
  | undefined {
  if (metadata.partition === undefined) return undefined;
  return {
    label: metadata.partition.label,
    ...(metadata.partition.mapBank !== undefined && {
      mapBank: metadata.partition.mapBank,
    }),
    activity: profileRegionActivity(metadata, rawValue),
    mappingAuthority: 'planner-model-partition',
  };
}

function profileRegionActivity(
  metadata: HabitLearningProfileValueMetadata,
  rawValue: HabitLearningJsonValue,
): 'active' | 'inactive' | 'unknown' {
  if (typeof rawValue === 'boolean') return rawValue ? 'active' : 'inactive';
  if (
    metadata.sourceDtype === 'boolean' &&
    typeof rawValue === 'number' &&
    (rawValue === 0 || rawValue === 1)
  ) {
    return rawValue === 1 ? 'active' : 'inactive';
  }
  const listed =
    typeof rawValue === 'number'
      ? metadata.valueList?.find(({ value }) => value === rawValue)?.description
      : undefined;
  const semantic = (listed ?? (typeof rawValue === 'string' ? rawValue : ''))
    .trim()
    .toLocaleLowerCase();
  if (semantic.length === 0) return 'unknown';
  if (
    /(?:no-?show|not[- _]?present|unoccupied|inactive|absent|clear|false|off|无人|无人在|未占用)/u.test(
      semantic,
    )
  ) {
    return 'inactive';
  }
  if (/(?:show|occupied|active|present|presence|true|on|有人|占用)/u.test(semantic)) {
    return 'active';
  }
  return 'unknown';
}

function analysisChannelKey(deviceKey: string, channelKey: string): string {
  return `${deviceKey}\u0000${channelKey}`;
}

export function overlappingGapIds(
  gaps: readonly HabitLearningAnalysisGap[],
  start: number,
  end: number,
): string[] {
  return gaps
    .filter((gap) => gap.start < end && gap.end > start)
    .map(({ gapId }) => gapId)
    .sort();
}

function safeExclusivePointEnd(timestamp: number): number {
  if (!Number.isSafeInteger(timestamp) || timestamp >= Number.MAX_SAFE_INTEGER) {
    throw new ConfigError('profile evidence timestamp is outside the safe range');
  }
  return timestamp + 1;
}

export function groupHabitLearningPointEventsByLocalDate<
  T extends { sourceId: string; observedAt: number },
>(
  observations: readonly T[],
  timezone: string,
): Array<{ sourceId: string; localDate: string; observations: T[] }> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: requireIanaTimezone(timezone, 'habit-learning point-event timezone'),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const groups = new Map<string, { sourceId: string; localDate: string; observations: T[] }>();
  for (const observation of [...observations].sort(
    (left, right) =>
      left.observedAt - right.observedAt || left.sourceId.localeCompare(right.sourceId),
  )) {
    if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0) {
      throw new ConfigError(
        'habit-learning point-event observedAt must be non-negative integer ms',
      );
    }
    const parts = new Map(
      formatter
        .formatToParts(new Date(observation.observedAt))
        .filter(({ type }) => type === 'year' || type === 'month' || type === 'day')
        .map(({ type, value }) => [type, value]),
    );
    const year = parts.get('year');
    const month = parts.get('month');
    const day = parts.get('day');
    if (year === undefined || month === undefined || day === undefined) {
      throw new ConfigError(`could not project observation timestamp in ${timezone}`);
    }
    const localDate = `${year}-${month}-${day}`;
    const key = `${observation.sourceId}\u0000${localDate}`;
    const group = groups.get(key) ?? {
      sourceId: observation.sourceId,
      localDate,
      observations: [],
    };
    group.observations.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.localDate.localeCompare(right.localDate),
  );
}

function captureAnalysisGaps(
  journal: CaptureJournalData,
  rangeStart: number,
  rangeEnd: number,
): HabitLearningAnalysisGap[] {
  const batches = [...journal.batches].sort((left, right) => left.sequence - right.sequence);
  const bySequence = new Map<number, HabitLearningCaptureGapRecord[]>();
  for (const gap of journal.gaps) {
    const current = bySequence.get(gap.sequence) ?? [];
    current.push(gap);
    bySequence.set(gap.sequence, current);
  }
  const ranges: HabitLearningAnalysisGap[] = [];
  for (const [sequence, records] of bySequence) {
    const previousAt = [...batches]
      .reverse()
      .find(
        (batch) => batch.sequence < sequence && batchGatewayTimestamp(batch, 'last') !== undefined,
      );
    const currentAt = batches.find(
      (batch) => batch.sequence >= sequence && batchGatewayTimestamp(batch, 'first') !== undefined,
    );
    const previousTimestamp =
      previousAt === undefined ? undefined : batchGatewayTimestamp(previousAt, 'last');
    const currentTimestamp =
      currentAt === undefined ? undefined : batchGatewayTimestamp(currentAt, 'first');
    const start = Math.max(
      rangeStart,
      Math.min(
        previousTimestamp === undefined ? rangeStart : safeExclusivePointEnd(previousTimestamp),
        rangeEnd,
      ),
    );
    const end = Math.min(rangeEnd, currentTimestamp ?? rangeEnd);
    if (end <= start) continue;
    ranges.push({
      gapId: stableDigest(records.map(({ gapId }) => gapId).sort()),
      start,
      end,
    });
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: HabitLearningAnalysisGap[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start >= previous.end) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = {
      gapId: stableDigest([previous.gapId, range.gapId].sort()),
      start: previous.start,
      end: Math.max(previous.end, range.end),
    };
  }
  return merged;
}

export function resolveProfileGatewayWindow(
  journal: CaptureJournalData,
  ruleId: string,
): {
  start: number;
  end: number;
  enableBoundary: { entryIndex: number; timestamp: number };
} {
  const enableBoundaries = journal.entries.flatMap((entry, entryIndex) =>
    entry.graphId === ruleId &&
    entry.rawType === 'r' &&
    isRecord(entry.ruleConfig) &&
    entry.ruleConfig.enable === true
      ? [{ entryIndex, timestamp: entry.timestamp }]
      : [],
  );
  if (enableBoundaries.length !== 1) {
    throw new ConfigError(
      `profile requires exactly one captured gateway enable boundary; found ${enableBoundaries.length}`,
    );
  }
  const enableBoundary = enableBoundaries[0];
  if (enableBoundary === undefined) {
    throw new ConfigError('profile gateway enable boundary is missing');
  }
  const lastTimestamp = Math.max(
    enableBoundary.timestamp,
    ...journal.entries
      .filter((entry) => entry.graphId === ruleId)
      .map(({ timestamp }) => timestamp),
  );
  const end = Math.max(lastTimestamp + 1, enableBoundary.timestamp + 1);
  if (
    !Number.isSafeInteger(lastTimestamp) ||
    !Number.isSafeInteger(end) ||
    end >= Number.MAX_SAFE_INTEGER
  ) {
    throw new ConfigError('profile gateway evidence timestamp is outside the safe range');
  }
  return {
    start: enableBoundary.timestamp,
    end,
    enableBoundary,
  };
}

function batchGatewayTimestamp(
  batch: HabitLearningCaptureBatchRecord | undefined,
  edge: 'first' | 'last',
): number | undefined {
  if (batch === undefined || batch.entries.length === 0) return undefined;
  const timestamps = batch.entries.map(({ timestamp }) => timestamp);
  return edge === 'first' ? Math.min(...timestamps) : Math.max(...timestamps);
}

function coverageIdSet(ids: Iterable<string>): CoverageIdSet {
  const sorted = [...new Set(ids)].sort();
  return { count: sorted.length, ids: sorted };
}

export function runtimeCoverageReport(
  plan: HabitLearningPlan,
  coverage: HabitLearningObservedSignalCoverage,
): {
  devices: RuntimeDeviceCoverage;
  rooms: RuntimeRoomCoverage;
  signals: RuntimeSignalCoverage;
} {
  const signalSet = (ids: readonly string[]): Set<string> => new Set(ids);
  const included = signalSet(coverage.includedSignalIds);
  const expectedPreload = signalSet(coverage.expectedPreloadSignalIds);
  const baselineSeen = signalSet(coverage.baselineSeenSignalIds);
  const behaviorObserved = signalSet(coverage.behaviorObservedSignalIds);
  const baselineOnly = signalSet(coverage.baselineOnlySignalIds);
  const stateAnchorOnly = signalSet(coverage.stateAnchorOnlySignalIds);
  const ambiguous = signalSet(coverage.ambiguousSignalIds);
  const missing = signalSet(coverage.missingSignalIds);
  const signalsByDevice = new Map<string, HabitLearningPlanSignal[]>();
  const signalsByRoom = new Map<string, HabitLearningPlanSignal[]>();
  for (const signal of plan.signals) {
    const deviceSignals = signalsByDevice.get(signal.device.did) ?? [];
    deviceSignals.push(signal);
    signalsByDevice.set(signal.device.did, deviceSignals);
    const roomSignals = signalsByRoom.get(signal.device.roomId) ?? [];
    roomSignals.push(signal);
    signalsByRoom.set(signal.device.roomId, roomSignals);
  }

  const deviceDetails: RuntimeDeviceCoverage['details'] = plan.deviceCoverage.map((device) => {
    const deviceSignals = signalsByDevice.get(device.did) ?? [];
    return {
      deviceId: device.did,
      roomId: device.roomId,
      status: device.status,
      observableSignalIds: signalIdsMatching(deviceSignals, (signal) =>
        ['event', 'push-notify'].includes(signal.observability),
      ),
      includedSignalIds: signalIdsMatching(deviceSignals, ({ signalId }) => included.has(signalId)),
      behaviorObservedSignalIds: signalIdsMatching(deviceSignals, ({ signalId }) =>
        behaviorObserved.has(signalId),
      ),
      baselineSeenSignalIds: signalIdsMatching(deviceSignals, ({ signalId }) =>
        baselineSeen.has(signalId),
      ),
      baselineOnlySignalIds: signalIdsMatching(deviceSignals, ({ signalId }) =>
        baselineOnly.has(signalId),
      ),
      ambiguousSignalIds: signalIdsMatching(deviceSignals, ({ signalId }) =>
        ambiguous.has(signalId),
      ),
      missingSignalIds: signalIdsMatching(deviceSignals, ({ signalId }) => missing.has(signalId)),
      excludedSignals: excludedSignalDetails(deviceSignals),
    };
  });
  const includedDeviceIds = deviceDetails
    .filter(({ status }) => status !== 'excluded')
    .map(({ deviceId }) => deviceId);
  const behaviorDeviceIds = deviceDetails
    .filter(({ behaviorObservedSignalIds }) => behaviorObservedSignalIds.length > 0)
    .map(({ deviceId }) => deviceId);
  const behaviorDevices = new Set(behaviorDeviceIds);
  const baselineOnlyDeviceIds = deviceDetails
    .filter(
      ({ deviceId, baselineSeenSignalIds }) =>
        !behaviorDevices.has(deviceId) && baselineSeenSignalIds.length > 0,
    )
    .map(({ deviceId }) => deviceId);
  const behaviorOrBaselineDevices = new Set([...behaviorDeviceIds, ...baselineOnlyDeviceIds]);
  const ambiguousDeviceIds = deviceDetails
    .filter(
      ({ deviceId, ambiguousSignalIds }) =>
        !behaviorOrBaselineDevices.has(deviceId) && ambiguousSignalIds.length > 0,
    )
    .map(({ deviceId }) => deviceId);
  const classifiedDevices = new Set([
    ...behaviorDeviceIds,
    ...baselineOnlyDeviceIds,
    ...ambiguousDeviceIds,
  ]);
  const missingDeviceIds = includedDeviceIds.filter((deviceId) => !classifiedDevices.has(deviceId));
  const excludedDeviceDetails = deviceDetails
    .filter(({ status }) => status === 'excluded')
    .map(({ deviceId }) => ({
      deviceId,
      reasonCodes: [
        ...(plan.deviceCoverage.find(({ did }) => did === deviceId)?.reasonCodes ?? []),
      ],
    }));

  const roomIds = [...new Set(plan.deviceCoverage.map(({ roomId }) => roomId))].sort();
  const roomNames = new Map(plan.deviceCoverage.map(({ roomId, roomName }) => [roomId, roomName]));
  const roomDetails: RuntimeRoomCoverage['details'] = roomIds.map((roomId) => {
    const roomSignals = signalsByRoom.get(roomId) ?? [];
    return {
      roomId,
      roomName: roomNames.get(roomId) ?? '',
      deviceCount: plan.deviceCoverage.filter((device) => device.roomId === roomId).length,
      candidateSignalCount: roomSignals.filter((signal) =>
        ['event', 'push-notify'].includes(signal.observability),
      ).length,
      includedSignalCount: countSignalsMatching(roomSignals, included),
      behaviorObservedSignalCount: countSignalsMatching(roomSignals, behaviorObserved),
      baselineSeenSignalCount: countSignalsMatching(roomSignals, baselineSeen),
      baselineOnlySignalCount: countSignalsMatching(roomSignals, baselineOnly),
      ambiguousSignalCount: countSignalsMatching(roomSignals, ambiguous),
      missingSignalCount: countSignalsMatching(roomSignals, missing),
      excludedSignals: excludedSignalDetails(roomSignals),
    };
  });
  const includedRoomIds = roomDetails
    .filter(({ includedSignalCount }) => includedSignalCount > 0)
    .map(({ roomId }) => roomId);
  const behaviorRoomIds = roomDetails
    .filter(({ behaviorObservedSignalCount }) => behaviorObservedSignalCount > 0)
    .map(({ roomId }) => roomId);
  const behaviorRooms = new Set(behaviorRoomIds);
  const baselineOnlyRoomIds = roomDetails
    .filter(
      ({ roomId, baselineSeenSignalCount }) =>
        !behaviorRooms.has(roomId) && baselineSeenSignalCount > 0,
    )
    .map(({ roomId }) => roomId);
  const behaviorOrBaselineRooms = new Set([...behaviorRoomIds, ...baselineOnlyRoomIds]);
  const ambiguousRoomIds = roomDetails
    .filter(
      ({ roomId, ambiguousSignalCount }) =>
        !behaviorOrBaselineRooms.has(roomId) && ambiguousSignalCount > 0,
    )
    .map(({ roomId }) => roomId);
  const classifiedRooms = new Set([
    ...behaviorRoomIds,
    ...baselineOnlyRoomIds,
    ...ambiguousRoomIds,
  ]);
  const missingRoomIds = includedRoomIds.filter((roomId) => !classifiedRooms.has(roomId));

  return {
    devices: {
      visible: coverageIdSet(deviceDetails.map(({ deviceId }) => deviceId)),
      included: coverageIdSet(includedDeviceIds),
      excluded: {
        ...coverageIdSet(excludedDeviceDetails.map(({ deviceId }) => deviceId)),
        details: excludedDeviceDetails,
      },
      behaviorObserved: coverageIdSet(behaviorDeviceIds),
      baselineOnly: coverageIdSet(baselineOnlyDeviceIds),
      ambiguous: coverageIdSet(ambiguousDeviceIds),
      missing: coverageIdSet(missingDeviceIds),
      details: deviceDetails,
    },
    rooms: {
      visible: coverageIdSet(roomIds),
      included: coverageIdSet(includedRoomIds),
      excluded: coverageIdSet(roomIds.filter((roomId) => !includedRoomIds.includes(roomId))),
      behaviorObserved: coverageIdSet(behaviorRoomIds),
      baselineOnly: coverageIdSet(baselineOnlyRoomIds),
      ambiguous: coverageIdSet(ambiguousRoomIds),
      missing: coverageIdSet(missingRoomIds),
      details: roomDetails,
    },
    signals: {
      observable: coverageIdSet(
        plan.signals
          .filter((signal) => ['event', 'push-notify'].includes(signal.observability))
          .map(({ signalId }) => signalId),
      ),
      included: coverageIdSet(coverage.includedSignalIds),
      expectedPreload: coverageIdSet(expectedPreload),
      baselineSeen: coverageIdSet(baselineSeen),
      behaviorObserved: coverageIdSet(behaviorObserved),
      baselineOnly: coverageIdSet(baselineOnly),
      stateAnchorOnly: coverageIdSet(stateAnchorOnly),
      ambiguous: coverageIdSet(ambiguous),
      missing: coverageIdSet(missing),
      excluded: {
        ...coverageIdSet(coverage.excludedSignalIds),
        details: excludedSignalDetails(plan.signals),
      },
    },
  };
}

function signalIdsMatching(
  signals: readonly HabitLearningPlanSignal[],
  predicate: (signal: HabitLearningPlanSignal) => boolean,
): string[] {
  return signals
    .filter(predicate)
    .map(({ signalId }) => signalId)
    .sort();
}

function countSignalsMatching(
  signals: readonly HabitLearningPlanSignal[],
  signalIds: ReadonlySet<string>,
): number {
  return signals.reduce((count, { signalId }) => count + (signalIds.has(signalId) ? 1 : 0), 0);
}

function excludedSignalDetails(
  signals: readonly HabitLearningPlanSignal[],
): CoverageExcludedSignalSet['details'] {
  return signals
    .filter(({ included }) => !included)
    .map(({ signalId, reasonCodes }) => ({
      signalId,
      reasonCodes: [...reasonCodes],
    }))
    .sort((left, right) => left.signalId.localeCompare(right.signalId));
}

function provesStartToFinishContinuity(
  journal: CaptureJournalData,
  session: HabitLearningStudySession,
): boolean {
  if (journal.gaps.length > 0 || journal.batches.length < 2) return false;
  const observationStartedAt = Date.parse(
    session.timestamps.observationStartedAt ?? session.timestamps.createdAt,
  );
  const finalCaptureCommittedAt = Date.parse(session.timestamps.finalCaptureCommittedAt ?? '');
  if (
    !Number.isFinite(observationStartedAt) ||
    !Number.isFinite(finalCaptureCommittedAt) ||
    finalCaptureCommittedAt < observationStartedAt
  ) {
    return false;
  }

  const first = journal.batches[0];
  const last = journal.batches.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    first.phase !== 'initial-window' ||
    Date.parse(first.capturedAt) < observationStartedAt ||
    last.capturedAt !== session.timestamps.finalCaptureCommittedAt
  ) {
    return false;
  }
  const enableBoundaryPresent = first.entries.some(
    (entry) =>
      entry.rawType === 'r' && isRecord(entry.ruleConfig) && entry.ruleConfig.enable === true,
  );
  if (!enableBoundaryPresent) return false;

  let previousCapturedAt = Number.NEGATIVE_INFINITY;
  for (const [index, batch] of journal.batches.entries()) {
    const capturedAt = Date.parse(batch.capturedAt);
    if (
      batch.sequence !== index + 1 ||
      !Number.isFinite(capturedAt) ||
      capturedAt < previousCapturedAt ||
      capturedAt > finalCaptureCommittedAt ||
      batch.completenessReasons.length > 0
    ) {
      return false;
    }
    if (
      index > 0 &&
      (batch.phase !== 'incremental' ||
        batch.scan.overlappedLines === 0 ||
        batch.scan.overlapCandidates !== 1)
    ) {
      return false;
    }
    previousCapturedAt = capturedAt;
  }
  return true;
}

function sourceToSignalMap(compilation: CompiledHabitLearningRule): Map<string, string> {
  const result = new Map<string, string>();
  for (const declaration of compilation.localVariables) {
    result.set(declaration.sourceId, declaration.signalId);
  }
  for (const source of compilation.sourceMap.sources) {
    if (!result.has(source.sourceId)) result.set(source.sourceId, source.sourceId);
  }
  return result;
}

function renderProfileMarkdown(profile: HabitLearningProfile): string {
  const lines = [
    '# 家庭习惯学习画像',
    '',
    `- 画像 ID：${profile.profileId}`,
    `- 观察窗口：${new Date(profile.observedFrom).toISOString()} — ${new Date(profile.observedUntil).toISOString()}`,
    `- 完整性：${profile.completeness.status}`,
    `- 已观察信号：${profile.completeness.observedSignalCount}/${profile.completeness.includedSignalCount}`,
    `- 日志缺口：${profile.completeness.gapCount}`,
    '',
    '## 使用边界',
    '',
    '- 画像只包含匿名设备键，不包含原始设备标识。',
    '- 人数估计值不能用来推断家庭常住人数，也不能用于识别个人。',
    '- 自动生成的规律仅是证据候选；在用户确认前不得直接转成自动化。',
    '',
    '## 直接观察',
    '',
    ...profile.observations.map(
      (observation) =>
        `- ${observation.deviceKey ?? 'device_unknown'} · ${observation.signalKey}：${observation.kind}，${observation.count?.min ?? 0} 次`,
    ),
    '',
    '## 待用户确认的候选规律',
    '',
    ...(profile.hypotheses.length === 0
      ? ['- 当前证据尚不足以生成跨日重复候选。']
      : profile.hypotheses.map(
          (hypothesis) =>
            `- ${hypothesis.statement}（置信度 ${hypothesis.confidence.toFixed(2)}；证据 ${hypothesis.evidenceObservationIds.length} 条）`,
        )),
    '',
    '## 用户确认',
    '',
    ...(profile.userConfirmed.length === 0
      ? ['- 暂无。']
      : profile.userConfirmed.map(
          (confirmation) =>
            `- ${JSON.stringify(confirmation.subject)} → ${JSON.stringify(confirmation.value)}`,
        )),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function writeHandoff(
  artifacts: HabitLearningPrivateArtifacts,
  session: HabitLearningStudySession,
  coverage: StudyCoverageArtifact,
): Promise<void> {
  const next =
    session.phase === 'ready-disabled'
      ? `xgg learn start --study-dir ${shellDisplayPath(artifacts.paths.study)} --enable --plan-id ${coverage.compilation.planId}`
      : session.phase === 'observing' || session.phase === 'observing-degraded'
        ? `xgg learn capture --study-dir ${shellDisplayPath(artifacts.paths.study)} --follow`
        : session.phase === 'awaiting-clarification'
          ? `xgg learn finish --study-dir ${shellDisplayPath(artifacts.paths.study)}`
          : session.phase === 'complete'
            ? `xgg learn profile --study-dir ${shellDisplayPath(artifacts.paths.study)} --minimum-completeness bounded`
            : `xgg learn status --study-dir ${shellDisplayPath(artifacts.paths.study)}`;
  await artifacts.writeText(
    'handoff',
    `# XGG household study handoff

- Study ID: ${session.studyId}
- Phase: ${session.phase}
- Rule ID: ${session.rule?.ruleId ?? 'not-created'}
- Expected enabled: ${session.rule?.expectedEnabled ?? false}
- Planned end: ${coverage.plannedEndAt}
- Finish stage: ${session.finish?.stage ?? 'not-started'}
- Pending clarifications: ${session.finish?.pendingClarifications.length ?? 0}
- Private device map: ${artifacts.paths.deviceMap}
- Next command: \`${next}\`

This directory is private. Do not commit inventory, specs, logs, corrections,
or profiles. Never infer household size or person identity from sensor values.
`,
  );
}

async function acquireFollowLease(studyPath: string): Promise<{
  path: string;
  owner: FollowOwner;
}> {
  const path = join(studyPath, FOLLOW_OWNER_FILE);
  await mkdir(studyPath, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date().toISOString();
    const owner: FollowOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
    };
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { path, owner };
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const current = await readFollowOwner(path);
      if (current !== undefined && processIsAlive(current.pid)) {
        throw new ConfigError(
          `another live capture supervisor owns this study (pid ${current.pid})`,
        );
      }
      await refuseSymlinkThenUnlink(path);
    }
  }
  throw new ConfigError('unable to acquire the capture supervisor lease');
}

async function updateFollowLease(
  lease: { path: string; owner: FollowOwner },
  patch: Pick<FollowOwner, 'heartbeatAt'> &
    Partial<Pick<FollowOwner, 'lastOutcome' | 'nextPollAt'>>,
): Promise<void> {
  const current = await readFollowOwner(lease.path);
  if (current?.token !== lease.owner.token) {
    throw new ConfigError('capture supervisor lease changed while follow mode was running');
  }
  lease.owner = { ...lease.owner, ...patch };
  await writePrivateAtomic(lease.path, `${JSON.stringify(lease.owner)}\n`);
}

async function releaseFollowLease(lease: {
  path: string;
  owner: FollowOwner;
}): Promise<void> {
  const current = await readFollowOwner(lease.path);
  if (current?.token === lease.owner.token) await refuseSymlinkThenUnlink(lease.path);
}

async function readFollowOwner(path: string): Promise<FollowOwner | undefined> {
  const raw = await readPrivateRegularText(path);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.heartbeatAt === 'string'
    ) {
      return parsed as unknown as FollowOwner;
    }
  } catch {
    // A malformed owner is conservatively treated as live/unsafe below.
  }
  throw new ConfigError('capture supervisor owner file is malformed; inspect it manually');
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

function followOwnerIsStale(owner: FollowOwner): boolean {
  if (!processIsAlive(owner.pid)) return true;
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatAt)) return true;
  const nextPollAt = owner.nextPollAt === undefined ? Number.NaN : Date.parse(owner.nextPollAt);
  const deadline = Number.isFinite(nextPollAt)
    ? nextPollAt + 60_000
    : heartbeatAt + 2 * DEFAULT_CAPTURE_INTERVAL_MS;
  return Date.now() > deadline;
}

async function refuseSymlinkThenUnlink(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ConfigError(`refusing non-regular private owner file: ${path}`);
  }
  await unlink(path);
}

async function writePrivateAtomic(path: string, value: string): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new ConfigError(`refusing non-regular private file: ${path}`);
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(value, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncPrivateDirectory(dirname(path));
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
  }
}

async function readPrivateRegularText(path: string): Promise<string | undefined> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (stat === undefined) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ConfigError(`refusing non-regular private file: ${path}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new ConfigError(`refusing non-regular private file: ${path}`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function syncPrivateDirectory(path: string): Promise<void> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const directory = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollow,
  );
  try {
    const stat = await directory.stat();
    if (!stat.isDirectory()) throw new ConfigError(`private parent is not a directory: ${path}`);
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function interruptibleDelay(milliseconds: number, stopped: () => boolean): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!stopped()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(remaining, 1_000)));
  }
}

function shellDisplayPath(path: string): string {
  return JSON.stringify(path);
}

function stableDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isConfirmedOutsideGitWorkTree(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const stderr = typeof error.stderr === 'string' ? error.stderr.toLowerCase() : '';
  return (
    (error.code === 128 || error.code === '128') &&
    (stderr.includes('not a git repository') || stderr.includes('not a git work tree'))
  );
}

function commandFailureSummary(error: unknown): string {
  if (!isRecord(error)) return error instanceof Error ? error.message : String(error);
  const code =
    typeof error.code === 'string' || typeof error.code === 'number'
      ? String(error.code)
      : 'unknown';
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  return stderr.length > 0 ? `exit ${code}: ${stderr}` : `exit ${code}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}
