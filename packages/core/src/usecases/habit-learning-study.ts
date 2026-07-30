import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  HABIT_LEARNING_FINISH_STAGES,
  HABIT_LEARNING_STUDY_SESSION_VERSION,
  type HabitLearningStudyPhase,
  type HabitLearningStudySession,
  type HabitLearningStudySessionInput,
  HabitLearningStudySessionSchema,
} from '../schemas/habit-learning-study.js';
import {
  HabitLearningStudyStore,
  type HabitLearningStudyStoreOptions,
  type HabitLearningStudyStorePaths,
} from './habit-learning-store.js';

export interface HabitLearningStudyArtifactPaths extends HabitLearningStudyStorePaths {
  session: string;
  plan: string;
  coverage: string;
  inventory: string;
  deviceMap: string;
  specs: string;
  graphs: string;
  graph: string;
  captureState: string;
  gaps: string;
  corrections: string;
  profile: string;
  profileMarkdown: string;
  handoff: string;
}

export type HabitLearningJsonArtifact =
  | 'plan'
  | 'coverage'
  | 'inventory'
  | 'deviceMap'
  | 'graph'
  | 'profile';
export type HabitLearningTextArtifact = 'profileMarkdown' | 'handoff';

export interface HabitLearningGitExposure {
  /** Whether the private study path is nested in a Git work tree. */
  insideWorkTree: boolean;
  /** Whether Git already tracks the path or any private artifact below it. */
  tracked: boolean;
  /** Whether the study path is covered by an effective ignore rule. */
  ignored: boolean;
}

export interface HabitLearningGitLeakAssessment {
  safe: boolean;
  reason: 'outside-work-tree' | 'ignored-private-path' | 'tracked' | 'unignored';
}

export type HabitLearningGitExposureInspector = (
  studyPath: string,
) => HabitLearningGitExposure | Promise<HabitLearningGitExposure>;

