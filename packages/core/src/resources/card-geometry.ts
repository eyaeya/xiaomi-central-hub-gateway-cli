import type {
  DeviceSpec,
  MiotAction,
  MiotEvent,
  MiotProperty,
  MiotService,
} from '../schemas/device-spec.js';
import type {
  SemanticDeviceAction,
  SemanticDeviceEvent,
  SemanticDeviceProperty,
  SemanticDeviceSpecProjection,
} from '../usecases/device-spec-semantics.js';

// Bundle-aligned card geometry for the audited Xiaomi gateway rule editor.
// Source provenance and formula evidence are recorded in GitHub Issue #197;
// consumers do not need any external reference file at runtime.
//
// Saved cfg.pos is rendered immediately. The browser recomputes it on card
// creation and relevant mutations, but a graph load only normalizes device
// cards after their metadata arrives. XGG therefore has to use the same
// per-card formulas when it creates a typed card and when `rule layout`
// explicitly repairs an existing graph.

export interface CardSize {
  width: number;
  height: number;
}

export interface CardGeometryNodeLike {
  type?: unknown;
  cfg?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  props?: unknown;
}

export interface CardGeometryDevice {
  did: string;
  name: string;
  roomName?: string;
  deviceTypeDescription?: string;
  modelName?: string;
  urn?: string;
}

export interface CardGeometryVariable {
  scope: string;
  id: string;
  name: string;
  type?: 'number' | 'string';
}

export interface BundleTextMeasureOptions {
  size: 14 | 16;
  weight: 400 | 500;
}

export type BundleTextMeasurer = (text: string, options: BundleTextMeasureOptions) => number;

export interface CardGeometryCatalog {
  specsByUrn?: ReadonlyMap<string, DeviceSpec>;
  semanticSpecsByUrn?: ReadonlyMap<string, SemanticDeviceSpecProjection>;
  devicesByDid?: ReadonlyMap<string, CardGeometryDevice>;
  deviceInventoryStatus?: 'loaded' | 'unavailable';
  unavailableSemanticUrns?: ReadonlySet<string>;
  variablesByRef?: ReadonlyMap<string, CardGeometryVariable>;
  unavailableVariableScopes?: ReadonlySet<string>;
  measureText?: BundleTextMeasurer;
}

export interface ResolvedCardGeometry extends CardSize {
  state: 'editing' | 'simplified';
  measurement: 'exact' | 'font-dependent';
}

export type CardGeometryResolution =
  | { kind: 'resolved'; geometry: ResolvedCardGeometry }
  | {
      kind: 'preserve';
      reason:
        | 'nop'
        | 'unknown-type'
        | 'unsupported-shape'
        | 'missing-spec'
        | 'missing-device'
        | 'missing-device-inventory'
        | 'missing-semantic-projection'
        | 'missing-variable-inventory';
      missing?: string;
    };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FALLBACK_WIDTH = 400;
const FALLBACK_HEIGHT = 150;
const NOP_WIDTH = 320;
const NOP_HEIGHT = 60;
const EXPR_HEIGHT_SEED = 30;

const HEADER = 60;
const GAP = 8;
const FIELD = 120;
const LONG_FIELD = 240;
const EXPR_MIN_HEIGHT = 32;
const ROW = 40;
const OUTER = 20;
const VARIABLE_TAG_PADDING = 4;

const BASE_WIDTH = LONG_FIELD + 2 * OUTER; // Bundle Rp() = 280
const BASE_HEIGHT = HEADER + 52 + EXPR_MIN_HEIGHT + OUTER; // Bundle Pp() = 164

const KNOWN_TYPES = new Set([
  'deviceInput',
  'deviceGet',
  'deviceOutput',
  'deviceInputSetVar',
  'deviceGetSetVar',
  'alarmClock',
  'timeRange',
  'delay',
  'statusLast',
  'condition',
  'loop',
  'onlyNTimes',
  'counter',
  'signalOr',
  'logicOr',
  'logicAnd',
  'logicNot',
  'onLoad',
  'nop',
  'eventSequence',
  'register',
  'modeSwitch',
  'varChange',
  'varGet',
  'varSetNumber',
  'varSetString',
]);

const DEVICE_TYPES = new Set([
  'deviceInput',
  'deviceGet',
  'deviceOutput',
  'deviceInputSetVar',
  'deviceGetSetVar',
]);

const EDITING_FIXED: Readonly<Record<string, CardSize>> = {
  condition: { width: 300, height: 140 },
  counter: { width: 328, height: 140 },
  delay: { width: 288, height: 112 },
  eventSequence: { width: 524, height: 140 },
  loop: { width: 510, height: 140 },
  onLoad: { width: 160, height: 98 },
  onlyNTimes: { width: 382, height: 140 },
  register: { width: 160, height: 140 },
  statusLast: { width: 288, height: 119 },
  logicNot: { width: 160, height: 100 },
};

const SIMPLIFIED_FIXED_WIDTH: Readonly<Record<string, number>> = {
  condition: 197,
  logicAnd: 88,
  logicOr: 88,
  modeSwitch: 104,
  onLoad: 136,
  register: 146,
  signalOr: 88,
  logicNot: 88,
};

