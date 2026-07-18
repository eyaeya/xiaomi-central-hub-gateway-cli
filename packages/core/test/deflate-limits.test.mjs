import assert from 'node:assert/strict';
import test from 'node:test';

import { packInnerJson, unpackInnerJson } from '../dist/crypto/deflate.js';
import { DEFAULT_MAX_INNER_COMPRESSED_BYTES, DEFAULT_MAX_INNER_JSON_BYTES } from '../dist/index.js';

test('unpackInnerJson decodes a normal small response with default limits', () => {
  const value = { jsonrpc: '2.0', id: 1, result: { ok: true } };
  assert.deepEqual(unpackInnerJson(packInnerJson(value)), value);
  assert.equal(DEFAULT_MAX_INNER_COMPRESSED_BYTES, 16 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_INNER_JSON_BYTES, 64 * 1024 * 1024);
});

test('unpackInnerJson accepts decoded and compressed payloads exactly at configured limits', () => {
  const value = 'A'.repeat(1022); // JSON encoding adds two quote bytes.
  const blob = packInnerJson(value);
  const compressedLength = blob.length - 4;

  assert.equal(blob.readUInt32LE(0), 1024);
  assert.equal(
    unpackInnerJson(blob, {
      maxJsonBytes: 1024,
      maxCompressedBytes: compressedLength,
    }),
    value,
  );
});

test('unpackInnerJson rejects a declared decoded length above the configured limit', () => {
  const blob = packInnerJson('ok');
  blob.writeUInt32LE(1025, 0);

  assert.throws(
    () => unpackInnerJson(blob, { maxJsonBytes: 1024 }),
    /inner declared length 1025 exceeds limit 1024/,
  );
});

test('unpackInnerJson rejects compressed input above the configured limit before inflate', () => {
  const blob = packInnerJson({ value: 'small' });
  const compressedLength = blob.length - 4;

  assert.throws(
    () => unpackInnerJson(blob, { maxCompressedBytes: compressedLength - 1 }),
    new RegExp(`inner compressed length ${compressedLength} exceeds limit ${compressedLength - 1}`),
  );
});

test('unpackInnerJson rejects actual output that exceeds the declared length', () => {
  const blob = packInnerJson('A'.repeat(4096));
  blob.writeUInt32LE(1024, 0);

  assert.throws(
    () => unpackInnerJson(blob, { maxJsonBytes: 1024 }),
    /inner inflated output exceeds declared length 1024/,
  );
});

test('unpackInnerJson bounds a high-compression-ratio payload without RSS assertions', () => {
  const blob = packInnerJson('A'.repeat(2 * 1024 * 1024));
  const compressedLength = blob.length - 4;
  assert.ok(
    compressedLength < 4096,
    `expected compact bomb fixture, got ${compressedLength} bytes`,
  );

  // Forge an in-range declaration. maxOutputLength must stop zlib when the
  // actual two-MiB JSON output crosses this 64-KiB declaration.
  blob.writeUInt32LE(64 * 1024, 0);
  assert.throws(
    () =>
      unpackInnerJson(blob, {
        maxJsonBytes: 64 * 1024,
        maxCompressedBytes: 4096,
      }),
    /inner inflated output exceeds declared length 65536/,
  );
});

test('unpackInnerJson rejects zero declarations and invalid receive limits', () => {
  const blob = packInnerJson(null);
  blob.writeUInt32LE(0, 0);
  assert.throws(() => unpackInnerJson(blob), /inner declared length must be positive/);
  assert.throws(
    () => unpackInnerJson(packInnerJson(null), { maxJsonBytes: 0 }),
    /maxJsonBytes must be a positive safe integer/,
  );
});
