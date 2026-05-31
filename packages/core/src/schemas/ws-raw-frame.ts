import { z } from 'zod';

/**
 * WS 帧类型枚举。源于 gateway.6cbc85.js class Rr static DATA_TYPE。
 * 文档：docs/protocol/ws-handshake.md §2
 */
export const WsDataType = z.enum([
  'PROTOCOL_LIST', // 0x01
  'SELECTED_PROTOCOL', // 0x02
  'SESSION_KEY_EXCHANGE', // 0x03
  'ERROR', // 0x04
  'DATA', // 0x05
  'SERVER_PUB_KEY', // 0x10
  'ECJPAKE_ROUND_ONE', // 0x20
  'ECJPAKE_ROUND_TWO', // 0x21
]);
export type WsDataType = z.infer<typeof WsDataType>;

/** 0x01 / 0x02 明文帧的 numeric → name 映射 */
export const DataTypeByte = {
  1: 'PROTOCOL_LIST',
  2: 'SELECTED_PROTOCOL',
  3: 'SESSION_KEY_EXCHANGE',
  4: 'ERROR',
  5: 'DATA',
  16: 'SERVER_PUB_KEY',
  32: 'ECJPAKE_ROUND_ONE',
  33: 'ECJPAKE_ROUND_TWO',
} as const satisfies Record<number, WsDataType>;

/** 0x01 client→server: 协议提案（明文 JSON array） */
export const ProtocolListFrame = z.array(z.string()).min(1);
export type ProtocolListFrame = z.infer<typeof ProtocolListFrame>;

/** 0x02 server→client: 协议选择（明文 JSON） */
export const SelectedProtocolFrame = z.object({
  protocol: z.string(),
});
export type SelectedProtocolFrame = z.infer<typeof SelectedProtocolFrame>;