const SIMPLIFIED_FIXED_HEIGHT: Readonly<Record<string, number>> = {
  varChange: 90,
  varGet: 90,
  varSetNumber: 61,
  varSetString: 61,
};

const DURATION_UNIT_LABEL: Readonly<Record<string, string>> = {
  ms: '毫秒',
  s: '秒',
  min: '分钟',
  hour: '小时',
};

const OPERATOR_LABEL: Readonly<Record<string, string>> = {
  '=': '等于',
  '!=': '不等于',
  '>=': '大于等于',
  '<=': '小于等于',
  '>': '大于',
  '<': '小于',
  between: '介于',
  include: '包含',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numericField(record: Record<string, unknown>, key: string): number | null {
  return finiteNumber(record[key]);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
}

function firstUnavailableVariableScope(
  value: unknown,
  unavailable: ReadonlySet<string> | undefined,
): string | null {
  if (unavailable === undefined || unavailable.size === 0) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const scope = firstUnavailableVariableScope(entry, unavailable);
      if (scope !== null) return scope;
    }
    return null;
  }
  const record = asRecord(value);
  if (record === null) return null;
  if (
    typeof record.scope === 'string' &&
    typeof record.id === 'string' &&
    unavailable.has(record.scope)
  ) {
    return record.scope;
  }
  for (const entry of Object.values(record)) {
    const scope = firstUnavailableVariableScope(entry, unavailable);
    if (scope !== null) return scope;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Browser canvas uses `MI Lan Pro`, which is unavailable in a dependency-free
 * Node process. This deterministic estimator keeps the Bundle arithmetic and
 * errs upward by rounding to avoid clipped first renders. Callers/tests can
 * inject a real canvas measurer without changing any card formula.
 */
export const estimateMiLanProText: BundleTextMeasurer = (text, { size, weight }) => {
  let em = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === ' ') em += 0.28;
    else if (/[0-9]/u.test(char)) em += 0.56;
    else if (/[A-Z]/u.test(char)) em += 0.62;
    else if (/[a-z]/u.test(char)) em += 0.53;
    else if (/[-+.,:;()[\]{}_/\\|'"`~!@#$%^&*=<>?]/u.test(char)) em += 0.38;
    else if (
      code >= 0x2e80 ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      em += 1;
    } else {
      em += 0.75;
    }
  }
  const weightAdjustment = weight === 500 ? 1.01 : 1;
  return Math.ceil(em * size * weightAdjustment);
};

export function variableGeometryKey(scope: string, id: string): string {
  return `${scope}\0${id}`;
}

/**
 * Transient creation seed only. `resolveBundleCardGeometry` must replace this
 * for every typed no-`--pos` executable card after the complete node exists.
 */
export function seedPosition(type: string): {
  x: number;
  y: number;
  width: number;
  height: number;
  exprHeight?: number;
} {
  if (type === 'nop') {
    return { x: 0, y: 0, width: NOP_WIDTH, height: NOP_HEIGHT };
  }
  return {
    x: 0,
    y: 0,
    width: FALLBACK_WIDTH,
    height: FALLBACK_HEIGHT,
    ...((type === 'varSetNumber' || type === 'varSetString') && {
      exprHeight: EXPR_HEIGHT_SEED,
    }),
  };
}

// Backward-compatible internal alias; unlike the former type table, this is a
// seed and is never claimed to be canonical geometry.
export const sizedPos = seedPosition;

function isFiniteRect(value: unknown): value is Rect {
  const record = asRecord(value);
  return (
    record !== null &&
    finiteNumber(record.x) !== null &&
    finiteNumber(record.y) !== null &&
    finiteNumber(record.width) !== null &&
    finiteNumber(record.height) !== null
  );
}

/**
 * Tight insertion-order placement. This precedes wiring, so the final
 * flow-aware `rule layout` uses its own edge-readable 32 px column lane.
 */
export function nextCardPosition(
  existing: readonly unknown[],
  size: { width: number; height: number },
): { x: number; y: number } {
  const rects = existing.filter(isFiniteRect);
  if (rects.length === 0) return { x: 40, y: 40 };

  const previous = rects[rects.length - 1] as Rect;
  let x = previous.x + previous.width + 24;
  let y = previous.y;
  if (x + size.width > 1600) {
    const maxBottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    x = 40;
    y = maxBottom + 24;
  }
  return { x, y };
}

export function replacePositionSize<T extends Record<string, unknown>>(
  pos: T,
  geometry: Pick<ResolvedCardGeometry, 'width' | 'height'>,
): T & { width: number; height: number } {
  return { ...pos, width: geometry.width, height: geometry.height };
}

function resolved(
  width: number,
  height: number,
  state: 'editing' | 'simplified',
  measurement: 'exact' | 'font-dependent' = 'exact',
): CardGeometryResolution {
  return { kind: 'resolved', geometry: { width, height, state, measurement } };
}

function propertyDtype(property: MiotProperty): 'boolean' | 'int' | 'float' | 'string' {
  // Bundle/shared semantic mapper recognizes only these exact MIoT formats;
  // every other vendor/extended format deliberately degrades to int.
  if (property.format === 'bool') return 'boolean';
  if (property.format === 'string') return 'string';
  if (property.format === 'float') return 'float';
  return 'int';
}

function hasValueList(property: MiotProperty): boolean {
  return Object.hasOwn(property, 'value-list');
}

function hasVariableInput(property: MiotProperty): boolean {
  return (
    !hasValueList(property) &&
    (Object.hasOwn(property, 'value-range') || propertyDtype(property) === 'string')
  );
}

function comparisonControlWidth(property: MiotProperty, operator: unknown): number {
  if (operator === 'between') return 406;
  const dtype = propertyDtype(property);
  if (dtype === 'boolean') return 162;
  if (hasValueList(property)) return 296;
  if (dtype === 'int' || dtype === 'float') return 256;
  return 248;
}

function serviceFor(spec: DeviceSpec, siid: number | null): MiotService | null {
  return siid === null ? null : (spec.services.find((service) => service.iid === siid) ?? null);
}

function propertyFor(service: MiotService | null, piid: number | null): MiotProperty | null {
  return piid === null
    ? null
    : (service?.properties?.find((property) => property.iid === piid) ?? null);
}

function eventFor(service: MiotService | null, eiid: number | null): MiotEvent | null {
  return eiid === null ? null : (service?.events?.find((event) => event.iid === eiid) ?? null);
}

function actionFor(service: MiotService | null, aiid: number | null): MiotAction | null {
  return aiid === null ? null : (service?.actions?.find((action) => action.iid === aiid) ?? null);
}

function propertyForEventArgument(
  service: MiotService | null,
  event: MiotEvent | null,
  piid: number | null,
): MiotProperty | null {
  if (piid === null || !event?.arguments?.includes(piid)) return null;
  return propertyFor(service, piid);
}

function configuredRows(argumentsValue: unknown): Record<string, unknown>[] {
  if (!Array.isArray(argumentsValue)) return [];
  return argumentsValue
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null && Object.keys(row).length > 0);
}

