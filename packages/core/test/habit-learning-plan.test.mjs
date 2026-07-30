import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HABIT_LEARNING_PLAN_VERSION,
  HabitLearningPlanSchema,
  habitLearningSignalId,
  planHabitLearning,
} from '../dist/index.js';

const deviceUrn = (name) => `urn:miot-spec-v2:device:${name}:0000A001:habit-fixture:1`;
const serviceUrn = (name) => `urn:miot-spec-v2:service:${name}:00007801:habit-fixture:1`;
const propertyUrn = (name) => `urn:miot-spec-v2:property:${name}:00000001:habit-fixture:1`;
const eventUrn = (name) => `urn:miot-spec-v2:event:${name}:00005001:habit-fixture:1`;
const actionUrn = (name) => `urn:miot-spec-v2:action:${name}:00002801:habit-fixture:1`;

function device(did, overrides = {}) {
  return {
    did,
    specV2Access: true,
    specV3Access: false,
    online: true,
    pushAvailable: true,
    name: `Device ${did}`,
    model: `fixture.${did}`,
    modelName: `Fixture ${did}`,
    urn: deviceUrn('habit-device'),
    roomId: 'room-1',
    roomName: 'Room One',
    icon: '',
    ...overrides,
  };
}

function property(iid, name, access = ['read', 'notify'], format = 'uint8', extra = {}) {
  return {
    iid,
    type: propertyUrn(name),
    description: name,
    format,
    access,
    ...extra,
  };
}

function event(iid, name, arguments_, extra = {}) {
  return {
    iid,
    type: eventUrn(name),
    description: name,
    ...(arguments_ !== undefined && { arguments: arguments_ }),
    ...extra,
  };
}

function service(
  iid,
  name,
  { properties = [], events = [], actions = [], type = serviceUrn(name), description = name } = {},
) {
  return {
    iid,
    type,
    description,
    properties,
    events,
    actions,
  };
}

function spec(name, services) {
  return {
    type: deviceUrn(name),
    description: name,
    services,
  };
}

function input(deviceValue, specValue, extra = {}) {
  return {
    device: { ...deviceValue, urn: specValue?.type ?? deviceValue.urn },
    ...(specValue !== undefined && { spec: specValue }),
    ...extra,
  };
}

function signalByCapability(plan, name, kind = 'property') {
  return plan.signals.find(
    (signal) =>
      signal.selector.kind === kind && signal.semantics.capabilityUrn.split(':')[3] === name,
  );
}

test('habit-learning planner and schema are available from the package root', () => {
  assert.equal(HABIT_LEARNING_PLAN_VERSION, 1);
  assert.equal(typeof HabitLearningPlanSchema.parse, 'function');
  assert.equal(typeof planHabitLearning, 'function');
  assert.equal(typeof habitLearningSignalId, 'function');
});

