// Master gateway: authenticated TLS WebSocket endpoint that forwards browser
// traffic to the internet and AI requests to FreeLLMAPI. Every request is
// authorized on the server against the device record and the service switches;
// nothing here trusts the client.
import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PRODUCT,
  RavenError,
  isPlainObject,
  type AiRequest,
  type ClientState,
  type DeviceRecord,
  type DeviceView,
  type ErrCode,
  type ServiceSwitches,
} from '@raven/shared';
import {
  RateWindow,
  TokenBucket,
  authTranscript,
  deviceIdFromPublicKey,
  isBlockedAddress,
  isLanPeer,
  pairingCode,
  redact,
  validateTarget,
  verifyTranscript,
} from '@raven/security';
import { MuxSession, type MuxStream, type OpenRequest } from '@raven/network-protocol';
import { appendJsonl, atomicWriteSync, readJsonSync } from '../../../../packages/local-memory/src/fsutil';
import type { ConfigStore } from './config';
import type { DeviceRegistry, DevicePatch } from './devices';
import type { AiService } from './ai';

export interface TlsMaterial {
  key: string;
  cert: string;
  /** sha256 of the certificate DER, lowercase hex */
  fingerprint: string;
}

export interface GatewayDeps {
  dataDir: string;
  config: ConfigStore;
  devices: DeviceRegistry;
  ai: AiService;
  tls: TlsMaterial;
  version: string;
  /** injected for tests; defaults to a real connectivity probe */
  internetProbe?: () => Promise<boolean>;
  /** extra device RPC methods (assistant routing, agent tasks); throw an Error with .code to refuse */
  rpcHandler?: (device: DeviceRecord, method: string, params: unknown) => Promise<unknown>;
  /** whether agent tasks are available to this device (host decides) */
  agentsFor?: (device: DeviceRecord) => boolean;
  /** addresses outside the LAN this master is reachable at (router port mapping), host:port */
  extraRoutes?: () => string[];
}

export interface LogEvent {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'security';
  msg: string;
  deviceId?: string;
}

interface TcpEntry {
  stream: MuxStream;
  socket: net.Socket;
  down: number;
  bulk: boolean;
  host: string;
}

interface AiEntry {
  stream: MuxStream;
  abort: AbortController;
}

interface Session {
  id: number;
  ws: WebSocket;
  mux: MuxSession;
  ip: string;
  scope: 'lan' | 'remote';
  nonce: string;
  authed: boolean;
  deviceId: string | null;
  tcp: Set<TcpEntry>;
  ai: Set<AiEntry>;
  winUp: number;
  winDown: number;
  bpsUp: number;
  bpsDown: number;
  bucketUp: TokenBucket;
  bucketDown: TokenBucket;
  authTimer: NodeJS.Timeout | null;
  connectedAt: number;
}

const BULK_BYTES = 16 * 1024 * 1024;
const MAX_UNAUTH = 64;
const MAX_PENDING = 25;
const GLOBAL_AI_CONCURRENCY = 12;

function throttledPump(src: Readable, dst: Writable, bucket: TokenBucket, onBytes: (n: number) => void): void {
  src.on('data', (chunk: Buffer) => {
    onBytes(chunk.length);
    const flushed = dst.write(chunk);
    const wait = bucket.take(chunk.length);
    if (flushed && wait <= 0) return;
    src.pause();
    let gates = 0;
    const open = () => {
      if (--gates === 0 && !(src as any).destroyed) src.resume();
    };
    if (!flushed) {
      gates++;
      dst.once('drain', open);
    }
    if (wait > 0) {
      gates++;
      setTimeout(open, Math.min(wait, 5000));
    }
  });
  src.on('end', () => {
    if (!(dst as any).destroyed) dst.end();
  });
}

/**
 * This machine's network interfaces. Android may refuse the lookup to apps; the Raven Master app then passes
 * its Wi-Fi / hotspot addresses in RAVEN_LAN_IPS (comma separated), refreshed through setLanAddresses().
 */
let lanOverride: string[] | null = process.env.RAVEN_LAN_IPS ? process.env.RAVEN_LAN_IPS.split(',').map((s) => s.trim()).filter(Boolean) : null;
export function setLanAddresses(list: string[] | null): void {
  lanOverride = list;
}
export function interfaces(): { address: string; family: string; internal: boolean; netmask: string }[] {
  try {
    const out = Object.values(os.networkInterfaces()).flatMap((l) => l ?? []).map((a) => ({ address: a.address, family: String(a.family), internal: a.internal, netmask: a.netmask }));
    if (out.some((a) => !a.internal) || !lanOverride) return out;
  } catch {
    /* not allowed on this platform */
  }
  return [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0' }, ...(lanOverride ?? []).map((address) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0' }))];
}

function localAddresses(): Set<string> {
  return new Set(interfaces().map((a) => a.address.toLowerCase()));
}

export function lanAddresses(): string[] {
  return interfaces()
    .filter((a) => (a.family === 'IPv4' || a.family === '4') && !a.internal)
    .map((a) => a.address);
}

async function defaultInternetProbe(): Promise<boolean> {
  const tryOne = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port: 443 });
      const t = setTimeout(() => {
        s.destroy();
        resolve(false);
      }, 4000);
      s.once('connect', () => {
        clearTimeout(t);
        s.destroy();
        resolve(true);
      });
      s.once('error', () => {
        clearTimeout(t);
        resolve(false);
      });
    });
  const results = await Promise.all([tryOne('1.1.1.1'), tryOne('8.8.8.8')]);
  return results.some(Boolean);
}

