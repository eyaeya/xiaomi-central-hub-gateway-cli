import assert from 'node:assert/strict';
import test from 'node:test';

import { addNode, relayoutGraph, updateNode } from '../dist/index.js';
import {
  estimateMiLanProText,
  nextCardPosition,
  replacePositionSize,
  resolveBundleCardGeometry,
  variableGeometryKey,
} from '../dist/resources/card-geometry.js';
import { FLOW_COLUMN_GAP, layoutGraph } from '../dist/usecases/layout-graph.js';

const urn = 'urn:miot-spec-v2:device:test-device:0000A001:1';
const spec = {
  type: urn,
  description: '测试设备',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:test:00007801:1',
      description: '测试服务',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:enabled:00000006:1',
          description: '开关',
          format: 'bool',
          access: ['read', 'notify', 'write'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:temperature:00000020:1',
          description: '温度',
          format: 'float',
          access: ['read', 'notify', 'write'],
          unit: '℃',
          'value-range': [-20, 100, 0.1],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:mode:00000008:1',
          description: '模式',
          format: 'int',
          access: ['read', 'notify', 'write'],
          'value-list': [
            { value: 0, description: '关闭' },
            { value: 1, description: '开启' },
          ],
        },
        {
          iid: 4,
          type: 'urn:miot-spec-v2:property:name:00000001:1',
          description: '名称',
          format: 'string',
          access: ['read', 'notify', 'write'],
        },
        {
          iid: 5,
          type: 'urn:miot-spec-v2:property:empty-enum:00000002:1',
          description: '空枚举',
          format: 'int',
          access: ['read', 'notify', 'write'],
          'value-list': [],
        },
      ],
      events: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:event:changed:00005001:1',
          description: '发生变化',
          arguments: [2, 3],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:event:clicked:00005002:1',
          description: '点击',
          arguments: [],
        },
      ],
      actions: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:action:set:00002801:1',
          description: '设置',
          in: [2, 4],
          out: [],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:action:stop:00002802:1',
          description: '停止',
          in: [],
          out: [],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:action:mixed:00002803:1',
          description: '混合设置',
          in: [1, 2, 4],
          out: [],
        },
      ],
    },
  ],
};

const device = {
  did: 'device-1',
  name: '书房传感器',
  roomName: '书房',
  deviceTypeDescription: '传感器',
  modelName: '测试设备',
  urn,
};

const variables = new Map([
  [
    variableGeometryKey('global', 'target'),
    { scope: 'global', id: 'target', name: '目标变量', type: 'number' },
  ],
  [
    variableGeometryKey('global', 'source'),
    { scope: 'global', id: 'source', name: '来源变量', type: 'number' },
  ],
]);

const measureTen = (text) => text.length * 10;
const catalog = {
  specsByUrn: new Map([[urn, spec]]),
  devicesByDid: new Map([[device.did, device]]),
  variablesByRef: variables,
  measureText: measureTen,
};

function semanticProperty({
  piid,
  description,
  dtype,
  unit,
  valueList,
  access = ['read', 'notify', 'write'],
}) {
  const raw = spec.services[0].properties.find((property) => property.iid === piid);
  assert.ok(raw);
  return {
    siid: 2,
    piid,
    sUrn: spec.services[0].type,
    urn: raw.type,
    sDescription: '语义服务',
    description,
    format: raw.format,
    dtype,
    access,
    proprietary: false,
    ...(unit !== undefined && { unit }),
    ...(valueList !== undefined && { valueList }),
  };
}

const semanticBool = semanticProperty({
  piid: 1,
  description: '语义开关',
  dtype: 'boolean',
  valueList: [
    { value: false, description: '关闭' },
    { value: true, description: '开启' },
  ],
});
const semanticTemperature = semanticProperty({
  piid: 2,
  description: '语义温度',
  dtype: 'float',
  unit: '语义度',
});
const semanticMode = semanticProperty({
  piid: 3,
  description: '语义模式',
  dtype: 'int',
  valueList: [
    { value: 0, description: '语义关闭' },
    { value: 1, description: '语义开启' },
  ],
});
const semanticName = semanticProperty({
  piid: 4,
  description: '语义名称',
  dtype: 'string',
});
const semanticSpec = {
  urn,
  description: '测试设备',
  deviceType: 'test-device',
  deviceTypeDescription: '传感器',
  locale: 'zh_cn',
  propertyNotify: [semanticBool, semanticTemperature, semanticMode, semanticName],
  propertyGet: [semanticBool, semanticTemperature, semanticMode, semanticName],
  propertySet: [semanticBool, semanticTemperature, semanticMode, semanticName],
  events: [
    {
      siid: 2,
      eiid: 1,
      sUrn: spec.services[0].type,
      urn: spec.services[0].events[0].type,
      sDescription: '语义服务',
      description: '语义事件',
      proprietary: false,
      arguments: [
        { resolved: true, piid: 2, property: semanticTemperature },
        { resolved: true, piid: 3, property: semanticMode },
      ],
    },
  ],
  actions: [
    {
      siid: 2,
      aiid: 3,
      sUrn: spec.services[0].type,
      urn: spec.services[0].actions[2].type,
      sDescription: '语义服务',
      description: '语义动作',
      proprietary: false,
      inputs: [
        { resolved: true, piid: 1, property: semanticBool },
        { resolved: true, piid: 2, property: semanticTemperature },
        { resolved: true, piid: 4, property: semanticName },
      ],
      outMetadata: [],
    },
  ],
  excludedServices: [],
  catalogs: [],
};