test('P1 planning includes overall occupancy, illumination, people count, and every A-1..B-16 state', () => {
  const partitionServices = [];
  for (let siid = 4; siid <= 35; siid += 1) {
    partitionServices.push(
      service(siid, 'partition-occupancy-sensor', {
        properties: [
          property(1, 'occupancy-status', ['read', 'notify'], 'uint8'),
          property(3, 'has-someone-duration', ['read', 'notify'], 'uint16', {
            unit: 'seconds',
            'value-range': [0, 36_000, 1],
          }),
          property(4, 'no-one-duration', ['read', 'notify'], 'uint16', {
            unit: 'seconds',
            'value-range': [0, 36_000, 1],
          }),
        ],
      }),
    );
  }
  const occupancySpec = spec('occupancy-sensor', [
    service(2, 'occupancy-sensor', {
      properties: [
        property(1, 'occupancy-status', ['read', 'notify'], 'uint8'),
        property(3, 'has-someone-duration', ['read', 'notify'], 'uint16', {
          unit: 'seconds',
          'value-range': [0, 36_000, 1],
        }),
        property(4, 'no-one-duration', ['read', 'notify'], 'uint16', {
          unit: 'seconds',
          'value-range': [0, 36_000, 1],
        }),
        property(5, 'illumination', ['read', 'notify'], 'float', {
          unit: 'lux',
          'value-range': [0, 1000, 1],
        }),
      ],
    }),
    service(3, 'config-sensor', {
      properties: [
        property(1, 'installation-method', ['read', 'write', 'notify'], 'uint8'),
        property(12, 'people-num', ['read', 'notify'], 'uint8', {
          description: '',
          'value-range': [0, 255, 1],
        }),
      ],
    }),
    ...partitionServices,
  ]);
  const occupancyDevice = device('occupancy', {
    model: 'xiaomi.sensor_occupy.p1',
    name: 'Partition sensor',
    roomName: 'Living Room',
  });

  const plan = planHabitLearning({
    devices: [input(occupancyDevice, occupancySpec)],
  });
  const partitionSignals = plan.signals.filter(
    (signal) => signal.included && signal.partition !== undefined,
  );
  const partitionOccupancy = partitionSignals.filter(
    (signal) => signal.semantics.capabilityUrn.split(':')[3] === 'occupancy-status',
  );
  assert.equal(partitionOccupancy.length, 32);
  const overallOccupancy = plan.signals.find(
    (signal) =>
      signal.selector.kind === 'property' &&
      signal.selector.siid === 2 &&
      signal.selector.piid === 1,
  );
  const illumination = signalByCapability(plan, 'illumination');
  const peopleCount = signalByCapability(plan, 'people-num');
  assert.equal(overallOccupancy.included, true);
  assert.equal(overallOccupancy.partition, undefined);
  assert.equal(illumination.included, true);
  assert.equal(illumination.tier, 'p1-context');
  assert.equal(illumination.selector.siid, 2);
  assert.equal(illumination.selector.piid, 5);
  assert.equal(peopleCount.included, true);
  assert.equal(peopleCount.tier, 'p1-context');
  assert.equal(peopleCount.selector.siid, 3);
  assert.equal(peopleCount.selector.piid, 12);
  assert.ok(
    signalByCapability(plan, 'installation-method').reasonCodes.includes(
      'configuration-or-diagnostic',
    ),
  );
  assert.equal(plan.graph.sourceCount, 35);
  assert.equal(
    plan.signals.filter(
      (signal) =>
        signal.semantics.capabilityUrn.split(':')[3].endsWith('duration') && signal.included,
    ).length,
    0,
  );
  assert.ok(
    plan.signals
      .filter((signal) => signal.included)
      .every((signal) =>
        signal.reasonCodes.includes(
          signal.tier === 'p0-behavior' ? 'included-p0-behavior' : 'included-p1-context',
        ),
      ),
  );
  assert.deepEqual(
    plan.partitionClarifications[0].labels.map(({ label, piid }) => [label, piid]),
    [
      ['A-1', 1],
      ['A-2', 1],
      ['A-3', 1],
      ['A-4', 1],
      ['A-5', 1],
      ['A-6', 1],
      ['A-7', 1],
      ['A-8', 1],
      ['A-9', 1],
      ['A-10', 1],
      ['A-11', 1],
      ['A-12', 1],
      ['A-13', 1],
      ['A-14', 1],
      ['A-15', 1],
      ['A-16', 1],
      ['B-1', 1],
      ['B-2', 1],
      ['B-3', 1],
      ['B-4', 1],
      ['B-5', 1],
      ['B-6', 1],
      ['B-7', 1],
      ['B-8', 1],
      ['B-9', 1],
      ['B-10', 1],
      ['B-11', 1],
      ['B-12', 1],
      ['B-13', 1],
      ['B-14', 1],
      ['B-15', 1],
      ['B-16', 1],
    ],
  );
  assert.equal(plan.partitionClarifications[0].askAfterObservation, true);
  assert.equal(plan.partitionClarifications[0].sourceOfTruth, 'Mi Home app');
  assert.ok(
    partitionSignals.every(
      (signal) => signal.partition.semanticStatus === 'opaque-user-confirmation-required',
    ),
  );
  assert.equal(plan.graph.sourceCount, plan.signals.filter((signal) => signal.included).length);
  assert.deepEqual(
    plan.graph.signalIds,
    plan.signals.filter((signal) => signal.included).map((signal) => signal.signalId),
  );
  assert.equal(plan.graph.automaticPartitioning, false);
  assert.equal(plan.policy.graphMode, 'single');
  assert.equal('shards' in plan, false);
  assert.equal(plan.policy.householdSizeInference, 'prohibited');
  assert.equal('householdSize' in plan, false);
  assert.ok(plan.limitations.includes('household-membership-not-observed'));
});

