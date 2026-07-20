import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError } from '@eyaeya/xgg-core';
import {
  NODE_ADD_AUTHORING_OPTION_ATTRIBUTES,
  assertNodeAddAuthoringFlagUsage,
} from '../dist/commands/rule/node-add-authoring-flags.js';
import { buildProgram } from '../dist/program.js';

const AUTHORING_FIELDS = [
  'cfg',
  'id',
  'deviceDid',
  'deviceSiid',
  'deviceProperty',
  'deviceAction',
  'deviceEvent',
  'eventFilter',
  'eventFilterInclude',
  'eventFilterBetween',
  'eventArgVar',
  'threshold',
  'propertyValue',
  'propertyInclude',
  'op',
  'params',
  'value',
  'forceOutOfRange',
  'allowNoPush',
  'preload',
  'pos',
  'simplified',
  'text',
  'delta',
  'background',
  'inputs',
  'duration',
  'interval',
  'start',
  'end',
  'mingTextShow',
  'weekdayOnly',
  'holidayOnly',
  'days',
  'varScope',
  'varId',
  'varType',
  'varValue',
  'threshold2',
  'allowUnknownScope',
  'at',
  'sunrise',
  'sunset',
  'offsetMin',
  'latitude',
  'longitude',
  'expr',
  'defaultExprScope',
  'outputs',
];

const OPERATIONAL_FIELDS = [
  'ruleId',
  'type',
  'snapshot',
  'validate',
  'varCheck',
  'snapshotsDir',
  'baseUrl',
  'sessionFile',
  'timeout',
  'pretty',
  'refreshHint',
  'nextHint',
];

const EXECUTABLE = ['id', 'pos', 'simplified'];
const DEVICE = [...EXECUTABLE, 'deviceDid', 'deviceSiid'];
const PROPERTY_COMPARISON = [
  'deviceProperty',
  'op',
  'threshold',
  'threshold2',
  'propertyValue',
  'propertyInclude',
  'forceOutOfRange',
];
const DAY_FILTER = ['weekdayOnly', 'holidayOnly', 'days'];
const VARIABLE_TARGET = ['varScope', 'varId', 'allowUnknownScope'];

