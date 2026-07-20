import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeviceSpecSemanticCache,
  projectDeviceSpecSemantics,
  projectDeviceTypesSemantics,
} from '../dist/index.js';

const rawSpec = {
  type: 'urn:miot-spec-v2:device:test-light:0000A001:vendor-model:1',
  description: 'Raw test light',
  services: [
    {
      iid: 1,
      type: 'urn:miot-spec-v2:service:device-information:00007801:vendor-model:1',
      description: 'Raw device information',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:manufacturer:00000001:vendor-model:1',
          description: 'Raw manufacturer',
          format: 'string',
          access: ['read'],
        },
      ],
    },
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:light:00007802:vendor-model:1',
      description: 'Raw light service',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:on:00000006:vendor-model:1',
          description: 'Raw power',
          format: 'bool',
          access: ['read', 'write', 'notify'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:mode:00000008:vendor-model:1',
          description: 'Raw mode',
          format: 'float',
          access: ['read', 'notify'],
          'value-list': [
            { value: 0, description: 'raw-off' },
            { value: 1, description: 'raw-eco' },
          ],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:brightness:00000005:vendor-model:1',
          description: 'Raw brightness',
          format: 'uint8',
          access: ['read', 'write'],
          unit: 'percentage',
          'value-range': [1, 100, 1],
        },
        {
          iid: 4,
          type: 'urn:vendor-spec:property:secret-mode:00000001:vendor-model:1',
          description: 'Raw vendor property',
          format: 'int',
          access: ['read', 'write'],
        },
      ],
      events: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:event:mode-changed:00005001:vendor-model:1',
          description: 'Raw mode event',
          arguments: [2, 99],
        },
      ],
      actions: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:action:set-mode:00002801:vendor-model:1',
          description: 'Raw set mode',
          in: [2, 99],
          out: [3],
        },
      ],
    },
  ],
};

const catalogBodies = {
  multi: {
    data: {
      zh_cn: {
        'service:2': '多语灯服务',
        'service:2:property:1': '多语电源',
        'service:2:event:1': '多语模式事件',
        'service:2:property:2:value:0': '多语关闭',
      },
    },
  },
  normalization: {
    result: [
      {
        urn: 'urn:miot-spec-v2:service:light:00007802',
        proName: 'mode',
        normalization: 'raw-off',
        description: '归一关闭',
      },
      {
        urn: 'urn:miot-spec-v2:service:light:00007802',
        proName: 'mode',
        normalization: 'raw-eco',
        description: '归一节能',
      },
    ],
  },
  services: {
    result: [
      {
        type: 'urn:miot-spec-v2:service:light:00007802',
        description: { zh_cn: '模板灯服务' },
      },
    ],
  },
  properties: {
    result: [
      {
        type: 'urn:miot-spec-v2:property:on:00000006',
        description: { zh_cn: '模板电源' },
      },
      {
        type: 'urn:miot-spec-v2:property:mode:00000008',
        description: { zh_cn: '模板模式' },
      },
      {
        type: 'urn:miot-spec-v2:property:brightness:00000005',
        description: { zh_cn: '模板亮度' },
      },
    ],
  },
  events: {
    result: [
      {
        type: 'urn:miot-spec-v2:event:mode-changed:00005001',
        description: { zh_cn: '模板模式事件' },
      },
    ],
  },
  actions: {
    result: [
      {
        type: 'urn:miot-spec-v2:action:set-mode:00002801',
        description: { zh_cn: '模板设置模式' },
      },
    ],
  },
  devices: {
    result: [
      {
        type: 'urn:miot-spec-v2:device:test-light:0000A001',
        description: { zh_cn: '测试灯品类' },
      },
    ],
  },
};