test('Trio planning keeps six opaque zones, overall context, and zone event arguments in one graph', () => {
  const izqServiceUrn = (name) => `urn:izq-spec:service:${name}:00007801:habit-fixture:1`;
  const izqPropertyUrn = (name) => `urn:izq-spec:property:${name}:00000001:habit-fixture:1`;
  const izqEventUrn = (name) => `urn:izq-spec:event:${name}:00005001:habit-fixture:1`;
  const zoneProperties = Array.from({ length: 6 }, (_, index) =>
    property(index + 1, 'status', ['read', 'notify'], 'uint8', {
      'value-list': [
        { value: 0, description: 'NoShow' },
        { value: 1, description: 'Show' },
      ],
    }),
  );
  const trioSpec = spec('occupancy-sensor', [
    service(2, 'occupancy-sensor', {
      properties: [
        property(1, 'occupancy-status', ['read', 'notify'], 'uint8'),
        property(2, 'illumination', ['read', 'notify'], 'uint16', {
          unit: 'lux',
          'value-range': [0, 65_535, 1],
        }),
      ],
    }),
    service(5, 'zone-manager', {
      type: izqServiceUrn('zone-manager'),
      properties: [
        property(1, 'zone-id', [], 'uint8', {
          type: izqPropertyUrn('zone-id'),
          description: '',
          'value-range': [0, 255, 1],
        }),
        property(2, 'duration', [], 'uint16', {
          type: izqPropertyUrn('duration'),
          description: '',
          unit: 'seconds',
          'value-range': [0, 65_535, 1],
        }),
        property(3, 'illumination', [], 'uint16', {
          type: izqPropertyUrn('illumination'),
          description: '',
          'value-range': [0, 65_535, 1],
        }),
      ],
      events: [
        event(1, 'zone-show', [1, 3], { type: izqEventUrn('zone-show') }),
        event(2, 'zone-noshow', [1, 3], { type: izqEventUrn('zone-noshow') }),
        event(3, 'zone-show-duration', [1, 2], {
          type: izqEventUrn('zone-show-duration'),
        }),
        event(4, 'zone-noshow-duration', [1, 2], {
          type: izqEventUrn('zone-noshow-duration'),
        }),
      ],
    }),
    service(6, 'switch-sensor', { properties: zoneProperties }),
  ]);
  const trioDevice = device('trio', {
    model: 'izq.sensor_occupy.trio',
    name: 'Trio sensor',
    roomName: 'Living Room',
  });
  const plan = planHabitLearning({ devices: [input(trioDevice, trioSpec)] });

  const overallOccupancy = plan.signals.find(
    (signal) =>
      signal.selector.kind === 'property' &&
      signal.selector.siid === 2 &&
      signal.selector.piid === 1,
  );
  const overallIllumination = plan.signals.find(
    (signal) =>
      signal.selector.kind === 'property' &&
      signal.selector.siid === 2 &&
      signal.selector.piid === 2,
  );
  const zoneSignals = plan.signals.filter(
    (signal) =>
      signal.included && signal.selector.kind === 'property' && signal.selector.siid === 6,
  );
  const zoneShow = signalByCapability(plan, 'zone-show', 'event');
  const zoneNoShow = signalByCapability(plan, 'zone-noshow', 'event');

  assert.equal(overallOccupancy.included, true);
  assert.equal(overallIllumination.included, true);
  assert.equal(overallIllumination.tier, 'p1-context');
  assert.deepEqual(
    zoneSignals.map((signal) => [
      signal.partition.label,
      signal.selector.siid,
      signal.selector.piid,
    ]),
    [
      ['Zone-1', 6, 1],
      ['Zone-2', 6, 2],
      ['Zone-3', 6, 3],
      ['Zone-4', 6, 4],
      ['Zone-5', 6, 5],
      ['Zone-6', 6, 6],
    ],
  );
  for (const eventSignal of [zoneShow, zoneNoShow]) {
    assert.equal(eventSignal.included, true);
    assert.deepEqual(eventSignal.selector.argumentPiids, [1, 3]);
    assert.deepEqual(
      eventSignal.selector.arguments.map((argument) => [
        argument.urn.split(':')[3],
        argument.sourceDtype,
        argument.captureDtype,
      ]),
      [
        ['zone-id', 'int', 'number'],
        ['illumination', 'int', 'number'],
      ],
    );
  }
  assert.equal(signalByCapability(plan, 'zone-show-duration', 'event').included, false);
  assert.equal(signalByCapability(plan, 'zone-noshow-duration', 'event').included, false);
  assert.deepEqual(
    plan.partitionClarifications[0].labels.map(({ label, siid, piid }) => [label, siid, piid]),
    [
      ['Zone-1', 6, 1],
      ['Zone-2', 6, 2],
      ['Zone-3', 6, 3],
      ['Zone-4', 6, 4],
      ['Zone-5', 6, 5],
      ['Zone-6', 6, 6],
    ],
  );
  assert.equal(plan.partitionClarifications[0].askAfterObservation, true);
  assert.equal(plan.graph.sourceCount, 10);
  assert.equal(plan.graph.sourceCount, plan.signals.filter((signal) => signal.included).length);
  assert.equal(plan.graph.automaticPartitioning, false);
  assert.equal('shards' in plan, false);
});

test('device eligibility records offline, ghost, no-push, and spec fetch failures without planning them', () => {
  const behaviorSpec = spec('switch', [
    service(2, 'switch', {
      properties: [property(1, 'on', ['read', 'notify'], 'bool')],
    }),
  ]);
  const entries = [
    input(device('eligible'), behaviorSpec),
    input(device('offline', { online: false }), behaviorSpec),
    input(device('no-push', { pushAvailable: false }), behaviorSpec),
    {
      device: device('ghost', {
        specV2Access: false,
        specV3Access: false,
        online: true,
        pushAvailable: false,
      }),
    },
    {
      device: device('spec-failed'),
      specError: 'fixture fetch failed',
    },
  ];
  const plan = planHabitLearning({ devices: entries });
  const byDid = new Map(plan.deviceCoverage.map((entry) => [entry.did, entry]));

  assert.equal(byDid.get('eligible').status, 'planned');
  assert.equal(byDid.get('offline').status, 'excluded');
  assert.ok(byDid.get('offline').reasonCodes.includes('device-offline'));
  assert.equal(byDid.get('no-push').status, 'excluded');
  assert.ok(byDid.get('no-push').reasonCodes.includes('device-push-unavailable'));
  assert.equal(byDid.get('ghost').status, 'excluded');
  assert.ok(byDid.get('ghost').reasonCodes.includes('device-ghost'));
  assert.equal(byDid.get('spec-failed').status, 'excluded');
  assert.ok(byDid.get('spec-failed').reasonCodes.includes('spec-fetch-failed'));
  assert.deepEqual(plan.specs.failedUrns, [deviceUrn('habit-device')]);
  assert.equal(plan.coverage.devices.visible, 5);
  assert.equal(plan.coverage.devices.planned, 1);
  assert.equal(plan.signals.find((signal) => signal.device.did === 'offline').included, false);
});