function editingDeviceGeometry(
  type: string,
  props: Record<string, unknown>,
  spec: DeviceSpec,
): CardGeometryResolution {
  const service = serviceFor(spec, numericField(props, 'siid'));
  if (service === null) return { kind: 'preserve', reason: 'unsupported-shape' };

  if (type === 'deviceInput') {
    const piid = numericField(props, 'piid');
    if (piid !== null) {
      const property = propertyFor(service, piid);
      if (property === null) return { kind: 'preserve', reason: 'unsupported-shape' };
      return resolved(288 + comparisonControlWidth(property, props.operator), 206, 'editing');
    }
    const event = eventFor(service, numericField(props, 'eiid'));
    if (event === null) return { kind: 'preserve', reason: 'unsupported-shape' };
    const args = Array.isArray(props.arguments) ? props.arguments : [];
    const rows = configuredRows(args);
    const addRow = (event.arguments?.length ?? 0) === args.length ? 0 : 1;
    let contentWidth = LONG_FIELD;
    for (const row of rows) {
      const property = propertyForEventArgument(service, event, numericField(row, 'piid'));
      if (property !== null) {
        contentWidth = Math.max(contentWidth, 148 + comparisonControlWidth(property, row.operator));
      }
    }
    return resolved(
      contentWidth + 2 * OUTER,
      BASE_HEIGHT + ROW * (rows.length + addRow),
      'editing',
    );
  }

  if (type === 'deviceGet') {
    const property = propertyFor(service, numericField(props, 'piid'));
    if (property === null) return { kind: 'preserve', reason: 'unsupported-shape' };
    return resolved(444 + comparisonControlWidth(property, props.operator), BASE_HEIGHT, 'editing');
  }

  if (type === 'deviceInputSetVar') {
    const piid = numericField(props, 'piid');
    if (piid !== null) {
      if (propertyFor(service, piid) === null) {
        return { kind: 'preserve', reason: 'unsupported-shape' };
      }
      return resolved(554, 204, 'editing');
    }
    const event = eventFor(service, numericField(props, 'eiid'));
    if (event === null) return { kind: 'preserve', reason: 'unsupported-shape' };
    const args = Array.isArray(props.arguments) ? props.arguments : [];
    const rows = configuredRows(args);
    const matchedRows = rows.filter(
      (row) => propertyForEventArgument(service, event, numericField(row, 'piid')) !== null,
    ).length;
    const addRow = (event.arguments?.length ?? 0) === args.length ? 0 : 1;
    return resolved(
      matchedRows > 0 ? 418 : 342,
      BASE_HEIGHT + ROW * (rows.length + addRow),
      'editing',
    );
  }

  if (type === 'deviceGetSetVar') {
    return resolved(
      propertyFor(service, numericField(props, 'piid')) === null ? 348 : 566,
      BASE_HEIGHT,
      'editing',
    );
  }

  if (type === 'deviceOutput') {
    const action = actionFor(service, numericField(props, 'aiid'));
    if (action !== null) {
      if (action.in.length === 0) return resolved(BASE_WIDTH, BASE_HEIGHT, 'editing');
      let widest = 0;
      for (const piid of action.in) {
        const property = propertyFor(service, piid);
        if (property === null) return { kind: 'preserve', reason: 'unsupported-shape' };
        widest = Math.max(
          widest,
          GAP +
            (propertyDtype(property) === 'string' ? LONG_FIELD : FIELD) +
            (hasVariableInput(property) ? 28 : 0),
        );
      }
      return resolved(
        BASE_WIDTH + 128 + widest,
        BASE_HEIGHT + ROW * Math.max(action.in.length - 1, 0),
        'editing',
      );
    }
    const property = propertyFor(service, numericField(props, 'piid'));
    if (property === null) return { kind: 'preserve', reason: 'unsupported-shape' };
    return resolved(
      BASE_WIDTH +
        GAP +
        (propertyDtype(property) === 'string' ? LONG_FIELD : FIELD) +
        (hasVariableInput(property) ? 28 : 0) +
        FIELD,
      BASE_HEIGHT,
      'editing',
    );
  }

  return { kind: 'preserve', reason: 'unsupported-shape' };
}

