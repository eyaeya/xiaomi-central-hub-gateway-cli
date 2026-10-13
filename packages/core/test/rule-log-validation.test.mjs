// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { SchemaError, fetchRuleLogs, parseLogLine, parseTimestamp } from '../dist/index.js';

function fakeLogSource(pages) {
  const baseUrl = 'http://log-validation.test';
  const agentStartedAt = '2026-10-13T00:00:00.000Z';
  return {
    baseUrl,
    maxBlocks: 4,
    store: {
      read: async () => ({
        host: baseUrl,
        pid: 1,
        socketPath: '/unused/logs.sock',
        agentStartedAt,
      }),
    },
    ipcClient: () => ({
      request: async (method, params) => {
        if (method === '$ping') return { host: baseUrl, agentStartedAt };
        assert.equal(method, '/api/getLog');
        return pages[params.num];
      },
      close() {},
    }),
  };
}

for (const response of [null, undefined, {}, [], 42, false]) {
  test(`non-string log response ${JSON.stringify(response)} is schema drift`, async () => {
    await assert.rejects(fetchRuleLogs(fakeLogSource([response])), SchemaError);
  });
}

test('a malformed later log page does not return partial evidence as success', async () => {
  await assert.rejects(
    fetchRuleLogs(fakeLogSource(['3|10|i|rule-demo|node-demo|success', {}])),
    SchemaError,
  );
});

test('invalid log timestamps remain unparsed and preserve newer raw-window metadata', async () => {
  const invalid = '3|9007199254740991|i|rule-demo|node-demo|invalid';
  const valid = '3|10|i|rule-demo|node-demo|success';
  const result = await fetchRuleLogs(fakeLogSource([`${valid}\n${invalid}`, '']));
  assert.deepEqual(result.rawLines, [valid, invalid]);
  assert.deepEqual(result.unparsed, [invalid]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.stopReason, 'empty-block');
  assert.equal(result.maxBlocks, 4);
});

for (const timestamp of ['', ' ', '1e20', '9007199254740991', '1.5', '-1', 'Infinity']) {
  test(`invalid row timestamp ${JSON.stringify(timestamp)} does not throw`, () => {
    assert.equal(parseLogLine(`3|${timestamp}|i|rule-demo|node-demo|success`), null);
  });
}

for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER]) {
  test(`invalid filter timestamp ${timestamp} is rejected`, () => {
    assert.throws(() => parseTimestamp(timestamp), /unparseable timestamp/);
  });
}
