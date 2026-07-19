import {
  ConfigError,
  GatewayError,
  NotFoundError,
  type SnapshotAllVariablesResult,
  VARIABLE_IDENTIFIER_CONSTRAINT,
  type VariableSnapshot,
  createStore,
  createVariable,
  deleteVariable,
  diffVariableSnapshots,
  dumpBeforeWrite,
  getVariableConfig,
  getVariableValue,
  isMissingScopeError,
  isValidVariableIdentifier,
  listScopes,
  listVariables,
  setVariableConfig,
  setVariableValue,
  snapshotAllVariables,
} from '@eyaeya/xgg-core';
import Table from 'cli-table3';
import { Command } from 'commander';
import { wrap } from '../action-wrap.js';
import {
  type NextStepHint,
  addNextHintFlag,
  buildNextSteps,
  nextHintOptedOut,
  printNextStepHintLine,
  withNextSteps,
} from '../agent-hints.js';
import { parsePositiveTimerMs } from '../local-input.js';
import { type TableColumn, emit, emitList } from '../output.js';
import {
  type ResolvedMutationGuard,
  addRefreshHintFlag,
  assertAgentModeOrSnapshotsDir,
  printRefreshHint,
} from './_mutation-guard.js';

interface VariableOpts {
  baseUrl?: string;
  sessionFile?: string;
  timeout: string;
  pretty?: boolean;
}

interface MutationOpts extends VariableOpts {
  snapshot?: boolean;
  snapshotsDir?: string;
  allowUnknownScope?: boolean;
  refreshHint?: boolean;
  nextHint?: boolean;
}

function makeDeps(opts: VariableOpts) {
  const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
  if (!baseUrl) throw new ConfigError('missing --base-url or XGG_BASE_URL');
  const timeoutMs = parsePositiveTimerMs(opts.timeout, '--timeout');
  const store = createStore(opts.sessionFile ? { sessionFile: opts.sessionFile } : {});
  return { baseUrl, store, timeoutMs };
}

async function maybeSnapshot(
  guard: ResolvedMutationGuard,
  deps: ReturnType<typeof makeDeps>,
): Promise<{ snapshotPath: string | null }> {
  if (!guard.snapshotEnabled) return { snapshotPath: null };
  const snapshotPath = await dumpBeforeWrite({
    baseUrl: deps.baseUrl,
    store: deps.store,
    ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
    ...(guard.snapshotsDir !== undefined && { snapshotsDir: guard.snapshotsDir }),
  });
  return { snapshotPath };
}

function addMutationFlags<T extends Command>(c: T): T {
  c.option('--no-snapshot', 'skip the pre-write dump snapshot (NOT recommended)');
  c.option('--snapshots-dir <path>', 'directory for pre-write snapshots (env: XGG_SNAPSHOTS_DIR)');
  c.option(
    '--allow-unknown-scope',
    'silence the M10 F29 warning for scopes the 米家网关 UI cannot display',
  );
  // B10 / F63e — opt-out for the post-write "refresh 米家 web UI" hint.
  addRefreshHintFlag(c);
  // Task 14 — opt-out for the post-action "next →" agent hint (spec §5.4).
  addNextHintFlag(c);
  return c;
}

// M10 F29 (codex M8 T4): the gateway happily persists variables in any
// scope name, but the 米家网关 web UI only renders the `global` scope.
// Anything else (e.g. `rule`, `m7probe`) becomes ghost data the user
// will never see in their UI. Print a one-line stderr warning so the
// AI agent or human operator at least notices; suppress with the
// `--allow-unknown-scope` opt-in for tests / experiments.
const KNOWN_UI_SCOPES = new Set(['global']);

function warnIfGhostScope(scope: string, allow: boolean | undefined): void {
  if (allow === true) return;
  if (KNOWN_UI_SCOPES.has(scope)) return;
  process.stderr.write(
    `[xgg variable] warning: scope "${scope}" is not in the web-UI-known set (${[...KNOWN_UI_SCOPES].join(', ')}); the gateway will persist it but the 米家网关 UI will not display the variable. Pass --allow-unknown-scope to silence (M10 F29).\n`,
  );
}

