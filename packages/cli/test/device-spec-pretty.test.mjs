import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { prepareDeviceSpecOutput } from '../dist/device-spec-output.js';
import {
  DEVICE_SPEC_PRETTY_MAX_LINE_WIDTH,
  renderDeviceSpecPretty,
} from '../dist/device-spec-pretty.js';

const serviceUrn = 'urn:miot-spec-v2:service:light:00007802:vendor-model:1';
const longEnumDescription = 'A deliberately long enum label that must wrap without being truncated';

const power = {
  siid: 2,
  piid: 1,
  sUrn: serviceUrn,
  urn: 'urn:miot-spec-v2:property:on:00000006:vendor-model:1',
  sDescription: 'Semantic light',
  description: 'Semantic power',
  format: 'bool',
  dtype: 'boolean',
  access: ['read', 'write', 'notify'],
  proprietary: false,
  valueList: [
    { value: true, description: '开启' },
    { value: false, description: '关闭' },
  ],
};

const modeA = {
  siid: 2,
  piid: 2,
  sUrn: serviceUrn,
  urn: 'urn:miot-spec-v2:property:mode:00000008:vendor-model:1',
  sDescription: 'Semantic light',
  description: 'Semantic mode A',
  format: 'float',
  dtype: 'int',
  access: ['read', 'write', 'notify'],
  proprietary: false,
  valueList: [
    { value: 0, description: '关闭' },
    { value: 1, description: longEnumDescription },
  ],
};

const brightness = {
  siid: 2,
  piid: 3,
  sUrn: serviceUrn,
  urn: 'urn:miot-spec-v2:property:brightness:00000005:vendor-model:1',
  sDescription: 'Semantic light',
  description: 'Semantic brightness',
  format: 'uint8',
  dtype: 'int',
  access: ['read', 'write'],
  proprietary: false,
  rawUnit: 'percentage',
  unit: '%',
  valueRange: { min: 1, max: 100, step: 1 },
};

const modeB = {
  siid: 2,
  piid: 4,
  sUrn: serviceUrn,
  urn: 'urn:miot-spec-v2:property:mode:00009999:vendor-model:1',
  sDescription: 'Semantic light',
  description: 'Semantic mode B',
  format: 'string',
  dtype: 'string',
  access: ['read'],
  proprietary: false,
};

const vendorProperty = {
  siid: 2,
  piid: 5,
  sUrn: serviceUrn,
  urn: 'urn:vendor-spec:property:secret-mode:00000001:vendor-model:1',
  sDescription: 'Semantic light',
  description: 'Vendor secret mode',
  format: 'int',
  dtype: 'int',
  access: ['read'],
  proprietary: true,
};

const secondPower = {
  ...power,
  siid: 3,
  sUrn: 'urn:miot-spec-v2:service:switch:0000780C:vendor-model:1',
  sDescription: 'Second switch',
  description: 'Second power',
  access: ['read'],
};

const projection = {
  urn: 'urn:miot-spec-v2:device:test-device:0000A001:vendor-model:1',
  description: 'Test device',
  deviceType: 'test-device',
  deviceTypeDescription: '测试设备品类',
  locale: 'zh_cn',
  propertyNotify: [power, modeA],
  propertyGet: [power, modeA, brightness, modeB, vendorProperty, secondPower],
  propertySet: [power, modeA, brightness],
  events: [
    {
      siid: 2,
      eiid: 1,
      sUrn: serviceUrn,
      urn: 'urn:miot-spec-v2:event:mode-changed:00005001:vendor-model:1',
      sDescription: 'Semantic light',
      description: 'Semantic mode changed',
      proprietary: false,
      arguments: [
        { resolved: true, piid: 2, property: modeA },
        { resolved: true, piid: 4, property: modeB },
        { resolved: false, piid: 99 },
      ],
    },
  ],
  actions: [
    {
      siid: 2,
      aiid: 1,
      sUrn: serviceUrn,
      urn: 'urn:miot-spec-v2:action:set-mode:00002801:vendor-model:1',
      sDescription: 'Semantic light',
      description: 'Semantic set mode',
      proprietary: false,
      inputs: [
        { resolved: true, piid: 2, property: modeA },
        { resolved: true, piid: 4, property: modeB },
        { resolved: false, piid: 99 },
      ],
      outMetadata: [{ resolved: true, piid: 3, property: brightness, bindable: false }],
    },
    {
      siid: 4,
      aiid: 1,
      sUrn: 'urn:vendor-spec:service:private-service:000078FF:vendor-model:1',
      urn: 'urn:vendor-spec:action:private-action:000028FF:vendor-model:1',
      sDescription: 'Private service',
      description: 'Private action',
      proprietary: true,
      inputs: [],
      outMetadata: [],
    },
  ],
  excludedServices: [
    {
      siid: 1,
      urn: 'urn:miot-spec-v2:service:device-information:00007801:vendor-model:1',
      description: 'Device information',
      reason: 'device-information-not-automatable',
    },
  ],
  catalogs: [
    { catalog: 'multi-language', status: 'fallback', reason: 'http', httpStatus: 503 },
    { catalog: 'property-value-normalization', status: 'loaded' },
    { catalog: 'service-template', status: 'loaded' },
    { catalog: 'property-template', status: 'loaded' },
    { catalog: 'event-template', status: 'loaded' },
    { catalog: 'action-template', status: 'loaded' },
    { catalog: 'device-template', status: 'loaded' },
  ],
};

