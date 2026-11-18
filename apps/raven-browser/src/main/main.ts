// Raven Browser main process.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net as enet, Notification, powerMonitor, session as esession, shell, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { RavenError, isSignInUrl, signInHeaders, type ErrCode } from '@raven/shared';
import { generateDeviceKeyPair, signTranscript } from '@raven/security';
import { MemoryStore, searchReference, type ChatMessage, type MemKind } from '@raven/local-memory';
import { isPlainObject } from '@raven/shared';
import { atomicWriteSync, isWritableDir, readJsonSync } from '../../../../packages/local-memory/src/fsutil';
import { ConnectionManager } from './connection';
import { ChatRunner, extractPage, extractSelection, isSensitiveUrl } from './ai';
import { shouldBlock } from './adblock';
import { DATA_FOLDER, IdentityStore, SettingsStore, exeDir, resolveDataRoot } from './store';
import { Win, type Host } from './windows';
import { PasswordStore, passwordOriginAllowed } from './passwords';
import type { AppState, BrowserSettings, ChatEvent, InvokeResult, PageContext } from '../types';

const VERSION = process.env.RAVEN_VERSION ?? '0.0.0';
const isDev = !app.isPackaged;

// ---------------------------------------------------------------- data location (before app ready)
const { root: dataRoot, portable } = resolveDataRoot();
fs.mkdirSync(dataRoot, { recursive: true });
app.setPath('userData', path.join(dataRoot, 'profile'));
app.setPath('sessionData', path.join(dataRoot, 'profile'));
app.setName('Raven Browser');
app.setAppUserModelId('app.raven.browser');
// No background networking of Chromium's own (sign-in, sync, safe-browsing pings, etc.).
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
// Off-screen test runs: Windows marks a window at -32000 as hidden and Chromium would stop handing it input.
if (process.env.RAVEN_HEADLESS === '1') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}
// Present a standard Chrome user agent: Electron's default adds "Electron/x" and the app name,
// which some sites (search engines, sign-in pages) treat as an automated client.
app.userAgentFallback = app.userAgentFallback.replace(/\s(raven-browser|Raven ?Browser)\/\S+/gi, '').replace(/\sElectron\/\S+/g, '');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let settings: SettingsStore;
let identity: IdentityStore;
let conn: ConnectionManager;
let memory: MemoryStore;
let chat: ChatRunner;
let passwords: PasswordStore;
let memoryWarning: string | null = null;
let quitting = false;
const windows = new Map<number, Win>();
let privateSeq = 1;
const sessionsSetUp = new WeakSet<Session>();
const permissionsFile = () => path.join(dataRoot, 'permissions.json');
let permissions: Record<string, Record<string, 'allow' | 'deny'>> = {};
const downloads = new Map<string, { item: Electron.DownloadItem; winId: number; private: boolean }>();
const privateDownloads = new Map<string, any>();

// ---------------------------------------------------------------- memory location
function openMemory(dir: string): MemoryStore {
  let target = dir;
  memoryWarning = null;
  if (!isWritableDir(target)) {
    memoryWarning = `The memory folder ${dir} is not available (drive removed or read-only). Raven is using ${dataRoot} until it comes back. Nothing was deleted.`;
    target = dataRoot;
  }
  const m = new MemoryStore(target);
  void m.init();
  return m;
}

// ---------------------------------------------------------------- host for windows
function engineUrl(q: string): string {
  const s = settings.value;
  const enc = encodeURIComponent(q);
  // Connected to a master that gives this PC internet: the master searches, Raven shows the results.
  const srv = conn?.client.online ? conn.client.state : null;
  if (s.masterSearch && srv && srv.permissions.internet && srv.services.internet && !srv.services.maintenance) return `raven://search?q=${enc}`;
  switch (s.searchEngine) {
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${enc}`;
    case 'bing':
      return `https://www.bing.com/search?q=${enc}`;
    case 'brave':
      return `https://search.brave.com/search?q=${enc}`;
    case 'custom':
      return s.customSearch.includes('%s') ? s.customSearch.replace('%s', enc) : `https://www.google.com/search?q=${enc}`;
    default:
      return `https://www.google.com/search?q=${enc}`;
  }
}

const host: Host = {
  memory: () => memory,
  historyAllowed: (priv) => !priv && !settings.value.pauseHistory,
  searchUrl: engineUrl,
  engineName: () => settings.value.searchEngine,
  lastProxyError: (h) => {
    const e = conn.proxy.lastError;
    return e && Date.now() - e.at < 10_000 && (!h || e.host === h) ? e.code : e && Date.now() - e.at < 3000 ? e.code : null;
  },
  onWindowsChanged: () => {
    for (const [id, w] of windows) if (w.window.isDestroyed()) windows.delete(id);
    saveSessionNow();
    if (windows.size === 0 && !quitting) app.quit();
  },
  openWindow: (o) => openWindow(o),
  saveSession: () => scheduleSessionSave(),
  askAi: (w, action, text) => {
    w.sidebar = true;
    w.changed();
    w.window.webContents.send('raven:ai-action', { action, text: text ?? '' });
  },
  webrtcPolicy: () => (settings.value.strictGateway || conn?.route === 'gateway' ? 'disable_non_proxied_udp' : 'default'),
  fetchFavicon: async (ses, url) => {
    try {
      const res = await ses.fetch(url, { signal: AbortSignal.timeout(6000) } as any);
      if (!res.ok) return null;
      const type = res.headers.get('content-type') ?? 'image/x-icon';
      if (!/^image\//.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 200_000) return null;
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  },
  setupSession: (ses) => setupSession(ses),
  isDev,
  dir: __dirname,
};

// ---------------------------------------------------------------- sessions
const PERMISSIONS_AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'window-management']);
const PERMISSIONS_ASK = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'display-capture', 'idle-detection', 'speaker-selection', 'storage-access', 'top-level-storage-access', 'fileSystem', 'hid', 'serial', 'usb']);

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function permKey(permission: string, details: any): string {
  if (permission === 'media') {
    const types: string[] = details?.mediaTypes ?? [];
    if (types.includes('video') && types.includes('audio')) return 'camera+microphone';
    if (types.includes('video')) return 'camera';
    return 'microphone';
  }
  return permission;
}

