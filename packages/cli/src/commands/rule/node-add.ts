import {
  ConfigError,
  addNode,
  dumpBeforeWrite,
  getDevice,
  nodeSchemaForType,
  parseFiniteDecimalLiteral,
} from '@eyaeya/xgg-core';
import type { AddNodeShortcut } from '@eyaeya/xgg-core';
import { type Command, InvalidArgumentError } from 'commander';
import { wrap } from '../../action-wrap.js';
import {
  addNextHintFlag,
  buildNextSteps,
  nextHintOptedOut,
  printNextStepHintLine,
  withNextSteps,
} from '../../agent-hints.js';
import { parseJsonInput } from '../../local-input.js';
import { emit } from '../../output.js';
import {
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
} from '../_mutation-guard.js';
import { type RuleOpts, makeDeps } from './_deps.js';

// M10 F29 reuse: varChange shortcuts reference a variable scope; warn if
// it's not the only web-UI-known scope (`global`). Mirrors the warning
// emitted by `variable create` (packages/cli/src/commands/variable.ts).
const KNOWN_UI_SCOPES = new Set(['global']);

function warnIfGhostScope(
  type: string,
  scope: string | undefined,
  allow: boolean | undefined,
): void {
  if (allow === true) return;
  if (scope === undefined) return;
  if (KNOWN_UI_SCOPES.has(scope)) return;
  process.stderr.write(
    `[xgg rule node add ${type}] warning: --var-scope "${scope}" is not in the web-UI-known set (${[...KNOWN_UI_SCOPES].join(', ')}); the gateway will store the reference but the variable is invisible in the 米家网关 UI and may never fire. Pass --allow-unknown-scope to silence (M10 F29).\n`,
  );
}

async function warnIfDeviceInputNoPush(
  did: string | undefined,
  deps: Parameters<typeof getDevice>[1],
  allow: boolean | undefined,
): Promise<void> {
  if (allow === true) return;
  if (did === undefined) return;
  const device = await getDevice(did, deps);
  if (device.pushAvailable !== false) return;
  process.stderr.write(
    `[xgg rule node add deviceInput] warning: device ${did} has pushAvailable=false; deviceInput state-mode listens for push notify events that this device does not send. The rule will save, but the state input will never fire from the device's own updates. Either use deviceGet (active poll) with a condition node to gate by state, or maintain state in-graph via a register. Pass --allow-no-push to silence (F17).\n`,
  );
}

