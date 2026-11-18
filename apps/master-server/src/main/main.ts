// Raven Master Server, desktop edition (Windows / macOS): a tray app around MasterCore. It adds the dashboard
// window, the tray, the clipboard, hidden browsers for tasks / remote tabs / search, and the bundled FreeLLMAPI.
// The dashboard talks to this process over Electron IPC only; no admin API is ever exposed on the network.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from '@raven/shared';
import { atomicWriteSync, readJsonSync } from '../../../../packages/local-memory/src/fsutil';
import { MasterCore, httpSearch, type SecretStore } from '../core';
import { FreeLlmSupervisor } from './freellm';
import { AgentManager } from './agent';
import { MasterSearch } from './search';
import { FakeHotspot, Hotspot } from './hotspot';
import type { InvokeResult } from '../types';

const VERSION = process.env.RAVEN_VERSION ?? '0.0.0';
const startHidden = process.argv.includes('--hidden');

app.setName('Raven Master Server');
// Test hook: run against a separate profile. Set before the single-instance lock, which is per profile.
if (process.env.RAVEN_USER_DATA) app.setPath('userData', process.env.RAVEN_USER_DATA);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId('app.raven.masterserver');

// ---------- OS-protected secret storage (Windows DPAPI / macOS Keychain via Electron safeStorage) ----------
class SafeSecretStore implements SecretStore {
  private data: Record<string, string>;
  constructor(private file: string) {
    this.data = readJsonSync<Record<string, string>>(file, {});
    if (!isPlainObject(this.data)) this.data = {};
  }
  get(name: string): string | null {
    const v = this.data[name];
    if (typeof v !== 'string') return null;
    try {
      if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
      return null;
    } catch {
      return null;
    }
  }
  set(name: string, value: string | null): void {
    if (value === null) delete this.data[name];
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('The system secure storage (Windows DPAPI or the macOS Keychain) is not available; refusing to store a secret unencrypted.');
      this.data[name] = 'enc:' + safeStorage.encryptString(value).toString('base64');
    }
    atomicWriteSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

let win: BrowserWindow | null = null;
let flWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let core: MasterCore;
let supervisor: FreeLlmSupervisor;
let secrets: SafeSecretStore;

function pushState(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('raven:state', core.snapshot());
  refreshTray();
}

function applyAutoStart(on: boolean): void {
  if (process.platform === 'darwin') {
    // macOS login item; started hidden so only the menu bar icon appears.
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
    return;
  }
  // Portable builds unpack to a temp folder; the real launcher path is given by the packager.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: on, path: exe, args: ['--hidden'] });
}

// ---------- windows ----------
function iconPath(): string {
  return path.join(__dirname, 'icon.png');
}

function createWindow(show: boolean): void {
  if (show && process.platform === 'darwin') void app.dock?.show();
  if (win && !win.isDestroyed()) {
    if (show) {
      win.show();
      win.focus();
    }
    return;
  }
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#100C0B',
    title: 'Raven Master Server',
    icon: iconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#100C0B', symbolColor: '#EDE6D6', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  win.setMenuBarVisibility(false);
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('context-menu', (_e, p) => {
    const items: Electron.MenuItemConstructorOptions[] = p.isEditable
      ? [
          { label: 'Undo', role: 'undo', enabled: p.editFlags.canUndo },
          { type: 'separator' },
          { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut },
          { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
          { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste },
          { type: 'separator' },
          { label: 'Select all', role: 'selectAll' },
        ]
      : p.selectionText.trim()
        ? [{ label: 'Copy', role: 'copy' }]
        : [];
    if (items.length && win) Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.once('ready-to-show', () => {
    if (process.env.RAVEN_HEADLESS === '1') {
      // Test/automation runs render far off-screen without taking focus.
      win?.setSkipTaskbar(true);
      win?.setPosition(-32000, -32000);
      win?.showInactive();
    } else if (show) win?.show();
  });
  win.on('close', (e) => {
    if (quitting || !core.config.value.minimizeToTray) return;
    e.preventDefault();
    win?.hide();
    if (process.env.RAVEN_HEADLESS !== '1' && Notification.isSupported() && !secrets.get('tray-hint-shown')) {
      new Notification({ title: 'Raven Master Server is still running', body: 'It keeps serving devices from the system tray. Right-click the tray icon to quit.', icon: iconPath() }).show();
      try {
        secrets.set('tray-hint-shown', '1');
      } catch {
        /* cosmetic */
      }
    }
  });
  win.on('closed', () => {
    win = null;
    if (!core.config.value.minimizeToTray && !quitting) void quit();
  });
  win.on('show', () => pushState());
  devShot(win);
}

/** Development only: save a screenshot of the window (RAVEN_SHOT=file.png), optionally after running a script. */
function devShot(w: BrowserWindow): void {
  const out = process.env.RAVEN_SHOT;
  if (!out || app.isPackaged) return;
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (process.env.RAVEN_SHOT_SCRIPT) {
          const r = await w.webContents.executeJavaScript(process.env.RAVEN_SHOT_SCRIPT, true);
          fs.writeFileSync(out + '.json', JSON.stringify(r ?? null, null, 2));
        }
        await new Promise((r) => setTimeout(r, Number(process.env.RAVEN_SHOT_WAIT ?? 1500)));
        const img = await w.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
      } catch (e) {
        fs.writeFileSync(out + '.error.txt', String(e));
      }
      if (process.env.RAVEN_SHOT_EXIT !== '0') void quit();
    }, Number(process.env.RAVEN_SHOT_DELAY ?? 3500));
  });
}