async function setupSession(ses: Session): Promise<void> {
  if (sessionsSetUp.has(ses)) return;
  sessionsSetUp.add(ses);
  // Every connection the web page makes goes through Raven's loopback proxy,
  // which decides: master gateway, direct, or refused.
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${conn.proxy.port}`, proxyBypassRules: '<local>' });
  ses.setSpellCheckerLanguages(['en-US']);
  // Login capture and fill (isolated from the page's own scripts; see preload-page.ts).
  const pagePreload = path.join(__dirname, 'preload-page.cjs');
  if (typeof (ses as any).registerPreloadScript === 'function') (ses as any).registerPreloadScript({ type: 'frame', id: 'raven-page', filePath: pagePreload });
  else ses.setPreloads([pagePreload]);
  ses.setUserAgent(app.userAgentFallback, 'en-US,en;q=0.9');
  // Chromium stops sending User-Agent Client Hints once the user agent is overridden; real Chrome
  // always sends the low-entropy ones, and their absence makes some sites treat Raven as a bot.
  const major = /Chrome\/(\d+)/.exec(app.userAgentFallback)?.[1] ?? '130';
  const hints: Record<string, string> = {
    'sec-ch-ua': `"Chromium";v="${major}", "Not_A Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': process.platform === 'darwin' ? '"macOS"' : process.platform === 'linux' ? '"Linux"' : '"Windows"',
  };
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, cb) => {
    // Google sign-in: present as Firefox (Google blocks sign-in from "embedded" browsers).
    if (isSignInUrl(details.url) || (details.webContents && !details.webContents.isDestroyed() && isSignInUrl(details.webContents.getURL()))) {
      return cb({ requestHeaders: signInHeaders(details.requestHeaders) });
    }
    const h = details.requestHeaders;
    for (const [k, v] of Object.entries(hints)) if (!Object.keys(h).some((x) => x.toLowerCase() === k)) h[k] = v;
    cb({ requestHeaders: h });
  });
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (PERMISSIONS_AUTO_ALLOW.has(permission)) return callback(true);
    const origin = originOf(details.requestingUrl ?? wc.getURL());
    const key = permKey(permission, details);
    if (!PERMISSIONS_ASK.has(permission) || !origin) return callback(false);
    const remembered = permissions[origin]?.[key];
    if (remembered) return callback(remembered === 'allow');
    const w = [...windows.values()].find((x) => x.tabFor(wc));
    const tab = w?.tabFor(wc);
    if (!w || !tab) return callback(false);
    void w.askPermission(tab.id, origin, key).then(({ ok, remember }) => {
      if (remember && !w.private) {
        permissions[origin] = { ...(permissions[origin] ?? {}), [key]: ok ? 'allow' : 'deny' };
        atomicWriteSync(permissionsFile(), JSON.stringify(permissions, null, 2));
      }
      callback(ok);
    });
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (PERMISSIONS_AUTO_ALLOW.has(permission)) return true;
    const key = permKey(permission, details);
    return permissions[requestingOrigin]?.[key] === 'allow';
  });
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    if (!settings.value.adblock || details.resourceType === 'mainFrame') return cb({});
    const pageUrl = details.webContents?.getURL() || details.referrer;
    if (shouldBlock(details.url, pageUrl, settings.value.adblockAllow)) {
      const wc = details.webContents;
      if (wc) {
        for (const w of windows.values()) {
          const t = w.tabFor(wc);
          if (t) {
            t.blocked++;
            w.changed();
          }
        }
      }
      return cb({ cancel: true });
    }
    cb({});
  });
  ses.on('will-download', (_e, item, wc) => onDownload(ses, item, wc));
}

// ---------------------------------------------------------------- downloads
const EXECUTABLE = /\.(exe|msi|msix|appx|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|jar|lnk|reg|pif|application|gadget|msc)$/i;

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p) && i < 1000; i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function onDownload(ses: Session, item: Electron.DownloadItem, wc: Electron.WebContents | undefined): void {
  const win = [...windows.values()].find((w) => w.session === ses) ?? [...windows.values()][0];
  const isPrivate = !!win?.private;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const name = item.getFilename().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
  const dir = settings.value.downloadDir && isWritableDir(settings.value.downloadDir) ? settings.value.downloadDir : app.getPath('downloads');
  if (settings.value.askWhereToSave) item.setSaveDialogOptions({ defaultPath: path.join(dir, name), title: 'Save download' });
  else item.setSavePath(uniquePath(dir, name));
  downloads.set(id, { item, winId: win?.id ?? 0, private: isPrivate });
  const rec = () => ({
    id,
    ts: item.getStartTime() * 1000 || Date.now(),
    url: item.getURL(),
    filename: path.basename(item.getSavePath() || name),
    path: item.getSavePath(),
    size: item.getTotalBytes(),
    received: item.getReceivedBytes(),
    state: item.getState() as 'progressing' | 'completed' | 'cancelled' | 'interrupted',
    mime: item.getMimeType(),
    paused: item.isPaused(),
    canResume: item.canResume(),
    ...(item.getState() === 'completed' ? { done: Date.now() } : {}),
  });
  let started = false;
  let last = 0;
  item.on('updated', () => {
    if (!item.getSavePath()) return; // still in the save dialog
    const r = rec();
    if (!started) {
      started = true;
      if (isPrivate) privateDownloads.set(id, r);
      else memory.recordDownload(r);
    } else if (Date.now() - last > 400) {
      last = Date.now();
      if (isPrivate) privateDownloads.set(id, r);
      else memory.recordDownload(r);
    }
    pushApp();
  });
  item.once('done', () => {
    const r = rec();
    if (!item.getSavePath()) {
      downloads.delete(id);
      return; // cancelled in the save dialog
    }
    if (isPrivate) privateDownloads.set(id, r);
    else memory.recordDownload(r);
    pushApp();
    if (r.state === 'completed' && win && !win.window.isDestroyed()) win.window.webContents.send('raven:toast', { text: `Downloaded ${r.filename}`, tone: 'ok' });
  });
  void wc;
}

