import { z } from 'zod';
import { DeviceSpecSchema } from './device-spec.js';
import { Device } from './device.js';

export const HABIT_LEARNING_PLAN_VERSION = 1 as const;
const HABIT_LEARNING_PARTITION_LABEL = /^(?:[AB]-(?:[1-9]|1[0-6])|Zone-[1-6])$/;

export const HABIT_LEARNING_REASON_CODES = [
  'device-offline',
  'device-ghost',
  'device-no-spec-access',
  'device-push-unavailable',
  'user-excluded',
  'spec-fetch-failed',
  'semantic-catalog-fallback',
  'property-not-notify',
  'sample-only-not-behavior',
  'configuration-or-diagnostic',
  'duration-default-excluded',
  'high-frequency-default-excluded',
  'default-policy-excluded',
  'sensitive-default-excluded',
  'event-argument-unresolved',
  'capture-dtype-unsupported',
  'context-default-deferred',
  'included-p0-behavior',
  'included-p1-context',
] as const;

export const HabitLearningReasonCodeSchema = z.enum(HABIT_LEARNING_REASON_CODES);
export type HabitLearningReasonCode = z.infer<typeof HabitLearningReasonCodeSchema>;

export const HabitLearningSignalTierSchema = z.enum(['p0-behavior', 'p1-context', 'excluded']);
export type HabitLearningSignalTier = z.infer<typeof HabitLearningSignalTierSchema>;

export const HabitLearningSensitivitySchema = z.enum(['normal', 'sensitive', 'restricted']);
export type HabitLearningSensitivity = z.infer<typeof HabitLearningSensitivitySchema>;

export const HabitLearningCaptureDtypeSchema = z.enum(['number', 'string']);
export type HabitLearningCaptureDtype = z.infer<typeof HabitLearningCaptureDtypeSchema>;

export const HabitLearningSourceDtypeSchema = z.enum(['boolean', 'float', 'int', 'string']);
export type HabitLearningSourceDtype = z.infer<typeof HabitLearningSourceDtypeSchema>;

export const HabitLearningObservabilitySchema = z.enum([
  'push-notify',
  'event',
  'sample-only',
  'unobservable',
]);
export type HabitLearningObservability = z.infer<typeof HabitLearningObservabilitySchema>;

export const HabitLearningVisibleDeviceSchema = Device.extend({
  did: z.string().min(1),
});
export type HabitLearningVisibleDevice = z.infer<typeof HabitLearningVisibleDeviceSchema>;

export const HabitLearningDeviceInputSchema = z
  .object({
    device: HabitLearningVisibleDeviceSchema,
    spec: DeviceSpecSchema.optional(),
    specError: z.string().min(1).optional(),
    semanticCatalogFallback: z.boolean().default(false),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.spec !== undefined && entry.specError !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['specError'],
        message: 'spec and specError are mutually exclusive',
      });
    }
  });
export type HabitLearningDeviceInput = z.input<typeof HabitLearningDeviceInputSchema>;
export type ParsedHabitLearningDeviceInput = z.output<typeof HabitLearningDeviceInputSchema>;

export const HabitLearningPlanInputSchema = z
  .object({
    devices: z.array(HabitLearningDeviceInputSchema),
    // General P1 context is opt-in. Occupancy-sensor illumination is a
    // documented exception and remains included by the planner by default.
    includeContext: z.boolean().default(false),
    includeSensitive: z.boolean().default(false),
    excludedDeviceIds: z
      .array(z.string().min(1))
      .default([])
      .transform((values) => [...new Set(values)].sort()),
    excludedRoomIds: z
      .array(z.string().min(1))
      .default([])
      .transform((values) => [...new Set(values)].sort()),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.devices.forEach((entry, index) => {
      if (seen.has(entry.device.did)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['devices', index, 'device', 'did'],
          message: `duplicate visible device DID: ${entry.device.did}`,
        });
      }
      seen.add(entry.device.did);
    });
  });
export type HabitLearningPlanInput = z.input<typeof HabitLearningPlanInputSchema>;
export type ParsedHabitLearningPlanInput = z.output<typeof HabitLearningPlanInputSchema>;