export interface HabitLearningPrivateArtifactsOptions
  extends Pick<
    HabitLearningStudyStoreOptions,
    'path' | 'lockTimeoutMs' | 'lockRetryMs' | 'orphanLockStaleMs'
  > {
  /** Reuse the exact capture store so its state.json and journal.ndjson stay canonical. */
  studyStore?: HabitLearningStudyStore;
  /**
   * Optional injected Git inspection. Core deliberately executes no Git
   * commands; a CLI adapter can supply check-ignore/ls-files results here.
   */
  inspectGitExposure?: HabitLearningGitExposureInspector;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<HabitLearningStudyPhase, ReadonlySet<HabitLearningStudyPhase>>
> = Object.freeze({
  preparing: new Set<HabitLearningStudyPhase>(['preparing', 'ready-disabled']),
  'ready-disabled': new Set<HabitLearningStudyPhase>(['ready-disabled', 'observing']),
  observing: new Set<HabitLearningStudyPhase>(['observing', 'observing-degraded', 'finishing']),
  'observing-degraded': new Set<HabitLearningStudyPhase>([
    'observing-degraded',
    'observing',
    'finishing',
  ]),
  finishing: new Set<HabitLearningStudyPhase>(['finishing', 'awaiting-clarification']),
  'awaiting-clarification': new Set<HabitLearningStudyPhase>([
    'awaiting-clarification',
    'complete',
  ]),
  complete: new Set<HabitLearningStudyPhase>(['complete']),
});

const LOGIN_CODE_KEY_PATTERN =
  /^(?:(?:gateway)?(?:login|verification|auth|pairing)(?:sixdigit)?code|sixdigit(?:login)?code|登录码|验证码|六位登录码|六位码)$/iu;
const LOGIN_CODE_TEXT_PATTERNS = [
  /(?:gateway\s*)?(?:login|verification|auth|pairing)\s*code\s*(?:is\s*)?[:：]?\s*\d{6}/i,
  /(?:登录码|验证码|六\s*位(?:登录)?码|6\s*位(?:登录)?码)\s*(?:是|为)?\s*[:：]?\s*\d{6}/u,
] as const;

/**
 * Private artifact coordinator for one household study.
 *
 * `session.json` is the lifecycle checkpoint. The reused
 * HabitLearningStudyStore remains the sole owner of capture `state.json`,
 * `journal.ndjson`, and its cross-process writer lock.
 */
export class HabitLearningPrivateArtifacts {
  readonly studyStore: HabitLearningStudyStore;
  readonly paths: Readonly<HabitLearningStudyArtifactPaths>;

  private readonly inspectGitExposure: HabitLearningGitExposureInspector | undefined;

  constructor(options: HabitLearningPrivateArtifactsOptions) {
    const studyPath = resolve(options.path);
    if (options.studyStore !== undefined) {
      if (options.studyStore.paths.study !== studyPath) {
        throw new TypeError(
          `Habit-learning artifact path ${studyPath} does not match reused store ${options.studyStore.paths.study}`,
        );
      }
      this.studyStore = options.studyStore;
    } else {
      this.studyStore = new HabitLearningStudyStore({
        path: studyPath,
        ...(options.lockTimeoutMs !== undefined && { lockTimeoutMs: options.lockTimeoutMs }),
        ...(options.lockRetryMs !== undefined && { lockRetryMs: options.lockRetryMs }),
        ...(options.orphanLockStaleMs !== undefined && {
          orphanLockStaleMs: options.orphanLockStaleMs,
        }),
      });
    }
    this.inspectGitExposure = options.inspectGitExposure;
    this.paths = createHabitLearningStudyArtifactPaths(this.studyStore.paths);
  }

  async initialize(): Promise<void> {
    if (this.inspectGitExposure !== undefined) {
      assertHabitLearningGitLeakGuard(await this.inspectGitExposure(this.paths.study));
    }
    await this.studyStore.initialize();
    await ensurePrivateDirectory(this.paths.specs, 'habit-learning specs directory');
    await ensurePrivateDirectory(this.paths.graphs, 'habit-learning graphs directory');
  }

  async readSession(): Promise<HabitLearningStudySession | undefined> {
    await this.initialize();
    const value = await readPrivateJsonIfPresent(this.paths.session, 'habit-learning session');
    return value === undefined ? undefined : HabitLearningStudySessionSchema.parse(value);
  }

  async writeSession(session: HabitLearningStudySessionInput): Promise<HabitLearningStudySession> {
    const parsed = HabitLearningStudySessionSchema.parse(session);
    await this.initialize();
    await this.studyStore.withLock(async () => {
      const existingValue = await readPrivateJsonIfPresent(
        this.paths.session,
        'habit-learning session',
      );
      if (existingValue !== undefined) {
        const existing = HabitLearningStudySessionSchema.parse(existingValue);
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
          throw new Error(
            'Habit-learning session already exists; use transitionSession for replacement',
          );
        }
        return;
      }
      await writePrivateJson(this.paths.session, parsed, 'habit-learning session');
    });
    return parsed;
  }

  async transitionSession(
    previous: HabitLearningStudySession,
    next: HabitLearningStudySessionInput,
  ): Promise<HabitLearningStudySession> {
    const parsed = assertHabitLearningStudyTransition(previous, next);
    await this.initialize();
    await this.studyStore.withLock(async () => {
      const currentValue = await readPrivateJsonIfPresent(
        this.paths.session,
        'habit-learning session',
      );
      if (currentValue === undefined) {
        throw new Error('Habit-learning session does not exist');
      }
      const current = HabitLearningStudySessionSchema.parse(currentValue);
      if (JSON.stringify(current) !== JSON.stringify(previous)) {
        throw new Error(
          `Habit-learning session changed concurrently at revision ${current.revision}`,
        );
      }
      await writePrivateJson(this.paths.session, parsed, 'habit-learning session');
    });
    return parsed;
  }

  async readJson<T = unknown>(artifact: HabitLearningJsonArtifact): Promise<T | undefined> {
    await this.initialize();
    return (await readPrivateJsonIfPresent(this.paths[artifact], `habit-learning ${artifact}`)) as
      | T
      | undefined;
  }

  async writeJson(artifact: HabitLearningJsonArtifact, value: unknown): Promise<void> {
    await this.initialize();
    await this.studyStore.withLock(() =>
      writePrivateJson(this.paths[artifact], value, `habit-learning ${artifact}`),
    );
  }

  specPath(specIdentifier: string): string {
    if (specIdentifier.trim().length === 0) {
      throw new TypeError('Habit-learning spec identifier must not be empty');
    }
    const digest = createHash('sha256').update(specIdentifier, 'utf8').digest('hex');
    return join(this.paths.specs, `${digest}.json`);
  }

  async readSpec<T = unknown>(specIdentifier: string): Promise<T | undefined> {
    await this.initialize();
    return (await readPrivateJsonIfPresent(
      this.specPath(specIdentifier),
      'habit-learning device spec',
    )) as T | undefined;
  }

  async writeSpec(specIdentifier: string, value: unknown): Promise<string> {
    await this.initialize();
    const path = this.specPath(specIdentifier);
    await this.studyStore.withLock(() =>
      writePrivateJson(path, value, 'habit-learning device spec'),
    );
    return path;
  }

  async readText(artifact: HabitLearningTextArtifact): Promise<string | undefined> {
    await this.initialize();
    return readPrivateTextIfPresent(this.paths[artifact], `habit-learning ${artifact}`);
  }

  async writeText(artifact: HabitLearningTextArtifact, value: string): Promise<void> {
    assertNoGatewayLoginCode(value);
    await this.initialize();
    await this.studyStore.withLock(() =>
      writePrivateText(this.paths[artifact], value, `habit-learning ${artifact}`),
    );
  }

  async readCorrections<T = unknown>(): Promise<T[]> {
    await this.initialize();
    return readPrivateNdjson(this.paths.corrections, 'habit-learning corrections');
  }

  async appendCorrections(
    records: readonly Readonly<Record<string, unknown>>[],
  ): Promise<{ records: number; bytes: number }> {
    await this.initialize();
    return this.studyStore.withLock(() =>
      appendPrivateNdjson(this.paths.corrections, records, 'habit-learning corrections'),
    );
  }
}

