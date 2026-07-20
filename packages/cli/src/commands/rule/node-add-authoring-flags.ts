import { ConfigError } from '@eyaeya/xgg-core';
import type { AddNodeShortcut } from '@eyaeya/xgg-core';

/**
 * Every `rule node add` option that can affect the authored node or shortcut.
 *
 * Operational options (`--rule-id`, snapshot/session/timeout/output flags, and
 * validation opt-outs) intentionally do not appear here: they are consumed by
 * the command workflow rather than by one card synthesizer. Keeping the full
 * authoring vocabulary in one typed map makes a newly-added Commander option a
 * deliberate allowlist change instead of another silently-dropped field.
 */
const AUTHORING_FLAG = {
  cfg: '--cfg',
  id: '--id',
  allowLegacyId: '--allow-legacy-id',
  deviceDid: '--device-did',
  deviceSiid: '--device-siid',
  deviceProperty: '--device-property',
  deviceAction: '--device-action',
  deviceEvent: '--device-event',
  eventFilter: '--event-filter',
  eventFilterInclude: '--event-filter-include',
  eventFilterBetween: '--event-filter-between',
  eventArgVar: '--event-arg-var',
  threshold: '--threshold',
  propertyValue: '--property-value',
  propertyInclude: '--property-include',
  op: '--op',
  params: '--params',
  value: '--value',
  forceOutOfRange: '--force-out-of-range',
  allowNoPush: '--allow-no-push',
  preload: '--preload/--no-preload',
  pos: '--pos',
  simplified: '--simplified',
  text: '--text',
  delta: '--delta',
  background: '--background',
  inputs: '--inputs',
  duration: '--duration',
  interval: '--interval',
  start: '--start',
  end: '--end',
  mingTextShow: '--ming-text-show',
  weekdayOnly: '--weekday-only',
  holidayOnly: '--holiday-only',
  days: '--days',
  varScope: '--var-scope',
  varId: '--var-id',
  varType: '--var-type',
  varValue: '--var-value',
  threshold2: '--threshold2',
  allowUnknownScope: '--allow-unknown-scope',
  at: '--at',
  sunrise: '--sunrise',
  sunset: '--sunset',
  offsetMin: '--offset-min',
  latitude: '--latitude',
  longitude: '--longitude',
  expr: '--expr',
  defaultExprScope: '--default-expr-scope',
  outputs: '--outputs',
} as const;

type AuthoringOption = keyof typeof AUTHORING_FLAG;
type ModeledShortcutType = AddNodeShortcut['type'];
type AuthoringOptionBag = { type: string } & Partial<Record<AuthoringOption, unknown>>;
type ModeAllowlist = Readonly<Record<string, readonly AuthoringOption[]>>;

/** Commander attribute names covered by the authoring allowlists (test seam). */
export const NODE_ADD_AUTHORING_OPTION_ATTRIBUTES: readonly string[] = Object.freeze(
  Object.keys(AUTHORING_FLAG),
);

/** Long flag names derived from the same registry for docs/Skill coverage checks. */
export const NODE_ADD_AUTHORING_FLAG_NAMES: readonly string[] = Object.freeze(
  Object.values(AUTHORING_FLAG).flatMap((label) => label.split('/')),
);

/**
 * Commander stores --preload and --no-preload in the same boolean property,
 * so the final option bag cannot reveal that both spellings occurred. The CLI
 * adapter records those two events and calls this before any other preflight.
 */
export function assertExclusivePreloadSpellings(input: {
  preload: boolean;
  noPreload: boolean;
}): void {
  if (!input.preload || !input.noPreload) return;
  throw new ConfigError(
    '--preload and --no-preload are mutually exclusive; choose exactly one explicit preload state',
  );
}

const executable = (...specific: AuthoringOption[]): readonly AuthoringOption[] => [
  'id',
  'allowLegacyId',
  'pos',
  'simplified',
  ...specific,
];
const device = (...specific: AuthoringOption[]): readonly AuthoringOption[] =>
  executable('deviceDid', 'deviceSiid', ...specific);

const PROPERTY_COMPARISON: readonly AuthoringOption[] = [
  'deviceProperty',
  'op',
  'threshold',
  'threshold2',
  'propertyValue',
  'propertyInclude',
  'forceOutOfRange',
];
const DAY_FILTER: readonly AuthoringOption[] = ['weekdayOnly', 'holidayOnly', 'days'];
const VARIABLE_TARGET: readonly AuthoringOption[] = ['varScope', 'varId', 'allowUnknownScope'];

/**
 * Mode-complete shortcut contract for all 25 executable cards plus `nop`.
 * `satisfies` makes a modeled type addition/removal fail compilation here.
 */