export const HabitLearningDeviceReferenceSchema = z
  .object({
    did: z.string().min(1),
    name: z.string(),
    model: z.string(),
    urn: z.string(),
    roomId: z.string(),
    roomName: z.string(),
  })
  .strict();
export type HabitLearningDeviceReference = z.infer<typeof HabitLearningDeviceReferenceSchema>;

export const HabitLearningPropertyArgumentSchema = z
  .object({
    piid: z.number().int().positive(),
    urn: z.string(),
    description: z.string(),
    format: z.string(),
    unit: z.string().optional(),
    valueRange: z
      .object({
        min: z.number(),
        max: z.number(),
        step: z.number(),
      })
      .strict()
      .optional(),
    valueList: z
      .array(
        z
          .object({
            value: z.number(),
            description: z.string(),
          })
          .strict(),
      )
      .optional(),
    sourceDtype: HabitLearningSourceDtypeSchema,
    captureDtype: HabitLearningCaptureDtypeSchema,
  })
  .strict();
export type HabitLearningPropertyArgument = z.infer<typeof HabitLearningPropertyArgumentSchema>;

export const HabitLearningPropertySelectorSchema = z
  .object({
    kind: z.literal('property'),
    siid: z.number().int().positive(),
    piid: z.number().int().positive(),
    access: z.array(z.enum(['read', 'write', 'notify'])),
    sourceDtype: HabitLearningSourceDtypeSchema,
    captureDtype: HabitLearningCaptureDtypeSchema,
  })
  .strict();

export const HabitLearningEventSelectorSchema = z
  .object({
    kind: z.literal('event'),
    siid: z.number().int().positive(),
    eiid: z.number().int().positive(),
    argumentPiids: z.array(z.number().int().positive()),
    arguments: z.array(HabitLearningPropertyArgumentSchema),
  })
  .strict();

export const HabitLearningSignalSelectorSchema = z.discriminatedUnion('kind', [
  HabitLearningPropertySelectorSchema,
  HabitLearningEventSelectorSchema,
]);
export type HabitLearningSignalSelector = z.infer<typeof HabitLearningSignalSelectorSchema>;