// F16 (2026-05-28 audit): gateway variable type vocab is strictly
// `number | string`. `createVar` rejects `boolean` / `bool` / `int` /
// anything else with `Unsupported type`. The CLI previously accepted
// `boolean` here and would silently produce setGraph rejections at
// runtime — reject up front with a clear error instead.
function parseScalar(type: string, raw: string): number | string {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new ConfigError(`--value "${raw}" is not a number`);
      return n;
    }
    case 'string':
      return raw;
    case 'boolean':
      throw new ConfigError(
        `--type "boolean" is not a valid gateway variable type. The gateway only supports "number" and "string" (verified 2026-05-28 — createVar rejects "bool"/"boolean"/"int" with "Unsupported type"). To track an on/off state, store it as a number variable (1/0) or string variable ("on"/"off") and compare with the same vocab.`,
      );
    default:
      throw new ConfigError(`--type must be number|string, got "${type}"`);
  }
}

export function variableCommand(): Command {
  const cmd = new Command('variable').description('Variable scope operations');

  cmd
    .command('list')
    .description('List all variable scopes on the gateway')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: table view (default: compact JSON)')
    .addHelpText('after', '\nExample:\n  $ xgg variable list --pretty')
    .action(
      wrap('variable.list', async (opts: VariableOpts) => {
        const deps = makeDeps(opts);
        const result = await listScopes(deps);
        const rows = result.map((scope) => ({ scope }));
        const columns: TableColumn<(typeof rows)[number]>[] = [
          { header: 'scope', get: (r) => r.scope },
        ];
        emitList(
          { jsonPayload: { ok: true, scopes: result }, columns, rows },
          { pretty: opts.pretty === true },
        );
      }),
    );

  cmd
    .command('get <scope>')
    .description('Get all variables in a scope')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print: table view (default: compact JSON)')
    .addHelpText('after', '\nExample:\n  $ xgg variable get myscope --pretty')
    .action(
      wrap('variable.get', async (scope: string, opts: VariableOpts) => {
        const deps = makeDeps(opts);
        const result = await listVariables(scope, deps);
        const rows = Object.entries(result).map(([id, v]) => ({
          id,
          type: typeof v.type === 'string' ? v.type : String(v.type ?? ''),
          value: typeof v.value === 'string' ? v.value : JSON.stringify(v.value),
        }));
        const columns: TableColumn<(typeof rows)[number]>[] = [
          { header: 'id', get: (r) => r.id },
          { header: 'type', get: (r) => r.type },
          { header: 'value', get: (r) => r.value },
        ];
        emitList(
          { jsonPayload: { ok: true, variables: result }, columns, rows },
          { pretty: opts.pretty === true },
        );
      }),
    );

  // M11 backlog drain — single-variable getters (codex M8 T4 partial gap).
  interface SingleGetterOpts extends VariableOpts {
    scope: string;
    id: string;
  }

  cmd
    .command('get-config')
    .description('Read a single variable config (gateway /api/getVarConfig)')
    .requiredOption('--scope <name>', 'scope name')
    .requiredOption('--id <id>', 'variable id')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText('after', '\nExample:\n  $ xgg variable get-config --scope global --id mode')
    .action(
      wrap('variable.get-config', async (opts: SingleGetterOpts) => {
        const deps = makeDeps(opts);
        const config = await getVariableConfig(opts.scope, opts.id, deps);
        emit(
          { ok: true, scope: opts.scope, id: opts.id, config },
          { pretty: opts.pretty === true },
        );
      }),
    );

  cmd
    .command('get-value')
    .description('Read a single variable current value (gateway /api/getVarValue)')
    .requiredOption('--scope <name>', 'scope name')
    .requiredOption('--id <id>', 'variable id')
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText('after', '\nExample:\n  $ xgg variable get-value --scope global --id mode')
    .action(
      wrap('variable.get-value', async (opts: SingleGetterOpts) => {
        const deps = makeDeps(opts);
        // F66-VarEntry-strict (2026-05-31): typed return is `{value: ...}`;
        // unwrap so the CLI emits {scope, id, value: <scalar>} not nested.
        const { value } = await getVariableValue(opts.scope, opts.id, deps);
        emit({ ok: true, scope: opts.scope, id: opts.id, value }, { pretty: opts.pretty === true });
      }),
    );

  interface CreateOpts extends MutationOpts {
    scope: string;
    id: string;
    type: 'number' | 'string';
    value: string;
    name: string;
    ifCompatible?: boolean;
    checkOnly?: boolean;
  }

  addMutationFlags(
    cmd
      .command('create')
      .description('Create a variable in a scope')
      .requiredOption(
        '--scope <name>',
        'scope name (auto-created if absent; non-empty [A-Za-z0-9]+, may start with a digit)',
      )
      .requiredOption(
        '--id <id>',
        'variable id within scope (non-empty [A-Za-z0-9]+, may start with a digit)',
      )
      .requiredOption('--type <type>', 'number|string')
      .requiredOption(
        '--value <value>',
        'initial value (number: numeric conversion; string: argv text verbatim, including quotes)',
      )
      .requiredOption('--name <name>', 'display name')
      .option(
        '--if-compatible',
        'replay-safe mode: keep an existing variable only when type, value and display name match exactly; otherwise fail without overwriting it',
      )
      .option(
        '--check-only',
        'with --if-compatible, perform a read-only compatibility preflight; a missing variable is reported but not created',
      ),
  )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      '\nExample:\n  $ xgg variable create --scope my --id temp --type number --value 0 --name "Temp"\n\nNote: --scope and --id must be non-empty ASCII alphanumeric [A-Za-z0-9]+ (digit-leading values are valid; no hyphen / underscore / dot).\nThe gateway rejects other characters with "Invalid id format"; xgg pre-flights this (F65b).\n--check-only requires --if-compatible and performs only the read phase used by multi-variable replay preflight.',
    )
    .action(
      wrap('variable.create', async (opts: CreateOpts) => {
        const value = parseScalar(opts.type, opts.value);
        if (opts.checkOnly === true && opts.ifCompatible !== true) {
          throw new ConfigError('--check-only requires --if-compatible');
        }
        if (!isValidVariableIdentifier(opts.scope)) {
          throw new ConfigError(`--scope "${opts.scope}" ${VARIABLE_IDENTIFIER_CONSTRAINT}`, {
            flag: '--scope',
            scope: opts.scope,
          });
        }
        if (!isValidVariableIdentifier(opts.id)) {
          throw new ConfigError(`--id "${opts.id}" ${VARIABLE_IDENTIFIER_CONSTRAINT}`, {
            flag: '--id',
            id: opts.id,
          });
        }
        if (opts.name.trim().length < 1) {
          throw new ConfigError('--name must be non-empty', { flag: '--name' });
        }
        // F66-VarUserData-relax (2026-05-31): the Mi-Home UI's createVar
        // payload sends only userData.name; validate that same final request
        // locally before --check-only can take its early read-only return.
        const createInput = {
          scope: opts.scope,
          id: opts.id,
          type: opts.type,
          value,
          userData: { name: opts.name },
        };
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const deps = makeDeps(opts);
        warnIfGhostScope(opts.scope, opts.allowUnknownScope);
        if (opts.ifCompatible === true) {
          const existing = await readExistingVariableForReplay(opts.scope, opts.id, deps);
          if (existing !== undefined) {
            assertVariableReplayCompatible(existing, {
              scope: opts.scope,
              id: opts.id,
              type: opts.type,
              value,
              name: opts.name,
            });
            const payload = {
              ok: true,
              scope: opts.scope,
              id: opts.id,
              type: opts.type,
              value,
              created: false,
              existing: true,
              ...(opts.checkOnly === true && { checkOnly: true }),
              snapshot: null,
            } as Record<string, unknown>;
            const hints = buildNextSteps('variable.create', payload, opts);
            emit(nextHintOptedOut(opts) ? payload : withNextSteps(payload, hints), {
              pretty: opts.pretty === true,
            });
            printNextStepHintLine(hints, opts, {
              contextLabel: `variable ${opts.scope}/${opts.id} (already compatible)`,
            });
            return;
          }
          if (opts.checkOnly === true) {
            const payload = {
              ok: true,
              scope: opts.scope,
              id: opts.id,
              type: opts.type,
              value,
              created: false,
              existing: false,
              missing: true,
              checkOnly: true,
              snapshot: null,
            } as Record<string, unknown>;
            const hints = buildNextSteps('variable.create', payload, opts);
            emit(nextHintOptedOut(opts) ? payload : withNextSteps(payload, hints), {
              pretty: opts.pretty === true,
            });
            printNextStepHintLine(hints, opts, {
              contextLabel: `variable ${opts.scope}/${opts.id} (preflight: missing)`,
            });
            return;
          }
        }
        const { snapshotPath } = await maybeSnapshot(guard, deps);
        try {
          await createVariable(createInput, deps);
        } catch (error) {
          // A variable can appear after the read-only replay preflight but
          // before createVar. Re-read only the known duplicate race: retain an
          // exact compatible winner, reject a mismatch, and never overwrite.
          if (opts.ifCompatible !== true || !isVariableAlreadyExistsError(error)) throw error;
          const raced = await readExistingVariableForReplay(opts.scope, opts.id, deps);
          if (raced === undefined) throw error;
          assertVariableReplayCompatible(raced, {
            scope: opts.scope,
            id: opts.id,
            type: opts.type,
            value,
            name: opts.name,
          });
          const payload = {
            ok: true,
            scope: opts.scope,
            id: opts.id,
            type: opts.type,
            value,
            created: false,
            existing: true,
            raced: true,
            snapshot: snapshotPath,
          } as Record<string, unknown>;
          const hints = buildNextSteps('variable.create', payload, opts);
          emit(nextHintOptedOut(opts) ? payload : withNextSteps(payload, hints), {
            pretty: opts.pretty === true,
          });
          printNextStepHintLine(hints, opts, {
            contextLabel: `variable ${opts.scope}/${opts.id} (concurrent compatible create)`,
          });
          return;
        }
        const payload = {
          ok: true,
          scope: opts.scope,
          id: opts.id,
          type: opts.type,
          value,
          ...(opts.ifCompatible === true && { created: true }),
          snapshot: snapshotPath,
        } as Record<string, unknown>;
        const hints = buildNextSteps('variable.create', payload, opts);
        emit(nextHintOptedOut(opts) ? payload : withNextSteps(payload, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `variable ${opts.scope}/${opts.id}`,
        });
        printNextStepHintLine(hints, opts, {
          contextLabel: `variable ${opts.scope}/${opts.id}`,
        });
      }),
    );

  interface DeleteOpts extends MutationOpts {
    scope: string;
    id?: string;
    all?: boolean;
  }

  addMutationFlags(
    cmd
      .command('delete')
      .description('Delete a variable, or a whole scope with --all')
      .requiredOption('--scope <name>', 'scope name (non-empty [A-Za-z0-9]+)')
      .option('--id <id>', 'variable id (omit with --all; non-empty [A-Za-z0-9]+)')
      .option('--all', 'delete every variable in the scope'),
  )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      '\nExamples:\n  $ xgg variable delete --scope my --id temp\n  $ xgg variable delete --scope my --all',
    )
    .action(
      wrap('variable.delete', async (opts: DeleteOpts) => {
        if (opts.all && opts.id) {
          throw new ConfigError('--id and --all are mutually exclusive');
        }
        if (!opts.all && !opts.id) {
          throw new ConfigError('variable delete requires either --id <id> or --all');
        }
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const deps = makeDeps(opts);
        warnIfGhostScope(opts.scope, opts.allowUnknownScope);
        const { snapshotPath } = await maybeSnapshot(guard, deps);
        if (opts.all) {
          await deleteVariable({ scope: opts.scope, all: true }, deps);
          const payload = {
            ok: true,
            scope: opts.scope,
            deleted: 'all',
            snapshot: snapshotPath,
          } as Record<string, unknown>;
          const hints = buildNextSteps('variable.delete', payload, opts);
          emit(nextHintOptedOut(opts) ? payload : withNextSteps(payload, hints), {
            pretty: opts.pretty === true,
          });
          printRefreshHint(opts, {
            baseUrl: deps.baseUrl,
            context: `variable ${opts.scope}/* (all deleted)`,
          });
          printNextStepHintLine(hints, opts, {
            contextLabel: `variable ${opts.scope}/* (all deleted)`,
          });
        } else if (opts.id) {
          await deleteVariable({ scope: opts.scope, id: opts.id }, deps);
          const payload = {
            ok: true,
            scope: opts.scope,
            id: opts.id,
            deleted: true,
            snapshot: snapshotPath,
          } as Record<string, unknown>;
          const hints = buildNextSteps('variable.delete', payload, opts);
          emit(nextHintOptedOut(opts) ? payload : withNextSteps(payload, hints), {
            pretty: opts.pretty === true,
          });
          printRefreshHint(opts, {
            baseUrl: deps.baseUrl,
            context: `variable ${opts.scope}/${opts.id} (deleted)`,
          });
          printNextStepHintLine(hints, opts, {
            contextLabel: `variable ${opts.scope}/${opts.id} (deleted)`,
          });
        }
      }),
    );

  interface SetValueOpts extends MutationOpts {
    scope: string;
    id: string;
    value: string;
    type?: 'number' | 'string';
    forceType?: boolean;
  }

  addMutationFlags(
    cmd
      .command('set-value')
      .description('Update a variable value')
      .requiredOption('--scope <name>', 'scope name (non-empty [A-Za-z0-9]+)')
      .requiredOption('--id <id>', 'variable id (non-empty [A-Za-z0-9]+)')
      .requiredOption(
        '--value <value>',
        'new value (number: numeric conversion; string: argv text verbatim, including quotes)',
      )
      // F66d (2026-05-31): --type semantics changed. Pre-F66d --type was a
      // parser hint defaulting to "string" — passing the wrong --type on a
      // number var pushed a string the gateway accepted but the UI silently
      // ignored (bundle Da.updateVar: `typeof o == typeof c.value` strict
      // equality, no-op on mismatch). Now --type is checked against the
      // stored type via getVariableConfig before the write; --type omitted
      // uses the stored type. Use --force-type to bypass for the rare
      // intentional re-type case.
      .option('--type <type>', 'value type (number|string); must match the stored variable type')
      .option(
        '--force-type',
        'bypass the F66d type-match guard (allow --type to differ from the stored type — safety hatch for intentional re-typing)',
      ),
  )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      `
Example:
  $ xgg variable set-value --scope my --id temp --value 42

Value parsing follows the stored (or explicit) type. Numbers use Number(...).
Strings use the argv text verbatim: --value Seed stores Seed, while
--value '"Seed"' stores the quote characters too; do not add JSON quotes
unless those quotes are intended data.

F66d (2026-05-31): xgg now fetches the stored variable's type via
getVarConfig before pushing the new value, so --type can be omitted and
--type=wrong is rejected before any side effect (bundle Da.updateVar:
silent no-op on typeof mismatch — see commit message). Use --force-type
to intentionally re-type a variable in place.`,
    )
    .action(
      wrap('variable.set-value', async (opts: SetValueOpts) => {
        const explicitlyTypedValue =
          opts.type !== undefined ? parseScalar(opts.type, opts.value) : undefined;
        // Resolve the Agent-mode contract before constructing session deps,
        // reading stored type, or emitting scope/type notes. A failed guard is
        // a single local CONFIG result with zero IPC traffic.
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const deps = makeDeps(opts);
        warnIfGhostScope(opts.scope, opts.allowUnknownScope);
        // F66d: fetch the stored type FIRST so we can reject a --type
        // mismatch or auto-coerce when --type is omitted. Any error
        // (NotFoundError, AuthExpiredError, …) bubbles unchanged — we do
        // NOT fall back to the legacy `--type string` default, because
        // that's exactly the silent-failure path we're closing.
        const stored = await getVariableConfig(opts.scope, opts.id, deps);
        const storedType = stored.type;
        let effectiveType: 'number' | 'string';
        if (opts.type !== undefined) {
          if (opts.type !== storedType && opts.forceType !== true) {
            throw new ConfigError(
              `--type "${opts.type}" does not match the stored variable type "${storedType}" for ${opts.scope}/${opts.id}. The Mi-Home UI's Da.updateVar (ai-config-v5.28b650.js) silently no-ops on typeof mismatch — your update would be accepted by the gateway but ignored by the UI. Either drop --type (xgg will use the stored type) or pass --force-type to deliberately re-type the variable.`,
            );
          }
          if (opts.type !== storedType && opts.forceType === true) {
            process.stderr.write(
              `[xgg variable] warning: --force-type override — pushing "${opts.type}" value into ${opts.scope}/${opts.id} (stored type was "${storedType}"). The UI will silently drop this update unless the stored type is also flipped to "${opts.type}" (F66d).\n`,
            );
          }
          effectiveType = opts.type;
        } else {
          effectiveType = storedType;
          // Pre-F66d --type defaulted to 'string'; warn whenever the auto-fetched
          // stored type differs so operators relying on the old default see the
          // coerce in their logs. Skip the warning when stored type IS string
          // (the no-change-of-behavior case) to keep happy-path output quiet.
          if (storedType !== 'string') {
            process.stderr.write(
              `[xgg variable] note: --type omitted, using stored type "${storedType}" for ${opts.scope}/${opts.id} (F66d auto-fetch). Pre-F66d this would have defaulted to "string" and silently no-op'd on the UI.\n`,
            );
          }
        }
        const value = explicitlyTypedValue ?? parseScalar(effectiveType, opts.value);
        const { snapshotPath } = await maybeSnapshot(guard, deps);
        await setVariableValue({ scope: opts.scope, id: opts.id, value }, deps);
        const payload = {
          ok: true,
          scope: opts.scope,
          id: opts.id,
          type: effectiveType,
          value,
          snapshot: snapshotPath,
        } as Record<string, unknown>;
        const hints = buildNextSteps('variable.set-value', payload, opts);
        emit(nextHintOptedOut(opts) ? payload : withNextSteps(payload, hints), {
          pretty: opts.pretty === true,
        });
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `variable ${opts.scope}/${opts.id} (value=${JSON.stringify(value)})`,
        });
        printNextStepHintLine(hints, opts, {
          contextLabel: `variable ${opts.scope}/${opts.id}`,
        });
      }),
    );

  interface SetConfigOpts extends MutationOpts {
    scope: string;
    id: string;
    name: string;
  }

  addMutationFlags(
    cmd
      .command('set-config')
      .description('Update a variable display name')
      .requiredOption('--scope <name>', 'scope name (non-empty [A-Za-z0-9]+)')
      .requiredOption('--id <id>', 'variable id (non-empty [A-Za-z0-9]+)')
      .requiredOption('--name <name>', 'new display name'),
  )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'pretty-print JSON output')
    .addHelpText(
      'after',
      '\nExample:\n  $ xgg variable set-config --scope my --id temp --name "New name"',
    )
    .action(
      wrap('variable.set-config', async (opts: SetConfigOpts) => {
        const guard = assertAgentModeOrSnapshotsDir(opts);
        const deps = makeDeps(opts);
        warnIfGhostScope(opts.scope, opts.allowUnknownScope);
        const { snapshotPath } = await maybeSnapshot(guard, deps);
        await setVariableConfig(
          {
            scope: opts.scope,
            id: opts.id,
            // F66-VarUserData-relax (2026-05-31): UI Da.setVarConfig only
            // sends `{name: a.trim()}` (ai-config-v5.28b650.js); gateway-side
            // qr.setVarConfig requires `userData !== undefined` and nothing
            // more. lastUpdateTime/version were xgg-synthesized ghost data.
            userData: { name: opts.name },
          },
          deps,
        );
        emit(
          { ok: true, scope: opts.scope, id: opts.id, name: opts.name, snapshot: snapshotPath },
          { pretty: opts.pretty === true },
        );
        printRefreshHint(opts, {
          baseUrl: deps.baseUrl,
          context: `variable ${opts.scope}/${opts.id} (name=${JSON.stringify(opts.name)})`,
        });
      }),
    );

  attachWatch(cmd);

  return cmd;
}