function editingGeometry(
  type: string,
  cfg: Record<string, unknown>,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  props: Record<string, unknown>,
  catalog: CardGeometryCatalog,
): CardGeometryResolution {
  const fixed = EDITING_FIXED[type];
  if (fixed !== undefined) return resolved(fixed.width, fixed.height, 'editing');

  if (type === 'logicAnd' || type === 'logicOr' || type === 'signalOr') {
    const count = Object.keys(inputs).length;
    if (count < 2) return { kind: 'preserve', reason: 'unsupported-shape' };
    // The editing connector list appends one disabled "添加" row.
    return resolved(160, ROW * count + 100, 'editing');
  }
  if (type === 'modeSwitch') {
    const count = Object.keys(outputs).length;
    if (count < 2) return { kind: 'preserve', reason: 'unsupported-shape' };
    return resolved(160, ROW * count + 100, 'editing');
  }

  if (DEVICE_TYPES.has(type)) {
    const urn = stringField(cfg, 'urn');
    if (urn === null) return { kind: 'preserve', reason: 'missing-spec' };
    const spec = catalog.specsByUrn?.get(urn);
    if (spec === undefined) return { kind: 'preserve', reason: 'missing-spec', missing: urn };
    return editingDeviceGeometry(type, props, spec);
  }

  if (type === 'varChange') {
    const id = stringField(props, 'id');
    if (id === null) return resolved(210, 152, 'editing');
    if (props.varType === 'string') return resolved(436, 152, 'editing');
    return resolved(props.operator === 'between' ? 594 : 444, 152, 'editing');
  }
  if (type === 'varGet') {
    const id = stringField(props, 'id');
    if (id === null) return resolved(264, 120, 'editing');
    if (props.varType === 'string') return resolved(524, 120, 'editing');
    return resolved(props.operator === 'between' ? 682 : 532, 120, 'editing');
  }
  if (type === 'varSetNumber' || type === 'varSetString') {
    const pos = asRecord(cfg.pos) ?? {};
    const exprHeight = finiteNumber(pos.exprHeight) ?? 0;
    return resolved(
      type === 'varSetNumber' ? 740 : 712,
      80 + Math.max(exprHeight, EXPR_MIN_HEIGHT),
      'editing',
    );
  }

  if (type === 'alarmClock') {
    const filter = asRecord(props.filter) ?? {};
    const custom = Object.hasOwn(filter, 'day');
    const solar = props.type === 'sunset';
    const offset = cfg.happenType !== 'now';
    let contentWidth = 376 + (custom ? 128 : 0) + (offset ? 164 : 0);
    if (solar) contentWidth = Math.max(contentWidth, 472);
    return resolved(2 * OUTER + contentWidth, 112 + (solar ? ROW : 0), 'editing');
  }
  if (type === 'timeRange') {
    const filter = asRecord(props.filter) ?? {};
    return resolved(Object.hasOwn(filter, 'day') ? 566 : 438, 112, 'editing');
  }

  return { kind: 'preserve', reason: 'unsupported-shape' };
}

function weekdaySummary(daysValue: unknown): string {
  if (!Array.isArray(daysValue)) return '';
  const days = [
    ...new Set(
      daysValue.filter(
        (day): day is number => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6,
      ),
    ),
  ].sort((a, b) => a - b);
  if (days.length === 0) return '';
  if (days.length === 7) return '周一~周日';
  if (days.length >= 2 && days.filter((day) => !days.includes((day + 6) % 7)).length === 1) {
    const start = days.find((day) => !days.includes((day + 6) % 7));
    const end = days.find((day) => !days.includes((day + 1) % 7));
    const chars = '日一二三四五六';
    if (start !== undefined && end !== undefined) {
      return `周${chars[start]}~周${chars[end]}`;
    }
  }
  const chars = '日一二三四五六';
  return `周${days.map((day) => chars[day]).join('')}`;
}

function dayModeSummary(filterValue: unknown): string {
  const filter = asRecord(filterValue);
  if (filter === null || Object.keys(filter).length === 0) return '每天';
  if (Object.hasOwn(filter, 'inHoliday')) {
    return filter.inHoliday === true ? '法定节假日' : '法定工作日';
  }
  if (Object.hasOwn(filter, 'day')) return weekdaySummary(filter.day);
  return '';
}

function timePart(value: unknown): { hour: string; minute: string } {
  const record = asRecord(value) ?? {};
  const hour = finiteNumber(record.hour);
  const minute = finiteNumber(record.minute);
  return {
    hour: hour === null ? '' : String(hour),
    minute: minute === null ? '' : String(minute).padStart(2, '0'),
  };
}