function gatewayDevice(overrides = {}) {
  return {
    specV2Access: true,
    specV3Access: false,
    online: true,
    pushAvailable: true,
    name: '设备',
    model: 'test.model.v1',
    modelName: '测试设备',
    urn,
    roomId: 'room-1',
    roomName: '书房',
    icon: '',
    ...overrides,
  };
}

function node(type, overrides = {}) {
  return {
    id: `${type}-1`,
    type,
    cfg: {
      pos: { x: 0, y: 0, width: 1, height: 1 },
      name: type,
      version: 1,
      ...(overrides.cfg ?? {}),
    },
    inputs: overrides.inputs ?? { input: null },
    outputs: overrides.outputs ?? { output: [] },
    props: overrides.props ?? {},
  };
}

function size(value, geometryCatalog = {}) {
  const result = resolveBundleCardGeometry(value, geometryCatalog);
  assert.equal(result.kind, 'resolved');
  return result.geometry;
}

test('fixed editing card rectangles match the pinned Bundle', () => {
  const cases = {
    condition: [300, 140],
    counter: [328, 140],
    delay: [288, 112],
    eventSequence: [524, 140],
    loop: [510, 140],
    onLoad: [160, 98],
    onlyNTimes: [382, 140],
    register: [160, 140],
    statusLast: [288, 119],
    logicNot: [160, 100],
  };
  for (const [type, [width, height]] of Object.entries(cases)) {
    assert.deepEqual(
      size(node(type)),
      { width, height, state: 'editing', measurement: 'exact' },
      type,
    );
  }
});

test('editing logic and mode cards include the disabled add row', () => {
  for (const count of [2, 3, 5, 10]) {
    const inputs = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`input${index}`, null]),
    );
    const outputs = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`output${index}`, []]),
    );
    for (const type of ['logicAnd', 'logicOr', 'signalOr']) {
      assert.deepEqual(size(node(type, { inputs })), {
        width: 160,
        height: 40 * count + 100,
        state: 'editing',
        measurement: 'exact',
      });
    }
    assert.deepEqual(size(node('modeSwitch', { outputs })), {
      width: 160,
      height: 40 * count + 100,
      state: 'editing',
      measurement: 'exact',
    });
  }
});

test('editing device cards follow MIoT mode, dtype, operator and row count', () => {
  const cfg = { urn };
  const comparisons = [
    { piid: 1, operator: '=', input: 450, get: 606 },
    { piid: 3, operator: 'include', input: 584, get: 740 },
    // Bundle tests value-list field presence, including an explicitly empty array.
    { piid: 5, operator: 'include', input: 584, get: 740 },
    { piid: 2, operator: '>', input: 544, get: 700 },
    { piid: 2, operator: 'between', input: 694, get: 850 },
    { piid: 4, operator: '=', input: 536, get: 692 },
  ];
  for (const entry of comparisons) {
    const props = {
      did: device.did,
      siid: 2,
      piid: entry.piid,
      operator: entry.operator,
    };
    assert.deepEqual(size(node('deviceInput', { cfg, inputs: {}, props }), catalog), {
      width: entry.input,
      height: 206,
      state: 'editing',
      measurement: 'exact',
    });
    assert.deepEqual(size(node('deviceGet', { cfg, props }), catalog), {
      width: entry.get,
      height: 164,
      state: 'editing',
      measurement: 'exact',
    });
  }
  const vendorFormatSpec = structuredClone(spec);
  vendorFormatSpec.services[0].properties.find((property) => property.iid === 4).format = 'str';
  const vendorCatalog = {
    ...catalog,
    specsByUrn: new Map([[urn, vendorFormatSpec]]),
  };
  assert.equal(
    size(
      node('deviceInput', {
        cfg,
        inputs: {},
        props: { did: device.did, siid: 2, piid: 4, operator: '=' },
      }),
      vendorCatalog,
    ).width,
    544,
  );
  assert.equal(
    size(
      node('deviceOutput', {
        cfg,
        props: { did: device.did, siid: 2, piid: 4, value: 'x' },
      }),
      vendorCatalog,
    ).width,
    528,
  );
  assert.deepEqual(
    size(
      node('deviceInput', {
        cfg,
        inputs: {},
        props: { did: device.did, siid: 2, eiid: 1, arguments: [] },
      }),
      catalog,
    ),
    { width: 280, height: 204, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceInput', {
        cfg,
        inputs: {},
        props: {
          did: device.did,
          siid: 2,
          eiid: 1,
          arguments: [{ piid: 2, dtype: 'float', operator: '>', v1: 20 }],
        },
      }),
      catalog,
    ),
    { width: 444, height: 244, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceInput', {
        cfg,
        inputs: {},
        props: { did: device.did, siid: 2, eiid: 2, arguments: [] },
      }),
      catalog,
    ),
    { width: 280, height: 164, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceInput', {
        cfg,
        inputs: {},
        props: {
          did: device.did,
          siid: 2,
          eiid: 1,
          arguments: [
            { piid: 2, dtype: 'float', operator: 'between', v1: 20, v2: 30 },
            { piid: 3, dtype: 'int', operator: 'include', v1: [1] },
          ],
        },
      }),
      catalog,
    ),
    { width: 594, height: 244, state: 'editing', measurement: 'exact' },
  );
  for (const [piid, width] of [
    [1, 528],
    [3, 528],
    [2, 556],
    [4, 676],
  ]) {
    assert.deepEqual(
      size(
        node('deviceOutput', {
          cfg,
          props: { did: device.did, siid: 2, piid, value: 20 },
        }),
        catalog,
      ),
      { width, height: 164, state: 'editing', measurement: 'exact' },
    );
  }
  assert.deepEqual(
    size(
      node('deviceOutput', {
        cfg,
        props: {
          did: device.did,
          siid: 2,
          aiid: 1,
          ins: [
            { piid: 2, value: 20 },
            { piid: 4, value: '测试' },
          ],
        },
      }),
      catalog,
    ),
    { width: 684, height: 204, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceOutput', { cfg, props: { did: device.did, siid: 2, aiid: 2, ins: [] } }),
      catalog,
    ),
    { width: 280, height: 164, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceOutput', {
        cfg,
        props: {
          did: device.did,
          siid: 2,
          aiid: 3,
          ins: [
            { piid: 1, value: true },
            { piid: 2, value: 20 },
            { piid: 4, value: '测试' },
          ],
        },
      }),
      catalog,
    ),
    { width: 684, height: 244, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceGetSetVar', {
        cfg,
        props: { did: device.did, siid: 2, scope: 'global', id: 'target' },
      }),
      catalog,
    ),
    { width: 348, height: 164, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceInputSetVar', {
        cfg,
        inputs: {},
        props: {
          did: device.did,
          siid: 2,
          eiid: 1,
          arguments: [{ piid: 2, dtype: 'number', scope: 'global', id: 'target' }],
        },
      }),
      catalog,
    ),
    { width: 418, height: 244, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceInputSetVar', {
        cfg,
        inputs: {},
        props: {
          did: device.did,
          siid: 2,
          piid: 2,
          dtype: 'number',
          scope: 'global',
          id: 'target',
        },
      }),
      catalog,
    ),
    { width: 554, height: 204, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceInputSetVar', {
        cfg,
        inputs: {},
        props: { did: device.did, siid: 2, eiid: 1, arguments: [] },
      }),
      catalog,
    ),
    { width: 342, height: 204, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceInputSetVar', {
        cfg,
        inputs: {},
        props: {
          did: device.did,
          siid: 2,
          eiid: 1,
          arguments: [
            { piid: 2, dtype: 'number', scope: 'global', id: 'target' },
            { piid: 3, dtype: 'number', scope: 'global', id: 'source' },
          ],
        },
      }),
      catalog,
    ),
    { width: 418, height: 244, state: 'editing', measurement: 'exact' },
  );
  assert.deepEqual(
    size(
      node('deviceGetSetVar', {
        cfg,
        props: { did: device.did, siid: 2, piid: 2, scope: 'global', id: 'target' },
      }),
      catalog,
    ),
    { width: 566, height: 164, state: 'editing', measurement: 'exact' },
  );
});

