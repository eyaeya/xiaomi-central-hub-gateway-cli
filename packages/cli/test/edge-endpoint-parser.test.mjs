import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError } from '@eyaeya/xgg-core';
import { parseEdgeEndpoints } from '../dist/commands/rule/_helpers.js';

test('compact edge endpoints retain the canonical NID:pin syntax', () => {
  assert.deepEqual(parseEdgeEndpoints({ from: 'source:output', to: 'sink:input' }), {
    from: { nodeId: 'source', pin: 'output' },
    to: { nodeId: 'sink', pin: 'input' },
  });
});

test('split edge endpoints preserve legacy ids containing colons', () => {
  assert.deepEqual(
    parseEdgeEndpoints({
      fromNodeId: 'legacy:source',
      fromPin: 'output',
      toNodeId: 'legacy:sink',
      toPin: 'input',
    }),
    {
      from: { nodeId: 'legacy:source', pin: 'output' },
      to: { nodeId: 'legacy:sink', pin: 'input' },
    },
  );
});

test('edge endpoint forms fail closed when mixed, partial, or absent', () => {
  for (const input of [
    { from: 'source:output', toNodeId: 'sink' },
    { fromNodeId: 'source', fromPin: 'output', toNodeId: 'sink' },
    {},
  ]) {
    assert.throws(
      () => parseEdgeEndpoints(input),
      (error) => error instanceof ConfigError && /endpoint|provided|non-empty/.test(error.message),
    );
  }
});
