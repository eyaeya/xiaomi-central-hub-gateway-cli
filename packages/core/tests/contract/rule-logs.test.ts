import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RuleLogBlockResponse } from '../../src/schemas/rule-logs.js';
import { parseLogLine } from '../../src/usecases/rule-logs.js';

const fixtures = new URL('../../../../fixtures/responses/rule-logs/', import.meta.url);
const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), 'utf8'));

describe('rule log response contracts', () => {
  it('registers every fixture, including the negative response shape', () => {
    expect(
      readdirSync(fixtures)
        .filter((name) => name.endsWith('.json'))
        .sort(),
    ).toEqual(['block.json', 'empty.json', 'invalid-response.json']);
  });
  it('accepts only an empty string as the empty result', () => {
    expect(RuleLogBlockResponse.parse(read('empty'))).toBe('');
  });
  it('preserves the raw text and parses observed row types', () => {
    const block = RuleLogBlockResponse.parse(read('block'));
    const entries = block.split('\n').map(parseLogLine);
    expect(entries.map((entry) => entry?.rawType)).toEqual(['r', 'i', 'e']);
    expect(entries[2]).toMatchObject({ level: 'error', errorCode: -9999 });
  });
  it('rejects structured payload drift instead of silently losing evidence', () => {
    expect(RuleLogBlockResponse.safeParse(read('invalid-response')).success).toBe(false);
  });
});