test('editing variable, expression, alarm and time-range branches match Bundle formulas', () => {
  const variableCases = [
    ['varChange', {}, 210, 152],
    ['varChange', { id: 'x', varType: 'string', operator: '=' }, 436, 152],
    ['varChange', { id: 'x', varType: 'number', operator: '>' }, 444, 152],
    ['varChange', { id: 'x', varType: 'number', operator: 'between' }, 594, 152],
    ['varGet', {}, 264, 120],
    ['varGet', { id: 'x', varType: 'string', operator: '=' }, 524, 120],
    ['varGet', { id: 'x', varType: 'number', operator: '>' }, 532, 120],
    ['varGet', { id: 'x', varType: 'number', operator: 'between' }, 682, 120],
  ];
  for (const [type, props, width, height] of variableCases) {
    assert.deepEqual(size(node(type, { props })), {
      width,
      height,
      state: 'editing',
      measurement: 'exact',
    });
  }

  for (const [exprHeight, outerHeight] of [
    [undefined, 112],
    [30, 112],
    [37, 117],
    [140, 220],
  ]) {
    const pos = {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      ...(exprHeight !== undefined && { exprHeight }),
    };
    assert.deepEqual(size(node('varSetNumber', { cfg: { pos }, props: { elements: [] } })), {
      width: 740,
      height: outerHeight,
      state: 'editing',
      measurement: 'exact',
    });
    assert.deepEqual(size(node('varSetString', { cfg: { pos }, props: { elements: [] } })), {
      width: 712,
      height: outerHeight,
      state: 'editing',
      measurement: 'exact',
    });
  }

  const alarmCases = [
    ['periodicAlarm', {}, 'now', 416, 112],
    ['periodicAlarm', { day: [1] }, 'now', 544, 112],
    ['sunset', {}, 'now', 512, 152],
    ['sunset', { day: [1] }, 'now', 544, 152],
    ['sunset', {}, 'before', 580, 152],
    ['sunset', { day: [1] }, 'after', 708, 152],
  ];
  for (const [type, filter, happenType, width, height] of alarmCases) {
    assert.deepEqual(
      size(node('alarmClock', { cfg: { happenType }, inputs: {}, props: { type, filter } })),
      { width, height, state: 'editing', measurement: 'exact' },
    );
  }

  for (const [filter, width] of [
    [{}, 438],
    [{ inHoliday: false }, 438],
    [{ inHoliday: true }, 438],
    [{ day: [1, 2] }, 566],
  ]) {
    assert.deepEqual(size(node('timeRange', { inputs: {}, props: { filter } })), {
      width,
      height: 112,
      state: 'editing',
      measurement: 'exact',
    });
  }
});

