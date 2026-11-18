// Visual check of every page of both apps: screenshots plus an automatic overlap detector.
//   node scripts/ui-audit.mjs     -> build/ui-audit/<page>.png and report.json
// Flags: text boxes that overlap other text, elements wider than the window, clipped text in buttons/labels.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const out = path.join(root, 'build', 'ui-audit');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const DETECT = `(() => {
  const W = innerWidth, H = innerHeight;
  const vis = (el) => { const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < H; };
  const label = (el) => (el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + ' "' + (el.innerText || '').trim().slice(0, 30) + '"');
  // Leaf elements that show text.
  const leaves = [...document.querySelectorAll('body *')].filter((el) => vis(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !el.closest('svg, canvas, .ascii-map'));
  const issues = [];
  for (const el of leaves) {
    const r = el.getBoundingClientRect();
    if (r.right > W + 1 && !el.closest('.nav, .tabs, .table, pre, .serp-list')) issues.push('beyond right edge: ' + label(el));
    const cs = getComputedStyle(el);
    if ((el.closest('button, .chip, .btn, .label, .tab') || cs.whiteSpace === 'nowrap') && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && !cs.maskImage?.includes('gradient') && !cs.webkitMaskImage?.includes('gradient') && cs.overflow !== 'visible') issues.push('clipped text: ' + label(el));
  }
  for (let i = 0; i < leaves.length; i++) {
    const a = leaves[i].getBoundingClientRect();
    for (let j = i + 1; j < leaves.length; j++) {
      const A = leaves[i], B = leaves[j];
      if (A.contains(B) || B.contains(A)) continue;
      const b = B.getBoundingClientRect();
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 4 && y > 4) issues.push('overlap: ' + label(A) + ' <> ' + label(B));
    }
  }
  if (document.documentElement.scrollWidth > W + 1) issues.push('page scrolls sideways: ' + document.documentElement.scrollWidth + ' > ' + W);
  return { width: W, height: H, issues: [...new Set(issues)].slice(0, 40) };
})()`;

function shot(app, name, setup, env = {}) {
  return new Promise((resolve) => {
    const file = path.join(out, `${name}.png`);
    const script = `(async () => { ${setup}; await new Promise((r) => setTimeout(r, 900)); return ${DETECT}; })()`;
    const p = spawn(electron, [path.join(root, 'build', app)], {
      env: {
        ...process.env,
        RAVEN_HEADLESS: '1',
        RAVEN_FAKE_HOTSPOT: '1',
        RAVEN_BIND: '127.0.0.1',
        RAVEN_NO_UPNP: '1',
        RAVEN_USER_DATA: path.join(root, 'build', 'dev-master'),
        RAVEN_DATA_DIR: path.join(root, 'build', 'dev-browser'),
        RAVEN_SHOT: file,
        RAVEN_SHOT_DELAY: '3500',
        RAVEN_SHOT_WAIT: '300',
        RAVEN_SHOT_SCRIPT: script,
        ...env,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on('exit', () => {
      clearTimeout(timer);
      const j = fs.existsSync(file + '.json') ? JSON.parse(fs.readFileSync(file + '.json', 'utf8')) : { issues: ['no result: ' + (fs.existsSync(file + '.error.txt') ? fs.readFileSync(file + '.error.txt', 'utf8').slice(0, 200) : 'crashed')] };
      resolve({ name, ...j });
    });
  });
}

const click = (text) => `{ const b = [...document.querySelectorAll('button, a')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); await new Promise((r) => setTimeout(r, 500)); }`;
const masterPages = ['Overview', 'Server control', 'Devices', 'Internet gateway', 'AI providers', 'Models', 'Logs', 'Settings'];
const report = [];
for (const pg of masterPages) {
  report.push(await shot('master-server', `master-${pg.toLowerCase().replace(/\s+/g, '-')}`, `await window.raven.invoke('updateConfig', { setupDone: true }); await new Promise((r) => setTimeout(r, 300)); ${click(pg)}`));
}
const inv = (m, ...a) => `await window.raven.invoke(${JSON.stringify(m)}${a.map((x) => ', ' + JSON.stringify(x)).join('')})`;
const browserPages = [
  ['browser-newtab', ''],
  ['browser-many-tabs', `for (let i = 0; i < 9; i++) ${inv('newTab', 'raven://newtab')}; ${inv('newTab', 'raven://settings')}`],
  ['browser-assistant', `${inv('sidebar', true)}`],
  ['browser-tasks', `${inv('sidebar', true)}; await new Promise((r) => setTimeout(r, 400)); { const b = [...document.querySelectorAll('.tabsw button')].find((x) => x.textContent.startsWith('Tasks')); if (b) b.click(); }`],
  ['browser-settings', `${inv('navigate', 'raven://settings')}`],
  ['browser-history', `${inv('navigate', 'raven://history')}`],
  ['browser-bookmarks', `${inv('navigate', 'raven://bookmarks')}`],
  ['browser-downloads', `${inv('navigate', 'raven://downloads')}`],
  ['browser-memory', `${inv('navigate', 'raven://memory')}`],
  ['browser-reference', `${inv('navigate', 'raven://reference')}`],
  ['browser-search', `${inv('navigate', 'raven://search?q=linked%20list%20in%20C')}`],
  ['browser-menu', `{ const b = document.querySelector('.toolbar .icon-btn[title*="enu"], .toolbar button[aria-label*="enu"]') || [...document.querySelectorAll('.toolbar button')].at(-1); b && b.click(); }`],
];
for (const [name, setup] of browserPages) report.push(await shot('raven-browser', name, setup));

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
let bad = 0;
for (const r of report) {
  const n = r.issues?.length ?? 0;
  bad += n;
  console.log(`${n ? 'ISSUES' : 'OK    '}  ${r.name}${r.width ? ` (${r.width}x${r.height})` : ''}`);
  for (const i of r.issues ?? []) console.log(`        - ${i}`);
}
console.log(`\n${report.length} screens, ${bad} issue(s)`);
