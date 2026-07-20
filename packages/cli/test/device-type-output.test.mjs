import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import {
  DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH,
  prepareDeviceTypeProjection,
  renderDeviceGetPretty,
  renderDeviceListPretty,
} from '../dist/device-type-output.js';

const urn = 'urn:miot-spec-v2:device:light:0000A001:test-model:1';
const secondUrn = 'urn:miot-spec-v2:device:sensor:0000A077:test-sensor:1';

function projection(status = { catalog: 'device-template', status: 'loaded' }) {
  return {
    locale: 'zh_cn',
    deviceTypes: [
      { urn, deviceType: 'light', deviceTypeDescription: '灯' },
      { urn: secondUrn, deviceType: 'sensor', deviceTypeDescription: '传感器' },
    ],
    catalogs: [status],
  };
}

test('default device type preparation preserves the raw path and performs no semantic request', async () => {
  const devices = [{ urn }, { urn: secondUrn }];
  let calls = 0;
  const projector = async () => {
    calls += 1;
    return projection();
  };

  const result = await prepareDeviceTypeProjection(devices, false, 123, projector);
  assert.equal(result, undefined);
  assert.equal(calls, 0);
  assert.deepEqual(devices, [{ urn }, { urn: secondUrn }]);
});

test('one pretty inventory projection batches every device into one catalog load', async () => {
  const calls = [];
  const projector = async (urns, options) => {
    calls.push({ urns, options });
    return projection();
  };
  const devices = [{ urn }, { urn: secondUrn }];

  const result = await prepareDeviceTypeProjection(devices, true, 321, projector);
  assert.deepEqual(result, projection());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { urns: [urn, secondUrn], options: { timeoutMs: 321 } });
});

test('list and get pretty views show the same stable token and Chinese description', () => {
  const semantic = projection();
  const rows = [
    {
      id: 'device-id-1',
      name: '客厅灯',
      model: 'test.light.v1',
      roomName: '客厅',
      urn,
      availability: '● full',
    },
    {
      id: 'device-id-2',
      name: '门磁',
      model: 'test.sensor.v1',
      roomName: '门厅',
      urn: secondUrn,
      availability: '◐ partial',
    },
  ];

  const list = renderDeviceListPretty(rows, semantic);
  const get = renderDeviceGetPretty(
    {
      urn,
      name: '客厅灯',
      modelName: '产品实例名称（不得作为品类回退）',
      description: '实例描述（不得作为品类回退）',
    },
    { ...semantic, deviceTypes: [semantic.deviceTypes[0]] },
  );

  assert.match(list, /deviceType/);
  assert.match(list, /deviceTypeDescription/);
  assert.match(list, /light/);
  assert.match(list, /灯/);
  assert.match(list, /sensor/);
  assert.match(list, /传感器/);
  assert.match(get, /^Device type: light$/m);
  assert.match(get, /^Device type description: 灯$/m);
  assert.match(list, /^Catalog status: device-template=loaded$/m);
  assert.match(get, /^Catalog status: device-template=loaded$/m);
  assert.ok(
    list.split('\n').every((line) => stringWidth(line) <= DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH),
  );
  assert.ok(
    get.split('\n').every((line) => stringWidth(line) <= DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH),
  );
});

test('pretty views keep fallback explicit and wrap long graphemes without truncating semantics', () => {
  const family = '👨‍👩‍👧‍👦';
  const combining = 'é';
  const longToken = `long-${'device-type-'.repeat(14)}token`;
  const longDescription = `${'超长中文品类'.repeat(24)}${family}${combining}`;
  const longUrn = `urn:miot-spec-v2:device:${longToken}:0000A001:test:1`;
  const semantic = {
    locale: 'zh_cn',
    deviceTypes: [
      {
        urn: longUrn,
        deviceType: longToken,
        deviceTypeDescription: longDescription,
      },
    ],
    catalogs: [{ catalog: 'device-template', status: 'fallback', reason: 'http', httpStatus: 503 }],
  };
  const output = renderDeviceGetPretty(
    { urn: longUrn, name: `${'超长设备名'.repeat(20)}${family}${combining}` },
    semantic,
  );
  const list = renderDeviceListPretty(
    [
      {
        id: `device-${'identifier-'.repeat(8)}`,
        name: `${'超长设备名'.repeat(20)}${family}${combining}`,
        model: `model.${'segment.'.repeat(10)}`,
        roomName: `${'长房间'.repeat(10)}`,
        urn: longUrn,
        availability: '● full',
      },
    ],
    semantic,
  );

  assert.match(output, /device-template=fallback\(http:503\)/);
  assert.ok(output.includes(family));
  assert.ok(output.includes(combining));
  assert.ok(output.replace(/\s/g, '').includes(longToken));
  assert.ok(output.replace(/\s/g, '').includes(longDescription.replace(/\s/g, '')));
  assert.ok(
    output.split('\n').every((line) => stringWidth(line) <= DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH),
  );
  assert.match(list, /device-template=fallback\(http:503\)/);
  assert.doesNotMatch(list, /…/, 'list cells wrap explicitly instead of truncating semantics');
  assert.ok(list.includes(family));
  assert.ok(list.includes(combining));
  assert.ok(
    list.split('\n').every((line) => stringWidth(line) <= DEVICE_TYPE_PRETTY_MAX_LINE_WIDTH),
  );
});