function simplifiedSummary(
  type: string,
  cfg: Record<string, unknown>,
  props: Record<string, unknown>,
): string {
  if (type === 'delay' || type === 'statusLast' || type === 'eventSequence') {
    const prefix = type === 'delay' ? '延时' : type === 'statusLast' ? '状态维持' : '在';
    const suffix = type === 'eventSequence' ? '内发生' : '';
    const value = cfg.value === undefined ? '' : String(cfg.value);
    const unitRaw = stringField(cfg, 'unit') ?? '';
    return `${prefix}${value}${DURATION_UNIT_LABEL[unitRaw] ?? unitRaw}${suffix}`;
  }
  if (type === 'loop') {
    const value = cfg.value === undefined ? '' : String(cfg.value);
    const unitRaw = stringField(cfg, 'unit') ?? '';
    return `每${value}${DURATION_UNIT_LABEL[unitRaw] ?? unitRaw}一次`;
  }
  if (type === 'counter') return `达到${String(props.n ?? '')}次时`;
  if (type === 'onlyNTimes') return `最多触发${String(props.n ?? '')}次`;
  if (type === 'timeRange') {
    const start = timePart(props.start);
    const end = timePart(props.end);
    return `${dayModeSummary(props.filter)} ${start.hour}:${start.minute}-${end.hour}:${end.minute}`;
  }
  if (type === 'alarmClock') {
    let eventText = '';
    if (props.type === 'periodicAlarm') {
      eventText = `${String(props.hour ?? '')}:${String(props.minute ?? '').padStart(2, '0')}`;
    } else if (props.type === 'sunset') {
      const solar = props.isSunset === true ? '日落' : '日出';
      const offset = finiteNumber(props.offset) ?? 0;
      eventText =
        offset === 0 ? `${solar}时` : `${solar}${offset > 0 ? '后' : '前'}${Math.abs(offset)}分钟`;
    }
    return `${dayModeSummary(props.filter)} ${eventText}`;
  }
  return '';
}

function variableLabel(scope: unknown, id: unknown, catalog: CardGeometryCatalog): string {
  if (typeof id !== 'string') return '变量已丢失';
  const normalizedScope = typeof scope === 'string' ? scope : '';
  return (
    catalog.variablesByRef?.get(variableGeometryKey(normalizedScope, id))?.name ?? '变量已丢失'
  );
}

interface DisplayProperty {
  description: string;
  dtype: 'boolean' | 'int' | 'float' | 'string';
  unit?: string;
  valueList?: ReadonlyArray<{ value: unknown; description: string }>;
}

function rawDisplayProperty(property: MiotProperty): DisplayProperty {
  return {
    description: property.description,
    dtype: propertyDtype(property),
    ...(property.unit !== undefined && { unit: property.unit }),
    ...(hasValueList(property) && { valueList: property['value-list'] ?? [] }),
  };
}

function semanticDisplayProperty(property: SemanticDeviceProperty): DisplayProperty {
  return {
    description: property.description,
    dtype: property.dtype,
    ...(property.unit !== undefined && { unit: property.unit }),
    ...(property.valueList !== undefined && { valueList: property.valueList }),
  };
}

function comparisonText(
  props: Record<string, unknown>,
  property?: DisplayProperty,
  includePrefix = true,
): string {
  const operator = stringField(props, 'operator') ?? '';
  if (property?.valueList !== undefined) {
    const values = Array.isArray(props.v1) ? props.v1 : [props.v1];
    const labels = values
      .map(
        (value) => property.valueList?.find((entry) => Object.is(entry.value, value))?.description,
      )
      .filter((value): value is string => typeof value === 'string');
    const prefix = property.dtype === 'boolean' ? '为：' : '包含：';
    return `${includePrefix ? prefix : ''}${labels.join('、')}`;
  }
  const first = props.v1 === undefined ? '' : String(props.v1);
  const unit = property?.unit ?? '';
  const second =
    operator === 'between' && props.v2 !== undefined ? `-${String(props.v2)}${unit}` : '';
  const prefix = `${OPERATOR_LABEL[operator] ?? operator}${includePrefix ? '：' : ''}`;
  return `${prefix}${first}${unit}${second}`;
}

function deviceInputValueText(
  props: Record<string, unknown>,
  property: DisplayProperty,
  includePrefix = true,
): string {
  if (property.valueList !== undefined) {
    return comparisonText(props, property, includePrefix);
  }
  if (property.dtype === 'int' || property.dtype === 'float') {
    return comparisonText(props, property, includePrefix);
  }
  // Bundle su(): string and non-enumerated boolean rows render only v1. They
  // do not prepend the comparison operator used by numeric rows.
  return props.v1 === undefined ? '' : String(props.v1);
}

interface SimplifiedAtom {
  label: string;
  variable?: boolean;
}

// Bundle pu() returns either one scalar atom or a nested atom array. `$c`
// adds the 4 px per-item gap only for a nested row; normal property/event/
// literal-action rows are scalar and must not receive that padding.
type SimplifiedRow = SimplifiedAtom | SimplifiedAtom[];

