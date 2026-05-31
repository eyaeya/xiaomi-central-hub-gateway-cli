import { createCipheriv, createDecipheriv } from 'node:crypto';

export const GCM_TAG_LEN = 16;
export const GCM_IV_LEN = 12;
export const GCM_KEY_LEN = 16;
export const GCM_SALT_LEN = 8;
export const GCM_COUNTER_LEN = 4;

export function makeIv(salt: Buffer, counter: number): Buffer {
  if (salt.length !== GCM_SALT_LEN) {
    throw new Error(`salt must be ${GCM_SALT_LEN} bytes, got ${salt.length}`);
  }
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) {
    throw new Error(`counter out of uint32 range: ${counter}`);
  }
  const iv = Buffer.allocUnsafe(GCM_IV_LEN);
  salt.copy(iv, 0);
  iv.writeUInt32LE(counter, GCM_SALT_LEN);
  return iv;
}

export interface GcmStreamOptions {
  key: Buffer;
  salt: Buffer;
  /** 'send' starts at counter 1 and increments on encrypt; 'recv' tracks the largest counter seen. */
  direction: 'send' | 'recv';
}

export class GcmStream {
  private readonly key: Buffer;
  private readonly salt: Buffer;
  private readonly direction: 'send' | 'recv';
  /** For 'send': next counter to use. For 'recv': largest accepted counter. */
  counter = 0;

  constructor(opts: GcmStreamOptions) {
    if (opts.key.length !== GCM_KEY_LEN) {
      throw new Error(`key must be ${GCM_KEY_LEN} bytes`);
    }
    if (opts.salt.length !== GCM_SALT_LEN) {
      throw new Error(`salt must be ${GCM_SALT_LEN} bytes`);
    }
    this.key = opts.key;
    this.salt = opts.salt;
    this.direction = opts.direction;
  }

  encrypt(plaintext: Buffer): Buffer {
    if (this.direction !== 'send') throw new Error('encrypt called on recv stream');
    this.counter += 1;
    const iv = makeIv(this.salt, this.counter);
    const cipher = createCipheriv('aes-128-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const out = Buffer.allocUnsafe(GCM_COUNTER_LEN + ct.length + GCM_TAG_LEN);
    out.writeUInt32LE(this.counter, 0);
    ct.copy(out, GCM_COUNTER_LEN);
    tag.copy(out, GCM_COUNTER_LEN + ct.length);
    return out;
  }

  decrypt(frame: Buffer): Buffer {
    if (this.direction !== 'recv') throw new Error('decrypt called on send stream');
    if (frame.length < GCM_COUNTER_LEN + GCM_TAG_LEN) {
      throw new Error('frame too short');
    }
    const counter = frame.readUInt32LE(0);
    if (counter <= this.counter) {
      throw new Error(`replay or out-of-order counter: got ${counter}, last ${this.counter}`);
    }
    const ct = frame.subarray(GCM_COUNTER_LEN, frame.length - GCM_TAG_LEN);
    const tag = frame.subarray(frame.length - GCM_TAG_LEN);
    const iv = makeIv(this.salt, counter);
    const decipher = createDecipheriv('aes-128-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    this.counter = counter;
    return pt;
  }
}
