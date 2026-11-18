// Test harness: a real GatewayServer on a real TLS port, real GatewayClient +
// LocalProxy, a local origin server, and a stand-in FreeLLMAPI HTTP server that
// speaks the documented /v1/models and /v1/chat/completions wire format.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { deviceIdFromPublicKey, generateDeviceKeyPair } from '@raven/security';
import { GatewayClient, LocalProxy, type Endpoint, type Identity } from '@raven/network-protocol';
import {
  AiService,
  ConfigStore,
  DeviceRegistry,
  GatewayServer,
  MemorySecretStore,
  loadOrCreateTls,
  type TlsMaterial,
} from '../apps/master-server/src/core';

export function tmpDir(prefix = 'raven-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ---------- stand-in FreeLLMAPI ----------
export class MockLlm {
  server: http.Server;
  port = 0;
  key = 'unified-key-1';
  models = [
    { id: 'm1', owned_by: 'provA', available: true },
    { id: 'm2', owned_by: 'provB', available: true },
    { id: 'm3', owned_by: 'provC', available: true },
  ];
  /** model id -> HTTP status to fail with */
  fail = new Map<string, number>();
  /** model id -> model id actually served (simulates a router that breaks pinning) */
  serveAs = new Map<string, string>();
  autoPick = 'm2';
  chunkDelayMs = 0;
  chunks = ['Hello', ' from', ' the', ' model'];
  requests: { model: string; auth: string; maxTokens?: number }[] = [];
  down = false;

  constructor() {
    this.server = http.createServer((req, res) => {
      if (this.down) {
        req.socket.destroy();
        return;
      }
      const auth = String(req.headers.authorization ?? '');
      if (auth !== `Bearer ${this.key}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'auto', owned_by: 'freellmapi', available: true },
              { id: 'fusion', owned_by: 'freellmapi', available: true },
              ...this.models.map((m) => ({ ...m, object: 'model', execution_status: m.available ? 'ready' : 'needsKey', supported_parameters: ['temperature'] })),
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          const json = JSON.parse(body);
          const model: string = json.model ?? 'auto';
          this.requests.push({ model, auth, maxTokens: json.max_tokens });
          const status = this.fail.get(model);
          if (status) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: status === 429 ? 'Rate limit exceeded' : 'upstream failure' } }));
            return;
          }
          const served = this.serveAs.get(model) ?? (model === 'auto' ? this.autoPick : model);
          const prov = this.models.find((m) => m.id === served)?.owned_by ?? 'prov';
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Routed-Via': `${prov}/${served}` });
          let closed = false;
          res.on('close', () => (closed = true));
          for (const c of this.chunks) {
            if (closed) return;
            res.write(`data: ${JSON.stringify({ model: served, choices: [{ delta: { content: c } }] })}\n\n`);
            if (this.chunkDelayMs) await sleep(this.chunkDelayMs);
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => {
      this.server.closeAllConnections?.();
      this.server.close(() => r());
    });
  }
}

// ---------- local origin ----------
export class Origin {
  server: http.Server;
  port = 0;
  uploads: { bytes: number; sha: string }[] = [];
  sockets = new Set<net.Socket>();
  constructor() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/hello') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'sid=abc; Path=/' });
        res.end(`hello ${req.headers.cookie ?? 'nocookie'}`);
      } else if (url.pathname === '/redirect') {
        res.writeHead(302, { Location: '/hello' });
        res.end();
      } else if (url.pathname === '/big') {
        const size = Number(url.searchParams.get('size') ?? 1024 * 1024);
        const range = req.headers.range;
        let start = 0;
        let end = size - 1;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          if (m) {
            start = Number(m[1]);
            if (m[2]) end = Number(m[2]);
          }
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
        } else {
          res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        }
        // Deterministic content: byte i = i % 251
        let pos = start;
        const write = () => {
          while (pos <= end) {
            const n = Math.min(64 * 1024, end - pos + 1);
            const buf = Buffer.allocUnsafe(n);
            for (let i = 0; i < n; i++) buf[i] = (pos + i) % 251;
            pos += n;
            if (!res.write(buf)) {
              res.once('drain', write);
              return;
            }
          }
          res.end();
        };
        write();
      } else if (url.pathname === '/upload' && req.method === 'POST') {
        const h = crypto.createHash('sha256');
        let bytes = 0;
        req.on('data', (c: Buffer) => {
          h.update(c);
          bytes += c.length;
        });
        req.on('end', () => {
          const sha = h.digest('hex');
          this.uploads.push({ bytes, sha });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bytes, sha }));
        });
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    // WebSocket-style echo on upgrade (raw echo after a 101).
    this.server.on('upgrade', (req, socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on('data', (d) => socket.write(d));
      socket.on('end', () => socket.end());
      socket.on('error', () => {});
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }
  /** Connections the gateway still holds open to this origin. */
  get openConnections(): number {
    return this.sockets.size;
  }
  stop(): Promise<void> {
    return new Promise((r) => {
      for (const s of this.sockets) s.destroy();
      this.server.close(() => r());
    });
  }
}

export function expectedBigSha(size: number, start = 0): string {
  const h = crypto.createHash('sha256');
  let pos = start;
  while (pos < size) {
    const n = Math.min(64 * 1024, size - pos);
    const buf = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) buf[i] = (pos + i) % 251;
    h.update(buf);
    pos += n;
  }
  return h.digest('hex');
}

// ---------- master harness ----------
export interface Harness {
  dir: string;
  port: number;
  config: ConfigStore;
  devices: DeviceRegistry;
  ai: AiService;
  gateway: GatewayServer;
  tls: TlsMaterial;
  llm: MockLlm;
  secrets: MemorySecretStore;
  backend: { baseUrl: string; apiKey: string } | null;
  stop(keepLlm?: boolean): Promise<void>;
  restart(): Promise<Harness>;
}

export async function startMaster(opts: { dir?: string; llm?: MockLlm; secrets?: MemorySecretStore; port?: number; online?: boolean } = {}): Promise<Harness> {
  const dir = opts.dir ?? tmpDir();
  const secrets = opts.secrets ?? new MemorySecretStore();
  const llm = opts.llm ?? new MockLlm();
  if (!llm.port) await llm.start();
  const config = new ConfigStore(dir);
  const port = opts.port ?? (await freePort());
  config.update({ port });
  const devices = new DeviceRegistry(dir);
  const tls = await loadOrCreateTls(dir, secrets);
  const h: Partial<Harness> = { dir, port, config, devices, tls, llm, secrets };
  h.backend = { baseUrl: llm.baseUrl, apiKey: llm.key };
  const ai = new AiService({ endpoint: () => h.backend ?? null }, () => config.value);
  await ai.refresh();
  const gateway = new GatewayServer({
    dataDir: dir,
    config,
    devices,
    ai,
    tls,
    version: 'test',
    internetProbe: async () => opts.online ?? true,
  });
  await gateway.start();
  h.ai = ai;
  h.gateway = gateway;
  h.stop = async (keepLlm = false) => {
    await gateway.stop();
    ai.stop();
    if (!keepLlm) await llm.stop();
  };
  h.restart = async () => {
    await h.stop!(true);
    return startMaster({ dir, llm, secrets, port });
  };
  return h as Harness;
}

export function newIdentity(): Identity {
  const kp = generateDeviceKeyPair();
  return { deviceId: deviceIdFromPublicKey(kp.publicKey), publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function endpointFor(h: Harness, pin: string | null = h.tls.fingerprint): Endpoint {
  return { host: '127.0.0.1', port: h.port, tls: 'pin', pin };
}

/** Pair + approve a fresh device and return its connected client. */
export async function pairedClient(h: Harness, name = 'Test PC'): Promise<{ client: GatewayClient; id: Identity }> {
  const id = newIdentity();
  const client = new GatewayClient(id, { name, appVersion: 'test' });
  const res = await client.connect(endpointFor(h, null));
  if (res.phase !== 'pending') throw new Error(`expected pending, got ${res.phase}`);
  const approved = new Promise<void>((r) => client.once('approved', () => r()));
  if (!h.gateway.approveDevice(id.deviceId)) throw new Error('approve failed');
  await approved;
  return { client, id };
}

/** LocalProxy routed through a gateway client. */
export async function proxyThrough(client: GatewayClient): Promise<LocalProxy> {
  const proxy = new LocalProxy({ connect: (host, port) => client.openTcp(host, port) });
  await proxy.listen();
  return proxy;
}

export function proxyAuth(proxy: LocalProxy): string {
  return 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
}

/** Plain-HTTP request through the local proxy (absolute-URI form). */
export function proxyGet(
  proxy: LocalProxy,
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: Buffer; auth?: boolean } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        method: opts.method ?? 'GET',
        path: url,
        headers: {
          Host: new URL(url).host,
          ...(opts.auth === false ? {} : { 'Proxy-Authorization': proxyAuth(proxy) }),
          ...(opts.headers ?? {}),
          ...(opts.body ? { 'Content-Length': String(opts.body.length) } : {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** CONNECT through the local proxy; resolves with the raw tunnel socket or the failure status. */
export function proxyConnect(proxy: LocalProxy, target: string, auth = true): Promise<{ status: number; socket: net.Socket; error?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      headers: auth ? { 'Proxy-Authorization': proxyAuth(proxy) } : {},
      agent: false,
    });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode ?? 0, socket, error: String(res.headers['x-raven-error'] ?? '') }));
    req.on('response', (res) => resolve({ status: res.statusCode ?? 0, socket: res.socket, error: String(res.headers['x-raven-error'] ?? '') }));
    req.on('error', reject);
    req.end();
  });
}

/** Collect an AI stream into text (parses the SSE the server relays). */
export async function collectAi(stream: Duplex): Promise<string> {
  let raw = '';
  for await (const c of stream) raw += c.toString('utf8');
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try {
      text += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '';
    } catch {
      /* ignore */
    }
  }
  return text;
}

export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return String((e as any)?.code ?? (e as Error).message);
  }
}
