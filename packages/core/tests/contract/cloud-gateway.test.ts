import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CloudGatewayPasscode, CloudGatewayUrl } from '../../src/schemas/cloud-gateway.js';

describe('cloud gateway real-shape sanitized contracts', () => {
  it.each([
    ['url.json', CloudGatewayUrl],
    ['passcode.json', CloudGatewayPasscode],
  ] as const)('parses %s', (file, schema) => {
    const data = JSON.parse(
      readFileSync(
        new URL(`../../../../fixtures/responses/cloud-gateway/${file}`, import.meta.url),
        'utf8',
      ),
    );
    expect(schema.safeParse(data).success).toBe(true);
  });
});
