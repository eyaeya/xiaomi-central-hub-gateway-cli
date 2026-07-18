import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LEN_PREFIX = 4;

/**
 * Default receive limit for decoded DATA-frame JSON. The 64 MiB ceiling leaves
 * headroom for generated backup payloads while keeping synchronous inflate
 * bounded. Callers with a measured larger requirement can override it through
 * `SessionChannelOptions.receiveLimits`.
 */
export const DEFAULT_MAX_INNER_JSON_BYTES = 64 * 1024 * 1024;

/**
 * Default receive limit for the compressed bytes after the four-byte length
 * prefix. This is deliberately lower than the decoded limit: legitimate JSON
 * should compress, while a large incompressible frame should be rejected before
 * zlib work begins.
 */
export const DEFAULT_MAX_INNER_COMPRESSED_BYTES = 16 * 1024 * 1024;

export interface InnerJsonLimits {
  /** Maximum declared and actual decoded UTF-8 JSON bytes. Must be a positive integer. */
  maxJsonBytes?: number;
  /** Maximum compressed bytes, excluding the four-byte length prefix. */
  maxCompressedBytes?: number;
}

function positiveIntegerLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function packInnerJson(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const compressed = deflateRawSync(json);
  const out = Buffer.allocUnsafe(LEN_PREFIX + compressed.length);
  out.writeUInt32LE(json.length, 0);
  compressed.copy(out, LEN_PREFIX);
  return out;
}

export function unpackInnerJson(blob: Buffer, limits: InnerJsonLimits = {}): unknown {
  const maxJsonBytes = positiveIntegerLimit(
    limits.maxJsonBytes ?? DEFAULT_MAX_INNER_JSON_BYTES,
    'maxJsonBytes',
  );
  const maxCompressedBytes = positiveIntegerLimit(
    limits.maxCompressedBytes ?? DEFAULT_MAX_INNER_COMPRESSED_BYTES,
    'maxCompressedBytes',
  );
  if (blob.length < LEN_PREFIX) {
    throw new Error('inner blob too short');
  }

  const compressedLength = blob.length - LEN_PREFIX;
  if (compressedLength === 0) {
    throw new Error('inner compressed payload is empty');
  }
  if (compressedLength > maxCompressedBytes) {
    throw new Error(
      `inner compressed length ${compressedLength} exceeds limit ${maxCompressedBytes}`,
    );
  }

  const declaredLen = blob.readUInt32LE(0);
  if (declaredLen === 0) {
    throw new Error('inner declared length must be positive');
  }
  if (declaredLen > maxJsonBytes) {
    throw new Error(`inner declared length ${declaredLen} exceeds limit ${maxJsonBytes}`);
  }

  let inflated: Buffer;
  try {
    // Use the peer's (already range-checked) declaration as the zlib hard
    // ceiling. This catches both output over the configured limit and a forged
    // too-small declaration before zlib can allocate the complete output.
    inflated = inflateRawSync(blob.subarray(LEN_PREFIX), {
      maxOutputLength: declaredLen,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`inner inflated output exceeds declared length ${declaredLen}`, { cause });
    }
    throw new Error('inner deflate decode failed', { cause });
  }
  if (inflated.length !== declaredLen) {
    throw new Error(`inner length mismatch: declared ${declaredLen}, inflated ${inflated.length}`);
  }
  try {
    return JSON.parse(inflated.toString('utf8'));
  } catch (cause) {
    throw new Error('inner JSON parse failed', { cause });
  }
}
