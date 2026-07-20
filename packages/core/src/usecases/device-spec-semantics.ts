import type {
  DeviceSpec,
  MiotAction,
  MiotEvent,
  MiotProperty,
  MiotService,
} from '../schemas/device-spec.js';

export type DeviceSpecSemanticFetch = typeof fetch;

export type DeviceSpecSemanticCatalogName =
  | 'multi-language'
  | 'property-value-normalization'
  | 'service-template'
  | 'property-template'
  | 'event-template'
  | 'action-template'
  | 'device-template';

export interface DeviceSpecSemanticCatalogStatus {
  catalog: DeviceSpecSemanticCatalogName;
  status: 'loaded' | 'fallback';
  reason?: 'http' | 'invalid-content' | 'network' | 'timeout';
  httpStatus?: number;
}

export interface SemanticDevicePropertyValue {
  value: number | boolean;
  description: string;
}

export interface SemanticDeviceProperty {
  siid: number;
  piid: number;
  sUrn: string;
  urn: string;
  sDescription: string;
  description: string;
  format: string;
  dtype: 'string' | 'boolean' | 'float' | 'int';
  access: Array<'read' | 'write' | 'notify'>;
  proprietary: boolean;
  rawUnit?: string;
  unit?: string;
  valueRange?: { min: number; max: number; step: number };
  valueList?: SemanticDevicePropertyValue[];
}

export type SemanticDevicePropertyReference =
  | { resolved: true; piid: number; property: SemanticDeviceProperty }
  | { resolved: false; piid: number };

export interface SemanticDeviceEvent {
  siid: number;
  eiid: number;
  sUrn: string;
  urn: string;
  sDescription: string;
  description: string;
  proprietary: boolean;
  arguments: SemanticDevicePropertyReference[];
}

export type SemanticDeviceActionOutputMetadata = SemanticDevicePropertyReference & {
  bindable: false;
};

export interface SemanticDeviceAction {
  siid: number;
  aiid: number;
  sUrn: string;
  urn: string;
  sDescription: string;
  description: string;
  proprietary: boolean;
  inputs: SemanticDevicePropertyReference[];
  /** MIoT action.out metadata; gateway deviceOutput cards expose no matching graph pin. */
  outMetadata: SemanticDeviceActionOutputMetadata[];
}

export interface SemanticDeviceExcludedService {
  siid: number;
  urn: string;
  description: string;
  reason: 'device-information-not-automatable';
}

export interface SemanticDeviceType {
  urn: string;
  deviceType: string;
  deviceTypeDescription: string;
}

export interface SemanticDeviceTypesProjection {
  locale: 'zh_cn';
  deviceTypes: SemanticDeviceType[];
  catalogs: DeviceSpecSemanticCatalogStatus[];
}

export interface SemanticDeviceSpecProjection {
  urn: string;
  description: string;
  deviceType: string;
  deviceTypeDescription: string;
  locale: 'zh_cn';
  propertyNotify: SemanticDeviceProperty[];
  propertyGet: SemanticDeviceProperty[];
  propertySet: SemanticDeviceProperty[];
  events: SemanticDeviceEvent[];
  actions: SemanticDeviceAction[];
  excludedServices: SemanticDeviceExcludedService[];
  catalogs: DeviceSpecSemanticCatalogStatus[];
}

export interface ProjectDeviceSpecSemanticsOptions {
  fetch?: DeviceSpecSemanticFetch;
  timeoutMs?: number;
  cache?: DeviceSpecSemanticCache;
}

interface CatalogLoad {
  values: Map<string, string>;
  status: DeviceSpecSemanticCatalogStatus;
}

interface SemanticFetchCacheState {
  resolved: Map<string, CatalogLoad>;
  inFlight: Map<string, Promise<CatalogLoad>>;
}

interface SemanticCacheState {
  byFetch: WeakMap<DeviceSpecSemanticFetch, SemanticFetchCacheState>;
}

