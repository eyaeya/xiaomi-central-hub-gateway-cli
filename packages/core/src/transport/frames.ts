import { ProtocolListFrame, SelectedProtocolFrame } from '../schemas/ws-raw-frame.js';

export const DATA_TYPE = {
  PROTOCOL_LIST: 0x01,
  SELECTED_PROTOCOL: 0x02,
  SESSION_KEY_EXCHANGE: 0x03,
  ERROR: 0x04,
  DATA: 0x05,
  SERVER_PUB_KEY: 0x10,
  ECJPAKE_ROUND_ONE: 0x20,
  ECJPAKE_ROUND_TWO: 0x21,
} as const;

export type DataTypeByte = (typeof DATA_TYPE)[keyof typeof DATA_TYPE];

export interface DecodedFrame {
  type: number;
  payload: Buffer;
}

export function decodeFrame(buf: Buffer): DecodedFrame {
  if (buf.length === 0) {
    throw new Error('empty frame');
  }
  const type = buf[0];
  if (type === undefined) throw new Error('empty frame');
  return { type, payload: buf.subarray(1) };
}

export function encodeRawFrame(type: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(1 + payload.length);
  out[0] = type;
  payload.copy(out, 1);
  return out;
}

export function writeUint32LE(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt32LE(value >>> 0, offset);
}

export function readUint32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

export function encodeProtocolList(protocols: readonly string[]): Buffer {
  ProtocolListFrame.parse(protocols);
  const json = Buffer.from(JSON.stringify(protocols), 'utf8');
  return encodeRawFrame(DATA_TYPE.PROTOCOL_LIST, json);
}

export function parseProtocolList(payload: Buffer): string[] {
  const json = JSON.parse(payload.toString('utf8'));
  return ProtocolListFrame.parse(json);
}

export function encodeSelectedProtocol(value: { protocol: string }): Buffer {
  SelectedProtocolFrame.parse(value);
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  return encodeRawFrame(DATA_TYPE.SELECTED_PROTOCOL, json);
}

export function parseSelectedProtocol(payload: Buffer): { protocol: string } {
  const json = JSON.parse(payload.toString('utf8'));
  return SelectedProtocolFrame.parse(json);
}