function semanticPropertyForCard(
  type: string,
  semanticSpec: SemanticDeviceSpecProjection | undefined,
  siid: number | null,
  piid: number | null,
): SemanticDeviceProperty | undefined {
  if (semanticSpec === undefined || siid === null || piid === null) return undefined;
  const properties =
    type === 'deviceInput' || type === 'deviceInputSetVar'
      ? semanticSpec.propertyNotify
      : type === 'deviceGet' || type === 'deviceGetSetVar'
        ? semanticSpec.propertyGet
        : semanticSpec.propertySet;
  return properties.find((property) => property.siid === siid && property.piid === piid);
}

function semanticEventForCard(
  semanticSpec: SemanticDeviceSpecProjection | undefined,
  siid: number | null,
  eiid: number | null,
): SemanticDeviceEvent | undefined {
  if (semanticSpec === undefined || siid === null || eiid === null) return undefined;
  return semanticSpec.events.find((event) => event.siid === siid && event.eiid === eiid);
}

function semanticActionForCard(
  semanticSpec: SemanticDeviceSpecProjection | undefined,
  siid: number | null,
  aiid: number | null,
): SemanticDeviceAction | undefined {
  if (semanticSpec === undefined || siid === null || aiid === null) return undefined;
  return semanticSpec.actions.find((action) => action.siid === siid && action.aiid === aiid);
}

function semanticArgumentProperty(
  event: SemanticDeviceEvent | undefined,
  piid: number | null,
): SemanticDeviceProperty | undefined {
  if (event === undefined || piid === null) return undefined;
  const reference = event.arguments.find((argument) => argument.piid === piid);
  return reference?.resolved === true ? reference.property : undefined;
}

function displayProperty(raw: MiotProperty, semantic?: SemanticDeviceProperty): DisplayProperty {
  return semantic === undefined ? rawDisplayProperty(raw) : semanticDisplayProperty(semantic);
}

function deviceRows(
  type: string,
  props: Record<string, unknown>,
  service: MiotService,
  catalog: CardGeometryCatalog,
  semanticSpec?: SemanticDeviceSpecProjection,
): SimplifiedRow[] {
  const siid = numericField(props, 'siid');
  if (type === 'deviceGet' || type === 'deviceInput') {
    const property = propertyFor(service, numericField(props, 'piid'));
    if (property !== null) {
      const semantic = semanticPropertyForCard(
        type,
        semanticSpec,
        siid,
        numericField(props, 'piid'),
      );
      return [{ label: deviceInputValueText(props, displayProperty(property, semantic)) }];
    }
    if (type === 'deviceInput') {
      const event = eventFor(service, numericField(props, 'eiid'));
      if (event === null) return [];
      const semanticEvent = semanticEventForCard(semanticSpec, siid, numericField(props, 'eiid'));
      return configuredRows(props.arguments)
        .map((argument): SimplifiedRow | null => {
          const meta = propertyForEventArgument(service, event, numericField(argument, 'piid'));
          const semantic = semanticArgumentProperty(semanticEvent, numericField(argument, 'piid'));
          return meta === null
            ? { label: '' }
            : {
                label: `${semantic?.description ?? meta.description}：${deviceInputValueText(
                  argument,
                  displayProperty(meta, semantic),
                  false,
                )}`,
              };
        })
        .filter((row): row is SimplifiedRow => row !== null);
    }
  }

  if (type === 'deviceOutput') {
    const action = actionFor(service, numericField(props, 'aiid'));
    if (action !== null) {
      const ins = Array.isArray(props.ins) ? props.ins : [];
      const semanticAction = semanticActionForCard(semanticSpec, siid, numericField(props, 'aiid'));
      return action.in.map((piid, index) => {
        const property = propertyFor(service, piid);
        const semanticReference = semanticAction?.inputs[index];
        const semantic =
          semanticReference?.resolved === true ? semanticReference.property : undefined;
        const display = property === null ? undefined : displayProperty(property, semantic);
        const value = asRecord(ins[index]) ?? {};
        if (typeof value.id === 'string') {
          return [
            { label: display?.description ?? '' },
            {
              label: variableLabel(value.scope, value.id, catalog),
              variable: true,
            },
          ];
        }
        const literal =
          display?.valueList !== undefined
            ? (display.valueList.find((entry) => Object.is(entry.value, value.value))
                ?.description ?? '')
            : `${String(value.value ?? '')}${display?.unit ?? ''}`;
        return { label: `${display?.description ?? ''}：${literal}` };
      });
    }
    const property = propertyFor(service, numericField(props, 'piid'));
    if (property !== null) {
      const semantic = semanticPropertyForCard(
        type,
        semanticSpec,
        siid,
        numericField(props, 'piid'),
      );
      const display = displayProperty(property, semantic);
      if (typeof props.id === 'string') {
        return [
          {
            label: variableLabel(props.scope, props.id, catalog),
            variable: true,
          },
        ];
      }
      const literal =
        display.valueList !== undefined
          ? (display.valueList.find((entry) => Object.is(entry.value, props.value))?.description ??
            '')
          : `${String(props.value ?? '')}${display.unit ?? ''}`;
      return [{ label: literal }];
    }
  }

  if (type === 'deviceInputSetVar') {
    if (numericField(props, 'piid') !== null) {
      return [
        [
          { label: '赋值给' },
          {
            label: variableLabel(props.scope, props.id, catalog),
            variable: true,
          },
        ],
      ];
    }
    const event = eventFor(service, numericField(props, 'eiid'));
    if (event === null) return [];
    const semanticEvent = semanticEventForCard(semanticSpec, siid, numericField(props, 'eiid'));
    return configuredRows(props.arguments)
      .map((argument): SimplifiedRow | null => {
        const property = propertyForEventArgument(service, event, numericField(argument, 'piid'));
        const semantic = semanticArgumentProperty(semanticEvent, numericField(argument, 'piid'));
        return property === null
          ? { label: '' }
          : [
              { label: `${semantic?.description ?? property.description} 赋值给` },
              {
                label: variableLabel(argument.scope, argument.id, catalog),
                variable: true,
              },
            ];
      })
      .filter((row): row is SimplifiedRow => row !== null);
  }

  if (type === 'deviceGetSetVar') {
    return [
      [
        { label: '赋值给' },
        {
          label: variableLabel(props.scope, props.id, catalog),
          variable: true,
        },
      ],
    ];
  }

  return [];
}

