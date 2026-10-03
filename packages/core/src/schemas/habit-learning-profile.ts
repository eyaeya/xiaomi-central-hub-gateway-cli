import { z } from 'zod';

export const HABIT_LEARNING_CORRECTION_VERSION = 1 as const;
export const HABIT_LEARNING_PROFILE_VERSION = 1 as const;

export const HABIT_LEARNING_ANONYMOUS_DEVICE_KEY_PATTERN = /^device_[a-f0-9]{32}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type HabitLearningJsonValue =
  | string
  | number
  | boolean
  | null
  | HabitLearningJsonValue[]
  | { [key: string]: HabitLearningJsonValue };

export const HabitLearningJsonValueSchema: z.ZodType<HabitLearningJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(HabitLearningJsonValueSchema),
    z.record(HabitLearningJsonValueSchema),
  ]),
);

export const HabitLearningAnonymousDeviceKeySchema = z
  .string()
  .regex(HABIT_LEARNING_ANONYMOUS_DEVICE_KEY_PATTERN);
export type HabitLearningAnonymousDeviceKey = z.infer<typeof HabitLearningAnonymousDeviceKeySchema>;

export const HabitLearningCorrectionSubjectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('region-label'),
      deviceKey: HabitLearningAnonymousDeviceKeySchema,
      label: z.string().trim().min(1).max(128),
      mapBank: z.string().trim().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('household-fact'),
      field: z.enum(['resident-count', 'pet-presence', 'schedule', 'accessibility-need']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('automation-constraint'),
      constraintKey: z.string().trim().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('profile-field'),
      field: z.string().trim().min(1).max(128),
    })
    .strict(),
]);
export type HabitLearningCorrectionSubject = z.infer<typeof HabitLearningCorrectionSubjectSchema>;

export const HabitLearningCorrectionSchema = z
  .object({
    correctionVersion: z.literal(HABIT_LEARNING_CORRECTION_VERSION),
    correctionId: z.string().regex(SHA256_HEX_PATTERN),
    recordedAt: z.number().int().nonnegative(),
    /** Time from which this correction is semantically effective. */
    asOf: z.number().int().nonnegative(),
    subject: HabitLearningCorrectionSubjectSchema,
    value: HabitLearningJsonValueSchema,
    source: z.enum(['user-mi-home-app', 'user-direct', 'user-import']),
    supersedes: z.string().regex(SHA256_HEX_PATTERN).optional(),
  })
  .strict();
export type HabitLearningCorrection = z.infer<typeof HabitLearningCorrectionSchema>;

export const HabitLearningResolvedConfirmationSchema = z
  .object({
    correctionId: z.string().regex(SHA256_HEX_PATTERN),
    recordedAt: z.number().int().nonnegative(),
    asOf: z.number().int().nonnegative(),
    subject: HabitLearningCorrectionSubjectSchema,
    value: HabitLearningJsonValueSchema,
    source: HabitLearningCorrectionSchema.shape.source,
  })
  .strict();
export type HabitLearningResolvedConfirmation = z.infer<
  typeof HabitLearningResolvedConfirmationSchema
>;

export const HabitLearningProfileObservationSchema = z
  .object({
    observationId: z.string().regex(SHA256_HEX_PATTERN),
    kind: z.enum(['event-count', 'state-interval', 'episode', 'sequence', 'value-summary']),
    deviceKey: HabitLearningAnonymousDeviceKeySchema.optional(),
    signalKey: z.string().trim().min(1).max(256),
    observedFrom: z.number().int().nonnegative(),
    observedUntil: z.number().int().nonnegative(),
    value: HabitLearningJsonValueSchema.optional(),
    count: z
      .object({
        min: z.number().int().nonnegative(),
        max: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1),
    gapIds: z.array(z.string().trim().min(1)).default([]),
    certainty: z.enum(['direct', 'bounded', 'ambiguous']),
  })
  .strict()
  .superRefine((observation, ctx) => {
    if (observation.observedUntil < observation.observedFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedUntil'],
        message: 'observedUntil must be greater than or equal to observedFrom',
      });
    }
    if (observation.count !== undefined && observation.count.max < observation.count.min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['count', 'max'],
        message: 'count.max must be greater than or equal to count.min',
      });
    }
  });