test('explicit device and room exclusions remain visible in coverage and never enter the graph', () => {
  const behaviorSpec = spec('switch', [
    service(2, 'switch', {
      properties: [property(1, 'on', ['read', 'notify'], 'bool')],
    }),
  ]);
  const plan = planHabitLearning({
    devices: [
      input(device('kept', { roomId: 'kept-room' }), behaviorSpec),
      input(device('device-excluded', { roomId: 'kept-room' }), behaviorSpec),
      input(device('room-excluded', { roomId: 'private-room' }), behaviorSpec),
    ],
    excludedDeviceIds: ['device-excluded'],
    excludedRoomIds: ['private-room'],
  });

  assert.deepEqual(plan.policy.excludedDeviceIds, ['device-excluded']);
  assert.deepEqual(plan.policy.excludedRoomIds, ['private-room']);
  assert.equal(plan.graph.sourceCount, 1);
  assert.deepEqual(
    plan.deviceCoverage
      .filter(({ status }) => status === 'excluded')
      .map(({ did }) => did)
      .sort(),
    ['device-excluded', 'room-excluded'],
  );
  for (const did of ['device-excluded', 'room-excluded']) {
    const signal = plan.signals.find((entry) => entry.device.did === did);
    assert.equal(signal.included, false);
    assert.ok(signal.reasonCodes.includes('user-excluded'));
  }
});

test('properties and events are classified by observability, rate, duration, policy, privacy, and argument safety', () => {
  const classificationSpec = spec('classification', [
    service(2, 'appliance', {
      properties: [
        property(1, 'on', ['read', 'notify'], 'bool'),
        property(2, 'temperature', ['read'], 'float'),
        property(3, 'working-duration', ['read', 'notify']),
        property(4, 'electric-power', ['read', 'notify'], 'float'),
        property(5, 'vendor-tuning', ['read', 'notify']),
        property(6, 'flag', ['read'], 'bool'),
        property(7, 'count', ['read'], 'uint32', {
          unit: 'items',
          'value-range': [0, 100, 1],
        }),
        property(8, 'ratio', ['read'], 'float'),
        property(9, 'label', ['read'], 'string', {
          'value-list': [
            { value: 2, description: 'Second' },
            { value: 1, description: 'First' },
          ],
        }),
        property(10, 'client-id', ['read'], 'string'),
      ],
      events: [
        event(1, 'clicked', []),
        event(2, 'cycle-finished', [6, 7, 8, 9]),
        event(3, 'broken-event', [99]),
        event(4, 'device-connected', [10]),
        event(5, 'telemetry-changed', []),
        event(6, 'recognized', [], { description: 'Face ID recognized' }),
      ],
      actions: [
        {
          iid: 1,
          type: actionUrn('start'),
          description: 'start',
          in: [],
          out: [],
        },
      ],
    }),
  ]);
  const plan = planHabitLearning({
    devices: [
      input(device('classification'), classificationSpec, {
        semanticCatalogFallback: true,
      }),
    ],
  });

  assert.equal(signalByCapability(plan, 'on').included, true);
  assert.equal(signalByCapability(plan, 'on').observability, 'push-notify');
  assert.ok(signalByCapability(plan, 'on').reasonCodes.includes('semantic-catalog-fallback'));
  assert.equal(plan.coverage.excludedByReason['semantic-catalog-fallback'], undefined);
  assert.equal(signalByCapability(plan, 'temperature').observability, 'sample-only');
  assert.ok(
    signalByCapability(plan, 'temperature').reasonCodes.includes('sample-only-not-behavior'),
  );
  assert.ok(
    signalByCapability(plan, 'working-duration').reasonCodes.includes('duration-default-excluded'),
  );
  assert.ok(
    signalByCapability(plan, 'electric-power').reasonCodes.includes(
      'high-frequency-default-excluded',
    ),
  );
  assert.ok(
    signalByCapability(plan, 'vendor-tuning').reasonCodes.includes('default-policy-excluded'),
  );

  const clicked = signalByCapability(plan, 'clicked', 'event');
  assert.equal(clicked.included, true);
  assert.deepEqual(clicked.selector.arguments, []);

  const multi = signalByCapability(plan, 'cycle-finished', 'event');
  assert.equal(multi.included, true);
  assert.deepEqual(
    multi.selector.arguments.map(({ sourceDtype, captureDtype }) => [sourceDtype, captureDtype]),
    [
      ['boolean', 'number'],
      ['int', 'number'],
      ['float', 'number'],
      ['string', 'string'],
    ],
  );
  assert.equal(multi.selector.arguments[1].unit, 'items');
  assert.deepEqual(multi.selector.arguments[1].valueRange, {
    min: 0,
    max: 100,
    step: 1,
  });
  assert.deepEqual(multi.selector.arguments[3].valueList, [
    { value: 1, description: 'First' },
    { value: 2, description: 'Second' },
  ]);

  const unresolved = signalByCapability(plan, 'broken-event', 'event');
  assert.equal(unresolved.included, false);
  assert.ok(unresolved.reasonCodes.includes('event-argument-unresolved'));

  const restricted = signalByCapability(plan, 'device-connected', 'event');
  assert.equal(restricted.sensitivity, 'restricted');
  assert.equal(restricted.included, false);
  assert.ok(restricted.reasonCodes.includes('sensitive-default-excluded'));

  const telemetry = signalByCapability(plan, 'telemetry-changed', 'event');
  assert.equal(telemetry.included, false);
  assert.ok(telemetry.reasonCodes.includes('high-frequency-default-excluded'));

  const descriptionOnlyRestricted = signalByCapability(plan, 'recognized', 'event');
  assert.equal(descriptionOnlyRestricted.sensitivity, 'sensitive');
  assert.equal(descriptionOnlyRestricted.included, false);
  assert.ok(descriptionOnlyRestricted.reasonCodes.includes('sensitive-default-excluded'));

  assert.equal(
    plan.signals.some((signal) => signal.selector.kind === 'action'),
    false,
  );
  assert.equal(plan.coverage.sampleOnlyProperties >= 5, true);
});