test('pretty view maps capabilities to automation purpose and node types', () => {
  const output = renderDeviceSpecPretty(projection);

  assert.match(
    output,
    /Automation purpose: event\/state updates\n {2}Rule nodes: deviceInput, deviceInputSetVar/,
  );
  assert.match(
    output,
    /Automation purpose: current-state query\n {2}Rule nodes: deviceGet, deviceGetSetVar/,
  );
  assert.match(output, /Automation purpose: write\/action execution\n {2}Rule nodes: deviceOutput/);
  assert.match(output, /Notify properties:/);
  assert.match(output, /Readable properties:/);
  assert.match(output, /Writable properties:/);
  assert.match(output, /Standard capabilities/);
  assert.match(output, /Proprietary\/vendor capabilities/);
  assert.match(output, /secret-mode/);
  assert.match(output, /private-action/);
  assert.match(output, /Excluded from automation:/);
  assert.match(output, /^Device type: test-device$/m);
  assert.match(output, /^Device type description: 测试设备品类$/m);
  assert.match(output, /device-template=loaded/);
  assert.equal((output.match(/selector=device-information/g) ?? []).length, 1);
});

test('pretty view reports semantic fallback and preserves typed domains and resolved references', () => {
  const output = renderDeviceSpecPretty(projection);

  assert.match(output, /values=multiLanguage -> normalization -> raw/);
  assert.match(output, /action=multiLanguage -> raw -> template/);
  assert.match(output, /action-input=multiLanguage -> raw/);
  assert.match(output, /multi-language=fallback\(http:503\)/);
  assert.match(output, /Raw instance labels are retained/);
  assert.match(output, /format=float dtype=int/);
  assert.match(output, /enum\[0="关闭", 1=/);
  assert.match(output, new RegExp(longEnumDescription));
  assert.match(output, /range\[1\.\.100 step 1\]/);
  assert.match(output, /unit: % \(raw=percentage\)/);
  assert.match(output, /\[0\] piid=2 selector=mode/);
  assert.match(output, /\[1\] piid=4 selector=mode/);
  assert.match(output, /\[2\] piid=99 unresolved/);
  assert.equal((output.match(/- \[0\] piid=2 selector=mode/g) ?? []).length, 2);
  assert.equal((output.match(/- \[1\] piid=4 selector=mode/g) ?? []).length, 2);
});

test('action.out is labeled as unbindable MIoT metadata, not a graph output', () => {
  const output = renderDeviceSpecPretty(projection);

  assert.match(output, /MIoT action\.out metadata \(not bindable; no rule-graph output pin\):/);
  assert.match(output, /\[0\] piid=3 selector=brightness/);
  assert.doesNotMatch(output, /\boutputs:/);
});

test('duplicate short names remain visible and output lines stay bounded', () => {
  const output = renderDeviceSpecPretty(projection);

  assert.ok((output.match(/piid=1 selector=on/g) ?? []).length >= 2);
  assert.ok(
    output.split('\n').every((line) => stringWidth(line) <= DEVICE_SPEC_PRETTY_MAX_LINE_WIDTH),
    `output exceeded ${DEVICE_SPEC_PRETTY_MAX_LINE_WIDTH} columns`,
  );
});

test('wide semantic labels wrap by grapheme and terminal display width', () => {
  const family = '👨‍👩‍👧‍👦';
  const combining = 'é';
  const longUrn = `urn:miot-spec-v2:device:${'long-segment'.repeat(18)}:0000A001:vendor-model:1`;
  const wideProjection = structuredClone(projection);
  wideProjection.urn = longUrn;
  wideProjection.description = `${'中文设备'.repeat(35)}${family}${combining}`;
  wideProjection.deviceType = 'long-device-type-token'.repeat(10);
  wideProjection.deviceTypeDescription = `${'中文品类'.repeat(35)}${family}${combining}`;
  wideProjection.propertyGet[0].description = `${'组合标签'.repeat(30)}${family}${combining}`;

  const output = renderDeviceSpecPretty(wideProjection);
  assert.ok(
    output.split('\n').every((line) => stringWidth(line) <= DEVICE_SPEC_PRETTY_MAX_LINE_WIDTH),
    `wide output exceeded ${DEVICE_SPEC_PRETTY_MAX_LINE_WIDTH} terminal columns`,
  );
  assert.ok(output.includes(family), 'emoji ZWJ grapheme must remain intact');
  assert.ok(output.includes(combining), 'combining-mark grapheme must remain intact');
  assert.ok(output.replace(/\s/g, '').includes(longUrn), 'long URN must wrap without truncation');
  assert.ok(
    output.replace(/\s/g, '').includes(wideProjection.deviceType),
    'stable device type must wrap without truncation',
  );
  assert.ok(
    output.replace(/\s/g, '').includes(wideProjection.deviceTypeDescription.replace(/\s/g, '')),
    'device type description must wrap without truncation',
  );
});

test('default JSON preparation keeps the raw envelope and performs no semantic request', async () => {
  const raw = {
    type: projection.urn,
    description: projection.description,
    services: [],
  };
  let semanticCalls = 0;
  const projector = async () => {
    semanticCalls += 1;
    return projection;
  };

  const json = await prepareDeviceSpecOutput(raw, false, 123, projector);
  assert.deepEqual(json, { format: 'json', payload: { ok: true, spec: raw } });
  assert.equal(json.payload.spec, raw, 'the default output keeps the exact raw spec object');
  assert.equal(semanticCalls, 0, 'the default JSON path must not fetch semantic catalogs');

  const pretty = await prepareDeviceSpecOutput(raw, true, 123, projector);
  assert.equal(pretty.format, 'pretty');
  assert.equal(semanticCalls, 1);
  assert.match(pretty.text, /Automation purpose: event\/state updates/);
});
