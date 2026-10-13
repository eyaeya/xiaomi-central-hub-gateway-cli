import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  CloudConsumablesResult,
  CloudDevicesResult,
  CloudHomesResult,
  CloudPropertiesResult,
  CloudScenesResult,
  CloudSpecResult,
} from '../../src/schemas/cloud.js';

const fixtures = new URL('../../../../fixtures/responses/cloud-live/', import.meta.url);
const contracts: Record<string, ZodTypeAny> = {
  'homes-redacted-live': CloudHomesResult,
  'devices-redacted-live': CloudDevicesResult,
  'property-get-redacted-live': CloudPropertiesResult,
  'property-auto-redacted-live': CloudPropertiesResult,
  'property-device-redacted-live': CloudPropertiesResult,
  'scenes-redacted-live': CloudScenesResult,
  'consumables-redacted-live': CloudConsumablesResult,
  'spec-public-live': CloudSpecResult,
};

describe('Cloud response contracts from live read captures', () => {
  it('covers every live fixture and keeps provenance separate from synthetic samples', () => {
    expect(
      readdirSync(fixtures)
        .filter((name) => name.endsWith('.json'))
        .sort(),
    ).toEqual(
      Object.keys(contracts)
        .map((name) => `${name}.json`)
        .sort(),
    );
    expect(readFileSync(new URL('README.md', fixtures), 'utf8')).toContain('2026-10-13');
  });
  it.each(Object.entries(contracts))('validates %s', (name, schema) => {
    const raw = readFileSync(new URL(`${name}.json`, fixtures), 'utf8');
    const parsed = JSON.parse(raw);
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(raw);
    expect(schema.safeParse(parsed).success).toBe(true);
    // Response examples must never grow private raw-list fields accidentally.
    expect(raw).not.toMatch(
      /"(?:token|ssid|bssid|mac|latitude|longitude|address|serviceToken|passToken|ssecurity)"\s*:/i,
    );
  });
  it('retains a real successful property response without CLI-only status fields', () => {
    const data = JSON.parse(
      readFileSync(new URL('property-get-redacted-live.json', fixtures), 'utf8'),
    );
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ did: 'device-demo', code: 0 });
    expect(data[0]).toHaveProperty('value');
    expect(data[0]).not.toHaveProperty('status');
    expect(data[0]).not.toHaveProperty('confirmed');
  });
  it('preserves the differing cached and device observations without claiming code zero means fresh', () => {
    const read = (name: string) =>
      CloudPropertiesResult.parse(
        JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), 'utf8')),
      )[0];
    const cached = read('property-auto-redacted-live');
    const device = read('property-device-redacted-live');
    expect(cached).toMatchObject({ code: 0, value: true, updateTime: 100 });
    expect(device).toMatchObject({ code: 0, value: false, updateTime: 200 });
    expect(cached?.did).toBe(device?.did);
    expect(cached?.siid).toBe(device?.siid);
    expect(cached?.piid).toBe(device?.piid);
  });
});