test('planner excludes diagnostic/configuration noise and restricted router identifiers while retaining safety state', () => {
  const policySpec = spec('policy-regression', [
    service(2, 'submersion-sensor', {
      properties: [
        property(1, 'submersion-state', ['read', 'notify'], 'bool'),
        property(2, 'submersion-state-top', ['read', 'notify'], 'bool'),
        property(3, 'submersion-state-threshold', ['read', 'notify'], 'uint8'),
      ],
      events: [event(1, 'device-be-reset', [])],
    }),
    service(3, 'curtain-cfg', {
      events: [
        event(1, 'dev-factory-reset', []),
        event(2, 'error-occurred', []),
        event(3, 'batt-output-overtmp', []),
      ],
    }),
    service(4, 'lock', {
      events: [event(1, 'exception-occurred', [])],
    }),
    service(5, 'switch-sensor-for-ble', {
      properties: [property(1, 'mode', ['read', 'notify'])],
      events: [event(1, 'click', [])],
    }),
    service(6, 'router', {
      properties: [
        property(1, 'connect-device-ids', [], 'string'),
        property(2, 'connected-device-number', ['read', 'notify']),
      ],
      events: [
        event(1, 'device-connect', [1]),
        event(2, 'device-disconnect', [1]),
        event(3, 'device-long-time-inactive', [1]),
      ],
    }),
    service(7, 'indicator-light', {
      properties: [property(1, 'on', ['read', 'notify'], 'bool')],
    }),
    service(8, 'virtual-service', {
      events: [event(1, 'virtual-event', [])],
    }),
    service(9, 'appliance', {
      events: [
        event(1, 'fault-happen', []),
        event(2, 'cycle-finished', []),
        event(3, 'config-changed', []),
        event(4, 'abnormal-sound', []),
        event(5, 'preset-changed', []),
        event(6, 'unbind-succeeded', []),
      ],
    }),
    service(10, 'privacy-boundaries', {
      properties: [
        property(1, 'identity-id', ['read'], 'string'),
        property(2, 'care-identity-id', ['read'], 'string'),
        property(3, 'key-call-userid', ['read'], 'string'),
        property(4, 'dhcp-server-mac-adress', ['read'], 'string'),
        property(5, 'wifi-ssid-hidden', ['read', 'notify'], 'bool'),
        property(6, 'fingerprint-board-version', ['read'], 'string'),
        property(7, 'if-set-password', ['read', 'notify'], 'bool'),
        property(8, 'credential-state', ['read', 'notify']),
        property(9, 'recording-mode', ['read', 'notify']),
        property(10, 'wifi-ssid', ['read'], 'string'),
        property(11, 'credential', ['read'], 'string'),
        property(12, 'audio-content', ['read'], 'string'),
        property(13, 'client-identifier', ['read'], 'string'),
        property(14, 'client-identifier-mode', ['read', 'notify'], 'bool'),
        property(15, 'device-id-state', ['read', 'notify']),
      ],
      events: [event(1, 'client-seen', [13]), event(2, 'ssid-observed', [10])],
    }),
    service(11, 'virtual-remote', {
      events: [event(1, 'gesture-detected', [])],
    }),
    service(12, 'air-conditioner', {
      properties: [property(1, 'mode', ['read', 'notify'])],
    }),
  ]);
  const plan = planHabitLearning({
    devices: [input(device('policy-regression'), policySpec)],
  });

  assert.equal(signalByCapability(plan, 'submersion-state').included, true);
  assert.equal(signalByCapability(plan, 'submersion-state-top').included, true);
  const submersionThreshold = signalByCapability(plan, 'submersion-state-threshold');
  assert.equal(submersionThreshold.included, false);
  assert.ok(submersionThreshold.reasonCodes.includes('default-policy-excluded'));
  assert.equal(signalByCapability(plan, 'cycle-finished', 'event').included, true);
  assert.equal(signalByCapability(plan, 'abnormal-sound', 'event').included, true);
  assert.equal(signalByCapability(plan, 'preset-changed', 'event').included, true);
  assert.equal(signalByCapability(plan, 'gesture-detected', 'event').included, true);
  assert.equal(signalByCapability(plan, 'click', 'event').included, true);
  assert.equal(
    plan.signals.find(
      (signal) =>
        signal.selector.kind === 'property' &&
        signal.semantics.serviceUrn.split(':')[3] === 'air-conditioner' &&
        signal.semantics.capabilityUrn.split(':')[3] === 'mode',
    ).included,
    true,
  );

  for (const capability of [
    'device-be-reset',
    'dev-factory-reset',
    'error-occurred',
    'batt-output-overtmp',
    'exception-occurred',
    'fault-happen',
    'config-changed',
    'unbind-succeeded',
    'on',
    'virtual-event',
  ]) {
    const kind = capability === 'on' ? 'property' : 'event';
    const signal = signalByCapability(plan, capability, kind);
    assert.equal(signal.included, false, `${capability} must not be planned as household behavior`);
    assert.ok(signal.reasonCodes.includes('configuration-or-diagnostic'));
  }

  const remoteMode = plan.signals.find(
    (signal) =>
      signal.selector.kind === 'property' &&
      signal.semantics.serviceUrn.split(':')[3] === 'switch-sensor-for-ble' &&
      signal.semantics.capabilityUrn.split(':')[3] === 'mode',
  );
  assert.equal(remoteMode.included, false);
  assert.ok(remoteMode.reasonCodes.includes('configuration-or-diagnostic'));

  for (const capability of [
    'connect-device-ids',
    'device-connect',
    'device-disconnect',
    'device-long-time-inactive',
  ]) {
    const kind = capability === 'connect-device-ids' ? 'property' : 'event';
    const signal = signalByCapability(plan, capability, kind);
    assert.equal(signal.sensitivity, 'restricted');
    assert.equal(signal.included, false);
    assert.ok(signal.reasonCodes.includes('sensitive-default-excluded'));
  }

  for (const capability of [
    'identity-id',
    'care-identity-id',
    'key-call-userid',
    'dhcp-server-mac-adress',
    'wifi-ssid',
    'credential',
    'audio-content',
    'client-identifier',
  ]) {
    const signal = signalByCapability(plan, capability);
    assert.equal(signal.sensitivity, 'restricted');
    assert.equal(signal.included, false);
  }

  for (const capability of [
    'wifi-ssid-hidden',
    'fingerprint-board-version',
    'if-set-password',
    'credential-state',
    'recording-mode',
    'client-identifier-mode',
    'device-id-state',
  ]) {
    assert.notEqual(signalByCapability(plan, capability).sensitivity, 'restricted');
  }

  const routerAggregate = signalByCapability(plan, 'connected-device-number');
  assert.equal(routerAggregate.sensitivity, 'normal');
  assert.equal(routerAggregate.included, false);
  assert.equal(routerAggregate.reasonCodes.includes('configuration-or-diagnostic'), false);

  const sensitiveOptIn = planHabitLearning({
    devices: [input(device('policy-regression'), policySpec)],
    includeSensitive: true,
  });
  for (const capability of [
    'device-connect',
    'device-disconnect',
    'device-long-time-inactive',
    'client-seen',
    'ssid-observed',
  ]) {
    const signal = signalByCapability(sensitiveOptIn, capability, 'event');
    assert.equal(signal.sensitivity, 'restricted');
    assert.equal(signal.included, false);
  }
});