function deviceOperation(type: string): string {
  if (type === 'deviceGet' || type === 'deviceGetSetVar') return '查询';
  if (type === 'deviceOutput') return '执行';
  return '上报';
}

function deviceCapabilityDescription(
  type: string,
  props: Record<string, unknown>,
  service: MiotService,
  semanticSpec?: SemanticDeviceSpecProjection,
): string {
  const siid = numericField(props, 'siid');
  const piid = numericField(props, 'piid');
  const eiid = numericField(props, 'eiid');
  const aiid = numericField(props, 'aiid');
  const semanticFeature =
    piid !== null
      ? semanticPropertyForCard(type, semanticSpec, siid, piid)
      : eiid !== null
        ? semanticEventForCard(semanticSpec, siid, eiid)
        : semanticActionForCard(semanticSpec, siid, aiid);
  if (semanticFeature !== undefined) {
    return `${semanticFeature.sDescription}-${semanticFeature.description}`;
  }

  let feature: MiotProperty | MiotEvent | MiotAction | null = null;
  if (piid !== null) feature = propertyFor(service, piid);
  else if (eiid !== null) feature = eventFor(service, eiid);
  else if (aiid !== null) feature = actionFor(service, aiid);
  return feature === null ? '' : `${service.description}-${feature.description}`;
}

function simplifiedDeviceGeometry(
  type: string,
  cfg: Record<string, unknown>,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  props: Record<string, unknown>,
  catalog: CardGeometryCatalog,
  measure: BundleTextMeasurer,
): CardGeometryResolution {
  const urn = stringField(cfg, 'urn');
  if (urn === null) return { kind: 'preserve', reason: 'missing-spec' };
  const spec = catalog.specsByUrn?.get(urn);
  if (spec === undefined) return { kind: 'preserve', reason: 'missing-spec', missing: urn };
  const semanticSpec = catalog.semanticSpecsByUrn?.get(urn);
  const service = serviceFor(spec, numericField(props, 'siid'));
  if (service === null) return { kind: 'preserve', reason: 'unsupported-shape' };
  const rows = deviceRows(type, props, service, catalog, semanticSpec);
  const connectorRows = Math.max(Object.keys(inputs).length, Object.keys(outputs).length);
  const detailHeight =
    53 +
    rows.reduce(
      (sum, row) =>
        sum + (Array.isArray(row) && row.some((atom) => atom.variable === true) ? 27 : 23),
      0,
    );
  const height = 72 + Math.max(36 * connectorRows, detailHeight);

  // Bundle $c() deliberately looks up the first device by cfg.urn rather
  // than props.did. If no matching display record exists it returns the
  // exact 190 px fallback; content rows still determine eu() height.
  const device = [...(catalog.devicesByDid?.values() ?? [])].find(
    (candidate) => candidate.urn === urn,
  );
  if (device === undefined) return resolved(190, height, 'simplified');

  const roomAndType = `${device.roomName || '未分配'}${
    device.deviceTypeDescription || device.modelName
      ? ` | ${device.deviceTypeDescription ?? device.modelName}`
      : ''
  }`;
  const deviceHeader =
    Math.max(
      measure(device.name, { size: 14, weight: 400 }),
      measure(roomAndType, { size: 14, weight: 400 }),
    ) + 48;
  const actionTitle =
    measure(
      `${deviceOperation(type)}${deviceCapabilityDescription(type, props, service, semanticSpec)}`,
      {
        size: 16,
        weight: 500,
      },
    ) + 20;
  const atomWidth = (atom: SimplifiedAtom): number =>
    measure(atom.label, { size: 14, weight: 400 }) +
    (atom.variable === true ? 2 * VARIABLE_TAG_PADDING : 0);
  const rowWidths = rows.map((row) =>
    Array.isArray(row)
      ? row.reduce((sum, atom) => sum + atomWidth(atom), 0) + row.length * VARIABLE_TAG_PADDING
      : atomWidth(row),
  );
  const width = clamp(Math.max(deviceHeader, actionTitle, ...rowWidths, 0) + 2 * OUTER, 190, 360);
  return resolved(width, height, 'simplified', 'font-dependent');
}