const cacheStates = new WeakMap<DeviceSpecSemanticCache, SemanticCacheState>();

/** Process-local request cache. Pass an explicit instance to control test/request isolation. */
export class DeviceSpecSemanticCache {
  constructor() {
    cacheStates.set(this, { byFetch: new WeakMap() });
  }

  clear(): void {
    cacheStates.set(this, { byFetch: new WeakMap() });
  }
}

const cachesByFetch = new WeakMap<DeviceSpecSemanticFetch, DeviceSpecSemanticCache>();

const DEFAULT_TIMEOUT_MS = 5000;
const MULTI_LANGUAGE_URL = 'https://miot-spec.org/instance/v2/multiLanguage';
const CATALOG_URLS = {
  values: 'https://miot-spec.org/miot-spec-v2/normalization/list/property_value',
  services: 'https://miot-spec.org/miot-spec-v2/template/list/service',
  properties: 'https://miot-spec.org/miot-spec-v2/template/list/property',
  events: 'https://miot-spec.org/miot-spec-v2/template/list/event',
  actions: 'https://miot-spec.org/miot-spec-v2/template/list/action',
  devices: 'https://miot-spec.org/miot-spec-v2/template/list/device',
} as const;

const UNIT_LABELS: Readonly<Record<string, string>> = {
  seconds: '秒',
  minutes: '分',
  pascal: 'Pa',
  percentage: '%',
  days: '天',
  ppm: 'ppm',
  rgb: 'RGB(十进制)',
  kelvin: 'K',
  hours: '小时',
  L: 'L',
  watt: 'W',
  metre: 'm',
  'mg/m3': 'mg/m³',
  lux: 'lux',
  arcdegrees: '°',
  celsius: '℃',
};

