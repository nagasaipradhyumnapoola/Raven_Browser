// End-to-end run of the headless master (the build that runs inside the Android app, Termux or a server)
// with a real Raven Browser: plain Node.js master, its token-protected dashboard API, pairing, browsing,
// AI and search through it.
//   node scripts/e2e-headless.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const out = path.join(root, 'build', 'e2e-headless');
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

// Stand-in OpenAI-compatible provider.
const KEY = 'headless-provider-key';
const llmRequests = [];
const llm = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end('{"error":{"message":"bad key"}}');
  if (req.url.startsWith('/v1/models')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'phone-model', owned_by: 'test' }] }));
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llmRequests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const p of ['Answer ', 'from ', 'the phone master.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const llmUrl = `http://127.0.0.1:${llm.address().port}`;
const gwPort = await freePort();
const dashPort = await freePort();

// ---------------------------------------------------------------- headless master (plain Node.js)
const masterData = path.join(out, 'master-data');
const master = spawn(process.execPath, [path.join(root, 'build', 'master-headless', 'raven-master.cjs'), '--data', masterData, '--dashboard-port', String(dashPort)], {
  env: { ...process.env, RAVEN_BIND: '127.0.0.1', RAVEN_NO_UPNP: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let mlog = '';
let ready = null;
master.stdout.on('data', (d) => {
  mlog += d;
  const m = /RAVEN_READY (\{.*\})/.exec(mlog);
  if (m && !ready) ready = JSON.parse(m[1]);
});
master.stderr.on('data', (d) => (mlog += d));
const t0 = Date.now();
while (!ready && Date.now() - t0 < 30_000) await sleep(200);
check('headless master starts under plain Node.js (no Electron) and prints its dashboard link', !!ready, ready ? `gateway ${ready.port}` : mlog.slice(-300));
if (!ready) process.exit(1);
const token = /#t=(.+)$/.exec(ready.dashboard)[1];
const api = async (method, ...args) => {
  const r = await fetch(`http://127.0.0.1:${dashPort}/api/invoke`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args }) });
  return r.json();
};

const page = await fetch(`http://127.0.0.1:${dashPort}/`).then((r) => r.text());
check('dashboard page is served on this device (with its API allowed)', page.includes('<div id="root">') && page.includes("connect-src 'self'"));
const noToken = await fetch(`http://127.0.0.1:${dashPort}/api/invoke`, { method: 'POST', body: '{"method":"state","args":[]}' });
const badHost = await new Promise((r) => http.get({ host: '127.0.0.1', port: dashPort, path: '/', headers: { Host: 'evil.example:80' } }, (res) => r(res.statusCode)));
check('dashboard API refuses calls without the token and pages loaded under another name', noToken.status === 401 && badHost === 403, `${noToken.status} / ${badHost}`);

await api('updateConfig', { setupDone: true, port: gwPort });
const added = await api('aiAddProvider', 'Phone test', llmUrl, KEY);
check('AI provider added from the phone dashboard (address + key validated)', added.ok && added.data.models === 1, JSON.stringify(added));
const st = await api('state');
check('snapshot says what this master can do (no hidden-browser tasks on a phone)', st.ok && st.data.host.agents === false && st.data.host.desktop === false);
const approver = setInterval(async () => {
  const s = await api('state');
  for (const d of s.data?.devices ?? []) if (d.status === 'pending') await api('approveDevice', d.id);
}, 400);

// ---------------------------------------------------------------- real Raven Browser against it
const browserScript = `(async () => {
  const inv = window.raven.invoke;
  const result = {};
  let app = (await inv('init')).data.app;
  let win = (await inv('init')).data.win;
  window.raven.on('raven:app', (a) => (app = a));
  window.raven.on('raven:win', (w) => (win = w));
  const until = async (cond, ms, what) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout: ' + what); await new Promise(r => setTimeout(r, 150)); } };
  await inv('settings', { strictGateway: true, restoreSession: false });
  await inv('connectAddress', '127.0.0.1:${gwPort}', false);
  await until(() => app.conn.state === 'gateway_online', 30000, 'online');
  result.online = true;
  result.agents = app.conn.server.agents;
  await inv('navigate', 'https://example.com/');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && (t.title === 'Example Domain' || t.error); }, 30000, 'page');
  const tab = win.tabs.find(t => t.id === win.activeId);
  result.page = { title: tab.title, error: tab.error };
  const events = [];
  window.raven.on('raven:chat', (e) => events.push(e));
  await inv('aiSend', { conversationId: null, history: [], text: 'hello', context: [], model: 'auto', mode: 'auto' });
  await until(() => events.some(e => e.t === 'done' || e.t === 'error'), 30000, 'ai');
  const end = events.find(e => e.t === 'done' || e.t === 'error');
  result.ai = { end: end.t, answer: end.conversation && end.conversation.messages.at(-1).content };
  const route = await inv('route', 'what is a linked list');
  result.route = route.ok ? route.data.action : route.error;
  const sr = await inv('masterSearch', 'linked list in C', 0);
  result.search = sr.ok ? { n: sr.data.results.length, engine: sr.data.engine, first: sr.data.results[0] && sr.data.results[0].url } : { error: sr.error };
  const task = await inv('agentStart', 'send a mail');
  result.taskError = task.ok ? null : task.error;
  return result;
})()`;
const browser = spawn(electron, [path.join(root, 'build', 'raven-browser')], {
  env: { ...process.env, RAVEN_HEADLESS: '1', RAVEN_DATA_DIR: path.join(out, 'browser-data'), RAVEN_SHOT: path.join(out, 'browser.png'), RAVEN_SHOT_DELAY: '3000', RAVEN_SHOT_SCRIPT: browserScript },
  stdio: 'ignore',
  windowsHide: true,
});
const t1 = Date.now();
while (!fs.existsSync(path.join(out, 'browser.png')) && Date.now() - t1 < 180_000) await sleep(300);
await sleep(500);
const bres = fs.existsSync(path.join(out, 'browser.png.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'browser.png.json'), 'utf8')) : null;
const berr = fs.existsSync(path.join(out, 'browser.png.error.txt')) ? fs.readFileSync(path.join(out, 'browser.png.error.txt'), 'utf8').slice(0, 300) : '';
check('Raven Browser pairs with the headless master and goes online', bres?.online, berr);
check('a real HTTPS site loads through the headless master', bres?.page?.title === 'Example Domain' && !bres.page.error, JSON.stringify(bres?.page));
check('AI answer streams from the provider through the headless master', bres?.ai?.end === 'done' && /phone master/.test(bres.ai.answer ?? ''), JSON.stringify(bres?.ai));
check('assistant router answers on the headless master', bres?.route === 'answer', bres?.route);
check('search runs on the headless master and returns results', bres?.search?.n > 0 && /^https?:/.test(bres.search.first ?? ''), JSON.stringify(bres?.search));
check('tasks are clearly unavailable on a phone master (no fake results)', bres?.agents === false && /desktop master/i.test(bres?.taskError ?? ''), bres?.taskError);

clearInterval(approver);
const secretsTxt = fs.readFileSync(path.join(masterData, 'secrets.json'), 'utf8');
check('provider key stored encrypted on the headless master', !secretsTxt.includes(KEY) && secretsTxt.includes('aes:'));
const logs = fs.readdirSync(path.join(masterData, 'logs')).map((f) => fs.readFileSync(path.join(masterData, 'logs', f), 'utf8')).join('\n');
check('headless master logs contain no secret', !logs.includes(KEY) && !mlog.includes(KEY));
const quit = await api('quit');
await sleep(1500);
check('headless master quits cleanly from the dashboard', quit.ok && master.exitCode === 0, String(master.exitCode));

browser.kill();
master.kill();
llm.close();
fs.writeFileSync(path.join(out, 'master.log'), mlog);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} headless checks passed`);
process.exit(failed ? 1 : 0);
