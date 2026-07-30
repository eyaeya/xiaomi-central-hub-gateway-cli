import { createHash } from 'node:crypto';
import { partitionLabel } from '../resources/device-partitions.js';
import type { MiotEvent, MiotProperty, MiotService } from '../schemas/device-spec.js';
import { isGhostDevice } from '../schemas/device.js';
import {
  HABIT_LEARNING_PLAN_VERSION,
  HABIT_LEARNING_REASON_CODES,
  type HabitLearningCaptureDtype,
  type HabitLearningDeviceCoverage,
  type HabitLearningDeviceReference,
  type HabitLearningGraph,
  type HabitLearningPartitionClarification,
  type HabitLearningPlan,
  type HabitLearningPlanInput,
  HabitLearningPlanInputSchema,
  HabitLearningPlanSchema,
  type HabitLearningReasonCode,
  type HabitLearningSensitivity,
  type HabitLearningSignal,
  type HabitLearningSignalSemantics,
  type HabitLearningSignalTier,
  type HabitLearningSourceDtype,
  type ParsedHabitLearningDeviceInput,
  type ParsedHabitLearningPlanInput,
} from '../schemas/habit-learning.js';

const PARTITION_OCCUPANCY_MODEL = 'xiaomi.sensor_occupy.p1';
const TRIO_OCCUPANCY_MODEL = 'izq.sensor_occupy.trio';
const OCCUPANCY_SENSOR_CORE_CONTEXT_MODELS: ReadonlySet<string> = new Set([
  PARTITION_OCCUPANCY_MODEL,
  TRIO_OCCUPANCY_MODEL,
]);

const LIMITATIONS = [
  'gateway-retention-unknown',
  'not-all-device-behavior-observable',
  'household-membership-not-observed',
  'manual-vs-automation-causality-unknown',
  'runtime-source-capacity-unverified',
] as const;

const BEHAVIOR_PROPERTY_NAMES = new Set([
  'activity-state',
  'air-cooler',
  'anion',
  'contact-state',
  'cooking-status',
  'curtain-status',
  'door-state',
  'dryer',
  'heating',
  'horizontal-swing',
  'keep-warm',
  'lock-state',
  'mode',
  'motion-state',
  'occupancy-state',
  'occupancy-status',
  'on',
  'operation-mode',
  'operation-state',
  'position',
  'running-state',
  'status',
  'submersion-state',
  'target-position',
  'valve-switch',
  'vertical-swing',
  'watering',
  'working-state',
  'working-status',
]);

const EXTENDED_SUBMERSION_BEHAVIOR_PROPERTY_NAMES = new Set(['submersion-state-top']);

const CONTEXT_PROPERTY_NAMES = new Set([
  'air-quality-index',
  'atmospheric-pressure',
  'co2-density',
  'humidity',
  'illuminance',
  'illumination',
  'noise-decibel',
  'pm10-density',
  'pm2.5-density',
  'relative-humidity',
  'temperature',
]);

const DIAGNOSTIC_SERVICE_NAMES = new Set([
  'battery',
  'config-sensor',
  'configuration',
  'device-information',
  'firmware',
  'network',
  'occupancy-config',
  'settings',
  'zone-metrics',
  'accidental-deletion',
  'indicator-light',
  'virtual-service',
]);

const DIAGNOSTIC_PROPERTY_NAMES = new Set([
  'battery-level',
  'fault',
  'firmware-version',
  'hardware-version',
  'manufacturer',
  'model',
  'rssi',
  'serial-number',
  'signal-strength',
  'software-version',
  'wifi-signal-strength',
]);

const HIGH_FREQUENCY_PROPERTY_NAMES = new Set([
  'current',
  'download-speed',
  'electric-current',
  'electric-power',
  'instantaneous-flow',
  'network-speed',
  'power-consumption',
  'real-time-power',
  'traffic',
  'upload-speed',
  'voltage',
]);

const SENSITIVE_PRIVACY_PARTS = [
  'camera',
  'doorbell',
  'face id',
  'face recognition',
  'facial',
  'fingerprint',
  'intercom',
  'lock-event',
  'microphone',
  'recording',
  'speaker-call',
  'talk',
  'video',
  'voice',
  '人脸',
  '指纹',
];

const SENSITIVE_PRIVACY_NAMES = new Set([
  'abnormal-vital-signs',
  'fall-asleep',
  'geofence-entered',
  'geofence-exited',
  'high-heart-rate',
  'key-call-start',
  'location-changed',
  'location-status',
  'location-update',
  'location-updated',
  'low-heart-rate',
  'low-spo2',
  'person-approaching-car-detected',
  'sleep-state-change',
  'visitor-identify',
]);