const BOOL_LABELS: Readonly<Record<string, Readonly<{ true: string; false: string }>>> = {
  'urn:miot-spec-v2:property:air-cooler:000000EB': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:alarm:00000012': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:anion:00000025': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:anti-fake:00000130': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:arrhythmia:000000B4': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:auto-cleanup:00000124': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:auto-deodorization:00000125': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:auto-keep-warm:0000002B': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:automatic-feeding:000000F0': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:blow:000000CD': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:card-insertion-state:00000106': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:contact-state:0000007C': { true: '接触', false: '分离' },
  'urn:miot-spec-v2:property:current-physical-control-lock:00000099': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:delay:0000014F': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:deodorization:000000C6': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:dns-auto-mode:000000DC': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:driving-status:000000B9': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:dryer:00000027': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:eco:00000024': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:glimmer-full-color:00000089': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:guard-mode:000000B6': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:heater:00000026': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:heating:000000C7': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:horizontal-swing:00000017': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:hot-water-recirculation:0000011C': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:image-distortion-correction:0000010F': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:local-storage:0000011E': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:motion-detection:00000056': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:motion-state:0000007D': { true: '有人', false: '无人' },
  'urn:miot-spec-v2:property:motion-tracking:0000008A': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:motor-reverse:00000072': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:off-delay:00000053': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:on:00000006': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:physical-controls-locked:0000001D': {
    true: '开启',
    false: '关闭',
  },
  'urn:miot-spec-v2:property:plasma:00000132': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:preheat:00000103': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:seating-state:000000B8': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:silent-execution:000000FB': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:sleep-aid-mode:0000010B': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:sleep-mode:00000028': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:snore-state:0000012A': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:soft-wind:000000CF': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:speed-control:000000E8': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:submersion-state:0000007E': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:time-watermark:00000087': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:un-straight-blowing:00000100': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:uv:00000029': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:valve-switch:000000FE': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:ventilation:000000CE': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:vertical-swing:00000018': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wake-up-mode:00000107': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:water-pump:000000F2': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:watering:000000CC': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wdr-mode:00000088': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wet:0000002A': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wifi-band-combine:000000E0': { true: '开启', false: '关闭' },
  'urn:miot-spec-v2:property:wifi-ssid-hidden:000000E3': { true: '是', false: '否' },
  'urn:miot-spec-v2:property:wind-reverse:00000117': { true: '是', false: '否' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalUrn(urn: string): string {
  return urn.split(':').slice(0, 5).join(':');
}

function shortName(urn: string): string {
  return urn.split(':')[3] ?? urn;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseTemplateCatalog(raw: unknown): Map<string, string> {
  if (!isRecord(raw) || !Array.isArray(raw.result)) throw new Error('invalid template catalog');
  const result = new Map<string, string>();
  for (const entry of raw.result) {
    if (!isRecord(entry) || !nonEmptyString(entry.type) || !isRecord(entry.description)) continue;
    const description = entry.description.zh_cn;
    if (nonEmptyString(description)) result.set(entry.type, description);
  }
  return result;
}

function parseDeviceTemplateCatalog(raw: unknown): Map<string, string> {
  if (!isRecord(raw) || !Array.isArray(raw.result)) {
    throw new Error('invalid device template catalog');
  }
  const result = new Map<string, string>();
  for (const entry of raw.result) {
    if (!isRecord(entry) || !nonEmptyString(entry.type) || !isRecord(entry.description)) continue;
    const deviceType = entry.type.split(':')[3];
    const description = entry.description.zh_cn;
    if (nonEmptyString(deviceType) && nonEmptyString(description)) {
      result.set(deviceType, description);
    }
  }
  return result;
}

function parseValueCatalog(raw: unknown): Map<string, string> {
  if (!isRecord(raw) || !Array.isArray(raw.result)) throw new Error('invalid value catalog');
  const result = new Map<string, string>();
  for (const entry of raw.result) {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.urn) ||
      !nonEmptyString(entry.proName) ||
      !nonEmptyString(entry.normalization) ||
      !nonEmptyString(entry.description)
    ) {
      continue;
    }
    result.set(`${entry.urn}|${entry.proName}|${entry.normalization}`, entry.description);
  }
  return result;
}

function parseMultiLanguage(raw: unknown): Map<string, string> {
  if (!isRecord(raw) || !isRecord(raw.data) || !isRecord(raw.data.zh_cn)) {
    throw new Error('invalid multi-language catalog');
  }
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(raw.data.zh_cn)) {
    if (!nonEmptyString(value)) continue;
    const segments = key.split(':');
    if (segments.length === 2) {
      result.set(`s:${Number(segments[1])}`, value);
    } else if (segments.length === 4) {
      const kind = segments[2] === 'property' ? 'p' : segments[2] === 'action' ? 'a' : 'e';
      result.set(`${kind}:${Number(segments[1])}:${Number(segments[3])}`, value);
    } else if (segments.length === 6) {
      result.set(`v:${Number(segments[1])}:${Number(segments[3])}:${Number(segments[5])}`, value);
    }
  }
  return result;
}

function cacheFor(
  fetchFn: DeviceSpecSemanticFetch,
  explicit?: DeviceSpecSemanticCache,
): DeviceSpecSemanticCache {
  if (explicit !== undefined) return explicit;
  const cached = cachesByFetch.get(fetchFn);
  if (cached !== undefined) return cached;
  const created = new DeviceSpecSemanticCache();
  cachesByFetch.set(fetchFn, created);
  return created;
}

