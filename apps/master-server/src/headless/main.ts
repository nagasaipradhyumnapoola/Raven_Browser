// Raven Master Server, headless edition: the same master core as the desktop app, without a window.
// Runs anywhere Node.js 18+ runs: inside the Raven Master Android app, Termux, a Linux box, a Raspberry Pi.
//
//   node raven-master.cjs [--data <folder>] [--dashboard-port 47812]
//
// The dashboard is served on this device only (127.0.0.1) and needs the one-time token printed at start
// (the Android app opens it for you). Tasks and remote tabs need a desktop master (they use a hidden browser);
// everything else works: gateway, pairing, AI providers, assistant router, search, remote access, limits.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isPlainObject } from '@raven/shared';
import { atomicWriteSync, readJsonSync } from '../../../../packages/local-memory/src/fsutil';
import { MasterCore, setLanAddresses, type SecretStore } from '../core';

// Node 18 (Android) has WebCrypto only under node:crypto.
if (!(globalThis as any).crypto) (globalThis as any).crypto = crypto.webcrypto;

const VERSION = process.env.RAVEN_VERSION ?? '0.0.0';
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dataDir = path.resolve(arg('--data') ?? process.env.RAVEN_DATA ?? path.join(process.cwd(), 'MasterServerData'));
const dashPort = Number(arg('--dashboard-port') ?? process.env.RAVEN_DASH_PORT ?? 47812);
const rendererDir = path.join(__dirname, 'renderer');

/**
 * Secrets encrypted with AES-256-GCM. The key comes from RAVEN_SECRET_KEY (the Android app keeps it in the
 * Android Keystore) or from secret.key in the data folder, which only this app's user can read.
 */
class FileSecretStore implements SecretStore {
  private data: Record<string, string>;
  private key: Buffer;
  constructor(private file: string) {
    const env = process.env.RAVEN_SECRET_KEY;
    if (env && /^[0-9a-f]{64}$/i.test(env)) this.key = Buffer.from(env, 'hex');
    else {
      const kf = path.join(path.dirname(file), 'secret.key');
      if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
      this.key = Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'hex');
    }
    this.data = readJsonSync<Record<string, string>>(file, {});
    if (!isPlainObject(this.data)) this.data = {};
  }
  get(name: string): string | null {
    const v = this.data[name];
    if (typeof v !== 'string' || !v.startsWith('aes:')) return null;
    try {
      const b = Buffer.from(v.slice(4), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
  set(name: string, value: string | null): void {
    if (value === null) delete this.data[name];
    else {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
      const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      this.data[name] = 'aes:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    }
    atomicWriteSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.jpg': 'image/jpeg' };

async function main(): Promise<void> {
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const secrets = new FileSecretStore(path.join(dataDir, 'secrets.json'));
  let stopping = false;
  const core = new MasterCore({
    version: VERSION,
    dataDir,
    secrets,
    quit: () => void stop(),
    // The Android app reads this flag at phone start-up (BootReceiver).
    setAutoStart: (on) => fs.writeFileSync(path.join(dataDir, 'autostart'), on ? '1' : '0'),
  });
  await core.init();
  await core.start();
  fs.writeFileSync(path.join(dataDir, 'autostart'), core.config.value.autoStart ? '1' : '0');
  // Android may hide network interfaces from Node; the app keeps lan-ips.txt current instead.
  const lanFile = path.join(dataDir, 'lan-ips.txt');
  let lanSeen = '';
  const lanTimer = setInterval(() => {
    try {
      const v = fs.existsSync(lanFile) ? fs.readFileSync(lanFile, 'utf8').trim() : '';
      if (v === lanSeen) return;
      lanSeen = v;
      setLanAddresses(v ? v.split(',').filter(Boolean) : null);
      core.gateway.pushStateAll();
      core.changed();
    } catch {
      /* try again */
    }
  }, 5000);
  lanTimer.unref();

  // ---------------- dashboard on this device only ----------------
  const token = process.env.RAVEN_DASH_TOKEN && /^[A-Za-z0-9_-]{16,}$/.test(process.env.RAVEN_DASH_TOKEN) ? process.env.RAVEN_DASH_TOKEN : crypto.randomBytes(24).toString('base64url');
  const authed = (req: http.IncomingMessage, q: URLSearchParams) => {
    const h = req.headers.authorization ?? '';
    const given = h.startsWith('Bearer ') ? h.slice(7) : q.get('t') ?? '';
    return given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };
  const listeners = new Set<http.ServerResponse>();
  let lastSent = 0;
  const broadcast = (force = false) => {
    if (!listeners.size) return;
    const now = Date.now();
    if (!force && now - lastSent < 900) return;
    lastSent = now;
    const msg = `data: ${JSON.stringify(core.snapshot())}\n\n`;
    for (const r of listeners) r.write(msg);
  };
  core.on('state', () => broadcast(true));
  core.on('tick', () => broadcast());
  core.on('pairing-request', (d: { name: string; pairingCode: string }) => console.log(`[pairing] "${d.name}" wants to connect, code ${d.pairingCode}. Approve it on the dashboard.`));

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    // Only pages opened on this device by name 127.0.0.1/localhost (blocks DNS-rebinding tricks).
    const hostOk = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.host ?? '');
    if (!hostOk) return void res.writeHead(403).end();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (u.pathname === '/api/invoke' && req.method === 'POST') {
      if (!authed(req, u.searchParams)) return void res.writeHead(401).end();
      let body = '';
      for await (const c of req) {
        body += c;
        if (body.length > 1_000_000) return void res.writeHead(413).end();
      }
      let j: any;
      try {
        j = JSON.parse(body);
      } catch {
        return void res.writeHead(400).end();
      }
      const r = await core.invoke(j?.method, Array.isArray(j?.args) ? j.args : []);
      if (j?.method === 'quit' && r.ok) setTimeout(() => void stop(), 200);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(r));
      return;
    }
    if (u.pathname === '/api/events') {
      if (!authed(req, u.searchParams)) return void res.writeHead(401).end();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(core.snapshot())}\n\n`);
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (req.method !== 'GET') return void res.writeHead(405).end();
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
    const file = path.resolve(rendererDir, rel);
    if (!file.startsWith(rendererDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end();
    let data: Buffer | string = fs.readFileSync(file);
    if (rel === 'index.html') data = data.toString('utf8').replace("connect-src 'none'", "connect-src 'self'");
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(data);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(dashPort, '127.0.0.1', () => resolve());
  });

  // When the Android app supplied the token it opens the dashboard itself; the token never goes to the log.
  const appOwned = !!process.env.RAVEN_DASH_TOKEN;
  const url = appOwned ? `http://127.0.0.1:${dashPort}/` : `http://127.0.0.1:${dashPort}/#t=${token}`;
  console.log(`Raven Master Server ${VERSION} (headless) is running.`);
  console.log(`Data folder: ${dataDir}`);
  console.log(`Gateway port: ${core.config.value.port}`);
  console.log(appOwned ? 'Dashboard: open the Raven Master app.' : `Dashboard (open on this device): ${url}`);
  console.log(`RAVEN_READY ${JSON.stringify({ dashboard: url, port: core.config.value.port })}`);

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    for (const r of listeners) r.end();
    server.close();
    await core.stop();
    process.exit(0);
  }
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((e) => {
  console.error('Raven Master Server could not start:', e?.stack ?? e);
  process.exit(1);
});
