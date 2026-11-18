// Checks the packaged executables in dist/ (no development hooks are present
// in packaged builds). Run with: node scripts/packaged-test.mjs
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { DEFAULT_LIMITS } from '@raven/shared';
import { deviceIdFromPublicKey, generateDeviceKeyPair } from '@raven/security';
import { GatewayClient } from '@raven/network-protocol';

const root = process.argv[2];
const dist = path.join(root, 'dist');
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitPort(port: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise<boolean>((r) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        r(true);
      });
      s.once('error', () => r(false));
    });
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

function kill(p: ChildProcess | null) {
  if (!p || p.exitCode !== null) return;
  try {
    spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* gone */
  }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-pkg-'));
  const port = 47000 + Math.floor(Math.random() * 500);
  for (const f of ['MasterServer.exe', 'RavenBrowser.exe']) {
    const p = path.join(dist, f);
    check(`${f} exists`, fs.existsSync(p), fs.existsSync(p) ? `${(fs.statSync(p).size / 1e6).toFixed(0)} MB` : 'missing');
  }

  // Pre-approve a test device so the check needs no clicks in the dashboard.
  const kp = generateDeviceKeyPair();
  const id = deviceIdFromPublicKey(kp.publicKey);
  const dataDir = path.join(work, 'master', 'MasterServerData');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port, setupDone: true, ai: { mode: 'managed', managedPort: port + 11 } }));
  fs.writeFileSync(
    path.join(dataDir, 'devices.json'),
    JSON.stringify({ version: 1, revokedKeys: [], devices: [{ id, name: 'Packaged test', publicKey: kp.publicKey, status: 'approved', internet: true, ai: true, allowedModels: null, defaultModel: null, limits: DEFAULT_LIMITS, createdAt: Date.now(), approvedAt: Date.now(), pairingCode: '000000' }] }),
  );

  const master = spawn(path.join(dist, 'MasterServer.exe'), [], {
    env: { ...process.env, RAVEN_HEADLESS: '1', RAVEN_BIND: '127.0.0.1', RAVEN_USER_DATA: path.join(work, 'master') },
    stdio: 'ignore',
    windowsHide: true,
  });
  const up = await waitPort(port, 90_000);
  check('MasterServer.exe starts (portable unpack, no installer) and its gateway listens', up, `port ${port}`);

  let flRunning = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const ev = path.join(dataDir, 'logs', 'events.jsonl');
    if (fs.existsSync(ev) && fs.readFileSync(ev, 'utf8').includes('FreeLLMAPI is running')) {
      flRunning = true;
      break;
    }
    await sleep(500);
  }
  check('built-in FreeLLMAPI starts inside MasterServer.exe (no Node.js installed separately)', flRunning);

  const client = new GatewayClient({ deviceId: id, publicKey: kp.publicKey, privateKey: kp.privateKey }, { name: 'Packaged test', appVersion: 'test' });
  let online = false;
  try {
    const r = await client.connect({ host: '127.0.0.1', port, tls: 'pin', pin: null });
    online = r.phase === 'online';
  } catch (e) {
    console.log('connect error', (e as Error).message);
  }
  check('approved device connects to the packaged gateway', online);

  if (online) {
    try {
      const s = await client.openTcp('example.com', 443);
      const sec = tls.connect({ socket: s as any, servername: 'example.com' });
      await new Promise<void>((res, rej) => {
        sec.once('secureConnect', () => res());
        sec.once('error', rej);
      });
      sec.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
      let body = '';
      for await (const d of sec) body += d.toString();
      check('HTTPS website through the packaged gateway', body.includes('Example Domain') && sec.authorized);
    } catch (e) {
      check('HTTPS website through the packaged gateway', false, (e as Error).message);
    }
    // Real FreeLLMAPI with no provider keys: the request must reach it and come back with its structured error.
    await sleep(3000);
    try {
      await client.openAi({ messages: [{ role: 'user', content: 'hi' }], model: 'auto', profile: 'general' });
      check('AI request reaches the bundled FreeLLMAPI', false, 'unexpected success without provider keys');
    } catch (e) {
      const code = (e as any).code;
      check('AI request reaches the bundled FreeLLMAPI and returns its real "no provider" error', code === 'providers_unavailable', code);
    }
    client.disconnect();
  }

  const secrets = fs.existsSync(path.join(dataDir, 'secrets.json')) ? fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8') : '';
  check('secrets stored encrypted with Windows DPAPI', secrets.includes('enc:') && !/BEGIN (EC )?PRIVATE KEY/.test(secrets));

  // Browser
  const bdata = path.join(work, 'browser');
  const browser = spawn(path.join(dist, 'RavenBrowser.exe'), [], { env: { ...process.env, RAVEN_HEADLESS: '1', RAVEN_DATA_DIR: bdata }, stdio: 'ignore', windowsHide: true });
  let started = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 60_000) {
    if (fs.existsSync(path.join(bdata, 'identity.json')) && fs.existsSync(path.join(bdata, 'profile')) && fs.existsSync(path.join(bdata, 'memory-index', 'manifest.json'))) {
      started = true;
      break;
    }
    await sleep(500);
  }
  await sleep(4000);
  check('RavenBrowser.exe starts with no login and creates its device identity and file memory', started && browser.exitCode === null);
  const id2 = started ? JSON.parse(fs.readFileSync(path.join(bdata, 'identity.json'), 'utf8')) : null;
  check('browser private key is encrypted (DPAPI), never stored in clear', !!id2 && typeof id2.privateKeyEnc === 'string' && !JSON.stringify(id2).includes('PRIVATE KEY'));
  const dbFiles = started ? fs.readdirSync(bdata, { recursive: true } as any).map(String).filter((f) => /\.(db|sqlite)$/i.test(f) && !f.startsWith('profile')) : [];
  check('no application database in the browser memory folder', started && dbFiles.length === 0, dbFiles.join(', '));

  kill(browser);
  kill(master);
  await sleep(3000);
  const portFree = !(await new Promise<boolean>((r) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      r(true);
    });
    s.once('error', () => r(false));
  }));
  check('port released after the master exits', portFree);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} packaged checks passed`);
  fs.writeFileSync(path.join(root, 'build', 'packaged-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}

void main();