function catalogKey(url) {
  if (url.includes('/multiLanguage')) return 'multi';
  if (url.includes('/normalization/list/property_value')) return 'normalization';
  if (url.endsWith('/template/list/service')) return 'services';
  if (url.endsWith('/template/list/property')) return 'properties';
  if (url.endsWith('/template/list/event')) return 'events';
  if (url.endsWith('/template/list/action')) return 'actions';
  if (url.endsWith('/template/list/device')) return 'devices';
  throw new Error(`unexpected catalog URL: ${url}`);
}

function successfulCatalogFetch(counter = { count: 0 }) {
  return async (input) => {
    counter.count += 1;
    const body = catalogBodies[catalogKey(String(input))];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('semantic projection applies precedence, automation access classes, and exclusions', async () => {
  const before = structuredClone(rawSpec);
  const projection = await projectDeviceSpecSemantics(rawSpec, {
    fetch: successfulCatalogFetch(),
    cache: new DeviceSpecSemanticCache(),
  });

  assert.deepEqual(rawSpec, before, 'semantic projection must not mutate the raw spec');
  assert.deepEqual(
    projection.catalogs.map(({ catalog, status }) => [catalog, status]),
    [
      ['multi-language', 'loaded'],
      ['property-value-normalization', 'loaded'],
      ['service-template', 'loaded'],
      ['property-template', 'loaded'],
      ['event-template', 'loaded'],
      ['action-template', 'loaded'],
      ['device-template', 'loaded'],
    ],
  );
  assert.equal(projection.deviceType, 'test-light');
  assert.equal(projection.deviceTypeDescription, '测试灯品类');
  assert.deepEqual(
    projection.excludedServices.map(({ siid, reason }) => [siid, reason]),
    [[1, 'device-information-not-automatable']],
  );
  assert.deepEqual(
    projection.propertyNotify.map(({ piid }) => piid),
    [1, 2],
  );
  assert.deepEqual(
    projection.propertyGet.map(({ piid }) => piid),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    projection.propertySet.map(({ piid }) => piid),
    [1, 3, 4],
  );

  const power = projection.propertyNotify[0];
  assert.equal(power.sDescription, '多语灯服务', 'multiLanguage wins over service template');
  assert.equal(power.description, '多语电源', 'multiLanguage wins over property template');
  assert.deepEqual(power.valueList, [
    { value: true, description: '开启' },
    { value: false, description: '关闭' },
  ]);

  const mode = projection.propertyNotify[1];
  assert.equal(mode.description, '模板模式', 'template wins over raw property label');
  assert.equal(mode.dtype, 'int', 'float value-list follows the production enum dtype');
  assert.deepEqual(mode.valueList, [
    { value: 0, description: '多语关闭' },
    { value: 1, description: '归一节能' },
  ]);
  assert.equal(projection.propertyGet[2].description, '模板亮度');
  assert.equal(projection.propertyGet[2].unit, '%');
  assert.equal(projection.propertyGet[3].description, 'Raw vendor property');
  assert.equal(projection.propertyGet[3].proprietary, true);
  assert.equal(projection.events[0].description, '多语模式事件');
  assert.equal(projection.events[0].arguments[0].resolved, true);
  assert.equal(
    projection.events[0].arguments[0].property.description,
    '模板模式',
    'event arguments use the projected property template fallback',
  );
  assert.deepEqual(projection.events[0].arguments[1], { resolved: false, piid: 99 });
  assert.equal(
    projection.actions[0].description,
    'Raw set mode',
    'raw action description wins before the action template',
  );
  assert.equal(projection.actions[0].inputs[0].resolved, true);
  assert.equal(
    projection.actions[0].inputs[0].property.description,
    'Raw mode',
    'action input names do not use the property template fallback',
  );
  assert.deepEqual(projection.actions[0].inputs[1], { resolved: false, piid: 99 });
  assert.equal(projection.actions[0].outMetadata[0].resolved, true);
  assert.equal(projection.actions[0].outMetadata[0].bindable, false);
  assert.equal('outputs' in projection.actions[0], false);
});

test('catalog cache deduplicates global requests and keys multiLanguage by device URN', async () => {
  const counter = { count: 0 };
  const fetch = successfulCatalogFetch(counter);
  const cache = new DeviceSpecSemanticCache();

  await Promise.all([
    projectDeviceSpecSemantics(rawSpec, { fetch, cache, timeoutMs: 100 }),
    projectDeviceSpecSemantics(rawSpec, { fetch, cache, timeoutMs: 100 }),
  ]);
  assert.equal(counter.count, 7, 'concurrent identical projections share all catalog requests');

  await projectDeviceSpecSemantics(
    { ...rawSpec, type: 'urn:miot-spec-v2:device:other-light:0000A002:vendor-model:1' },
    { fetch, cache, timeoutMs: 100 },
  );
  assert.equal(counter.count, 8, 'a new URN only refetches its per-device multiLanguage catalog');

  await projectDeviceSpecSemantics(rawSpec, { fetch, cache, timeoutMs: 250 });
  assert.equal(counter.count, 8, 'resolved catalogs are reused across later timeout policies');
});

test('HTTP and timeout failures are reported and fall back without rejecting', async () => {
  const httpCounter = { count: 0 };
  const httpCache = new DeviceSpecSemanticCache();
  const httpFetch = async () => {
    httpCounter.count += 1;
    return new Response('unavailable', { status: 503 });
  };
  const httpFallback = await projectDeviceSpecSemantics(rawSpec, {
    fetch: httpFetch,
    cache: httpCache,
    timeoutMs: 100,
  });
  assert.ok(
    httpFallback.catalogs.every(
      ({ status, reason, httpStatus }) =>
        status === 'fallback' && reason === 'http' && httpStatus === 503,
    ),
  );
  assert.equal(httpFallback.propertyNotify[0].description, 'Raw power');
  assert.equal(httpFallback.deviceType, 'test-light');
  assert.equal(
    httpFallback.deviceTypeDescription,
    'test-light',
    'device type fallback must not reuse the instance product description',
  );
  assert.deepEqual(httpFallback.propertyNotify[0].valueList, [
    { value: true, description: '开启' },
    { value: false, description: '关闭' },
  ]);
  assert.deepEqual(httpFallback.propertyNotify[1].valueList, [
    { value: 0, description: 'raw-off' },
    { value: 1, description: 'raw-eco' },
  ]);
  await projectDeviceSpecSemantics(rawSpec, {
    fetch: httpFetch,
    cache: httpCache,
    timeoutMs: 100,
  });
  assert.equal(httpCounter.count, 14, 'fallback results do not poison the successful-result cache');

  const timeoutFallback = await projectDeviceSpecSemantics(rawSpec, {
    fetch: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    cache: new DeviceSpecSemanticCache(),
    timeoutMs: 5,
  });
  assert.ok(
    timeoutFallback.catalogs.every(
      ({ status, reason }) => status === 'fallback' && reason === 'timeout',
    ),
  );
});

test('device template parser uses the exact endpoint, short token, zh_cn, and raw fallback', async () => {
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method });
    return Response.json({
      result: [
        {
          type: 'urn:miot-spec-v2:device:light:0000A001',
          description: { zh_cn: '灯' },
        },
        {
          type: 'urn:miot-spec-v2:device:light:0000A001:duplicate:1',
          description: { zh_cn: '照明设备' },
        },
        {
          type: 'urn:miot-spec-v2:device:space-label:0000A002',
          description: { zh_cn: ' ' },
        },
        {
          type: 'urn:miot-spec-v2:device:empty-label:0000A003',
          description: { zh_cn: '' },
        },
        { type: 'urn:miot-spec-v2:device:no-zh-cn:0000A004', description: { en: 'English' } },
        { type: 'too-short', description: { zh_cn: '不可用' } },
        { description: { zh_cn: '不可用' } },
      ],
    });
  };
  const cache = new DeviceSpecSemanticCache();
  const urns = [
    'urn:miot-spec-v2:device:light:0000A001:test:1',
    'urn:miot-spec-v2:device:unknown:0000A099:test:1',
    'urn:miot-spec-v2:device:space-label:0000A002:test:1',
  ];

  const [first, concurrent] = await Promise.all([
    projectDeviceTypesSemantics(urns, { fetch, cache, timeoutMs: 100 }),
    projectDeviceTypesSemantics(urns, { fetch, cache, timeoutMs: 100 }),
  ]);
  assert.deepEqual(first, concurrent);
  assert.deepEqual(calls, [
    {
      url: 'https://miot-spec.org/miot-spec-v2/template/list/device',
      method: 'GET',
    },
  ]);
  assert.deepEqual(first.deviceTypes, [
    {
      urn: urns[0],
      deviceType: 'light',
      deviceTypeDescription: '照明设备',
    },
    {
      urn: urns[1],
      deviceType: 'unknown',
      deviceTypeDescription: 'unknown',
    },
    {
      urn: urns[2],
      deviceType: 'space-label',
      deviceTypeDescription: ' ',
    },
  ]);
  assert.deepEqual(first.catalogs, [{ catalog: 'device-template', status: 'loaded' }]);

  await projectDeviceTypesSemantics(urns, { fetch, cache, timeoutMs: 250 });
  assert.equal(calls.length, 1, 'a successful device catalog is cached across timeout policies');
});

