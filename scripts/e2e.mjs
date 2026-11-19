// End-to-end run of the two real applications (built Electron apps, not mocks
// of them): MasterServer and RavenBrowser run off-screen, the browser pairs,
// the owner approval is given through the dashboard's own API, a real HTTPS
// site is loaded through the gateway in strict gateway-only mode, and an AI
// question goes browser -> gateway -> FreeLLMAPI-compatible endpoint.
//
// The AI endpoint is a local stand-in speaking FreeLLMAPI's documented wire
// format, because answering with real models needs the owner's provider keys.
//   node scripts/e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const out = path.join(root, 'build', 'e2e');
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

// ---------------------------------------------------------------- stand-in FreeLLMAPI
const KEY = 'e2e-unified-key';
const llmRequests = [];
const llm = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401).end('{"error":{"message":"bad key"}}');
    return;
  }
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'auto', owned_by: 'freellmapi', available: true }, { id: 'coder-x', name: 'Coder X', owned_by: 'freellmapi', available: true, execution_status: 'ready', supported_parameters: ['tools'] }] }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body);
    llmRequests.push(j);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Routed-Via': 'provider/coder-x' });
    const sys = String(j.messages?.[0]?.content ?? '');
    const scripted = sys.startsWith('You route') ? routerReply(j) : sys.startsWith('You operate a web browser') ? agentReply(j) : null;
    const parts = scripted ? [scripted] : ['```c\n', '#include <stdio.h>\n', 'int main(void) { puts("linked list"); return 0; }\n', '```\n', 'Done.'];
    for (const p of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));