test('simplified cards use their independent fixed, pin and measured paths', () => {
  assert.deepEqual(
    size(
      node('condition', {
        cfg: { simplified: true },
        inputs: { trigger: null, condition: null },
        outputs: { met: [], unmet: [] },
      }),
      catalog,
    ),
    { width: 197, height: 92, state: 'simplified', measurement: 'exact' },
  );

  for (const count of [2, 3, 5]) {
    const inputs = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`input${index}`, null]),
    );
    assert.deepEqual(size(node('logicAnd', { cfg: { simplified: true }, inputs }), catalog), {
      width: 88,
      height: 36 * count + 20,
      state: 'simplified',
      measurement: 'exact',
    });
  }

  const event = size(
    node('eventSequence', {
      cfg: { simplified: true, value: 5, unit: 'min' },
      inputs: { input1: null, input2: null },
    }),
    catalog,
  );
  assert.deepEqual(event, {
    width: '在5分钟内发生'.length * 10 + 66,
    height: 92,
    state: 'simplified',
    measurement: 'font-dependent',
  });

  const variable = size(
    node('varChange', {
      cfg: { simplified: true },
      props: {
        scope: 'global',
        id: 'target',
        varType: 'number',
        operator: '>',
        v1: 20,
      },
    }),
    catalog,
  );
  assert.equal(variable.height, 90);
  assert.equal(variable.measurement, 'font-dependent');
  assert.ok(variable.width >= 190 && variable.width <= 360);
});

test('simplified device heights distinguish event/action rows and variable tags', () => {
  const baseCfg = { urn, simplified: true };
  const event0 = size(
    node('deviceInput', {
      cfg: baseCfg,
      inputs: {},
      props: { did: device.did, siid: 2, eiid: 2, arguments: [] },
    }),
    catalog,
  );
  assert.equal(event0.height, 125);
  assert.equal(event0.measurement, 'font-dependent');

  const event2 = size(
    node('deviceInput', {
      cfg: baseCfg,
      inputs: {},
      props: {
        did: device.did,
        siid: 2,
        eiid: 1,
        arguments: [
          { piid: 2, dtype: 'float', operator: '>', v1: 20 },
          { piid: 3, dtype: 'int', operator: 'include', v1: [1] },
        ],
      },
    }),
    catalog,
  );
  assert.equal(event2.height, 171);

  const setVar = size(
    node('deviceInputSetVar', {
      cfg: baseCfg,
      inputs: {},
      props: {
        did: device.did,
        siid: 2,
        eiid: 1,
        arguments: [
          { piid: 2, dtype: 'number', scope: 'global', id: 'target' },
          { piid: 3, dtype: 'number', scope: 'global', id: 'source' },
        ],
      },
    }),
    catalog,
  );
  assert.equal(setVar.height, 179);

  const missingDevice = size(
    node('deviceInput', {
      cfg: baseCfg,
      inputs: {},
      props: { did: 'missing-device', siid: 2, eiid: 2, arguments: [] },
    }),
    { ...catalog, devicesByDid: new Map() },
  );
  assert.deepEqual(missingDevice, {
    width: 190,
    height: 125,
    state: 'simplified',
    measurement: 'exact',
  });

  const stringValue = size(
    node('deviceGet', {
      cfg: baseCfg,
      props: {
        did: device.did,
        siid: 2,
        piid: 4,
        dtype: 'string',
        operator: '=',
        v1: 'abc',
      },
    }),
    {
      ...catalog,
      measureText: (text) => {
        if (text === 'abc') return 250;
        return 0;
      },
    },
  );
  assert.equal(stringValue.width, 290);

  const propertyVariable = size(
    node('deviceOutput', {
      cfg: baseCfg,
      inputs: { trigger: null },
      props: {
        did: device.did,
        siid: 2,
        piid: 2,
        scope: 'global',
        id: 'target',
      },
    }),
    {
      ...catalog,
      measureText: (text) => (text === '目标变量' ? 250 : 0),
    },
  );
  // Bundle pu() flattens the singleton property variable atom: no compound
  // row gap and no 27 px compound-variable row height.
  assert.equal(propertyVariable.width, 298);
  assert.equal(propertyVariable.height, 148);
});

test('simplified device width uses the frontend zh_cn semantic projection', () => {
  const englishSpec = structuredClone(spec);
  englishSpec.services[0].description = 'Extremely Long Public Instance Service Description';
  englishSpec.services[0].properties.find((property) => property.iid === 4).description =
    'Extremely Long Public Instance Property Description';
  const semantic = {
    urn,
    description: '测试设备',
    deviceType: 'test-device',
    deviceTypeDescription: '传感器',
    locale: 'zh_cn',
    propertyNotify: [],
    propertyGet: [
      {
        siid: 2,
        piid: 4,
        sDescription: '服务',
        description: '名称',
        dtype: 'string',
      },
    ],
    propertySet: [],
    events: [],
    actions: [],
    excludedServices: [],
    catalogs: [],
  };
  const card = node('deviceGet', {
    cfg: { urn, simplified: true },
    props: {
      did: device.did,
      siid: 2,
      piid: 4,
      dtype: 'string',
      operator: '=',
      v1: 'abc',
    },
  });
  const base = {
    ...catalog,
    specsByUrn: new Map([[urn, englishSpec]]),
    measureText: measureTen,
  };
  assert.equal(size(card, { ...base, semanticSpecsByUrn: new Map() }).width, 360);
  assert.equal(size(card, { ...base, semanticSpecsByUrn: new Map([[urn, semantic]]) }).width, 190);
});

