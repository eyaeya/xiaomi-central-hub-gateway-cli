import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function help(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--help'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\s+/g, ' ');
}

test('strict lint and enable help describe the complete validation gates', () => {
  const lint = help(['rule', 'lint']);
  assert.match(lint, /promote missing required inputs/);
  assert.match(lint, /directed sink reachability/);

  const enable = help(['rule', 'enable']);
  assert.match(enable, /strict topology and required inputs/);
  assert.match(enable, /directed sink reachability/);
  assert.match(enable, /ConfigError \(exit 5\)/);
  assert.match(enable, /does not bypass request\/envelope parsing/);
  assert.doesNotMatch(enable, /exit code 2/);
});

test('export and import help cover all five modeled device families', () => {
  const exportHelp = help(['rule', 'export']);
  const importHelp = help(['rule', 'import']);
  for (const text of [exportHelp, importHelp]) {
    assert.match(text, /All five modeled device-backed node families/);
    assert.match(text, /deviceGetSetVar/);
  }
  assert.match(importHelp, /first target-graph write is the exported empty shell/);
  assert.match(importHelp, /cfg overwrite and enable=false/);
  assert.match(importHelp, /rebuilds nodes\/edges while disabled/);
  assert.match(importHelp, /final rule enable only when the export was enabled/);
  assert.match(importHelp, /a disabled export stays disabled/);
  assert.match(importHelp, /each command is a separate transaction/);
  assert.match(importHelp, /web\/xgg\/API writer/);
  assert.match(importHelp, /post-staging failure leaves the expected disabled partial graph/);
  assert.match(
    importHelp,
    /--target-name is applied to both a clone and an existing same-ID target/,
  );
  assert.match(exportHelp, /Every replay first preflights the complete variable plan read-only/);
  assert.match(
    exportHelp,
    /Same-id then prepares captured variables with compatibility guards before its first target-graph write/,
  );
  assert.match(
    exportHelp,
    /A --target-id clone instead writes the disabled empty target with create-only\/expect-absent semantics before any variable write/,
  );
  assert.match(
    importHelp,
    /When captured local variables exist, same-id prepares them with compatibility guards before that graph write/,
  );
  assert.match(
    importHelp,
    /a clone keeps its expect-absent guard and prepares remapped local variables only after the disabled empty target exists/,
  );
  assert.match(
    importHelp,
    /Pre-canonical-ID JSON exports are upgraded only for modeled typed replay/,
  );
  assert.match(importHelp, /ambiguous colon-bearing edge ids use split node-id\/pin flags/);
  assert.match(importHelp, /Raw and unknown commands are never mislabeled/);
  assert.doesNotMatch(
    exportHelp,
    /Replay preflights the complete variable plan, then creates the empty target/,
  );
  assert.match(exportHelp, /override the replayed\/cloned rule's userData.name/);
});

test('node-add help directs every modeled type to shortcuts and bounds raw fallback', () => {
  const nodeAdd = help(['rule', 'node', 'add']);
  assert.match(nodeAdd, /All 25 modeled executable types plus nop have shortcuts/);
  assert.match(nodeAdd, /unmodeled future card/);
  assert.match(nodeAdd, /--cfg selects raw\/full-tuple handling for every type/);
  assert.match(nodeAdd, /cannot be combined with shortcut authoring flags/);
  assert.match(nodeAdd, /strict schema unless --no-validate/);
  assert.doesNotMatch(nodeAdd, /\$ xgg rule node add --rule-id \S+ --type eventSequence[^$]*--cfg/);
  assert.match(nodeAdd, /deviceInput\/deviceInputSetVar trigger or capture source/);
  assert.match(nodeAdd, /deviceGet\/deviceGetSetVar read source/);
  assert.match(nodeAdd, /event-driven deviceInput\/deviceInputSetVar/);
  assert.match(nodeAdd, /deviceInput\/deviceGet\/varChange\/varGet/);
  assert.match(nodeAdd, /varChange\/varGet\/varSetNumber\/varSetString\/device\*SetVar/);
  assert.match(nodeAdd, /varChange\/varGet variable type/);
  assert.match(nodeAdd, /ASCII alphanumeric \[A-Za-z0-9\]\+/);
  assert.match(nodeAdd, /auto-generated editor-compatible id/);
  assert.match(nodeAdd, /Raw --cfg replay preserves legacy\/opaque ids verbatim/);
  assert.match(nodeAdd, /--allow-legacy-id/);
  assert.match(nodeAdd, /export-replay compatibility only/);
});

test('edge help exposes lossless split endpoints for legacy ids', () => {
  for (const command of ['add', 'remove']) {
    const edge = help(['rule', 'edge', command]);
    assert.match(edge, /--from <NID:pin>/);
    assert.match(edge, /--to <NID:pin>/);
    assert.match(edge, /--from-node-id <id>/);
    assert.match(edge, /--from-pin <pin>/);
    assert.match(edge, /--to-node-id <id>/);
    assert.match(edge, /--to-pin <pin>/);
    assert.match(edge, /legacy:id/);
  }
});

test('device replacement help makes ghost targets diagnostic-only and rechecks eligibility', () => {
  const discovery = help(['rule', 'device', 'replacements']);
  assert.match(discovery, /Default discovery excludes ghost devices/);
  assert.match(discovery, /eligible=false with no planId/);
  assert.match(discovery, /diagnostic-only/);
  assert.match(discovery, /--node-id lightOn/);
  assert.doesNotMatch(discovery, /--node-id light-on/);

  const replace = help(['rule', 'device', 'replace']);
  assert.match(replace, /fresh device inventory rejects a target that is or became a ghost/);
  assert.match(replace, /before setGraph/);
  assert.match(replace, /--node-id lightOn/);
  assert.doesNotMatch(replace, /--node-id light-on/);
});

test('rule trace help separates source block scanning from frame truncation', () => {
  const trace = help(['rule', 'trace']);

  assert.match(trace, /--max-blocks <N> source getLog blocks to scan \(default 8\)/);
  assert.match(trace, /--max-steps <N> after fetching, keep at most the newest N selected frames/);
  assert.match(trace, /--max-steps only truncates frames after that scan and cannot widen it/);
  assert.match(trace, /completeness\.fetch\.boundedByMaxBlocks=true/);
  assert.match(trace, /completeness\.fetch\.stopReason=max-blocks/);
  assert.match(trace, /raise --max-blocks <N> to scan more retained log blocks/);
  assert.match(trace, /Gateway retention remains the outer limit/);
  assert.match(trace, /a larger scan still cannot prove complete execution/);
  assert.match(trace, /--max-blocks 32 --max-steps 100 --pretty/);
});