export class GatewayServer extends EventEmitter {
  private server: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private sessions = new Set<Session>();
  private byDevice = new Map<string, Session>();
  private seq = 1;
  private aiWindows = new Map<string, RateWindow>();
  private ipAttempts = new Map<string, RateWindow>();
  private events: LogEvent[] = [];
  private tick: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private usageFile: string;
  private eventsFile: string;
  private probe: () => Promise<boolean>;
  masterOnline = true;
  listening = false;
  listenError: string | null = null;
  startedAt = 0;

  constructor(private deps: GatewayDeps) {
    super();
    this.usageFile = path.join(deps.dataDir, 'usage.json');
    this.eventsFile = path.join(deps.dataDir, 'logs', 'events.jsonl');
    this.probe = deps.internetProbe ?? defaultInternetProbe;
    const usage = readJsonSync<Record<string, number[]>>(this.usageFile, {});
    if (isPlainObject(usage)) {
      for (const [id, stamps] of Object.entries(usage)) {
        if (Array.isArray(stamps)) {
          const w = new RateWindow();
          w.import(stamps as number[]);
          this.aiWindows.set(id, w);
        }
      }
    }
    deps.ai.on('change', () => this.pushStateAll());
  }

  private get cfg() {
    return this.deps.config.value;
  }

  get switches(): ServiceSwitches {
    return this.cfg.switches;
  }

  get fingerprint(): string {
    return this.deps.tls.fingerprint;
  }

  // ---------- logging ----------
  log(level: LogEvent['level'], msg: string, deviceId?: string): void {
    const ev: LogEvent = { ts: Date.now(), level, msg: redact(msg), ...(deviceId ? { deviceId } : {}) };
    this.events.push(ev);
    if (this.events.length > 1500) this.events.splice(0, this.events.length - 1500);
    void appendJsonl(this.eventsFile, ev).catch(() => {});
    this.emit('log', ev);
  }

  recentEvents(deviceId?: string, limit = 200): LogEvent[] {
    const list = deviceId ? this.events.filter((e) => e.deviceId === deviceId) : this.events;
    return list.slice(-limit).reverse();
  }