const MODELED_SHORTCUT_ALLOWLIST = {
  deviceInput: {
    property: device(...PROPERTY_COMPARISON, 'allowNoPush', 'preload'),
    event: device(
      'deviceEvent',
      'eventFilter',
      'eventFilterInclude',
      'eventFilterBetween',
      'allowNoPush',
    ),
  },
  deviceGet: {
    property: device(...PROPERTY_COMPARISON),
  },
  deviceOutput: {
    select: device('deviceAction', 'deviceProperty'),
    action: device('deviceAction', 'params', 'allowUnknownScope'),
    property: device('deviceProperty', 'value', 'allowUnknownScope'),
  },
  deviceInputSetVar: {
    property: device('deviceProperty', ...VARIABLE_TARGET, 'preload', 'allowNoPush'),
    event: device('deviceEvent', 'eventArgVar', ...VARIABLE_TARGET, 'allowNoPush'),
  },
  deviceGetSetVar: {
    property: device('deviceProperty', ...VARIABLE_TARGET),
  },
  alarmClock: {
    periodic: executable('at', ...DAY_FILTER),
    solar: executable('sunrise', 'sunset', 'offsetMin', 'latitude', 'longitude', ...DAY_FILTER),
  },
  timeRange: {
    shortcut: executable('start', 'end', 'mingTextShow', ...DAY_FILTER),
  },
  delay: { shortcut: executable('duration') },
  statusLast: { shortcut: executable('duration') },
  condition: { shortcut: executable() },
  loop: { shortcut: executable('interval') },
  onlyNTimes: { shortcut: executable('threshold') },
  counter: { shortcut: executable('threshold') },
  signalOr: { shortcut: executable('inputs') },
  logicOr: { shortcut: executable('inputs') },
  logicAnd: { shortcut: executable('inputs') },
  logicNot: { shortcut: executable() },
  onLoad: { shortcut: executable() },
  register: { shortcut: executable() },
  eventSequence: { shortcut: executable('duration') },
  modeSwitch: { shortcut: executable('outputs') },
  varChange: {
    number: executable(...VARIABLE_TARGET, 'varType', 'op', 'threshold', 'threshold2', 'preload'),
    string: executable(...VARIABLE_TARGET, 'varType', 'op', 'varValue', 'preload'),
    invalidType: executable(
      ...VARIABLE_TARGET,
      'varType',
      'op',
      'threshold',
      'threshold2',
      'varValue',
      'preload',
    ),
  },
  varGet: {
    number: executable(...VARIABLE_TARGET, 'varType', 'op', 'threshold', 'threshold2'),
    string: executable(...VARIABLE_TARGET, 'varType', 'op', 'varValue'),
    invalidType: executable(
      ...VARIABLE_TARGET,
      'varType',
      'op',
      'threshold',
      'threshold2',
      'varValue',
    ),
  },
  varSetNumber: {
    shortcut: executable(...VARIABLE_TARGET, 'expr', 'defaultExprScope'),
  },
  varSetString: {
    shortcut: executable(...VARIABLE_TARGET, 'expr', 'defaultExprScope'),
  },
  nop: {
    shortcut: ['id', 'allowLegacyId', 'pos', 'text', 'delta', 'background'],
  },
} satisfies Record<ModeledShortcutType, ModeAllowlist>;

const RAW_ALLOWLIST: readonly AuthoringOption[] = ['cfg', 'id'];

function isSupplied(opts: AuthoringOptionBag, option: AuthoringOption): boolean {
  const value = opts[option];
  return Array.isArray(value) ? value.length > 0 : value !== undefined;
}

function isModeledShortcutType(type: string): type is ModeledShortcutType {
  return Object.hasOwn(MODELED_SHORTCUT_ALLOWLIST, type);
}

function hasAny(opts: AuthoringOptionBag, options: readonly AuthoringOption[]): boolean {
  return options.some((option) => isSupplied(opts, option));
}

function suppliedFlags(
  opts: AuthoringOptionBag,
  options: readonly AuthoringOption[],
): AuthoringOption[] {
  return options.filter((option) => isSupplied(opts, option));
}

