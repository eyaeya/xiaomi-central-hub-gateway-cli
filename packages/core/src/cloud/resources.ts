// SPDX-License-Identifier: GPL-3.0-or-later
/** Native resource adapter informed by Do1e/mijia-api v5.0.0 (GPL-3.0). */
import type { z } from 'zod';
import {
  CloudActionResult,
  CloudConsumablesResult,
  CloudDevice,
  CloudDevicesResult,
  CloudHomesResult,
  CloudPropertiesResult,
  CloudRunSceneResult,
  CloudScenesResult,
  CloudSharedDevicesResult,
  CloudSpecResult,
  CloudStatisticsRequest,
  CloudStatisticsResult,
} from '../schemas/cloud.js';
import {
  ConfigError,
  GatewayError,
  NotConfirmedError,
  NotFoundError,
  SchemaError,
} from '../transport/errors.js';
import type { CloudTransport } from './transport.js';

export interface DeviceSelector {
  did?: string;
  name?: string;
  homeId?: string;
}
export interface PropertySelector {
  siid?: number;
  piid?: number;
  property?: string;
}
export interface ActionSelector {
  siid?: number;
  aiid?: number;
  action?: string;
  inputs?: unknown[];
}
export interface CloudProperty {
  siid: number;
  piid: number;
  name: string;
  serviceName: string;
  description: string;
  comment?: string;
  format: string;
  access: string[];
  unit?: string;
  valueRange?: [number, number, number];
  valueList?: {
    value: string | number | boolean;
    description: string;
    comment?: string | undefined;
  }[];
}
export interface CloudAction {
  siid: number;
  aiid: number;
  name: string;
  serviceName: string;
  description: string;
  comment?: string;
  inputs: CloudProperty[];
}
export type CloudDeviceSummary = z.infer<typeof CloudDevice> & {
  home?: string;
  room?: string;
  room_id?: string;
};
export interface CloudSpec {
  specType: string;
  properties: CloudProperty[];
  actions: CloudAction[];
}
export interface CloudDeviceSpec extends CloudSpec {
  device: CloudDeviceSummary;
}
export type CloudPropertyReadResult = z.infer<typeof CloudPropertiesResult>[number] & {
  status: 'ok' | 'accepted' | 'error';
  confirmed: boolean;
};
export interface CloudClientOptions {
  now?: () => number;
  /** Zero disables caching. Cached metadata never includes live property values. */
  deviceCacheTtlMs?: number;
  specCacheTtlMs?: number;
}
export type CloudReadSource = 'auto' | 'device' | 'cache';
export interface CloudReadOptions {
  /** auto prefers cloud cache; device requests a device RPC; cache never requests the device. */
  source?: CloudReadSource;
}
interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}
export interface CloudStatisticsParams {
  did: string;
  key: string;
  data_type: string;
  limit: number;
  time_start: number;
  time_end: number;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    // Zod diagnostics can contain input values; do not attach them to cloud errors.
    throw new SchemaError(`Cloud ${label} response does not match its schema`, { domain: 'cloud' });
  }
  return result.data;
}
function invalid(message: string): never {
  throw new ConfigError(message, { domain: 'cloud' });
}
function malformed(message: string): never {
  throw new SchemaError(message, { domain: 'cloud' });
}
function numericId(id: string): number {
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))
    invalid('Cloud home ID must be a safe integer');
  return Number(id);
}
function shortType(type: string): string {
  const name = type.split(':')[3];
  if (!name) return malformed('Cloud MIoT type has no semantic name');
  return name;
}
function status(code: number) {
  if (code !== 0 && code !== 1) {
    throw new GatewayError(`Cloud device operation failed (code ${code})`, {
      domain: 'cloud',
      cloudCode: code,
    });
  }
  return { status: code === 0 ? ('ok' as const) : ('accepted' as const), confirmed: code === 0 };
}
/** A mutation already sent cannot be declared failed from a malformed reply. */
function mutationResult<T>(parseResult: () => T): T {
  try {
    return parseResult();
  } catch (error) {
    if (
      error instanceof SchemaError ||
      error instanceof NotFoundError ||
      error instanceof ConfigError
    ) {
      throw new NotConfirmedError(
        'Cloud mutation was sent, but its result could not be confirmed; inspect device state before retrying',
        { domain: 'cloud' },
      );
    }
    throw error;
  }
}
function choose<T>(items: T[], label: string): T {
  if (!items.length) throw new NotFoundError(`Cloud ${label} was not found`, { domain: 'cloud' });
  if (items.length > 1)
    invalid(`Cloud ${label} is ambiguous; use an explicit ID or service-qualified name`);
  return items[0] as T;
}
function matchesName(
  item: { name: string; serviceName: string; siid: number },
  iid: number,
  name: string,
) {
  return (
    name === item.name ||
    name === `${item.serviceName}.${item.name}` ||
    name === `${item.siid}.${iid}`
  );
}
function validateFormat(property: CloudProperty, value: unknown): void {
  const format = property.format;
  let valid = false;
  if (format === 'bool') valid = typeof value === 'boolean';
  else if (format === 'string') valid = typeof value === 'string';
  else if (format === 'float' || format === 'double')
    valid = typeof value === 'number' && Number.isFinite(value);
  else {
    const int = /^(u?)int(8|16|32|64)?$/.exec(format);
    if (int && typeof value === 'number' && Number.isSafeInteger(value)) {
      const unsigned = int[1] === 'u';
      const bits = Number(int[2] ?? 32);
      const min = unsigned ? 0 : -(2 ** (bits - 1));
      const max = unsigned ? 2 ** bits - 1 : 2 ** (bits - 1) - 1;
      valid = value >= min && value <= max;
    }
  }
  if (!valid) invalid(`Value must match MIoT format ${format}`);
}
function validateValue(property: CloudProperty, value: unknown): void {
  validateFormat(property, value);
  if (property.valueList?.length && !property.valueList.some((option) => option.value === value)) {
    invalid('Value is not one of the MIoT property enumerated values');
  }
  if (property.valueRange) {
    const [min, max, step] = property.valueRange;
    if (typeof value !== 'number' || value < min || value > max)
      invalid('Value is outside the MIoT property range');
    if (step > 0) {
      const steps = (value - min) / step;
      if (Math.abs(steps - Math.round(steps)) > 1e-7)
        invalid('Value does not match the MIoT property step');
    }
  }
}