async function fetchCatalog(
  fetchFn: DeviceSpecSemanticFetch,
  url: string,
  catalog: DeviceSpecSemanticCatalogName,
  timeoutMs: number,
  parser: (raw: unknown) => Map<string, string>,
): Promise<CatalogLoad> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      return {
        values: new Map(),
        status: { catalog, status: 'fallback', reason: 'http', httpStatus: response.status },
      };
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return {
        values: new Map(),
        status: {
          catalog,
          status: 'fallback',
          reason: controller.signal.aborted ? 'timeout' : 'invalid-content',
        },
      };
    }
    try {
      return { values: parser(raw), status: { catalog, status: 'loaded' } };
    } catch {
      return {
        values: new Map(),
        status: { catalog, status: 'fallback', reason: 'invalid-content' },
      };
    }
  } catch {
    return {
      values: new Map(),
      status: {
        catalog,
        status: 'fallback',
        reason: controller.signal.aborted ? 'timeout' : 'network',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function loadCatalog(
  cache: DeviceSpecSemanticCache,
  fetchFn: DeviceSpecSemanticFetch,
  url: string,
  catalog: DeviceSpecSemanticCatalogName,
  timeoutMs: number,
  parser: (raw: unknown) => Map<string, string>,
): Promise<CatalogLoad> {
  const state = cacheStates.get(cache);
  if (state === undefined) throw new Error('invalid DeviceSpecSemanticCache');
  let fetchState = state.byFetch.get(fetchFn);
  if (fetchState === undefined) {
    fetchState = { resolved: new Map(), inFlight: new Map() };
    state.byFetch.set(fetchFn, fetchState);
  }
  const identityKey = `${catalog}|${url}`;
  const resolved = fetchState.resolved.get(identityKey);
  if (resolved !== undefined) return Promise.resolve(resolved);
  const policyKey = `${identityKey}|${timeoutMs}`;
  const inFlight = fetchState.inFlight.get(policyKey);
  if (inFlight !== undefined) return inFlight;
  const request = fetchCatalog(fetchFn, url, catalog, timeoutMs, parser).then((result) => {
    if (result.status.status === 'loaded' && !fetchState.resolved.has(identityKey)) {
      fetchState.resolved.set(identityKey, result);
    }
    return result;
  });
  fetchState.inFlight.set(policyKey, request);
  void request.then(
    () => {
      if (fetchState.inFlight.get(policyKey) === request) fetchState.inFlight.delete(policyKey);
    },
    () => {
      if (fetchState.inFlight.get(policyKey) === request) fetchState.inFlight.delete(policyKey);
    },
  );
  return request;
}

function propertyDtype(property: MiotProperty): SemanticDeviceProperty['dtype'] {
  const raw =
    property.format === 'string'
      ? 'string'
      : property.format === 'bool'
        ? 'boolean'
        : property.format === 'float'
          ? 'float'
          : 'int';
  return raw === 'float' && property['value-list'] !== undefined ? 'int' : raw;
}

function isProprietary(
  service: MiotService,
  member: MiotProperty | MiotEvent | MiotAction,
): boolean {
  return (
    service.type.split(':')[1] !== 'miot-spec-v2' || member.type.split(':')[1] !== 'miot-spec-v2'
  );
}

interface SemanticSources {
  multi: Map<string, string>;
  values: Map<string, string>;
  services: Map<string, string>;
  properties: Map<string, string>;
  events: Map<string, string>;
  actions: Map<string, string>;
  devices: Map<string, string>;
}

function semanticDeviceType(urn: string, devices: ReadonlyMap<string, string>): SemanticDeviceType {
  const deviceType = urn.split(':')[3] ?? '';
  return {
    urn,
    deviceType,
    deviceTypeDescription: devices.get(deviceType) ?? deviceType,
  };
}

function semanticProperty(
  service: MiotService,
  property: MiotProperty,
  serviceDescription: string,
  sources: SemanticSources,
): SemanticDeviceProperty {
  const description =
    sources.multi.get(`p:${service.iid}:${property.iid}`) ??
    sources.properties.get(canonicalUrn(property.type)) ??
    property.description;
  const valueRange = property['value-range'];
  const rawValueList = property['value-list'];
  let valueList: SemanticDevicePropertyValue[] | undefined;
  if (rawValueList !== undefined) {
    valueList = rawValueList.map((entry, index) => {
      const normalizationKey = `${canonicalUrn(service.type)}|${shortName(property.type)}|${entry.description}`;
      return {
        value: entry.value,
        description:
          sources.multi.get(`v:${service.iid}:${property.iid}:${index}`) ??
          sources.values.get(normalizationKey) ??
          entry.description,
      };
    });
  } else if (property.format === 'bool') {
    const labels = BOOL_LABELS[canonicalUrn(property.type)];
    valueList = [
      { value: true, description: labels?.true ?? 'true' },
      { value: false, description: labels?.false ?? 'false' },
    ];
  }
  return {
    siid: service.iid,
    piid: property.iid,
    sUrn: service.type,
    urn: property.type,
    sDescription: serviceDescription,
    description,
    format: property.format,
    dtype: propertyDtype(property),
    access: [...property.access],
    proprietary: isProprietary(service, property),
    ...(property.unit === undefined
      ? {}
      : { rawUnit: property.unit, unit: UNIT_LABELS[property.unit] ?? property.unit }),
    ...(valueRange === undefined
      ? {}
      : { valueRange: { min: valueRange[0], max: valueRange[1], step: valueRange[2] } }),
    ...(valueList === undefined ? {} : { valueList }),
  };
}

function propertyReferences(
  piids: readonly number[] | undefined,
  properties: ReadonlyMap<number, SemanticDeviceProperty>,
): SemanticDevicePropertyReference[] {
  return (piids ?? []).map((piid) => {
    const property = properties.get(piid);
    return property === undefined ? { resolved: false, piid } : { resolved: true, piid, property };
  });
}

function projectWithSources(
  spec: DeviceSpec,
  sources: SemanticSources,
  catalogs: DeviceSpecSemanticCatalogStatus[],
): SemanticDeviceSpecProjection {
  const deviceType = semanticDeviceType(spec.type, sources.devices);
  const propertyNotify: SemanticDeviceProperty[] = [];
  const propertyGet: SemanticDeviceProperty[] = [];
  const propertySet: SemanticDeviceProperty[] = [];
  const events: SemanticDeviceEvent[] = [];
  const actions: SemanticDeviceAction[] = [];
  const excludedServices: SemanticDeviceExcludedService[] = [];

  for (const service of spec.services) {
    const serviceDescription =
      sources.multi.get(`s:${service.iid}`) ??
      sources.services.get(canonicalUrn(service.type)) ??
      service.description;
    if (shortName(service.type) === 'device-information') {
      excludedServices.push({
        siid: service.iid,
        urn: service.type,
        description: serviceDescription,
        reason: 'device-information-not-automatable',
      });
      continue;
    }

    const properties = new Map<number, SemanticDeviceProperty>();
    const actionInputProperties = new Map<number, SemanticDeviceProperty>();
    for (const property of service.properties ?? []) {
      const projected = semanticProperty(service, property, serviceDescription, sources);
      properties.set(property.iid, projected);
      actionInputProperties.set(property.iid, {
        ...projected,
        description: sources.multi.get(`p:${service.iid}:${property.iid}`) ?? property.description,
      });
      if (property.access.includes('notify')) propertyNotify.push(projected);
      if (property.access.includes('read')) propertyGet.push(projected);
      if (property.access.includes('write')) propertySet.push(projected);
    }

    for (const event of service.events ?? []) {
      events.push({
        siid: service.iid,
        eiid: event.iid,
        sUrn: service.type,
        urn: event.type,
        sDescription: serviceDescription,
        description:
          sources.multi.get(`e:${service.iid}:${event.iid}`) ??
          sources.events.get(canonicalUrn(event.type)) ??
          event.description,
        proprietary: isProprietary(service, event),
        arguments: propertyReferences(event.arguments, properties),
      });
    }

    for (const action of service.actions ?? []) {
      const outputs = propertyReferences(action.out, properties).map((reference) => ({
        ...reference,
        bindable: false as const,
      }));
      actions.push({
        siid: service.iid,
        aiid: action.iid,
        sUrn: service.type,
        urn: action.type,
        sDescription: serviceDescription,
        description:
          sources.multi.get(`a:${service.iid}:${action.iid}`) ??
          (nonEmptyString(action.description)
            ? action.description
            : (sources.actions.get(canonicalUrn(action.type)) ?? action.description)),
        proprietary: isProprietary(service, action),
        inputs: propertyReferences(action.in, actionInputProperties),
        outMetadata: outputs,
      });
    }
  }

  return {
    urn: spec.type,
    description: spec.description,
    deviceType: deviceType.deviceType,
    deviceTypeDescription: deviceType.deviceTypeDescription,
    locale: 'zh_cn',
    propertyNotify,
    propertyGet,
    propertySet,
    events,
    actions,
    excludedServices,
    catalogs,
  };
}

/**
 * Resolve Bundle-compatible stable device type tokens and their best-effort
 * zh_cn labels without fetching per-device MIoT instance specs.
 */
export async function projectDeviceTypesSemantics(
  urns: readonly string[],
  opts: ProjectDeviceSpecSemanticsOptions = {},
): Promise<SemanticDeviceTypesProjection> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = cacheFor(fetchFn, opts.cache);
  const devices = await loadCatalog(
    cache,
    fetchFn,
    CATALOG_URLS.devices,
    'device-template',
    timeoutMs,
    parseDeviceTemplateCatalog,
  );
  return {
    locale: 'zh_cn',
    deviceTypes: urns.map((urn) => semanticDeviceType(urn, devices.values)),
    catalogs: [devices.status],
  };
}

/**
 * Best-effort semantic projection used by human-facing device capability views.
 * Every catalog is independently bounded. Capability labels fall back to raw
 * instance descriptions, while the device type label falls back to its stable
 * short token; the input spec is never mutated.
 */
export async function projectDeviceSpecSemantics(
  spec: DeviceSpec,
  opts: ProjectDeviceSpecSemanticsOptions = {},
): Promise<SemanticDeviceSpecProjection> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = cacheFor(fetchFn, opts.cache);
  const multiUrl = new URL(MULTI_LANGUAGE_URL);
  multiUrl.searchParams.set('urn', spec.type);

  const [multi, values, services, properties, events, actions, devices] = await Promise.all([
    loadCatalog(
      cache,
      fetchFn,
      multiUrl.toString(),
      'multi-language',
      timeoutMs,
      parseMultiLanguage,
    ),
    loadCatalog(
      cache,
      fetchFn,
      CATALOG_URLS.values,
      'property-value-normalization',
      timeoutMs,
      parseValueCatalog,
    ),
    loadCatalog(
      cache,
      fetchFn,
      CATALOG_URLS.services,
      'service-template',
      timeoutMs,
      parseTemplateCatalog,
    ),
    loadCatalog(
      cache,
      fetchFn,
      CATALOG_URLS.properties,
      'property-template',
      timeoutMs,
      parseTemplateCatalog,
    ),
    loadCatalog(
      cache,
      fetchFn,
      CATALOG_URLS.events,
      'event-template',
      timeoutMs,
      parseTemplateCatalog,
    ),
    loadCatalog(
      cache,
      fetchFn,
      CATALOG_URLS.actions,
      'action-template',
      timeoutMs,
      parseTemplateCatalog,
    ),
    loadCatalog(
      cache,
      fetchFn,
      CATALOG_URLS.devices,
      'device-template',
      timeoutMs,
      parseDeviceTemplateCatalog,
    ),
  ]);

  return projectWithSources(
    spec,
    {
      multi: multi.values,
      values: values.values,
      services: services.values,
      properties: properties.values,
      events: events.values,
      actions: actions.values,
      devices: devices.values,
    },
    [
      multi.status,
      values.status,
      services.status,
      properties.status,
      events.status,
      actions.status,
      devices.status,
    ],
  );
}