test('privacy and provisioning policy uses narrow semantic matches with fail-closed restricted data', () => {
  const restrictedNames = [
    'stream-auth-token',
    'image-snapshot',
    'license-plate',
    'sim-imei',
    'sim1-imei',
    'sim2-imei',
    'ppp-username',
    'audio-id',
    'cloud-video-id',
    'lock-user-info-string',
    'app-identity',
  ];
  const sensitiveNames = [
    'abnormal-vital-signs',
    'high-heart-rate',
    'low-heart-rate',
    'low-spo2',
    'fall-asleep',
    'sleep-state-change',
    'key-call-start',
    'visitor-identify',
    'person-approaching-car-detected',
  ];
  const configurationNames = [
    'add-user-complete',
    'add-user-key-complete',
    'delete-user-complete',
    'delete-user-key-complete',
    'history-user-complete',
    'sync-user-complete',
    'sync-user-key-complete',
    'update-lock-user',
    'member-list-change',
  ];
  const ordinaryNames = [
    'abnormal-sound',
    'sleep-timer-finished',
    'visitor-mode-changed',
    'user-manual-triggered',
    'member-present',
    'record-button-pressed',
  ];
  const privacySpec = spec('privacy-adversarial', [
    service(2, 'behavior-events', {
      events: [...restrictedNames, ...sensitiveNames, ...configurationNames, ...ordinaryNames].map(
        (name, index) => event(index + 1, name, []),
      ),
    }),
  ]);
  const planInput = {
    devices: [input(device('privacy-adversarial'), privacySpec)],
  };
  const defaultPlan = planHabitLearning(planInput);
  const sensitiveOptIn = planHabitLearning({
    ...planInput,
    includeSensitive: true,
  });

  for (const capability of restrictedNames) {
    for (const plan of [defaultPlan, sensitiveOptIn]) {
      const signal = signalByCapability(plan, capability, 'event');
      assert.equal(signal.sensitivity, 'restricted', capability);
      assert.equal(signal.included, false, `${capability} must never be captured`);
      assert.ok(signal.reasonCodes.includes('sensitive-default-excluded'));
    }
  }

  for (const capability of sensitiveNames) {
    const defaultSignal = signalByCapability(defaultPlan, capability, 'event');
    assert.equal(defaultSignal.sensitivity, 'sensitive', capability);
    assert.equal(defaultSignal.included, false, `${capability} requires sensitive opt-in`);
    assert.ok(defaultSignal.reasonCodes.includes('sensitive-default-excluded'));

    const optedInSignal = signalByCapability(sensitiveOptIn, capability, 'event');
    assert.equal(optedInSignal.sensitivity, 'sensitive', capability);
    assert.equal(optedInSignal.included, true, `${capability} should honor sensitive opt-in`);
  }

  for (const capability of configurationNames) {
    for (const plan of [defaultPlan, sensitiveOptIn]) {
      const signal = signalByCapability(plan, capability, 'event');
      assert.equal(signal.included, false, `${capability} is provisioning noise`);
      assert.ok(signal.reasonCodes.includes('configuration-or-diagnostic'));
    }
  }

  for (const capability of ordinaryNames) {
    for (const plan of [defaultPlan, sensitiveOptIn]) {
      const signal = signalByCapability(plan, capability, 'event');
      assert.equal(signal.sensitivity, 'normal', `${capability} must not be broadly matched`);
      assert.equal(signal.included, true, `${capability} remains ordinary behavior`);
    }
  }
});