// ---------------------------------------------------------------- windows + session restore
interface SavedSession {
  windows: { tabs: { url: string; pinned: boolean }[]; active: number; bounds?: Electron.Rectangle; sidebar?: boolean }[];
}
let sessionTimer: NodeJS.Timeout | null = null;
function scheduleSessionSave(): void {
  if (sessionTimer) return;
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    saveSessionNow();
  }, 1500);
}
function saveSessionNow(): void {
  if (quitting && windows.size === 0) return;
  const data: SavedSession = { windows: [] };
  for (const w of windows.values()) {
    if (w.private || w.window.isDestroyed()) continue;
    const tabs = w.tabs.map((t) => ({ url: t.internal ? t.url : t.wc?.getURL() || t.url, pinned: t.pinned })).filter((t) => t.url);
    if (!tabs.length) continue;
    data.windows.push({ tabs, active: Math.max(0, w.tabs.findIndex((t) => t.id === w.activeId)), bounds: w.window.getNormalBounds(), sidebar: w.sidebar });
  }
  const file = path.join(dataRoot, 'session.json');
  if (!settings.value.restoreSession) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (data.windows.length) atomicWriteSync(file, JSON.stringify(data, null, 2));
}

function openWindow(opts: { private?: boolean; urls?: string[]; restore?: SavedSession['windows'][number] }): Win {
  const ses = opts.private ? esession.fromPartition(`raven-private-${privateSeq++}`, { cache: false }) : esession.fromPartition('persist:raven');
  void setupSession(ses);
  const w = new Win(host, ses, !!opts.private);
  windows.set(w.id, w);
  if (opts.restore) {
    if (opts.restore.bounds) w.window.setBounds(opts.restore.bounds);
    w.sidebar = !!opts.restore.sidebar;
    for (const t of opts.restore.tabs) w.newTab({ url: t.url, pinned: t.pinned, background: true });
    const target = w.tabs[Math.min(opts.restore.active, w.tabs.length - 1)];
    if (target) w.activate(target.id);
  } else if (opts.urls?.length) {
    for (const u of opts.urls) w.newTab({ url: u });
  } else {
    w.newTab({ url: 'raven://newtab' });
  }
  w.window.webContents.once('did-finish-load', () => {
    pushApp();
    w.changed();
  });
  return w;
}

function winFor(sender: Electron.WebContents): Win | undefined {
  for (const w of windows.values()) if (!w.window.isDestroyed() && w.window.webContents === sender) return w;
  return undefined;
}

// ---------------------------------------------------------------- app state broadcast
let appQueued = false;
function appState(): AppState {
  const latest = conn.client.state?.latestBrowserVersion;
  const newer = latest && latest.localeCompare(VERSION, undefined, { numeric: true }) > 0 ? latest : null;
  return {
    version: VERSION,
    conn: conn.view(),
    settings: settings.value,
    memoryRoot: memory.root,
    memoryWarning,
    downloads: [...memory.listDownloads(), ...privateDownloads.values()]
      .map((d) => {
        const live = downloads.get(d.id);
        return live ? { ...d, received: live.item.getReceivedBytes(), size: live.item.getTotalBytes(), state: live.item.getState(), paused: live.item.isPaused() } : d;
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 200) as any,
    updateAvailable: newer,
    dataRoot,
    portable,
  };
}
function pushApp(): void {
  if (appQueued) return;
  appQueued = true;
  setTimeout(() => {
    appQueued = false;
    const s = appState();
    for (const w of windows.values()) if (!w.window.isDestroyed()) w.window.webContents.send('raven:app', s);
  }, 50);
}

// ---------------------------------------------------------------- passwords
interface PendingPassword {
  id: number;
  origin: string;
  username: string;
  password: string;
}
const pendingPasswords = new Map<number, PendingPassword>();
let pwSeq = 1;
/** Usernames typed on an earlier step of a multi-step sign-in, per tab and site (kept 10 minutes). */
const lastUsernames = new Map<string, { value: string; at: number }>();

/** The site a page message really comes from: decided here from the frame, never from what the page says. */
function frameOrigin(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): string | null {
  const o = e.senderFrame?.origin;
  return o && o !== 'null' && passwordOriginAllowed(o) ? o : null;
}

function setupPasswordIpc(): void {
  ipcMain.on('raven-page:username', (e, value: unknown) => {
    const origin = frameOrigin(e);
    if (!origin || typeof value !== 'string' || !value.trim()) return;
    lastUsernames.set(`${e.sender.id}|${origin}`, { value: value.trim().slice(0, 200), at: Date.now() });
  });

  ipcMain.on('raven-page:submitted', (e, p: unknown) => {
    const origin = frameOrigin(e);
    if (!origin || !isPlainObject(p) || typeof p.password !== 'string' || !p.password) return;
    const w = [...windows.values()].find((x) => x.tabFor(e.sender));
    const tab = w?.tabFor(e.sender);
    if (!w || !tab || w.private || passwords.isNever(origin)) return;
    let username = typeof p.username === 'string' ? p.username.trim().slice(0, 200) : '';
    const earlier = lastUsernames.get(`${e.sender.id}|${origin}`);
    if (!username && earlier && Date.now() - earlier.at < 10 * 60_000) username = earlier.value;
    const password = p.password.slice(0, 1000);
    const kind = passwords.check(origin, username, password);
    if (kind === 'same') {
      const hit = passwords.forOrigin(origin).find((l) => l.username === username);
      if (hit) passwords.touch(hit.id);
      return;
    }
    if (w.pwOffer) pendingPasswords.delete(w.pwOffer.id);
    const id = pwSeq++;
    pendingPasswords.set(id, { id, origin, username, password });
    w.pwOffer = { id, tabId: tab.id, origin, username, update: kind === 'update' };
    w.changed();
    // An unanswered offer goes away after 2 minutes, password and all.
    setTimeout(() => {
      if (pendingPasswords.delete(id) && w.pwOffer?.id === id) {
        w.pwOffer = null;
        w.changed();
      }
    }, 120_000).unref?.();
  });

  ipcMain.handle('raven-page:fill', async (e, p: unknown) => {
    const origin = frameOrigin(e);
    if (!origin) return null;
    const w = [...windows.values()].find((x) => x.tabFor(e.sender));
    if (!w) return null;
    const logins = passwords.forOrigin(origin);
    if (!logins.length) return null;
    let pick = logins[0];
    if (logins.length > 1) {
      // Several accounts on this site: let the person choose, right under the field.
      const at = isPlainObject(p) ? p : {};
      const view = (w.tabFor(e.sender) as any)?.view?.getBounds?.() ?? { x: 0, y: 0 };
      pick = await new Promise((resolve) => {
        let chosen: typeof logins[number] | null = null;
        const menu = Menu.buildFromTemplate([
          ...logins.map((l) => ({ label: l.username || '(no username)', click: () => (chosen = l) })),
        ]);
        menu.popup({ window: w.window, x: Math.round(view.x + Number(at.x ?? 0)), y: Math.round(view.y + Number(at.y ?? 0)), callback: () => resolve(chosen as any) });
      });
      if (!pick) return null;
    }
    const password = passwords.reveal(pick.id);
    if (password === null) return null;
    passwords.touch(pick.id);
    return { username: pick.username, password };
  });
}

// ---------------------------------------------------------------- IPC
async function masterRpc(method: string, params: unknown, timeout = 15_000): Promise<unknown> {
  if (!conn.client.online) throw new Error('Not connected to the master server.');
  try {
    return await conn.client.rpc(method, params, timeout);
  } catch (e) {
    const err = e as { code?: ErrCode; message?: string };
    // The master's own explanation follows "code: "; fall back to the standard text for the code.
    const detail = err.message && err.code && err.message.startsWith(`${err.code}: `) ? err.message.slice(err.code.length + 2) : '';
    throw new Error(detail || (err.code && err.code !== 'internal' ? new RavenError(err.code).message : 'The master could not do that.'));
  }
}

/** Agent updates from the master go to every normal window; a question gets a desktop notice if no window is focused. */
const notified = new Set<string>();
function onMasterEvent(ev: any): void {
  if (!ev || ev.kind !== 'agent' || !ev.task) return;
  for (const w of windows.values()) if (!w.window.isDestroyed() && !w.private) w.window.webContents.send('raven:agent', ev.task);
  const p = ev.task.prompt;
  if (p && !notified.has(p.id)) {
    notified.add(p.id);
    const focused = [...windows.values()].some((w) => !w.window.isDestroyed() && w.window.isFocused());
    if (!focused && Notification.isSupported() && process.env.RAVEN_HEADLESS !== '1') {
      const n = new Notification({ title: p.kind === 'password' ? `Password needed for ${p.site}` : p.kind === 'confirm' ? 'Approve a step' : 'A task needs your answer', body: p.detail.slice(0, 180) });
      n.on('click', () => {
        const w = [...windows.values()].find((x) => !x.private && !x.window.isDestroyed());
        if (w) {
          w.window.show();
          w.window.focus();
          w.sidebar = true;
          w.changed();
          w.window.webContents.send('raven:agent', ev.task);
        }
      });
      n.show();
    }
  }
}

type Handler = (w: Win, ...args: any[]) => unknown | Promise<unknown>;
const str = (v: unknown, max = 4000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid value.');
  return v;
};
const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid number.');
  return v;
};
const tabOf = (w: Win, id: unknown) => {
  const t = w.tabs.find((x) => x.id === id);
  if (!t) throw new Error('No such tab.');
  return t;
};

