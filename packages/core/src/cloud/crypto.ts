// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Xiaomi cloud wire protocol, adapted from Do1e/mijia-api 5.0.0.
 * miutils.py credits Sammy Svensson's MIT-licensed micloud implementation.
 * See THIRD_PARTY_NOTICES.md for source attribution and distribution terms.
 */
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export function cloudNonce(now = Date.now(), entropy = randomBytes(8)): string {
  if (entropy.length !== 8) throw new Error('Cloud nonce entropy must contain eight bytes');
  const result = Buffer.alloc(12);
  result.set(entropy);
  result.writeUInt32BE(Math.floor(now / 60000), 8);
  return result.toString('base64');
}

export function cloudSignedNonce(security: string, nonce: string): string {
  return createHash('sha256')
    .update(Buffer.from(security, 'base64'))
    .update(Buffer.from(nonce, 'base64'))
    .digest('base64');
}

/** RC4-drop1024 is required by the remote protocol, not used for local storage. */
export function cloudRc4(key: Uint8Array, input: Uint8Array): Buffer {
  if (key.length === 0) throw new Error('Cloud cipher key is empty');
  const state = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const keyBytes = Buffer.from(key);
  const inputBytes = Buffer.from(input);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state.readUInt8(i) + keyBytes.readUInt8(i % key.length)) & 255;
    const value = state.readUInt8(i);
    state[i] = state.readUInt8(j);
    state[j] = value;
  }
  let i = 0;
  j = 0;
  const output = Buffer.alloc(input.length);
  for (let offset = -1024; offset < input.length; offset++) {
    i = (i + 1) & 255;
    j = (j + state.readUInt8(i)) & 255;
    const value = state.readUInt8(i);
    state[i] = state.readUInt8(j);
    state[j] = value;
    if (offset >= 0)
      output[offset] =
        inputBytes.readUInt8(offset) ^
        state.readUInt8((state.readUInt8(i) + state.readUInt8(j)) & 255);
  }
  return output;
}

function signature(path: string, signedNonce: string, params: Record<string, string>): string {
  const text = [
    'POST',
    path,
    ...Object.entries(params).map(([key, value]) => `${key}=${value}`),
    signedNonce,
  ].join('&');
  return createHash('sha1').update(text).digest('base64');
}

export function encodeCloudRequest(
  path: string,
  body: Record<string, unknown>,
  security: string,
  nonce: string,
): URLSearchParams {
  const signedNonce = cloudSignedNonce(security, nonce);
  const params: Record<string, string> = { data: JSON.stringify(body) };
  params.rc4_hash__ = signature(path, signedNonce, params);
  for (const [key, value] of Object.entries(params)) {
    params[key] = cloudRc4(Buffer.from(signedNonce, 'base64'), Buffer.from(value)).toString(
      'base64',
    );
  }
  return new URLSearchParams({
    ...params,
    signature: signature(path, signedNonce, params),
    ssecurity: security,
    _nonce: nonce,
  });
}

export function decodeCloudResponse(text: string, security: string, nonce: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const bytes = cloudRc4(
      Buffer.from(cloudSignedNonce(security, nonce), 'base64'),
      Buffer.from(text, 'base64'),
    );
    const decoded =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 })
        : bytes;
    return JSON.parse(decoded.toString('utf8')) as unknown;
  }
}