test('location, secret, contact, and media event arguments remain fail-closed', () => {
  const privateArguments = [
    property(1, 'latitude', [], 'double'),
    property(2, 'longitude', [], 'double'),
    property(3, 'access-token', [], 'string'),
    property(4, 'voice-url', [], 'string'),
    property(5, 'phone-number', [], 'string'),
    property(6, 'email-address', [], 'string'),
    property(7, 'token-state', [], 'uint8'),
    property(8, 'oauth-token', [], 'string'),
    property(9, 'bearer-token', [], 'string'),
    property(10, 'shared-secret', [], 'string'),
    property(11, 'content-url', [], 'string'),
    property(12, 'thumbnail-url', [], 'string'),
    property(13, 'vendor-coordinate', [], 'double', { description: '纬度' }),
    property(14, 'secret-state', [], 'uint8'),
    property(15, 'contact-state', [], 'uint8'),
    property(16, 'firmware-url', [], 'string'),
  ];
  const privateSpec = spec('private-event-arguments', [
    service(2, 'location-and-contact', {
      properties: privateArguments,
      events: [
        event(1, 'location-update', [1, 2]),
        event(2, 'authentication-updated', [3]),
        event(3, 'voice-ready', [4]),
        event(4, 'contact-updated', [5, 6]),
        event(5, 'token-state-changed', [7]),
        event(6, 'oauth-updated', [8]),
        event(7, 'bearer-updated', [9]),
        event(8, 'secret-updated', [10]),
        event(9, 'content-ready', [11]),
        event(10, 'thumbnail-ready', [12]),
        event(11, 'vendor-location-updated', [13]),
        event(12, 'secret-state-changed', [14]),
        event(13, 'contact-state-changed', [15]),
        event(14, 'asset-reference-changed', [16]),
      ],
    }),
    service(3, 'contact', {
      properties: [
        property(1, 'id', [], 'string'),
        property(2, 'name', [], 'string'),
        property(3, 'state', [], 'uint8'),
      ],
      events: [event(1, 'contact-record-changed', [1, 2]), event(2, 'contact-state-updated', [3])],
    }),
    service(4, 'media', {
      properties: [property(1, 'url', [], 'string'), property(2, 'state', [], 'uint8')],
      events: [event(1, 'media-ready', [1]), event(2, 'media-state-changed', [2])],
    }),
    service(5, 'location', {
      properties: [property(1, 'coordinate', [], 'string'), property(2, 'status', [], 'uint8')],
      events: [event(1, 'coordinates-ready', [1]), event(2, 'location-status-changed', [2])],
    }),
  ]);
  const planInput = {
    devices: [
      input(device('private-event-arguments'), privateSpec, {
        semanticCatalogFallback: true,
      }),
    ],
  };
  for (const plan of [
    planHabitLearning(planInput),
    planHabitLearning({ ...planInput, includeSensitive: true }),
  ]) {
    for (const capability of [
      'location-update',
      'authentication-updated',
      'voice-ready',
      'contact-updated',
      'oauth-updated',
      'bearer-updated',
      'secret-updated',
      'content-ready',
      'thumbnail-ready',
      'vendor-location-updated',
      'contact-record-changed',
      'media-ready',
      'coordinates-ready',
    ]) {
      const signal = signalByCapability(plan, capability, 'event');
      assert.equal(signal.sensitivity, 'restricted', capability);
      assert.equal(signal.included, false, `${capability} must never be captured`);
      assert.ok(signal.reasonCodes.includes('sensitive-default-excluded'));
    }
    for (const capability of [
      'token-state-changed',
      'secret-state-changed',
      'contact-state-changed',
      'asset-reference-changed',
      'contact-state-updated',
      'media-state-changed',
      'location-status-changed',
    ]) {
      const controlSignal = signalByCapability(plan, capability, 'event');
      assert.equal(controlSignal.sensitivity, 'normal', capability);
      assert.equal(controlSignal.included, true, capability);
    }
  }

  const zeroArgumentLocationSpec = spec('location-event', [
    service(2, 'location', {
      events: [event(1, 'location-update', []), event(2, 'location-updated', [])],
    }),
  ]);
  const defaultLocation = planHabitLearning({
    devices: [input(device('location-event'), zeroArgumentLocationSpec)],
  });
  const optedInLocation = planHabitLearning({
    devices: [input(device('location-event'), zeroArgumentLocationSpec)],
    includeSensitive: true,
  });
  for (const capability of ['location-update', 'location-updated']) {
    assert.equal(signalByCapability(defaultLocation, capability, 'event').sensitivity, 'sensitive');
    assert.equal(signalByCapability(defaultLocation, capability, 'event').included, false);
    assert.equal(signalByCapability(optedInLocation, capability, 'event').included, true);
  }
});

