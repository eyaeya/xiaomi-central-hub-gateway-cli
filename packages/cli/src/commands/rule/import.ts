import {
  ConfigError,
  type ExportedRule,
  applyRename,
  renderExportedAsShell,
} from '@eyaeya/xgg-core';
import type { Command } from 'commander';
import { wrap } from '../../action-wrap.js';
import { addNextHintFlag } from '../../agent-hints.js';
import { readJsonInput } from '../../local-input.js';

// `xgg rule import` is a pure text transformer (read JSON → optionally
// rename → render shell). It does NOT need a gateway connection to render
// the script; only the replay (`| bash`) does. So we deliberately skip the
// `_deps.makeDeps` helper here (which would error out on missing --base-url)
// and accept --base-url purely as a substitution into the emitted script.
interface ImportOpts {
  fromFile: string;
  targetId?: string;
  targetName?: string;
  baseUrl?: string;
  nextHint?: boolean;
}

export function attachImport(cmd: Command): void {
  const sub = cmd
    .command('import')
    .description(
      'Re-emit the bash script for a previously-saved `xgg rule export --format json` payload, optionally renaming the rule id/name on the way out.',
    )
    .requiredOption(
      '--from-file <path>',
      'path to a JSON file produced by `xgg rule export --format json`',
    )
    .option('--target-id <ID>', 'recreate the rule under a new id (default: source id from file)')
    .option(
      '--target-name <NAME>',
      "override the imported rule's userData.name (default: '[Cloned] <orig>' when --target-id is set)",
    )
    .option(
      '--base-url <url>',
      'gateway base URL (only used to substitute BASE_URL in the emitted script)',
    );
  addNextHintFlag(sub)
    .addHelpText(
      'after',
      `
Examples:
  $ xgg rule import --from-file rule.json
      # Re-render the script identical to what \`xgg rule export\` would emit.

  $ xgg rule import --from-file rule.json --target-id 9999999999999 | bash
      # Clone the saved rule into a new rule id; name becomes "[Cloned] <orig>".

  $ xgg rule import --from-file rule.json \\
        --target-id 9999999999999 --target-name "按钮播报-备份" | bash
      # Clone with an explicit new name.

Notes:
  - The JSON file must be the output of \`xgg rule export <id> --format json\`.
  - Re-emit is purely a text transformation; no gateway access is needed
    to *render* the script. The replay (\`| bash\`) still talks to the
    gateway and requires \`xgg login\`.
  - Import deliberately emits no live next-step hint: rendering stdout does
    not prove that the script was executed. After a successful replay, run
    \`xgg rule validate --rule-id <id>\`, then strict lint before enabling.
  - Cloning rewrites only R<source-id> to R<target-id>. Captured local
    variables are fully preflighted before any write. The empty target is then
    created with expect-absent semantics before local variables are prepared,
    so an existing rule id (including one which appears during preflight) is
    never overwritten. Concurrent variable changes can still stop replay
    because the gateway has no cross-variable transaction. global variables
    remain declared external dependencies and must exist.
  - --target-id must differ from the exported rule id. Omit it for same-id
    replay or use only --target-name for an in-place rename.
  - Exports containing opaque raw fallbacks for unknown future node types can
    be replayed with the same id, but cannot be cloned with --target-id: xgg
    cannot safely discover and rewrite rule-local references inside an
    unmodeled payload.
  - Device-output / device-input nodes referenced in the export must still
    exist on the target gateway with the same DIDs; otherwise the replay
    fails at the corresponding \`rule node add\` step.`,
    )
    .action(
      wrap('rule.import', async (opts: ImportOpts) => {
        const parsed = await readJsonInput(opts.fromFile, '--from-file');
        const exported = parseExportedRule(parsed, opts.fromFile);

        const rename: { targetId?: string; targetName?: string } = {};
        if (opts.targetId !== undefined) rename.targetId = opts.targetId;
        if (opts.targetName !== undefined) rename.targetName = opts.targetName;
        const renamed =
          rename.targetId !== undefined || rename.targetName !== undefined
            ? applyRename(exported, rename)
            : exported;

        const baseUrl = opts.baseUrl ?? process.env.XGG_BASE_URL;
        const script = renderExportedAsShell(renamed, {
          ...(baseUrl && { baseUrl }),
        });
        for (const w of renamed.warnings) {
          process.stderr.write(`# WARNING (xgg rule import): ${w}\n`);
        }
        process.stdout.write(script);
        // Pure text transformer — stdout is the bash script. Do not emit a
        // live validation hint: this process cannot know whether stdout was
        // executed, saved for review, or discarded.
      }),
    );
}

// Guard against arbitrary JSON being fed to applyRename. We do a structural
// check rather than zod (the JSON-RPC `--format json` envelope adds `ok: true`
// to the payload; we tolerate that).
function parseExportedRule(parsed: unknown, sourcePath: string): ExportedRule {
  if (parsed === null || typeof parsed !== 'object') {
    throw new ConfigError(`--from-file ${sourcePath} root must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  // Strip CLI's `ok: true` envelope if present (emit() adds it).
  const body = (typeof obj.ruleId === 'string' ? obj : obj) as Record<string, unknown>;
  if (
    typeof body.ruleId !== 'string' ||
    typeof body.ruleName !== 'string' ||
    typeof body.enable !== 'boolean' ||
    !Array.isArray(body.commands) ||
    !Array.isArray(body.warnings)
  ) {
    throw new ConfigError(
      `--from-file ${sourcePath} is not a valid \`xgg rule export\` payload (missing ruleId / ruleName / enable / commands / warnings)`,
    );
  }
  return {
    ...(body as unknown as ExportedRule),
    // Pre-variable-aware exports did not carry this field. Same-id re-render
    // stays backward compatible; applyRename() separately refuses an unsafe
    // clone if its command stream references undeclared variables.
    externalVariables: Array.isArray(body.externalVariables)
      ? (body.externalVariables as ExportedRule['externalVariables'])
      : [],
  };
}
