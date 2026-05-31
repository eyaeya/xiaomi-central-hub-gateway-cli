import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LEN_PREFIX = 4;

export function packInnerJson(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const compressed = deflateRawSync(json);
  const out = Buffer.allocUnsafe(LEN_PREFIX + compressed.length);
  out.writeUInt32LE(json.length, 0);
  compressed.copy(out, LEN_PREFIX);
  return out;
}

export function unpackInnerJson(blob: Buffer): unknown {
  if (blob.length < LEN_PREFIX) {
    throw new Error('inner blob too short');
  }
  const declaredLen = blob.readUInt32LE(0);
  const inflated = inflateRawSync(blob.subarray(LEN_PREFIX));
  if (inflated.length !== declaredLen) {
    throw new Error(`inner length mismatch: declared ${declaredLen}, inflated ${inflated.length}`);
  }
  return JSON.parse(inflated.toString('utf8'));
}
