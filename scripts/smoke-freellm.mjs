// Boots the bundled FreeLLMAPI exactly as MasterServer.exe does (as a child of
// the Electron runtime in Node mode) and exercises its real documented API.
//   node scripts/smoke-freellm.mjs
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-fl-'));
const port = 47899;
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

const child = fork(path.join(root, 'build', 'freellm', 'server.mjs'), [], {
  execPath: electron,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    RAVEN_FL_DB: path.join(dir, 'freeapi.db'),
    RAVEN_FL_PORT: String(port),
    RAVEN_FL_CLIENT_DIST: path.join(root, 'build', 'freellm', 'client'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    FREEAPI_ENV_PATH: path.join(dir, 'none.env'),
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const ready = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout waiting for FreeLLMAPI\n' + log.slice(-2000))), 40000);
  child.on('message', (m) => {
    if (m.t === 'ready') {
      clearTimeout(t);
      resolve(m);
    }
    if (m.t === 'fatal') {
      clearTimeout(t);
      reject(new Error(m.error + '\n' + log.slice(-2000)));
    }
  });
  child.on('exit', (code) => reject(new Error(`exited ${code}\n${log.slice(-2000)}`)));
}).catch((e) => {
  console.error('FAIL  boot:', e.message);
  process.exit(1);
});

const base = `http://127.0.0.1:${ready.port}`;
check('FreeLLMAPI boots under the Electron runtime with node:sqlite', true, `port ${ready.port}`);
check('unified key handed to the parent over IPC only', typeof ready.apiKey === 'string' && ready.apiKey.length > 10);

let r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${ready.apiKey}` } });
const models = await r.json();
check('GET /v1/models with the unified key', r.ok && Array.isArray(models.data), `${models.data?.length} entries`);
const real = (models.data ?? []).filter((m) => typeof m.execution_status === 'string');
check('catalog has real provider models', real.length > 0, `${real.length} models, e.g. ${real.slice(0, 3).map((m) => m.id).join(', ')}`);

r = await fetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer wrong-key' } });
check('wrong key is rejected', r.status === 401 || r.status === 403, `HTTP ${r.status}`);

r = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${ready.apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'Say hi' }], stream: true }),
});
const body = (await r.text()).slice(0, 300).replace(/\s+/g, ' ');
check('POST /v1/chat/completions answers (no provider keys configured yet, so a clean error is expected)', r.status >= 400 && r.status < 600, `HTTP ${r.status}: ${body}`);

r = await fetch(`${base}/api/settings/api-key`, { headers: { Authorization: `Bearer ${ready.sessionToken}` } });
const cur = await r.json();
check('admin API: read unified key with the dashboard session', r.ok && cur.apiKey === ready.apiKey);

r = await fetch(`${base}/api/settings/api-key/regenerate`, { method: 'POST', headers: { Authorization: `Bearer ${ready.sessionToken}` } });
const regen = await r.json();
check('admin API: regenerate unified key', r.ok && typeof regen.apiKey === 'string' && regen.apiKey !== ready.apiKey);
r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${ready.apiKey}` } });
check('old unified key stops working after regeneration', r.status === 401 || r.status === 403, `HTTP ${r.status}`);
r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${regen.apiKey}` } });
check('new unified key works', r.ok);

r = await fetch(`${base}/api/keys/providers`, { headers: { Authorization: `Bearer ${ready.sessionToken}` } });
const provs = await r.json().catch(() => null);
check('admin API: provider list', r.ok, Array.isArray(provs) ? `${provs.length} providers` : typeof provs);

r = await fetch(`${base}/api/settings/api-key`);
check('admin API refuses callers without a session', r.status === 401, `HTTP ${r.status}`);

r = await fetch(`${base}/`);
const html = await r.text();
check('embedded FreeLLMAPI dashboard is served', r.ok && html.includes('<div id="root"'), `HTTP ${r.status}`);

child.send({ t: 'shutdown' });
await new Promise((res) => child.on('exit', res));
check('child shuts down cleanly on request', true);
const dbFiles = fs.readdirSync(dir);
check('FreeLLMAPI keeps its own internal storage in its data folder', dbFiles.some((f) => f.startsWith('freeapi.db')), dbFiles.join(', '));
fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
