import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  cloudNonce,
  cloudRc4,
  cloudSignedNonce,
  decodeCloudResponse,
  encodeCloudRequest,
} from '../../../src/cloud/crypto.js';

const security = 'AAECAwQFBgcICQoLDA0ODw==';
const nonce = 'AAECAwQFBgcBsAEF';

describe('Xiaomi cloud cryptography', () => {
  it('matches independently generated mijiaAPI 5.0.0/PyCryptodome vectors', () => {
    const signed = cloudSignedNonce(security, nonce);
    expect(signed).toBe('txJEFQS1fCYeZA6mYwNy2pc7x6nkdv4QFZ3JhVIgyKo=');
    expect(
      cloudRc4(Buffer.from(signed, 'base64'), Buffer.from('hello world')).toString('base64'),
    ).toBe('g1JsCTcVmycsnnk=');
    expect(
      Object.fromEntries(encodeCloudRequest('/miotspec/prop/get', { params: [] }, security, nonce)),
    ).toEqual({
      data: 'kBVwBCpUgTt8yEaEBg==',
      rc4_hash__: 'mmc0FhptoQoOv3GUKt7I21VOKE6Xijt6LroPpA==',
      signature: '6HLTSIjARX+1p3lc3cAMmlEFQ+8=',
      ssecurity: security,
      _nonce: nonce,
    });
  });

  it('creates a 12-byte nonce with a big-endian minute suffix', () => {
    const result = Buffer.from(
      cloudNonce(60000 * 42, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])),
      'base64',
    );
    expect(result.subarray(0, 8)).toEqual(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(result.readUInt32BE(8)).toBe(42);
  });

  it('accepts plaintext errors and decrypts gzip cloud replies', () => {
    expect(decodeCloudResponse('{"code":401}', security, nonce)).toEqual({ code: 401 });
    const payload = gzipSync(Buffer.from('{"code":0,"result":{"ok":true}}'));
    const encrypted = cloudRc4(
      Buffer.from(cloudSignedNonce(security, nonce), 'base64'),
      payload,
    ).toString('base64');
    expect(decodeCloudResponse(encrypted, security, nonce)).toEqual({
      code: 0,
      result: { ok: true },
    });
  });
});