export function createHabitLearningStudyArtifactPaths(
  storePaths: Readonly<HabitLearningStudyStorePaths>,
): Readonly<HabitLearningStudyArtifactPaths> {
  const specs = join(storePaths.study, 'specs');
  const graphs = join(storePaths.study, 'graphs');
  return Object.freeze({
    ...storePaths,
    session: join(storePaths.study, 'session.json'),
    plan: join(storePaths.study, 'plan.json'),
    coverage: join(storePaths.study, 'coverage.json'),
    inventory: join(storePaths.study, 'inventory.private.json'),
    deviceMap: join(storePaths.study, 'device-map.private.json'),
    specs,
    graphs,
    graph: join(graphs, 'rule.json'),
    captureState: storePaths.state,
    gaps: join(storePaths.study, 'gaps.ndjson'),
    corrections: join(storePaths.study, 'corrections.ndjson'),
    profile: join(storePaths.study, 'profile.json'),
    profileMarkdown: join(storePaths.study, 'profile.md'),
    handoff: join(storePaths.study, 'handoff.md'),
  });
}

export function assessHabitLearningGitLeakRisk(
  exposure: HabitLearningGitExposure,
): HabitLearningGitLeakAssessment {
  if (exposure.tracked) return { safe: false, reason: 'tracked' };
  if (!exposure.insideWorkTree) return { safe: true, reason: 'outside-work-tree' };
  if (exposure.ignored) return { safe: true, reason: 'ignored-private-path' };
  return { safe: false, reason: 'unignored' };
}

export function assertHabitLearningGitLeakGuard(exposure: HabitLearningGitExposure): void {
  const assessment = assessHabitLearningGitLeakRisk(exposure);
  if (assessment.safe) return;
  if (assessment.reason === 'tracked') {
    throw new Error('Refusing tracked Git path for private habit-learning artifacts');
  }
  throw new Error('Refusing unignored Git path for private habit-learning artifacts');
}

export function createInitialHabitLearningStudySession(input: {
  studyId?: string;
  now: string;
}): HabitLearningStudySession {
  return HabitLearningStudySessionSchema.parse({
    sessionVersion: HABIT_LEARNING_STUDY_SESSION_VERSION,
    studyId: input.studyId ?? randomUUID(),
    phase: 'preparing',
    revision: 0,
    timestamps: {
      createdAt: input.now,
      updatedAt: input.now,
    },
    degradedReasonCodes: [],
  });
}

/**
 * Validate a durable session replacement and reject lifecycle rollback or
 * graph-identity drift. Same-phase replacements are allowed for capture and
 * finish checkpoints, but every replacement increments revision exactly once.
 */