test('event argument semantics are canonical and participate in the plan ID', () => {
  function semanticPlan(argumentExtras) {
    const semanticSpec = spec('event-argument-semantics', [
      service(2, 'selector', {
        properties: [
          property(1, 'mode', [], 'uint8', {
            unit: 'mode-code',
            'value-range': [0, 2, 1],
            'value-list': [
              { value: 2, description: 'Away' },
              { value: 0, description: 'Home' },
            ],
            ...argumentExtras,
          }),
        ],
        events: [event(1, 'mode-selected', [1])],
      }),
    ]);
    return planHabitLearning({
      devices: [input(device('event-argument-semantics'), semanticSpec)],
    });
  }

  const baseline = semanticPlan({});
  const argument = signalByCapability(baseline, 'mode-selected', 'event').selector.arguments[0];
  assert.equal(argument.unit, 'mode-code');
  assert.deepEqual(argument.valueRange, { min: 0, max: 2, step: 1 });
  assert.deepEqual(argument.valueList, [
    { value: 0, description: 'Home' },
    { value: 2, description: 'Away' },
  ]);

  const reordered = semanticPlan({
    'value-list': [
      { value: 0, description: 'Home' },
      { value: 2, description: 'Away' },
    ],
  });
  assert.equal(reordered.planId, baseline.planId);
  assert.notEqual(semanticPlan({ unit: 'percent' }).planId, baseline.planId);
  assert.notEqual(semanticPlan({ 'value-range': [0, 4, 2] }).planId, baseline.planId);
  assert.notEqual(
    semanticPlan({
      'value-list': [
        { value: 0, description: 'At home' },
        { value: 2, description: 'Away' },
      ],
    }).planId,
    baseline.planId,
  );
});

test('signal IDs, plan IDs, ordering, and the unified graph are deterministic', () => {
  const roomOneSpec = spec('room-one', [
    service(3, 'button', {
      events: [event(2, 'double-clicked', []), event(1, 'clicked', [])],
    }),
    service(2, 'switch', {
      properties: [
        property(2, 'mode', ['read', 'notify']),
        property(1, 'on', ['read', 'notify'], 'bool'),
      ],
    }),
  ]);
  const roomTwoSpec = spec('room-two', [
    service(2, 'curtain', {
      properties: [
        property(1, 'position', ['read', 'notify']),
        property(2, 'status', ['read', 'notify']),
      ],
      events: [event(1, 'manually-opened', [])],
    }),
  ]);
  const roomOne = input(device('room-one', { roomId: '1', roomName: 'Alpha' }), roomOneSpec);
  const roomTwo = input(device('room-two', { roomId: '2', roomName: 'Beta' }), roomTwoSpec);
  const first = planHabitLearning({
    devices: [roomTwo, roomOne],
  });
  const second = planHabitLearning({
    devices: [
      {
        ...roomOne,
        spec: {
          ...roomOne.spec,
          services: [...roomOne.spec.services].reverse().map((entry) => ({
            ...entry,
            properties:
              entry.properties === undefined
                ? undefined
                : [...entry.properties].reverse().map((propertyEntry) => ({
                    ...propertyEntry,
                    access: [...propertyEntry.access].reverse(),
                  })),
            events: entry.events === undefined ? undefined : [...entry.events].reverse(),
          })),
        },
      },
      roomTwo,
    ],
  });

  assert.equal(first.planId, second.planId);
  assert.equal(first.graph.graphId, second.graph.graphId);
  assert.deepEqual(
    first.signals.map(({ signalId }) => signalId),
    second.signals.map(({ signalId }) => signalId),
  );
  const onSignal = first.signals.find(
    (signal) =>
      signal.device.did === 'room-one' &&
      signal.selector.kind === 'property' &&
      signal.selector.piid === 1,
  );
  assert.equal(
    onSignal.signalId,
    habitLearningSignalId('room-one', {
      kind: 'property',
      siid: 2,
      piid: 1,
    }),
  );
  assert.deepEqual(
    first.graph.signalIds,
    first.signals.filter((signal) => signal.included).map((signal) => signal.signalId),
  );
  assert.equal(first.graph.automaticPartitioning, false);
});

test('general context is explicitly enabled while occupancy illumination stays a default exception', () => {
  const contextSpec = spec('context', [
    service(2, 'environment', {
      properties: [
        property(1, 'temperature', ['read', 'notify'], 'float'),
        property(2, 'relative-humidity', ['read', 'notify'], 'float'),
      ],
    }),
  ]);
  const defaultPlan = planHabitLearning({
    devices: [input(device('context'), contextSpec)],
  });
  const includedPlan = planHabitLearning({
    devices: [input(device('context'), contextSpec)],
    includeContext: true,
  });

  assert.equal(defaultPlan.coverage.contextSignals, 0);
  assert.equal(includedPlan.coverage.contextSignals, 2);
  assert.ok(
    defaultPlan.signals.every((signal) => signal.reasonCodes.includes('context-default-deferred')),
  );
});
