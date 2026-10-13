import { describe, expect, it, vi } from 'vitest';
import { CloudClient, type CloudClientOptions } from '../../../src/cloud/resources.js';
import type { CloudTransport } from '../../../src/cloud/transport.js';

const specType = 'urn:miot-spec-v2:device:light:0000A001:example-lamp:1';
function property(iid: number, name: string, format = 'bool', access = ['read', 'write']) {
  return {
    iid,
    type: `urn:miot-spec-v2:property:${name}:00000001:example:1`,
    description: name,
    format,
    access,
  };
}
function sampleSpec() {
  return {
    type: specType,
    description: 'Synthetic example light',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:light:00007802:example:1',
        description: 'Light',
        properties: [
          property(1, 'on'),
          { ...property(2, 'brightness', 'uint8'), 'value-range': [0, 100, 5] },
          property(3, 'temperature', 'float', ['read']),
          property(4, 'write-only', 'string', ['write']),
          {
            ...property(5, 'mode', 'uint8'),
            'value-list': [
              { value: 0, description: 'Idle' },
              { value: 2, description: 'Active' },
            ],
          },
          property(6, 'text', 'string', []),
          {
            ...property(7, 'quiet', 'uint8', []),
            'value-list': [
              { value: 0, description: 'Speak' },
              { value: 1, description: 'Quiet' },
            ],
          },
        ],
        actions: [
          {
            iid: 1,
            type: 'urn:miot-spec-v2:action:toggle:00002801:example:1',
            description: 'Toggle',
            in: [],
            out: [],
          },
          {
            iid: 2,
            type: 'urn:miot-spec-v2:action:execute-text-directive:00002801:example:1',
            description: 'Run',
            in: [6, 7],
            out: [],
          },
          {
            iid: 3,
            type: 'urn:miot-spec-v2:action:play-text:00002801:example:1',
            description: 'Play',
            in: [6],
            out: [],
          },
        ],
      },
    ],
  };
}
const sampleDevice = {
  did: 'device-demo',
  name: 'Example light',
  model: 'example.light.v1',
  isOnline: true,
  spec_type: specType,
};
function fake(options: CloudClientOptions = {}) {
  const responses: Record<string, unknown> = {
    '/v2/homeroom/gethome_merged': {
      homelist: [{ id: '101', uid: 42, name: 'Example home', roomlist: [] }],
    },
    '/home/home_device_list': {
      device_info: [
        {
          ...sampleDevice,
          token: 'secret-token',
          ssid: 'secret-network',
          latitude: 'secret-position',
        },
      ],
      has_more: false,
    },
    '/v2/home/device_list_page': { list: [] },
    '/miotspec/prop/get': [{ did: 'device-demo', siid: 2, piid: 1, code: 0, value: true }],
    '/miotspec/prop/set': [{ did: 'device-demo', siid: 2, piid: 1, code: 0 }],
    '/miotspec/action': { did: 'device-demo', siid: 2, aiid: 1, code: 0, out: [] },
    '/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList': {
      manual_scene_info_list: [{ scene_id: 'scene-demo', name: 'Example scene' }],
    },
    '/appgateway/miot/appsceneservice/AppSceneService/NewRunScene': true,
    '/v2/home/standard_consumable_items': {
      items: [
        {
          consumes_data: [
            {
              did: 'device-demo',
              name: 'Filter',
              details: [
                {
                  id: 'filter-demo',
                  description: 'Filter',
                  value: '80',
                  consumable_type: 'filter',
                },
              ],
            },
          ],
        },
      ],
    },
    '/v2/user/statistics': [{ time: 100, value: '[0.25]' }],
  };
  const spec = sampleSpec();
  const request = vi.fn(
    async (path: string, _body: Record<string, unknown>, _options?: { mutation?: boolean }) =>
      responses[path],
  );
  const getSpec = vi.fn(async () => spec);
  const transport: CloudTransport = { request, getSpec };
  return { client: new CloudClient(transport, options), request, getSpec, spec, responses };
}
const did = { did: 'device-demo' };
const on = { property: 'on' };

