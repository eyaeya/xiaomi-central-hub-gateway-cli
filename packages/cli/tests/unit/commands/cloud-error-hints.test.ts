import { SchemaError } from '@eyaeya/xgg-core';
import { describe, expect, it } from 'vitest';
import { formatErrorJson, lookupHint } from '../../../src/errors.js';

describe('cloud-first authentication recovery hints', () => {
  it('prioritizes cloud gateway bootstrap over manual codes for gateway auth failures', () => {
    for (const code of ['AUTH_REQUIRED', 'AUTH_EXPIRED']) {
      const hint = lookupHint(code, 'rule.list');
      expect(hint).toContain('xgg cloud login');
      expect(hint).toContain('xgg cloud gateway login --did <GATEWAY_DID>');
      expect(hint.indexOf('xgg cloud gateway login')).toBeLessThan(
        hint.indexOf('xgg login --code'),
      );
    }
  });

  it('offers explicit credential recovery without requesting a gateway code', () => {
    const error = new SchemaError('Cloud credential file has an invalid structure', {
      domain: 'cloud',
      reason: 'invalid-credentials',
    });
    const result = formatErrorJson(error);
    expect(result.error.hint).toContain('xgg cloud login --restart');
    expect(result.error.hint).not.toContain('xgg login --code');
  });
});
