import { GcmStream } from '../crypto/gcm.js';
import { JpakeParty } from '../crypto/jpake.js';
import {
  deriveTransitionalCipher,
  generateDirectionCipher,
  parseDirectionBlob,
} from '../crypto/kdf.js';
import { AuthRequiredError, NetworkError, XggError } from './errors.js';
import type { BinaryTransport } from './fake.js';
import {
  DATA_TYPE,
  decodeFrame,
  encodeProtocolList,
  encodeRawFrame,
  parseSelectedProtocol,
} from './frames.js';

export interface HandshakeResult {
  /** Server's send-direction key (peer-derived; from server's 0x03). */
  serverKey: Buffer;
  /** Server's send-direction salt (peer-derived; from server's 0x03). */
  serverSalt: Buffer;
  /** Client's send-direction key (self-generated; sent in client's 0x03). */
  clientKey: Buffer;
  /** Client's send-direction salt (self-generated; sent in client's 0x03). */
  clientSalt: Buffer;
  /** Live GCM stream encrypting client→server frames (counter starts at 1 on first encrypt). */
  clientSend: GcmStream;
  /** Live GCM stream decrypting server→client frames (counter starts at 1 on first decrypt). */
  clientRecv: GcmStream;
}

export interface RunHandshakeOptions {
  passcode: string;
  transport: BinaryTransport;
  /** Override RNG for the client's direction blob (test seam). */
  randomClientBlob?: () => Buffer;
}

/**
 * Drive the passcode WS handshake to completion:
 *   0x01 → 0x02 → 0x20 ↔ 0x20 → 0x21 ↔ 0x21 → 0x03 ↔ 0x03
 *
 * Implements the symmetric 0x03 SESSION_KEY_EXCHANGE flow (see
 * `docs/protocol/ec-jpake-binary-layout.md` §6/§7): the JPAKE shared secret
 * derives a one-shot transitional cipher; each side then sends its own random
 * 24-byte direction blob under that cipher, and the transitional cipher is
 * discarded once both 0x03 frames have been exchanged.
 *
 * On wire-level surprises:
 *  - `0x04 ERROR` from the gateway → `AuthRequiredError` (the only documented
 *    rejection signal during handshake is auth failure).
 *  - Unexpected frame type → `NetworkError` (with the expected hex).
 *  - Transport close (peer hangup, ws error event) → `NetworkError` tagged
 *    with the stage it died at. F52 (2026-05-30) — pre-F52 a clean WS-close
 *    leaked the raw `Error("transport closed")` past CLI error mapping,
 *    which then dropped it into the UNKNOWN-code bucket without an
 *    actionable hint.
 */
