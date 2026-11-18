// Stream multiplexer carried over one WebSocket (binary frames).
//
// Frame: [type u8][streamId u32 BE][payload...]
// One WebSocket carries many independent byte streams (one per proxied TCP
// connection or AI generation) plus a JSON control channel. Each stream has
// credit-based flow control so a slow receiver stalls only its own stream and
// nothing is buffered without bound on either side.
import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ErrCode } from '@raven/shared';

export const enum Frame {
  CTRL = 0,
  OPEN = 1,
  OPEN_OK = 2,
  OPEN_ERR = 3,
  DATA = 4,
  END = 5,
  RESET = 6,
  WINDOW = 7,
}

export const INITIAL_WINDOW = 512 * 1024;
export const MAX_DATA_FRAME = 32 * 1024;
export const MAX_FRAME = 1024 * 1024;

export interface Transport {
  send(data: Buffer, cb: (err?: Error | null) => void): void;
  close(): void;
}

export type OpenRequest =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'ai'; req: unknown };

function frame(type: number, id: number, payload?: Buffer): Buffer {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(5 + len);
  buf[0] = type;
  buf.writeUInt32BE(id >>> 0, 1);
  if (payload && len) payload.copy(buf, 5);
  return buf;
}

function jsonFrame(type: number, id: number, obj: unknown): Buffer {
  return frame(type, id, Buffer.from(JSON.stringify(obj ?? {}), 'utf8'));
}

