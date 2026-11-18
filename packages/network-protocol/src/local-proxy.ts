// Loopback HTTP proxy that Chromium is pointed at. It never decrypts HTTPS:
// CONNECT requests become opaque byte tunnels. Where the bytes go (master
// gateway tunnel, direct socket, or nowhere) is decided by the injected router.
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { ERR_TEXT, type ErrCode } from '@raven/shared';
import { randomToken, timingSafeEqualStr } from '@raven/security';

export interface ProxyRouter {
  /** Return a connected duplex to host:port or throw an error with a `.code` ErrCode. */
  connect(host: string, port: number): Promise<Duplex>;
}

const HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function errCode(e: unknown): ErrCode {
  const c = (e as any)?.code;
  return typeof c === 'string' && c in ERR_TEXT ? (c as ErrCode) : 'connect_failed';
}

function parseHostPort(target: string, defPort: number): { host: string; port: number } | null {
  let host = target;
  let port = defPort;
  if (target.startsWith('[')) {
    const end = target.indexOf(']');
    if (end < 0) return null;
    host = target.slice(1, end);
    const rest = target.slice(end + 1);
    if (rest.startsWith(':')) port = Number(rest.slice(1));
  } else {
    const i = target.lastIndexOf(':');
    if (i > 0) {
      host = target.slice(0, i);
      port = Number(target.slice(i + 1));
    }
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function errorPage(code: ErrCode): string {
  const msg = ERR_TEXT[code] ?? ERR_TEXT.connect_failed;
  return `<!doctype html><meta charset="utf-8"><title>Raven: cannot open page</title><meta name="raven-error" content="${code}"><body style="font-family:system-ui;background:#100C0B;color:#eee;padding:48px"><h1 style="color:#EB4604">Page not reachable</h1><p>${msg}</p><p style="opacity:.6">Code: ${code}</p></body>`;
}

export class LocalProxy {
  private server: http.Server;
  private sockets = new Set<net.Socket>();
  readonly username = 'raven';
  readonly password = randomToken(18);
  port = 0;
  /** last error code produced, for the browser's error page */
  lastError: { code: ErrCode; host: string; at: number } | null = null;

  constructor(private router: ProxyRouter) {
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server.on('connect', (req, socket, head) => void this.onConnect(req, socket as net.Socket, head));
    this.server.on('upgrade', (req, socket, head) => void this.onUpgrade(req, socket as net.Socket, head));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server.on('clientError', (_e, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  /** Drop every open proxied connection (used when the route changes). */
  dropAll(): void {
    for (const s of this.sockets) s.destroy();
  }

  close(): Promise<void> {
    this.dropAll();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const h = req.headers['proxy-authorization'];
    if (typeof h !== 'string' || !h.toLowerCase().startsWith('basic ')) return false;
    const got = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
    return timingSafeEqualStr(got, `${this.username}:${this.password}`);
  }

  private noteError(code: ErrCode, host: string): void {
    this.lastError = { code, host, at: Date.now() };
  }

  private async onConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    socket.on('error', () => {});
    if (!this.authorized(req)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="raven"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = parseHostPort(req.url ?? '', 443);
    if (!target) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    let upstream: Duplex;
    try {
      upstream = await this.router.connect(target.host, target.port);
    } catch (e) {
      const code = errCode(e);
      this.noteError(code, target.host);
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nX-Raven-Error: ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => {
      // A clean end is flushed by pipe(); only an abnormal close tears the socket down.
      if (!upstream.readableEnded) socket.destroy();
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="raven"', 'Content-Length': '0' });
      res.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new Error('unsupported');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Raven local proxy: absolute http:// URL required');
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let upstream: Duplex;
    try {
      upstream = await this.router.connect(host, port);
    } catch (e) {
      const code = errCode(e);
      this.noteError(code, host);
      const body = errorPage(code);
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'X-Raven-Error': code, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers['connection'] = 'close';
    const out = http.request({
      method: req.method,
      path: url.pathname + url.search,
      headers,
      // No agent on purpose: Node only honours createConnection when no agent is set.
      createConnection: () => upstream as any,
      setHost: false,
    });
    out.on('response', (up) => {
      const h: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined || HOP.has(k.toLowerCase())) continue;
        h[k] = v;
      }
      h['connection'] = 'close';
      res.writeHead(up.statusCode ?? 502, up.statusMessage, h);
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    out.on('error', () => {
      if (!res.headersSent) {
        const body = errorPage('connect_failed');
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'X-Raven-Error': 'connect_failed' });
        res.end(body);
      } else {
        res.destroy();
      }
      upstream.destroy();
    });
    res.on('close', () => {
      out.destroy();
      upstream.destroy();
    });
    req.pipe(out);
  }

  /** Plain ws:// upgrade: replay the request head and splice the sockets. */
  private async onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    socket.on('error', () => {});
    if (!this.authorized(req)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="raven"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let upstream: Duplex;
    try {
      upstream = await this.router.connect(host, port);
    } catch (e) {
      const code = errCode(e);
      this.noteError(code, host);
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nX-Raven-Error: ${code}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const lk = k.toLowerCase();
      if (lk === 'proxy-authorization' || lk === 'proxy-connection') continue;
      lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => {
      // A clean end is flushed by pipe(); only an abnormal close tears the socket down.
      if (!upstream.readableEnded) socket.destroy();
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
  }
}

/** Direct (no gateway) connection used for the optional direct-internet fallback. */
export function directConnect(host: string, port: number, timeoutMs = 15_000): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'connect_timeout' }));
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      s.setNoDelay(true);
      resolve(s);
    });
    s.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(err.message), { code: err.code === 'ENOTFOUND' ? 'dns_failure' : 'connect_failed' }));
    });
  });
}
