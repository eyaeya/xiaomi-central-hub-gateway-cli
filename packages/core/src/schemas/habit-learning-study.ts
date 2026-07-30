import { z } from 'zod';

export const HABIT_LEARNING_STUDY_SESSION_VERSION = 1 as const;

export const HABIT_LEARNING_STUDY_PHASES = [
  'preparing',
  'ready-disabled',
  'observing',
  'observing-degraded',
  'finishing',
  'awaiting-clarification',
  'complete',
] as const;

export const HabitLearningStudyPhaseSchema = z.enum(HABIT_LEARNING_STUDY_PHASES);
export type HabitLearningStudyPhase = z.infer<typeof HabitLearningStudyPhaseSchema>;

export const HABIT_LEARNING_FINISH_STAGES = [
  'final-capture-pending',
  'disable-pending',
  'disable-readback-pending',
  'clarification-pending',
  'awaiting-clarification',
  'profile-pending',
  'complete',
] as const;

export const HabitLearningFinishStageSchema = z.enum(HABIT_LEARNING_FINISH_STAGES);
export type HabitLearningFinishStage = z.infer<typeof HabitLearningFinishStageSchema>;

const IsoTimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const HabitLearningStudyRuleReferenceSchema = z
  .object({
    ruleId: z.string().trim().min(1),
    expectedEnabled: z.boolean(),
    semanticDigest: Sha256Schema,
    layoutDigest: Sha256Schema,
    lastReadbackAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type HabitLearningStudyRuleReference = z.infer<typeof HabitLearningStudyRuleReferenceSchema>;

export const HabitLearningPendingClarificationSchema = z
  .object({
    questionId: Sha256Schema,
    subject: z.string().trim().min(1).max(512),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type HabitLearningPendingClarification = z.infer<
  typeof HabitLearningPendingClarificationSchema
>;

export const HabitLearningStudyTimestampsSchema = z
  .object({
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    readyDisabledAt: IsoTimestampSchema.optional(),
    observationStartedAt: IsoTimestampSchema.optional(),
    lastHealthyCaptureAt: IsoTimestampSchema.optional(),
    degradedAt: IsoTimestampSchema.optional(),
    finishingStartedAt: IsoTimestampSchema.optional(),
    finalCaptureCommittedAt: IsoTimestampSchema.optional(),
    disableRequestedAt: IsoTimestampSchema.optional(),
    disableReadbackAt: IsoTimestampSchema.optional(),
    clarificationPreparedAt: IsoTimestampSchema.optional(),
    profileWrittenAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type HabitLearningStudyTimestamps = z.infer<typeof HabitLearningStudyTimestampsSchema>;

export const HabitLearningFinishCheckpointSchema = z
  .object({
    stage: HabitLearningFinishStageSchema,
    attempts: z.number().int().nonnegative(),
    pendingClarifications: z.array(HabitLearningPendingClarificationSchema),
    lastErrorCode: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type HabitLearningFinishCheckpoint = z.infer<typeof HabitLearningFinishCheckpointSchema>;

/**
 * Durable lifecycle checkpoint for one private household study.
 *
 * Gateway authentication material is intentionally absent. The rule identity,
 * expected enable state, graph digests, timestamps, finish stage, and pending
 * clarification IDs are sufficient to resume and reconcile an interrupted
 * finish against live gateway readback.
 */
const HabitLearningStudySessionBaseSchema = z
  .object({
    sessionVersion: z.literal(HABIT_LEARNING_STUDY_SESSION_VERSION),
    studyId: z.string().uuid(),
    phase: HabitLearningStudyPhaseSchema,
    revision: z.number().int().nonnegative(),
    rule: HabitLearningStudyRuleReferenceSchema.optional(),
    timestamps: HabitLearningStudyTimestampsSchema,
    degradedReasonCodes: z.array(z.string().trim().min(1).max(256)).default([]),
    finish: HabitLearningFinishCheckpointSchema.optional(),
  })
  .strict();

type HabitLearningStudySessionCandidate = z.output<typeof HabitLearningStudySessionBaseSchema>;

export const HabitLearningStudySessionSchema = HabitLearningStudySessionBaseSchema.superRefine(
  (session, context) => {
    const createdAt = Date.parse(session.timestamps.createdAt);
    const updatedAt = Date.parse(session.timestamps.updatedAt);
    if (updatedAt < createdAt) {
      addIssue(context, ['timestamps', 'updatedAt'], 'updatedAt cannot precede createdAt');
    }
    if (
      session.rule?.lastReadbackAt !== undefined &&
      (Date.parse(session.rule.lastReadbackAt) < createdAt ||
        Date.parse(session.rule.lastReadbackAt) > updatedAt)
    ) {
      addIssue(
        context,
        ['rule', 'lastReadbackAt'],
        'lastReadbackAt must be between createdAt and updatedAt',
      );
    }

    for (const [field, value] of Object.entries(session.timestamps)) {
      if (field === 'createdAt' || field === 'updatedAt' || value === undefined) continue;
      const timestamp = Date.parse(value);
      if (timestamp < createdAt || timestamp > updatedAt) {
        addIssue(
          context,
          ['timestamps', field],
          `${field} must be between createdAt and updatedAt`,
        );
      }
    }

    if (session.phase !== 'preparing' && session.rule === undefined) {
      addIssue(context, ['rule'], `rule is required in phase ${session.phase}`);
    }

    requirePhaseTimestamp(session.phase, session.timestamps, context);
    validateExpectedEnableState(session, context);
    validateFinishCheckpoint(session, context);

    if (session.phase === 'observing-degraded' && session.degradedReasonCodes.length === 0) {
      addIssue(
        context,
        ['degradedReasonCodes'],
        'observing-degraded requires at least one degraded reason code',
      );
    }

    const questionIds = new Set<string>();
    session.finish?.pendingClarifications.forEach((question, index) => {
      if (questionIds.has(question.questionId)) {
        addIssue(
          context,
          ['finish', 'pendingClarifications', index, 'questionId'],
          `duplicate pending clarification questionId: ${question.questionId}`,
        );
      }
      questionIds.add(question.questionId);
    });
  },
);

export type HabitLearningStudySession = z.output<typeof HabitLearningStudySessionSchema>;
export type HabitLearningStudySessionInput = z.input<typeof HabitLearningStudySessionSchema>;

function requirePhaseTimestamp(
  phase: HabitLearningStudyPhase,
  timestamps: HabitLearningStudyTimestamps,
  context: z.RefinementCtx,
): void {
  const requiredByPhase: Partial<
    Record<HabitLearningStudyPhase, keyof HabitLearningStudyTimestamps>
  > = {
    'ready-disabled': 'readyDisabledAt',
    observing: 'observationStartedAt',
    'observing-degraded': 'degradedAt',
    finishing: 'finishingStartedAt',
    'awaiting-clarification': 'clarificationPreparedAt',
    complete: 'completedAt',
  };
  const required = requiredByPhase[phase];
  if (required !== undefined && timestamps[required] === undefined) {
    addIssue(context, ['timestamps', required], `${required} is required in phase ${phase}`);
  }
}

function validateExpectedEnableState(
  session: HabitLearningStudySessionCandidate,
  context: z.RefinementCtx,
): void {
  const expected = session.rule?.expectedEnabled;
  if (expected === undefined) return;

  if (
    (session.phase === 'ready-disabled' ||
      session.phase === 'awaiting-clarification' ||
      session.phase === 'complete') &&
    expected
  ) {
    addIssue(
      context,
      ['rule', 'expectedEnabled'],
      `${session.phase} requires the study rule to be disabled`,
    );
  }
  if ((session.phase === 'observing' || session.phase === 'observing-degraded') && !expected) {
    addIssue(
      context,
      ['rule', 'expectedEnabled'],
      `${session.phase} requires the study rule to be enabled`,
    );
  }
  if (session.timestamps.disableReadbackAt !== undefined && expected) {
    addIssue(
      context,
      ['rule', 'expectedEnabled'],
      'expectedEnabled must be false after a successful disable readback',
    );
  }
}

function validateFinishCheckpoint(
  session: HabitLearningStudySessionCandidate,
  context: z.RefinementCtx,
): void {
  const finishPhases = new Set<HabitLearningStudyPhase>([
    'finishing',
    'awaiting-clarification',
    'complete',
  ]);
  if (finishPhases.has(session.phase) && session.finish === undefined) {
    addIssue(context, ['finish'], `finish checkpoint is required in phase ${session.phase}`);
    return;
  }
  if (!finishPhases.has(session.phase) && session.finish !== undefined) {
    addIssue(context, ['finish'], `finish checkpoint is not valid in phase ${session.phase}`);
    return;
  }
  if (session.finish === undefined) return;

  if (
    session.phase === 'finishing' &&
    (session.finish.stage === 'awaiting-clarification' ||
      session.finish.stage === 'profile-pending' ||
      session.finish.stage === 'complete')
  ) {
    addIssue(
      context,
      ['finish', 'stage'],
      `finish stage ${session.finish.stage} does not match phase finishing`,
    );
  }
  if (
    session.phase === 'awaiting-clarification' &&
    session.finish.stage !== 'awaiting-clarification' &&
    session.finish.stage !== 'profile-pending'
  ) {
    addIssue(
      context,
      ['finish', 'stage'],
      `finish stage ${session.finish.stage} does not match phase awaiting-clarification`,
    );
  }
  if (session.phase === 'complete' && session.finish.stage !== 'complete') {
    addIssue(context, ['finish', 'stage'], 'complete phase requires finish stage complete');
  }
  if (
    session.finish.stage === 'profile-pending' &&
    session.finish.pendingClarifications.length > 0
  ) {
    addIssue(
      context,
      ['finish', 'pendingClarifications'],
      'profile-pending requires all clarifications to be resolved',
    );
  }
  if (session.finish.stage === 'complete') {
    if (session.finish.pendingClarifications.length > 0) {
      addIssue(
        context,
        ['finish', 'pendingClarifications'],
        'complete finish cannot retain pending clarifications',
      );
    }
    if (session.timestamps.profileWrittenAt === undefined) {
      addIssue(
        context,
        ['timestamps', 'profileWrittenAt'],
        'complete finish requires profileWrittenAt',
      );
    }
  }

  const stageIndex = HABIT_LEARNING_FINISH_STAGES.indexOf(session.finish.stage);
  const disablePendingIndex = HABIT_LEARNING_FINISH_STAGES.indexOf('disable-pending');
  const disableReadbackPendingIndex = HABIT_LEARNING_FINISH_STAGES.indexOf(
    'disable-readback-pending',
  );
  const clarificationPendingIndex = HABIT_LEARNING_FINISH_STAGES.indexOf('clarification-pending');
  const boundedCaptureTermination =
    session.finish.lastErrorCode === 'RULE_UNEXPECTEDLY_DISABLED' ||
    session.finish.lastErrorCode === 'SEMANTIC_GRAPH_DRIFT';
  if (
    stageIndex >= disablePendingIndex &&
    session.timestamps.finalCaptureCommittedAt === undefined &&
    !boundedCaptureTermination
  ) {
    addIssue(
      context,
      ['timestamps', 'finalCaptureCommittedAt'],
      `finish stage ${session.finish.stage} requires finalCaptureCommittedAt`,
    );
  }
  if (
    stageIndex >= disableReadbackPendingIndex &&
    session.timestamps.disableRequestedAt === undefined &&
    session.finish.lastErrorCode !== 'RULE_UNEXPECTEDLY_DISABLED'
  ) {
    addIssue(
      context,
      ['timestamps', 'disableRequestedAt'],
      `finish stage ${session.finish.stage} requires disableRequestedAt`,
    );
  }
  if (
    stageIndex >= clarificationPendingIndex &&
    session.timestamps.disableReadbackAt === undefined
  ) {
    addIssue(
      context,
      ['timestamps', 'disableReadbackAt'],
      `finish stage ${session.finish.stage} requires disableReadbackAt`,
    );
  }
}

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message,
  });
}