test('simplified bool value-list text from semantic projection participates in width measurement', () => {
  const measured = [];
  const geometry = size(
    node('deviceGet', {
      cfg: { urn, simplified: true },
      props: {
        did: device.did,
        siid: 2,
        piid: 1,
        dtype: 'boolean',
        operator: '=',
        v1: true,
      },
    }),
    {
      ...catalog,
      semanticSpecsByUrn: new Map([[urn, semanticSpec]]),
      measureText: (text) => {
        measured.push(text);
        return text === '为：开启' ? 250 : 0;
      },
    },
  );

  assert.ok(measured.includes('为：开启'));
  assert.equal(geometry.width, 290);
});

test('simplified semantic event and action rows use translated descriptions, units and values', () => {
  const eventMeasured = [];
  const event = size(
    node('deviceInput', {
      cfg: { urn, simplified: true },
      inputs: {},
      props: {
        did: device.did,
        siid: 2,
        eiid: 1,
        arguments: [{ piid: 2, dtype: 'float', operator: '>', v1: 20 }],
      },
    }),
    {
      ...catalog,
      semanticSpecsByUrn: new Map([[urn, semanticSpec]]),
      measureText: (text) => {
        eventMeasured.push(text);
        return measureTen(text);
      },
    },
  );
  assert.ok(eventMeasured.includes('上报语义服务-语义事件'));
  assert.ok(eventMeasured.includes('语义温度：大于20语义度'));
  assert.equal(event.height, 148);

  const actionMeasured = [];
  const action = size(
    node('deviceOutput', {
      cfg: { urn, simplified: true },
      inputs: { trigger: null },
      props: {
        did: device.did,
        siid: 2,
        aiid: 3,
        ins: [
          { piid: 1, value: true },
          { piid: 2, value: 20 },
          { piid: 4, scope: 'global', id: 'target' },
        ],
      },
    }),
    {
      ...catalog,
      semanticSpecsByUrn: new Map([[urn, semanticSpec]]),
      measureText: (text) => {
        actionMeasured.push(text);
        return measureTen(text);
      },
    },
  );
  assert.ok(actionMeasured.includes('执行语义服务-语义动作'));
  assert.ok(actionMeasured.includes('语义开关：开启'));
  assert.ok(actionMeasured.includes('语义温度：20语义度'));
  assert.ok(actionMeasured.includes('语义名称'));
  assert.ok(actionMeasured.includes('目标变量'));
  // 53 px base + two ordinary 23 px rows + one variable-tag 27 px row.
  assert.equal(action.height, 198);
});

test('simplified device header follows the first inventory device with the same URN', () => {
  const first = {
    ...device,
    did: 'inventory-first',
    name: '第一台库存设备显示名称',
    roomName: '甲',
    deviceTypeDescription: '短类型',
  };
  const selected = {
    ...device,
    did: 'selected-by-props',
    name: '第二台',
    roomName: '乙',
    deviceTypeDescription: '短类型',
  };
  const measured = [];
  const geometry = size(
    node('deviceGet', {
      cfg: { urn, simplified: true },
      props: {
        did: selected.did,
        siid: 2,
        piid: 4,
        dtype: 'string',
        operator: '=',
        v1: 'abc',
      },
    }),
    {
      ...catalog,
      devicesByDid: new Map([
        [first.did, first],
        [selected.did, selected],
      ]),
      measureText: (text) => {
        measured.push(text);
        return measureTen(text);
      },
    },
  );

  assert.ok(measured.includes(first.name));
  assert.ok(!measured.includes(selected.name));
  assert.equal(geometry.width, first.name.length * 10 + 88);
});

test('position helpers preserve x/y and expression state while spacing insertion tightly', () => {
  assert.deepEqual(
    replacePositionSize(
      { x: 1, y: 2, width: 3, height: 4, exprHeight: 140 },
      { width: 740, height: 220 },
    ),
    { x: 1, y: 2, width: 740, height: 220, exprHeight: 140 },
  );
  assert.deepEqual(
    nextCardPosition([{ x: 40, y: 40, width: 300, height: 140 }], {
      width: 160,
      height: 180,
    }),
    { x: 364, y: 40 },
  );
  assert.ok(estimateMiLanProText('事件 sequence 12', { size: 16, weight: 500 }) > 0);
});

