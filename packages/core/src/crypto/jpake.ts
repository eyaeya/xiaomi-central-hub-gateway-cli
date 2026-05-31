import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { CURVE, Point } from '@noble/secp256k1';

const N: bigint = CURVE.n;

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function modN(x: bigint): bigint {
  const r = x % N;
  return r < 0n ? r + N : r;
}

function bigintTo32BE(n: bigint): Buffer {
  const hex = n.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

function bigintFrom32BE(buf: Buffer): bigint {
  if (buf.length === 0) return 0n;
  return BigInt(`0x${buf.toString('hex')}`);
}

function bigintFromBytesBE(buf: Buffer): bigint {
  if (buf.length === 0) return 0n;
  return BigInt(`0x${buf.toString('hex')}`);
}

function encodePointXY(p: Point): { x: Buffer; y: Buffer } {
  // @noble Point.toRawBytes(false) yields 65B (0x04 || X || Y)
  const raw = Buffer.from(p.toRawBytes(false));
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('point encoding invariant');
  return { x: Buffer.from(raw.subarray(1, 33)), y: Buffer.from(raw.subarray(33, 65)) };
}

/** Wire-format point (#P): [0x41][0x04|X|Y] = 66 bytes. */
function pointWire(p: Point): Buffer {
  const { x, y } = encodePointXY(p);
  return Buffer.concat([Buffer.from([0x41, 0x04]), x, y]);
}

function pointParse(buf: Buffer, off: number): { point: Point; next: number } {
  if (buf[off] !== 0x41) {
    throw new Error(`expected 0x41 at offset ${off}, got 0x${buf[off]?.toString(16)}`);
  }
  if (buf[off + 1] !== 0x04) {
    throw new Error(`expected 0x04 at offset ${off + 1}, got 0x${buf[off + 1]?.toString(16)}`);
  }
  const pointBytes = buf.subarray(off + 1, off + 1 + 65); // includes the 0x04
  const point = Point.fromHex(pointBytes);
  return { point, next: off + 1 + 65 };
}

function scalarWire(n: bigint): Buffer {
  return Buffer.concat([Buffer.from([0x20]), bigintTo32BE(n)]);
}

function scalarParse(buf: Buffer, off: number): { scalar: bigint; next: number } {
  if (buf[off] !== 0x20) {
    throw new Error(`expected 0x20 at offset ${off}, got 0x${buf[off]?.toString(16)}`);
  }
  const scalar = bigintFrom32BE(Buffer.from(buf.subarray(off + 1, off + 1 + 32)));
  return { scalar, next: off + 1 + 32 };
}

/** Hash-input point (#K): [u32BE(65)][0x04|X|Y] = 69 bytes. NOTE: NOT the same as #P. */
function pointHashInput(p: Point): Buffer {
  const { x, y } = encodePointXY(p);
  const out = Buffer.alloc(69);
  out.writeUInt32BE(65, 0);
  out[4] = 0x04;
  x.copy(out, 5);
  y.copy(out, 37);
  return out;
}

/** Role hash-input chunk: [u32BE(len)][role utf8 bytes]. */
function roleHashInput(role: 'client' | 'server'): Buffer {
  const r = Buffer.from(role, 'utf8'); // "client"=6B, "server"=6B
  const out = Buffer.alloc(4 + r.length);
  out.writeUInt32BE(r.length, 0);
  r.copy(out, 4);
  return out;
}

const G: Point = Point.BASE;

interface ZKP {
  V: Point;
  r: bigint;
}

/** Schnorr proof: prove knowledge of `priv` s.t. `pub = base · priv`. */
function writeZKP(
  base: Point,
  priv: bigint,
  pub: Point,
  role: 'client' | 'server',
  rand: () => Buffer,
): ZKP {
  let k = bigintFrom32BE(Buffer.from(rand())) % N;
  if (k === 0n) k = 1n;
  const V = base.multiply(k);
  const c = modN(
    bigintFrom32BE(
      sha256(pointHashInput(base), pointHashInput(V), pointHashInput(pub), roleHashInput(role)),
    ),
  );
  const r = modN(k - c * priv);
  return { V, r };
}

function verifyZKP(zkp: ZKP, base: Point, pub: Point, role: 'client' | 'server'): boolean {
  const c = modN(
    bigintFrom32BE(
      sha256(pointHashInput(base), pointHashInput(zkp.V), pointHashInput(pub), roleHashInput(role)),
    ),
  );
  // verify: pub · c + base · r == V
  const rhs = pub.multiply(c).add(base.multiply(zkp.r));
  return rhs.equals(zkp.V);
}

/** Wire-format ZKP (#D): [#P V 66B][0x20][r 32B BE] = 99 bytes. */
function zkpWire(z: ZKP): Buffer {
  return Buffer.concat([pointWire(z.V), scalarWire(z.r)]);
}

function zkpParse(buf: Buffer, off: number): { zkp: ZKP; next: number } {
  const { point: V, next: o1 } = pointParse(buf, off);
  const { scalar: r, next: o2 } = scalarParse(buf, o1);
  return { zkp: { V, r }, next: o2 };
}

/** #V() prefix prepended to server→client Round 2: [0x03][u16BE(0x16=22)] = 3 bytes. */
const ROUND_TWO_SERVER_PREFIX = Buffer.from([0x03, 0x00, 0x16]);

function passcodeToSecret(passcode: string): bigint {
  // Bundle: `new f(new TextEncoder().encode(passcode))` — BigInteger from UTF-8 bytes,
  // big-endian, no reduction. For a 6-digit decimal passcode this is < 2^48 so always < n.
  if (passcode.length === 0) throw new Error('passcode is empty');
  return bigintFromBytesBE(Buffer.from(passcode, 'utf8'));
}

export interface JpakeOptions {
  role: 'client' | 'server';
  passcode: string;
  /** Override RNG for deterministic tests. Returns 32 random bytes per call. */
  randomBytes?: () => Buffer;
  /** Override 16-byte RNG for the Round 2 `b16` randomization. */
  random16?: () => Buffer;
}

export class JpakeParty {
  private readonly role: 'client' | 'server';
  private readonly otherRole: 'client' | 'server';
  private readonly secret: bigint;
  private readonly rand32: () => Buffer;
  private readonly rand16: () => Buffer;

  // Self round 1
  private x1!: bigint;
  private x2!: bigint;
  private X1!: Point;
  private X2!: Point;

  // Peer round 1
  private peerX1!: Point;
  private peerX2!: Point;

  // Self round 2
  private x2s!: bigint;
  private A!: Point;

  // Peer round 2
  private B!: Point;

  // KDF output cache
  private shared?: Buffer;

  constructor(opts: JpakeOptions) {
    this.role = opts.role;
    this.otherRole = opts.role === 'client' ? 'server' : 'client';
    this.secret = passcodeToSecret(opts.passcode);
    this.rand32 = opts.randomBytes ?? (() => nodeRandomBytes(32));
    this.rand16 = opts.random16 ?? (() => nodeRandomBytes(16));
  }

  private randScalar(): bigint {
    let s = bigintFrom32BE(Buffer.from(this.rand32())) % N;
    if (s === 0n) s = 1n;
    return s;
  }

  writeRoundOne(): Buffer {
    this.x1 = this.randScalar();
    this.x2 = this.randScalar();
    this.X1 = G.multiply(this.x1);
    this.X2 = G.multiply(this.x2);
    const z1 = writeZKP(G, this.x1, this.X1, this.role, () => this.rand32());
    const z2 = writeZKP(G, this.x2, this.X2, this.role, () => this.rand32());
    return Buffer.concat([pointWire(this.X1), zkpWire(z1), pointWire(this.X2), zkpWire(z2)]);
  }

  readRoundOne(buf: Buffer): void {
    if (buf.length !== 330) throw new Error(`expected 330-byte round 1, got ${buf.length}`);
    let off = 0;
    const p1 = pointParse(buf, off);
    off = p1.next;
    const z1 = zkpParse(buf, off);
    off = z1.next;
    const p2 = pointParse(buf, off);
    off = p2.next;
    const z2 = zkpParse(buf, off);
    off = z2.next;
    if (!verifyZKP(z1.zkp, G, p1.point, this.otherRole)) {
      throw new Error('invalid ZKP for peer X1');
    }
    if (!verifyZKP(z2.zkp, G, p2.point, this.otherRole)) {
      throw new Error('invalid ZKP for peer X2');
    }
    this.peerX1 = p1.point;
    this.peerX2 = p2.point;
  }

  writeRoundTwo(): Buffer {
    // G2_self = X1_self + X1_peer + X2_peer
    const G2 = this.X1.add(this.peerX1).add(this.peerX2);
    // y = b16·n + secret  (≡ secret mod n; the b16·n component is a side-channel salt)
    const b16 = bigintFromBytesBE(Buffer.from(this.rand16()));
    const y = modN(b16 * N + this.secret);
    this.x2s = modN(this.x2 * y);
    this.A = G2.multiply(this.x2s);
    const zA = writeZKP(G2, this.x2s, this.A, this.role, () => this.rand32());
    const body = Buffer.concat([pointWire(this.A), zkpWire(zA)]);
    return this.role === 'server' ? Buffer.concat([ROUND_TWO_SERVER_PREFIX, body]) : body;
  }

  readRoundTwo(buf: Buffer): void {
    // Server-sent round 2 is 3 bytes longer due to the #V() prefix
    let off = 0;
    if (this.role === 'client') {
      // receiving from server → strip 3-byte prefix
      if (buf.length !== 168)
        throw new Error(`expected 168-byte server round 2, got ${buf.length}`);
      if (buf[0] !== 0x03 || buf[1] !== 0x00 || buf[2] !== 0x16) {
        throw new Error('invalid server round 2 prefix');
      }
      off = 3;
    } else {
      if (buf.length !== 165)
        throw new Error(`expected 165-byte client round 2, got ${buf.length}`);
    }
    const p = pointParse(buf, off);
    off = p.next;
    const z = zkpParse(buf, off);
    off = z.next;
    // G2_peer (as we compute it from our side) = X1_self + X2_self + X1_peer
    const peerG2 = this.X1.add(this.X2).add(this.peerX1);
    if (!verifyZKP(z.zkp, peerG2, p.point, this.otherRole)) {
      throw new Error('invalid ZKP for peer round 2');
    }
    this.B = p.point;
  }

  /** Returns the 32-byte SHA-256(Ka.X) — the transitional secret per §6 of the layout doc. */
  deriveSharedSecret(): Buffer {
    if (this.shared) return this.shared;
    // Replicate the bundle's readRoundTwo final block:
    //   y_self = b16_self · n + secret  (fresh)
    //   m = x2_self · y_self mod n
    //   Ka = (B - X2_peer · m) · x2_self
    const b16 = bigintFromBytesBE(Buffer.from(this.rand16()));
    const yLocal = modN(b16 * N + this.secret);
    const m = modN(this.x2 * yLocal);
    const negTerm = this.peerX2.multiply(modN(N - m));
    const Ka = this.B.add(negTerm).multiply(this.x2);
    const { x } = encodePointXY(Ka);
    this.shared = sha256(x);
    return this.shared;
  }
}