test('device template fallback reasons are independent and never use product descriptions', async () => {
  const urn = 'urn:miot-spec-v2:device:air-purifier:0000A007:test:1';
  const scenarios = [
    {
      reason: 'http',
      httpStatus: 502,
      fetch: async () => new Response('bad gateway', { status: 502 }),
    },
    {
      reason: 'network',
      fetch: async () => {
        throw new Error('offline');
      },
    },
    {
      reason: 'invalid-content',
      fetch: async () => Response.json({ result: 'not-an-array' }),
    },
    {
      reason: 'timeout',
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      timeoutMs: 5,
    },
  ];

  for (const scenario of scenarios) {
    const projection = await projectDeviceTypesSemantics([urn], {
      fetch: scenario.fetch,
      cache: new DeviceSpecSemanticCache(),
      timeoutMs: scenario.timeoutMs ?? 100,
    });
    assert.deepEqual(projection.deviceTypes, [
      {
        urn,
        deviceType: 'air-purifier',
        deviceTypeDescription: 'air-purifier',
      },
    ]);
    assert.deepEqual(projection.catalogs, [
      {
        catalog: 'device-template',
        status: 'fallback',
        reason: scenario.reason,
        ...(scenario.httpStatus === undefined ? {} : { httpStatus: scenario.httpStatus }),
      },
    ]);
  }
});

test('device template failures retry and a later success becomes cached', async () => {
  const urn = 'urn:miot-spec-v2:device:curtain:0000A00C:test:1';
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('temporary', { status: 503 });
    return Response.json({
      result: [
        {
          type: 'urn:miot-spec-v2:device:curtain:0000A00C',
          description: { zh_cn: '窗帘' },
        },
      ],
    });
  };
  const cache = new DeviceSpecSemanticCache();

  const failed = await projectDeviceTypesSemantics([urn], { fetch, cache, timeoutMs: 100 });
  assert.equal(failed.deviceTypes[0].deviceTypeDescription, 'curtain');
  assert.equal(failed.catalogs[0].status, 'fallback');

  const recovered = await projectDeviceTypesSemantics([urn], { fetch, cache, timeoutMs: 100 });
  assert.equal(recovered.deviceTypes[0].deviceTypeDescription, '窗帘');
  assert.equal(recovered.catalogs[0].status, 'loaded');

  const cached = await projectDeviceTypesSemantics([urn], { fetch, cache, timeoutMs: 250 });
  assert.equal(cached.deviceTypes[0].deviceTypeDescription, '窗帘');
  assert.equal(calls, 2, 'fallback is retried and the later successful result is cached');
});
