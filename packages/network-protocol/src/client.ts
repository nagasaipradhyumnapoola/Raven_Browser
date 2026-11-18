// Browser-side gateway client: one authenticated, encrypted WebSocket to the
// master server carrying the stream multiplexer.
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { PRODUCT, type AiMeta, type AiRequest, type ClientState, type ErrCode } from '@raven/shared';
import { authTranscript, signTranscript } from '@raven/security';
import { MuxSession, StreamError, type MuxStream } from './mux';

export interface Identity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

export interface Endpoint {
  host: string;
  port: number;
  /** 'pin' = self-signed certificate pinned by fingerprint (LAN / direct). 'ca' = publicly trusted certificate (tunnel / reverse proxy). */
  tls: 'pin' | 'ca';
  /** sha256 fingerprint (lowercase hex) of the server certificate, once known */
  pin: string | null;
}

export type ClientPhase = 'idle' | 'connecting' | 'pending' | 'online' | 'closed';

export interface ConnectResult {
  phase: 'online' | 'pending';
  pin: string | null;
  pairingCode?: string;
  state?: ClientState;
}

function normFp(fp: string): string {
  return fp.replace(/:/g, '').toLowerCase();
}

/**
 * Events: 'state' (ClientState), 'pending' (pairingCode), 'approved', 'denied' (ErrCode),
 * 'close' ({ code, wasOnline }).
 */