export function assertHabitLearningStudyTransition(
  previousInput: HabitLearningStudySessionInput,
  nextInput: HabitLearningStudySessionInput,
): HabitLearningStudySession {
  const previous = HabitLearningStudySessionSchema.parse(previousInput);
  const next = HabitLearningStudySessionSchema.parse(nextInput);
  if (next.studyId !== previous.studyId) {
    throw new TypeError('Habit-learning studyId is immutable');
  }
  if (next.sessionVersion !== previous.sessionVersion) {
    throw new TypeError('Habit-learning sessionVersion is immutable');
  }
  if (next.revision !== previous.revision + 1) {
    throw new TypeError(
      `Habit-learning revision must advance exactly once (${previous.revision} -> ${next.revision})`,
    );
  }
  if (!ALLOWED_TRANSITIONS[previous.phase].has(next.phase)) {
    throw new TypeError(
      `Invalid habit-learning phase transition: ${previous.phase} -> ${next.phase}`,
    );
  }
  if (next.timestamps.createdAt !== previous.timestamps.createdAt) {
    throw new TypeError('Habit-learning createdAt is immutable');
  }
  if (Date.parse(next.timestamps.updatedAt) < Date.parse(previous.timestamps.updatedAt)) {
    throw new TypeError('Habit-learning updatedAt cannot move backwards');
  }
  assertRuleIdentityStable(previous, next);
  assertRecordedTimestampsStable(previous, next);
  assertFinishStageDoesNotRegress(previous, next);
  return next;
}

export function assertNoGatewayLoginCode(value: unknown): void {
  const seen = new Set<object>();

  const visit = (candidate: unknown, path: string): void => {
    if (typeof candidate === 'string') {
      if (LOGIN_CODE_TEXT_PATTERNS.some((pattern) => pattern.test(candidate))) {
        throw new TypeError(`Refusing gateway login code in private artifact at ${path}`);
      }
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      const normalizedKey = key.replaceAll(/[-_\s]/g, '');
      if (LOGIN_CODE_KEY_PATTERN.test(normalizedKey)) {
        throw new TypeError(
          `Refusing gateway login-code field in private artifact at ${path}.${key}`,
        );
      }
      visit(entry, `${path}.${key}`);
    }
  };

  visit(value, '$');
}

function assertRuleIdentityStable(
  previous: HabitLearningStudySession,
  next: HabitLearningStudySession,
): void {
  if (previous.rule === undefined) return;
  if (next.rule === undefined) {
    throw new TypeError('Habit-learning rule reference cannot be removed');
  }
  if (next.rule.ruleId !== previous.rule.ruleId) {
    throw new TypeError('Habit-learning ruleId is immutable');
  }
  if (next.rule.semanticDigest !== previous.rule.semanticDigest) {
    throw new TypeError('Habit-learning semanticDigest is immutable');
  }
  if (next.rule.layoutDigest !== previous.rule.layoutDigest) {
    throw new TypeError('Habit-learning layoutDigest is immutable');
  }
}

function assertRecordedTimestampsStable(
  previous: HabitLearningStudySession,
  next: HabitLearningStudySession,
): void {
  for (const [field, previousValue] of Object.entries(previous.timestamps)) {
    if (field === 'updatedAt' || previousValue === undefined) continue;
    const nextValue = next.timestamps[field as keyof typeof next.timestamps];
    if (field === 'lastHealthyCaptureAt') {
      if (nextValue === undefined || Date.parse(nextValue) < Date.parse(previousValue)) {
        throw new TypeError('Habit-learning timestamp lastHealthyCaptureAt cannot regress');
      }
      continue;
    }
    if (nextValue !== previousValue) {
      throw new TypeError(`Habit-learning timestamp ${field} is immutable once recorded`);
    }
  }
}

function assertFinishStageDoesNotRegress(
  previous: HabitLearningStudySession,
  next: HabitLearningStudySession,
): void {
  if (previous.finish === undefined || next.finish === undefined) return;
  const previousIndex = HABIT_LEARNING_FINISH_STAGES.indexOf(previous.finish.stage);
  const nextIndex = HABIT_LEARNING_FINISH_STAGES.indexOf(next.finish.stage);
  if (nextIndex < previousIndex) {
    throw new TypeError(
      `Habit-learning finish stage cannot regress: ${previous.finish.stage} -> ${next.finish.stage}`,
    );
  }
}