describe('CloudClient safe discovery', () => {
  it('preserves room membership and derives labels without exposing room metadata', async () => {
    const f = fake();
    f.responses['/v2/homeroom/gethome_merged'] = {
      homelist: [
        {
          id: '101',
          uid: 42,
          name: 'Example home',
          roomlist: [{ id: '201', name: 'Study', dids: ['device-demo'], address: 'private' }],
        },
      ],
    };
    expect(await f.client.listDevices('101')).toEqual([
      {
        ...sampleDevice,
        home_id: '101',
        home: 'Example home',
        room_id: '201',
        room: 'Study',
      },
    ]);
    expect(JSON.stringify(await f.client.listHomes())).not.toContain('private');
  });
  it('does not invent a room for conflicting or absent room membership', async () => {
    const f = fake();
    f.responses['/v2/homeroom/gethome_merged'] = {
      homelist: [
        {
          id: '101',
          uid: 42,
          name: 'Example home',
          roomlist: [
            { id: '201', name: 'First', dids: ['device-demo'] },
            { id: '202', name: 'Second', dids: ['device-demo'] },
            { id: '203', name: 'Empty', dids: null },
          ],
        },
      ],
    };
    expect((await f.client.listDevices())[0]).not.toHaveProperty('room');
  });
  it('strips secrets and location from homes, rooms and device summaries', async () => {
    const f = fake();
    f.responses['/v2/homeroom/gethome_merged'] = {
      homelist: [
        {
          id: '101',
          uid: 42,
          name: 'Example home',
          latitude: 1,
          address: 'private',
          roomlist: [{ id: '201', name: 'Room', bssid: 'private' }],
        },
      ],
    };
    const homes = await f.client.listHomes();
    expect(homes).toEqual([
      { id: '101', uid: 42, name: 'Example home', roomlist: [{ id: '201', name: 'Room' }] },
    ]);
    expect(await f.client.listDevices()).toEqual([
      { ...sampleDevice, home_id: '101', home: 'Example home' },
    ]);
  });
  it('includes individual shares, deduplicates them, and removes the owner marker', async () => {
    const f = fake();
    f.responses['/v2/home/device_list_page'] = {
      list: [
        { ...sampleDevice, owner: { uid: 7 } },
        { ...sampleDevice, did: 'shared-demo', owner: { uid: 7 }, token: 'private' },
        { ...sampleDevice, did: 'unshared-demo' },
      ],
    };
    expect(await f.client.listDevices()).toEqual([
      { ...sampleDevice, home_id: '101', home: 'Example home' },
      { ...sampleDevice, did: 'shared-demo', home_id: 'shared' },
    ]);
  });
  it('keeps explicit home filters isolated from individual shares', async () => {
    const f = fake();
    await f.client.listDevices('101');
    expect(f.request.mock.calls.some(([path]) => path === '/v2/home/device_list_page')).toBe(false);
    await expect(f.client.listDevices('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('supports the explicit shared pseudo-home without loading homes', async () => {
    const f = fake();
    f.responses['/v2/home/device_list_page'] = { list: [{ ...sampleDevice, owner: true }] };
    expect(await f.client.listDevices('shared')).toHaveLength(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('follows pagination and rejects stuck cursors', async () => {
    const f = fake();
    f.responses['/home/home_device_list'] = {
      device_info: [sampleDevice],
      has_more: true,
      max_did: 'cursor-demo',
    };
    await expect(f.client.listDevices('101')).rejects.toMatchObject({ code: 'SCHEMA' });
    expect(f.request.mock.calls.filter(([path]) => path === '/home/home_device_list')).toHaveLength(
      2,
    );
  });
  it('uses next_start_did for shared-device pagination and retains later pages', async () => {
    const f = fake();
    f.request.mockImplementation(async (path, body) =>
      path === '/v2/home/device_list_page'
        ? body.start_did
          ? { list: [{ ...sampleDevice, did: 'shared-second-demo', owner: true }], has_more: false }
          : {
              list: [{ ...sampleDevice, owner: true }],
              has_more: true,
              next_start_did: 'next-demo',
            }
        : f.responses[path],
    );
    expect((await f.client.listDevices('shared')).map((device) => device.did)).toEqual([
      'device-demo',
      'shared-second-demo',
    ]);
    expect(f.request).toHaveBeenLastCalledWith(
      '/v2/home/device_list_page',
      expect.objectContaining({ start_did: 'next-demo', limit: 200 }),
    );
  });
  it('requires unique exact device names and rejects conflicting selectors', async () => {
    const f = fake();
    f.responses['/home/home_device_list'] = {
      device_info: [sampleDevice, { ...sampleDevice, did: 'other-demo' }],
    };
    await expect(f.client.deviceSpec({ name: sampleDevice.name })).rejects.toMatchObject({
      code: 'CONFIG',
    });
    await expect(f.client.deviceSpec({ ...did, name: sampleDevice.name })).rejects.toMatchObject({
      code: 'CONFIG',
    });
    await expect(f.client.deviceSpec({ name: 'absent' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('reports malformed responses without response values in diagnostics', async () => {
    const f = fake();
    f.responses['/home/home_device_list'] = {
      device_info: [{ did: 'private', name: { token: 'secret-token' } }],
    };
    try {
      await f.client.listDevices();
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'SCHEMA', details: { domain: 'cloud' } });
      expect(JSON.stringify(error)).not.toContain('secret-token');
    }
  });
});

describe('CloudClient metadata caching and public specs', () => {
  it('queries public specs without credentials or device discovery and preserves comments', async () => {
    const f = fake();
    Object.assign(f.spec.services[0]?.properties[0] ?? {}, { comment: '开关' });
    Object.assign(f.spec.services[0]?.actions[0] ?? {}, { comment: '切换' });
    const spec = await f.client.specByType(specType);
    expect(spec.properties[0]).toHaveProperty('comment', '开关');
    expect(spec.actions[0]).toHaveProperty('comment', '切换');
    expect(spec).not.toHaveProperty('device');
    expect(f.request).not.toHaveBeenCalled();
    await expect(f.client.specByType('../invalid')).rejects.toMatchObject({ code: 'CONFIG' });
    expect(f.getSpec).toHaveBeenCalledTimes(1);
  });
  it('caches metadata within TTL, refreshes on expiry, and never caches property values', async () => {
    let now = 0;
    const f = fake({ now: () => now, deviceCacheTtlMs: 100, specCacheTtlMs: 200 });
    await f.client.getProperty(did, on);
    f.responses['/miotspec/prop/get'] = [
      { did: 'device-demo', siid: 2, piid: 1, code: 0, value: false },
    ];
    await expect(f.client.getProperty(did, on)).resolves.toHaveProperty('value', false);
    expect(f.getSpec).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.filter(([path]) => path === '/home/home_device_list')).toHaveLength(
      1,
    );
    expect(f.request.mock.calls.filter(([path]) => path === '/miotspec/prop/get')).toHaveLength(2);
    now = 100;
    await f.client.getProperty(did, on);
    expect(f.request.mock.calls.filter(([path]) => path === '/home/home_device_list')).toHaveLength(
      2,
    );
    expect(f.getSpec).toHaveBeenCalledTimes(1);
    now = 200;
    await f.client.getProperty(did, on);
    expect(f.getSpec).toHaveBeenCalledTimes(2);
    f.client.clearCache();
    await f.client.getProperty(did, on);
    expect(f.getSpec).toHaveBeenCalledTimes(3);
  });
  it('isolates returned metadata mutations and keeps filtered discovery cache keys separate', async () => {
    const f = fake();
    const devices = await f.client.listDevices();
    Object.assign(devices[0] ?? {}, { did: 'wrong-demo' });
    const spec = await f.client.specByType(specType);
    spec.properties.length = 0;
    expect((await f.client.listDevices())[0]?.did).toBe('device-demo');
    expect((await f.client.specByType(specType)).properties.length).toBeGreaterThan(0);
    await expect(f.client.listDevices('*')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('allows disabling caches and rejects invalid TTL values', async () => {
    const f = fake({ deviceCacheTtlMs: 0, specCacheTtlMs: 0 });
    await f.client.deviceSpec(did);
    await f.client.deviceSpec(did);
    expect(f.getSpec).toHaveBeenCalledTimes(2);
    expect(() => fake({ deviceCacheTtlMs: -1 })).toThrow();
    expect(() => fake({ specCacheTtlMs: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe('CloudClient batch property reads', () => {
  it.each([
    ['auto', 1],
    ['device', 2],
    ['cache', 3],
  ] as const)(
    'maps %s reads to datasource %s without changing the returned evidence',
    async (source, datasource) => {
      const f = fake();
      await f.client.getProperty(did, on, { source });
      expect(f.request).toHaveBeenLastCalledWith('/miotspec/prop/get', {
        params: [{ did: 'device-demo', siid: 2, piid: 1 }],
        datasource,
      });
    },
  );
  it('does not silently fall back to a cache after a direct device-read failure', async () => {
    const f = fake();
    f.responses['/miotspec/prop/get'] = [{ did: 'device-demo', siid: 2, piid: 1, code: -4001 }];
    await expect(f.client.getProperty(did, on, { source: 'device' })).rejects.toMatchObject({
      code: 'GATEWAY',
    });
    expect(f.request.mock.calls.filter(([path]) => path === '/miotspec/prop/get')).toHaveLength(1);
    expect(f.request).toHaveBeenLastCalledWith(
      '/miotspec/prop/get',
      expect.objectContaining({ datasource: 2 }),
    );
  });
  it('orders reordered responses by request and preserves independent failures and update time', async () => {
    const f = fake();
    f.responses['/miotspec/prop/get'] = [
      { did: 'device-demo', siid: 2, piid: 2, code: -4001 },
      { did: 'device-demo', siid: 2, piid: 1, code: 0, value: true, updateTime: 100 },
    ];
    expect(await f.client.getProperties(did, [on, { property: 'brightness' }])).toEqual([
      {
        did: 'device-demo',
        siid: 2,
        piid: 1,
        code: 0,
        value: true,
        updateTime: 100,
        status: 'ok',
        confirmed: true,
      },
      { did: 'device-demo', siid: 2, piid: 2, code: -4001, status: 'error', confirmed: false },
    ]);
  });
  it('keeps the single-property failure contract and distinguishes accepted from a value', async () => {
    const f = fake();
    f.responses['/miotspec/prop/get'] = [{ did: 'device-demo', siid: 2, piid: 1, code: -4001 }];
    await expect(f.client.getProperty(did, on)).rejects.toMatchObject({ code: 'GATEWAY' });
    f.responses['/miotspec/prop/get'] = [{ did: 'device-demo', siid: 2, piid: 1, code: 1 }];
    expect(await f.client.getProperties(did, [on])).toEqual([
      { did: 'device-demo', siid: 2, piid: 1, code: 1, status: 'accepted', confirmed: false },
    ]);
  });
  it('defaults to readable properties only and limits each request to twenty properties', async () => {
    const f = fake();
    const service = f.spec.services[0];
    if (!service) throw new Error('missing test service');
    service.properties = Array.from({ length: 21 }, (_, index) => property(index + 1, `p${index}`));
    service.properties.push(property(22, 'hidden', 'string', ['write']));
    service.actions = [];
    f.request.mockImplementation(async (path, body) =>
      path === '/miotspec/prop/get'
        ? (body.params as { did: string; siid: number; piid: number }[]).map((param) => ({
            ...param,
            code: 0,
            value: true,
          }))
        : f.responses[path],
    );
    const values = await f.client.getProperties(did);
    expect(values).toHaveLength(21);
    expect(
      f.request.mock.calls
        .filter(([path]) => path === '/miotspec/prop/get')
        .map(([, body]) => (body.params as unknown[]).length),
    ).toEqual([20, 1]);
  });
  it('rejects duplicate selectors and unreadable properties before sending requests', async () => {
    const f = fake();
    await expect(f.client.getProperties(did, [on, { siid: 2, piid: 1 }])).rejects.toMatchObject({
      code: 'CONFIG',
    });
    await expect(f.client.getProperties(did, [])).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(f.client.getProperties(did, [{ property: 'write-only' }])).rejects.toMatchObject({
      code: 'CONFIG',
      details: { reason: 'property-not-readable' },
    });
    expect(f.request.mock.calls.some(([path]) => path === '/miotspec/prop/get')).toBe(false);
  });
  it.each(
    [
      [
        { did: 'device-demo', siid: 2, piid: 1, code: 0, value: true },
        { did: 'device-demo', siid: 2, piid: 1, code: -4001 },
      ],
      [
        { did: 'wrong-demo', siid: 2, piid: 1, code: -4001 },
        { did: 'device-demo', siid: 2, piid: 2, code: 0, value: 20 },
      ],
      [{ did: 'device-demo', siid: 2, piid: 1, code: 0, value: true }],
    ].map((raw) => ({ raw })),
  )('rejects missing, duplicate and unrelated response identities ($raw)', async ({ raw }) => {
    const f = fake();
    f.responses['/miotspec/prop/get'] = raw;
    await expect(
      f.client.getProperties(did, [on, { property: 'brightness' }]),
    ).rejects.toMatchObject({ code: 'SCHEMA' });
  });
});

describe('CloudClient MIoT properties', () => {
  it('resolves semantic or numeric names and sends a live property read', async () => {
    const f = fake();
    expect(await f.client.getProperty(did, { property: 'light.on' })).toMatchObject({
      value: true,
      status: 'ok',
      confirmed: true,
    });
    expect(f.request).toHaveBeenLastCalledWith('/miotspec/prop/get', {
      params: [{ did: 'device-demo', siid: 2, piid: 1 }],
      datasource: 1,
    });
    await expect(f.client.getProperty(did, { property: '2.1' })).resolves.toHaveProperty(
      'value',
      true,
    );
    await expect(f.client.getProperty(did, { siid: 2, piid: 1 })).resolves.toHaveProperty(
      'value',
      true,
    );
  });
  it('rejects ambiguous names while service-qualified and numeric IDs disambiguate', async () => {
    const f = fake();
    f.spec.services.push({
      iid: 3,
      type: 'urn:miot-spec-v2:service:night-light:00007802:example:1',
      description: 'Night light',
      properties: [property(1, 'on')],
      actions: [],
    });
    await expect(f.client.getProperty(did, on)).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(f.client.getProperty(did, { property: 'light.on' })).resolves.toHaveProperty(
      'value',
      true,
    );
  });
  it.each([
    [{ property: 'on' }, 'true'],
    [{ property: 'brightness' }, 101],
    [{ property: 'brightness' }, 12],
    [{ property: 'brightness' }, -5],
    [{ property: 'brightness' }, 20.5],
    [{ property: 'mode' }, 1],
    [{ property: 'temperature' }, 22],
  ])(
    'rejects type, range, step, enum and access violations before mutation (%j)',
    async (selector, value) => {
      const f = fake();
      await expect(f.client.setProperty(did, selector, value)).rejects.toMatchObject({
        code: 'CONFIG',
      });
      expect(f.request.mock.calls.some(([, , options]) => options?.mutation)).toBe(false);
    },
  );
  it('tags write-only read failures for CLI audit snapshots', async () => {
    const f = fake();
    await expect(f.client.getProperty(did, { property: 'write-only' })).rejects.toMatchObject({
      code: 'CONFIG',
      details: { reason: 'property-not-readable' },
    });
  });
  it('marks writes mutation and reports code 1 as accepted but not confirmed', async () => {
    const f = fake();
    f.responses['/miotspec/prop/set'] = [{ did: 'device-demo', siid: 2, piid: 1, code: 1 }];
    expect(await f.client.setProperty(did, on, false)).toMatchObject({
      status: 'accepted',
      confirmed: false,
      code: 1,
    });
    expect(f.request).toHaveBeenLastCalledWith(
      '/miotspec/prop/set',
      { params: [{ did: 'device-demo', siid: 2, piid: 1, value: false }] },
      { mutation: true },
    );
  });
  it('fails every nonzero/nonaccepted item and never repeats a write', async () => {
    const f = fake();
    f.responses['/miotspec/prop/set'] = [{ did: 'device-demo', siid: 2, piid: 1, code: -4001 }];
    await expect(f.client.setProperty(did, on, false)).rejects.toMatchObject({
      code: 'GATEWAY',
      details: { domain: 'cloud', cloudCode: -4001 },
    });
    expect(f.request.mock.calls.filter(([path]) => path === '/miotspec/prop/set')).toHaveLength(1);
  });
  it.each([
    [{ did: 'wrong-demo', siid: 2, piid: 1, code: 0, value: true }],
    [{ did: 'device-demo', siid: 2, piid: 1, code: 0 }],
    [],
  ])('does not invent values or accept an unrelated response', async (...args) => {
    const f = fake();
    f.responses['/miotspec/prop/get'] = args;
    await expect(f.client.getProperty(did, on)).rejects.toBeDefined();
  });
  it.each(
    [
      null,
      [],
      [{ did: 'wrong-demo', siid: 2, piid: 1, code: 0 }],
      [
        { did: 'device-demo', siid: 2, piid: 1, code: 0 },
        { did: 'other-demo', siid: 2, piid: 1, code: 0 },
      ],
    ].map((raw) => ({ raw })),
  )('reports uncertain writes for malformed or mismatched responses ($raw)', async ({ raw }) => {
    const f = fake();
    f.responses['/miotspec/prop/set'] = raw;
    await expect(f.client.setProperty(did, on, false)).rejects.toMatchObject({
      code: 'NOT_CONFIRMED',
      details: { domain: 'cloud' },
    });
    expect(f.request.mock.calls.filter(([path]) => path === '/miotspec/prop/set')).toHaveLength(1);
  });
  it('rejects a read value with the wrong MIoT type, without treating sensor ranges as read limits', async () => {
    const f = fake();
    f.responses['/miotspec/prop/get'] = [
      { did: 'device-demo', siid: 2, piid: 1, code: 0, value: 'true' },
    ];
    await expect(f.client.getProperty(did, on)).rejects.toMatchObject({ code: 'SCHEMA' });
    f.responses['/miotspec/prop/get'] = [
      { did: 'device-demo', siid: 2, piid: 2, code: 0, value: 110 },
    ];
    await expect(f.client.getProperty(did, { property: 'brightness' })).resolves.toHaveProperty(
      'value',
      110,
    );
  });
  it('rejects extra response identities before interpreting their error codes', async () => {
    const f = fake();
    f.responses['/miotspec/prop/get'] = [
      { did: 'device-demo', siid: 2, piid: 1, code: 0, value: true },
      { did: 'other-demo', siid: 2, piid: 1, code: -4001 },
    ];
    await expect(f.client.getProperty(did, on)).rejects.toMatchObject({ code: 'SCHEMA' });
  });
  it('rejects a mismatched spec and missing action input definitions', async () => {
    const f = fake();
    f.spec.type = 'urn:other';
    await expect(f.client.deviceSpec(did)).rejects.toMatchObject({ code: 'SCHEMA' });
    f.spec.type = specType;
    f.spec.services[0]?.actions.push({
      iid: 9,
      type: 'urn:miot-spec-v2:action:broken:00002801:example:1',
      description: 'Broken',
      in: [99],
      out: [],
    });
    await expect(f.client.deviceSpec(did)).rejects.toMatchObject({ code: 'SCHEMA' });
  });
});

describe('CloudClient actions and other resources', () => {
  it('validates action inputs and uses MIoT in (not value)', async () => {
    const f = fake();
    await expect(f.client.action(did, { action: 'toggle', inputs: [true] })).rejects.toMatchObject({
      code: 'CONFIG',
    });
    await expect(
      f.client.action(did, { action: 'execute-text-directive', inputs: ['hello', 2] }),
    ).rejects.toMatchObject({ code: 'CONFIG' });
    expect(await f.client.action(did, { action: 'toggle' })).toMatchObject({
      status: 'ok',
      confirmed: true,
    });
    expect(f.request).toHaveBeenLastCalledWith(
      '/miotspec/action',
      { params: { did: 'device-demo', siid: 2, aiid: 1, in: [] } },
      { mutation: true },
    );
  });
  it('speaker run/play resolves the real spec action and validates quiet input', async () => {
    const f = fake();
    f.responses['/miotspec/action'] = { did: 'device-demo', siid: 2, aiid: 2, code: 1 };
    await expect(f.client.speaker(did, 'Turn on the light', 'run')).resolves.toHaveProperty(
      'confirmed',
      false,
    );
    expect(f.request).toHaveBeenLastCalledWith(
      '/miotspec/action',
      { params: { did: 'device-demo', siid: 2, aiid: 2, in: ['Turn on the light', 1] } },
      { mutation: true },
    );
    f.responses['/miotspec/action'] = { did: 'device-demo', siid: 2, aiid: 3, code: 0 };
    await f.client.speaker(did, 'Hello', 'play');
    expect(f.request).toHaveBeenLastCalledWith(
      '/miotspec/action',
      { params: { did: 'device-demo', siid: 2, aiid: 3, in: ['Hello'] } },
      { mutation: true },
    );
  });
  it('does not claim all scene effects completed after submission', async () => {
    const f = fake();
    expect(await f.client.runScene('scene-demo', '101')).toEqual({
      scene_id: 'scene-demo',
      home_id: '101',
      status: 'accepted',
      confirmed: false,
    });
    expect(f.request).toHaveBeenLastCalledWith(
      '/appgateway/miot/appsceneservice/AppSceneService/NewRunScene',
      { scene_id: 'scene-demo', scene_type: 2, phone_id: 'null', home_id: '101', owner_uid: 42 },
      { mutation: true },
    );
    await expect(f.client.runScene('missing', '101')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.responses['/appgateway/miot/appsceneservice/AppSceneService/NewRunScene'] = false;
    await expect(f.client.runScene('scene-demo', '101')).rejects.toMatchObject({ code: 'GATEWAY' });
  });
  it('reports an unrelated negative write response as unknown for the intended target', async () => {
    const f = fake();
    f.responses['/miotspec/prop/set'] = [{ did: 'wrong-demo', siid: 2, piid: 1, code: -4001 }];
    await expect(f.client.setProperty(did, on, false)).rejects.toMatchObject({
      code: 'NOT_CONFIRMED',
    });
    f.responses['/miotspec/action'] = { did: 'wrong-demo', siid: 2, aiid: 1, code: -4001 };
    await expect(f.client.action(did, { action: 'toggle' })).rejects.toMatchObject({
      code: 'NOT_CONFIRMED',
    });
  });
  it('does not imply failure or completion from unknown action and scene acknowledgements', async () => {
    const f = fake();
    f.responses['/miotspec/action'] = { did: 'wrong-demo', siid: 2, aiid: 1, code: 0 };
    await expect(f.client.action(did, { action: 'toggle' })).rejects.toMatchObject({
      code: 'NOT_CONFIRMED',
    });
    f.responses['/appgateway/miot/appsceneservice/AppSceneService/NewRunScene'] = {};
    await expect(f.client.runScene('scene-demo', '101')).rejects.toMatchObject({
      code: 'NOT_CONFIRMED',
    });
  });
  it('returns consumables from every group and strips unrelated metadata', async () => {
    const f = fake();
    f.responses['/v2/home/standard_consumable_items'] = {
      items: [
        {
          consumes_data: [
            {
              did: 'device-demo',
              name: 'Filter',
              token: 'private',
              details: { value: '80', location: 'private' },
            },
          ],
        },
        { consumes_data: [{ did: 'other-demo', name: 'Battery' }] },
      ],
    };
    expect(await f.client.listConsumables('101')).toEqual([
      { did: 'device-demo', name: 'Filter', home_id: '101', details: { value: '80' } },
      { did: 'other-demo', name: 'Battery', home_id: '101' },
    ]);
  });
  it('validates bounded statistics queries and preserves values as data', async () => {
    const f = fake();
    const query = {
      did: 'device-demo',
      key: '2.1',
      data_type: 'stat_day_v3',
      limit: 10,
      time_start: 0,
      time_end: 100,
    };
    expect(await f.client.statistics(query)).toEqual([{ value: '[0.25]', time: 100 }]);
    await expect(f.client.statistics({ ...query, time_start: 101 })).rejects.toMatchObject({
      code: 'CONFIG',
    });
    await expect(f.client.statistics({ ...query, limit: 0 })).rejects.toMatchObject({
      code: 'CONFIG',
    });
  });
});