function assertModeMutexes(opts: AuthoringOptionBag, type: ModeledShortcutType): void {
  if (type === 'deviceInputSetVar') {
    if (isSupplied(opts, 'deviceProperty') && isSupplied(opts, 'deviceEvent')) {
      throw new ConfigError(
        'deviceInputSetVar cannot mix --device-property with --device-event; choose exactly one capture mode',
      );
    }
    if (
      isSupplied(opts, 'deviceEvent') &&
      isSupplied(opts, 'eventArgVar') &&
      hasAny(opts, ['varScope', 'varId'])
    ) {
      throw new ConfigError(
        'deviceInputSetVar event mode cannot mix --event-arg-var with --var-scope/--var-id; use per-argument routing or the single-argument target form',
      );
    }
  }

  if (type === 'alarmClock') {
    const forms = suppliedFlags(opts, ['at', 'sunrise', 'sunset']);
    if (forms.length > 1) {
      throw new ConfigError(
        `alarmClock trigger options are mutually exclusive: ${forms
          .map((option) => AUTHORING_FLAG[option])
          .join(', ')}; choose exactly one of --at, --sunrise, or --sunset`,
      );
    }
  }

  if (type === 'alarmClock' || type === 'timeRange') {
    const filters = suppliedFlags(opts, ['weekdayOnly', 'holidayOnly', 'days']);
    if (filters.length > 1) {
      throw new ConfigError(
        `day filters are mutually exclusive for --type ${type}: ${filters
          .map((option) => AUTHORING_FLAG[option])
          .join(', ')}; choose at most one`,
      );
    }
  }
}

function resolveMode(opts: AuthoringOptionBag, type: ModeledShortcutType): string {
  switch (type) {
    case 'deviceInput':
    case 'deviceInputSetVar':
      return isSupplied(opts, 'deviceEvent') ? 'event' : 'property';
    case 'deviceGet':
    case 'deviceGetSetVar':
      return 'property';
    case 'deviceOutput': {
      const actionIntent = hasAny(opts, ['deviceAction', 'params']);
      const propertyIntent = hasAny(opts, ['deviceProperty', 'value']);
      if (actionIntent && propertyIntent) {
        throw new ConfigError(
          'deviceOutput action mode (--device-action/--params) and property mode (--device-property/--value) are mutually exclusive; choose exactly one mode',
        );
      }
      if (isSupplied(opts, 'params') && !isSupplied(opts, 'deviceAction')) {
        throw new ConfigError('--params requires --device-action in deviceOutput action mode');
      }
      if (isSupplied(opts, 'value') && !isSupplied(opts, 'deviceProperty')) {
        throw new ConfigError('--value requires --device-property in deviceOutput property mode');
      }
      if (actionIntent) return 'action';
      if (propertyIntent) return 'property';
      return 'select';
    }
    case 'alarmClock':
      return hasAny(opts, ['sunrise', 'sunset', 'offsetMin', 'latitude', 'longitude'])
        ? 'solar'
        : 'periodic';
    case 'varChange':
    case 'varGet':
      if (opts.varType === 'string') return 'string';
      if (opts.varType === undefined || opts.varType === 'number') return 'number';
      return 'invalidType';
    default:
      return 'shortcut';
  }
}

/**
 * Reject every supplied authoring option that the selected type/mode will not
 * consume. This must run before mutation guards, session lookup, snapshots, or
 * RPC so deterministic authoring mistakes never depend on gateway state.
 */
export function assertNodeAddAuthoringFlagUsage(opts: AuthoringOptionBag): void {
  const supplied = (Object.keys(AUTHORING_FLAG) as AuthoringOption[]).filter((option) =>
    isSupplied(opts, option),
  );

  const raw = isSupplied(opts, 'cfg');
  let mode: string;
  let allowed: readonly AuthoringOption[] | undefined;
  if (raw || !isModeledShortcutType(opts.type)) {
    mode = 'raw';
    allowed = RAW_ALLOWLIST;
  } else {
    const type = opts.type;
    assertModeMutexes(opts, type);
    mode = resolveMode(opts, type);
    const typeAllowlist: ModeAllowlist = MODELED_SHORTCUT_ALLOWLIST[type];
    allowed = typeAllowlist[mode];
  }

  if (allowed === undefined) {
    throw new ConfigError(
      `internal node authoring allowlist is missing mode "${mode}" for ${opts.type}`,
    );
  }

  const allowedSet = new Set<AuthoringOption>(allowed);
  const unsupported = supplied.filter((option) => !allowedSet.has(option));
  if (unsupported.length === 0) return;

  const modeLabel = mode === 'shortcut' || mode === 'raw' ? mode : `${mode} mode`;
  const accepted = allowed.map((option) => AUTHORING_FLAG[option]).join(', ') || '(none)';
  throw new ConfigError(
    `--type ${opts.type} ${modeLabel} does not accept authoring option(s): ${unsupported
      .map((option) => AUTHORING_FLAG[option])
      .join(', ')}. Accepted authoring options for this mode: ${accepted}`,
    { type: opts.type, mode, unsupported: unsupported.map((option) => AUTHORING_FLAG[option]) },
  );
}