export class CloudClient {
  private readonly now: () => number;
  private readonly deviceCacheTtlMs: number;
  private readonly specCacheTtlMs: number;
  private homeCache: CacheEntry<z.infer<typeof CloudHomesResult>['homelist']> | undefined;
  private readonly deviceCache = new Map<string, CacheEntry<CloudDeviceSummary[]>>();
  private readonly specCache = new Map<string, CacheEntry<CloudSpec>>();

  constructor(
    private readonly transport: CloudTransport,
    options: CloudClientOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.deviceCacheTtlMs = options.deviceCacheTtlMs ?? 30_000;
    this.specCacheTtlMs = options.specCacheTtlMs ?? 300_000;
    for (const ttl of [this.deviceCacheTtlMs, this.specCacheTtlMs]) {
      if (!Number.isFinite(ttl) || ttl < 0) invalid('Cloud metadata cache TTL must be nonnegative');
    }
  }

  /** Force metadata discovery again; credentials and live device state are unaffected. */
  clearCache(): void {
    this.homeCache = undefined;
    this.deviceCache.clear();
    this.specCache.clear();
  }

  private cached<T>(entry: CacheEntry<T> | undefined): T | undefined {
    return entry && entry.expiresAt > this.now() ? structuredClone(entry.value) : undefined;
  }

