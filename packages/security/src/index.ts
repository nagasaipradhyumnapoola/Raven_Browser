// Security primitives: device identity (Ed25519), auth transcripts, destination
// guard (no private/loopback/metadata targets), token buckets and rate windows.
// Only standard Node crypto is used; no home-made cryptography.
import crypto from 'node:crypto';
import net from 'node:net';

// ---------- Device identity ----------
export interface DeviceKeyPair {
  /** SPKI DER base64 */
  publicKey: string;
  /** PKCS8 DER base64 (store encrypted at rest) */
  privateKey: string;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Stable device id derived from the public key (so it cannot be spoofed). */
export function deviceIdFromPublicKey(publicKeyB64: string): string {
  const h = crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex');
  return `RVN-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`.toUpperCase();
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Transcript the device signs to prove possession of its private key. It binds
 * the server nonce, the device id and the TLS channel the client actually saw
 * (`pin:<cert sha256>` for a pinned certificate, `ca:<hostname>` for a
 * CA-validated remote endpoint), so a relay in the middle cannot reuse it.
 */
export function authTranscript(nonce: string, deviceId: string, channel: string): Buffer {
  return Buffer.from(`raven-auth-v1|${nonce}|${deviceId}|${channel}`, 'utf8');
}

export function signTranscript(privateKeyB64: string, transcript: Buffer): string {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, transcript, key).toString('base64');
}

export function verifyTranscript(publicKeyB64: string, transcript: Buffer, signatureB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, transcript, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** Six-digit code shown on both the browser and the dashboard during pairing. */
export function pairingCode(serverFingerprint: string, publicKeyB64: string): string {
  const h = crypto.createHash('sha256').update(`raven-pair-v1|${serverFingerprint}|${publicKeyB64}`).digest();
  const n = h.readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------- PIN hashing (dashboard unlock) ----------
export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const want = Buffer.from(parts[2], 'base64');
  const got = crypto.scryptSync(pin, salt, want.length);
  return crypto.timingSafeEqual(want, got);
}

// ---------- Destination guard ----------
function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** Expand an IPv6 literal to 8 hextets (returns null when malformed). */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    if (!net.isIPv4(maybeV4)) return null;
    const n = ipv4ToInt(maybeV4);
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...rest].map((h) => parseInt(h || '0', 16));
  if (parts.length !== 8 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
  if (tail.length) {
    parts[6] = tail[0];
    parts[7] = tail[1];
  }
  return parts;
}

/**
 * True when an IP literal must never be reached through the gateway: loopback,
 * private LAN ranges, link-local, CGNAT, multicast, cloud metadata and their
 * IPv6 equivalents (including IPv4-mapped / NAT64 forms).
 */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return V4_BLOCKED.some(([b, bits]) => inV4(ip, b, bits));
  if (!net.isIPv6(ip)) return true; // not an IP at all: refuse
  const p = expandV6(ip);
  if (!p) return true;
  const allZeroTo = (n: number) => p.slice(0, n).every((x) => x === 0);
  if (allZeroTo(7) && (p[7] === 0 || p[7] === 1)) return true; // :: and ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZeroTo(5) && (p[5] === 0xffff || p[5] === 0)) {
    const v4 = `${p[6] >> 8}.${p[6] & 0xff}.${p[7] >> 8}.${p[7] & 0xff}`;
    return isBlockedAddress(v4);
  }
  // NAT64 64:ff9b::/96
  if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0)) {
    const v4 = `${p[6] >> 8}.${p[6] & 0xff}.${p[7] >> 8}.${p[7] & 0xff}`;
    return isBlockedAddress(v4);
  }
  if ((p[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((p[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((p[0] & 0xff00) === 0xff00) return true; // multicast
  if (p[0] === 0x2001 && p[1] === 0xdb8) return true; // documentation
  return false;
}

/** Private/LAN peer check used to classify a client connection as LAN or remote. */
export function isLanPeer(ip: string): boolean {
  let a = ip;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (net.isIPv4(a)) {
    return (
      inV4(a, '10.0.0.0', 8) ||
      inV4(a, '172.16.0.0', 12) ||
      inV4(a, '192.168.0.0', 16) ||
      inV4(a, '169.254.0.0', 16) ||
      inV4(a, '127.0.0.0', 8)
    );
  }
  const p = expandV6(a);
  if (!p) return false;
  if (p.slice(0, 7).every((x) => x === 0) && p[7] === 1) return true;
  return (p[0] & 0xfe00) === 0xfc00 || (p[0] & 0xffc0) === 0xfe80;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i;

export interface HostCheck {
  ok: boolean;
  reason?: string;
}

/** Syntactic validation of a CONNECT target before any DNS work happens. */
export function validateTarget(host: string, port: number, blockedPorts: number[] = [25]): HostCheck {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'bad port' };
  if (blockedPorts.includes(port)) return { ok: false, reason: 'port not allowed' };
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return { ok: false, reason: 'bad host' };
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(h)) return { ok: true };
  if (!HOST_RE.test(h)) return { ok: false, reason: 'bad host' };
  const lower = h.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return { ok: false, reason: 'local name' };
  }
  return { ok: true };
}

// ---------- Rate limiting ----------
/** Token bucket used for bandwidth shaping (bytes) — time is injected for tests. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private rate: number,
    private burst: number = rate,
    private now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  setRate(rate: number, burst: number = rate): void {
    this.rate = rate;
    this.burst = burst;
    if (this.tokens > burst) this.tokens = burst;
  }
  get unlimited(): boolean {
    return this.rate <= 0;
  }
  /** Milliseconds to wait before `n` units may pass; consumes them. */
  take(n: number): number {
    if (this.rate <= 0) return 0;
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    this.tokens -= n;
    if (this.tokens >= 0) return 0;
    return Math.ceil((-this.tokens / this.rate) * 1000);
  }
}

/** Sliding window counter (timestamps) for per-minute/hour/day request limits. */
export class RateWindow {
  private stamps: number[] = [];
  constructor(private now: () => number = Date.now) {}
  record(): void {
    this.stamps.push(this.now());
    this.trim();
  }
  private trim(): void {
    const cutoff = this.now() - 24 * 3600_000;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i] < cutoff) i++;
    if (i > 0) this.stamps.splice(0, i);
  }
  count(windowMs: number): number {
    const cutoff = this.now() - windowMs;
    let n = 0;
    for (let i = this.stamps.length - 1; i >= 0 && this.stamps[i] >= cutoff; i--) n++;
    return n;
  }
  usage(): { minute: number; hour: number; day: number } {
    this.trim();
    return { minute: this.count(60_000), hour: this.count(3600_000), day: this.count(24 * 3600_000) };
  }
  /** ms until the oldest stamp inside the window expires. */
  resetIn(windowMs: number): number {
    const cutoff = this.now() - windowMs;
    const first = this.stamps.find((s) => s >= cutoff);
    return first === undefined ? 0 : Math.max(0, first + windowMs - this.now());
  }
  export(): number[] {
    this.trim();
    return [...this.stamps];
  }
  import(stamps: number[]): void {
    this.stamps = stamps.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
    this.trim();
  }
}

/** Redact anything that looks like a secret before it reaches a log line. */
export function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(sk|gsk|key|pk|xai|AIza)[-_][A-Za-z0-9_-]{12,}/g, '[redacted-key]')
    .replace(/\bfreellmapi-[A-Za-z0-9_-]{8,}/gi, '[redacted-key]')
    .replace(/("?(?:api[_-]?key|apikey|authorization|token|secret|password)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, '$1[redacted]');
}
export * from './link';
