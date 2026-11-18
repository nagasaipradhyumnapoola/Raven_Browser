// End-to-end run of the Android master (the real APK on an emulator or a USB-connected phone) with a real
// Raven Browser on this PC: install, start, open the dashboard API, add an AI provider, pair, browse, AI, search.
//   node scripts/e2e-android.mjs            (needs: an emulator or phone visible to `adb devices`, a test build)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = process.env.ANDROID_HOME || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
const adbPath = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const adb = (...a) => execFileSync(adbPath, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const apk = path.join(root, 'build', 'android', 'RavenMaster-debug.apk');
const out = path.join(root, 'build', 'e2e-android');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

// ---------------------------------------------------------------- device
let t0 = Date.now();
while (Date.now() - t0 < 240_000) {
  try {
    if (adb('shell', 'getprop', 'sys.boot_completed') === '1') break;
  } catch {
    /* still booting */
  }
  await sleep(2000);
}
const abi = adb('shell', 'getprop', 'ro.product.cpu.abi');
const release = adb('shell', 'getprop', 'ro.build.version.release');
check('an Android device is ready', !!abi, `Android ${release}, ${abi}`);
adb('install', '-r', '-g', apk);
adb('shell', 'am', 'force-stop', 'app.raven.master');
// A token left by an earlier run must not be mistaken for the new one.
try {
  adb('shell', 'run-as', 'app.raven.master', 'rm', '-f', 'files/dashboard.token');
} catch {
  /* first install */
}
adb('shell', 'am', 'start', '-n', 'app.raven.master/.MainActivity');
let token = '';
t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  try {
    token = adb('shell', 'run-as', 'app.raven.master', 'cat', 'files/dashboard.token');
    if (/^[A-Za-z0-9_-]{16,}$/.test(token)) break;
  } catch {
    /* not yet */
  }
  await sleep(1500);
}
const dashPort = await freePort();
const gwPort = await freePort();
adb('forward', `tcp:${dashPort}`, 'tcp:47812');
adb('forward', `tcp:${gwPort}`, 'tcp:47800');
const api = async (method, ...args) => {
  const r = await fetch(`http://127.0.0.1:${dashPort}/api/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args }) });
  return r.json();
};
let state = null;
t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  try {
    state = await api('state');
    if (state.ok) break;
  } catch {
    /* node still starting */
  }
  await sleep(1500);
}
check('the app starts the master inside the phone (embedded Node.js) and its dashboard answers', state?.ok && state.data.stats.listening, state?.ok ? `gateway listening on ${state.data.stats.port}` : 'no answer');
check('the phone master reports what it can do (no hidden-browser tasks on a phone)', state?.ok && state.data.host.agents === false && state.data.host.desktop === false);
const page = await fetch(`http://127.0.0.1:${dashPort}/`).then((r) => r.text()).catch(() => '');
check('the dashboard page the app shows is served by the phone master', page.includes('<div id="root">'));

// Stand-in AI provider on this PC; the emulator reaches it at 10.0.2.2 (a real phone: use your PC's address).
const KEY = 'android-provider-key';
const llm = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end('{"error":{"message":"bad key"}}');
  if (req.url.startsWith('/v1/models')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'android-model', owned_by: 'test' }] }));
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const p of ['Answer ', 'from ', 'the Android master.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => llm.listen(0, '0.0.0.0', r));
const added = await api('aiAddProvider', 'Android test', `http://10.0.2.2:${llm.address().port}`, KEY);
check('an AI provider is added on the phone (address + key checked from the phone)', added.ok, JSON.stringify(added));
await api('updateConfig', { setupDone: true });
const approver = setInterval(async () => {
  const s = await api('state').catch(() => null);
  for (const d of s?.data?.devices ?? []) if (d.status === 'pending') await api('approveDevice', d.id);
}, 500);

// ---------------------------------------------------------------- Raven Browser on this PC, master on the phone
const browserScript = `(async () => {
  const inv = window.raven.invoke;
  const result = {};
  let app = (await inv('init')).data.app;
  let win = (await inv('init')).data.win;
  window.raven.on('raven:app', (a) => (app = a));
  window.raven.on('raven:win', (w) => (win = w));
  const until = async (cond, ms, what) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout: ' + what + ' ' + app.conn.state + ' ' + app.conn.lastError); await new Promise(r => setTimeout(r, 150)); } };
  await inv('settings', { strictGateway: true, restoreSession: false });
  await inv('connectAddress', '127.0.0.1:${gwPort}', false);
  await until(() => app.conn.state === 'gateway_online', 60000, 'online');
  result.online = true;
  result.server = app.conn.server.serverName;
  await inv('navigate', 'https://example.com/');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && (t.title === 'Example Domain' || t.error); }, 45000, 'page');
  const tab = win.tabs.find(t => t.id === win.activeId);
  result.page = { title: tab.title, error: tab.error };
  const events = [];
  window.raven.on('raven:chat', (e) => events.push(e));
  await inv('aiSend', { conversationId: null, history: [], text: 'hello', context: [], model: 'auto', mode: 'auto' });
  await until(() => events.some(e => e.t === 'done' || e.t === 'error'), 45000, 'ai');
  const end = events.find(e => e.t === 'done' || e.t === 'error');
  result.ai = { end: end.t, answer: end.conversation && end.conversation.messages.at(-1).content, error: end.error };
  const sr = await inv('masterSearch', 'linked list in C', 0);
  result.search = sr.ok ? { n: sr.data.results.length, engine: sr.data.engine } : { error: sr.error };
  await inv('download', 'https://www.rfc-editor.org/rfc/rfc9110.txt');
  await until(() => app.downloads.some(d => ['completed', 'interrupted', 'cancelled'].includes(d.state)), 90000, 'download');
  result.download = app.downloads[0] && { state: app.downloads[0].state, bytes: app.downloads[0].received };
  return result;
})()`;
// Downloads land in the browser's default folder; point it at the output folder first.
const settingsFile = path.join(out, 'browser-data', 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({ askWhereToSave: false, downloadDir: path.join(out, 'downloads') }));
const browser = spawn(electron, [path.join(root, 'build', 'raven-browser')], {
  env: {
    ...process.env,
    RAVEN_HEADLESS: '1',
    RAVEN_DATA_DIR: path.join(out, 'browser-data'),
    RAVEN_SHOT: path.join(out, 'browser.png'),
    RAVEN_SHOT_DELAY: '3000',
    RAVEN_SHOT_SCRIPT: browserScript,
  },
  stdio: 'ignore',
  windowsHide: true,
});
t0 = Date.now();
while (!fs.existsSync(path.join(out, 'browser.png')) && Date.now() - t0 < 300_000) await sleep(500);
await sleep(500);
const bres = fs.existsSync(path.join(out, 'browser.png.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'browser.png.json'), 'utf8')) : null;
const berr = fs.existsSync(path.join(out, 'browser.png.error.txt')) ? fs.readFileSync(path.join(out, 'browser.png.error.txt'), 'utf8').slice(0, 300) : '';
check('Raven Browser on this PC pairs with the master on the phone and goes online', bres?.online, berr || bres?.server);
check('a real HTTPS site loads through the phone', bres?.page?.title === 'Example Domain' && !bres.page.error, JSON.stringify(bres?.page));
check('an AI answer streams through the phone master', bres?.ai?.end === 'done' && /Android master/.test(bres.ai.answer ?? ''), JSON.stringify(bres?.ai));
check('search runs on the phone and the results come back', bres?.search?.n > 0, JSON.stringify(bres?.search));
const dl = path.join(out, 'downloads', 'rfc9110.txt');
check('a 500 KB download comes through the phone intact', bres?.download?.state === 'completed' && fs.existsSync(dl) && fs.statSync(dl).size > 100_000, JSON.stringify(bres?.download));
clearInterval(approver);

const secrets = (() => {
  try {
    return adb('shell', 'run-as', 'app.raven.master', 'cat', 'files/MasterServerData/secrets.json');
  } catch {
    return '';
  }
})();
check('the provider key is stored encrypted on the phone (Android Keystore-protected key)', secrets.includes('aes:') && !secrets.includes(KEY));
const log = adb('logcat', '-d', '-s', 'RavenMaster');
fs.writeFileSync(path.join(out, 'logcat.txt'), log);
check('the phone master never writes the key or the dashboard token to the log', !log.includes(KEY) && !log.includes(token));

browser.kill();
llm.close();
adb('forward', '--remove', `tcp:${dashPort}`);
adb('forward', '--remove', `tcp:${gwPort}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Android checks passed`);
process.exit(failed ? 1 : 0);