export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private mux: MuxSession | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private rpcSeq = 1;
  private rpcWait = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  phase: ClientPhase = 'idle';
  state: ClientState | null = null;
  endpoint: Endpoint | null = null;
  lastDenied: ErrCode | null = null;

  constructor(
    private identity: Identity,
    private info: { name: string; appVersion: string },
  ) {
    super();
  }

  setIdentity(identity: Identity): void {
    this.identity = identity;
  }

  get online(): boolean {
    return this.phase === 'online' && !!this.mux && !this.mux.isClosed;
  }

  /** Connect and authenticate. Resolves when the server answered (welcome or pending). */
  connect(endpoint: Endpoint, timeoutMs = 10_000): Promise<ConnectResult> {
    this.disconnect('reconnect');
    this.endpoint = endpoint;
    this.phase = 'connecting';
    this.lastDenied = null;
    return new Promise<ConnectResult>((resolve, reject) => {
      let settled = false;
      let seenPin: string | null = endpoint.pin;
      const fail = (code: ErrCode, detail?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new StreamError(code, detail));
      };
      const host = endpoint.host.includes(':') && !endpoint.host.startsWith('[') ? `[${endpoint.host}]` : endpoint.host;
      const url = `wss://${host}:${endpoint.port}/raven/v${PRODUCT.protocolVersion}`;
      const ws = new WebSocket(url, {
        handshakeTimeout: timeoutMs,
        maxPayload: 2 * 1024 * 1024,
        perMessageDeflate: false,
        // In 'pin' mode the certificate is self-signed: chain validation is
        // replaced by an exact fingerprint comparison below, before any
        // authenticated data is exchanged. 'ca' mode uses normal validation.
        rejectUnauthorized: endpoint.tls === 'ca',
        ...(endpoint.tls === 'pin' ? { checkServerIdentity: () => undefined } : {}),
      } as any);
      this.ws = ws;
      const timer = setTimeout(() => {
        fail('server_unreachable', 'timeout');
        ws.terminate();
      }, timeoutMs + 2000);

      const mux = new MuxSession(
        {
          send: (data, cb) => ws.send(data, { binary: true }, cb),
          close: () => ws.close(),
        },
        'client',
      );

      ws.on('open', () => {
        if (endpoint.tls === 'pin') {
          const sock: any = (ws as any)._socket;
          const cert = sock?.getPeerCertificate?.();
          const fp = cert?.fingerprint256 ? normFp(cert.fingerprint256) : null;
          if (!fp) {
            fail('server_unreachable', 'no certificate');
            ws.terminate();
            return;
          }
          if (endpoint.pin && fp !== normFp(endpoint.pin)) {
            fail('server_unreachable', 'certificate mismatch');
            this.emit('pin-mismatch', fp);
            ws.terminate();
            return;
          }
          seenPin = fp;
        }
        this.mux = mux;
      });

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return;
        mux.handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
      });

      mux.on('ctrl', (msg: any) => {
        switch (msg.t) {
          case 'challenge': {
            const channel = endpoint.tls === 'pin' ? `pin:${seenPin}` : `ca:${endpoint.host.toLowerCase()}`;
            const sig = signTranscript(this.identity.privateKey, authTranscript(String(msg.nonce), this.identity.deviceId, channel));
            mux.sendCtrl({
              t: 'auth',
              v: PRODUCT.protocolVersion,
              deviceId: this.identity.deviceId,
              publicKey: this.identity.publicKey,
              name: this.info.name,
              appVersion: this.info.appVersion,
              channel,
              sig,
            });
            break;
          }
          case 'welcome': {
            const wasPending = this.phase === 'pending';
            this.phase = 'online';
            this.state = msg.state as ClientState;
            this.startPing();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ phase: 'online', pin: seenPin, state: this.state });
            }
            if (wasPending) this.emit('approved');
            this.emit('state', this.state);
            break;
          }
          case 'pending': {
            this.phase = 'pending';
            this.startPing();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ phase: 'pending', pin: seenPin, pairingCode: String(msg.code ?? '') });
            }
            this.emit('pending', String(msg.code ?? ''));
            break;
          }
          case 'denied': {
            this.lastDenied = (msg.code as ErrCode) ?? 'device_unauthorized';
            fail(this.lastDenied);
            this.emit('denied', this.lastDenied);
            break;
          }
          case 'state': {
            this.state = msg.state as ClientState;
            this.emit('state', this.state);
            break;
          }
          case 'bye': {
            this.lastDenied = (msg.code as ErrCode) ?? null;
            if (this.lastDenied) this.emit('denied', this.lastDenied);
            break;
          }
          case 'event': {
            this.emit('event', msg.ev);
            break;
          }
          case 'rpc_result': {
            const w = this.rpcWait.get(msg.id);
            if (!w) break;
            this.rpcWait.delete(msg.id);
            clearTimeout(w.timer);
            if (msg.ok) w.resolve(msg.result);
            else w.reject(new StreamError((msg.code as ErrCode) ?? 'internal', msg.detail));
            break;
          }
          default:
            break;
        }
      });

      const onGone = (detail: string) => {
        const wasOnline = this.phase === 'online' || this.phase === 'pending';
        fail('server_unreachable', detail);
        if (this.ws === ws) {
          this.stopPing();
          this.phase = 'closed';
          this.mux = null;
          this.ws = null;
          mux.close(detail);
          for (const w of this.rpcWait.values()) {
            clearTimeout(w.timer);
            w.reject(new StreamError('server_unreachable'));
          }
          this.rpcWait.clear();
          this.emit('close', { code: this.lastDenied, wasOnline });
        } else {
          mux.close(detail);
        }
      };
      ws.on('error', (err: Error) => onGone(err.message));
      ws.on('close', () => onGone('closed'));
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const mux = this.mux;
      if (!mux) return;
      if (Date.now() - mux.lastActivity > 50_000) {
        this.ws?.terminate();
        return;
      }
      mux.sendCtrl({ t: 'ping' });
    }, 15_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  disconnect(_reason = 'client'): void {
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    if (this.mux) this.mux.close('client disconnect');
    this.mux = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    if (this.phase !== 'idle') this.phase = 'closed';
  }

  /** Open a TCP tunnel to host:port through the master gateway. */
  async openTcp(host: string, port: number): Promise<Duplex> {
    if (!this.online || !this.mux) throw new StreamError('server_unreachable');
    const { stream } = await this.mux.open({ kind: 'tcp', host, port }, 25_000);
    return stream;
  }

  /** Start an AI generation. The stream yields raw SSE bytes from the server. */
  async openAi(req: AiRequest): Promise<{ stream: MuxStream; meta: AiMeta }> {
    if (!this.online || !this.mux) throw new StreamError('server_unreachable');
    const { stream, meta } = await this.mux.open({ kind: 'ai', req }, 90_000);
    return { stream, meta: meta as AiMeta };
  }

  rpc<T = any>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.online || !this.mux) return reject(new StreamError('server_unreachable'));
      const id = this.rpcSeq++;
      const timer = setTimeout(() => {
        this.rpcWait.delete(id);
        reject(new StreamError('server_unreachable', 'rpc timeout'));
      }, timeoutMs);
      this.rpcWait.set(id, { resolve, reject, timer });
      this.mux.sendCtrl({ t: 'rpc', id, method, params });
    });
  }
}