function parseParamsJson(raw: string): Record<string, unknown> {
  const parsed = parseJsonInput(raw, '--params');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('--params must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseFiniteDecimal(raw: string): number {
  const parsed = parseFiniteDecimalLiteral(raw);
  if (parsed === null) {
    throw new InvalidArgumentError(`expected a finite decimal number (got "${raw}")`);
  }
  return parsed;
}

function assertPropertyValueUsage(opts: NodeAddOpts): void {
  if (opts.propertyValue === undefined) return;
  if (opts.type !== 'deviceInput' && opts.type !== 'deviceGet') {
    throw new ConfigError(
      `--property-value only applies to deviceInput/deviceGet property-mode shortcuts (got --type ${opts.type})`,
    );
  }
  if (
    opts.deviceDid === undefined ||
    opts.deviceProperty === undefined ||
    opts.deviceEvent !== undefined ||
    opts.cfg !== undefined
  ) {
    throw new ConfigError(
      '--property-value requires --device-did plus --device-property and is not valid with --device-event or legacy --cfg',
    );
  }
  if (opts.propertyValue.length === 0) {
    throw new ConfigError('--property-value must not be empty');
  }
  if (opts.threshold !== undefined || opts.threshold2 !== undefined) {
    throw new ConfigError('--property-value is mutually exclusive with --threshold/--threshold2');
  }
  if (opts.op !== undefined && opts.op !== 'eq') {
    throw new ConfigError('--property-value only supports --op eq');
  }
}

interface NodeAddOpts extends RuleOpts {
  ruleId: string;
  type: string;
  cfg?: string;
  id?: string;
  snapshot?: boolean;
  snapshotsDir?: string;
  validate?: boolean;
  // F66f (2026-05-31) — opt out of the incremental var-existence sweep.
  // Default ON; pass --no-var-check for raw probes / restore flows.
  varCheck?: boolean;
  deviceDid?: string;
  // F63c (2026-05-30): disambiguates --device-property/--device-action/
  // --device-event when a spec exposes the same short-name under multiple
  // services. Filters the resolver to the requested siid.
  deviceSiid?: number;
  deviceProperty?: string;
  deviceAction?: string;
  deviceEvent?: string;
  // B9 / F63d (2026-05-30) — repeatable per-piid filter expressions for
  // deviceInput event-mode. Each value is `<piid><op><v1>` (op ∈ =, !=, >,
  // <, >=, <=). Commander collects via the accumulator function below.
  eventFilter?: string[];
  // B4 / F65a (2026-05-30) — repeatable per-piid variable routing for
  // deviceInputSetVar event-mode. Each value is `<piid>=<scope>.<id>`
  // (e.g. `1=global.lockOpId`). Used for multi-arg events where each
  // captured event-argument flows into its own destination variable.
  eventArgVar?: string[];
  threshold?: number;
  propertyValue?: string;
  op?: string;
  params?: string;
  value?: string;
  forceOutOfRange?: boolean;
  allowNoPush?: boolean;
  pos?: { x: number; y: number; width: number; height: number };
  // M10 F17 — non-device shortcut flags
  inputs?: number;
  duration?: string;
  interval?: string;
  start?: string;
  end?: string;
  weekdayOnly?: boolean;
  holidayOnly?: boolean;
  days?: number[];
  varScope?: string;
  varId?: string;
  varType?: string;
  // F41 (2026-05-30) — string varType comparison literal. Required for
  // varChange/varGet when --var-type string; mutually exclusive with
  // --threshold. Forwarded as-is (no Number.parseFloat coercion which
  // would NaN-out any non-numeric input).
  varValue?: string;
  threshold2?: number;
  allowUnknownScope?: boolean;
  at?: string;
  sunrise?: boolean;
  sunset?: boolean;
  offsetMin?: number;
  latitude?: number;
  longitude?: number;
  // M14 task F — varSetNumber/varSetString expression
  expr?: string;
  defaultExprScope?: string;
  outputs?: number;
  refreshHint?: boolean;
  nextHint?: boolean;
}

export function attachNodeAdd(cmd: Command): void {
  const node = cmd.commands.find((c) => c.name() === 'node') ?? cmd.command('node');
  if (!node.description()) node.description('Node operations within a rule');
  const sub = node
    .command('add')
    .description('Add a node to a rule graph')
    .requiredOption('--rule-id <id>', 'rule id')
    .requiredOption('--type <T>', 'node type (e.g. deviceInput)')
    .option(
      '--cfg <JSON>',
      'full node JSON (legacy path) — accepts either the 4-tuple {cfg,inputs,outputs,props} OR just the cfg field; the gateway requires the full shape for node types that have no c-shortcut',
    )
    .option('--id <NID>', 'override node id (default: random)')
    .option('--no-snapshot', 'skip the pre-write dump snapshot')
    .option('--no-validate', 'skip the web-UI save-button validator (NOT recommended)')
    .option(
      '--no-var-check',
      'skip the F66f incremental var-existence sweep (only meaningful with --validate; useful for raw probes where var refs are about to be materialised by the same batch)',
    )
    .option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)')
    .option('--base-url <url>', 'gateway base URL')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .option(
      '--device-did <DID>',
      'device did for shortcut path (synthesizes cfg/inputs/outputs/props)',
    )
    .option(
      '--device-siid <N>',
      'service iid to disambiguate --device-property/--device-action/--device-event when the spec exposes the same short-name under multiple services (F63c)',
      Number.parseInt,
    )
    .option(
      '--device-property <P>',
      'device property name (deviceInput trigger | deviceOutput property-write target)',
    )
    .option('--device-action <A>', 'device action name (deviceOutput action-invoke)')
    .option(
      '--device-event <E>',
      'device event name for event-driven deviceInput trigger (e.g. click, double-click, long-press, motion-detected)',
    )
    .option(
      '--event-filter <piid><op><v1>',
      "deviceInput event-mode argument filter (repeatable). Forms: <piid>=<v1> | <piid>!=<v1> | <piid>><v1> | <piid><<v1> | <piid>>=<v1> | <piid><=<v1>. Operator/v1 validated against the event spec comparison dtype (F40/F59): bool/string → '=' only; int (including float + non-empty value-list enums) → 6 scalar ops; continuous float → '>' / '<' only. Mutually exclusive with --cfg. Example: --event-filter 1=1 --event-filter 3=2",
      (v: string, acc: string[] = []) => acc.concat(v),
      [] as string[],
    )
    .option(
      '--event-arg-var <piid>=<scope>.<id>',
      'deviceInputSetVar event-mode per-arg variable routing (repeatable). scope/id are non-empty ASCII alphanumeric [A-Za-z0-9]+. Mutually exclusive with --var-scope/--var-id and --cfg. Example: --event-arg-var 1=global.lockOpId',
      (v: string, acc: string[] = []) => acc.concat(v),
      [] as string[],
    )
    .option(
      '--threshold <N>',
      'numeric comparison threshold (deviceInput/deviceGet) or count threshold (counter/onlyNTimes)',
      parseFiniteDecimal,
    )
    .option(
      '--property-value <S>',
      'deviceInput/deviceGet string-property equality literal (required for string properties; mutually exclusive with --threshold/--threshold2)',
    )
    .option(
      '--op <OP>',
      'comparison operator: gt|lt|eq|ne|gte|lte|between. F49 — `between` requires --threshold (v1) + --threshold2 (v2); int/float deviceInput/deviceGet + number varType varChange/varGet only.',
    )
    .option(
      '--params <JSON>',
      'action input params as JSON; variable refs use {"param":{"$var":"global.varId"}}',
    )
    .option(
      '--value <V>',
      'property write value (deviceOutput property-write); use $global.varId for a variable ref; literals are coerced per MIoT format',
    )
    .option(
      '--force-out-of-range',
      'bypass the M11 F19 threshold ∈ MIoT value-range check on deviceInput',
    )
    .option(
      '--allow-no-push',
      'silence F17 warning for deviceInput state-mode on pushAvailable=false devices',
    )
    .option(
      '--pos <x,y,width,height>',
      'canvas position override (preserves layout from xgg rule export round-trips)',
      (raw) => {
        const parts = raw.split(',').map((s) => Number.parseFloat(s));
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
          throw new Error(`--pos must be x,y,width,height numbers (got "${raw}")`);
        }
        const [x, y, width, height] = parts;
        return { x: x as number, y: y as number, width: width as number, height: height as number };
      },
    )
    // M10 F17 — non-device shortcut flags
    .option('--inputs <N>', 'logicAnd/logicOr/signalOr input count (default 2)', Number.parseInt)
    .option(
      '--duration <S>',
      'delay/statusLast/eventSequence duration (delay: integer; others: positive integer; unit ms|s|m)',
    )
    .option(
      '--interval <S>',
      'loop interval (gateway-compatible integer + ms|s|m, e.g. 0ms, 30s, 1m)',
    )
    .option('--start <HH:MM[:SS]>', 'timeRange start time')
    .option('--end <HH:MM[:SS]>', 'timeRange end time')
    .option('--weekday-only', 'timeRange/alarmClock fires only on legal workdays')
    .option('--holiday-only', 'timeRange/alarmClock fires only on legal holidays')
    .option(
      '--days <0,1,...>',
      'timeRange/alarmClock fires only on these weekdays (Sun=0..Sat=6, comma-separated)',
      (raw) => raw.split(',').map((s) => Number.parseInt(s, 10)),
    )
    .option(
      '--var-scope <S>',
      'variable scope for varChange/device*SetVar (non-empty [A-Za-z0-9]+)',
    )
    .option(
      '--var-id <I>',
      'variable id for varChange/device*SetVar (non-empty [A-Za-z0-9]+; may start with a digit)',
    )
    .option(
      '--var-type <T>',
      'varChange variable type: number|string (gateway-supported vocab — F16)',
    )
    .option(
      '--var-value <S>',
      'varChange/varGet string-varType comparison literal (required for --var-type string; mutually exclusive with --threshold — F41)',
    )
    .option('--threshold2 <N>', 'optional second threshold for --op between', parseFiniteDecimal)
    .option(
      '--allow-unknown-scope',
      'silence F29 warning when --var-scope is not in KNOWN_UI_SCOPES',
    )
    .option('--at <HH:MM[:SS]>', 'alarmClock periodicAlarm time-of-day')
    .option('--sunrise', 'alarmClock sunrise trigger')
    .option('--sunset', 'alarmClock sunset trigger')
    .option(
      '--offset-min <N>',
      'alarmClock minutes offset from sunrise/sunset (negative=before)',
      Number.parseFloat,
    )
    .option('--latitude <DEG>', 'alarmClock sunrise/sunset latitude', Number.parseFloat)
    .option('--longitude <DEG>', 'alarmClock sunrise/sunset longitude', Number.parseFloat)
    .option(
      '--expr <S>',
      'varSetNumber/varSetString expression. Variable scope/id use [A-Za-z0-9]+ and may start with a digit. Use $id or $scope.id; $$ for literal $. Invalid unescaped $ references fail locally.',
    )
    .option(
      '--default-expr-scope <S>',
      'default scope for unqualified $id in --expr (default: global; non-empty [A-Za-z0-9]+)',
    )
    .option(
      '--outputs <N>',
      'modeSwitch number of output pins (>= 2; creates output0..outputN-1)',
      Number.parseInt,
    );
  addNextHintFlag(addRefreshHintFlag(sub))
    .addHelpText(
      'after',
      `
Examples (M7+M9 device shortcut path):
  # Property trigger
  $ xgg rule node add --rule-id r1 --type deviceInput \\
      --device-did lumi.<DID> --device-property temperature --op gt --threshold 27
  # Event trigger (M9 F11 — BLE button etc.)
  $ xgg rule node add --rule-id r1 --type deviceInput \\
      --device-did blt.3.<DID> --device-event click
  # Event trigger with per-arg filters (B9 — smart lock lock-event etc.)
  $ xgg rule node add --rule-id r1 --type deviceInput \\
      --device-did lumi.<DID> --device-event lock-event \\
      --event-filter 1=1 --event-filter 3=2
  # Action invoke (e.g. speaker play-text)
  $ xgg rule node add --rule-id r1 --type deviceOutput \\
      --device-did lumi.<DID> --device-action play-text \\
      --params '{"text-content":"Hello"}'
  # Action invoke with variable parameter (web UI var selector wire shape)
  $ xgg rule node add --rule-id r1 --type deviceOutput \\
      --device-did lumi.<DID> --device-action play-text \\
      --params '{"text-content":{"$var":"global.skillWalkMsg"}}'
  # Property write (F16; light/AC/plug with no action)
  $ xgg rule node add --rule-id r1 --type deviceOutput \\
      --device-did <DID> --device-property on --value true
  # Property write from variable
  $ xgg rule node add --rule-id r1 --type deviceOutput \\
      --device-did <DID> --device-property brightness --value '$global.skillWalkTemp'
  # Copy a device property into a variable on notify
  $ xgg rule node add --rule-id r1 --type deviceInputSetVar \\
      --device-did <DID> --device-property on \\
      --var-scope global --var-id skillWalkCount
  # Query a device property into a variable on input event
  $ xgg rule node add --rule-id r1 --type deviceGetSetVar \\
      --device-did <DID> --device-property on \\
      --var-scope global --var-id skillWalkCount
  # Multi-arg setVar event (B4/F65a — e.g. smart lock lock-event 4 args → 4 vars)
  $ xgg rule node add --rule-id r1 --type deviceInputSetVar \\
      --device-did <DID> --device-event lock-event \\
      --event-arg-var 1=global.lockOpId \\
      --event-arg-var 3=global.lockMethod \\
      --event-arg-var 5=global.lockTime

Examples (M10 F17 non-device shortcut path):
  $ xgg rule node add --rule-id r1 --type onLoad
  $ xgg rule node add --rule-id r1 --type condition
  $ xgg rule node add --rule-id r1 --type logicAnd --inputs 3
  $ xgg rule node add --rule-id r1 --type logicOr --inputs 2
  $ xgg rule node add --rule-id r1 --type signalOr --inputs 3
  $ xgg rule node add --rule-id r1 --type logicNot
  $ xgg rule node add --rule-id r1 --type counter --threshold 3
  $ xgg rule node add --rule-id r1 --type onlyNTimes --threshold 3
  $ xgg rule node add --rule-id r1 --type delay --duration 5s
  $ xgg rule node add --rule-id r1 --type statusLast --duration 10s
  $ xgg rule node add --rule-id r1 --type loop --interval 30s
  $ xgg rule node add --rule-id r1 --type timeRange --start 08:00 --end 22:30 --weekday-only
  $ xgg rule node add --rule-id r1 --type varChange \\
      --var-scope global --var-id mode --var-type number --op eq --threshold 1
  $ xgg rule node add --rule-id r1 --type alarmClock --at 07:30 --days 1,2,3,4,5
  $ xgg rule node add --rule-id r1 --type alarmClock --sunset \\
      --latitude 30.46 --longitude 114.41 --offset-min -15

Examples (legacy --cfg path — full 4-tuple for node types without a c-shortcut):
  # eventSequence (two ordered inputs within timeout)
  $ xgg rule node add --rule-id r1 --type eventSequence --id n-seq --cfg '{
      "cfg":    {"pos":{"x":200,"y":200,"width":200,"height":120},"name":"eventSequence","version":1,"unit":"s","value":5},
      "inputs": {"input1":null,"input2":null},
      "outputs":{"output":[]},
      "props":  {"timeout":5000}
    }'`,
    )
    .action(
      wrap('rule.node.add', async (opts: NodeAddOpts) => {
        const parsedParams = opts.params !== undefined ? parseParamsJson(opts.params) : undefined;
        const parsedCfg =
          opts.cfg !== undefined ? parseJsonInput<unknown>(opts.cfg, '--cfg') : undefined;
        // This flag's applicability is entirely local. Reject misuse before
        // Agent guards, session lookup, device warnings, snapshots, or IPC so
        // authentication state cannot mask a deterministic authoring error.
        assertPropertyValueUsage(opts);
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const { snapshotsDir } = guard;
        const deps = makeDeps(opts);

        let addNodeInput: Parameters<typeof addNode>[0];
        const NON_DEVICE_TYPES = new Set([
          'onLoad',
          'condition',
          'logicAnd',
          'logicOr',
          'signalOr',
          'logicNot',
          'counter',
          'onlyNTimes',
          'delay',
          'statusLast',
          'loop',
          'timeRange',
          'varChange',
          'varGet',
          'varSetNumber',
          'varSetString',
          'register',
          'eventSequence',
          'modeSwitch',
          'alarmClock',
        ]);
        if (NON_DEVICE_TYPES.has(opts.type)) {
          // M10 F17 — non-device shortcut: build from CLI flags only, no
          // gateway device/spec lookup
          if (opts.type === 'varChange' || opts.type === 'varGet') {
            warnIfGhostScope(opts.type, opts.varScope, opts.allowUnknownScope);
          }
          const shortcut: AddNodeShortcut = {
            type: opts.type as AddNodeShortcut['type'],
            ...(opts.id !== undefined && { id: opts.id }),
            ...(opts.pos !== undefined && { pos: opts.pos }),
            ...(opts.inputs !== undefined && { inputs: opts.inputs }),
            ...(opts.duration !== undefined && { duration: opts.duration }),
            ...(opts.interval !== undefined && { interval: opts.interval }),
            ...(opts.start !== undefined && { start: opts.start }),
            ...(opts.end !== undefined && { end: opts.end }),
            ...(opts.weekdayOnly === true && { weekdayOnly: true }),
            ...(opts.holidayOnly === true && { holidayOnly: true }),
            ...(opts.days !== undefined && { days: opts.days }),
            ...(opts.varScope !== undefined && { varScope: opts.varScope }),
            ...(opts.varId !== undefined && { varId: opts.varId }),
            ...(opts.varType !== undefined && {
              // F16 (2026-05-28): gateway variable type vocab is strictly
              // number/string; reject "boolean" up front rather than letting
              // the eventual setGraph fail with `Unsupported type`.
              varType: ((): 'number' | 'string' => {
                if (opts.varType === 'number' || opts.varType === 'string') return opts.varType;
                throw new ConfigError(
                  `--var-type "${opts.varType}" is not a valid gateway variable type. The gateway only supports "number" and "string". To track on/off state, use a number variable (1/0) or a string variable ("on"/"off").`,
                );
              })(),
            }),
            ...(opts.op !== undefined && {
              op: opts.op as 'gt' | 'lt' | 'eq' | 'ne' | 'gte' | 'lte' | 'between',
            }),
            ...(opts.threshold !== undefined && { threshold: opts.threshold }),
            ...(opts.varValue !== undefined && { varValue: opts.varValue }),
            ...(opts.threshold2 !== undefined && { threshold2: opts.threshold2 }),
            ...(opts.allowUnknownScope === true && { allowUnknownScope: true }),
            ...(opts.at !== undefined && { at: opts.at }),
            ...(opts.sunrise === true && { sunrise: true }),
            ...(opts.sunset === true && { sunset: true }),
            ...(opts.offsetMin !== undefined && { offsetMin: opts.offsetMin }),
            ...(opts.latitude !== undefined && { latitude: opts.latitude }),
            ...(opts.longitude !== undefined && { longitude: opts.longitude }),
            ...(opts.expr !== undefined && { expr: opts.expr }),
            ...(opts.defaultExprScope !== undefined && {
              defaultExprScope: opts.defaultExprScope,
            }),
            ...(opts.outputs !== undefined && { outputsCount: opts.outputs }),
          };
          addNodeInput = {
            ruleId: opts.ruleId,
            shortcut,
            validate: opts.validate !== false,
            varCheck: opts.varCheck !== false,
          };
        } else if (opts.deviceDid) {
          // Device shortcut path — synthesizes 4-piece node from device spec
          if (
            opts.type === 'deviceInput' &&
            opts.deviceProperty !== undefined &&
            opts.deviceEvent === undefined
          ) {
            await warnIfDeviceInputNoPush(opts.deviceDid, deps, opts.allowNoPush);
          }
          if (opts.type === 'deviceInputSetVar' || opts.type === 'deviceGetSetVar') {
            warnIfGhostScope(opts.type, opts.varScope, opts.allowUnknownScope);
          }
          // B9 / F63d (2026-05-30) — --event-filter is event-mode-only; reject
          // when the user didn't pass --device-event so the synth doesn't
          // silently drop the flag.
          if ((opts.eventFilter?.length ?? 0) > 0) {
            if (opts.type !== 'deviceInput') {
              throw new ConfigError(
                `--event-filter only applies to deviceInput event-mode (got --type ${opts.type})`,
              );
            }
            if (opts.deviceEvent === undefined) {
              throw new ConfigError(
                '--event-filter requires --device-event (event-mode only). Property-mode triggers use --op/--threshold.',
              );
            }
          }
          // B4 / F65a (2026-05-30) — --event-arg-var is deviceInputSetVar
          // event-mode-only; reject misuse up front so the synth doesn't
          // silently drop the flag.
          if ((opts.eventArgVar?.length ?? 0) > 0) {
            if (opts.type !== 'deviceInputSetVar') {
              throw new ConfigError(
                `--event-arg-var only applies to deviceInputSetVar event-mode (got --type ${opts.type})`,
              );
            }
            if (opts.deviceEvent === undefined) {
              throw new ConfigError(
                '--event-arg-var requires --device-event (event-mode only). Property-mode setVar uses --device-property + --var-scope/--var-id.',
              );
            }
          }
          const shortcut: AddNodeShortcut = {
            type: opts.type as AddNodeShortcut['type'],
            ...(opts.id !== undefined && { id: opts.id }),
            ...(opts.pos !== undefined && { pos: opts.pos }),
            deviceDid: opts.deviceDid,
            ...(opts.deviceSiid !== undefined && { deviceSiid: opts.deviceSiid }),
            ...(opts.deviceProperty !== undefined && { deviceProperty: opts.deviceProperty }),
            ...(opts.deviceAction !== undefined && { deviceAction: opts.deviceAction }),
            ...(opts.deviceEvent !== undefined && { deviceEvent: opts.deviceEvent }),
            ...(opts.eventFilter !== undefined &&
              opts.eventFilter.length > 0 && { deviceEventArgs: opts.eventFilter }),
            ...(opts.eventArgVar !== undefined &&
              opts.eventArgVar.length > 0 && { deviceEventArgVars: opts.eventArgVar }),
            ...(opts.threshold !== undefined && { threshold: opts.threshold }),
            ...(opts.propertyValue !== undefined && { propertyValue: opts.propertyValue }),
            // F49 (2026-05-30) — --threshold2 must reach device-shortcut
            // path too (used by deviceInput/deviceGet `--op between`).
            // Previously only forwarded inside the non-device branch.
            ...(opts.threshold2 !== undefined && { threshold2: opts.threshold2 }),
            ...(opts.op !== undefined && {
              op: opts.op as 'gt' | 'lt' | 'eq' | 'ne' | 'gte' | 'lte' | 'between',
            }),
            ...(parsedParams !== undefined && { params: parsedParams }),
            ...(opts.value !== undefined && { value: opts.value }),
            ...(opts.forceOutOfRange === true && { forceOutOfRange: true }),
            ...(opts.varScope !== undefined && { varScope: opts.varScope }),
            ...(opts.varId !== undefined && { varId: opts.varId }),
          };
          addNodeInput = {
            ruleId: opts.ruleId,
            shortcut,
            validate: opts.validate !== false,
            varCheck: opts.varCheck !== false,
          };
        } else {
          // Legacy --cfg path
          if (parsedCfg === undefined) {
            throw new ConfigError(
              'Either a non-device --type, --device-did (device shortcut), or --cfg (legacy) is required',
            );
          }
          // B9 / F63d (2026-05-30) — --event-filter is shortcut-only; reject
          // when the user mixes it with --cfg to avoid silent drop.
          if ((opts.eventFilter?.length ?? 0) > 0) {
            throw new ConfigError(
              '--event-filter is mutually exclusive with --cfg. Either drop --cfg and use the device shortcut path, or hand-craft the arguments[] elements inside --cfg.',
            );
          }
          // B4 / F65a (2026-05-30) — --event-arg-var is shortcut-only;
          // reject when the user mixes it with --cfg to avoid silent drop.
          if ((opts.eventArgVar?.length ?? 0) > 0) {
            throw new ConfigError(
              '--event-arg-var is mutually exclusive with --cfg. Either drop --cfg and use the device shortcut path, or hand-craft the arguments[] elements inside --cfg.',
            );
          }
          const parsed = parsedCfg;
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ConfigError('--cfg must be a JSON object');
          }
          // M13 finding: --cfg historically was treated as the `cfg` field
          // only, which surfaces as "Invalid node parameter: Invalid props"
          // because non-shortcut node types require {cfg, inputs, outputs, props}.
          // Accept either form: full 4-tuple (preferred) or cfg-only (legacy
          // shape).
          const obj = parsed as Record<string, unknown>;
          const looksLikeFullNode =
            'cfg' in obj || 'inputs' in obj || 'outputs' in obj || 'props' in obj;
          const idFallback = opts.id ?? `n-${Date.now()}`;
          const node = looksLikeFullNode
            ? {
                ...obj,
                id: opts.id ?? (obj.id as string | undefined) ?? idFallback,
                type: opts.type,
              }
            : { id: idFallback, type: opts.type, cfg: obj };
          // For the 25 modeled node types, validate the hand-crafted node
          // against that type's strict schema *before* the gateway round-trip.
          // NodeUnion.safeParse can't do this — UnknownNode sits last and matches
          // any {type, id}, so a deviceInput with malformed props would fall
          // through and only fail at the gateway with a cryptic "Invalid props".
          // An unmodeled --type (or empty, which becomes a SchemaError inside
          // addNode) returns undefined here and falls through unchanged. Gated on
          // --validate so --no-validate skips it like the gateway-side check.
          const specificSchema = opts.validate !== false ? nodeSchemaForType(opts.type) : undefined;
          if (specificSchema) {
            const result = specificSchema.safeParse(node);
            if (!result.success) {
              const issue = result.error.issues[0];
              const where = issue && issue.path.length > 0 ? issue.path.join('.') : '<root>';
              const why = issue?.message ?? 'does not match the schema';
              throw new ConfigError(
                `--cfg shape invalid at ${where}: ${why} (type "${opts.type}"). Non-shortcut nodes need the full {cfg, inputs, outputs, props} tuple; see \`xgg rule node add --help\`.`,
              );
            }
          }
          addNodeInput = {
            ruleId: opts.ruleId,
            node,
            validate: opts.validate !== false,
            varCheck: opts.varCheck !== false,
          };
        }

        const snapshotPath = !guard.snapshotEnabled
          ? null
          : await dumpBeforeWrite({
              baseUrl: deps.baseUrl,
              store: deps.store,
              ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
              ...(snapshotsDir !== undefined && { snapshotsDir }),
            });

        const result = await addNode(addNodeInput, deps);
        const payloadBase = {
          ok: true,
          nodeId: result.nodeId,
          type: opts.type,
          snapshot: snapshotPath,
        } as Record<string, unknown>;
        const hints = buildNextSteps(
          'rule.node.add',
          { nodeId: result.nodeId, ruleId: opts.ruleId, type: opts.type },
          opts,
        );
        emit(nextHintOptedOut(opts) ? payloadBase : withNextSteps(payloadBase, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `rule ${opts.ruleId} (node-add ${opts.type})`,
        });
        printNextStepHintLine(hints, opts, {
          contextLabel: `rule ${opts.ruleId} (+node ${opts.type})`,
        });
      }),
    );
}