  // ---------- lifecycle ----------
  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.tick = setInterval(() => this.onTick(), 1000);
    this.tick.unref?.();
    this.persistTimer = setInterval(() => this.persist(), 20_000);
    this.persistTimer.unref?.();
    const runProbe = async () => {
      let ok = false;
      try {
        ok = await this.probe();
      } catch {
        ok = false;
      }
      if (ok !== this.masterOnline) {
        this.masterOnline = ok;
        this.log(ok ? 'info' : 'warn', ok ? 'Internet connection on this laptop is back.' : 'No internet on the master laptop.');
        this.pushStateAll();
        this.emit('change');
      }
    };
    void runProbe();
    this.probeTimer = setInterval(() => void runProbe(), 30_000);
    this.probeTimer.unref?.();
    if (this.switches.master) await this.listen();
  }

  async stop(): Promise<void> {
    if (this.tick) clearInterval(this.tick);
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.tick = this.probeTimer = this.persistTimer = null;
    await this.unlisten('server_unreachable');
    this.persist();
  }

  private persist(): void {
    try {
      this.deps.devices.flushIfDirty();
      const usage: Record<string, number[]> = {};
      for (const [id, w] of this.aiWindows) {
        const s = w.export();
        if (s.length) usage[id] = s;
      }
      atomicWriteSync(this.usageFile, JSON.stringify(usage));
    } catch (e) {
      this.log('error', `Could not save state: ${(e as Error).message}`);
    }
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve) => {
      const server = https.createServer(
        { key: this.deps.tls.key, cert: this.deps.tls.cert, minVersion: 'TLSv1.2' },
        (_req, res) => {
          // Nothing but the WebSocket endpoint is served here. Never a proxy, never an admin API.
          res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' });
          res.end('Not found');
        },
      );
      server.on('clientError', (_e, socket) => socket.destroy());
      server.on('tlsClientError', () => {});
      // A plain HTTP CONNECT / proxy request to this port is refused outright.
      server.on('connect', (_req, socket) => socket.destroy());
      const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
      server.on('upgrade', (req, socket, head) => {
        const url = req.url ?? '';
        if (url !== `/raven/v${PRODUCT.protocolVersion}`) {
          socket.destroy();
          return;
        }
        const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
        if (!this.allowAttempt(ip)) {
          socket.destroy();
          return;
        }
        const forwarded = !!(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['forwarded']);
        wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, ip, forwarded));
      });
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.listening = false;
        this.listenError = err.code === 'EADDRINUSE' ? `Port ${this.cfg.port} is already in use by another program.` : err.message;
        this.server = null;
        this.wss = null;
        this.log('error', `Gateway could not start: ${this.listenError}`);
        this.emit('change');
        resolve();
      });
      // RAVEN_BIND is a development/test override (for example 127.0.0.1); normal runs listen on every interface.
      server.listen(this.cfg.port, process.env.RAVEN_BIND || '0.0.0.0', () => {
        this.server = server;
        this.wss = wss;
        this.listening = true;
        this.listenError = null;
        this.log('info', `Gateway listening on port ${this.cfg.port}.`);
        this.emit('change');
        resolve();
      });
    });
  }

  private async unlisten(code: ErrCode): Promise<void> {
    for (const s of [...this.sessions]) this.closeSession(s, code);
    const server = this.server;
    this.server = null;
    this.wss = null;
    this.listening = false;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      this.log('info', 'Gateway stopped; port released.');
    }
    this.emit('change');
  }

  /** Change the port: restarts the listener when it is running. */
  async rebind(): Promise<void> {
    if (!this.server) return;
    await this.unlisten('server_unreachable');
    if (this.switches.master) await this.listen();
  }

  private allowAttempt(ip: string): boolean {
    let w = this.ipAttempts.get(ip);
    if (!w) {
      w = new RateWindow();
      this.ipAttempts.set(ip, w);
      if (this.ipAttempts.size > 2000) this.ipAttempts.clear();
    }
    if (w.count(60_000) >= 40) return false;
    w.record();
    let unauth = 0;
    for (const s of this.sessions) if (!s.authed) unauth++;
    return unauth < MAX_UNAUTH;
  }

  // ---------- connection + authentication ----------
  private onSocket(ws: WebSocket, ip: string, forwarded: boolean): void {
    const scope: 'lan' | 'remote' = !forwarded && isLanPeer(ip) ? 'lan' : 'remote';
    const mux = new MuxSession(
      {
        send: (data, cb) => {
          if (ws.readyState !== ws.OPEN) return cb(new Error('closed'));
          ws.send(data, { binary: true }, cb);
        },
        close: () => ws.close(),
      },
      'server',
      1024,
    );
    const sess: Session = {
      id: this.seq++,
      ws,
      mux,
      ip,
      scope,
      nonce: crypto.randomBytes(24).toString('base64url'),
      authed: false,
      deviceId: null,
      tcp: new Set(),
      ai: new Set(),
      winUp: 0,
      winDown: 0,
      bpsUp: 0,
      bpsDown: 0,
      bucketUp: new TokenBucket(0),
      bucketDown: new TokenBucket(0),
      authTimer: null,
      connectedAt: Date.now(),
    };
    this.sessions.add(sess);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        ws.close();
        return;
      }
      mux.handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
    });
    ws.on('error', () => {});
    ws.on('close', () => this.dropSession(sess));
    mux.on('ctrl', (msg: any) => this.onCtrl(sess, msg));
    mux.onOpen = (stream, req, accept, reject) => void this.onOpen(sess, stream, req, accept, reject);

    const sw = this.switches;
    if ((scope === 'lan' && !sw.lan) || (scope === 'remote' && !sw.remote)) {
      this.log('security', `Rejected ${scope} connection from ${ip}: ${scope} access is off.`);
      this.deny(sess, 'access_scope_disabled');
      return;
    }
    sess.authTimer = setTimeout(() => this.closeSession(sess, 'device_unauthorized'), 10_000);
    mux.sendCtrl({ t: 'challenge', nonce: sess.nonce, serverName: this.cfg.serverName });
  }

  private deny(sess: Session, code: ErrCode): void {
    sess.mux.sendCtrl({ t: 'denied', code });
    setTimeout(() => this.closeSession(sess), 150);
  }

  private closeSession(sess: Session, byeCode?: ErrCode): void {
    if (byeCode && sess.ws.readyState === sess.ws.OPEN) sess.mux.sendCtrl({ t: 'bye', code: byeCode });
    if (sess.authTimer) clearTimeout(sess.authTimer);
    const ws = sess.ws;
    setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }, byeCode ? 120 : 0);
    if (!byeCode) this.dropSession(sess);
  }

  private dropSession(sess: Session): void {
    if (!this.sessions.delete(sess)) return;
    if (sess.authTimer) clearTimeout(sess.authTimer);
    for (const e of [...sess.tcp]) e.socket.destroy();
    for (const e of [...sess.ai]) e.abort.abort();
    sess.tcp.clear();
    sess.ai.clear();
    sess.mux.close('socket closed');
    if (sess.deviceId && this.byDevice.get(sess.deviceId) === sess) {
      this.byDevice.delete(sess.deviceId);
      this.deps.devices.update(sess.deviceId, { lastSeen: Date.now() });
      this.log('info', 'Device disconnected.', sess.deviceId);
    }
    this.emit('change');
  }

  private onCtrl(sess: Session, msg: any): void {
    if (!isPlainObject(msg) || typeof msg.t !== 'string') return;
    if (!sess.authed && !sess.deviceId) {
      if (msg.t === 'auth') this.onAuth(sess, msg);
      return;
    }
    switch (msg.t) {
      case 'ping':
        sess.mux.sendCtrl({ t: 'pong' });
        break;
      case 'rpc':
        this.onRpc(sess, msg);
        break;
      default:
        break;
    }
  }

  private onAuth(sess: Session, msg: any): void {
    const { deviceId, publicKey, name, channel, sig } = msg;
    const strOk = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
    if (!strOk(deviceId, 40) || !strOk(publicKey, 400) || !strOk(channel, 300) || !strOk(sig, 400) || msg.v !== PRODUCT.protocolVersion) {
      this.log('security', `Malformed authentication from ${sess.ip}.`);
      return this.deny(sess, 'bad_request');
    }
    // The signed channel must be the TLS channel this server really terminates.
    const pinOk = channel === `pin:${this.deps.tls.fingerprint}`;
    const caHost = channel.startsWith('ca:') ? channel.slice(3) : null;
    const caOk = !!caHost && this.switches.remote && this.cfg.remoteHosts.includes(caHost);
    if (!pinOk && !caOk) {
      this.log('security', `Authentication with a wrong channel binding from ${sess.ip} (possible interception).`, deviceId);
      return this.deny(sess, 'device_unauthorized');
    }
    const devices = this.deps.devices;
    let device = devices.get(deviceId);
    const keyToVerify = device ? device.publicKey : publicKey;
    if (!device && deviceIdFromPublicKey(publicKey) !== deviceId) {
      this.log('security', `Device id does not match its key (spoofing attempt) from ${sess.ip}.`, deviceId);
      return this.deny(sess, 'device_unauthorized');
    }
    if (!verifyTranscript(keyToVerify, authTranscript(sess.nonce, deviceId, channel), sig)) {
      this.log('security', `Invalid device credential from ${sess.ip}.`, deviceId);
      if (device) devices.update(deviceId, { lastError: 'Invalid device credential' });
      return this.deny(sess, device?.status === 'revoked' ? 'device_revoked' : 'device_unauthorized');
    }
    if (!device) {
      if (devices.isKeyRevoked(publicKey)) {
        this.log('security', `Revoked credential tried to pair again from ${sess.ip}.`, deviceId);
        return this.deny(sess, 'device_revoked');
      }
      if (!this.switches.pairing || this.switches.maintenance) return this.deny(sess, 'pairing_disabled');
      if (devices.pendingCount() >= MAX_PENDING) return this.deny(sess, 'too_many_connections');
      device = devices.addPending(deviceId, publicKey, typeof name === 'string' ? name : '', pairingCode(this.deps.tls.fingerprint, publicKey));
      this.log('info', `New device "${device.name}" asked to pair from ${sess.ip}.`, deviceId);
      if (sess.scope === 'lan' && this.cfg.autoApproveUntil > Date.now()) {
        devices.setStatus(deviceId, 'approved');
        this.log('security', `Device "${device.name}" auto-approved (temporary LAN auto-approve is on).`, deviceId);
      }
      this.emit('pairing-request', device);
    }
    if (device.status === 'revoked') return this.deny(sess, 'device_revoked');

    let approvedOnline = 0;
    for (const s of this.byDevice.values()) if (s.authed) approvedOnline++;
    if (device.status !== 'pending' && approvedOnline >= this.cfg.maxClients && !this.byDevice.has(deviceId)) {
      return this.deny(sess, 'too_many_connections');
    }

    if (sess.authTimer) clearTimeout(sess.authTimer);
    sess.authTimer = null;
    const old = this.byDevice.get(deviceId);
    if (old && old !== sess) this.closeSession(old);
    sess.deviceId = deviceId;
    this.byDevice.set(deviceId, sess);
    devices.update(deviceId, {
      lastSeen: Date.now(),
      lastIp: sess.ip,
      lastScope: sess.scope,
      ...(typeof name === 'string' && device.status === 'pending' && name.trim() ? { name } : {}),
    });
    this.applyLimits(sess, device);
    if (device.status === 'pending') {
      sess.mux.sendCtrl({ t: 'pending', code: device.pairingCode });
    } else {
      sess.authed = true;
      sess.mux.sendCtrl({ t: 'welcome', state: this.clientState(sess, device) });
      this.log('info', `Device connected over ${sess.scope} from ${sess.ip}.`, deviceId);
    }
    this.emit('change');
  }

  private onRpc(sess: Session, msg: any): void {
    const reply = (ok: boolean, extra: Record<string, unknown> = {}) => sess.mux.sendCtrl({ t: 'rpc_result', id: msg.id, ok, ...extra });
    const device = sess.deviceId ? this.deps.devices.get(sess.deviceId) : undefined;
    if (!device || !sess.authed || device.status !== 'approved') return reply(false, { code: 'device_unauthorized' });
    if (msg.method === 'rotate_key') {
      const p = msg.params;
      if (!isPlainObject(p) || typeof p.publicKey !== 'string' || typeof p.sigOld !== 'string' || typeof p.sigNew !== 'string') {
        return reply(false, { code: 'bad_request' });
      }
      const transcript = Buffer.from(`raven-rotate-v1|${device.id}|${p.publicKey}`, 'utf8');
      if (!verifyTranscript(device.publicKey, transcript, p.sigOld) || !verifyTranscript(p.publicKey, transcript, p.sigNew)) {
        this.log('security', 'Rejected a credential rotation with bad signatures.', device.id);
        return reply(false, { code: 'device_unauthorized' });
      }
      this.deps.devices.rotateKey(device.id, p.publicKey);
      this.log('security', 'Device credential rotated.', device.id);
      return reply(true);
    }
    if (msg.method === 'refresh') {
      sess.mux.sendCtrl({ t: 'state', state: this.clientState(sess, device) });
      return reply(true);
    }
    const h = this.deps.rpcHandler;
    if (h && typeof msg.method === 'string' && msg.method.length <= 40) {
      h(device, msg.method, msg.params).then(
        (result) => reply(true, { result }),
        (e: any) => reply(false, { code: typeof e?.code === 'string' ? e.code : 'internal', detail: redact(String(e?.message ?? 'failed')).slice(0, 300) }),
      );
      return;
    }
    return reply(false, { code: 'bad_request' });
  }

  private applyLimits(sess: Session, device: DeviceRecord): void {
    const bps = device.limits.bandwidthBps;
    const burst = Math.max(bps, 64 * 1024);
    sess.bucketUp.setRate(bps, burst);
    sess.bucketDown.setRate(bps, burst);
  }

  private aiWindow(deviceId: string): RateWindow {
    let w = this.aiWindows.get(deviceId);
    if (!w) {
      w = new RateWindow();
      this.aiWindows.set(deviceId, w);
    }
    return w;
  }

  private clientState(sess: Session, device: DeviceRecord): ClientState {
    const sw = this.switches;
    const ai = this.deps.ai;
    const usable = device.status === 'approved';
    return {
      serverName: this.cfg.serverName,
      serverVersion: this.deps.version,
      deviceStatus: device.status,
      services: { master: sw.master, internet: sw.internet, ai: sw.ai, maintenance: sw.maintenance },
      permissions: { internet: usable && device.internet, ai: usable && device.ai },
      masterOnline: this.masterOnline,
      aiBackend: ai.health,
      models: usable && device.ai && sw.ai ? ai.permittedFor(device).map((m) => ({ id: m.id, name: m.name, provider: m.provider, available: m.available })) : [],
      defaultModel: device.defaultModel ?? this.cfg.models.defaultModel,
      autoAllowed: ai.autoAllowed(device) || ai.permittedFor(device).some((m) => m.available),
      limits: device.limits,
      aiUsage: this.aiWindow(device.id).usage(),
      latestBrowserVersion: this.cfg.latestBrowserVersion,
      agents: usable && !!this.deps.agentsFor?.(device),
      // Every address a paired device may try when the one it used stops working (changing networks).
      routes: usable ? [...new Set([...(process.env.RAVEN_BIND ? [process.env.RAVEN_BIND] : lanAddresses()).map((a) => `${a}:${this.cfg.port}`), ...(sw.remote ? this.deps.extraRoutes?.() ?? [] : [])])].slice(0, 12) : [],
    };
  }

  private pushState(sess: Session): void {
    if (!sess.deviceId) return;
    const device = this.deps.devices.get(sess.deviceId);
    if (!device) return;
    if (sess.authed) sess.mux.sendCtrl({ t: 'state', state: this.clientState(sess, device) });
  }

  /** Push an event to one device if it is online. Returns false when it is not connected. */
  sendEvent(deviceId: string, ev: unknown): boolean {
    const s = this.byDevice.get(deviceId);
    if (!s || !s.authed) return false;
    s.mux.sendCtrl({ t: 'event', ev });
    return true;
  }

  isOnline(deviceId: string): boolean {
    return !!this.byDevice.get(deviceId)?.authed;
  }

  pushStateAll(): void {
    for (const s of this.sessions) this.pushState(s);
  }

  // ---------- stream authorization ----------
  private gate(sess: Session): { device: DeviceRecord } | { code: ErrCode } {
    const device = sess.deviceId ? this.deps.devices.get(sess.deviceId) : undefined;
    if (!device || !sess.authed) return { code: device?.status === 'pending' ? 'device_pending' : 'device_unauthorized' };
    if (device.status === 'revoked') return { code: 'device_revoked' };
    if (device.status === 'suspended') return { code: 'device_suspended' };
    if (device.status !== 'approved') return { code: 'device_pending' };
    if (!this.switches.master) return { code: 'server_unreachable' };
    if (this.switches.maintenance) return { code: 'maintenance' };
    return { device };
  }

  private async onOpen(
    sess: Session,
    stream: MuxStream,
    req: OpenRequest,
    accept: (meta?: unknown) => void,
    reject: (code: ErrCode, detail?: string) => void,
  ): Promise<void> {
    stream.on('error', () => {});
    const g = this.gate(sess);
    if ('code' in g) return reject(g.code);
    try {
      if (isPlainObject(req) && req.kind === 'tcp') await this.openTcp(sess, g.device, stream, req as any, accept, reject);
      else if (isPlainObject(req) && req.kind === 'ai') await this.openAi(sess, g.device, stream, (req as any).req, accept, reject);
      else reject('bad_request');
    } catch (e) {
      const code = e instanceof RavenError ? e.code : 'internal';
      reject(code, e instanceof RavenError ? e.detail : undefined);
      if (!(e instanceof RavenError)) this.log('error', `Stream failed: ${(e as Error).message}`, sess.deviceId ?? undefined);
    }
  }

  private allowlisted(host: string, ip: string, port: number): boolean {
    const list = this.cfg.lanAllowlist.map((s) => s.toLowerCase().trim());
    const h = host.toLowerCase();
    return list.includes(h) || list.includes(`${h}:${port}`) || list.includes(ip) || list.includes(`${ip}:${port}`);
  }

  private async resolveTarget(host: string, port: number): Promise<string[]> {
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    let addrs: string[];
    if (net.isIP(bare)) addrs = [bare];
    else {
      try {
        let dnsTimer: NodeJS.Timeout | undefined;
        try {
          const res = await Promise.race([
            dns.promises.lookup(bare, { all: true, verbatim: false }),
            new Promise<never>((_, rej) => {
              dnsTimer = setTimeout(() => rej(new Error('dns timeout')), 8000);
            }),
          ]);
          addrs = res.map((r) => r.address);
        } finally {
          clearTimeout(dnsTimer);
        }
      } catch {
        throw new RavenError(this.masterOnline ? 'dns_failure' : 'master_no_internet', bare);
      }
    }
    if (addrs.length === 0) throw new RavenError('dns_failure', bare);
    const own = localAddresses();
    // Every resolved address is checked and we connect to the vetted IP, so a
    // hostname cannot be re-pointed at a private address after the check.
    const allowed = addrs.filter((ip) => this.allowlisted(bare, ip, port) || (!isBlockedAddress(ip) && !own.has(ip.toLowerCase())));
    if (allowed.length === 0) throw new RavenError('blocked_destination', bare);
    return allowed.slice(0, 3);
  }

  private connectTo(ip: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: ip, port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new RavenError('connect_timeout'));
      }, 12_000);
      s.once('connect', () => {
        clearTimeout(t);
        s.setNoDelay(true);
        s.setKeepAlive(true, 30_000);
        resolve(s);
      });
      s.once('error', () => {
        clearTimeout(t);
        reject(new RavenError('connect_failed'));
      });
    });
  }

  private async openTcp(
    sess: Session,
    device: DeviceRecord,
    stream: MuxStream,
    req: { host: unknown; port: unknown },
    accept: (meta?: unknown) => void,
    reject: (code: ErrCode, detail?: string) => void,
  ): Promise<void> {
    if (!this.switches.internet) return reject('internet_gateway_disabled');
    if (!device.internet) return reject('internet_not_permitted');
    if (sess.tcp.size >= device.limits.maxConnections) return reject('too_many_connections');
    const host = typeof req.host === 'string' ? req.host : '';
    const port = typeof req.port === 'number' ? req.port : 0;
    const check = validateTarget(host, port, this.cfg.blockedPorts);
    if (!check.ok) {
      const bare = host.toLowerCase();
      if (!(check.reason === 'local name' && this.cfg.lanAllowlist.map((s) => s.toLowerCase()).some((e) => e === bare || e === `${bare}:${port}`))) {
        this.log('security', `Blocked request to ${host.slice(0, 80)}:${port} (${check.reason}).`, device.id);
        return reject(check.reason === 'local name' || check.reason === 'port not allowed' ? 'blocked_destination' : 'bad_request');
      }
    }
    let ips: string[];
    try {
      ips = await this.resolveTarget(host, port);
    } catch (e) {
      if (e instanceof RavenError && e.code === 'blocked_destination') {
        this.log('security', `Blocked request to private address ${host}:${port}.`, device.id);
      }
      throw e;
    }
    let socket: net.Socket | null = null;
    let lastErr: RavenError = new RavenError('connect_failed');
    for (const ip of ips) {
      if (stream.destroyed) return;
      try {
        socket = await this.connectTo(ip, port);
        break;
      } catch (e) {
        lastErr = e as RavenError;
      }
    }
    if (!socket) throw this.masterOnline ? lastErr : new RavenError('master_no_internet');
    // Re-check: a permission may have been switched off while we were connecting.
    const g = this.gate(sess);
    const dev = 'device' in g ? g.device : null;
    if (stream.destroyed || !dev || !dev.internet || !this.switches.internet) {
      socket.destroy();
      if (!stream.destroyed) reject('code' in g ? g.code : !this.switches.internet ? 'internet_gateway_disabled' : 'internet_not_permitted');
      return;
    }
    const entry: TcpEntry = { stream, socket, down: 0, bulk: false, host };
    sess.tcp.add(entry);
    accept();
    const sock = socket;
    throttledPump(sock, stream, sess.bucketDown, (n) => {
      sess.winDown += n;
      dev.totalDown += n;
      entry.down += n;
      if (!entry.bulk && entry.down >= BULK_BYTES) {
        let bulk = 0;
        for (const e of sess.tcp) if (e.bulk) bulk++;
        if (bulk >= dev.limits.maxDownloads) {
          this.log('warn', `Large transfer stopped: device is over its limit of ${dev.limits.maxDownloads} concurrent downloads.`, dev.id);
          stream.reset('too_many_connections', 'concurrent download limit');
          sock.destroy();
          return;
        }
        entry.bulk = true;
      }
    });
    throttledPump(stream, sock, sess.bucketUp, (n) => {
      sess.winUp += n;
      dev.totalUp += n;
    });
    this.deps.devices.markDirty();
    let linger: NodeJS.Timeout | null = null;
    // Half-closed tunnels (browser finished sending, site never closes) are not kept forever.
    let half: NodeJS.Timeout | null = null;
    const armHalf = () => {
      if (half) clearTimeout(half);
      half = setTimeout(() => {
        sock.destroy();
        if (!stream.destroyed) stream.destroy();
      }, 20_000);
      half.unref?.();
    };
    stream.once('end', armHalf);
    sock.on('data', () => {
      if (half) armHalf();
    });
    sock.on('error', () => {
      if (!stream.destroyed) stream.reset('connect_failed');
    });
    sock.on('close', (hadError: boolean) => {
      if (half) clearTimeout(half);
      sess.tcp.delete(entry);
      if (stream.destroyed) return;
      if (hadError) stream.reset('connect_failed');
      else {
        // Clean close by the site: everything it sent is already queued on the
        // stream, so let the browser read it to the end instead of resetting.
        if (!stream.writableEnded) stream.end();
        linger = setTimeout(() => {
          if (!stream.destroyed) stream.destroy();
        }, 30_000);
        linger.unref?.();
      }
    });
    stream.on('close', () => {
      if (linger) clearTimeout(linger);
      if (half) clearTimeout(half);
      sess.tcp.delete(entry);
      // Flush any upload tail before closing a cleanly finished connection.
      if (stream.readableEnded && !stream.errored) sock.destroySoon();
      else sock.destroy();
    });
  }

  private validateAiRequest(raw: unknown, maxBytes: number): AiRequest {
    if (!isPlainObject(raw) || !Array.isArray(raw.messages)) throw new RavenError('bad_request');
    let size = 0;
    const messages = raw.messages.slice(0, 400).map((m) => {
      if (!isPlainObject(m) || typeof m.content !== 'string' || !['system', 'user', 'assistant'].includes(m.role as string)) {
        throw new RavenError('bad_request');
      }
      size += Buffer.byteLength(m.content);
      return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
    });
    if (messages.length === 0) throw new RavenError('bad_request');
    if (size > maxBytes) throw new RavenError('payload_too_large');
    return {
      messages,
      model: typeof raw.model === 'string' && raw.model.length <= 200 ? raw.model : 'auto',
      profile: raw.profile === 'coding' ? 'coding' : 'general',
      maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : undefined,
    };
  }

  private async openAi(
    sess: Session,
    device: DeviceRecord,
    stream: MuxStream,
    raw: unknown,
    accept: (meta?: unknown) => void,
    reject: (code: ErrCode, detail?: string) => void,
  ): Promise<void> {
    if (!this.switches.ai) return reject('ai_gateway_disabled');
    if (!device.ai) return reject('ai_not_permitted');
    const req = this.validateAiRequest(raw, device.limits.maxPayloadBytes);
    if (sess.ai.size >= device.limits.aiConcurrent) return reject('too_many_connections', 'concurrent generations');
    let active = 0;
    for (const s of this.sessions) active += s.ai.size;
    if (active >= GLOBAL_AI_CONCURRENCY) return reject('rate_limited', 'server is busy');
    const win = this.aiWindow(device.id);
    const u = win.usage();
    const L = device.limits;
    if (L.aiPerMinute > 0 && u.minute >= L.aiPerMinute) return reject('rate_limited', `resets in ${Math.ceil(win.resetIn(60_000) / 1000)}s`);
    if (L.aiPerHour > 0 && u.hour >= L.aiPerHour) return reject('rate_limited', `resets in ${Math.ceil(win.resetIn(3600_000) / 60_000)} min`);
    if (L.aiPerDay > 0 && u.day >= L.aiPerDay) return reject('quota_exceeded', `resets in ${Math.ceil(win.resetIn(86_400_000) / 3600_000)} h`);
    win.record();
    device.aiRequests++;
    this.deps.devices.markDirty();

    const abort = new AbortController();
    const entry: AiEntry = { stream, abort };
    sess.ai.add(entry);
    const cleanup = () => {
      sess.ai.delete(entry);
      abort.abort();
    };
    stream.on('close', cleanup);
    try {
      const run = await this.deps.ai.run(device, req, abort.signal);
      // Re-check after the (possibly long) wait for the first byte.
      const g = this.gate(sess);
      if (stream.destroyed || 'code' in g || !g.device.ai || !this.switches.ai) {
        abort.abort();
        if (!stream.destroyed) reject('code' in g ? g.code : !this.switches.ai ? 'ai_gateway_disabled' : 'ai_not_permitted');
        return;
      }
      accept(run.meta);
      this.log('info', `AI request served by ${run.meta.model ?? 'router'}${run.meta.provider ? ` (${run.meta.provider})` : ''}.`, device.id);
      const reader = run.body.getReader();
      try {
        for (;;) {
          let idleTimer: NodeJS.Timeout | undefined;
          const idle = new Promise<never>((_, rej) => {
            idleTimer = setTimeout(() => rej(new RavenError('providers_unavailable', 'stalled')), 120_000);
          });
          let step: ReadableStreamReadResult<Uint8Array>;
          try {
            step = await Promise.race([reader.read(), idle]);
          } finally {
            clearTimeout(idleTimer);
          }
          const { done, value } = step;
          if (done) break;
          if (stream.destroyed) break;
          if (value && value.length) {
            sess.winDown += value.length;
            if (!stream.write(Buffer.from(value))) await new Promise<void>((r) => stream.once('drain', () => r()));
          }
        }
        if (!stream.destroyed) stream.end();
      } catch (e) {
        if (!stream.destroyed) stream.reset(e instanceof RavenError ? e.code : 'providers_unavailable');
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch (e) {
      if (abort.signal.aborted && !(e instanceof RavenError)) {
        if (!stream.destroyed) reject('internal', 'cancelled');
        return;
      }
      const code = e instanceof RavenError ? e.code : 'ai_backend_unreachable';
      const detail = e instanceof RavenError ? e.detail : undefined;
      this.deps.devices.update(device.id, { lastError: `AI: ${code}${detail ? ` (${detail})` : ''}` });
      this.log('warn', `AI request refused: ${code}${detail ? ` (${detail})` : ''}`, device.id);
      reject(code, detail);
    } finally {
      sess.ai.delete(entry);
    }
  }

  // ---------- periodic ----------
  private onTick(): void {
    let any = false;
    for (const s of this.sessions) {
      if (s.bpsUp !== s.winUp || s.bpsDown !== s.winDown) any = true;
      s.bpsUp = s.winUp;
      s.bpsDown = s.winDown;
      s.winUp = 0;
      s.winDown = 0;
    }
    if (this.cfg.autoApproveUntil && this.cfg.autoApproveUntil < Date.now()) {
      this.deps.config.update({ autoApproveUntil: 0 });
      this.log('security', 'Temporary LAN auto-approve ended.');
      any = true;
    }
    this.emit('tick', any);
  }

  // ---------- administration (called only by the local dashboard) ----------
  async setSwitches(patch: Partial<ServiceSwitches>): Promise<ServiceSwitches> {
    const before = { ...this.switches };
    const next = { ...before, ...patch };
    this.deps.config.update({ switches: next });
    const cancel = this.cfg.drainPolicy === 'cancel';
    const changed = (k: keyof ServiceSwitches) => before[k] !== next[k];
    for (const k of Object.keys(next) as (keyof ServiceSwitches)[]) {
      if (changed(k)) this.log(k === 'master' || k === 'remote' || k === 'pairing' ? 'security' : 'info', `Switch "${k}" turned ${next[k] ? 'ON' : 'OFF'}.`);
    }
    if (changed('internet') && !next.internet && cancel) {
      for (const s of this.sessions) for (const e of [...s.tcp]) e.stream.reset('internet_gateway_disabled');
    }
    if (changed('ai') && !next.ai && cancel) {
      for (const s of this.sessions) for (const e of [...s.ai]) e.stream.reset('ai_gateway_disabled');
    }
    if (changed('maintenance') && next.maintenance && cancel) {
      for (const s of this.sessions) s.mux.resetStreams('maintenance');
    }
    if (changed('lan') && !next.lan) {
      for (const s of [...this.sessions]) if (s.scope === 'lan') this.closeSession(s, 'access_scope_disabled');
    }
    if (changed('remote') && !next.remote) {
      for (const s of [...this.sessions]) if (s.scope === 'remote') this.closeSession(s, 'access_scope_disabled');
    }
    if (changed('master')) {
      if (next.master) await this.listen();
      else {
        this.pushStateAll();
        await new Promise((r) => setTimeout(r, 100));
        await this.unlisten('server_unreachable');
      }
    }
    this.pushStateAll();
    this.emit('change');
    return this.switches;
  }

  listDevices(): DeviceView[] {
    return this.deps.devices.list().map((d) => {
      const s = this.byDevice.get(d.id);
      return {
        ...d,
        online: !!s,
        activeStreams: s ? s.tcp.size : 0,
        activeAi: s ? s.ai.size : 0,
        bpsUp: s ? s.bpsUp : 0,
        bpsDown: s ? s.bpsDown : 0,
        aiUsage: this.aiWindow(d.id).usage(),
      };
    });
  }

  approveDevice(id: string): boolean {
    const d = this.deps.devices.get(id);
    if (!d || d.status !== 'pending') return false;
    this.deps.devices.setStatus(id, 'approved');
    this.log('security', `Device "${d.name}" approved.`, id);
    const s = this.byDevice.get(id);
    if (s) {
      s.authed = true;
      this.applyLimits(s, d);
      s.mux.sendCtrl({ t: 'welcome', state: this.clientState(s, d) });
    }
    this.emit('change');
    return true;
  }

  revokeDevice(id: string): boolean {
    const d = this.deps.devices.get(id);
    if (!d) return false;
    this.deps.devices.setStatus(id, 'revoked');
    this.log('security', `Device "${d.name}" revoked; its credential is permanently invalid.`, id);
    const s = this.byDevice.get(id);
    if (s) this.closeSession(s, 'device_revoked');
    this.emit('change');
    return true;
  }

  suspendDevice(id: string, suspended: boolean): boolean {
    const d = this.deps.devices.get(id);
    if (!d || d.status === 'revoked' || d.status === 'pending') return false;
    this.deps.devices.setStatus(id, suspended ? 'suspended' : 'approved');
    this.log('security', `Device "${d.name}" ${suspended ? 'suspended' : 're-enabled'}.`, id);
    const s = this.byDevice.get(id);
    if (s) {
      if (suspended) s.mux.resetStreams('device_suspended');
      this.pushState(s);
    }
    this.emit('change');
    return true;
  }

  updateDevice(id: string, patch: DevicePatch): boolean {
    const before = this.deps.devices.get(id);
    if (!before) return false;
    const hadInternet = before.internet;
    const hadAi = before.ai;
    const d = this.deps.devices.update(id, patch);
    if (!d) return false;
    const s = this.byDevice.get(id);
    if (s) {
      this.applyLimits(s, d);
      const cancel = this.cfg.drainPolicy === 'cancel';
      if (hadInternet && !d.internet && cancel) for (const e of [...s.tcp]) e.stream.reset('internet_not_permitted');
      if (hadAi && !d.ai && cancel) for (const e of [...s.ai]) e.stream.reset('ai_not_permitted');
      this.pushState(s);
    }
    if (patch.internet !== undefined || patch.ai !== undefined || patch.allowedModels !== undefined) {
      this.log('security', `Permissions changed for "${d.name}": internet ${d.internet ? 'on' : 'off'}, AI ${d.ai ? 'on' : 'off'}, models ${d.allowedModels ? d.allowedModels.length : 'all'}.`, id);
    }
    this.emit('change');
    return true;
  }

  disconnectDevice(id: string): boolean {
    const s = this.byDevice.get(id);
    if (!s) return false;
    this.log('info', 'Device disconnected by the owner.', id);
    this.closeSession(s, 'server_unreachable');
    return true;
  }

  removeDevice(id: string): boolean {
    const s = this.byDevice.get(id);
    if (s) this.closeSession(s, 'device_revoked');
    const ok = this.deps.devices.remove(id);
    if (ok) this.log('security', 'Device record removed.', id);
    this.emit('change');
    return ok;
  }

  removeExpiredDevices(): number {
    const n = this.deps.devices.removeExpired();
    if (n) this.log('info', `Removed ${n} expired device record(s).`);
    this.emit('change');
    return n;
  }

  disconnectAll(): number {
    const n = this.sessions.size;
    for (const s of [...this.sessions]) this.closeSession(s, 'server_unreachable');
    this.log('security', `Disconnect All: ${n} session(s) closed. Approved devices keep their identity.`);
    return n;
  }

  stats() {
    let streams = 0;
    let aiActive = 0;
    let bpsUp = 0;
    let bpsDown = 0;
    let online = 0;
    for (const s of this.sessions) {
      streams += s.tcp.size;
      aiActive += s.ai.size;
      bpsUp += s.bpsUp;
      bpsDown += s.bpsDown;
      if (s.authed) online++;
    }
    const devices = this.deps.devices.list();
    return {
      listening: this.listening,
      listenError: this.listenError,
      port: this.cfg.port,
      addresses: lanAddresses(),
      fingerprint: this.deps.tls.fingerprint,
      masterOnline: this.masterOnline,
      clients: online,
      pending: devices.filter((d) => d.status === 'pending').length,
      streams,
      aiActive,
      bpsUp,
      bpsDown,
      totalUp: devices.reduce((n, d) => n + d.totalUp, 0),
      totalDown: devices.reduce((n, d) => n + d.totalDown, 0),
      aiRequests: devices.reduce((n, d) => n + d.aiRequests, 0),
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }
}