type ReplayVariableEntry = Awaited<ReturnType<typeof listVariables>>[string];

function isVariableAlreadyExistsError(error: unknown): error is GatewayError {
  return error instanceof GatewayError && /already exists|duplicate/i.test(error.message);
}

async function readExistingVariableForReplay(
  scope: string,
  id: string,
  deps: ReturnType<typeof makeDeps>,
): Promise<ReplayVariableEntry | undefined> {
  try {
    const variables = await listVariables(scope, deps);
    return Object.hasOwn(variables, id) ? variables[id] : undefined;
  } catch (error) {
    if (isMissingScopeError(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertVariableReplayCompatible(
  existing: ReplayVariableEntry,
  expected: {
    scope: string;
    id: string;
    type: 'number' | 'string';
    value: number | string;
    name: string;
  },
): void {
  const actual = {
    type: existing.type,
    value: existing.value,
    name: existing.userData.name,
  };
  if (
    actual.type === expected.type &&
    Object.is(actual.value, expected.value) &&
    actual.name === expected.name
  ) {
    return;
  }
  throw new ConfigError(
    `variable ${expected.scope}.${expected.id} already exists with different type, value, or display name; replay will not overwrite it`,
    {
      scope: expected.scope,
      id: expected.id,
      expected: { type: expected.type, value: expected.value, name: expected.name },
      actual,
    },
  );
}

// ── watch (snapshot + optional --follow polling) ───────────────────────────
//
// M15 (2026-05-29): the Mi-Home Geek-Edition "real-time variable dashboard"
// Tampermonkey script piggybacks on the page's WS via `editor.gateway.callAPI`
// and polls `getVarScopeList` + `getVarList` every 800ms. Both methods are
// already wrapped in @eyaeya/xgg-core — `variable watch` makes that same pattern
// ergonomic for AI agents that need a current-state snapshot (for picking
// thresholds) or a streaming diff (for observing an automation).
//
// IMPORTANT: the gateway has no read-device-property RPC (docs/api/devices.md
// "Property / action endpoints — DEFERRED"). To observe a device's live
// properties via this command, first route them into a variable using a rule
// with deviceInput / deviceGet → varSet, then watch the variable.

interface WatchOpts extends VariableOpts {
  scope?: string;
  follow?: boolean;
  intervalMs?: string;
  maxEvents?: string;
  allowUnknownScope?: boolean;
  nextHint?: boolean;
}

const DEFAULT_WATCH_INTERVAL_MS = 800;

function attachWatch(cmd: Command): void {
  const watchSub = cmd
    .command('watch')
    .description(
      'Snapshot every variable value once, or stream changes with --follow (NDJSON). For AI agents picking automation thresholds.',
    )
    .option('--scope <name>', 'restrict to a single scope (default: all scopes)')
    .option('--follow', 'poll continuously and stream change events as NDJSON')
    .option(
      '--interval-ms <N>',
      `polling interval for --follow in ms (default ${DEFAULT_WATCH_INTERVAL_MS})`,
    )
    .option(
      '--max-events <N>',
      'in --follow, exit cleanly once N events have been emitted (any op: change/add/remove/errors; default: until SIGINT)',
    )
    .option('--base-url <url>', 'gateway base URL (or XGG_BASE_URL)')
    .option('--session-file <path>', 'session file path')
    .option('--timeout <ms>', 'request timeout in milliseconds', '10000')
    .option('--pretty', 'snapshot mode only: render as a table instead of compact JSON')
    .option(
      '--allow-unknown-scope',
      'treat a non-existent --scope as an empty snapshot instead of erroring out',
    );
  // Task 14 — snapshot-mode emits a "switch to --follow" hint; --follow path
  // early-skips (rule predicate also blocks). Flag must be present so both
  // paths accept the opt-out.
  addNextHintFlag(watchSub);
  watchSub
    .addHelpText(
      'after',
      `
Examples:
  $ xgg variable watch                          # one-shot snapshot, JSON
  $ xgg variable watch --pretty                 # one-shot snapshot, table
  $ xgg variable watch --scope global           # filter
  $ xgg variable watch --follow                 # stream NDJSON until Ctrl-C
  $ xgg variable watch --follow --max-events 5  # stream then exit
  $ xgg variable watch --follow --interval-ms 1500

Note: the gateway has no read-device-property RPC. To observe a device's
live properties, route them into a variable via a rule (deviceInput or
deviceGet → varSet) and watch the variable.`,
    )
    .action(
      wrap('variable.watch', async (opts: WatchOpts) => {
        if (
          opts.follow !== true &&
          (opts.intervalMs !== undefined || opts.maxEvents !== undefined)
        ) {
          throw new ConfigError('--interval-ms / --max-events require --follow');
        }
        const intervalMs =
          opts.intervalMs !== undefined
            ? parsePositiveTimerMs(opts.intervalMs, '--interval-ms')
            : DEFAULT_WATCH_INTERVAL_MS;
        const maxEvents =
          opts.maxEvents !== undefined
            ? parseNonnegativeIntOrThrow(opts.maxEvents, '--max-events')
            : null;

        const deps = makeDeps(opts);
        const snapOpts = opts.scope !== undefined ? { scope: opts.scope } : {};

        // R7: take the initial snapshot once; --allow-unknown-scope swallows
        // NotFoundError into an empty snapshot for BOTH snapshot and --follow
        // modes. snapshotAllVariables already does the listScopes() existence
        // check internally, so no separate precheck is needed.
        let initial: SnapshotAllVariablesResult;
        try {
          initial = await snapshotAllVariables(deps, snapOpts);
        } catch (e) {
          if (e instanceof NotFoundError && opts.allowUnknownScope === true) {
            initial = {
              ts: Date.now(),
              iso: new Date().toISOString(),
              scopes: [],
              snapshot: {},
              errors: {},
            };
          } else {
            throw e;
          }
        }

        if (opts.follow !== true) {
          // Task 14 / spec §5.4 rule 24 — snapshot mode emits a "switch to
          // --follow" hint via JSON nextSteps + stderr note: line. The
          // --follow path skips both (handled below via early return).
          const hints = buildNextSteps('variable.watch', initial, opts);
          renderSnapshot(initial, opts, hints);
          printNextStepHintLine(hints, opts, {
            contextLabel: opts.scope !== undefined ? `variable ${opts.scope}` : 'variable watch',
          });
          return;
        }

        await runFollowLoop(deps, snapOpts, intervalMs, maxEvents, initial);
      }),
    );
}

function renderSnapshot(
  result: {
    ts: number;
    iso: string;
    scopes: string[];
    snapshot: VariableSnapshot;
    errors: Record<string, string>;
  },
  opts: WatchOpts,
  hints: NextStepHint[] = [],
): void {
  if (opts.pretty === true) {
    const table = new Table({
      head: ['scope', 'id', 'type', 'value', 'name'],
      style: { head: [], border: [] },
      wordWrap: true,
    });
    for (const scope of result.scopes) {
      const entries = result.snapshot[scope] ?? {};
      for (const id of Object.keys(entries).sort()) {
        const e = entries[id];
        if (e === undefined) continue;
        table.push([
          scope,
          id,
          e.type === undefined ? '' : typeof e.type === 'string' ? e.type : JSON.stringify(e.type),
          e.value === undefined ? '' : renderValue(e.value),
          renderName(e.userData) ?? '',
        ]);
      }
    }
    process.stdout.write(`${table.toString()}\n`);
    for (const [scope, msg] of Object.entries(result.errors)) {
      process.stderr.write(`[xgg variable] warning: scope "${scope}": ${msg}\n`);
    }
    return;
  }
  const variables = flattenForJson(result.snapshot);
  const payload = {
    op: 'snapshot',
    ts: result.ts,
    iso: result.iso,
    scopes: result.scopes,
    variables,
    errors: result.errors,
  } as Record<string, unknown>;
  emit(nextHintOptedOut(opts) ? payload : withNextSteps(payload, hints), { pretty: false });
}

function flattenForJson(
  snapshot: VariableSnapshot,
): Record<string, Record<string, { type: unknown | null; value: unknown | null; name?: string }>> {
  const out: Record<
    string,
    Record<string, { type: unknown | null; value: unknown | null; name?: string }>
  > = {};
  for (const [scope, entries] of Object.entries(snapshot)) {
    out[scope] = {};
    for (const [id, e] of Object.entries(entries)) {
      const name = renderName(e.userData);
      // R10: emit explicit null for present-but-undefined fields so the
      // wire shape stays `parsed.variables.scope.id.value` (defined, even
      // if null) rather than dropping the key — JSON.stringify silently
      // omits keys whose value is `undefined`.
      const type = e.type === undefined ? null : e.type;
      const value = e.value === undefined ? null : e.value;
      out[scope][id] = name !== undefined ? { type, value, name } : { type, value };
    }
  }
  return out;
}

function renderValue(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function renderName(userData: Record<string, unknown> | undefined): string | undefined {
  const n = userData?.name;
  return typeof n === 'string' ? n : undefined;
}

function parseNonnegativeIntOrThrow(raw: string, flag: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError(`${flag} must be a nonnegative integer (got '${raw}')`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new ConfigError(`${flag} must be a nonnegative integer (got '${raw}')`);
  }
  return n;
}

async function runFollowLoop(
  deps: ReturnType<typeof makeDeps>,
  snapOpts: { scope?: string },
  intervalMs: number,
  maxEvents: number | null,
  initial: SnapshotAllVariablesResult,
): Promise<void> {
  emit(
    {
      op: 'snapshot',
      ts: initial.ts,
      iso: initial.iso,
      scopes: initial.scopes,
      variables: flattenForJson(initial.snapshot),
      errors: initial.errors,
    },
    { pretty: false },
  );

  if (maxEvents === 0) return;
  // R7/R13: when the user explicitly named a `--scope` and it came back
  // empty (the --allow-unknown-scope path), there is nothing to observe —
  // exit cleanly after the empty snapshot line rather than spinning the
  // polling loop forever. Without `--scope`, an empty initial.scopes is a
  // transient state (brand-new gateway with no rules/variables yet); keep
  // polling so scopes that appear later are observed.
  if (snapOpts.scope !== undefined && initial.scopes.length === 0) return;

  let prev = initial.snapshot;
  let prevErrors = initial.errors;
  let emitted = 0;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  while (true) {
    await sleep(intervalMs);
    const next = await snapshotAllVariables(deps, snapOpts);

    for (const scope of Object.keys(next.errors)) {
      const carry = prev[scope];
      if (carry !== undefined) next.snapshot[scope] = carry;
    }

    const errorsChanged = JSON.stringify(next.errors) !== JSON.stringify(prevErrors);
    if (errorsChanged) {
      emit(
        {
          op: 'errors',
          ts: next.ts,
          iso: next.iso,
          errors: next.errors,
        },
        { pretty: false },
      );
      prevErrors = next.errors;
      emitted += 1;
      if (maxEvents !== null && emitted >= maxEvents) return;
    }

    const events = diffVariableSnapshots(prev, next.snapshot, {
      ts: next.ts,
      ...(snapOpts.scope !== undefined && { scope: snapOpts.scope }),
    });
    prev = next.snapshot;
    for (const ev of events) {
      emit(ev, { pretty: false });
      emitted += 1;
      if (maxEvents !== null && emitted >= maxEvents) return;
    }
  }
}