const ROUTES = [
  {
    label: 'deviceInput/property',
    base: { type: 'deviceInput', deviceDid: 'did', deviceProperty: 'temperature' },
    allowed: [...DEVICE, ...PROPERTY_COMPARISON, 'allowNoPush', 'preload'],
  },
  {
    label: 'deviceInput/event',
    base: { type: 'deviceInput', deviceDid: 'did', deviceEvent: 'changed' },
    allowed: [...DEVICE, 'deviceEvent', 'eventFilter', 'eventFilterInclude', 'eventFilterBetween'],
  },
  {
    label: 'deviceGet/property',
    base: { type: 'deviceGet', deviceDid: 'did', deviceProperty: 'temperature' },
    allowed: [...DEVICE, ...PROPERTY_COMPARISON],
  },
  {
    label: 'deviceOutput/action',
    base: { type: 'deviceOutput', deviceDid: 'did', deviceAction: 'toggle' },
    allowed: [...DEVICE, 'deviceAction', 'params', 'allowUnknownScope'],
  },
  {
    label: 'deviceOutput/property',
    base: { type: 'deviceOutput', deviceDid: 'did', deviceProperty: 'on' },
    allowed: [...DEVICE, 'deviceProperty', 'value', 'allowUnknownScope'],
  },
  {
    label: 'deviceInputSetVar/property',
    base: { type: 'deviceInputSetVar', deviceDid: 'did', deviceProperty: 'temperature' },
    allowed: [...DEVICE, 'deviceProperty', ...VARIABLE_TARGET, 'preload'],
  },
  {
    label: 'deviceInputSetVar/event',
    base: { type: 'deviceInputSetVar', deviceDid: 'did', deviceEvent: 'changed' },
    allowed: [...DEVICE, 'deviceEvent', 'eventArgVar', ...VARIABLE_TARGET],
  },
  {
    label: 'deviceGetSetVar/property',
    base: { type: 'deviceGetSetVar', deviceDid: 'did', deviceProperty: 'temperature' },
    allowed: [...DEVICE, 'deviceProperty', ...VARIABLE_TARGET],
  },
  {
    label: 'alarmClock/periodic',
    base: { type: 'alarmClock', at: '07:00' },
    allowed: [...EXECUTABLE, 'at', ...DAY_FILTER],
  },
  {
    label: 'alarmClock/solar',
    base: { type: 'alarmClock', latitude: 30, longitude: 114 },
    allowed: [
      ...EXECUTABLE,
      'sunrise',
      'sunset',
      'offsetMin',
      'latitude',
      'longitude',
      ...DAY_FILTER,
    ],
  },
  {
    label: 'timeRange',
    base: { type: 'timeRange', start: '08:00', end: '22:00' },
    allowed: [...EXECUTABLE, 'start', 'end', 'mingTextShow', ...DAY_FILTER],
  },
  { label: 'delay', base: { type: 'delay', duration: '5s' }, allowed: [...EXECUTABLE, 'duration'] },
  {
    label: 'statusLast',
    base: { type: 'statusLast', duration: '5s' },
    allowed: [...EXECUTABLE, 'duration'],
  },
  { label: 'condition', base: { type: 'condition' }, allowed: EXECUTABLE },
  { label: 'loop', base: { type: 'loop', interval: '5s' }, allowed: [...EXECUTABLE, 'interval'] },
  {
    label: 'onlyNTimes',
    base: { type: 'onlyNTimes', threshold: 2 },
    allowed: [...EXECUTABLE, 'threshold'],
  },
  {
    label: 'counter',
    base: { type: 'counter', threshold: 2 },
    allowed: [...EXECUTABLE, 'threshold'],
  },
  { label: 'signalOr', base: { type: 'signalOr' }, allowed: [...EXECUTABLE, 'inputs'] },
  { label: 'logicOr', base: { type: 'logicOr' }, allowed: [...EXECUTABLE, 'inputs'] },
  { label: 'logicAnd', base: { type: 'logicAnd' }, allowed: [...EXECUTABLE, 'inputs'] },
  { label: 'logicNot', base: { type: 'logicNot' }, allowed: EXECUTABLE },
  { label: 'onLoad', base: { type: 'onLoad' }, allowed: EXECUTABLE },
  { label: 'register', base: { type: 'register' }, allowed: EXECUTABLE },
  {
    label: 'eventSequence',
    base: { type: 'eventSequence', duration: '5s' },
    allowed: [...EXECUTABLE, 'duration'],
  },
  { label: 'modeSwitch', base: { type: 'modeSwitch' }, allowed: [...EXECUTABLE, 'outputs'] },
  {
    label: 'varChange/number',
    base: { type: 'varChange', varType: 'number' },
    allowed: [
      ...EXECUTABLE,
      ...VARIABLE_TARGET,
      'varType',
      'op',
      'threshold',
      'threshold2',
      'preload',
    ],
  },
  {
    label: 'varChange/string',
    base: { type: 'varChange', varType: 'string' },
    allowed: [...EXECUTABLE, ...VARIABLE_TARGET, 'varType', 'op', 'varValue', 'preload'],
  },
  {
    label: 'varGet/number',
    base: { type: 'varGet', varType: 'number' },
    allowed: [...EXECUTABLE, ...VARIABLE_TARGET, 'varType', 'op', 'threshold', 'threshold2'],
  },
  {
    label: 'varGet/string',
    base: { type: 'varGet', varType: 'string' },
    allowed: [...EXECUTABLE, ...VARIABLE_TARGET, 'varType', 'op', 'varValue'],
  },
  {
    label: 'varSetNumber',
    base: { type: 'varSetNumber' },
    allowed: [...EXECUTABLE, ...VARIABLE_TARGET, 'expr', 'defaultExprScope'],
  },
  {
    label: 'varSetString',
    base: { type: 'varSetString' },
    allowed: [...EXECUTABLE, ...VARIABLE_TARGET, 'expr', 'defaultExprScope'],
  },
  {
    label: 'nop',
    base: { type: 'nop' },
    allowed: ['id', 'pos', 'text', 'delta', 'background'],
  },
];

const SENTINEL = {
  cfg: '{}',
  id: 'node-id',
  deviceDid: 'did',
  deviceSiid: 2,
  deviceProperty: 'temperature',
  deviceAction: 'toggle',
  deviceEvent: 'changed',
  eventFilter: ['1=1'],
  eventFilterInclude: ['1=1,2'],
  eventFilterBetween: ['1=1,2'],
  eventArgVar: ['1=global.value'],
  threshold: { literal: '1', value: 1 },
  propertyValue: 'open',
  propertyInclude: [1],
  op: 'eq',
  params: '{}',
  value: '1',
  forceOutOfRange: true,
  allowNoPush: true,
  preload: false,
  pos: { x: 1, y: 2, width: 3, height: 4 },
  simplified: false,
  text: 'note',
  delta: '[]',
  background: '#fff',
  inputs: 2,
  duration: '5s',
  interval: '5s',
  start: '08:00',
  end: '22:00',
  mingTextShow: false,
  weekdayOnly: true,
  holidayOnly: true,
  days: [1],
  varScope: 'global',
  varId: 'value',
  varType: 'number',
  varValue: 'open',
  threshold2: { literal: '2', value: 2 },
  allowUnknownScope: true,
  at: '07:00',
  sunrise: true,
  sunset: true,
  offsetMin: -10,
  latitude: 30,
  longitude: 114,
  expr: '$global.value',
  defaultExprScope: 'global',
  outputs: 2,
};