function simplifiedVariableGeometry(
  type: string,
  props: Record<string, unknown>,
  catalog: CardGeometryCatalog,
  measure: BundleTextMeasurer,
): CardGeometryResolution {
  if (type === 'varChange' || type === 'varGet') {
    const label = variableLabel(props.scope, props.id, catalog);
    const header =
      measure(type === 'varChange' ? '更新' : '查询', { size: 16, weight: 500 }) +
      measure(label, { size: 14, weight: 400 }) +
      28;
    const comparison = measure(comparisonText(props), { size: 14, weight: 400 });
    return resolved(
      clamp(Math.max(header, comparison) + 2 * OUTER, 190, 360),
      SIMPLIFIED_FIXED_HEIGHT[type] as number,
      'simplified',
      'font-dependent',
    );
  }

  const target =
    measure(variableLabel(props.scope, props.id, catalog), { size: 14, weight: 400 }) +
    2 * VARIABLE_TAG_PADDING;
  const elements = Array.isArray(props.elements) ? props.elements : [];
  const elementWidth = elements.reduce((sum, raw) => {
    const element = asRecord(raw);
    if (element === null) return sum;
    if (element.type === 'const') {
      return sum + measure(String(element.value ?? ''), { size: 14, weight: 400 });
    }
    if (element.type === 'var') {
      return (
        sum +
        measure(variableLabel(element.scope, element.id, catalog), {
          size: 14,
          weight: 400,
        }) +
        2 * VARIABLE_TAG_PADDING
      );
    }
    return sum;
  }, 0);
  return resolved(
    clamp(target + 18 + elementWidth + 2 * OUTER, 190, 360),
    SIMPLIFIED_FIXED_HEIGHT[type] as number,
    'simplified',
    'font-dependent',
  );
}

function simplifiedGeometry(
  type: string,
  cfg: Record<string, unknown>,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  props: Record<string, unknown>,
  catalog: CardGeometryCatalog,
): CardGeometryResolution {
  const measure = catalog.measureText ?? estimateMiLanProText;
  if (DEVICE_TYPES.has(type)) {
    return simplifiedDeviceGeometry(type, cfg, inputs, outputs, props, catalog, measure);
  }
  if (
    type === 'varChange' ||
    type === 'varGet' ||
    type === 'varSetNumber' ||
    type === 'varSetString'
  ) {
    return simplifiedVariableGeometry(type, props, catalog, measure);
  }

  const connectorRows = Math.max(Object.keys(inputs).length, Object.keys(outputs).length);
  if (connectorRows < 1) return { kind: 'preserve', reason: 'unsupported-shape' };
  const height =
    SIMPLIFIED_FIXED_HEIGHT[type] ?? 36 * connectorRows + 20 + (connectorRows === 1 ? 5 : 0);
  const fixedWidth = SIMPLIFIED_FIXED_WIDTH[type];
  if (fixedWidth !== undefined) return resolved(fixedWidth, height, 'simplified');

  const summary = simplifiedSummary(type, cfg, props);
  if (summary.length === 0) return { kind: 'preserve', reason: 'unsupported-shape' };
  const connectorOffset =
    type === 'eventSequence'
      ? 26
      : type === 'counter' || type === 'loop' || type === 'onlyNTimes'
        ? 40
        : 0;
  return resolved(
    measure(summary, { size: 16, weight: 500 }) + 2 * OUTER + connectorOffset,
    height,
    'simplified',
    'font-dependent',
  );
}

export function resolveBundleCardGeometry(
  node: CardGeometryNodeLike,
  catalog: CardGeometryCatalog = {},
): CardGeometryResolution {
  if (typeof node.type !== 'string' || !KNOWN_TYPES.has(node.type)) {
    return { kind: 'preserve', reason: 'unknown-type' };
  }
  if (node.type === 'nop') return { kind: 'preserve', reason: 'nop' };

  const cfg = asRecord(node.cfg);
  const inputs = asRecord(node.inputs);
  const outputs = asRecord(node.outputs);
  const props = asRecord(node.props);
  if (cfg === null || inputs === null || outputs === null || props === null) {
    return { kind: 'preserve', reason: 'unsupported-shape' };
  }

  if (cfg.simplified === true) {
    if (DEVICE_TYPES.has(node.type)) {
      if (catalog.deviceInventoryStatus === 'unavailable') {
        return { kind: 'preserve', reason: 'missing-device-inventory' };
      }
      const urn = stringField(cfg, 'urn');
      if (urn !== null && catalog.unavailableSemanticUrns?.has(urn) === true) {
        return { kind: 'preserve', reason: 'missing-semantic-projection', missing: urn };
      }
    }
    const unavailableScope = firstUnavailableVariableScope(
      props,
      catalog.unavailableVariableScopes,
    );
    if (unavailableScope !== null) {
      return {
        kind: 'preserve',
        reason: 'missing-variable-inventory',
        missing: unavailableScope,
      };
    }
  }

  return cfg.simplified === true
    ? simplifiedGeometry(node.type, cfg, inputs, outputs, props, catalog)
    : editingGeometry(node.type, cfg, inputs, outputs, props, catalog);
}