export type HabitLearningProfileObservation = z.output<
  typeof HabitLearningProfileObservationSchema
>;
export type HabitLearningProfileObservationInput = z.input<
  typeof HabitLearningProfileObservationSchema
>;

/**
 * Hypotheses deliberately have no household-size or person-identity subject.
 * Those facts may enter `userConfirmed` only through an explicit correction.
 */
export const HabitLearningProfileHypothesisSchema = z
  .object({
    hypothesisId: z.string().regex(SHA256_HEX_PATTERN),
    subject: z.enum([
      'routine-window',
      'region-topology',
      'device-use-pattern',
      'environment-association',
    ]),
    statement: z.string().trim().min(1).max(2_000),
    confidence: z.number().min(0).max(1),
    evidenceObservationIds: z.array(z.string().regex(SHA256_HEX_PATTERN)).min(1),
    confirmationCorrectionIds: z.array(z.string().regex(SHA256_HEX_PATTERN)).default([]),
    alternativeExplanations: z.array(z.string().trim().min(1).max(1_000)).min(1),
    questions: z.array(z.string().trim().min(1).max(1_000)).default([]),
    status: z.literal('candidate-needs-user-confirmation'),
    interpretationBoundary: z.literal('does-not-identify-person-or-household-size'),
  })
  .strict();
export type HabitLearningProfileHypothesis = z.output<typeof HabitLearningProfileHypothesisSchema>;
export type HabitLearningProfileHypothesisInput = z.input<
  typeof HabitLearningProfileHypothesisSchema
>;

export const HabitLearningAutomationConstraintSchema = z
  .object({
    constraintId: z.string().regex(SHA256_HEX_PATTERN),
    kind: z.enum([
      'exclude-device',
      'exclude-room',
      'exclude-time-window',
      'prohibit-action',
      'privacy-boundary',
      'require-user-confirmation',
    ]),
    description: z.string().trim().min(1).max(2_000),
    deviceKey: HabitLearningAnonymousDeviceKeySchema.optional(),
    source: z.enum(['user-confirmed', 'safety-default']),
    correctionIds: z.array(z.string().regex(SHA256_HEX_PATTERN)).default([]),
  })
  .strict()
  .superRefine((constraint, ctx) => {
    if (constraint.source === 'user-confirmed' && constraint.correctionIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctionIds'],
        message: 'user-confirmed constraints must cite at least one correction',
      });
    }
  });
export type HabitLearningAutomationConstraint = z.output<
  typeof HabitLearningAutomationConstraintSchema
>;
export type HabitLearningAutomationConstraintInput = z.input<
  typeof HabitLearningAutomationConstraintSchema
>;

export const HabitLearningProfileCompletenessSchema = z
  .object({
    status: z.enum(['sufficient', 'bounded', 'insufficient']),
    usableForHabitInference: z.enum(['yes-with-bounds', 'no']),
    provesAllHouseholdBehavior: z.literal(false),
    collectorContinuity: z.enum(['continuous', 'gapped', 'unknown']),
    plannedSignalCount: z.number().int().nonnegative(),
    includedSignalCount: z.number().int().nonnegative(),
    observedSignalCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    observedCoverageRatio: z.number().min(0).max(1).nullable(),
    reasonCodes: z.array(z.string().trim().min(1)),
    householdSizeInference: z.literal('prohibited'),
    personIdentityInference: z.literal('prohibited'),
  })
  .strict()
  .superRefine((completeness, ctx) => {
    if (completeness.includedSignalCount > completeness.plannedSignalCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['includedSignalCount'],
        message: 'includedSignalCount cannot exceed plannedSignalCount',
      });
    }
    if (completeness.observedSignalCount > completeness.includedSignalCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedSignalCount'],
        message: 'observedSignalCount cannot exceed includedSignalCount',
      });
    }
    if (completeness.collectorContinuity === 'gapped' && completeness.gapCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gapCount'],
        message: 'gapped collector continuity requires at least one gap',
      });
    }
    if (completeness.status === 'insufficient' && completeness.usableForHabitInference !== 'no') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usableForHabitInference'],
        message: 'insufficient evidence is not usable for habit inference',
      });
    }
  });