export const HabitLearningSignalSemanticsSchema = z
  .object({
    serviceUrn: z.string(),
    capabilityUrn: z.string(),
    serviceDescription: z.string(),
    capabilityDescription: z.string(),
    unit: z.string().optional(),
    valueRange: z
      .object({
        min: z.number(),
        max: z.number(),
        step: z.number(),
      })
      .strict()
      .optional(),
    valueList: z
      .array(
        z
          .object({
            value: z.number(),
            description: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type HabitLearningSignalSemantics = z.infer<typeof HabitLearningSignalSemanticsSchema>;

export const HabitLearningPartitionReferenceSchema = z
  .object({
    label: z.string().regex(HABIT_LEARNING_PARTITION_LABEL),
    semanticStatus: z.literal('opaque-user-confirmation-required'),
  })
  .strict();
export type HabitLearningPartitionReference = z.infer<typeof HabitLearningPartitionReferenceSchema>;

export const HabitLearningSignalSchema = z
  .object({
    signalId: z.string().regex(/^[a-f0-9]{64}$/),
    device: HabitLearningDeviceReferenceSchema,
    selector: HabitLearningSignalSelectorSchema,
    semantics: HabitLearningSignalSemanticsSchema,
    partition: HabitLearningPartitionReferenceSchema.optional(),
    observability: HabitLearningObservabilitySchema,
    tier: HabitLearningSignalTierSchema,
    sensitivity: HabitLearningSensitivitySchema,
    included: z.boolean(),
    reasonCodes: z.array(HabitLearningReasonCodeSchema),
    runtimeVerified: z.literal(false),
    estimatedNodes: z.number().int().nonnegative(),
    estimatedVariables: z.number().int().nonnegative(),
    estimatedLogLinesPerOccurrence: z
      .object({
        min: z.number().int().nonnegative(),
        max: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type HabitLearningSignal = z.infer<typeof HabitLearningSignalSchema>;

export const HabitLearningGraphSchema = z
  .object({
    graphId: z.string().regex(/^[a-f0-9]{64}$/),
    label: z.string(),
    signalIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    sourceCount: z.number().int().nonnegative(),
    automaticPartitioning: z.literal(false),
    unverifiedRuntimeCapacity: z.literal(true),
  })
  .strict();
export type HabitLearningGraph = z.infer<typeof HabitLearningGraphSchema>;

export const HabitLearningDeviceCoverageSchema = z
  .object({
    did: z.string().min(1),
    name: z.string(),
    roomId: z.string(),
    roomName: z.string(),
    status: z.enum(['planned', 'partially-planned', 'excluded']),
    reasonCodes: z.array(HabitLearningReasonCodeSchema),
    observableSignalCount: z.number().int().nonnegative(),
    plannedSignalCount: z.number().int().nonnegative(),
    sampleOnlyPropertyCount: z.number().int().nonnegative(),
  })
  .strict();
export type HabitLearningDeviceCoverage = z.infer<typeof HabitLearningDeviceCoverageSchema>;

export const HabitLearningPartitionClarificationSchema = z
  .object({
    did: z.string().min(1),
    deviceName: z.string(),
    roomName: z.string(),
    labels: z
      .array(
        z
          .object({
            label: z.string().regex(HABIT_LEARNING_PARTITION_LABEL),
            siid: z.number().int().positive(),
            piid: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    askAfterObservation: z.literal(true),
    sourceOfTruth: z.literal('Mi Home app'),
  })
  .strict();
export type HabitLearningPartitionClarification = z.infer<
  typeof HabitLearningPartitionClarificationSchema
>;

export const HabitLearningPlanSchema = z
  .object({
    planVersion: z.literal(HABIT_LEARNING_PLAN_VERSION),
    planId: z.string().regex(/^[a-f0-9]{64}$/),
    inventory: z
      .object({
        visibleDeviceCount: z.number().int().nonnegative(),
        onlineCount: z.number().int().nonnegative(),
        pushAvailableCount: z.number().int().nonnegative(),
        inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    specs: z
      .object({
        requestedUrns: z.array(z.string()),
        loadedUrns: z.array(z.string()),
        failedUrns: z.array(z.string()),
        semanticCatalogFallbackUrns: z.array(z.string()),
      })
      .strict(),
    policy: z
      .object({
        name: z.literal('behavior'),
        includeContext: z.boolean(),
        includeSensitive: z.boolean(),
        excludedDeviceIds: z.array(z.string().min(1)),
        excludedRoomIds: z.array(z.string().min(1)),
        includesSensitiveValues: z.boolean(),
        graphMode: z.literal('single'),
        automaticPartitioning: z.literal(false),
        occupancySensorCoreContextIncludedByDefault: z.literal(true),
        householdSizeInference: z.literal('prohibited'),
        unverifiedRuntimeCapacity: z.literal(true),
      })
      .strict(),
    signals: z.array(HabitLearningSignalSchema),
    graph: HabitLearningGraphSchema,
    deviceCoverage: z.array(HabitLearningDeviceCoverageSchema),
    partitionClarifications: z.array(HabitLearningPartitionClarificationSchema),
    coverage: z
      .object({
        devices: z
          .object({
            visible: z.number().int().nonnegative(),
            planned: z.number().int().nonnegative(),
            excluded: z.number().int().nonnegative(),
          })
          .strict(),
        observableSignals: z.number().int().nonnegative(),
        plannedSignals: z.number().int().nonnegative(),
        behaviorSignals: z.number().int().nonnegative(),
        contextSignals: z.number().int().nonnegative(),
        excludedSignals: z.number().int().nonnegative(),
        sampleOnlyProperties: z.number().int().nonnegative(),
        excludedByReason: z.record(HabitLearningReasonCodeSchema, z.number().int().nonnegative()),
      })
      .strict(),
    limitations: z.array(
      z.enum([
        'gateway-retention-unknown',
        'not-all-device-behavior-observable',
        'household-membership-not-observed',
        'manual-vs-automation-causality-unknown',
        'runtime-source-capacity-unverified',
      ]),
    ),
  })
  .strict();
export type HabitLearningPlan = z.infer<typeof HabitLearningPlanSchema>;