function nodeAddCommand(program) {
  const rule = program.commands.find((command) => command.name() === 'rule');
  const node = rule?.commands.find((command) => command.name() === 'node');
  return node?.commands.find((command) => command.name() === 'add');
}

test('Commander node-add options stay partitioned into authoring and operational fields', () => {
  assert.deepEqual([...NODE_ADD_AUTHORING_OPTION_ATTRIBUTES].sort(), [...AUTHORING_FIELDS].sort());

  const add = nodeAddCommand(buildProgram());
  assert.ok(add);
  const registered = [...new Set(add.options.map((option) => option.attributeName()))].sort();
  assert.deepEqual(registered, [...AUTHORING_FIELDS, ...OPERATIONAL_FIELDS].sort());
});

test('all 32 modeled shortcut routes accept exactly their consumed authoring fields', () => {
  assert.equal(ROUTES.length, 32);
  for (const route of ROUTES) {
    const accepted = new Set(route.allowed);
    for (const field of AUTHORING_FIELDS) {
      // --cfg selects the independent raw route; it is tested below rather
      // than treated as a flag on every shortcut route.
      if (field === 'cfg') continue;
      const candidate = {
        ...route.base,
        [field]: Object.hasOwn(route.base, field) ? route.base[field] : SENTINEL[field],
      };
      if (accepted.has(field)) {
        assert.doesNotThrow(
          () => assertNodeAddAuthoringFlagUsage(candidate),
          `${route.label} should consume ${field}`,
        );
      } else {
        assert.throws(
          () => assertNodeAddAuthoringFlagUsage(candidate),
          (error) => error instanceof ConfigError,
          `${route.label} must reject ${field}`,
        );
      }
    }
  }
});

test('raw routes accept only cfg/id and empty repeatable defaults are not supplied flags', () => {
  for (const type of ['futureNode', 'onLoad', 'deviceOutput', 'nop']) {
    assert.doesNotThrow(() =>
      assertNodeAddAuthoringFlagUsage({
        type,
        cfg: '{}',
        id: 'raw-id',
        eventFilter: [],
        eventFilterInclude: [],
        eventFilterBetween: [],
        eventArgVar: [],
      }),
    );
    for (const field of AUTHORING_FIELDS.filter(
      (candidate) => candidate !== 'cfg' && candidate !== 'id',
    )) {
      assert.throws(
        () =>
          assertNodeAddAuthoringFlagUsage({
            type,
            cfg: '{}',
            [field]: SENTINEL[field],
          }),
        (error) => error instanceof ConfigError,
        `${type} raw must reject ${field}`,
      );
    }
  }
});

test('explicit false is supplied while operational fields never enter card allowlists', () => {
  assert.throws(
    () => assertNodeAddAuthoringFlagUsage({ type: 'onLoad', preload: false }),
    (error) => error instanceof ConfigError && /--preload/.test(error.message),
  );
  assert.doesNotThrow(() =>
    assertNodeAddAuthoringFlagUsage({
      type: 'onLoad',
      id: 'load',
      pos: { x: 1, y: 2, width: 200, height: 120 },
      simplified: false,
      ruleId: 'rule',
      snapshot: false,
      validate: false,
      varCheck: false,
      snapshotsDir: '/unused',
      baseUrl: 'http://unused',
      sessionFile: '/unused',
      timeout: '1000',
      pretty: true,
      refreshHint: false,
      nextHint: false,
    }),
  );
});

test('mode mutex errors are local, actionable, and never echo option values', () => {
  const secret = 'issue163-secret-value';
  const cases = [
    {
      opts: {
        type: 'deviceOutput',
        deviceAction: 'toggle',
        params: secret,
        deviceProperty: 'on',
        value: secret,
      },
      message: /action mode.*property mode.*mutually exclusive/,
    },
    {
      opts: {
        type: 'deviceInputSetVar',
        deviceProperty: 'temperature',
        deviceEvent: 'changed',
      },
      message: /cannot mix --device-property with --device-event/,
    },
    {
      opts: {
        type: 'deviceInputSetVar',
        deviceEvent: 'changed',
        eventArgVar: [`1=global.${secret}`],
        varScope: 'global',
      },
      message: /cannot mix --event-arg-var with --var-scope\/--var-id/,
    },
    {
      opts: { type: 'deviceOutput', params: secret },
      message: /--params requires --device-action/,
    },
    {
      opts: { type: 'deviceOutput', value: secret },
      message: /--value requires --device-property/,
    },
    {
      opts: { type: 'alarmClock', at: '07:00', sunrise: true },
      message: /trigger options are mutually exclusive/,
    },
    {
      opts: { type: 'timeRange', weekdayOnly: true, days: [1] },
      message: /day filters are mutually exclusive/,
    },
  ];

  for (const { opts, message } of cases) {
    assert.throws(
      () => assertNodeAddAuthoringFlagUsage(opts),
      (error) =>
        error instanceof ConfigError &&
        message.test(error.message) &&
        !error.message.includes(secret),
    );
  }
});