export type HabitLearningProfileCompleteness = z.infer<
  typeof HabitLearningProfileCompletenessSchema
>;

export const HabitLearningProfileSchema = z
  .object({
    profileVersion: z.literal(HABIT_LEARNING_PROFILE_VERSION),
    profileId: z.string().regex(SHA256_HEX_PATTERN),
    /** Semantic graph/source-map identity used to produce this profile. */
    sourceSemanticDigest: z.string().regex(SHA256_HEX_PATTERN),
    /** Private inventory identity captured when the study was planned. */
    sourceInventoryHash: z.string().regex(SHA256_HEX_PATTERN),
    /** Frozen plan includes MIoT value semantics; absent on legacy profiles. */
    sourcePlanId: z.string().regex(SHA256_HEX_PATTERN).optional(),
    generatedAt: z.number().int().nonnegative(),
    observedFrom: z.number().int().nonnegative(),
    observedUntil: z.number().int().nonnegative(),
    timezone: z.string().trim().min(1).max(128),
    expiresAt: z.number().int().nonnegative(),
    invalidatedAt: z.number().int().nonnegative().optional(),
    invalidationReason: z.string().trim().min(1).max(1_000).optional(),
    observations: z.array(HabitLearningProfileObservationSchema),
    hypotheses: z.array(HabitLearningProfileHypothesisSchema),
    userConfirmed: z.array(HabitLearningResolvedConfirmationSchema),
    automationConstraints: z.array(HabitLearningAutomationConstraintSchema),
    completeness: HabitLearningProfileCompletenessSchema,
    privacy: z
      .object({
        anonymizedDeviceKeys: z.literal(true),
        containsRawDeviceIdentifiers: z.literal(false),
        householdSizeInference: z.literal('prohibited'),
        personIdentityInference: z.literal('prohibited'),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.observedUntil < profile.observedFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedUntil'],
        message: 'observedUntil must be greater than or equal to observedFrom',
      });
    }
    if (profile.generatedAt < profile.observedUntil) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['generatedAt'],
        message: 'generatedAt must be greater than or equal to observedUntil',
      });
    }
    if (profile.expiresAt <= profile.generatedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresAt must be greater than generatedAt',
      });
    }
    profile.observations.forEach((observation, index) => {
      if (
        observation.observedFrom < profile.observedFrom ||
        observation.observedUntil > profile.observedUntil
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observations', index],
          message: 'observation must be contained by the profile observation window',
        });
      }
    });
    if (profile.invalidatedAt !== undefined && profile.invalidationReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invalidationReason'],
        message: 'invalidationReason is required when invalidatedAt is set',
      });
    }
    if (profile.invalidatedAt === undefined && profile.invalidationReason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invalidatedAt'],
        message: 'invalidatedAt is required when invalidationReason is set',
      });
    }
    if (profile.invalidatedAt !== undefined && profile.invalidatedAt < profile.generatedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invalidatedAt'],
        message: 'invalidatedAt cannot be earlier than generatedAt',
      });
    }
  });
export type HabitLearningProfile = z.output<typeof HabitLearningProfileSchema>;
export type HabitLearningProfileInput = z.input<typeof HabitLearningProfileSchema>;

export const HabitLearningProfileFreshnessSchema = z
  .object({
    evaluatedAt: z.number().int().nonnegative(),
    status: z.enum(['current', 'stale', 'expired', 'invalidated', 'insufficient']),
    reusableForRuleAuthoring: z.boolean(),
    minimumCompleteness: z.enum(['sufficient', 'bounded']),
    reasons: z.array(
      z.enum([
        'current',
        'profile-expired',
        'profile-invalidated',
        'insufficient-completeness',
        'live-drift-check-required',
        'semantic-digest-mismatch',
        'inventory-drift',
        'source-plan-unavailable',
        'plan-drift',
      ]),
    ),
  })
  .strict();
export type HabitLearningProfileFreshness = z.infer<typeof HabitLearningProfileFreshnessSchema>;