function refreshTray(): void {
  if (!tray) return;
  const st = core.gateway.stats();
  const sw = core.gateway.switches;
  const status = !sw.master ? 'Server OFF' : !st.listening ? 'Server error' : `${st.clients} device(s) connected`;
  tray.setToolTip(`Raven Master Server\n${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { label: `Internet gateway: ${sw.internet ? 'ON' : 'OFF'}   AI gateway: ${sw.ai ? 'ON' : 'OFF'}`, enabled: false },
      { type: 'separator' },
      { label: 'Open dashboard', click: () => createWindow(true) },
      {
        label: 'Emergency stop (disconnect everything)',
        enabled: sw.master,
        click: () => void core.gateway.setSwitches({ master: false }),
      },
      { type: 'separator' },
      { label: 'Quit Raven Master Server', click: () => void quit() },
    ]),
  );
}

async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  await core?.stop();
  tray?.destroy();
  app.quit();
}

function openFreeLlmDashboard(): void {
  const url = supervisor.dashboardUrl;
  const token = supervisor.session;
  if (!url || !token) throw new Error('The built-in FreeLLMAPI is not running. Turn it on first.');
  if (flWin && !flWin.isDestroyed()) {
    flWin.show();
    flWin.focus();
    return;
  }
  flWin = new BrowserWindow({
    width: 1240,
    height: 840,
    backgroundColor: '#0b0b0c',
    title: 'FreeLLMAPI: providers and keys',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-freellm.cjs'),
      additionalArguments: [`--freeapi-token=${token}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:freellmapi-dashboard',
    },
  });
  const origin = new URL(url).origin;
  flWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:\/\//i.test(u) && !u.startsWith(origin)) void shell.openExternal(u);
    return { action: 'deny' };
  });
  flWin.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(u)) void shell.openExternal(u);
    }
  });
  flWin.on('closed', () => {
    flWin = null;
    void core.ai.refresh();
  });
  void flWin.loadURL(url);
}

async function main(): Promise<void> {
  await app.whenReady();
  const dataDir = path.join(app.getPath('userData'), 'MasterServerData');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  secrets = new SafeSecretStore(path.join(dataDir, 'secrets.json'));

  core = new MasterCore({
    version: VERSION,
    dataDir,
    secrets,
    attach: (c) => {
      // The FreeLLMAPI bundle is unpacked next to app.asar so its native image module can load.
      supervisor = new FreeLlmSupervisor(path.join(__dirname, 'freellm').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), dataDir, secrets, () => c.config.value.ai.managedPort, (lvl, msg) => c.gateway?.log(lvl, msg));
      const agents = new AgentManager({
        ai: c.ai,
        secrets,
        log: (lvl, msg, id) => c.gateway.log(lvl, msg, id),
        send: (id, ev) => c.gateway.sendEvent(id, ev),
        lanAllowlist: () => c.config.value.lanAllowlist,
        denied: (d, needsInternet) => c.agentDenied(d, needsInternet),
      });
      const browserSearch = new MasterSearch((ses) => agents.guardSession(ses));
      // Tests of unpackaged builds use a stand-in, so they never change this computer's real Wi-Fi.
      const hotspot = process.env.RAVEN_FAKE_HOTSPOT === '1' && !app.isPackaged ? new FakeHotspot(() => c.changed()) : new Hotspot(() => c.changed());
      return {
        supervisor,
        agents,
        hotspot,
        search: {
          // The hidden browser first; plain HTTP if every engine challenged it.
          search: async (d, q, engine, page) => {
            try {
              return await browserSearch.search(d, q, engine, page);
            } catch (e) {
              return httpSearch(q, page).catch(() => Promise.reject(e));
            }
          },
          shutdown: () => browserSearch.shutdown(),
        },
      };
    },
    clipboard: { write: (t) => clipboard.writeText(t), read: () => clipboard.readText(), clear: () => clipboard.clear() },
    openPath: (p) => void shell.openPath(p),
    setAutoStart: applyAutoStart,
    confirm: async (message, detail) => {
      if (!win) return false;
      const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Yes, do it'], defaultId: 0, cancelId: 0, message, detail });
      return r.response === 1;
    },
    show: () => createWindow(true),
    quit: () => void quit(),
    openFreeLlmDashboard,
  });
  await core.init();

  core.on('state', pushState);
  core.on('tick', () => {
    if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('raven:state', core.snapshot());
  });
  core.on('pairing-request', (d: { name: string; pairingCode: string }) => {
    if (process.env.RAVEN_HEADLESS !== '1' && Notification.isSupported()) {
      const n = new Notification({ title: 'A device wants to connect', body: `"${d.name}" is waiting for approval. Code ${d.pairingCode}.`, icon: iconPath() });
      n.on('click', () => createWindow(true));
      n.show();
      // An open dashboard flashes in the taskbar so the request is not missed.
      if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
    }
  });

  ipcMain.handle('raven:invoke', async (event, method: unknown, ...args: unknown[]): Promise<InvokeResult> => {
    // Only our own dashboard page may call in.
    if (!win || event.sender !== win.webContents) return { ok: false, error: 'Not allowed.' };
    return core.invoke(method, args);
  });

  await core.start();
  applyAutoStart(core.config.value.autoStart);

  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  if (process.env.RAVEN_HEADLESS !== '1') tray = new Tray(img);
  // On macOS the server lives in the menu bar; the Dock icon appears only while the dashboard is open.
  if (process.platform === 'darwin' && startHidden) app.dock?.hide();
  tray?.on('click', () => createWindow(true));
  refreshTray();
  createWindow(!startHidden);

  app.on('second-instance', () => createWindow(true));
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });
  app.on('before-quit', (e) => {
    if (!quitting) {
      e.preventDefault();
      void quit();
    }
  });
}

main().catch((err) => {
  dialog.showErrorBox('Raven Master Server could not start', String(err?.stack ?? err));
  app.exit(1);
});
