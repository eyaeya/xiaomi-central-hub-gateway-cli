import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UpdatePackageMetadata } from '../../src/schemas/update.js';

const official = JSON.parse(
  readFileSync(
    new URL('../../../../fixtures/responses/update/npm-latest.json', import.meta.url),
    'utf8',
  ),
);

describe('update registry manifest contracts', () => {
  it.each(['npm-latest.json', 'npmmirror-latest.json'])('parses observed %s', (file) => {
    const data = JSON.parse(
      readFileSync(
        new URL(`../../../../fixtures/responses/update/${file}`, import.meta.url),
        'utf8',
      ),
    );
    expect(UpdatePackageMetadata.safeParse(data).success).toBe(true);
  });

  it.each([
    { name: '@someone/other-cli' },
    { version: '3.1.0-beta.1' },
    { dependencies: { '@eyaeya/xgg-core': '*' } },
    { dependencies: { '@eyaeya/xgg-core': '^2.0.0' } },
    { dist: { ...official.dist, integrity: 'sha1-untrusted' } },
    { dist: { ...official.dist, tarball: 'http://packages.example.org/cli.tgz' } },
    { dist: { ...official.dist, tarball: 'https://user:private@packages.example.org/cli.tgz' } },
    { dist: { ...official.dist, tarball: 'not-a-url' } },
  ])('rejects unsafe or incompatible release fields: %j', (override) => {
    expect(UpdatePackageMetadata.safeParse({ ...official, ...override }).success).toBe(false);
  });
});
