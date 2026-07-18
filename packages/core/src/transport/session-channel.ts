import { type InnerJsonLimits, packInnerJson, unpackInnerJson } from '../crypto/deflate.js';
import type { GcmStream } from '../crypto/gcm.js';
import { DATA_TYPE, decodeFrame, encodeRawFrame } from './frames.js';

export interface SessionChannelOptions {
  send: GcmStream;
  recv: GcmStream;
  /** Optional DATA-frame receive ceilings. Defaults are exported from the core package. */
  receiveLimits?: InnerJsonLimits;
}

export class SessionChannel {
  constructor(private readonly opts: SessionChannelOptions) {}

  sendJson(value: unknown): Buffer {
    const inner = packInnerJson(value);
    const body = this.opts.send.encrypt(inner);
    return encodeRawFrame(DATA_TYPE.DATA, body);
  }

  recvJson(frame: Buffer): unknown {
    const { type, payload } = decodeFrame(frame);
    if (type !== DATA_TYPE.DATA) {
      // F55 (2026-05-30) — template both sides of the hex so the error
      // string is symmetric with recvRaw below. Pre-F55 the "expected"
      // side was hardcoded as `0x05` while the "got" side templated via
      // toString(16) — minor cosmetic asymmetry within the same file.
      throw new Error(
        `expected 0x${DATA_TYPE.DATA.toString(16)} DATA frame, got 0x${type.toString(16)}`,
      );
    }
    const inner = this.opts.recv.decrypt(payload);
    return unpackInnerJson(inner, this.opts.receiveLimits);
  }

  /** Encrypt a raw byte payload (used by 0x03 SESSION_KEY_EXCHANGE — no deflate, no JSON). */
  sendRaw(payload: Buffer, frameType: number = DATA_TYPE.SESSION_KEY_EXCHANGE): Buffer {
    const body = this.opts.send.encrypt(payload);
    return encodeRawFrame(frameType, body);
  }

  /** Decrypt a raw byte payload from 0x03 frame. */
  recvRaw(frame: Buffer, expectedType: number = DATA_TYPE.SESSION_KEY_EXCHANGE): Buffer {
    const { type, payload } = decodeFrame(frame);
    if (type !== expectedType) {
      throw new Error(`expected 0x${expectedType.toString(16)} frame, got 0x${type.toString(16)}`);
    }
    return this.opts.recv.decrypt(payload);
  }
}