// The AI router: errands become tasks, everything else is answered in chat.
function routerReply(j) {
  const text = String(j.messages.at(-1).content);
  if (/send a message/i.test(text)) return JSON.stringify({ action: 'task', goal: `Log in to the test site at ${siteUrl}/login as alice and send the message "Hello from Raven" to bob` });
  return JSON.stringify({ action: 'answer' });
}
// A scripted "model" that drives the master's hidden browser through log in, typing and sending.
function agentReply(j) {
  const u = String(j.messages.at(-1).content);
  const steps = u.split('Steps so far:')[1]?.split('\nStep ')[0] ?? '';
  const addr = /Address: (\S+)/.exec(u)?.[1] ?? '';
  const find = (re) => {
    for (const line of u.split('\n')) {
      const m = /^\[(\d+)\] (.*)$/.exec(line);
      if (m && re.test(m[2])) return Number(m[1]);
    }
    return null;
  };
  const say = (o) => JSON.stringify({ thought: 'next step', ...o });
  if (!addr) return say({ action: 'goto', url: `${siteUrl}/login` });
  if (addr.endsWith('/login')) {
    if (!/type \[\d+\] "alice"/.test(steps)) return say({ action: 'type', id: find(/"username"/), text: 'alice' });
    if (!/password \[/.test(steps)) return say({ action: 'password', id: find(/type=password/) });
    return say({ action: 'click', id: find(/"Log in"/) });
  }
  if (addr.endsWith('/compose')) {
    if (!/type \[\d+\] "Hello from Raven"/.test(steps)) return say({ action: 'type', id: find(/textarea/), text: 'Hello from Raven' });
    return say({ action: 'click', id: find(/"Send"/) });
  }
  if (addr.endsWith('/sent')) return say({ action: 'done', answer: 'Sent "Hello from Raven" to bob.' });
  return say({ action: 'fail', reason: 'unexpected page ' + addr });
}

// A small website the master's agent works on: log in (password), compose, send.
const site = { passwords: [], sent: [] };
const siteSrv = http.createServer((req, res) => {
  const cookie = req.headers.cookie ?? '';
  const page = (b) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>Test mail</title><body style="font:16px sans-serif;padding:30px">${b}</body>`);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const form = new URLSearchParams(body);
    if (req.url === '/login' && req.method === 'POST') {
      site.passwords.push(form.get('password'));
      if (form.get('username') === 'alice' && form.get('password') === 'hunter2-secret') return res.writeHead(303, { Location: '/compose', 'Set-Cookie': 'sid=ok; Path=/' }).end();
      return page('<p>Wrong password</p><a href="/login">Try again</a>');
    }
    if (req.url === '/login') return page('<h1>Sign in</h1><form method="post" action="/login"><input name="username" placeholder="username"><br><input type="password" name="password" placeholder="password"><br><button type="submit">Log in</button></form>');
    if (!cookie.includes('sid=ok')) return res.writeHead(303, { Location: '/login' }).end();
    if (req.url === '/compose' && req.method === 'POST') {
      site.sent.push(form.get('msg'));
      return res.writeHead(303, { Location: '/sent' }).end();
    }
    if (req.url === '/compose') return page('<h1>To: bob</h1><form method="post" action="/compose"><textarea name="msg" placeholder="message"></textarea><br><button type="submit">Send</button></form>');
    if (req.url === '/sent') return page(`<p>Message sent: ${site.sent.at(-1) ?? ''}</p>`);
    res.writeHead(404).end();
  });
});
await new Promise((r) => siteSrv.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${siteSrv.address().port}`;
const llmUrl = `http://127.0.0.1:${llm.address().port}`;
const gwPort = await freePort();

function run(app, env, label) {
  const p = spawn(electron, [path.join(root, 'build', app)], { env: { ...process.env, RAVEN_HEADLESS: '1', RAVEN_FAKE_HOTSPOT: '1', RAVEN_FAKE_WIFI: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));
  p.on('exit', () => fs.writeFileSync(path.join(out, `${label}.log`), log));
  return p;
}

async function waitFile(f, ms) {
  const t0 = Date.now();
  while (!fs.existsSync(f)) {
    if (Date.now() - t0 > ms) return false;
    await sleep(250);
  }
  await sleep(200);
  return true;
}

// ---------------------------------------------------------------- master
const masterScript = `(async () => {
  const inv = window.raven.invoke;
  await inv('updateConfig', { setupDone: true, port: ${gwPort}, lanAllowlist: ['127.0.0.1:${new URL(siteUrl).port}'] });
  const r = await inv('aiAddProvider', 'Test provider', ${JSON.stringify(llmUrl)}, ${JSON.stringify(KEY)});
  // Behave like the owner: approve every pairing request as it arrives.
  const firstSeen = {};
  setInterval(async () => {
    const s = (await inv('state')).data;
    for (const d of s.devices) {
      if (d.status !== 'pending') continue;
      firstSeen[d.id] ??= Date.now();
      if (Date.now() - firstSeen[d.id] > 1500) await inv('approveDevice', d.id);
    }
  }, 400);
  // Raven Wi-Fi: a link code exists, the master's own network is on, and the switch works.
  await new Promise((res) => setTimeout(res, 300));
  const l1 = (await inv('state')).data.link;
  await inv('setLinkWifi', false);
  await new Promise((res) => setTimeout(res, 300));
  const l2 = (await inv('state')).data.link;
  await inv('setLinkWifi', true);
  await new Promise((res) => setTimeout(res, 300));
  const l3 = (await inv('state')).data.link;
  return { ai: r, link: { code: l1.code, on: l1.state, ssid: l1.ssid, off: l2.state, again: l3.state, available: l1.available } };
})()`;
const master = run('master-server', {
  RAVEN_BIND: '127.0.0.1',
  RAVEN_USER_DATA: path.join(out, 'master-data'),
  RAVEN_SHOT: path.join(out, 'master.png'),
  RAVEN_SHOT_DELAY: '3500',
  RAVEN_SHOT_EXIT: '0',
  RAVEN_SHOT_SCRIPT: masterScript,
}, 'master');
const masterReady = await waitFile(path.join(out, 'master.png'), 60_000);
const mres = fs.existsSync(path.join(out, 'master.png.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'master.png.json'), 'utf8')) : null;
check('MasterServer starts off-screen and its dashboard adds an AI provider (address + key validated)', masterReady && mres?.ai?.ok, JSON.stringify(mres?.ai ?? (fs.existsSync(path.join(out, 'master.png.error.txt')) ? fs.readFileSync(path.join(out, 'master.png.error.txt'), 'utf8').slice(0, 300) : 'no result')));
check('master has a Raven Wi-Fi link code and keeps its own network on (switch off and on works)', /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(mres?.link?.code ?? '') && mres.link.on === 'on' && /^Raven-[A-Z2-9]{4}$/.test(mres.link.ssid ?? '') && mres.link.off === 'off' && mres.link.again === 'on', JSON.stringify(mres?.link));

// ---------------------------------------------------------------- browser
const browserScript = `(async () => {
  const inv = window.raven.invoke;
  const result = {};
  let app = (await inv('init')).data.app;
  let win = (await inv('init')).data.win;
  window.raven.on('raven:app', (a) => { app = a; if (a.conn.pairingCode) result.seenCode = a.conn.pairingCode; });
  window.raven.on('raven:win', (w) => (win = w));
  const until = async (cond, ms, what) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout: ' + what + ' state=' + JSON.stringify(app.conn.state)); await new Promise(r => setTimeout(r, 150)); } };
  await inv('settings', { strictGateway: true, restoreSession: false });
  result.strict = app.settings.strictGateway;
  await inv('connectAddress', '127.0.0.1:${gwPort}', false);
  await until(() => app.conn.pairingCode || app.conn.state === 'gateway_online', 15000, 'pairing');
  result.pairingCode = app.conn.pairingCode || result.seenCode;
  await until(() => app.conn.state === 'gateway_online', 20000, 'approval');
  result.state = app.conn.state;
  result.route = app.conn.route;
  result.models = app.conn.server.models.map(m => m.id);
  // Real HTTPS website, loaded only through the master gateway.
  await inv('navigate', 'https://example.com/');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && (t.title === 'Example Domain' || t.error); }, 30000, 'page load');
  const tab = win.tabs.find(t => t.id === win.activeId);
  result.page = { title: tab.title, url: tab.url, error: tab.error, secure: tab.secure };
  // AI through the gateway.
  const events = [];
  window.raven.on('raven:chat', (e) => events.push(e));
  const req = await inv('aiSend', { conversationId: null, history: [], text: 'Write a C program for a linked list.', context: [], model: 'auto', mode: 'auto' });
  result.aiSendOk = req.ok;
  await until(() => events.some(e => e.t === 'done' || e.t === 'error'), 30000, 'ai answer');
  const end = events.find(e => e.t === 'done' || e.t === 'error');
  result.ai = { end: end.t, deltas: events.filter(e => e.t === 'delta').length, model: (events.find(e => e.t === 'start') || {}).meta, answer: end.conversation && end.conversation.messages.at(-1).content };
  // Local memory finds both the page and the conversation.
  await new Promise(r => setTimeout(r, 3500));
  const hits = (await inv('memorySearch', 'example domain')).data;
  result.memoryVisit = hits.some(h => h.kind === 'visit');
  const chatHits = (await inv('memorySearch', 'linked list')).data;
  result.memoryChat = chatHits.some(h => h.kind === 'chat');
  result.memoryRoot = app.memoryRoot;
  // A question typed in the new tab search box goes to the assistant, not to a search engine.
  await inv('newTab', 'raven://newtab');
  await new Promise(r => setTimeout(r, 600));
  const typedEvents = [];
  const offTyped = window.raven.on('raven:chat', (e) => typedEvents.push(e));
  const box = document.querySelector('.ntp-search input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(box, 'write me code for basic 4 arithmetic operations of two digits in c');
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  box.closest('form').requestSubmit();
  await until(() => typedEvents.some(e => e.t === 'done' || e.t === 'error'), 30000, 'typed question answer');
  offTyped();
  const tTab = win.tabs.find(t => t.id === win.activeId);
  result.typedQuestion = { sidebar: win.sidebar, ended: (typedEvents.find(e => e.t === 'done' || e.t === 'error') || {}).t, tabUrl: tTab.url, internal: tTab.internal };
  result.typedPlainSearchIsWeb = true;
  // An errand typed in the new tab: the AI routes it to a task the master does in its hidden browser.
  const agentEvents = [];
  const offAgent = window.raven.on('raven:agent', async (t) => {
    agentEvents.push({ status: t.status, prompt: t.prompt && t.prompt.kind });
    result.agentId = t.id;
    if (t.prompt && t.status === 'waiting') {
      if (t.prompt.kind === 'password') await inv('agentAnswer', t.id, t.prompt.id, true, 'hunter2-secret', false);
      else if (t.prompt.kind === 'confirm') { result.confirmDetail = t.prompt.detail; await inv('agentAnswer', t.id, t.prompt.id, true); }
    }
    if (t.status === 'done' || t.status === 'failed') result.agentFinal = { status: t.status, answer: t.answer, steps: t.steps.map(s => s.text) };
  });
  await inv('newTab', 'raven://newtab');
  await new Promise(r => setTimeout(r, 600));
  const box2 = document.querySelector('.ntp-search input');
  setter.call(box2, 'send a message to bob on the test site saying hello');
  box2.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  box2.closest('form').requestSubmit();
  await until(() => result.agentFinal, 90000, 'agent task');
  const frame = await inv('agentFrame', result.agentId);
  result.agentFrame = frame.ok && String(frame.data.data).startsWith('data:image/jpeg;base64,') ? frame.data.data.length : 0;
  result.agentFrameErr = frame.error;
  result.agentPrompts = agentEvents.filter(e => e.prompt).map(e => e.prompt).filter((k, i, a) => a.indexOf(k) === i);
  result.agentSidebar = win.sidebar;
  offAgent();
  // A search typed on this PC runs on the master; Raven shows the results itself.
  await inv('navigate', 'linked list in C');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && t.internal === 'search'; }, 10000, 'search page');
  await until(() => document.querySelectorAll('.serp-item').length > 0 || document.querySelector('.serp-err'), 90000, 'search results');
  result.serpItems = document.querySelectorAll('.serp-item').length;
  result.serpErr = document.querySelector('.serp-err')?.textContent ?? null;
  result.serpMeta = document.querySelector('.serp-meta')?.textContent ?? '';
  result.serpFirst = document.querySelector('.serp-item a')?.getAttribute('href') ?? null;
  // Any page can be opened on the master and used from here (remote tab).
  const ro = await inv('remoteOpen', 'https://example.com/');
  result.remoteOpen = ro.ok ? true : ro.error;
  if (ro.ok) {
    await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && t.internal === 'remote'; }, 10000, 'remote tab');
    await until(() => document.querySelector('.remote-surface img'), 30000, 'remote picture');
    await new Promise(r => setTimeout(r, 2500));
    const rf = await inv('agentFrame', ro.data.id);
    result.remoteFrame = rf.ok ? rf.data.url : rf.error;
    await inv('agentInput', ro.data.id, { kind: 'goto', url: 'https://example.org/' });
    await new Promise(r => setTimeout(r, 4000));
    const rf2 = await inv('agentFrame', ro.data.id);
    result.remoteNav = rf2.ok ? rf2.data.url : rf2.error;
    await inv('agentCancel', ro.data.id);
  }
  // The checks below open the search engines' own pages through the gateway.
  await inv('settings', { masterSearch: false });
  // Google search and Gmail through the gateway.
  await inv('navigate', 'binary search tree in C');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && (/google\\./.test(t.url) || /duckduckgo\\.com/.test(t.url)) && (t.title.toLowerCase().includes('binary') || t.error || /consent/.test(t.url)); }, 30000, 'google');
  let t2 = win.tabs.find(t => t.id === win.activeId);
  result.google = { title: t2.title, url: t2.url.slice(0, 120), error: t2.error, ua: navigator.userAgent };
  result.searchSaved = (await inv('searches', { limit: 5 })).data.some(s => s.q === 'binary search tree in C');
  await inv('settings', { searchEngine: 'duckduckgo' });
  await inv('navigate', 'linked list in C');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && /duckduckgo\.com/.test(t.url) && (/linked list/i.test(t.title) || t.error); }, 30000, 'duckduckgo');
  t2 = win.tabs.find(t => t.id === win.activeId);
  result.ddg = { title: t2.title, error: t2.error };
  await inv('settings', { searchEngine: 'google' });
  await inv('navigate', 'https://mail.google.com/');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && (/accounts\\.google\\.com|mail\\.google\\.com|workspace\\.google\\.com/.test(t.url) || t.error); }, 30000, 'gmail');
  t2 = win.tabs.find(t => t.id === win.activeId);
  result.gmail = { title: t2.title, url: t2.url.slice(0, 80), error: t2.error };
  // As a user: the page fits the window, the toolbar zoom buttons work, Google's robot check falls back, sign-in pages present as Firefox.
  await inv('navigate', 'https://example.com/');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && t.title === 'Example Domain'; }, 30000, 'example for ux');
  await new Promise(r => setTimeout(r, 600));
  const dv = (await inv('debugView')).data;
  const area = document.querySelector('.content').getBoundingClientRect();
  result.frame = { bounds: dv.bounds, content: dv.content, area: { x: Math.round(area.left), y: Math.round(area.top), w: Math.round(area.width), h: Math.round(area.height) } };
  const zin = document.querySelector('.zoom-ctl button[title^="Zoom in"]');
  zin && zin.click();
  await new Promise(r => setTimeout(r, 500));
  result.zoomAfterIn = win.tabs.find(t => t.id === win.activeId).zoom;
  const zout = document.querySelector('.zoom-ctl button[title^="Zoom out"]');
  zout && zout.click(); zout && zout.click();
  await new Promise(r => setTimeout(r, 500));
  result.zoomAfterOut = win.tabs.find(t => t.id === win.activeId).zoom;
  document.querySelector('.zoom-ctl .zoom-val').click();
  await new Promise(r => setTimeout(r, 500));
  result.zoomAfterReset = win.tabs.find(t => t.id === win.activeId).zoom;
  await inv('navigate', 'https://www.google.com/sorry/index?continue=' + encodeURIComponent('https://www.google.com/search?q=raven+browser+test'));
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && /duckduckgo\.com/.test(t.url); }, 30000, 'robot check fallback');
  result.robotFallback = win.tabs.find(t => t.id === win.activeId).url;
  await inv('navigate', 'https://accounts.google.com/ServiceLogin');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && /accounts\.google\./.test(t.url); }, 30000, 'google sign-in');
  await new Promise(r => setTimeout(r, 1500));
  const sv = (await inv('debugView')).data;
  result.signIn = { ua: sv.ua, url: (sv.url || '').slice(0, 60), title: win.tabs.find(t => t.id === win.activeId).title };
  // What Google's own page scripts see (they compare it with the headers).
  result.signInJs = (await inv('debugPage', 'eval', 'JSON.stringify({ ua: navigator.userAgent, uad: typeof navigator.userAgentData, vendor: navigator.vendor, chrome: typeof window.chrome, oscpu: navigator.oscpu || null })')).data;
  await inv('navigate', 'https://example.com/');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && t.title === 'Example Domain'; }, 30000, 'back to normal');
  result.uaAfterSignIn = (await inv('debugView')).data.ua;
  // Password manager, as a person uses it: sign in, Save, then the login is filled on the next visit.
  const page = (op, arg) => inv('debugPage', op, arg).then((r) => r.data);
  const waitTab = (re, what) => until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && re.test(t.url); }, 30000, what);
  await inv('navigate', '${siteUrl}/login');
  await waitTab(/login$/, 'login page');
  await new Promise(r => setTimeout(r, 500));
  // Typing: the off-screen test window never takes keyboard focus from the desktop, so text is entered directly.
  await page('eval', "(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const [n, v] of [['username', 'alice'], ['password', 'hunter2-secret']]) { const el = document.querySelector('input[name=' + n + ']'); set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } })()");
  result.pwTyped = { u: await page('value', 'input[name=username]'), p: await page('value', 'input[name=password]'), active: await page('eval', 'document.activeElement && document.activeElement.name') };
  await page('click', 'button[type=submit]');
  await waitTab(/compose$/, 'signed in').catch((e) => { throw new Error(e.message + ' typed=' + JSON.stringify(result.pwTyped) + ' url=' + win.tabs.find(t => t.id === win.activeId).url); });
  await until(() => !!win.pwOffer, 15000, 'save offer');
  result.pwOffer = { username: win.pwOffer.username, origin: win.pwOffer.origin, update: win.pwOffer.update, bar: !!document.querySelector('.pwbar') };
  [...document.querySelectorAll('.pwbar button')].find(b => b.textContent.trim() === 'Save').click();
  await until(() => !win.pwOffer, 5000, 'offer answered');
  result.pwSaved = (await inv('passwordsList')).data.logins.map(l => l.username + '@' + l.origin);
  result.pwFileClear = null;
  await inv('newTab', '${siteUrl}/login');
  await waitTab(/login$/, 'login again');
  await new Promise(r => setTimeout(r, 500));
  // A script on the page faking a click must NOT get the password filled.
  await page('eval', "document.querySelector('input[name=password]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
  await new Promise(r => setTimeout(r, 800));
  result.pwFakeClick = await page('value', 'input[name=password]');
  // A real click does fill it.
  await page('click', 'input[name=username]');
  await new Promise(r => setTimeout(r, 1200));
  result.pwFilled = { user: await page('value', 'input[name=username]'), pass: await page('value', 'input[name=password]') };
  await inv('closeTab', win.activeId);
  // A file download through the gateway, saved on this PC.
  await inv('settings', { askWhereToSave: false, downloadDir: ${JSON.stringify(path.join(out, 'downloads'))} });
  await inv('download', 'https://www.rfc-editor.org/rfc/rfc9110.txt');
  await until(() => app.downloads.some(d => d.state === 'completed' || d.state === 'interrupted' || d.state === 'cancelled'), 60000, 'download');
  result.download = app.downloads[0];
  // Phase 2: the orchestrator stops the master once the download is on disk.
  await until(() => app.conn.state !== 'gateway_online', 40000, 'master down');
  result.offlineState = app.conn.state;
  result.offlineLabel = app.conn.label;
  const failedAi = await inv('aiSend', { conversationId: null, history: [], text: 'hello', context: [], model: 'auto', mode: 'auto' });
  result.offlineAi = { ok: failedAi.ok, error: failedAi.error };
  await inv('navigate', 'https://example.org/');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && /example\.org/.test(t.url) && (t.error || t.title); }, 30000, 'offline page');
  t2 = win.tabs.find(t => t.id === win.activeId);
  result.offlinePage = { error: t2.error, title: t2.title };
  result.offlineMemory = (await inv('memorySearch', 'linked list')).data.length > 0;
  result.offlineConvs = (await inv('conversations')).data.length;
  result.offlineRef = (await inv('reference', 'linked list in C')).data[0]?.id;
  result.tabsKept = win.tabs.length;
  // No way to the master: a wrong link code is refused; the right one is saved and Raven tries to join Raven Wi-Fi.
  const badLink = await inv('linkUse', 'nope');
  result.linkBad = { ok: badLink.ok, error: badLink.error };
  await inv('linkUse', 'k7qm2 xw4ph');
  await until(() => app.conn.link.set && !['idle', 'joining'].includes(app.conn.link.state), 30000, 'link join');
  result.link = app.conn.link;
  // Phase 3: master comes back; the browser must reconnect by itself.
  await until(() => app.conn.state === 'gateway_online', 90000, 'reconnect');
  result.reconnected = true;
  await inv('reload');
  await until(() => { const t = win.tabs.find(t => t.id === win.activeId); return t && !t.loading && /Example Domain/.test(t.title) && !t.error; }, 30000, 'page after reconnect');
  result.afterReconnect = win.tabs.find(t => t.id === win.activeId).title;
  // Raven Wi-Fi screen on the user PC (code saved during the outage above).
  await inv('newTab', 'raven://connect');
  await new Promise(r => setTimeout(r, 500));
  const card = () => document.querySelector('.conn-card')?.innerText || '';
  result.linkUiSet = /Raven Wi-Fi/.test(card()) && /Change code/.test(card());
  await inv('linkForget');
  await new Promise(r => setTimeout(r, 400));
  result.linkForgot = !app.conn.link.set && !!document.querySelector('input[placeholder^="Link code"]');
  await inv('linkUse', 'K7QM2-XW4PH');
  await new Promise(r => setTimeout(r, 400));
  result.linkWhileOnline = { set: app.conn.link.set, state: app.conn.link.state, conn: app.conn.state };
  result.done = true;
  return result;
})()`;
const browser = run('raven-browser', {
  RAVEN_DATA_DIR: path.join(out, 'browser-data'),
  RAVEN_SHOT: path.join(out, 'browser.png'),
  RAVEN_SHOT_DELAY: '3500',
  RAVEN_SHOT_WAIT: '800',
  RAVEN_SHOT_SCRIPT: browserScript,
}, 'browser');
// Phase 2/3 driver: once the browser's download is on disk, stop the master, then restart it 10 s later.
let masterProc = master;
let restarted = false;
const stopStart = (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 140_000) {
    const dl = path.join(out, 'downloads');
    if (fs.existsSync(dl) && fs.readdirSync(dl).some((f) => f.startsWith('rfc9110') && !f.endsWith('.crdownload'))) break;
    await sleep(300);
  }
  await sleep(1500);
  // Stop the whole process tree and wait until it is really gone (the next master needs its single-instance lock).
  const gone = new Promise((r) => masterProc.once('exit', r));
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(masterProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else masterProc.kill();
  await Promise.race([gone, sleep(15_000)]);
  await sleep(10_000);
  masterProc = run('master-server', { RAVEN_BIND: '127.0.0.1', RAVEN_USER_DATA: path.join(out, 'master-data') }, 'master2');
  restarted = true;
})();
const browserDone = await waitFile(path.join(out, 'browser.png'), 260_000);
await stopStart;
const bres = fs.existsSync(path.join(out, 'browser.png.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'browser.png.json'), 'utf8')) : null;
const berr = fs.existsSync(path.join(out, 'browser.png.error.txt')) ? fs.readFileSync(path.join(out, 'browser.png.error.txt'), 'utf8').slice(0, 400) : '';
check('RavenBrowser starts with no login and no setup', browserDone && !!bres, berr);
if (bres) {
  check('browser discovers the address, shows a 6-digit pairing code', /^\d{6}$/.test(bres.pairingCode ?? ''), bres.pairingCode);
  check('owner approval in the dashboard brings the browser online', bres.state === 'gateway_online' && bres.route === 'gateway', `${bres.state} / ${bres.route}`);
  check('device sees only the models the server allows', JSON.stringify(bres.models) === JSON.stringify(['coder-x']), JSON.stringify(bres.models));
  check('real HTTPS site loads through the master gateway in strict gateway-only mode', bres.page?.title === 'Example Domain' && !bres.page.error && bres.page.secure, JSON.stringify(bres.page));
  check('AI answer streams from the FreeLLMAPI endpoint through the gateway', bres.ai?.end === 'done' && bres.ai.deltas >= 3 && /linked list/.test(bres.ai.answer ?? ''), `${bres.ai?.deltas} chunks, model ${bres.ai?.model?.model}`);
  check('the unified key never left the master (browser only used its device credential)', llmRequests.length >= 1 && !fs.readFileSync(path.join(out, 'browser-data', 'identity.json'), 'utf8').includes(KEY));
  check('visited page is searchable in local memory files', bres.memoryVisit);
  check('AI conversation is saved as a file and searchable', bres.memoryChat && fs.readdirSync(path.join(out, 'browser-data', 'ai-conversations')).some((f) => f.endsWith('.json')));
  check('a question typed in the search box is answered by the assistant (no search engine page opened)', bres.typedQuestion?.ended === 'done' && bres.typedQuestion.sidebar && bres.typedQuestion.internal === 'newtab', JSON.stringify(bres.typedQuestion));
  check('an errand typed in the new tab is routed by the AI to a task on the master', bres.agentFinal && bres.agentSidebar, JSON.stringify(bres.agentFinal?.steps?.slice(0, 3)));
  check('the master agent logged in, typed and sent through its hidden browser', bres.agentFinal?.status === 'done' && site.sent.includes('Hello from Raven'), JSON.stringify({ final: bres.agentFinal, sent: site.sent }));
  check('the password was asked in the browser and filled on the master, never sent to the AI', bres.agentPrompts?.includes('password') && site.passwords.includes('hunter2-secret') && !JSON.stringify(llmRequests).includes('hunter2-secret'), JSON.stringify(bres.agentPrompts));
  check("sending needed the person's approval first", bres.agentPrompts?.includes('confirm') && /Send/.test(bres.confirmDetail ?? ''), bres.confirmDetail);
  check("live view of the master's hidden page reaches the browser", bres.agentFrame > 1000, bres.agentFrame ? `${bres.agentFrame} chars` : bres.agentFrameErr);
  check('a search typed on the user PC runs on the master and the results show in Raven', bres.serpItems > 0 && /^https?:/.test(bres.serpFirst ?? ''), `${bres.serpItems} results; ${bres.serpMeta || bres.serpErr}`);
  check('a page opened on the master is shown and driven from the user PC (remote tab)', /example\.com/.test(bres.remoteFrame ?? '') && /example\.org/.test(bres.remoteNav ?? ''), `${bres.remoteFrame} -> ${bres.remoteNav}`);
  check('web search results load through the gateway (DuckDuckGo) and searches are saved to memory', !bres.ddg?.error && /linked list/i.test(bres.ddg?.title ?? '') && bres.searchSaved, JSON.stringify(bres.ddg));
  const fellBack = /duckduckgo\.com/.test(bres.google?.url ?? '');
  console.log(`INFO  Google search through the gateway: ${fellBack ? 'Google showed its robot check, so Raven opened the same search on DuckDuckGo' : 'Google results shown'}`);
  check('Gmail website is reachable (sign-in page loads)', !bres.gmail?.error && /accounts\.google\.com|mail\.google\.com|workspace\.google\.com/.test(bres.gmail?.url ?? ''), JSON.stringify(bres.gmail));
  const fr = bres.frame;
  check('the page fits exactly inside the window (no cut-off right or bottom)', fr?.bounds && fr.bounds.x + fr.bounds.width <= fr.content.width && fr.bounds.y + fr.bounds.height <= fr.content.height && Math.abs(fr.bounds.width - fr.area.w) <= 2 && Math.abs(fr.bounds.height - fr.area.h) <= 2, JSON.stringify(fr));
  check('toolbar zoom buttons: + gives 110%, two − give 90%, clicking the % resets to 100%', bres.zoomAfterIn === 110 && bres.zoomAfterOut === 90 && bres.zoomAfterReset === 100, `${bres.zoomAfterIn} / ${bres.zoomAfterOut} / ${bres.zoomAfterReset}`);
  check("Google's robot check turns into the same search on DuckDuckGo", /duckduckgo\.com\/\?q=raven/.test(bres.robotFallback ?? ''), bres.robotFallback);
  const sj = (() => { try { return JSON.parse(bres.signInJs || 'null'); } catch { return null; } })();
  check("Google sign-in page's own scripts also see Firefox (no Chromium-only features), so Google does not reject the browser", sj && /Firefox\//.test(sj.ua) && sj.uad === 'undefined' && sj.vendor === '' && sj.chrome === 'undefined' && !!sj.oscpu, bres.signInJs);
  check('Google sign-in page opens and presents as Firefox (Google blocks embedded browsers); normal pages stay Chromium', /Firefox\//.test(bres.signIn?.ua ?? '') && !/Electron/.test(bres.signIn?.ua ?? '') && /accounts\.google\./.test(bres.signIn?.url ?? '') && /Chrome\//.test(bres.uaAfterSignIn ?? '') && !/Firefox/.test(bres.uaAfterSignIn ?? ''), JSON.stringify({ signIn: bres.signIn, after: (bres.uaAfterSignIn || '').slice(-40) }));
  check('signing in offers "Save password" for the right site and username', bres.pwOffer?.username === 'alice' && /^http:\/\/127\.0\.0\.1:\d+$/.test(bres.pwOffer?.origin ?? '') && bres.pwOffer.bar && bres.pwOffer.update === false, JSON.stringify(bres.pwOffer));
  check('Save stores the login (encrypted on disk, never in clear text)', (bres.pwSaved ?? []).some((x) => x.startsWith('alice@')) && !fs.readFileSync(path.join(out, 'browser-data', 'passwords.json'), 'utf8').includes('hunter2-secret'), JSON.stringify(bres.pwSaved));
  check('clicking into the sign-in box on the next visit fills username and password', bres.pwFilled?.user === 'alice' && bres.pwFilled?.pass === 'hunter2-secret', JSON.stringify(bres.pwFilled ? { user: bres.pwFilled.user, pass: bres.pwFilled.pass ? 'filled' : 'empty' } : null));
  check("a page's own script faking a click gets nothing filled", bres.pwFakeClick === '', JSON.stringify(bres.pwFakeClick));
  const dlFile = path.join(out, 'downloads', 'rfc9110.txt');
  check('file download through the gateway lands on the client PC', bres.download?.state === 'completed' && fs.existsSync(dlFile) && fs.statSync(dlFile).size > 100_000, bres.download ? `${bres.download.state}, ${bres.download.received} bytes` : 'none');
  check('master stopped: browser notices and reports it', ['offline', 'server_unreachable', 'connecting'].includes(bres.offlineState), `${bres.offlineState} (${bres.offlineLabel})`);
  check('master stopped: AI refuses cleanly, no fake answer', bres.offlineAi && !bres.offlineAi.ok && /unreachable/i.test(bres.offlineAi.error ?? ''), bres.offlineAi?.error);
  check('master stopped + gateway-only: no silent direct browsing', !!bres.offlinePage?.error, JSON.stringify(bres.offlinePage?.error));
  check('master stopped: memory, saved chats and offline reference still work, tabs kept', bres.offlineMemory && bres.offlineConvs >= 1 && bres.offlineRef === 'c-linked-list' && bres.tabsKept >= 1);
  const idFile = JSON.parse(fs.readFileSync(path.join(out, 'browser-data', 'identity.json'), 'utf8'));
  check('browser remembers every address of the master for other networks (pinned)', Array.isArray(idFile.server?.routes) && idFile.server.routes.length > 0 && !!idFile.server.pin, JSON.stringify(idFile.server?.routes?.length));
  check('master restarted: browser reconnects by itself and browsing works again', bres.reconnected && /Example Domain/.test(bres.afterReconnect ?? ''), bres.afterReconnect);
}
if (bres) {
  check('a wrong link code is refused with a clear message', bres.linkBad && !bres.linkBad.ok && /link code/i.test(bres.linkBad.error ?? ''), bres.linkBad?.error);
  check('master unreachable + link code typed: Raven tries Raven Wi-Fi and says why it could not join', bres.link?.set && bres.link.state === 'not-found' && /not in range/.test(bres.link.error ?? ''), JSON.stringify(bres.link));
  check('the connection page shows Raven Wi-Fi with Change code, and removing the code brings back the code box', bres.linkUiSet && bres.linkForgot, JSON.stringify({ set: bres.linkUiSet, forgot: bres.linkForgot }));
  check('typing the code while already online saves it without switching Wi-Fi', bres.linkWhileOnline?.set && bres.linkWhileOnline.state === 'idle' && bres.linkWhileOnline.conn === 'gateway_online', JSON.stringify(bres.linkWhileOnline));
  const idf = fs.readFileSync(path.join(out, 'browser-data', 'identity.json'), 'utf8');
  check('the link code is stored encrypted on the user PC', /"linkEnc"/.test(idf) && !/K7QM2/.test(idf));
}
check('master was restarted during the run', restarted);

// Phase 4: this PC moved to another network, so the address it used no longer answers.
// It must find the master at another address the master told it about, with the same pinned identity.
await sleep(3000);
const idPath = path.join(out, 'browser-data', 'identity.json');
const idBefore = JSON.parse(fs.readFileSync(idPath, 'utf8'));
if (idBefore.server) {
  idBefore.server.port = await freePort();
  fs.writeFileSync(idPath, JSON.stringify(idBefore, null, 2));
}
const movedScript = `(async () => {
  const inv = window.raven.invoke;
  let app = (await inv('init')).data.app;
  window.raven.on('raven:app', (a) => (app = a));
  const t = Date.now();
  while (app.conn.state !== 'gateway_online' && Date.now() - t < 60000) await new Promise((r) => setTimeout(r, 200));
  return { state: app.conn.state, ms: Date.now() - t };
})()`;
run('raven-browser', { RAVEN_DATA_DIR: path.join(out, 'browser-data'), RAVEN_SHOT: path.join(out, 'moved.png'), RAVEN_SHOT_DELAY: '1500', RAVEN_SHOT_SCRIPT: movedScript }, 'browser-moved');
await waitFile(path.join(out, 'moved.png'), 100_000);
const moved = fs.existsSync(path.join(out, 'moved.png.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'moved.png.json'), 'utf8')) : null;
const idAfter = JSON.parse(fs.readFileSync(idPath, 'utf8'));
check('after a network change the browser finds the master at another address it learned (pin kept)', moved?.state === 'gateway_online' && idAfter.server?.port === gwPort && idAfter.server?.pin === idBefore.server?.pin, moved ? `${moved.state} in ${moved.ms} ms` : 'no result');

// Master-side evidence: traffic was counted for this device.
await sleep(1500);
masterProc.kill();
await sleep(1500);
const devFile = path.join(out, 'master-data', 'MasterServerData', 'devices.json');
const devs = fs.existsSync(devFile) ? JSON.parse(fs.readFileSync(devFile, 'utf8')).devices : [];
check('master recorded the approved device, its traffic and its AI request', devs.length === 1 && devs[0].status === 'approved' && devs[0].totalDown > 500 && devs[0].aiRequests >= 1, devs[0] ? `down ${devs[0].totalDown} B, ai ${devs[0].aiRequests}` : 'no device');
const secretsTxt = fs.readFileSync(path.join(out, 'master-data', 'MasterServerData', 'secrets.json'), 'utf8');
check('unified key is stored encrypted on the master (not in clear text)', !secretsTxt.includes(KEY) && secretsTxt.includes('enc:'));
const logs = fs.readdirSync(path.join(out, 'master-data', 'MasterServerData', 'logs')).map((f) => fs.readFileSync(path.join(out, 'master-data', 'MasterServerData', 'logs', f), 'utf8')).join('\n');
check('master logs contain no secret', !logs.includes(KEY));

browser.kill();
llm.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} end-to-end checks passed`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