test('wired layout uses a 32 px right-edge lane', () => {
  assert.equal(FLOW_COLUMN_GAP, 32);
  const positions = layoutGraph({
    nodes: [
      { id: 'a', width: 200, height: 100 },
      { id: 'b', width: 100, height: 100 },
      { id: 'c', width: 300, height: 100 },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  });
  assert.deepEqual(positions, {
    a: { x: 40, y: 40 },
    b: { x: 272, y: 40 },
    c: { x: 404, y: 40 },
  });
});

function layoutGateway(nodes, options = {}) {
  const baseUrl = 'http://gateway.invalid';
  const startedAt = '2026-07-29T00:00:00.000Z';
  const calls = [];
  let deviceListIndex = 0;
  const state = {
    summary: {
      id: 'rule1',
      enable: false,
      uiType: 'test',
      userData: {
        name: 'geometry repair',
        transform: { x: 0, y: 0, scale: 1, rotate: 0 },
        lastUpdateTime: 0,
        version: 0,
      },
    },
    nodes: structuredClone(nodes),
  };
  return {
    state,
    deps: {
      baseUrl,
      store: {
        read: async () => ({
          host: baseUrl,
          pid: 1,
          socketPath: '/tmp/xgg-card-geometry-unused.sock',
          agentStartedAt: startedAt,
          agentVersion: '2.0.1',
          lastValidatedAt: startedAt,
        }),
      },
      ipcClient: () => ({
        request: async (method, params) => {
          calls.push({ method, params: structuredClone(params) });
          if (method === '$ping') return { host: baseUrl, agentStartedAt: startedAt };
          if (method === '$mutation.acquire') return { leaseId: 'geometry-lease' };
          if (method === '$mutation.release' || method === '$mutation.fence') {
            return { ok: true };
          }
          if (method === '/api/getGraphList') return [structuredClone(state.summary)];
          if (method === '/api/getGraph') {
            return { id: 'rule1', nodes: structuredClone(state.nodes) };
          }
          if (method === '/api/getDevList') {
            const response = options.deviceListResponses?.[deviceListIndex];
            deviceListIndex += 1;
            if (response instanceof Error) throw response;
            if (response !== undefined) return { devList: structuredClone(response) };
          }
          if (method === '/api/setGraph') {
            state.summary = structuredClone(params.cfg);
            state.nodes = structuredClone(params.nodes);
            return null;
          }
          throw new Error(`unexpected RPC: ${method}`);
        },
        close: () => {},
      }),
    },
    calls,
  };
}

test('rule layout repairs stale card geometry before positioning and is idempotent', async () => {
  const onLoad = (id, target) => ({
    id,
    type: 'onLoad',
    cfg: {
      pos: { x: 900, y: 500, width: 200, height: 120 },
      name: 'onLoad',
      version: 1,
    },
    inputs: {},
    outputs: { output: [target] },
    props: {},
  });
  const gateway = layoutGateway([
    onLoad('first', 'sequence.input1'),
    onLoad('second', 'sequence.input2'),
    {
      id: 'sequence',
      type: 'eventSequence',
      cfg: {
        pos: { x: 1200, y: 700, width: 340, height: 140 },
        name: 'eventSequence',
        version: 1,
        unit: 'min',
        value: 5,
      },
      inputs: { input1: null, input2: null },
      outputs: { output: [] },
      props: { timeout: 300_000 },
    },
  ]);

  const first = await relayoutGraph('rule1', gateway.deps, {
    validate: false,
    varCheck: false,
  });
  assert.deepEqual(first, {
    id: 'rule1',
    nodeCount: 3,
    moved: 3,
    resized: 3,
    geometryPreserved: 0,
  });
  assert.deepEqual(
    gateway.state.nodes.map((entry) => entry.cfg.pos),
    [
      { x: 40, y: 40, width: 160, height: 98 },
      { x: 40, y: 178, width: 160, height: 98 },
      { x: 232, y: 40, width: 524, height: 140 },
    ],
  );

  const second = await relayoutGraph('rule1', gateway.deps, {
    validate: false,
    varCheck: false,
  });
  assert.deepEqual(second, {
    id: 'rule1',
    nodeCount: 3,
    moved: 0,
    resized: 0,
    geometryPreserved: 0,
  });
});

test('typed creation resolves normal and simplified geometry but preserves explicit pos', async () => {
  const gateway = layoutGateway([]);
  await addNode(
    {
      ruleId: 'rule1',
      shortcut: {
        type: 'eventSequence',
        id: 'normal',
        duration: '5min',
      },
      varCheck: false,
    },
    gateway.deps,
  );
  assert.deepEqual(gateway.state.nodes[0].cfg.pos, {
    x: 40,
    y: 40,
    width: 524,
    height: 140,
  });

  await addNode(
    {
      ruleId: 'rule1',
      shortcut: {
        type: 'eventSequence',
        id: 'compact',
        duration: '5min',
        simplified: true,
      },
      varCheck: false,
    },
    gateway.deps,
  );
  assert.equal(gateway.state.nodes[1].cfg.pos.x, 588);
  assert.equal(gateway.state.nodes[1].cfg.pos.y, 40);
  assert.equal(gateway.state.nodes[1].cfg.pos.height, 92);
  assert.notEqual(gateway.state.nodes[1].cfg.pos.width, 524);

  const explicit = { x: 900, y: 80, width: 340, height: 140 };
  await addNode(
    {
      ruleId: 'rule1',
      shortcut: {
        type: 'eventSequence',
        id: 'lossless',
        duration: '5min',
        pos: explicit,
      },
      varCheck: false,
    },
    gateway.deps,
  );
  assert.deepEqual(gateway.state.nodes[2].cfg.pos, explicit);
});

test('ordinary node updates recalculate geometry while explicit cfg.pos stays lossless', async () => {
  const gateway = layoutGateway([
    {
      id: 'sequence',
      type: 'eventSequence',
      cfg: {
        pos: { x: 100, y: 200, width: 524, height: 140 },
        name: 'eventSequence',
        version: 1,
        unit: 'min',
        value: 5,
      },
      inputs: { input1: null, input2: null },
      outputs: { output: [] },
      props: { timeout: 300_000 },
    },
  ]);

  await updateNode(
    {
      ruleId: 'rule1',
      nodeId: 'sequence',
      patch: { cfg: { simplified: true } },
      varCheck: false,
    },
    gateway.deps,
  );
  assert.equal(gateway.state.nodes[0].cfg.pos.x, 100);
  assert.equal(gateway.state.nodes[0].cfg.pos.y, 200);
  assert.equal(gateway.state.nodes[0].cfg.pos.height, 92);
  assert.notEqual(gateway.state.nodes[0].cfg.pos.width, 524);

  const explicit = { x: 1, y: 2, width: 333, height: 77 };
  await updateNode(
    {
      ruleId: 'rule1',
      nodeId: 'sequence',
      patch: { cfg: { simplified: false, pos: explicit } },
      varCheck: false,
    },
    gateway.deps,
  );
  assert.deepEqual(gateway.state.nodes[0].cfg.pos, explicit);
});

test('layout keep-sizes mode preserves every saved rectangle and reports it', async () => {
  const gateway = layoutGateway([
    {
      id: 'start',
      type: 'onLoad',
      cfg: {
        pos: { x: 900, y: 500, width: 200, height: 120 },
        name: 'onLoad',
        version: 1,
      },
      inputs: {},
      outputs: { output: [] },
      props: {},
    },
  ]);

  const result = await relayoutGraph('rule1', gateway.deps, {
    validate: false,
    varCheck: false,
    normalizeSizes: false,
  });
  assert.deepEqual(result, {
    id: 'rule1',
    nodeCount: 1,
    moved: 1,
    resized: 0,
    geometryPreserved: 1,
  });
  assert.deepEqual(gateway.state.nodes[0].cfg.pos, {
    x: 40,
    y: 40,
    width: 200,
    height: 120,
  });
});

test('unknown and malformed known nodes move without geometry metadata lookups', async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    throw new Error('unexpected MIoT metadata fetch');
  });
  const opaqueUrn = 'urn:miot-spec-v2:device:opaque:0000A001:1';
  const gateway = layoutGateway([
    {
      id: 'future',
      type: 'futureDeviceCard',
      cfg: {
        pos: { x: 900, y: 500, width: 240, height: 135 },
        name: 'futureDeviceCard',
        version: 1,
        simplified: true,
        urn: opaqueUrn,
      },
      inputs: { input: null },
      outputs: { output: ['malformed.input'] },
      props: {
        did: 'future-device',
        scope: 'global',
        id: 'opaqueVariable',
      },
    },
    {
      id: 'malformed',
      type: 'deviceGet',
      cfg: {
        pos: { x: 1400, y: 800, width: 610, height: 175 },
        name: 'deviceGet',
        version: 1,
        simplified: true,
        urn: opaqueUrn,
      },
      inputs: { input: null },
      outputs: { output: [], output2: [] },
      // Missing the strict string arm's v1; UnknownNode remains read-compatible.
      props: {
        did: 'future-device',
        siid: 2,
        piid: 4,
        dtype: 'string',
        operator: '=',
        scope: 'global',
        id: 'malformedVariable',
      },
    },
  ]);

  const result = await relayoutGraph('rule1', gateway.deps, {
    validate: false,
    varCheck: false,
  });
  assert.deepEqual(result, {
    id: 'rule1',
    nodeCount: 2,
    moved: 2,
    resized: 0,
    geometryPreserved: 2,
  });
  assert.deepEqual(
    gateway.state.nodes.map((entry) => entry.cfg.pos),
    [
      { x: 40, y: 40, width: 240, height: 135 },
      { x: 312, y: 40, width: 610, height: 175 },
    ],
  );
  assert.equal(fetchCount, 0);
  assert.deepEqual(
    gateway.calls
      .map((entry) => entry.method)
      .filter((method) => method === '/api/getDevList' || method === '/api/getVarList'),
    [],
  );
});