function parseJson(buf: Buffer): any {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

export class StreamError extends Error {
  code: ErrCode;
  constructor(code: ErrCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

export class MuxStream extends Duplex {
  readonly id: number;
  private session: MuxSession;
  private sendWindow = INITIAL_WINDOW;
  private recvUnacked = 0;
  private pendingWrite: { chunk: Buffer; cb: (err?: Error | null) => void } | null = null;
  private localEnded = false;
  private remoteEnded = false;
  private closedBySession = false;
  bytesIn = 0;
  bytesOut = 0;

  constructor(session: MuxSession, id: number) {
    super({ allowHalfOpen: true, highWaterMark: 256 * 1024 });
    this.session = session;
    this.id = id;
    // A reset stream must never crash the process when nobody is listening.
    this.on('error', () => {});
  }

  // Socket-shaped no-ops so Node's http client can use a tunnel stream as its connection.
  setTimeout(_ms?: number, _cb?: () => void): this {
    return this;
  }
  setNoDelay(_v?: boolean): this {
    return this;
  }
  setKeepAlive(_v?: boolean, _d?: number): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  // ---- outbound ----
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.pump(chunk, cb);
  }

  private pump(chunk: Buffer, cb: (err?: Error | null) => void): void {
    if (this.destroyed) return cb(new Error('stream closed'));
    if (chunk.length === 0) return cb();
    if (this.sendWindow <= 0) {
      this.pendingWrite = { chunk, cb };
      return;
    }
    const n = Math.min(chunk.length, MAX_DATA_FRAME, this.sendWindow);
    const part = chunk.subarray(0, n);
    this.sendWindow -= n;
    this.bytesOut += n;
    this.session.sendRaw(frame(Frame.DATA, this.id, part), (err) => {
      if (err) return cb(err);
      const rest = chunk.subarray(n);
      if (rest.length === 0) return cb();
      this.pump(rest, cb);
    });
  }

  _final(cb: (err?: Error | null) => void): void {
    this.localEnded = true;
    this.session.sendRaw(frame(Frame.END, this.id), () => {
      this.maybeFinish();
      cb();
    });
  }

  // ---- inbound ----
  _read(): void {
    if (this.recvUnacked >= INITIAL_WINDOW / 4) this.grant();
  }

  private grant(): void {
    if (this.recvUnacked <= 0 || this.destroyed) return;
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(this.recvUnacked, 0);
    this.recvUnacked = 0;
    this.session.sendRaw(frame(Frame.WINDOW, this.id, b), () => {});
  }

  /** @internal */
  onData(payload: Buffer): void {
    if (this.destroyed || this.remoteEnded) return;
    this.bytesIn += payload.length;
    this.recvUnacked += payload.length;
    if (this.recvUnacked > INITIAL_WINDOW * 2) {
      // Peer ignored flow control.
      this.reset('bad_request');
      return;
    }
    const more = this.push(payload);
    if (more && this.recvUnacked >= INITIAL_WINDOW / 4) this.grant();
  }

  /** @internal */
  onWindow(credit: number): void {
    this.sendWindow += credit;
    if (this.pendingWrite && this.sendWindow > 0) {
      const { chunk, cb } = this.pendingWrite;
      this.pendingWrite = null;
      this.pump(chunk, cb);
    }
  }

  /** @internal */
  onEnd(): void {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.push(null);
    this.maybeFinish();
  }

  /** @internal */
  onReset(code: ErrCode, detail?: string): void {
    this.closedBySession = true;
    // The peer already finished sending: this reset only means "I am done with
    // your half too". Deliver what is still buffered before closing.
    if (this.remoteEnded) {
      if (this.readableEnded) this.destroy();
      else {
        this.once('end', () => this.destroy());
        this.resume === undefined ? undefined : void 0;
      }
      const pending = this.pendingWrite;
      this.pendingWrite = null;
      if (pending) pending.cb(new StreamError(code, detail));
      return;
    }
    this.destroy(new StreamError(code, detail));
  }

  /** @internal */
  onSessionClosed(): void {
    this.closedBySession = true;
    this.destroy(new StreamError('server_unreachable'));
  }

  private maybeFinish(): void {
    if (this.localEnded && this.remoteEnded) this.session.forget(this.id);
  }

  /** Abort the stream and tell the peer why. */
  reset(code: ErrCode = 'internal', detail?: string): void {
    if (this.destroyed) return;
    this.session.sendRaw(jsonFrame(Frame.RESET, this.id, { code, detail }), () => {});
    this.closedBySession = true;
    this.destroy(new StreamError(code, detail));
  }

  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    const pending = this.pendingWrite;
    this.pendingWrite = null;
    if (pending) pending.cb(err ?? new Error('stream closed'));
    if (!this.closedBySession && !(this.localEnded && this.remoteEnded)) {
      this.session.sendRaw(jsonFrame(Frame.RESET, this.id, { code: 'internal' }), () => {});
    }
    this.session.forget(this.id);
    cb(err);
  }
}

export interface OpenHandler {
  (stream: MuxStream, req: OpenRequest, accept: (meta?: unknown) => void, reject: (code: ErrCode, detail?: string) => void): void;
}

export class MuxSession extends EventEmitter {
  private streams = new Map<number, MuxStream>();
  private opening = new Map<number, { resolve: (v: { stream: MuxStream; meta: any }) => void; reject: (e: Error) => void; stream: MuxStream; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private closed = false;
  onOpen: OpenHandler | null = null;
  lastActivity = Date.now();

  constructor(
    private transport: Transport,
    private role: 'client' | 'server',
    private maxStreams = 512,
  ) {
    super();
  }

  get streamCount(): number {
    return this.streams.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** @internal */
  sendRaw(buf: Buffer, cb: (err?: Error | null) => void): void {
    if (this.closed) return cb(new Error('session closed'));
    try {
      this.transport.send(buf, cb);
    } catch (e) {
      cb(e as Error);
    }
  }

  sendCtrl(obj: unknown): void {
    this.sendRaw(jsonFrame(Frame.CTRL, 0, obj), () => {});
  }

  /** @internal */
  forget(id: number): void {
    this.streams.delete(id);
  }

  /** Client side: open a stream; resolves once the server accepted it. */
  open(req: OpenRequest, timeoutMs = 30_000): Promise<{ stream: MuxStream; meta: any }> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new StreamError('server_unreachable'));
      if (this.streams.size >= this.maxStreams) return reject(new StreamError('too_many_connections'));
      const id = this.nextId;
      this.nextId += 2;
      const stream = new MuxStream(this, id);
      this.streams.set(id, stream);
      const timer = setTimeout(() => {
        if (this.opening.delete(id)) {
          stream.reset('connect_timeout');
          reject(new StreamError('connect_timeout'));
        }
      }, timeoutMs);
      this.opening.set(id, { resolve, reject, stream, timer });
      this.sendRaw(jsonFrame(Frame.OPEN, id, req), (err) => {
        if (err && this.opening.delete(id)) {
          clearTimeout(timer);
          stream.onSessionClosed();
          reject(new StreamError('server_unreachable'));
        }
      });
    });
  }

  /** Feed one received WebSocket message into the session. */
  handleMessage(buf: Buffer): void {
    if (this.closed) return;
    this.lastActivity = Date.now();
    if (buf.length < 5 || buf.length > MAX_FRAME) {
      this.close('bad frame');
      return;
    }
    const type = buf[0];
    const id = buf.readUInt32BE(1);
    const payload = buf.subarray(5);
    switch (type) {
      case Frame.CTRL: {
        const msg = parseJson(payload);
        if (msg && typeof msg === 'object') this.emit('ctrl', msg);
        return;
      }
      case Frame.OPEN: {
        if (this.role !== 'server') return;
        const req = parseJson(payload);
        if (!req || this.streams.has(id) || id === 0) {
          this.sendRaw(jsonFrame(Frame.OPEN_ERR, id, { code: 'bad_request' }), () => {});
          return;
        }
        if (this.streams.size >= this.maxStreams) {
          this.sendRaw(jsonFrame(Frame.OPEN_ERR, id, { code: 'too_many_connections' }), () => {});
          return;
        }
        const stream = new MuxStream(this, id);
        this.streams.set(id, stream);
        let settled = false;
        const accept = (meta?: unknown) => {
          if (settled || stream.destroyed) return;
          settled = true;
          this.sendRaw(jsonFrame(Frame.OPEN_OK, id, meta ?? {}), () => {});
        };
        const reject = (code: ErrCode, detail?: string) => {
          if (settled) return;
          settled = true;
          this.sendRaw(jsonFrame(Frame.OPEN_ERR, id, { code, detail }), () => {});
          stream.onReset(code, detail);
        };
        if (this.onOpen) this.onOpen(stream, req as OpenRequest, accept, reject);
        else reject('internal');
        return;
      }
      case Frame.OPEN_OK: {
        const p = this.opening.get(id);
        if (!p) return;
        this.opening.delete(id);
        clearTimeout(p.timer);
        p.resolve({ stream: p.stream, meta: parseJson(payload) ?? {} });
        return;
      }
      case Frame.OPEN_ERR: {
        const p = this.opening.get(id);
        if (!p) return;
        this.opening.delete(id);
        clearTimeout(p.timer);
        const info = parseJson(payload) ?? {};
        p.stream.onReset(info.code ?? 'internal', info.detail);
        p.reject(new StreamError(info.code ?? 'internal', info.detail));
        return;
      }
      case Frame.DATA:
        this.streams.get(id)?.onData(payload);
        return;
      case Frame.END:
        this.streams.get(id)?.onEnd();
        return;
      case Frame.RESET: {
        const info = parseJson(payload) ?? {};
        const p = this.opening.get(id);
        if (p) {
          this.opening.delete(id);
          clearTimeout(p.timer);
          p.reject(new StreamError(info.code ?? 'internal', info.detail));
        }
        this.streams.get(id)?.onReset(info.code ?? 'internal', info.detail);
        return;
      }
      case Frame.WINDOW: {
        if (payload.length !== 4) return;
        this.streams.get(id)?.onWindow(payload.readUInt32BE(0));
        return;
      }
      default:
        return;
    }
  }

  /** Reset every stream (optionally only those matching a filter). */
  resetStreams(code: ErrCode, filter?: (s: MuxStream) => boolean): void {
    for (const s of [...this.streams.values()]) {
      if (!filter || filter(s)) s.reset(code);
    }
  }

  /** Tear the session down; every stream errors with server_unreachable. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.opening.values()) {
      clearTimeout(p.timer);
      p.reject(new StreamError('server_unreachable'));
    }
    this.opening.clear();
    for (const s of [...this.streams.values()]) s.onSessionClosed();
    this.streams.clear();
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
    this.emit('close', reason ?? 'closed');
  }
}
