import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  CloudActionResult,
  CloudConsumablesResult,
  CloudDevicesResult,
  CloudHomesResult,
  CloudPropertiesResult,
  CloudRunSceneResult,
  CloudScenesResult,
  CloudSharedDevicesResult,
  CloudSpecResult,
  CloudStatisticsResult,
} from '../../src/schemas/cloud.js';

const fixtures = new URL('../../../../fixtures/responses/cloud/', import.meta.url);
const contracts: Record<string, ZodTypeAny> = {
  homes: CloudHomesResult,
  devices: CloudDevicesResult,
  'shared-devices': CloudSharedDevicesResult,
  spec: CloudSpecResult,
  'property-get': CloudPropertiesResult,
  'property-batch': CloudPropertiesResult,
  'property-set': CloudPropertiesResult,
  'property-error': CloudPropertiesResult,
  action: CloudActionResult,
  scenes: CloudScenesResult,
  'scene-run': CloudRunSceneResult,
  consumables: CloudConsumablesResult,
  statistics: CloudStatisticsResult,
};
describe('Cloud resource contracts (synthetic, live evidence is separate)', () => {
  it('covers every cloud response fixture', () => {
    const files = readdirSync(fixtures)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(files).toEqual(
      Object.keys(contracts)
        .map((name) => `${name}-synthetic.json`)
        .sort(),
    );
  });
  it.each(Object.entries(contracts))('parses %s and strips private fields', (name, schema) => {
    const raw = readFileSync(new URL(`${name}-synthetic.json`, fixtures), 'utf8');
    const data = JSON.parse(raw);
    expect(`${JSON.stringify(data, null, 2)}\n`).toBe(raw);
    const parsed = schema.parse(data);
    const encoded = JSON.stringify(parsed);
    expect(encoded).not.toContain('SYNTHETIC_SECRET');
    expect(encoded).not.toContain('SYNTHETIC_NETWORK');
    expect(encoded).not.toContain('SYNTHETIC_PRIVATE');
  });
  it('retains room membership, observed device update time, and public spec comments', () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(new URL(`${name}-synthetic.json`, fixtures), 'utf8'));
    expect(CloudHomesResult.parse(read('homes')).homelist[0]?.roomlist?.[0]?.dids).toEqual([
      'device-demo',
    ]);
    expect(CloudPropertiesResult.parse(read('property-get'))[0]?.updateTime).toBe(100);
    expect(CloudSpecResult.parse(read('spec')).services[0]?.properties[0]?.comment).toBe(
      '示例开关',
    );
    expect(CloudSpecResult.parse(read('spec')).services[0]?.actions[0]?.comment).toBe('示例切换');
  });
});
