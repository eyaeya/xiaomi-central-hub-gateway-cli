import { GcmStream } from '../crypto/gcm.js';
import { JpakeParty } from '../crypto/jpake.js';
import {
  deriveTransitionalCipher,
  generateDirectionCipher,
  parseDirectionBlob,
} from '../crypto/kdf.js';
import {
  DATA_TYPE,
  decodeFrame,
  encodeRawFrame,
  encodeSelectedProtocol,
  parseProtocolList,
} from './frames.js';

export interface BinaryTransport {
  send(frame: Buffer): void;
  /** Resolves with the next frame received. Rejects if the transport is closed while waiting. */
  receive(): Promise<Buffer>;
  close(): void;
}

class PipeTransport implements BinaryTransport {
  private peer!: PipeTransport;
  private readonly queue: Buffer[] = [];
  private resolveNext: ((b: Buffer) => void) | null = null;
  private rejectNext: ((e: unknown) => void) | null = null;
  private closed = false;

  setPeer(p: PipeTransport): void {
    this.peer = p;
  }

  send(frame: Buffer): void {
    if (this.closed) throw new Error('transport closed');
    const copy = Buffer.from(frame);
    queueMicrotask(() => this.peer.deliver(copy));
  }

  private deliver(frame: Buffer): void {
    if (this.closed) return;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      this.rejectNext = null;
      r(frame);
    } else {
      this.queue.push(frame);
    }
  }

  receive(): Promise<Buffer> {
    if (this.closed && this.queue.length === 0) {
      return Promise.reject(new Error('transport closed'));
    }
    const head = this.queue.shift();
    if (head !== undefined) return Promise.resolve(head);
    return new Promise<Buffer>((resolve, reject) => {
      this.resolveNext = resolve;
      this.rejectNext = reject;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.rejectNext) {
      const r = this.rejectNext;
      this.resolveNext = null;
      this.rejectNext = null;
      r(new Error('transport closed'));
    }
    // Mirror real WS behaviour: closing one side tears down both. Without
    // this, a peer awaiting receive() would hang forever once the writer side
    // is dead.
    if (this.peer && !this.peer.closed) {
      this.peer.close();
    }
  }
}

export function makeFakeTransportPair(): [BinaryTransport, BinaryTransport] {
  const a = new PipeTransport();
  const b = new PipeTransport();
  a.setPeer(b);
  b.setPeer(a);
  return [a, b];
}

export interface StubServerOptions {
  passcode: string;
  transport: BinaryTransport;
}

/**
 * Minimal server-side passcode handshake emulator. Mirrors the symmetric 0x03
 * dance described in `docs/protocol/ec-jpake-binary-layout.md` §6/§7:
 *
 *   1. recv 0x01 PROTOCOL_LIST → send 0x02 SELECTED_PROTOCOL
 *   2. exchange 0x20/0x21 JPAKE rounds (server is one of the two parties)
 *   3. derive 32B JPAKE secret → transitional cipher
 *   4. generate own 24B direction blob (server-send key+salt)
 *   5. encrypt own blob under transitional cipher → send as 0x03
 *   6. recv peer's 0x03 → decrypt → parse client's direction blob
 *   7. discard transitional cipher; the real data streams start fresh per direction
 *
 * The server holds the connection open until `stop()` so the handshake test can
 * observe both negotiated direction blobs.
 */
export class StubGatewayServer {
  negotiatedClientKey: Buffer | null = null;
  negotiatedClientSalt: Buffer | null = null;
  serverKey: Buffer | null = null;
  serverSalt: Buffer | null = null;
  private running = false;
  private done!: Promise<void>;

  constructor(private readonly opts: StubServerOptions) {}

  start(): void {
    this.running = true;
    this.done = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.opts.transport.close();
    try {
      await this.done;
    } catch {
      // run() exits via transport close while awaiting; that's expected.
    }
  }

  private async run(): Promise<void> {
    // 1. recv 0x01 PROTOCOL_LIST
    const f1 = await this.opts.transport.receive();
    const { type: t1, payload: p1 } = decodeFrame(f1);
    if (t1 !== DATA_TYPE.PROTOCOL_LIST) throw new Error(`expected 0x01, got 0x${t1.toString(16)}`);
    const protos = parseProtocolList(p1);
    if (!protos.includes('passcode')) throw new Error('passcode not offered');

    // 2. send 0x02 SELECTED_PROTOCOL
    this.opts.transport.send(encodeSelectedProtocol({ protocol: 'passcode' }));

    // 3. JPAKE rounds — server speaks first on each round
    const party = new JpakeParty({ role: 'server', passcode: this.opts.passcode });
    this.opts.transport.send(encodeRawFrame(DATA_TYPE.ECJPAKE_ROUND_ONE, party.writeRoundOne()));
    {
      const { type, payload } = decodeFrame(await this.opts.transport.receive());
      if (type !== DATA_TYPE.ECJPAKE_ROUND_ONE) {
        throw new Error(`expected 0x20, got 0x${type.toString(16)}`);
      }
      party.readRoundOne(payload);
    }
    this.opts.transport.send(encodeRawFrame(DATA_TYPE.ECJPAKE_ROUND_TWO, party.writeRoundTwo()));
    {
      const { type, payload } = decodeFrame(await this.opts.transport.receive());
      if (type !== DATA_TYPE.ECJPAKE_ROUND_TWO) {
        throw new Error(`expected 0x21, got 0x${type.toString(16)}`);
      }
      party.readRoundTwo(payload);
    }

    // 4. derive transitional cipher + own direction blob
    const shared = party.deriveSharedSecret();
    const trans = deriveTransitionalCipher(shared);
    const transSend = new GcmStream({ key: trans.key, salt: trans.salt, direction: 'send' });
    const transRecv = new GcmStream({ key: trans.key, salt: trans.salt, direction: 'recv' });

    const own = generateDirectionCipher();
    this.serverKey = own.material.key;
    this.serverSalt = own.material.salt;

    // 5. send own 0x03 (encrypted blob)
    this.opts.transport.send(
      encodeRawFrame(DATA_TYPE.SESSION_KEY_EXCHANGE, transSend.encrypt(own.blob)),
    );

    // 6. recv peer's 0x03 → parse client direction blob
    const { type: tc, payload: pc } = decodeFrame(await this.opts.transport.receive());
    if (tc !== DATA_TYPE.SESSION_KEY_EXCHANGE) {
      throw new Error(`expected 0x03 from client, got 0x${tc.toString(16)}`);
    }
    const peerBlob = transRecv.decrypt(pc);
    const peerMat = parseDirectionBlob(peerBlob);
    this.negotiatedClientKey = peerMat.key;
    this.negotiatedClientSalt = peerMat.salt;

    // Hold the connection open until stop() so the test can inspect state.
    while (this.running) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