export async function runPasscodeHandshake(opts: RunHandshakeOptions): Promise<HandshakeResult> {
  const t = opts.transport;

  // 1. propose passcode protocol
  t.send(encodeProtocolList(['passcode']));

  // 2. await server selection
  {
    const f = decodeFrame(await recvOrNetworkError(t, 'selected-protocol (0x02)'));
    if (f.type === DATA_TYPE.ERROR) {
      throw new AuthRequiredError('gateway rejected protocol proposal');
    }
    if (f.type !== DATA_TYPE.SELECTED_PROTOCOL) {
      throw new NetworkError(`expected 0x02, got 0x${f.type.toString(16)}`);
    }
    const { protocol } = parseSelectedProtocol(f.payload);
    if (protocol !== 'passcode') {
      throw new NetworkError(`gateway selected unsupported protocol: ${protocol}`);
    }
  }

  // 3. JPAKE rounds — per ws-handshake.md, client speaks first on each round.
  const party = new JpakeParty({ role: 'client', passcode: opts.passcode });

  // Round 1: client sends (independent of peer state), then reads server's reply.
  t.send(encodeRawFrame(DATA_TYPE.ECJPAKE_ROUND_ONE, party.writeRoundOne()));
  {
    const f = decodeFrame(await recvOrNetworkError(t, 'jpake round 1 (0x20)'));
    if (f.type === DATA_TYPE.ERROR) {
      throw new AuthRequiredError('gateway rejected before round 1');
    }
    if (f.type !== DATA_TYPE.ECJPAKE_ROUND_ONE) {
      throw new NetworkError(`expected 0x20, got 0x${f.type.toString(16)}`);
    }
    party.readRoundOne(f.payload);
  }

  // Round 2: writeRoundTwo() needs peerX1/X2 from readRoundOne above, so the
  // write-then-send must come after step-1 recv.
  t.send(encodeRawFrame(DATA_TYPE.ECJPAKE_ROUND_TWO, party.writeRoundTwo()));
  {
    const f = decodeFrame(await recvOrNetworkError(t, 'jpake round 2 (0x21)'));
    if (f.type === DATA_TYPE.ERROR) {
      throw new AuthRequiredError('gateway rejected before round 2');
    }
    if (f.type !== DATA_TYPE.ECJPAKE_ROUND_TWO) {
      throw new NetworkError(`expected 0x21, got 0x${f.type.toString(16)}`);
    }
    party.readRoundTwo(f.payload);
  }

  // 4. transitional cipher + own direction blob
  const shared = party.deriveSharedSecret();
  const trans = deriveTransitionalCipher(shared);
  const transSend = new GcmStream({ key: trans.key, salt: trans.salt, direction: 'send' });
  const transRecv = new GcmStream({ key: trans.key, salt: trans.salt, direction: 'recv' });

  const own = opts.randomClientBlob
    ? generateDirectionCipher(opts.randomClientBlob)
    : generateDirectionCipher();

  // 5. send own 0x03 (encrypted blob)
  t.send(encodeRawFrame(DATA_TYPE.SESSION_KEY_EXCHANGE, transSend.encrypt(own.blob)));

  // 6. recv server's 0x03 → parse server's direction blob
  let serverMat: { key: Buffer; salt: Buffer };
  {
    const f = decodeFrame(await recvOrNetworkError(t, 'session-key exchange (0x03)'));
    if (f.type === DATA_TYPE.ERROR) {
      throw new AuthRequiredError('gateway dropped before session-key exchange');
    }
    if (f.type !== DATA_TYPE.SESSION_KEY_EXCHANGE) {
      throw new NetworkError(`expected 0x03, got 0x${f.type.toString(16)}`);
    }
    // GCM tag mismatch here surfaces as a plain Error from node:crypto — let it
    // bubble; the test asserts on /decrypt/ to catch the passcode-mismatch case.
    const peerBlob = transRecv.decrypt(f.payload);
    serverMat = parseDirectionBlob(peerBlob);
  }

  // 7. discard transitional cipher; build the real per-direction streams.
  const clientSend = new GcmStream({
    key: own.material.key,
    salt: own.material.salt,
    direction: 'send',
  });
  const clientRecv = new GcmStream({
    key: serverMat.key,
    salt: serverMat.salt,
    direction: 'recv',
  });

  return {
    serverKey: serverMat.key,
    serverSalt: serverMat.salt,
    clientKey: own.material.key,
    clientSalt: own.material.salt,
    clientSend,
    clientRecv,
  };
}

// F52 (2026-05-30) — every t.receive() in the handshake is routed through
// this helper so a peer-closed transport (or any other recv-side throw)
// surfaces as a typed NetworkError carrying the stage tag. Previously the
// raw Error('transport closed') from PipeTransport (or the raw 'ws' lib
// error from ws.on('error')) leaked past the handshake into CLI error
// mapping, which dropped it into the UNKNOWN-code bucket and skipped the
// per-message reachability hint. Single-sentinel (NetworkError, not
// AuthRequiredError) because the gateway signals real auth failure via
// 0x04 ERROR which is handled separately at each round.
async function recvOrNetworkError(t: BinaryTransport, stage: string): Promise<Buffer> {
  try {
    return await t.receive();
  } catch (e) {
    if (e instanceof XggError) throw e;
    const cause = e instanceof Error ? e.message : String(e);
    throw new NetworkError(`transport closed before ${stage}`, { stage, cause });
  }
}