  async listHomes() {
    const cached = this.cached(this.homeCache);
    if (cached !== undefined) return cached;
    const raw = await this.transport.request('/v2/homeroom/gethome_merged', {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      fetch_cariot: true,
      limit: 300,
      app_ver: 7,
      plat_form: 0,
    });
    const homes = parse(CloudHomesResult, raw, 'homes').homelist;
    this.homeCache = {
      expiresAt: this.now() + this.deviceCacheTtlMs,
      value: structuredClone(homes),
    };
    return homes;
  }

  private async homes(homeId?: string) {
    const homes = await this.listHomes();
    return homeId === undefined
      ? homes
      : [
          choose(
            homes.filter((home) => home.id === homeId),
            'home',
          ),
        ];
  }

  async listDevices(homeId?: string): Promise<CloudDeviceSummary[]> {
    const cacheKey = homeId === undefined ? 'all' : `home:${homeId}`;
    const cached = this.cached(this.deviceCache.get(cacheKey));
    if (cached !== undefined) return cached;
    const devices = new Map<string, CloudDeviceSummary>();
    for (const home of homeId === 'shared' ? [] : await this.homes(homeId)) {
      let cursor = '';
      const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 100) malformed('Cloud device pagination exceeded its page limit');
        const raw = await this.transport.request('/home/home_device_list', {
          home_owner: home.uid,
          home_id: numericId(home.id),
          limit: 200,
          start_did: cursor,
          get_split_device: true,
          support_smart_home: true,
          get_cariot_device: true,
          get_third_device: true,
        });
        const result = parse(CloudDevicesResult, raw, 'devices');
        for (const device of result.device_info) {
          if (!devices.has(device.did)) {
            const rooms = home.roomlist?.filter((room) => room.dids?.includes(device.did)) ?? [];
            // Conflicting room assignments are left unresolved instead of choosing a room.
            const room = rooms.length === 1 ? rooms[0] : undefined;
            devices.set(device.did, {
              ...device,
              home_id: home.id,
              home: home.name,
              ...(room ? { room: room.name, room_id: room.id } : {}),
            });
          }
        }
        if (!result.has_more) break;
        if (!result.max_did || seen.has(result.max_did))
          malformed('Cloud device pagination did not advance');
        cursor = result.max_did;
        seen.add(cursor);
      }
    }
    // Individual shares are not necessarily part of a listed home. When a home
    // filter is present, do not silently include devices outside that household.
    if (homeId === undefined || homeId === 'shared') {
      let cursor = '';
      const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 100) malformed('Cloud shared-device pagination exceeded its page limit');
        const raw = await this.transport.request('/v2/home/device_list_page', {
          limit: 200,
          ssid: '<unknown ssid>',
          bssid: '02:00:00:00:00:00',
          getVirtualModel: true,
          getHuamiDevices: 1,
          get_split_device: true,
          support_smart_home: true,
          get_cariot_device: true,
          get_third_device: true,
          get_phone_device: true,
          get_miwear_device: true,
          ...(cursor ? { start_did: cursor } : {}),
        });
        const result = parse(CloudSharedDevicesResult, raw, 'shared devices');
        for (const item of result.list) {
          if (item.owner && !devices.has(item.did)) {
            devices.set(item.did, { ...CloudDevice.parse(item), home_id: 'shared' });
          }
        }
        if (!result.has_more) break;
        if (!result.next_start_did || seen.has(result.next_start_did))
          malformed('Cloud shared-device pagination did not advance');
        cursor = result.next_start_did;
        seen.add(cursor);
      }
    }
    const result = [...devices.values()];
    this.deviceCache.set(cacheKey, {
      expiresAt: this.now() + this.deviceCacheTtlMs,
      value: structuredClone(result),
    });
    return result;
  }

  async resolveDevice(selector: DeviceSelector): Promise<CloudDeviceSummary> {
    if ((!selector.did && !selector.name) || (selector.did && selector.name)) {
      invalid('Select a cloud device using exactly one of did or name');
    }
    const devices = await this.listDevices(selector.homeId);
    return choose(
      devices.filter((device) =>
        selector.did ? device.did === selector.did : device.name === selector.name,
      ),
      'device',
    );
  }

  async deviceSpec(selector: DeviceSelector): Promise<CloudDeviceSpec> {
    const device = await this.resolveDevice(selector);
    if (!device.spec_type) invalid('This cloud device does not publish an MIoT spec');
    return { ...(await this.specByType(device.spec_type)), device };
  }

  /** Public MIoT metadata: does not enumerate homes or require cloud authorization. */
  async specByType(specType: string): Promise<CloudSpec> {
    if (!/^urn:miot-spec-v2:device:[a-zA-Z0-9:_-]+$/.test(specType))
      invalid('Expected a MIoT device spec URN');
    const cached = this.cached(this.specCache.get(specType));
    if (cached !== undefined) return cached;
    const raw = parse(CloudSpecResult, await this.transport.getSpec(specType), 'MIoT spec');
    if (raw.type !== specType) malformed('Cloud MIoT spec type does not match the selected device');
    const properties: CloudProperty[] = [];
    const actions: CloudAction[] = [];
    const serviceIds = new Set<number>();
    for (const service of raw.services) {
      if (serviceIds.has(service.iid)) malformed('Cloud MIoT spec contains duplicate service IDs');
      serviceIds.add(service.iid);
      const serviceName = shortType(service.type);
      const propertyIds = new Set<number>();
      for (const prop of service.properties) {
        if (propertyIds.has(prop.iid)) malformed('Cloud MIoT spec contains duplicate property IDs');
        propertyIds.add(prop.iid);
        properties.push({
          siid: service.iid,
          piid: prop.iid,
          serviceName,
          name: shortType(prop.type),
          description: prop.description,
          ...(prop.comment === undefined ? {} : { comment: prop.comment }),
          format: prop.format,
          access: prop.access,
          ...(prop.unit === undefined ? {} : { unit: prop.unit }),
          ...(prop['value-range'] === undefined ? {} : { valueRange: prop['value-range'] }),
          ...(prop['value-list'] === undefined ? {} : { valueList: prop['value-list'] }),
        });
      }
      const actionIds = new Set<number>();
      for (const action of service.actions) {
        if (actionIds.has(action.iid)) malformed('Cloud MIoT spec contains duplicate action IDs');
        actionIds.add(action.iid);
        const inputs = action.in.map((piid) => {
          const input = properties.find((prop) => prop.siid === service.iid && prop.piid === piid);
          if (!input) return malformed('Cloud MIoT action references a missing input property');
          return input;
        });
        actions.push({
          siid: service.iid,
          aiid: action.iid,
          serviceName,
          name: shortType(action.type),
          description: action.description,
          ...(action.comment === undefined ? {} : { comment: action.comment }),
          inputs,
        });
      }
    }
    const result = { specType, properties, actions };
    this.specCache.set(specType, {
      expiresAt: this.now() + this.specCacheTtlMs,
      value: structuredClone(result),
    });
    return result;
  }

  private property(spec: CloudDeviceSpec, selector: PropertySelector): CloudProperty {
    const numeric = selector.siid !== undefined || selector.piid !== undefined;
    if (
      (numeric && selector.property !== undefined) ||
      (!numeric && !selector.property) ||
      (numeric && (selector.siid === undefined || selector.piid === undefined))
    ) {
      invalid('Select a property with its name or both siid and piid');
    }
    return choose(
      spec.properties.filter((property) =>
        numeric
          ? property.siid === selector.siid && property.piid === selector.piid
          : matchesName(property, property.piid, selector.property as string),
      ),
      'property',
    );
  }

  async getProperty(
    selector: DeviceSelector,
    propertySelector: PropertySelector,
    options: CloudReadOptions = {},
  ) {
    const [result] = await this.getProperties(selector, [propertySelector], options);
    if (!result) return malformed('Cloud property response is missing');
    return { ...result, ...status(result.code) };
  }

  /** Read one device's requested properties (or all readable properties) in bounded batches. */
  async getProperties(
    selector: DeviceSelector,
    propertySelectors?: PropertySelector[],
    options: CloudReadOptions = {},
  ): Promise<CloudPropertyReadResult[]> {
    const source = options.source ?? 'auto';
    if (source !== 'auto' && source !== 'device' && source !== 'cache')
      invalid('Cloud read source must be auto, device or cache');
    const datasource = source === 'device' ? 2 : source === 'cache' ? 3 : 1;
    const spec = await this.deviceSpec(selector);
    if (propertySelectors?.length === 0) invalid('Select at least one cloud property');
    const properties = propertySelectors
      ? propertySelectors.map((property) => this.property(spec, property))
      : spec.properties.filter((property) => property.access.includes('read'));
    const identities = new Set<string>();
    for (const property of properties) {
      if (!property.access.includes('read')) {
        throw new ConfigError('This MIoT property is not readable', {
          domain: 'cloud',
          reason: 'property-not-readable',
        });
      }
      const key = `${property.siid}.${property.piid}`;
      if (identities.has(key)) invalid('Cloud property selection contains a duplicate');
      identities.add(key);
    }
    const output: CloudPropertyReadResult[] = [];
    // Keep requests modest even for large specs; no single-device failure is hidden.
    for (let offset = 0; offset < properties.length; offset += 20) {
      const batch = properties.slice(offset, offset + 20);
      const params = batch.map((property) => ({
        did: spec.device.did,
        siid: property.siid,
        piid: property.piid,
      }));
      const raw = await this.transport.request('/miotspec/prop/get', { params, datasource });
      const results = parse(CloudPropertiesResult, raw, 'property read');
      if (results.length !== params.length)
        malformed('Cloud property response has an unexpected item count');
      for (const property of batch) {
        const matched = results.filter(
          (item) =>
            item.did === spec.device.did &&
            item.siid === property.siid &&
            item.piid === property.piid,
        );
        if (matched.length !== 1)
          malformed('Cloud property response identity is missing, duplicated or unrelated');
        const result = matched[0];
        if (!result) return malformed('Cloud property response is missing');
        if (result.code === 0 && result.value === undefined)
          malformed('Cloud successful property read omitted its value');
        if ((result.code === 0 || result.code === 1) && result.value !== undefined) {
          try {
            validateFormat(property, result.value);
          } catch {
            malformed('Cloud property read value does not match its MIoT format');
          }
        }
        output.push({
          ...result,
          ...(result.code === 0 || result.code === 1
            ? status(result.code)
            : { status: 'error' as const, confirmed: false }),
        });
      }
    }
    return output;
  }

  async setProperty(selector: DeviceSelector, propertySelector: PropertySelector, value: unknown) {
    const spec = await this.deviceSpec(selector);
    const property = this.property(spec, propertySelector);
    if (!property.access.includes('write')) invalid('This MIoT property is not writable');
    validateValue(property, value);
    const params = { did: spec.device.did, siid: property.siid, piid: property.piid, value };
    const raw = await this.transport.request(
      '/miotspec/prop/set',
      { params: [params] },
      { mutation: true },
    );
    return mutationResult(() => {
      const results = parse(CloudPropertiesResult, raw, 'property write');
      if (results.length !== 1) malformed('Cloud property response has an unexpected item count');
      const result = choose(
        results.filter(
          (item) =>
            item.did === params.did && item.siid === params.siid && item.piid === params.piid,
        ),
        'property write response',
      );
      return { ...result, ...status(result.code) };
    });
  }

  async action(selector: DeviceSelector, actionSelector: ActionSelector) {
    const spec = await this.deviceSpec(selector);
    const numeric = actionSelector.siid !== undefined || actionSelector.aiid !== undefined;
    if (
      (numeric && actionSelector.action !== undefined) ||
      (!numeric && !actionSelector.action) ||
      (numeric && (actionSelector.siid === undefined || actionSelector.aiid === undefined))
    ) {
      invalid('Select an action with its name or both siid and aiid');
    }
    const action = choose(
      spec.actions.filter((item) =>
        numeric
          ? item.siid === actionSelector.siid && item.aiid === actionSelector.aiid
          : matchesName(item, item.aiid, actionSelector.action as string),
      ),
      'action',
    );
    const values = actionSelector.inputs ?? [];
    if (values.length !== action.inputs.length)
      invalid('Action input count does not match the MIoT spec');
    action.inputs.forEach((property, index) => validateValue(property, values[index]));
    const params = { did: spec.device.did, siid: action.siid, aiid: action.aiid, in: values };
    const raw = await this.transport.request('/miotspec/action', { params }, { mutation: true });
    return mutationResult(() => {
      const result = parse(CloudActionResult, raw, 'action');
      if (result.did !== params.did || result.siid !== params.siid || result.aiid !== params.aiid)
        malformed('Cloud action response identity did not match the request');
      return { ...result, ...status(result.code) };
    });
  }

  async listScenes(homeId?: string) {
    const scenes = [];
    for (const home of await this.homes(homeId)) {
      const raw = await this.transport.request(
        '/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList',
        {
          app_version: 12,
          get_type: 2,
          home_id: home.id,
          owner_uid: home.uid,
        },
      );
      scenes.push(
        ...parse(CloudScenesResult, raw, 'scenes').manual_scene_info_list.map((scene) => ({
          ...scene,
          home_id: home.id,
        })),
      );
    }
    return scenes;
  }

  async runScene(sceneId: string, homeId: string) {
    if (!sceneId) invalid('A cloud scene ID is required');
    const home = (await this.homes(homeId))[0];
    if (!home) return malformed('Cloud home lookup returned no home');
    // The server must confirm the scene belongs to this home before any mutation.
    choose(
      (await this.listScenes(homeId)).filter((scene) => scene.scene_id === sceneId),
      'scene',
    );
    const raw = await this.transport.request(
      '/appgateway/miot/appsceneservice/AppSceneService/NewRunScene',
      {
        scene_id: sceneId,
        scene_type: 2,
        phone_id: 'null',
        home_id: homeId,
        owner_uid: home.uid,
      },
      { mutation: true },
    );
    return mutationResult(() => {
      const result = parse(CloudRunSceneResult, raw, 'scene run');
      if (result === false)
        throw new GatewayError('Cloud scene run was rejected', { domain: 'cloud' });
      if (typeof result === 'object' && result.code !== undefined) status(result.code);
      // A successful submission does not establish the outcome of every scene action.
      return { scene_id: sceneId, home_id: homeId, status: 'accepted' as const, confirmed: false };
    });
  }

  async listConsumables(homeId?: string) {
    const items = [];
    for (const home of await this.homes(homeId)) {
      const raw = await this.transport.request('/v2/home/standard_consumable_items', {
        home_id: numericId(home.id),
        owner_id: home.uid,
        filter_ignore: true,
      });
      const result = parse(CloudConsumablesResult, raw, 'consumables');
      for (const group of result.items) {
        items.push(...group.consumes_data.map((item) => ({ ...item, home_id: home.id })));
      }
    }
    return items;
  }

  async statistics(params: CloudStatisticsParams) {
    const request = CloudStatisticsRequest.safeParse(params);
    if (!request.success) invalid('Invalid cloud statistics query (type, count or time range)');
    return parse(
      CloudStatisticsResult,
      await this.transport.request('/v2/user/statistics', request.data),
      'statistics',
    );
  }

  async speaker(selector: DeviceSelector, text: string, kind: 'run' | 'play', quiet = true) {
    if (!text.trim()) invalid('Speaker text must not be empty');
    return this.action(selector, {
      action: kind === 'run' ? 'execute-text-directive' : 'play-text',
      inputs: kind === 'run' ? [text, quiet ? 1 : 0] : [text],
    });
  }
}