test('layout preserves a strict device card when its MIoT spec cannot be fetched', async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    throw new Error('spec registry offline');
  });
  const missingUrn = 'urn:miot-spec-v2:device:layout-missing-spec:0000A001:1';
  const gateway = layoutGateway([
    {
      id: 'query',
      type: 'deviceGet',
      cfg: {
        pos: { x: 900, y: 500, width: 777, height: 188 },
        name: 'deviceGet',
        version: 1,
        urn: missingUrn,
      },
      inputs: { input: null },
      outputs: { output: [], output2: [] },
      props: {
        did: 'missing-spec-device',
        siid: 2,
        piid: 4,
        dtype: 'string',
        operator: '=',
        v1: 'abc',
      },
    },
  ]);

  const result = await relayoutGraph('rule1', gateway.deps, {
    validate: false,
    varCheck: false,
  });
  assert.deepEqual(result, {
    id: 'rule1',
    nodeCount: 1,
    moved: 1,
    resized: 0,
    geometryPreserved: 1,
  });
  assert.deepEqual(gateway.state.nodes[0].cfg.pos, {
    x: 40,
    y: 40,
    width: 777,
    height: 188,
  });
  assert.equal(fetchCount, 1);
});

test('simplified update fails closed when its MIoT spec is unavailable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('spec registry offline');
  });
  const missingUrn = 'urn:miot-spec-v2:device:update-missing-spec:0000A001:1';
  const original = {
    id: 'query',
    type: 'deviceGet',
    cfg: {
      pos: { x: 100, y: 200, width: 692, height: 120 },
      name: 'deviceGet',
      version: 1,
      urn: missingUrn,
    },
    inputs: { input: null },
    outputs: { output: [], output2: [] },
    props: {
      did: 'missing-spec-device',
      siid: 2,
      piid: 4,
      dtype: 'string',
      operator: '=',
      v1: 'abc',
    },
  };
  const gateway = layoutGateway([original], { deviceListResponses: [{}] });

  await assert.rejects(
    updateNode(
      {
        ruleId: 'rule1',
        nodeId: 'query',
        patch: { cfg: { simplified: true } },
        varCheck: false,
      },
      gateway.deps,
    ),
    /could not resolve gateway-editor card geometry for deviceGet: missing-spec; no graph changes were written/,
  );
  assert.deepEqual(gateway.state.nodes, [original]);
  assert.equal(gateway.calls.filter((entry) => entry.method === '/api/setGraph').length, 0);
});