async function writePrivateJson(path: string, value: unknown, label: string): Promise<void> {
  assertNoGatewayLoginCode(value);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  await writePrivateText(path, `${serialized}\n`, label);
}

async function writePrivateText(path: string, value: string, label: string): Promise<void> {
  assertNoGatewayLoginCode(value);
  await assertRegularFileOrMissing(path, label);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    handle = await fs.open(temporaryPath, privateOpenFlags('exclusive-write'), 0o600);
    await handle.writeFile(value, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertRegularFileOrMissing(path, label);
    await fs.rename(temporaryPath, path);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await unlinkIfPresent(temporaryPath);
  }
}

async function readPrivateJsonIfPresent(path: string, label: string): Promise<unknown | undefined> {
  const raw = await readPrivateTextIfPresent(path, label);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${path}`, { cause: error });
  }
}

async function readPrivateTextIfPresent(path: string, label: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await assertRegularFileOrMissing(path, label);
    try {
      handle = await fs.open(path, privateOpenFlags('read'));
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (hasErrorCode(error, 'ELOOP')) {
        throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
      }
      throw error;
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    await handle.chmod(0o600);
    return await handle.readFile('utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function appendPrivateNdjson(
  path: string,
  records: readonly Readonly<Record<string, unknown>>[],
  label: string,
): Promise<{ records: number; bytes: number }> {
  if (records.length === 0) return { records: 0, bytes: 0 };
  const serialized = records
    .map((record, index) => {
      assertNoGatewayLoginCode(record);
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        throw new TypeError(`${label} record ${index} must be a JSON object`);
      }
      let line: string | undefined;
      try {
        line = JSON.stringify(record);
      } catch (error) {
        throw new TypeError(`${label} record ${index} must be JSON-serializable`, {
          cause: error,
        });
      }
      if (line === undefined) {
        throw new TypeError(`${label} record ${index} must be JSON-serializable`);
      }
      return `${line}\n`;
    })
    .join('');

  await assertRegularFileOrMissing(path, label);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, privateOpenFlags('append'), 0o600);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    await handle.chmod(0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } catch (error) {
    if (hasErrorCode(error, 'ELOOP')) {
      throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
  await syncDirectory(dirname(path));
  return { records: records.length, bytes: Buffer.byteLength(serialized) };
}

async function readPrivateNdjson<T>(path: string, label: string): Promise<T[]> {
  const raw = await readPrivateTextIfPresent(path, label);
  if (raw === undefined || raw.length === 0) return [];
  if (!raw.endsWith('\n')) {
    throw new Error(`Invalid partial ${label} record at end of ${path}`);
  }
  const lines = raw.slice(0, -1).split('\n');
  return lines.map((line, index) => {
    if (line.length === 0) throw new Error(`Invalid empty ${label} record at line ${index + 1}`);
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`Invalid ${label} JSON at line ${index + 1}`, { cause: error });
    }
  });
}

async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  try {
    const existing = await fs.lstat(path);
    if (existing.isSymbolicLink()) throw new Error(`Refusing symbolic-link ${label}: ${path}`);
    if (!existing.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      await fs.mkdir(path, { mode: 0o700 });
    } catch (createError) {
      if (!hasErrorCode(createError, 'EEXIST')) throw createError;
    }
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, privateOpenFlags('directory-read'));
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
    await handle.chmod(0o700);
  } catch (error) {
    if (hasErrorCode(error, 'ELOOP')) {
      throw new Error(`Refusing symbolic-link ${label}: ${path}`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
  await syncDirectory(dirname(path));
}

async function assertRegularFileOrMissing(path: string, label: string): Promise<void> {
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link ${label}: ${path}`);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function privateOpenFlags(kind: 'append' | 'directory-read' | 'exclusive-write' | 'read'): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  if (kind === 'append') {
    return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollow;
  }
  if (kind === 'exclusive-write') {
    return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  }
  if (kind === 'directory-read') {
    return fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollow;
  }
  return fsConstants.O_RDONLY | noFollow;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, privateOpenFlags('directory-read'));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}