const RESTRICTED_PRIVACY_NAMES = new Set([
  'access-token',
  'api-key',
  'api-secret',
  'app-identity',
  'audio-id',
  'auth-token',
  'client-secret',
  'cloud-video-id',
  'current-address',
  'email',
  'email-address',
  'e-mail-address',
  'gps',
  'gps-coordinate',
  'image-snapshot',
  'latitude',
  'license-plate',
  'lock-user-info-string',
  'location-coordinate',
  'longitude',
  'mobile-number',
  'phone-number',
  'play-content',
  'playing-history-content',
  'ppp-username',
  'private-key',
  'refresh-token',
  'secret',
  'secret-key',
  'session-token',
  'stream-auth-token',
  'telephone-number',
  'text-content',
  'voice-url',
]);

const CONFIGURATION_EVENT_NAMES = new Set([
  'add-user-complete',
  'add-user-key-complete',
  'delete-user-complete',
  'delete-user-key-complete',
  'history-user-complete',
  'member-list-change',
  'sync-user-complete',
  'sync-user-key-complete',
  'update-lock-user',
]);

const reasonOrder = new Map<string, number>(
  HABIT_LEARNING_REASON_CODES.map((reason, index) => [reason, index]),
);

interface ClassifiedCapability {
  tier: Exclude<HabitLearningSignalTier, 'excluded'> | 'excluded';
  sensitivity: HabitLearningSensitivity;
  reasons: HabitLearningReasonCode[];
  eligibleByPolicy: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function uniqueSorted<T>(values: Iterable<T>, compare?: (a: T, b: T) => number): T[] {
  return [...new Set(values)].sort(compare);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortReasons(reasons: Iterable<HabitLearningReasonCode>): HabitLearningReasonCode[] {
  return uniqueSorted(reasons, (left, right) => {
    const leftOrder = reasonOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = reasonOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || compareStrings(left, right);
  });
}

function urnShortName(urn: string): string {
  return urn.split(':')[3]?.toLowerCase() ?? urn.toLowerCase();
}

function containsPart(value: string, parts: readonly string[]): boolean {
  return parts.some((part) => value.includes(part));
}

function isDurationName(name: string): boolean {
  return /(?:^|-)(?:countdown|duration|elapsed-time|keep-warm-time|remaining-time|run-time|time-left|uptime)(?:-|$)/.test(
    name,
  );
}

function isDiagnosticServiceName(name: string): boolean {
  return (
    DIAGNOSTIC_SERVICE_NAMES.has(name) || /(?:^|-)(?:cfg|config|configuration)(?:-|$)/.test(name)
  );
}

function isDiagnosticEventName(name: string): boolean {
  return /(?:^|-)(?:batt|battery|cfg|config|configuration|error|exception|factory|fault|firmware|ota|reset|unbind)(?:-|$)/.test(
    name,
  );
}

function isConfigurationEventName(name: string): boolean {
  return CONFIGURATION_EVENT_NAMES.has(name);
}

function isBehaviorPropertyName(name: string): boolean {
  return BEHAVIOR_PROPERTY_NAMES.has(name) || EXTENDED_SUBMERSION_BEHAVIOR_PROPERTY_NAMES.has(name);
}

function isConfigurationPropertyName(serviceName: string, propertyName: string): boolean {
  return (
    propertyName === 'enable-switch' ||
    (propertyName === 'mode' &&
      (serviceName.includes('button') || serviceName.includes('switch-sensor')))
  );
}

function sourceDtype(format: string): HabitLearningSourceDtype | undefined {
  if (format.length === 0) return undefined;
  if (format === 'string') return 'string';
  if (format === 'bool') return 'boolean';
  if (format === 'float' || format === 'double') return 'float';
  // The gateway's spec parser and web editor treat every other non-string
  // format as an integer/numeric value, including vendor-extended formats.
  return 'int';
}

function captureDtype(format: string): HabitLearningCaptureDtype | undefined {
  const source = sourceDtype(format);
  if (source === undefined) return undefined;
  return source === 'string' ? 'string' : 'number';
}

function privacySensitivity(
  parts: readonly string[],
  valueFormat?: string,
): HabitLearningSensitivity {
  const normalized = parts.map((part) => part.trim().toLowerCase());
  if (normalized.some((part) => isRestrictedPrivacyPart(part, valueFormat))) {
    return 'restricted';
  }
  if (normalized.some((part) => SENSITIVE_PRIVACY_NAMES.has(part))) return 'sensitive';
  const material = normalized.join(' ');
  if (containsPart(material, SENSITIVE_PRIVACY_PARTS)) return 'sensitive';
  return 'normal';
}

function hasSemanticToken(value: string, token: string): boolean {
  return new RegExp(`(?:^|-)${token}(?:-|$)`).test(value);
}

function isContextualRestrictedPrivacy(serviceName: string, capabilityName: string): boolean {
  const isContactContext =
    hasSemanticToken(serviceName, 'contact') ||
    hasSemanticToken(serviceName, 'contacts') ||
    serviceName === 'address-book' ||
    serviceName === 'phone-book';
  if (
    isContactContext &&
    /^(?:address|e-?mail|e-?mail-address|id|ids|name|mobile-number|phone|phone-number|telephone-number)$/.test(
      capabilityName,
    )
  ) {
    return true;
  }

  const isMediaContext = [
    'audio',
    'camera',
    'media',
    'recording',
    'snapshot',
    'video',
    'voice',
  ].some((token) => hasSemanticToken(serviceName, token));
  if (isMediaContext && /^(?:(?:content|media|thumbnail)-)?(?:uri|url)$/.test(capabilityName)) {
    return true;
  }

  const isLocationContext = ['geofence', 'gps', 'location'].some((token) =>
    hasSemanticToken(serviceName, token),
  );
  return isLocationContext && /^(?:address|coordinate|coordinates|position)$/.test(capabilityName);
}

function isRestrictedPrivacyPart(part: string, valueFormat?: string): boolean {
  if (RESTRICTED_PRIVACY_NAMES.has(part) || /^sim\d*-imei$/.test(part)) {
    return true;
  }
  if (
    /(?:^|[-_.\s])(?:account|client|credential|device|face|identity|key|member|person|user)[-_.\s]?(?:id|ids)$/.test(
      part,
    )
  ) {
    return true;
  }
  if (/(?:^|[-_.\s])(?:bssid|ssid|ip-address|mac-address|mac-adress)$/.test(part)) {
    return true;
  }
  if (
    /(?:^|[-_.\s])(?:contact-name|e-?mail(?:-address)?|latitude|location-coordinate|longitude|mobile-number|phone-number|telephone-number)$/.test(
      part,
    )
  ) {
    return true;
  }
  if (/(?:^|[-_.\s])(?:audio-content|stream-address|video-content|voice-content)$/.test(part)) {
    return true;
  }
  if (valueFormat === 'string') {
    if (/(?:^|[-_.\s])(?:credential|passcode|password)$/.test(part)) {
      return true;
    }
    if (
      /(?:^|[-_.\s])(?:(?:access|api|auth|refresh|session|stream)[-_.\s]?token|(?:api|client|private|secret)[-_.\s]?(?:key|secret))$/.test(
        part,
      )
    ) {
      return true;
    }
    if (/(?:^|[-_.\s])(?:secret|token)$/.test(part)) {
      return true;
    }
    if (
      /(?:^|[-_.\s])(?:audio|content|image|media|recording|snapshot|stream|thumbnail|video|voice)[-_.\s]?(?:uri|url)$/.test(
        part,
      )
    ) {
      return true;
    }
  }
  return /(?:人员标识|凭证|密码|密钥|成员标识|用户标识|身份标识|账号|联系人姓名|手机号|电话号码|电子邮箱|邮箱地址|经度|纬度|坐标|媒体地址|媒体链接)$/.test(
    part,
  );
}

function maximumSensitivity(
  left: HabitLearningSensitivity,
  right: HabitLearningSensitivity,
): HabitLearningSensitivity {
  const rank: Record<HabitLearningSensitivity, number> = {
    normal: 0,
    sensitive: 1,
    restricted: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function deviceReference(entry: ParsedHabitLearningDeviceInput): HabitLearningDeviceReference {
  const { device } = entry;
  return {
    did: device.did,
    name: device.name,
    model: device.model,
    urn: device.urn,
    roomId: device.roomId,
    roomName: device.roomName,
  };
}

function deviceBlockingReasons(
  entry: ParsedHabitLearningDeviceInput,
  policy: ParsedHabitLearningPlanInput,
): HabitLearningReasonCode[] {
  const reasons: HabitLearningReasonCode[] = [];
  const { device } = entry;
  if (!device.online) reasons.push('device-offline');
  if (isGhostDevice(device)) {
    reasons.push('device-ghost');
  } else if (!device.specV2Access && !device.specV3Access) {
    reasons.push('device-no-spec-access');
  }
  if (!device.pushAvailable) reasons.push('device-push-unavailable');
  if (
    policy.excludedDeviceIds.includes(device.did) ||
    policy.excludedRoomIds.includes(device.roomId)
  ) {
    reasons.push('user-excluded');
  }
  if (
    entry.spec === undefined &&
    (device.specV2Access || device.specV3Access || entry.specError !== undefined)
  ) {
    reasons.push('spec-fetch-failed');
  }
  return sortReasons(reasons);
}

function propertySensitivity(
  entry: ParsedHabitLearningDeviceInput,
  service: MiotService,
  property: MiotProperty,
): HabitLearningSensitivity {
  const serviceName = urnShortName(service.type);
  const propertyName = urnShortName(property.type);
  if (isContextualRestrictedPrivacy(serviceName, propertyName)) return 'restricted';
  const semanticParts = [
    entry.device.model,
    urnShortName(entry.device.urn),
    serviceName,
    propertyName,
  ];
  if (entry.semanticCatalogFallback) {
    // Raw descriptions are display metadata rather than wire semantics. Only
    // consult them when the semantic catalog is unavailable, and fail closed
    // for explicit biometric, credential, or person-identifier vocabulary.
    semanticParts.push(service.description, property.description);
  }
  return privacySensitivity(semanticParts, property.format);
}

function eventSensitivity(
  entry: ParsedHabitLearningDeviceInput,
  service: MiotService,
  event: MiotEvent,
  arguments_: MiotProperty[],
): HabitLearningSensitivity {
  const semanticParts = [
    entry.device.model,
    urnShortName(entry.device.urn),
    urnShortName(service.type),
    urnShortName(event.type),
  ];
  if (entry.semanticCatalogFallback) {
    semanticParts.push(service.description, event.description);
  }
  let sensitivity = privacySensitivity(semanticParts);
  for (const argument of arguments_) {
    sensitivity = maximumSensitivity(sensitivity, propertySensitivity(entry, service, argument));
  }
  return sensitivity;
}

function fixedPartitionLabel(
  entry: ParsedHabitLearningDeviceInput,
  service: MiotService,
  property?: MiotProperty,
): string | undefined {
  const p1Label = partitionLabel(entry.device.model, service.iid);
  if (p1Label !== undefined) return p1Label;
  if (
    entry.device.model !== TRIO_OCCUPANCY_MODEL ||
    property === undefined ||
    service.iid !== 6 ||
    urnShortName(service.type) !== 'switch-sensor' ||
    urnShortName(property.type) !== 'status' ||
    property.iid < 1 ||
    property.iid > 6
  ) {
    return undefined;
  }
  return `Zone-${property.iid}`;
}

function basePropertyClassification(
  entry: ParsedHabitLearningDeviceInput,
  service: MiotService,
  property: MiotProperty,
  policy: ParsedHabitLearningPlanInput,
): ClassifiedCapability {
  const propertyName = urnShortName(property.type);
  const serviceName = urnShortName(service.type);
  const partition = fixedPartitionLabel(entry, service, property);
  const isPartitionOccupancy =
    partition !== undefined && (propertyName === 'occupancy-status' || propertyName === 'status');
  const isOccupancySensorCoreContext =
    OCCUPANCY_SENSOR_CORE_CONTEXT_MODELS.has(entry.device.model) &&
    (propertyName === 'illumination' ||
      propertyName === 'illuminance' ||
      propertyName === 'people-num');
  const sensitivity = propertySensitivity(entry, service, property);
  const reasons: HabitLearningReasonCode[] = [];

  if (!property.access.includes('notify')) {
    reasons.push('property-not-notify');
    if (property.access.includes('read')) reasons.push('sample-only-not-behavior');
  }
  if (captureDtype(property.format) === undefined) {
    reasons.push('capture-dtype-unsupported');
  }

  let desiredTier: ClassifiedCapability['tier'];
  if (isPartitionOccupancy) {
    desiredTier = 'p0-behavior';
  } else if (isOccupancySensorCoreContext) {
    // Overall illumination and instantaneous people count are deliberately
    // retained for this model even though they live outside services 4..35.
    // They provide essential context for interpreting A-1..B-16 transitions;
    // people-num must never be reinterpreted as household membership.
    desiredTier = 'p1-context';
  } else if (isDurationName(propertyName)) {
    desiredTier = 'excluded';
    reasons.push('duration-default-excluded');
  } else if (
    isDiagnosticServiceName(serviceName) ||
    DIAGNOSTIC_PROPERTY_NAMES.has(propertyName) ||
    isConfigurationPropertyName(serviceName, propertyName)
  ) {
    desiredTier = 'excluded';
    reasons.push('configuration-or-diagnostic');
  } else if (HIGH_FREQUENCY_PROPERTY_NAMES.has(propertyName)) {
    desiredTier = 'excluded';
    reasons.push('high-frequency-default-excluded');
  } else if (isBehaviorPropertyName(propertyName)) {
    desiredTier = 'p0-behavior';
  } else if (CONTEXT_PROPERTY_NAMES.has(propertyName)) {
    desiredTier = 'p1-context';
  } else {
    desiredTier = 'excluded';
    reasons.push('default-policy-excluded');
  }

  if (sensitivity === 'restricted' || (sensitivity === 'sensitive' && !policy.includeSensitive)) {
    reasons.push('sensitive-default-excluded');
  }
  if (desiredTier === 'p1-context' && !policy.includeContext && !isOccupancySensorCoreContext) {
    reasons.push('context-default-deferred');
  }

  const eligibleByPolicy =
    desiredTier !== 'excluded' &&
    property.access.includes('notify') &&
    captureDtype(property.format) !== undefined &&
    sensitivity !== 'restricted' &&
    (sensitivity !== 'sensitive' || policy.includeSensitive) &&
    (desiredTier !== 'p1-context' || policy.includeContext || isOccupancySensorCoreContext);

  return {
    tier: desiredTier,
    sensitivity,
    reasons: sortReasons(reasons),
    eligibleByPolicy,
  };
}

function baseEventClassification(
  entry: ParsedHabitLearningDeviceInput,
  service: MiotService,
  event: MiotEvent,
  resolvedArguments: MiotProperty[],
  hasUnresolvedArguments: boolean,
  policy: ParsedHabitLearningPlanInput,
): ClassifiedCapability {
  const eventName = urnShortName(event.type);
  const serviceName = urnShortName(service.type);
  const sensitivity = eventSensitivity(entry, service, event, resolvedArguments);
  const reasons: HabitLearningReasonCode[] = [];
  let desiredTier: ClassifiedCapability['tier'] = 'p0-behavior';

  if (hasUnresolvedArguments) reasons.push('event-argument-unresolved');
  if (resolvedArguments.some((argument) => captureDtype(argument.format) === undefined)) {
    reasons.push('capture-dtype-unsupported');
  }

  if (isDurationName(eventName)) {
    desiredTier = 'excluded';
    reasons.push('duration-default-excluded');
  } else if (
    isDiagnosticServiceName(serviceName) ||
    isDiagnosticEventName(eventName) ||
    isConfigurationEventName(eventName)
  ) {
    desiredTier = 'excluded';
    reasons.push('configuration-or-diagnostic');
  } else if (
    eventName === 'metrics' ||
    eventName.includes('properties-changed') ||
    eventName.includes('telemetry') ||
    eventName.includes('statistics')
  ) {
    desiredTier = 'excluded';
    reasons.push('high-frequency-default-excluded');
  }

  if (sensitivity === 'restricted' || (sensitivity === 'sensitive' && !policy.includeSensitive)) {
    reasons.push('sensitive-default-excluded');
  }

  const eligibleByPolicy =
    desiredTier !== 'excluded' &&
    !hasUnresolvedArguments &&
    resolvedArguments.every((argument) => captureDtype(argument.format) !== undefined) &&
    sensitivity !== 'restricted' &&
    (sensitivity !== 'sensitive' || policy.includeSensitive);

  return {
    tier: desiredTier,
    sensitivity,
    reasons: sortReasons(reasons),
    eligibleByPolicy,
  };
}

function signalIdentity(
  did: string,
  selector:
    | { kind: 'property'; siid: number; piid: number }
    | { kind: 'event'; siid: number; eiid: number; argumentPiids: number[] },
): string {
  return digest({ did, ...selector });
}

function propertySemantics(
  service: MiotService,
  property: MiotProperty,
): HabitLearningSignalSemantics {
  return {
    serviceUrn: service.type,
    capabilityUrn: property.type,
    serviceDescription: service.description,
    capabilityDescription: property.description,
    ...(property.unit !== undefined && { unit: property.unit }),
    ...(property['value-range'] !== undefined && {
      valueRange: {
        min: property['value-range'][0],
        max: property['value-range'][1],
        step: property['value-range'][2],
      },
    }),
    ...(property['value-list'] !== undefined && {
      valueList: [...property['value-list']]
        .sort((left, right) => left.value - right.value)
        .map(({ value, description }) => ({ value, description })),
    }),
  };
}

function eventSemantics(service: MiotService, event: MiotEvent): HabitLearningSignalSemantics {
  return {
    serviceUrn: service.type,
    capabilityUrn: event.type,
    serviceDescription: service.description,
    capabilityDescription: event.description,
  };
}

function eventArgument(argument: MiotProperty) {
  return {
    piid: argument.iid,
    urn: argument.type,
    description: argument.description,
    format: argument.format,
    ...(argument.unit !== undefined && { unit: argument.unit }),
    ...(argument['value-range'] !== undefined && {
      valueRange: {
        min: argument['value-range'][0],
        max: argument['value-range'][1],
        step: argument['value-range'][2],
      },
    }),
    ...(argument['value-list'] !== undefined && {
      valueList: [...argument['value-list']]
        .sort((left, right) => left.value - right.value)
        .map(({ value, description }) => ({ value, description })),
    }),
    sourceDtype: sourceDtype(argument.format) ?? 'int',
    captureDtype: captureDtype(argument.format) ?? 'number',
  };
}

function finalizedClassification(
  base: ClassifiedCapability,
  entry: ParsedHabitLearningDeviceInput,
  policy: ParsedHabitLearningPlanInput,
): {
  included: boolean;
  tier: HabitLearningSignalTier;
  reasonCodes: HabitLearningReasonCode[];
} {
  const reasons = [
    ...deviceBlockingReasons(entry, policy),
    ...(entry.semanticCatalogFallback ? (['semantic-catalog-fallback'] as const) : []),
    ...base.reasons,
  ];
  const included = base.eligibleByPolicy && deviceBlockingReasons(entry, policy).length === 0;
  if (included) {
    reasons.push(base.tier === 'p0-behavior' ? 'included-p0-behavior' : 'included-p1-context');
  }
  return {
    included,
    tier: included ? base.tier : 'excluded',
    reasonCodes: sortReasons(reasons),
  };
}

function propertySignal(
  entry: ParsedHabitLearningDeviceInput,
  service: MiotService,
  property: MiotProperty,
  policy: ParsedHabitLearningPlanInput,
): HabitLearningSignal {
  const source = sourceDtype(property.format) ?? 'int';
  const capture = captureDtype(property.format) ?? 'number';
  const base = basePropertyClassification(entry, service, property, policy);
  const finalized = finalizedClassification(base, entry, policy);
  const label = fixedPartitionLabel(entry, service, property);
  return {
    signalId: signalIdentity(entry.device.did, {
      kind: 'property',
      siid: service.iid,
      piid: property.iid,
    }),
    device: deviceReference(entry),
    selector: {
      kind: 'property',
      siid: service.iid,
      piid: property.iid,
      access: (['read', 'write', 'notify'] as const).filter((access) =>
        property.access.includes(access),
      ),
      sourceDtype: source,
      captureDtype: capture,
    },
    semantics: propertySemantics(service, property),
    ...(label !== undefined && {
      partition: {
        label,
        semanticStatus: 'opaque-user-confirmation-required' as const,
      },
    }),
    observability: property.access.includes('notify')
      ? 'push-notify'
      : property.access.includes('read')
        ? 'sample-only'
        : 'unobservable',
    tier: finalized.tier,
    sensitivity: base.sensitivity,
    included: finalized.included,
    reasonCodes: finalized.reasonCodes,
    runtimeVerified: false,
    estimatedNodes: finalized.included ? 1 : 0,
    estimatedVariables: finalized.included ? 1 : 0,
    estimatedLogLinesPerOccurrence: finalized.included ? { min: 1, max: 4 } : { min: 0, max: 0 },
  };
}

function eventSignal(
  entry: ParsedHabitLearningDeviceInput,
  service: MiotService,
  event: MiotEvent,
  policy: ParsedHabitLearningPlanInput,
): HabitLearningSignal {
  const argumentPiids = [...(event.arguments ?? [])];
  const propertiesByIid = new Map(
    (service.properties ?? []).map((property) => [property.iid, property]),
  );
  const resolvedArguments = argumentPiids
    .map((piid) => propertiesByIid.get(piid))
    .filter((property): property is MiotProperty => property !== undefined);
  const hasUnresolvedArguments = resolvedArguments.length !== argumentPiids.length;
  const base = baseEventClassification(
    entry,
    service,
    event,
    resolvedArguments,
    hasUnresolvedArguments,
    policy,
  );
  const finalized = finalizedClassification(base, entry, policy);
  const label = partitionLabel(entry.device.model, service.iid);
  return {
    signalId: signalIdentity(entry.device.did, {
      kind: 'event',
      siid: service.iid,
      eiid: event.iid,
      argumentPiids,
    }),
    device: deviceReference(entry),
    selector: {
      kind: 'event',
      siid: service.iid,
      eiid: event.iid,
      argumentPiids,
      arguments: resolvedArguments.map(eventArgument),
    },
    semantics: eventSemantics(service, event),
    ...(label !== undefined && {
      partition: {
        label,
        semanticStatus: 'opaque-user-confirmation-required' as const,
      },
    }),
    observability: 'event',
    tier: finalized.tier,
    sensitivity: base.sensitivity,
    included: finalized.included,
    reasonCodes: finalized.reasonCodes,
    runtimeVerified: false,
    estimatedNodes: finalized.included ? 1 : 0,
    estimatedVariables: finalized.included ? argumentPiids.length : 0,
    estimatedLogLinesPerOccurrence: finalized.included ? { min: 1, max: 4 } : { min: 0, max: 0 },
  };
}

function signalSortKey(signal: HabitLearningSignal): string {
  const selector = signal.selector;
  const iid = selector.kind === 'property' ? selector.piid : selector.eiid;
  const tierOrder = signal.tier === 'p0-behavior' ? '0' : signal.tier === 'p1-context' ? '1' : '2';
  return [
    signal.device.roomId,
    tierOrder,
    signal.device.did,
    String(selector.siid).padStart(5, '0'),
    selector.kind,
    String(iid).padStart(5, '0'),
    signal.signalId,
  ].join('\u0000');
}

function compareSignals(left: HabitLearningSignal, right: HabitLearningSignal): number {
  return compareStrings(signalSortKey(left), signalSortKey(right));
}

function signalsForEntry(
  entry: ParsedHabitLearningDeviceInput,
  policy: ParsedHabitLearningPlanInput,
): HabitLearningSignal[] {
  if (entry.spec === undefined) return [];
  const signals: HabitLearningSignal[] = [];
  const services = [...entry.spec.services].sort((left, right) => left.iid - right.iid);
  for (const service of services) {
    for (const property of [...(service.properties ?? [])].sort(
      (left, right) => left.iid - right.iid,
    )) {
      signals.push(propertySignal(entry, service, property, policy));
    }
    for (const event of [...(service.events ?? [])].sort((left, right) => left.iid - right.iid)) {
      signals.push(eventSignal(entry, service, event, policy));
    }
  }
  return signals.sort(compareSignals);
}

function buildGraph(signals: HabitLearningSignal[]): HabitLearningGraph {
  const signalIds = signals.filter((signal) => signal.included).map((signal) => signal.signalId);
  return {
    graphId: digest({ mode: 'single', signalIds }),
    label: 'Household habit learning',
    signalIds,
    sourceCount: signalIds.length,
    automaticPartitioning: false,
    unverifiedRuntimeCapacity: true,
  };
}

function observableSignal(signal: HabitLearningSignal): boolean {
  return signal.observability === 'event' || signal.observability === 'push-notify';
}

function sampleOnlyProperty(signal: HabitLearningSignal): boolean {
  return signal.observability === 'sample-only';
}

function buildDeviceCoverage(
  entries: ParsedHabitLearningDeviceInput[],
  signals: HabitLearningSignal[],
  policy: ParsedHabitLearningPlanInput,
): HabitLearningDeviceCoverage[] {
  return entries
    .map((entry) => {
      const deviceSignals = signals.filter((signal) => signal.device.did === entry.device.did);
      const observableSignalCount = deviceSignals.filter(observableSignal).length;
      const plannedSignalCount = deviceSignals.filter((signal) => signal.included).length;
      const excludedObservable = observableSignalCount - plannedSignalCount;
      const signalReasons = deviceSignals.flatMap((signal) =>
        signal.included
          ? signal.reasonCodes.filter((reason) => reason === 'semantic-catalog-fallback')
          : signal.reasonCodes,
      );
      const reasonCodes = sortReasons([...deviceBlockingReasons(entry, policy), ...signalReasons]);
      const status: HabitLearningDeviceCoverage['status'] =
        plannedSignalCount === 0
          ? 'excluded'
          : excludedObservable > 0
            ? 'partially-planned'
            : 'planned';
      return {
        did: entry.device.did,
        name: entry.device.name,
        roomId: entry.device.roomId,
        roomName: entry.device.roomName,
        status,
        reasonCodes,
        observableSignalCount,
        plannedSignalCount,
        sampleOnlyPropertyCount: deviceSignals.filter(sampleOnlyProperty).length,
      };
    })
    .sort((left, right) => compareStrings(left.did, right.did));
}

function partitionClarifications(
  signals: HabitLearningSignal[],
): HabitLearningPartitionClarification[] {
  const byDevice = new Map<
    string,
    {
      deviceName: string;
      roomName: string;
      labels: Map<string, { siid: number; piid: number }>;
    }
  >();
  for (const signal of signals) {
    if (!signal.included || signal.partition === undefined || signal.selector.kind !== 'property') {
      continue;
    }
    const current = byDevice.get(signal.device.did) ?? {
      deviceName: signal.device.name,
      roomName: signal.device.roomName,
      labels: new Map<string, { siid: number; piid: number }>(),
    };
    current.labels.set(signal.partition.label, {
      siid: signal.selector.siid,
      piid: signal.selector.piid,
    });
    byDevice.set(signal.device.did, current);
  }
  return [...byDevice.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([did, entry]) => ({
      did,
      deviceName: entry.deviceName,
      roomName: entry.roomName,
      labels: [...entry.labels.entries()]
        .sort(
          (left, right) =>
            left[1].siid - right[1].siid ||
            left[1].piid - right[1].piid ||
            compareStrings(left[0], right[0]),
        )
        .map(([label, selector]) => ({ label, ...selector })),
      askAfterObservation: true,
      sourceOfTruth: 'Mi Home app',
    }));
}

function countExcludedByReason(
  signals: HabitLearningSignal[],
): Partial<Record<HabitLearningReasonCode, number>> {
  const counts: Partial<Record<HabitLearningReasonCode, number>> = {};
  for (const signal of signals) {
    if (signal.included) continue;
    for (const reason of signal.reasonCodes) {
      if (
        reason === 'included-p0-behavior' ||
        reason === 'included-p1-context' ||
        reason === 'semantic-catalog-fallback'
      ) {
        continue;
      }
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => {
      const leftOrder = reasonOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = reasonOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || compareStrings(left, right);
    }),
  );
}

function planIdMaterial(plan: Omit<HabitLearningPlan, 'planId'>): unknown {
  return {
    planVersion: plan.planVersion,
    inventory: plan.inventory,
    specs: plan.specs,
    policy: plan.policy,
    signals: plan.signals.map((signal) => ({
      signalId: signal.signalId,
      roomId: signal.device.roomId,
      tier: signal.tier,
      sensitivity: signal.sensitivity,
      included: signal.included,
      reasonCodes: signal.reasonCodes,
      partitionLabel: signal.partition?.label ?? null,
      selector: signal.selector,
      semantics: {
        serviceUrn: signal.semantics.serviceUrn,
        capabilityUrn: signal.semantics.capabilityUrn,
        unit: signal.semantics.unit ?? null,
        valueRange: signal.semantics.valueRange ?? null,
        valueList: signal.semantics.valueList ?? null,
      },
    })),
    graph: plan.graph,
    limitations: plan.limitations,
  };
}

/**
 * Produce a deterministic, read-only household habit-learning coverage plan.
 *
 * This function deliberately accepts already-fetched inventory/spec data and
 * performs no I/O or time reads. It describes observable evidence only; it
 * never estimates household size or identity.
 */
export function planHabitLearning(input: HabitLearningPlanInput): HabitLearningPlan {
  const parsed = HabitLearningPlanInputSchema.parse(input);
  const entries = [...parsed.devices].sort((left, right) =>
    compareStrings(left.device.did, right.device.did),
  );
  const signals = entries.flatMap((entry) => signalsForEntry(entry, parsed)).sort(compareSignals);
  const graph = buildGraph(signals);
  const deviceCoverage = buildDeviceCoverage(entries, signals, parsed);

  const requestedUrns = uniqueSorted(
    entries
      .filter((entry) => entry.device.specV2Access || entry.device.specV3Access)
      .map((entry) => entry.device.urn),
    compareStrings,
  );
  const loadedUrns = uniqueSorted(
    entries.filter((entry) => entry.spec !== undefined).map((entry) => entry.device.urn),
    compareStrings,
  );
  const failedUrns = uniqueSorted(
    entries
      .filter(
        (entry) =>
          entry.spec === undefined &&
          (entry.device.specV2Access || entry.device.specV3Access || entry.specError !== undefined),
      )
      .map((entry) => entry.device.urn),
    compareStrings,
  );
  const semanticCatalogFallbackUrns = uniqueSorted(
    entries.filter((entry) => entry.semanticCatalogFallback).map((entry) => entry.device.urn),
    compareStrings,
  );
  const inventoryHash = digest(
    entries.map(({ device }) => ({
      did: device.did,
      model: device.model,
      urn: device.urn,
      roomId: device.roomId,
      online: device.online,
      pushAvailable: device.pushAvailable,
      specV2Access: device.specV2Access,
      specV3Access: device.specV3Access,
    })),
  );
  const plannedSignals = signals.filter((signal) => signal.included);
  const plannedDeviceCount = deviceCoverage.filter((device) => device.status !== 'excluded').length;
  const includesSensitiveValues = plannedSignals.some((signal) => signal.sensitivity !== 'normal');
  const planWithoutId: Omit<HabitLearningPlan, 'planId'> = {
    planVersion: HABIT_LEARNING_PLAN_VERSION,
    inventory: {
      visibleDeviceCount: entries.length,
      onlineCount: entries.filter((entry) => entry.device.online).length,
      pushAvailableCount: entries.filter((entry) => entry.device.pushAvailable).length,
      inventoryHash,
    },
    specs: {
      requestedUrns,
      loadedUrns,
      failedUrns,
      semanticCatalogFallbackUrns,
    },
    policy: {
      name: 'behavior',
      includeContext: parsed.includeContext,
      includeSensitive: parsed.includeSensitive,
      excludedDeviceIds: parsed.excludedDeviceIds,
      excludedRoomIds: parsed.excludedRoomIds,
      includesSensitiveValues,
      graphMode: 'single',
      automaticPartitioning: false,
      occupancySensorCoreContextIncludedByDefault: true,
      householdSizeInference: 'prohibited',
      unverifiedRuntimeCapacity: true,
    },
    signals,
    graph,
    deviceCoverage,
    partitionClarifications: partitionClarifications(signals),
    coverage: {
      devices: {
        visible: entries.length,
        planned: plannedDeviceCount,
        excluded: entries.length - plannedDeviceCount,
      },
      observableSignals: signals.filter(observableSignal).length,
      plannedSignals: plannedSignals.length,
      behaviorSignals: plannedSignals.filter((signal) => signal.tier === 'p0-behavior').length,
      contextSignals: plannedSignals.filter((signal) => signal.tier === 'p1-context').length,
      excludedSignals: signals.length - plannedSignals.length,
      sampleOnlyProperties: signals.filter(sampleOnlyProperty).length,
      excludedByReason: countExcludedByReason(signals),
    },
    limitations: [...LIMITATIONS],
  };
  const plan: HabitLearningPlan = {
    ...planWithoutId,
    planId: digest(planIdMaterial(planWithoutId)),
  };
  return HabitLearningPlanSchema.parse(plan);
}

/** Stable identifier material for callers that need to compare a saved signal. */
export function habitLearningSignalId(
  did: string,
  selector:
    | { kind: 'property'; siid: number; piid: number }
    | { kind: 'event'; siid: number; eiid: number; argumentPiids?: number[] },
): string {
  return signalIdentity(
    did,
    selector.kind === 'property'
      ? selector
      : {
          ...selector,
          argumentPiids: [...(selector.argumentPiids ?? [])],
        },
  );
}