test('unavailable device inventory preserves layout geometry and fails updates closed', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/miot-spec-v2/instance')) {
      return new Response(JSON.stringify(spec), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('semantic catalogs offline');
  });
  const original = node('deviceGet', {
    cfg: {
      urn,
      simplified: true,
      pos: { x: 900, y: 500, width: 333, height: 177 },
    },
    props: {
      did: device.did,
      siid: 2,
      piid: 4,
      dtype: 'string',
      operator: '=',
      v1: 'abc',
    },
    outputs: { output: [], output2: [] },
  });

  const layout = layoutGateway([original], {
    deviceListResponses: [new Error('inventory offline')],
  });
  const result = await relayoutGraph('rule1', layout.deps, {
    validate: false,
    varCheck: false,
  });
  assert.deepEqual(result, {
    id: 'rule1',
    nodeCount: 1,
    moved: 1,
    resized: 0,
    geometryPreserved: 1,
  });
  assert.deepEqual(layout.state.nodes[0].cfg.pos, {
    x: 40,
    y: 40,
    width: 333,
    height: 177,
  });

  const update = layoutGateway([original], {
    deviceListResponses: [new Error('inventory offline')],
  });
  await assert.rejects(
    updateNode(
      {
        ruleId: 'rule1',
        nodeId: original.id,
        patch: { props: { ...original.props, v1: 'changed' } },
        varCheck: false,
      },
      update.deps,
    ),
    /could not resolve gateway-editor card geometry for deviceGet: missing-device-inventory; no graph changes were written/,
  );
  assert.deepEqual(update.state.nodes, [original]);
  assert.equal(update.calls.filter((entry) => entry.method === '/api/setGraph').length, 0);
});

test('unavailable variable inventory preserves layout geometry and fails updates closed', async () => {
  const original = node('varGet', {
    cfg: {
      simplified: true,
      pos: { x: 900, y: 500, width: 333, height: 123 },
    },
    props: {
      scope: 'global',
      id: 'target',
      varType: 'number',
      operator: '>',
      v1: 20,
    },
    outputs: { output: [], output2: [] },
  });

  const layout = layoutGateway([original]);
  const result = await relayoutGraph('rule1', layout.deps, {
    validate: false,
    varCheck: false,
  });
  assert.deepEqual(result, {
    id: 'rule1',
    nodeCount: 1,
    moved: 1,
    resized: 0,
    geometryPreserved: 1,
  });
  assert.deepEqual(layout.state.nodes[0].cfg.pos, {
    x: 40,
    y: 40,
    width: 333,
    height: 123,
  });

  const update = layoutGateway([original]);
  await assert.rejects(
    updateNode(
      {
        ruleId: 'rule1',
        nodeId: original.id,
        patch: { props: { ...original.props, v1: 21 } },
        varCheck: false,
      },
      update.deps,
    ),
    /could not resolve gateway-editor card geometry for varGet: missing-variable-inventory; no graph changes were written/,
  );
  assert.deepEqual(update.state.nodes, [original]);
  assert.equal(update.calls.filter((entry) => entry.method === '/api/setGraph').length, 0);
});

test('simplified creation uses filtered inventory order instead of props.did seed order', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('semantic catalogs offline');
  });
  const ghost = gatewayDevice({
    specV2Access: false,
    specV3Access: true,
    name: '不可访问设备'.repeat(8),
    roomName: '幽灵房间',
  });
  const first = gatewayDevice({
    name: '第一台可用库存设备',
    roomName: '甲',
  });
  const selected = gatewayDevice({
    name: '乙',
    roomName: '乙',
  });
  const inventory = {
    ghost,
    first,
    selected,
  };
  const gateway = layoutGateway([], {
    deviceListResponses: [inventory],
  });

  await addNode(
    {
      ruleId: 'rule1',
      shortcut: {
        type: 'deviceGet',
        id: 'inventoryOrder',
        deviceDid: 'selected',
        deviceProperty: 'name',
        propertyValue: 'abc',
        simplified: true,
      },
      getDeviceSpec: async () => structuredClone(spec),
      validate: false,
      varCheck: false,
    },
    gateway.deps,
  );

  const added = gateway.state.nodes[0];
  const expectedFirst = size(added, {
    specsByUrn: new Map([[urn, spec]]),
    devicesByDid: new Map([
      [
        'first',
        {
          did: 'first',
          name: first.name,
          roomName: first.roomName,
          modelName: first.modelName,
          deviceTypeDescription: 'test-device',
          urn,
        },
      ],
    ]),
  }).width;
  const expectedGhost = size(added, {
    specsByUrn: new Map([[urn, spec]]),
    devicesByDid: new Map([
      [
        'ghost',
        {
          did: 'ghost',
          name: ghost.name,
          roomName: ghost.roomName,
          modelName: ghost.modelName,
          deviceTypeDescription: 'test-device',
          urn,
        },
      ],
    ]),
  }).width;
  const expectedSelected = size(added, {
    specsByUrn: new Map([[urn, spec]]),
    devicesByDid: new Map([
      [
        'selected',
        {
          did: 'selected',
          name: selected.name,
          roomName: selected.roomName,
          modelName: selected.modelName,
          deviceTypeDescription: 'test-device',
          urn,
        },
      ],
    ]),
  }).width;
  assert.equal(added.props.did, 'selected');
  assert.equal(added.cfg.pos.width, expectedFirst);
  assert.notEqual(added.cfg.pos.width, expectedGhost);
  assert.notEqual(added.cfg.pos.width, expectedSelected);
  assert.equal(gateway.calls.filter((entry) => entry.method === '/api/getDevList').length, 1);
});
