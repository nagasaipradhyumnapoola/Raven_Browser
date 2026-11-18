// Live check with REAL AI models: the master uses the owner's real provider (copied profile in build/real-test),
// and a real Raven Browser asks real questions, lets the AI router decide, and runs a real task on a real website.
//   node scripts/e2e-real.mjs      (needs build/real-test/master: a copy of a configured master profile)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const base = path.join(root, 'build', 'real-test');
const out = path.join(base, 'run');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const gwPort = await freePort();
const run = (app, env) => spawn(electron, [path.join(root, 'build', app)], { env: { ...process.env, RAVEN_HEADLESS: '1', RAVEN_FAKE_HOTSPOT: '1', ...env }, stdio: 'ignore', windowsHide: true });
const waitFile = async (f, ms) => { const t = Date.now(); while (!fs.existsSync(f) && Date.now() - t < ms) await sleep(500); await sleep(300); return fs.existsSync(f); };

// ---------------------------------------------------------------- master on the copied real profile
const masterScript = `(async () => {
  const inv = window.raven.invoke;
  await inv('updateConfig', { setupDone: true, port: ${gwPort} });
  let s;
  for (let i = 0; i < 60; i++) { await inv('aiRefresh'); s = (await inv('state')).data; if (s.ai.health === 'ok' && s.models.some(m => m.available)) break; await new Promise(r => setTimeout(r, 1000)); }
  setInterval(async () => { const st = (await inv('state')).data; for (const d of st.devices) if (d.status === 'pending') await inv('approveDevice', d.id); }, 500);
  return { health: s.ai.health, providers: s.ai.providers.map(p => ({ name: p.name, health: p.health, models: p.models })), ready: s.models.filter(m => m.available).length, error: s.ai.lastError };
})()`;
const master = run('master-server', { RAVEN_USER_DATA: path.join(base, 'master'), RAVEN_BIND: '127.0.0.1', RAVEN_NO_UPNP: '1', RAVEN_SHOT: path.join(out, 'master.png'), RAVEN_SHOT_DELAY: '3000', RAVEN_SHOT_EXIT: '0', RAVEN_SHOT_SCRIPT: masterScript });
await waitFile(path.join(out, 'master.png'), 120_000);
const m = fs.existsSync(path.join(out, 'master.png.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'master.png.json'), 'utf8')) : null;
check('the new master takes over the owner\'s existing AI setup and its provider answers', m?.health === 'ok' && m.ready > 0, JSON.stringify(m));

// ---------------------------------------------------------------- real browser, real models
const browserScript = `(async () => {
  const inv = window.raven.invoke;
  const result = {};
  let app = (await inv('init')).data.app;
  let win = (await inv('init')).data.win;
  window.raven.on('raven:app', (a) => (app = a));
  window.raven.on('raven:win', (w) => (win = w));
  const until = async (cond, ms, what) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout: ' + what); await new Promise(r => setTimeout(r, 200)); } };
  await inv('settings', { strictGateway: true, restoreSession: false });
  await inv('connectAddress', '127.0.0.1:${gwPort}', false);
  await until(() => app.conn.state === 'gateway_online', 60000, 'online');
  // 1. A real chat answer.
  const events = [];
  window.raven.on('raven:chat', (e) => events.push(e));
  await inv('aiSend', { conversationId: null, history: [], text: 'What is the capital of France? Reply with one word only.', context: [], model: 'auto', mode: 'general' });
  await until(() => events.some(e => e.t === 'done' || e.t === 'error'), 120000, 'chat');
  const end = events.find(e => e.t === 'done' || e.t === 'error');
  result.chat = { end: end.t, answer: end.t === 'done' && end.conversation ? end.conversation.messages.at(-1).content.slice(0, 200) : null, code: end.code, message: end.message, model: (events.find(e => e.t === 'start') || {}).meta };
  // 2. The real AI router.
  result.route = {};
  for (const q of ['what is a linked list in C', 'open youtube', 'best budget laptops 2026 reviews', 'go to wikipedia and find out the year Alan Turing was born']) {
    const r = await inv('route', q);
    result.route[q] = r.ok ? r.data : { error: r.error };
  }
  // 3. Real search through the master.
  const sr = await inv('masterSearch', 'Alan Turing', 0);
  result.search = sr.ok ? { n: sr.data.results.length, engine: sr.data.engine, first: sr.data.results[0] && sr.data.results[0].site } : { error: sr.error };
  // 4. A real task on a real website, driven by the real model.
  const seen = [];
  let id1 = null;
  const off = window.raven.on('raven:agent', async (t) => {
    if (t.kind === 'remote' || (id1 && t.id !== id1)) return;
    result.taskId = t.id;
    if (t.prompt && t.status === 'waiting') {
      seen.push(t.prompt.kind + ': ' + t.prompt.detail.slice(0, 120));
      // Acting as a careful person: decline anything that would send or change something; skip questions.
      await inv('agentAnswer', t.id, t.prompt.id, false);
    }
    if (['done', 'failed', 'cancelled'].includes(t.status)) result.task = { status: t.status, answer: (t.answer || '').slice(0, 300), steps: t.steps.map(s => s.text) };
  });
  const st = await inv('agentStart', 'Open https://en.wikipedia.org/wiki/Alan_Turing and tell me the year Alan Turing was born.');
  id1 = st.ok ? st.data.id : null;
  result.taskStart = st.ok ? 'started' : st.error;
  if (st.ok) await until(() => result.task, 300000, 'task').catch(() => (result.task = result.task || { status: 'timeout' }));
  if (result.taskId) {
    const f = await inv('agentFrame', result.taskId);
    result.frameUrl = f.ok ? f.data.url : f.error;
  }
  result.prompts = seen;
  off();
  // 5. A harder real task: use the site's search box, open the result, read it.
  result.task2 = null;
  let id2 = null;
  const off2 = window.raven.on('raven:agent', async (t) => {
    if (t.kind === 'remote' || (id2 && t.id !== id2) || t.id === result.taskId) return;
    if (t.prompt && t.status === 'waiting') { seen.push('task2 ' + t.prompt.kind + ': ' + t.prompt.detail.slice(0, 120)); await inv('agentAnswer', t.id, t.prompt.id, false); }
    if (['done', 'failed', 'cancelled'].includes(t.status)) result.task2 = { status: t.status, answer: (t.answer || '').slice(0, 300), steps: t.steps.map(s => s.text) };
  });
  const st2 = await inv('agentStart', 'Go to https://en.wikipedia.org, use the search box to search for Ada Lovelace, open her article and tell me the year she was born.');
  id2 = st2.ok ? st2.data.id : null;
  if (st2.ok) await until(() => result.task2, 400000, 'task2').catch(() => (result.task2 = result.task2 || { status: 'timeout' }));
  off2();
  return result;
})()`;
const browser = run('raven-browser', { RAVEN_DATA_DIR: path.join(out, 'browser-data'), RAVEN_SHOT: path.join(out, 'browser.png'), RAVEN_SHOT_DELAY: '3000', RAVEN_SHOT_SCRIPT: browserScript });
await waitFile(path.join(out, 'browser.png'), 600_000);
const b = fs.existsSync(path.join(out, 'browser.png.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'browser.png.json'), 'utf8')) : null;
const berr = fs.existsSync(path.join(out, 'browser.png.error.txt')) ? fs.readFileSync(path.join(out, 'browser.png.error.txt'), 'utf8').slice(0, 300) : '';
check('a real model answers a question through the gateway', b?.chat?.end === 'done' && /paris/i.test(b.chat.answer ?? ''), JSON.stringify(b?.chat ?? berr));
const r = b?.route ?? {};
check('the real AI router answers a question in chat', r['what is a linked list in C']?.action === 'answer', JSON.stringify(r['what is a linked list in C']));
check('the real AI router opens a site', r['open youtube']?.action === 'open' && /youtube/.test(r['open youtube'].url ?? ''), JSON.stringify(r['open youtube']));
check('the real AI router searches', r['best budget laptops 2026 reviews']?.action === 'search', JSON.stringify(r['best budget laptops 2026 reviews']));
check('the real AI router turns an errand into a task', r['go to wikipedia and find out the year Alan Turing was born']?.action === 'task', JSON.stringify(r['go to wikipedia and find out the year Alan Turing was born']));
check('a real search runs on the master', b?.search?.n > 0, JSON.stringify(b?.search));
check('a real task on a real website, driven by the real model, gets the right answer', b?.task?.status === 'done' && /1912/.test(b.task.answer ?? ''), JSON.stringify({ task: b?.task, start: b?.taskStart, prompts: b?.prompts, at: b?.frameUrl }));

check('a harder real task (site search box, open result, read) works with the real model', b?.task2?.status === 'done' && /1815/.test(b.task2.answer ?? ''), JSON.stringify(b?.task2));

browser.kill();
master.kill();
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, master: m, browser: b }, null, 2));
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed`);
process.exit(0);