async function contextFor(w: Win, kind: 'page' | 'selection' | 'tabs', tabIds?: number[]): Promise<PageContext[]> {
  if (kind === 'tabs') {
    const out: PageContext[] = [];
    for (const id of (tabIds ?? []).slice(0, 4)) {
      const t = tabOf(w, id);
      if (!t.wc || t.internal) continue;
      try {
        out.push(await extractPage(t.wc, t.wc.getURL()));
      } catch {
        /* skip pages that cannot be read */
      }
    }
    if (!out.length) throw new Error('None of the chosen tabs could be read.');
    return out.map((c) => ({ ...c, kind: 'tabs' }));
  }
  const t = w.active;
  if (!t || !t.wc || t.internal) throw new Error('Open a web page first.');
  if (kind === 'selection') return [await extractSelection(t.wc, t.wc.getURL(), t.wc.getTitle())];
  return [await extractPage(t.wc, t.wc.getURL())];
}

function buildHandlers(): Record<string, Handler> {
  return {
    init: (w) => ({ win: w.state(), app: appState() }),
    // passwords
    passwordAnswer: (w, id, choice) => {
      const o = pendingPasswords.get(num(id));
      if (!o || !w.pwOffer || w.pwOffer.id !== num(id)) return false;
      pendingPasswords.delete(o.id);
      w.pwOffer = null;
      if (choice === 'save') passwords.save(o.origin, o.username, o.password);
      else if (choice === 'never') passwords.setNever(o.origin, true);
      w.changed();
      return true;
    },
    passwordsList: () => ({ logins: passwords.list(), never: passwords.neverList() }),
    passwordReveal: (_w, id) => {
      const p = passwords.reveal(str(id, 40));
      if (p === null) throw new Error('That password could not be read.');
      return p;
    },
    passwordCopy: (_w, id) => {
      const p = passwords.reveal(str(id, 40));
      if (p === null) throw new Error('That password could not be read.');
      clipboard.writeText(p);
      setTimeout(() => {
        void Promise.resolve(clipboard.readText()).then((t) => t === p && clipboard.clear());
      }, 30_000);
      return true;
    },
    passwordDelete: (_w, id) => passwords.remove(str(id, 40)),
    passwordNever: (_w, origin, on) => (passwords.setNever(str(origin, 300), on === true), true),
    passwordsClear: () => (passwords.clearAll(), true),
    // Test builds only: where the active page really sits, and how it identifies itself.
    ...(process.env.RAVEN_SHOT && !app.isPackaged
      ? {
          debugView: (w: Win) => {
            const t = w.active;
            const v = (t as any)?.view as { getBounds(): Electron.Rectangle } | undefined;
            const [cw, ch] = w.window.getContentSize();
            return { bounds: v?.getBounds() ?? null, content: { width: cw, height: ch }, ua: t?.wc?.getUserAgent() ?? null, url: t?.wc?.getURL() ?? null };
          },
          /** Real (trusted) input into the active page, as a person would give it. */
          debugPage: async (w: Win, op: unknown, arg: unknown) => {
            const wc = w.active?.wc;
            if (!wc) return null;
            // Chrome DevTools Protocol input: real, trusted events, even in an off-screen unfocused test window.
            const cdp = async (method: string, params: Record<string, unknown>) => {
              if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
              return wc.debugger.sendCommand(method, params);
            };
            if (op === 'click') {
              const r = await wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(String(arg))}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
              if (!r) return false;
              await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
              await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
              await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
              return true;
            }
            if (op === 'type') return (await cdp('Input.insertText', { text: String(arg) }), true);
            if (op === 'value') return wc.executeJavaScript(`(document.querySelector(${JSON.stringify(String(arg))}) || {}).value ?? null`);
            if (op === 'eval') return wc.executeJavaScript(String(arg));
            return null;
          },
        }
      : {}),
    // assistant routing + master agents (everything goes over the encrypted link to the master)
    route: (_w, text) => masterRpc('route', { text: str(text, 2000) }, 20_000),
    agentStart: (_w, goal) => masterRpc('agentStart', { goal: str(goal, 1000) }),
    agentList: () => (conn.client.online ? conn.client.rpc('agentList', {}, 10_000) : []),
    agentCancel: (_w, id) => masterRpc('agentCancel', { id: str(id, 40) }),
    agentAnswer: (_w, id, promptId, ok, value, remember) =>
      masterRpc('agentAnswer', { id: str(id, 40), promptId: str(promptId, 40), ok: ok === true, value: typeof value === 'string' ? value.slice(0, 2000) : undefined, remember: remember === true }),
    agentFrame: (_w, id) => masterRpc('agentFrame', { id: str(id, 40) }, 15_000),
    agentInput: (_w, id, p) => masterRpc('agentInput', { id: str(id, 40), ...(isPlainObject(p) ? p : {}) }),
    agentForgetPasswords: () => masterRpc('agentForgetPasswords', {}),
    masterSearch: (_w, q, page) => {
      const e = settings.value.searchEngine;
      const engine = e === 'duckduckgo' || e === 'bing' || e === 'brave' ? e : 'google';
      return masterRpc('search', { q: str(q, 400), engine, page: typeof page === 'number' ? page : 0 }, 60_000);
    },
    /** The engine's own page, opened through the gateway (for images, maps, news...). */
    engineUrlFor: (_w, q) => {
      const save = settings.value.masterSearch;
      settings.value.masterSearch = false;
      try {
        return engineUrl(str(q, 400));
      } finally {
        settings.value.masterSearch = save;
      }
    },
    remoteOpen: async (w, url) => {
      const t = (await masterRpc('remoteOpen', { url: str(url, 2000) })) as { id: string };
      w.newTab({ url: `raven://remote?id=${encodeURIComponent(t.id)}` });
      return t;
    },
    // window
    minimize: (w) => w.window.minimize(),
    maximize: (w) => (w.window.isMaximized() ? w.window.unmaximize() : w.window.maximize()),
    close: (w) => w.window.close(),
    setRect: (w, r) => w.setRect(r),
    overlay: (w, on) => w.setOverlay(on === true),
    newWindow: (_w, priv) => (openWindow({ private: priv === true }), true),
    // tabs
    newTab: (w, url) => w.newTab({ url: typeof url === 'string' ? url : undefined }).id,
    closeTab: (w, id) => w.closeTab(num(id)),
    activate: (w, id) => w.activate(num(id)),
    duplicate: (w, id) => w.duplicate(num(id)),
    pin: (w, id, on) => w.pin(num(id), on === true),
    moveTab: (w, id, to) => w.move(num(id), num(to)),
    reopen: (w) => w.reopenClosed(),
    mute: (w, id) => {
      const t = tabOf(w, id);
      t.wc?.setAudioMuted(!t.wc.isAudioMuted());
      w.changed();
    },
    closeOthers: (w, id) => {
      for (const t of [...w.tabs]) if (t.id !== id && !t.pinned) w.closeTab(t.id);
    },
    // navigation
    navigate: (w, text, tabId) => w.navigate(str(text, 8000), typeof tabId === 'number' ? tabId : undefined),
    back: (w) => w.active?.back(),
    forward: (w) => w.active?.forward(),
    reload: (w, hard) => w.active?.reload(hard === true),
    stop: (w) => w.active?.wc?.stop(),
    home: (w) => w.navigate(settings.value.homepage || 'raven://newtab'),
    zoom: (w, dir) => w.zoom(dir),
    print: (w) => w.active?.wc && !w.active.internal && w.active.wc.print({}),
    fullscreen: (w) => w.window.setFullScreen(!w.window.isFullScreen()),
    find: (w, text, fwd, next) => w.findText(str(text, 500), fwd !== false, next === true),
    findClose: (w) => w.closeFind(),
    sidebar: (w, on) => {
      w.sidebar = typeof on === 'boolean' ? on : !w.sidebar;
      w.changed();
      return w.sidebar;
    },
    answerPermission: (w, id, ok, remember) => w.answerPermission(num(id), ok === true, remember === true),
    // suggestions + memory
    suggest: async (w, q) => {
      const text = str(q, 500).trim();
      if (!text || w.private) return [];
      const hits = await memory.search(text, { kinds: ['visit', 'bookmark', 'search'], limit: 24 });
      const seen = new Set<string>();
      const out: { kind: string; title: string; url?: string }[] = [];
      for (const h of hits) {
        const key = h.url ?? `s:${h.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: h.kind, title: h.title, url: h.url });
        if (out.length >= 7) break;
      }
      return out;
    },
    memorySearch: (_w, q, kinds, deep) => memory.search(str(q, 500), { kinds: Array.isArray(kinds) ? (kinds as MemKind[]) : undefined, limit: 120, deep: deep === true }),
    memoryStats: () => memory.stats(),
    history: (_w, opts) => memory.listHistory(isPlainObject(opts) ? (opts as any) : {}),
    searches: (_w, opts) => memory.listSearches(isPlainObject(opts) ? (opts as any) : {}),
    clearHistory: async (_w, opts) => {
      const o = isPlainObject(opts) ? opts : {};
      const n = await memory.clearHistory({ url: typeof o.url === 'string' ? o.url : undefined, since: typeof o.since === 'number' ? o.since : undefined });
      // Chromium's own back/forward lists stay with open tabs; Raven's history files are the browsing history.
      return n;
    },
    clearSearches: (_w, since) => memory.clearSearches(typeof since === 'number' ? since : undefined),
    bookmarks: () => memory.listBookmarks(),
    toggleBookmark: (w) => {
      const t = w.active;
      if (!t || w.private) return false;
      const url = t.internal ? t.url : t.wc?.getURL() || t.url;
      if (!url || url.startsWith('raven://')) return false;
      const on = memory.isBookmarked(url);
      if (on) memory.removeBookmark(url);
      else memory.addBookmark(url, t.internal ? t.title : t.wc?.getTitle() || url);
      w.changed();
      return !on;
    },
    addBookmark: (w, url, title) => {
      memory.addBookmark(str(url, 2000), str(title ?? url, 300));
      w.changed();
    },
    removeBookmark: (w, id) => {
      memory.removeBookmark(str(id, 2000));
      w.changed();
    },
    notes: () => memory.listNotes(),
    saveNote: (_w, n) => {
      if (!isPlainObject(n)) throw new Error('Invalid note.');
      return memory.saveNote({ id: typeof n.id === 'string' ? n.id : undefined, title: str(n.title ?? 'Note', 200), url: typeof n.url === 'string' ? n.url : undefined, body: str(n.body ?? '', 500_000) });
    },
    deleteNote: (_w, id) => memory.deleteNote(str(id, 60)),
    clearNotes: () => memory.clearNotes(),
    savePage: async (w) => {
      const t = w.active;
      if (!t?.wc || t.internal) throw new Error('Open a web page first.');
      const url = t.wc.getURL();
      if (isSensitiveUrl(url)) throw new Error('Private pages (mail, sign-in, payment) are not saved.');
      const page = await extractPage(t.wc, url);
      // Saved copies are static: scripts and forms are removed so nothing runs or submits offline.
      const html = String(
        await t.wc.executeJavaScriptInIsolatedWorld(998, [
          {
            code: `(() => { const d = document.documentElement.cloneNode(true); d.querySelectorAll('script,noscript,iframe,object,embed,form,input,textarea,select,button,link[rel=preload],link[rel=modulepreload]').forEach(e => e.remove()); d.querySelectorAll('*').forEach(e => { for (const a of [...e.attributes]) if (/^on/i.test(a.name)) e.removeAttribute(a.name); }); const base = document.createElement('base'); base.href = location.href; d.querySelector('head')?.prepend(base); return '<!doctype html>' + d.outerHTML; })()`,
          },
        ]),
      );
      return memory.savePage({ url, title: t.wc.getTitle(), html: html.slice(0, 8_000_000), text: page.text });
    },
    savedPages: () => memory.listSavedPages(),
    openSavedPage: (w, id) => {
      const p = memory.getSavedPage(str(id, 60));
      if (!p) throw new Error('That saved page is gone.');
      w.newTab({ url: 'file:///' + p.file.replace(/\\/g, '/') });
    },
    deleteSavedPage: (_w, id) => memory.deleteSavedPage(str(id, 60)),
    clearSavedPages: () => memory.clearSavedPages(),
    clearCache: async () => {
      for (const ses of [esession.fromPartition('persist:raven')]) {
        await ses.clearCache();
        await ses.clearStorageData({ storages: ['cachestorage', 'shadercache', 'serviceworkers'] });
      }
      return true;
    },
    clearCookies: async () => {
      await esession.fromPartition('persist:raven').clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] });
      return true;
    },
    clearAllMemory: async () => {
      await memory.clearAll();
      return true;
    },
    backup: () => memory.backup(),
    exportMemory: async (w) => {
      const r = await dialog.showSaveDialog(w.window, { title: 'Export Raven memory', defaultPath: path.join(app.getPath('documents'), `raven-memory-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'Raven memory', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return null;
      return memory.exportTo(r.filePath);
    },
    importMemory: async (w) => {
      const r = await dialog.showOpenDialog(w.window, { title: 'Import Raven memory', properties: ['openFile'], filters: [{ name: 'Raven memory', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      return memory.importFrom(r.filePaths[0]);
    },
    rebuildIndex: () => memory.rebuildIndex(),
    openMemoryFolder: () => shell.openPath(memory.root),
    chooseMemoryFolder: async (w, copy) => {
      const r = await dialog.showOpenDialog(w.window, { title: 'Choose where Raven keeps its memory', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      const dir = path.basename(r.filePaths[0]) === DATA_FOLDER ? r.filePaths[0] : path.join(r.filePaths[0], DATA_FOLDER);
      if (!isWritableDir(dir)) throw new Error('Raven cannot write to that folder.');
      const old = memory;
      await old.flush();
      if (copy !== false) {
        const tmp = path.join(dataRoot, 'logs', `move-${Date.now()}.json`);
        await old.exportTo(tmp);
        const next = new MemoryStore(dir);
        await next.init();
        await next.importFrom(tmp);
        fs.rmSync(tmp, { force: true });
        memory = next;
      } else memory = openMemory(dir);
      settings.update({ memoryDir: dir });
      memoryWarning = null;
      pushApp();
      return dir;
    },
    retryMemoryFolder: async () => {
      const wanted = settings.value.memoryDir;
      if (!isWritableDir(wanted)) throw new Error('That drive is still not available.');
      const fallback = memory;
      await fallback.flush();
      const tmp = path.join(dataRoot, 'logs', `merge-${Date.now()}.json`);
      await fallback.exportTo(tmp);
      memory = openMemory(wanted);
      await memory.ready;
      await memory.importFrom(tmp);
      fs.rmSync(tmp, { force: true });
      pushApp();
      return true;
    },
    enablePortable: async () => {
      const dir = exeDir();
      if (!dir) throw new Error('Portable mode is only available in the packaged RavenBrowser.exe.');
      const target = path.join(dir, DATA_FOLDER);
      if (!isWritableDir(target)) throw new Error(`The folder next to RavenBrowser.exe (${dir}) is not writable. Copy RavenBrowser.exe to a USB drive or a folder you own first.`);
      await memory.flush();
      const tmp = path.join(target, 'import-on-start.json');
      await memory.exportTo(tmp);
      fs.copyFileSync(path.join(dataRoot, 'settings.json'), path.join(target, 'settings.json'));
      const s = readJsonSync<any>(path.join(target, 'settings.json'), {});
      s.memoryDir = target;
      atomicWriteSync(path.join(target, 'settings.json'), JSON.stringify(s, null, 2));
      return target;
    },
    // downloads
    downloadAction: async (_w, id, action) => {
      const live = downloads.get(str(id, 60));
      const rec = memory.listDownloads().find((d) => d.id === id) ?? privateDownloads.get(id);
      switch (action) {
        case 'cancel':
          live?.item.cancel();
          break;
        case 'pause':
          live?.item.pause();
          break;
        case 'resume':
          if (live?.item.canResume()) live.item.resume();
          else if (rec) esession.fromPartition('persist:raven').downloadURL(rec.url);
          break;
        case 'retry':
          if (rec) esession.fromPartition('persist:raven').downloadURL(rec.url);
          break;
        case 'show':
          if (rec?.path && fs.existsSync(rec.path)) shell.showItemInFolder(rec.path);
          else throw new Error('The file was moved or deleted.');
          break;
        case 'open':
          if (!rec?.path || !fs.existsSync(rec.path)) throw new Error('The file was moved or deleted.');
          // Programs are never launched from the browser: show them in their folder instead.
          if (EXECUTABLE.test(rec.path)) shell.showItemInFolder(rec.path);
          else await shell.openPath(rec.path);
          break;
        case 'forget':
          privateDownloads.delete(id);
          await memory.clearDownloads(id);
          break;
      }
      pushApp();
      return true;
    },
    download: (w, url) => {
      const u = str(url, 4000);
      if (!/^https?:/i.test(u)) throw new Error('Only web addresses can be downloaded.');
      w.session.downloadURL(u);
      return true;
    },
    clearDownloads: async () => {
      for (const [k, v] of privateDownloads) if (v.state !== 'progressing') privateDownloads.delete(k);
      await memory.clearDownloads();
      pushApp();
      return true;
    },
    chooseDownloadDir: async (w) => {
      const r = await dialog.showOpenDialog(w.window, { properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      settings.update({ downloadDir: r.filePaths[0] });
      pushApp();
      return r.filePaths[0];
    },
    // settings
    settings: (_w, patch) => {
      if (!isPlainObject(patch)) throw new Error('Invalid settings.');
      const before = settings.value.deviceName;
      settings.update(patch as Partial<BrowserSettings>);
      if (settings.value.deviceName !== before) conn.setDeviceName(settings.value.deviceName);
      conn.recompute();
      for (const w of windows.values()) for (const t of w.tabs) t.wc?.setWebRTCIPHandlingPolicy(host.webrtcPolicy());
      pushApp();
      return settings.value;
    },
    permissionsList: () => permissions,
    revokePermission: (_w, origin, key) => {
      if (permissions[origin]) {
        delete permissions[origin][key];
        if (!Object.keys(permissions[origin]).length) delete permissions[origin];
        atomicWriteSync(permissionsFile(), JSON.stringify(permissions, null, 2));
      }
      return permissions;
    },
    adblockSite: (w, on) => {
      const t = w.active;
      const hostName = t?.wc ? new URL(t.wc.getURL()).hostname.toLowerCase() : '';
      if (!hostName) return false;
      const set = new Set(settings.value.adblockAllow);
      if (on === false) set.add(hostName);
      else set.delete(hostName);
      settings.update({ adblockAllow: [...set] });
      t?.reload();
      pushApp();
      return true;
    },
    // connection
    connect: (_w, target) => {
      if (!isPlainObject(target)) throw new Error('Invalid server.');
      return conn.useServer({ host: str(target.host, 255), port: num(target.port), name: typeof target.name === 'string' ? target.name : undefined, fp: typeof target.fp === 'string' ? target.fp : undefined });
    },
    connectAddress: (_w, text, ca) => conn.useAddress(str(text, 300), ca === true),
    reconnect: () => conn.connectNow(),
    forgetServer: () => conn.forgetServer(),
    rotateKey: async () => {
      const next = generateDeviceKeyPair();
      const transcript = Buffer.from(`raven-rotate-v1|${identity.deviceId}|${next.publicKey}`, 'utf8');
      await conn.client.rpc('rotate_key', { publicKey: next.publicKey, sigOld: signTranscript(identity.privateKey, transcript), sigNew: signTranscript(next.privateKey, transcript) });
      identity.adoptKey(next.publicKey, next.privateKey);
      conn.client.setIdentity(identity.identity);
      return true;
    },
    // AI
    conversations: () => memory.listConversations(),
    conversation: (_w, id) => memory.getConversation(str(id, 60)),
    deleteConversation: (_w, id) => memory.deleteConversation(str(id, 60)),
    clearConversations: () => memory.clearConversations(),
    pageContext: (w, kind, tabIds) => contextFor(w, kind === 'selection' ? 'selection' : kind === 'tabs' ? 'tabs' : 'page', Array.isArray(tabIds) ? tabIds.filter((x) => typeof x === 'number') : undefined),
    savedPageContext: (_w, id) => {
      const p = memory.getSavedPage(str(id, 60));
      if (!p) throw new Error('That saved page is gone.');
      return [{ kind: 'saved', title: p.meta.title, url: p.meta.url, text: p.text, chars: p.text.length } satisfies PageContext];
    },
    aiSend: (w, req) => {
      if (!isPlainObject(req)) throw new Error('Invalid request.');
      const history = Array.isArray(req.history) ? (req.history as ChatMessage[]).filter((m) => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role)).slice(-60) : [];
      const context = Array.isArray(req.context) ? (req.context as PageContext[]).filter((c) => c && typeof c.text === 'string').slice(0, 4) : [];
      if (!conn.client.online) throw new RavenError(conn.client.phase === 'pending' ? 'device_pending' : 'server_unreachable');
      return chat.send({
        conversationId: typeof req.conversationId === 'string' ? req.conversationId : null,
        title: typeof req.title === 'string' ? req.title : undefined,
        history,
        text: str(req.text, 100_000),
        context,
        model: typeof req.model === 'string' ? req.model : 'auto',
        mode: req.mode === 'coding' || req.mode === 'general' ? req.mode : 'auto',
        private: w.private,
        emit: (e: ChatEvent) => {
          if (!w.window.isDestroyed()) w.window.webContents.send('raven:chat', e);
        },
      });
    },
    aiStop: (_w, id) => chat.stop(num(id)),
    reference: (_w, q, lang) => searchReference(typeof q === 'string' ? q : '', typeof lang === 'string' ? lang : undefined).slice(0, 60).map((h) => h.entry),
    openExternalDataRoot: () => shell.openPath(dataRoot),
    quit: () => app.quit(),
  };
}

// ---------------------------------------------------------------- start
async function main(): Promise<void> {
  await app.whenReady();
  settings = new SettingsStore(dataRoot);
  identity = new IdentityStore(dataRoot);
  passwords = new PasswordStore(dataRoot);
  setupPasswordIpc();
  identity.load();
  permissions = readJsonSync<typeof permissions>(permissionsFile(), {});
  if (!isPlainObject(permissions)) permissions = {};
  memory = openMemory(settings.value.memoryDir || dataRoot);
  // A portable copy prepared by "enable portable mode" brings the memory with it.
  const pending = path.join(dataRoot, 'import-on-start.json');
  if (fs.existsSync(pending)) {
    await memory.ready;
    try {
      await memory.importFrom(pending);
    } finally {
      fs.rmSync(pending, { force: true });
    }
  }

  conn = new ConnectionManager(identity, settings, VERSION);
  conn.on('change', pushApp);
  conn.client.on('event', onMasterEvent);
  // Back from sleep or the screen unlocked: look for the master straight away.
  powerMonitor.on('resume', () => conn.kick());
  powerMonitor.on('unlock-screen', () => conn.kick());
  await conn.start();
  chat = new ChatRunner(conn, () => memory, () => settings.value.aiSaveConversations);

  // The proxy asks for a password so other programs on this PC cannot borrow the gateway.
  app.on('login', (event, _wc, details, authInfo, callback) => {
    if (authInfo.isProxy && (authInfo.host === '127.0.0.1' || authInfo.host === 'localhost') && authInfo.port === conn.proxy.port) {
      event.preventDefault();
      callback(conn.proxy.username, conn.proxy.password);
    }
    void details;
  });
  // The UI's own session never loads remote content, but route it too so nothing can leak around the gateway.
  await esession.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${conn.proxy.port}`, proxyBypassRules: '<local>' });

  const handlers = buildHandlers();
  ipcMain.handle('raven:invoke', async (event, method: unknown, ...args: unknown[]): Promise<InvokeResult> => {
    const w = winFor(event.sender);
    if (!w) return { ok: false, error: 'Not allowed.' };
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, method)) return { ok: false, error: 'Unknown action.' };
    try {
      const data = await handlers[method](w, ...args);
      return { ok: true, data };
    } catch (e) {
      const code = (e as any)?.code;
      return { ok: false, error: (e as Error).message || 'Something went wrong.', ...(typeof code === 'string' ? { code: code as ErrCode } : {}) };
    }
  });

  // Network changes (Wi-Fi rejoined, cable plugged in) trigger an immediate reconnect.
  let wasOnline = enet.isOnline();
  setInterval(() => {
    const now = enet.isOnline();
    if (now !== wasOnline) {
      wasOnline = now;
      if (now) conn.networkChanged();
    }
  }, 3000).unref();

  const saved = readJsonSync<SavedSession | null>(path.join(dataRoot, 'session.json'), null);
  const args = process.argv.slice(1).filter((a) => /^(https?:|file:)/i.test(a));
  if (settings.value.restoreSession && saved && Array.isArray(saved.windows) && saved.windows.length) {
    for (const sw of saved.windows) openWindow({ restore: sw });
    if (args.length) [...windows.values()][0]?.newTab({ url: args[0] });
  } else openWindow({ urls: args.length ? args : undefined });

  if (identity.regenerated) {
    const w = [...windows.values()][0];
    setTimeout(() => w?.window.webContents.send('raven:toast', { text: 'This copy of Raven runs under a new user account or computer, so it has a new device identity. Pair it with the master server once.', tone: 'bad' }), 2500);
  }

  app.on('second-instance', (_e, argv) => {
    const urls = argv.filter((a) => /^(https?:|file:)/i.test(a));
    const w = [...windows.values()].find((x) => !x.private);
    if (w) {
      if (w.window.isMinimized()) w.window.restore();
      w.window.focus();
      for (const u of urls) w.newTab({ url: u });
    } else openWindow({ urls });
  });
  app.on('before-quit', () => {
    saveSessionNow();
    quitting = true;
  });
  app.on('will-quit', () => {
    conn.stop();
    void memory.flush();
  });
  app.on('window-all-closed', () => app.quit());

  devShot();
}

/** Development only: RAVEN_SHOT=file.png saves a screenshot of the first window (optionally after a script). */
function devShot(): void {
  const out = process.env.RAVEN_SHOT;
  if (!out || app.isPackaged) return;
  const w = [...windows.values()][0];
  if (!w) return;
  setTimeout(async () => {
    try {
      if (process.env.RAVEN_SHOT_SCRIPT) {
        const r = await w.window.webContents.executeJavaScript(process.env.RAVEN_SHOT_SCRIPT, true);
        fs.writeFileSync(out + '.json', JSON.stringify(r ?? null, null, 2));
      }
      await new Promise((r) => setTimeout(r, Number(process.env.RAVEN_SHOT_WAIT ?? 1500)));
      const img = await w.window.capturePage();
      fs.writeFileSync(out, img.toPNG());
    } catch (e) {
      fs.writeFileSync(out + '.error.txt', String((e as Error)?.stack ?? e));
    }
    if (process.env.RAVEN_SHOT_EXIT !== '0') app.quit();
  }, Number(process.env.RAVEN_SHOT_DELAY ?? 4000));
}

main().catch((err) => {
  dialog.showErrorBox('Raven Browser could not start', String(err?.stack ?? err));
  app.exit(1);
});

void BrowserWindow;
