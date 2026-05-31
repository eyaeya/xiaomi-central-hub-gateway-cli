import { randomBytes } from 'node:crypto';

export interface CipherMaterial {
  /** 16 bytes — AES-128 key */
  key: Buffer;
  /** 8 bytes — GCM nonce salt (the 12-byte nonce is [salt:8B][counter:4B LE]) */
  salt: Buffer;
}

/**
 * Derive the **transitional** AES-128-GCM cipher from the 32-byte EC-JPAKE shared
 * secret. The transitional cipher is used **once per side** to encrypt the per-direction
 * key blob carried in the 0x03 SESSION_KEY_EXCHANGE frame. After both 0x03 frames
 * exchange, the transitional cipher is discarded.
 *
 * See `docs/protocol/ec-jpake-binary-layout.md` §6.
 *
 * Layout of the 32-byte shared secret:
 *   bytes [0..16) → AES-128 key
 *   bytes [16..24) → 8-byte GCM IV salt
 *   bytes [24..32) → unused
 */
export function deriveTransitionalCipher(sharedSecret: Buffer): CipherMaterial {
  if (sharedSecret.length !== 32) {
    throw new Error(`shared secret must be 32 bytes, got ${sharedSecret.length}`);
  }
  return {
    key: Buffer.from(sharedSecret.subarray(0, 16)),
    salt: Buffer.from(sharedSecret.subarray(16, 24)),
  };
}

/**
 * Generate a fresh 24-byte random blob (16-byte AES key + 8-byte GCM salt) for
 * one direction of the data channel. The caller is responsible for transmitting
 * this material to the peer over the transitional cipher (0x03 frame).
 *
 * Returns both the parsed {key, salt} and the raw 24-byte blob ready for encryption.
 */
export function generateDirectionCipher(rand: () => Buffer = () => randomBytes(24)): {
  material: CipherMaterial;
  blob: Buffer;
} {
  const blob = rand();
  if (blob.length !== 24)
    throw new Error(`direction cipher blob must be 24 bytes, got ${blob.length}`);
  return {
    material: {
      key: Buffer.from(blob.subarray(0, 16)),
      salt: Buffer.from(blob.subarray(16, 24)),
    },
    blob: Buffer.from(blob),
  };
}

/**
 * Parse a 24-byte blob received from the peer (after decrypting their 0x03 frame
 * under the transitional cipher) into the peer's direction cipher material.
 */
export function parseDirectionBlob(blob: Buffer): CipherMaterial {
  if (blob.length !== 24) throw new Error(`direction blob must be 24 bytes, got ${blob.length}`);
  return {
    key: Buffer.from(blob.subarray(0, 16)),
    salt: Buffer.from(blob.subarray(16, 24)),
  };
}
