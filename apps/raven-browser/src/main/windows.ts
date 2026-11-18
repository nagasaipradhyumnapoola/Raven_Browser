// Browser windows and tabs. Each tab is a sandboxed WebContentsView; internal
// pages (new tab, history, settings...) are drawn by the window's own UI.
import { BrowserWindow, Menu, WebContentsView, clipboard, shell, type Session, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { ERR_TEXT, type ErrCode } from '@raven/shared';
import type { MemoryStore } from '@raven/local-memory';
import type { FindState, InternalPage, PasswordOffer, PermissionAsk, TabView, WindowState } from '../types';

export interface Host {
  memory(): MemoryStore;
  historyAllowed(priv: boolean): boolean;
  searchUrl(q: string): string;
  engineName(): string;
  lastProxyError(host: string): ErrCode | null;
  onWindowsChanged(): void;
  openWindow(opts: { private?: boolean; urls?: string[] }): Win;
  saveSession(): void;
  askAi(win: Win, action: 'explain' | 'summarize' | 'ask', text?: string): void;
  webrtcPolicy(): 'default' | 'disable_non_proxied_udp';
  fetchFavicon(ses: Session, url: string): Promise<string | null>;
  setupSession(ses: Session): void;
  isDev: boolean;
  dir: string;
}

import { googleBlockedQuery, nextZoom } from './navhelpers';
import { firefoxUserAgent, isSignInUrl } from '@raven/shared';

const INTERNAL: Record<string, InternalPage> = {
  'raven://newtab': 'newtab',
  'raven://search': 'search',
  'raven://remote': 'remote',
  'raven://passwords': 'passwords',
  'raven://history': 'history',
  'raven://bookmarks': 'bookmarks',
  'raven://downloads': 'downloads',
  'raven://settings': 'settings',
  'raven://memory': 'memory',
  'raven://reference': 'reference',
  'raven://connect': 'connect',
};
const INTERNAL_TITLE: Record<InternalPage, string> = {
  newtab: 'New tab',
  search: 'Search',
  remote: 'On the master',
  passwords: 'Passwords',
  history: 'History',
  bookmarks: 'Bookmarks',
  downloads: 'Downloads',
  settings: 'Settings',
  memory: 'Memory',
  reference: 'Offline reference',
  connect: 'Master server',
};

/** Standard Cut / Copy / Paste / Select all for any text in the app's own interface. */
export function editMenu(win: BrowserWindow, p: Electron.ContextMenuParams): void {
  const items: Electron.MenuItemConstructorOptions[] = [];
  const hasSel = !!p.selectionText.trim();
  if (p.isEditable) {
    items.push(
      { label: 'Undo', role: 'undo', enabled: p.editFlags.canUndo },
      { label: 'Redo', role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste },
      { label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll' },
    );
  } else if (hasSel) {
    items.push({ label: 'Copy', role: 'copy' });
  }
  if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) });
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

let tabSeq = 1;
let winSeq = 1;
let permSeq = 1;

export class Tab {
  id = tabSeq++;
  view: WebContentsView | null = null;
  internal: InternalPage | null = 'newtab';
  /** the Raven page (search results...) this tab came from, so Back returns to it */
  private returnTo: { url: string; floor: number } | null = null;
  pinned = false;
  title = 'New tab';
  url = 'raven://newtab';
  favicon: string | null = null;
  error: TabView['error'] = null;
  crashed = false;
  blocked = 0;
  audible = false;
  private visitTimer: NodeJS.Timeout | null = null;

  constructor(private win: Win) {}

  get wc(): WebContents | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.win.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        plugins: true, // built-in PDF viewer
        spellcheck: true,
        safeDialogs: true,
        navigateOnDragDrop: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    this.view = view;
    this.wire(view.webContents);
    this.win.attach(this);
    return view;
  }

  /** Popups that need window.opener (sign-in windows) arrive with a ready WebContents. */
  adopt(wc: WebContents): void {
    const view = new WebContentsView({ webContents: wc } as any);
    view.setBackgroundColor('#ffffff');
    this.view = view;
    this.internal = null;
    this.url = '';
    this.wire(wc);
    this.win.attach(this);
  }

  private wire(wc: WebContents): void {
    wc.setWebRTCIPHandlingPolicy(this.win.host.webrtcPolicy());
    // Google sign-in pages refuse "embedded" browsers; on them this tab presents itself as Firefox (see signin.ts).
    const normalUA = wc.getUserAgent();
    wc.on('did-start-navigation', (e: any, u?: string, inPlace?: boolean, main?: boolean) => {
      const url = e?.url ?? u ?? '';
      if ((e?.isMainFrame ?? main) === false || (e?.isSameDocument ?? inPlace) === true) return;
      const want = isSignInUrl(url) ? firefoxUserAgent() : normalUA;
      if (wc.getUserAgent() !== want) wc.setUserAgent(want);
    });
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (!/^(https?|about|blob|data):/i.test(url) && url !== '') {
        if (/^(mailto|tel):/i.test(url)) void this.win.confirmExternal(url);
        return { action: 'deny' };
      }
      // Sign-in popups keep their opener; ordinary links become tabs.
      if (disposition === 'new-window' && features) {
        return {
          action: 'allow',
          createWindow: (options: any) => {
            const t = this.win.newTab({ background: false, adoptFrom: options.webContents });
            return t.wc!;
          },
        } as any;
      }
      this.win.newTab({ url, background: disposition === 'background-tab', after: this });
      return { action: 'deny' };
    });
    wc.on('did-start-loading', () => {
      this.crashed = false;
      this.win.changed();
    });
    wc.on('did-stop-loading', () => this.win.changed());
    wc.on('did-navigate', (_e, url) => {
      // Google showed its robot check for a search: run the same search on DuckDuckGo instead of stopping there.
      const q = googleBlockedQuery(url);
      if (q) {
        this.win.window.webContents.send('raven:toast', { text: 'Google asked for a robot check, so this search opened on DuckDuckGo.', tone: 'ok' });
        void wc.loadURL(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`).catch(() => {});
        return;
      }
      this.url = url;
      this.error = null;
      this.blocked = 0;
      this.favicon = null;
      this.scheduleVisit();
      this.win.changed();
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (!isMain) return;
      this.url = url;
      this.win.changed();
    });
    wc.on('page-title-updated', (_e, title) => {
      this.title = title || this.url;
      this.scheduleVisit(800);
      this.win.changed();
    });
    wc.on('page-favicon-updated', async (_e, icons) => {
      const icon = icons.find((i) => /^https?:|^data:image/i.test(i));
      if (!icon) return;
      this.favicon = icon.startsWith('data:') ? icon : await this.win.host.fetchFavicon(this.win.session, icon);
      this.win.changed();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3: aborted (user stopped, or a download)
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        /* ignore */
      }
      const raven = code === -130 || code === -111 || code === -105 || code === -109 || code === -102 ? this.win.host.lastProxyError(host) : null;
      this.error = { code: String(code), text: raven ? ERR_TEXT[raven] : friendlyNetError(code, desc), url, ...(raven ? { raven } : {}) };
      this.url = url;
      this.title = host || url;
      this.win.changed();
    });
    wc.on('render-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit') return;
      this.crashed = true;
      this.win.changed();
    });
    wc.on('media-started-playing', () => {
      this.audible = true;
      this.win.changed();
    });
    wc.on('media-paused', () => {
      this.audible = false;
      this.win.changed();
    });
    wc.on('enter-html-full-screen', () => this.win.setHtmlFullscreen(true));
    wc.on('leave-html-full-screen', () => this.win.setHtmlFullscreen(false));
    wc.on('found-in-page', (_e, r) => {
      this.win.find = { ...this.win.find, active: r.activeMatchOrdinal, matches: r.matches };
      this.win.changed();
    });
    wc.on('zoom-changed', (_e, dir) => {
      wc.setZoomFactor(nextZoom(wc.getZoomFactor(), dir === 'in' ? 'in' : 'out'));
      this.win.changed();
    });
    wc.on('before-input-event', (e, input) => {
      if (this.win.handleShortcut(input)) e.preventDefault();
    });
    wc.on('context-menu', (_e, p) => this.win.contextMenu(this, p));
    wc.on('will-prevent-unload', (e) => e.preventDefault()); // never trap the user on "leave site?"
  }

  private scheduleVisit(delay = 2500): void {
    if (this.visitTimer) clearTimeout(this.visitTimer);
    this.visitTimer = setTimeout(() => {
      this.visitTimer = null;
      if (!this.wc || this.error || !this.win.host.historyAllowed(this.win.private)) return;
      this.win.host.memory().addVisit(this.wc.getURL(), this.wc.getTitle());
    }, delay);
  }

  load(raw: string): void {
    const internal = INTERNAL[raw.split('?')[0].toLowerCase()];
    if (internal) {
      this.internal = internal;
      this.url = raw;
      this.title = INTERNAL_TITLE[internal];
      if (internal === 'search') {
        try {
          const q = new URL(raw).searchParams.get('q');
          if (q) this.title = q;
        } catch {
          /* keep the default title */
        }
      }
      this.error = null;
      this.favicon = null;
      this.win.layout();
      this.win.changed();
      return;
    }
    const from = this.internal === 'search' ? this.url : null;
    this.internal = null;
    this.error = null;
    this.crashed = false;
    const view = this.ensureView();
    if (from) this.returnTo = { url: from, floor: view.webContents.navigationHistory.length() };
    this.url = raw;
    void view.webContents.loadURL(raw, isSignInUrl(raw) ? { userAgent: firefoxUserAgent() } : undefined).catch(() => {
      /* did-fail-load reports it */
    });
    this.win.layout();
    this.win.changed();
  }

  back(): void {
    const wc = this.wc;
    if (this.internal && wc && wc.getURL()) {
      this.internal = null;
      this.title = wc.getTitle();
      this.url = wc.getURL();
      this.win.layout();
      this.win.changed();
      return;
    }
    // Back from the first page opened from search results returns to the results.
    if (!this.internal && this.returnTo && wc && wc.navigationHistory.getActiveIndex() <= this.returnTo.floor) {
      const url = this.returnTo.url;
      this.returnTo = null;
      return this.load(url);
    }
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(): void {
    if (this.wc?.navigationHistory.canGoForward()) this.wc.navigationHistory.goForward();
  }

  reload(hard = false): void {
    if (this.internal) return this.win.changed();
    const wc = this.wc;
    if (!wc) return;
    this.error = null;
    this.crashed = false;
    if (hard) wc.reloadIgnoringCache();
    else if (!wc.getURL() && this.url) void wc.loadURL(this.url).catch(() => {});
    else wc.reload();
  }

  view_(): TabView {
    const wc = this.wc;
    const internal = this.internal;
    const url = internal ? this.url : wc?.getURL() || this.url;
    return {
      id: this.id,
      url,
      title: internal ? this.title || INTERNAL_TITLE[internal] : this.title || url,
      favicon: internal ? null : this.favicon,
      loading: !internal && !!wc?.isLoading(),
      canBack: (!!internal && !!wc?.getURL()) || (!internal && (!!wc?.navigationHistory.canGoBack() || !!this.returnTo)),
      canForward: !internal && !!wc?.navigationHistory.canGoForward(),
      pinned: this.pinned,
      internal,
      zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
      audible: this.audible,
      muted: !!wc?.isAudioMuted(),
      error: internal ? null : this.error,
      secure: url.startsWith('https://'),
      blocked: this.blocked,
      crashed: this.crashed,
    };
  }

  destroy(): void {
    if (this.visitTimer) clearTimeout(this.visitTimer);
    const wc = this.wc;
    if (this.view) this.win.detach(this);
    if (wc) wc.close();
    this.view = null;
  }
}

function friendlyNetError(code: number, desc: string): string {
  const map: Record<number, string> = {
    [-105]: 'The site name could not be found.',
    [-106]: 'This PC is not connected to the internet.',
    [-109]: 'The address is unreachable.',
    [-118]: 'The site took too long to respond.',
    [-102]: 'The site refused the connection.',
    [-100]: 'The connection was closed.',
    [-101]: 'The connection was reset.',
    [-130]: 'The connection through the master server failed.',
    [-200]: 'The site’s security certificate is not valid. Raven does not continue to sites with invalid certificates.',
    [-201]: 'The site’s security certificate has expired or the PC clock is wrong.',
    [-202]: 'The site’s security certificate is not trusted.',
    [-501]: 'The site uses a security setting this browser does not support.',
  };
  return map[code] ?? desc.replace(/^net::/, '').replace(/_/g, ' ').toLowerCase();
}

export class Win {
  id = winSeq++;
  window: BrowserWindow;
  tabs: Tab[] = [];
  activeId = 0;
  closed: { url: string; pinned: boolean }[] = [];
  sidebar = false;
  find: FindState = { open: false, text: '', active: 0, matches: 0 };
  perms: (PermissionAsk & { resolve: (ok: boolean, remember: boolean) => void })[] = [];
  pwOffer: PasswordOffer | null = null;
  backdrop: string | null = null;
  private rect = { x: 0, y: 92, width: 800, height: 600 };
  private overlay = false;
  private htmlFullscreen = false;
  private changeQueued = false;

  constructor(
    readonly host: Host,
    readonly session: Session,
    readonly private_: boolean,
  ) {
    this.window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 720,
      minHeight: 480,
      show: false,
      backgroundColor: '#100C0B',
      title: private_ ? 'Raven Browser (private)' : 'Raven Browser',
      icon: path.join(host.dir, 'icon.png'),
      frame: false,
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: path.join(host.dir, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: host.isDev,
        spellcheck: true,
        additionalArguments: [`--raven-window=${this.id}`],
      },
    });
    this.window.setMenuBarVisibility(false);
    void this.window.loadFile(path.join(host.dir, 'renderer', 'index.html'), { query: { win: String(this.id), private: private_ ? '1' : '0' } });
    const ui = this.window.webContents;
    ui.setWindowOpenHandler(() => ({ action: 'deny' }));
    ui.on('will-navigate', (e) => e.preventDefault());
    ui.on('context-menu', (_e, p) => editMenu(this.window, p));
    ui.on('before-input-event', (e, input) => {
      if (this.handleShortcut(input, true)) e.preventDefault();
    });
    // Raven's own controls never zoom (a zoomed interface would mis-size the page next to it).
    // Ctrl + mouse wheel over the tab bar or toolbar zooms the page instead.
    ui.on('did-finish-load', () => {
      ui.setZoomFactor(1);
      void ui.setVisualZoomLevelLimits(1, 1);
    });
    ui.on('zoom-changed', (_e, dir) => {
      ui.setZoomFactor(1);
      this.zoom(dir === 'in' ? 'in' : 'out');
    });
    this.window.once('ready-to-show', () => {
      // Test/automation runs (RAVEN_HEADLESS=1) render far off-screen without taking focus.
      if (process.env.RAVEN_HEADLESS === '1') {
        this.window.setSkipTaskbar(true);
        this.window.setPosition(-32000, -32000);
        this.window.showInactive();
      } else this.window.show();
    });
    this.window.on('resize', () => this.changed());
    this.window.on('maximize', () => this.changed());
    this.window.on('unmaximize', () => this.changed());
    this.window.on('enter-full-screen', () => this.changed());
    this.window.on('leave-full-screen', () => {
      this.htmlFullscreen = false;
      this.layout();
      this.changed();
    });
    this.window.on('closed', () => {
      for (const t of this.tabs) t.destroy();
      this.tabs = [];
      host.onWindowsChanged();
    });
  }

  get private(): boolean {
    return this.private_;
  }

  get active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  // ---------------------------------------------------------------- views
  attach(tab: Tab): void {
    if (!tab.view) return;
    this.window.contentView.addChildView(tab.view);
    tab.view.setVisible(false);
    this.layout();
  }

  detach(tab: Tab): void {
    if (!tab.view) return;
    try {
      this.window.contentView.removeChildView(tab.view);
    } catch {
      /* window already gone */
    }
  }

  setRect(r: { x: number; y: number; width: number; height: number }): void {
    this.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) };
    this.layout();
  }

  /** Overlays (menus, dialogs, suggestions) must sit above the page: the page is swapped for a still picture. */
  async setOverlay(on: boolean): Promise<void> {
    if (on === this.overlay) return;
    if (on) {
      const wc = this.active?.wc;
      if (wc && !this.active?.internal && this.active?.view?.getVisible()) {
        try {
          const img = await wc.capturePage();
          this.backdrop = img.isEmpty() ? null : img.resize({ width: Math.min(1400, img.getSize().width) }).toDataURL();
        } catch {
          this.backdrop = null;
        }
      } else this.backdrop = null;
    } else this.backdrop = null;
    this.overlay = on;
    this.layout();
    this.changed();
  }

  layout(): void {
    if (this.window.isDestroyed()) return;
    for (const t of this.tabs) {
      if (!t.view) continue;
      const show = t.id === this.activeId && !t.internal && !t.error && !t.crashed && !this.overlay;
      if (show) {
        const [cw, ch] = this.window.getContentSize();
        if (this.htmlFullscreen) {
          t.view.setBounds({ x: 0, y: 0, width: cw, height: ch });
        } else {
          // The page area is measured in the interface's CSS pixels; convert to window units and keep it inside the window.
          const z = this.window.webContents.getZoomFactor() || 1;
          const x = Math.max(0, Math.round(this.rect.x * z));
          const y = Math.max(0, Math.round(this.rect.y * z));
          t.view.setBounds({ x, y, width: Math.max(0, Math.min(Math.round(this.rect.width * z), cw - x)), height: Math.max(0, Math.min(Math.round(this.rect.height * z), ch - y)) });
        }
      }
      if (t.view.getVisible() !== show) t.view.setVisible(show);
    }
  }

  setHtmlFullscreen(on: boolean): void {
    this.htmlFullscreen = on;
    this.window.setFullScreen(on);
    this.layout();
    this.changed();
  }

  // ---------------------------------------------------------------- tabs
  newTab(opts: { url?: string; background?: boolean; after?: Tab; pinned?: boolean; adoptFrom?: WebContents } = {}): Tab {
    const t = new Tab(this);
    t.pinned = !!opts.pinned;
    const idx = opts.after ? this.tabs.indexOf(opts.after) + 1 : this.tabs.length;
    this.tabs.splice(idx > 0 ? idx : this.tabs.length, 0, t);
    if (opts.adoptFrom) t.adopt(opts.adoptFrom);
    else t.load(opts.url ?? 'raven://newtab');
    if (!opts.background) this.activate(t.id);
    this.changed();
    return t;
  }

  activate(id: number): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    if (this.find.open) this.closeFind();
    this.activeId = id;
    this.layout();
    const t = this.active;
    if (t?.wc && !t.internal) t.wc.focus();
    else this.window.webContents.focus();
    this.changed();
  }

  closeTab(id: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = this.tabs[i];
    const url = t.internal ? t.url : t.wc?.getURL() || t.url;
    if (!this.private && url && url !== 'raven://newtab') this.closed.push({ url, pinned: t.pinned });
    if (this.closed.length > 25) this.closed.shift();
    this.tabs.splice(i, 1);
    t.destroy();
    if (this.tabs.length === 0) {
      this.window.close();
      return;
    }
    if (this.activeId === id) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    this.changed();
  }

  reopenClosed(): void {
    const c = this.closed.pop();
    if (c) this.newTab({ url: c.url, pinned: c.pinned });
  }

  duplicate(id: number): void {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
    this.newTab({ url: t.internal ? t.url : t.wc?.getURL() || t.url, after: t });
  }

  pin(id: number, on: boolean): void {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
    t.pinned = on;
    // Pinned tabs live at the left edge.
    this.tabs = [...this.tabs.filter((x) => x.pinned), ...this.tabs.filter((x) => !x.pinned)];
    this.changed();
  }

  move(id: number, toIndex: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, toIndex)), 0, t);
    this.changed();
  }

  cycle(dir: 1 | -1): void {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].id);
  }

  // ---------------------------------------------------------------- page actions
  navigate(input: string, tabId?: number): void {
    const t = (tabId ? this.tabs.find((x) => x.id === tabId) : this.active) ?? this.newTab();
    const text = input.trim();
    if (!text) return;
    const url = toUrl(text);
    if (url) t.load(url);
    else {
      if (this.host.historyAllowed(this.private)) this.host.memory().addSearch(text, this.host.engineName());
      t.load(this.host.searchUrl(text));
    }
  }

  openFind(): void {
    if (!this.active?.wc || this.active.internal) return;
    this.find = { ...this.find, open: true };
    this.changed();
  }

  findText(text: string, forward = true, next = false): void {
    const wc = this.active?.wc;
    this.find = { ...this.find, open: true, text };
    if (!wc) return;
    if (!text) {
      wc.stopFindInPage('clearSelection');
      this.find = { ...this.find, active: 0, matches: 0 };
    } else wc.findInPage(text, { forward, findNext: next });
    this.changed();
  }

  closeFind(): void {
    this.active?.wc?.stopFindInPage('keepSelection');
    this.find = { open: false, text: this.find.text, active: 0, matches: 0 };
    this.changed();
  }

  zoom(dir: 'in' | 'out' | 'reset'): void {
    const wc = this.active?.wc;
    if (!wc || this.active?.internal) return;
    wc.setZoomFactor(nextZoom(wc.getZoomFactor(), dir));
    this.changed();
  }

  async confirmExternal(url: string): Promise<void> {
    const { dialog } = await import('electron');
    const r = await dialog.showMessageBox(this.window, {
      type: 'question',
      buttons: ['Cancel', 'Open'],
      defaultId: 0,
      cancelId: 0,
      message: 'Open this link in another program?',
      detail: url.slice(0, 300),
    });
    if (r.response === 1) void shell.openExternal(url);
  }

  // ---------------------------------------------------------------- keyboard
  handleShortcut(input: Electron.Input, fromUi = false): boolean {
    if (input.type !== 'keyDown') return false;
    const ctrl = input.control || input.meta;
    const k = input.key.toLowerCase();
    const send = (cmd: string) => this.window.webContents.send('raven:cmd', cmd);
    const t = this.active;
    if (ctrl && input.shift) {
      if (k === 't') return this.reopenClosed(), true;
      if (k === 'n') return this.host.openWindow({ private: true }), true;
      if (k === 'tab') return this.cycle(-1), true;
      if (k === 'delete') return send('clear-data'), true;
      if (k === 'b') return send('toggle-bookmarks-bar'), true;
      if (k === 'r') return t?.reload(true), true;
      return false;
    }
    if (ctrl && input.alt) return false;
    if (ctrl) {
      if (k === 't') return this.newTab(), true;
      if (k === 'n') return this.host.openWindow({}), true;
      if (k === 'w') return t && this.closeTab(t.id), true;
      if (k === 'l' || k === 'e') return send('focus-omnibox'), true;
      if (k === 'r') return t?.reload(), true;
      if (k === 'f') return this.openFind(), send('focus-find'), true;
      if (k === 'h') return this.newTab({ url: 'raven://history' }), true;
      if (k === 'j') return this.newTab({ url: 'raven://downloads' }), true;
      if (k === 'd') return send('bookmark'), true;
      if (k === 'k') return send('toggle-ai'), true;
      if (k === 'p') return t?.wc && !t.internal ? (t.wc.print({}), true) : false;
      if (k === 's') return send('save-page'), true;
      if (k === 'tab') return this.cycle(1), true;
      if (k === '=' || k === '+') return this.zoom('in'), true;
      if (k === '-') return this.zoom('out'), true;
      if (k === '0') return this.zoom('reset'), true;
      if (/^[1-8]$/.test(k)) {
        const target = this.tabs[Number(k) - 1];
        if (target) this.activate(target.id);
        return true;
      }
      if (k === '9') {
        const last = this.tabs[this.tabs.length - 1];
        if (last) this.activate(last.id);
        return true;
      }
      if (k === 'u' && this.host.isDev) return t?.wc?.openDevTools({ mode: 'detach' }), true;
      return false;
    }
    if (input.alt && !fromUi) {
      if (k === 'arrowleft') return t?.back(), true;
      if (k === 'arrowright') return t?.forward(), true;
    }
    if (input.alt && fromUi && (k === 'arrowleft' || k === 'arrowright')) {
      if (k === 'arrowleft') t?.back();
      else t?.forward();
      return true;
    }
    if (k === 'f5') return t?.reload(), true;
    if (k === 'f11') return this.window.setFullScreen(!this.window.isFullScreen()), true;
    if (k === 'f12' && this.host.isDev) return t?.wc?.openDevTools({ mode: 'detach' }), true;
    if (k === 'escape') {
      if (this.find.open) return this.closeFind(), true;
      if (t?.wc?.isLoading() && !fromUi) return t.wc.stop(), true;
    }
    return false;
  }

  // ---------------------------------------------------------------- context menu
  contextMenu(tab: Tab, p: Electron.ContextMenuParams): void {
    const wc = tab.wc;
    if (!wc) return;
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => this.newTab({ url: p.linkURL, background: true, after: tab }) },
        { label: 'Open link in new window', click: () => this.host.openWindow({ urls: [p.linkURL] }) },
        { label: 'Open link in private window', click: () => this.host.openWindow({ private: true, urls: [p.linkURL] }) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open image in new tab', click: () => this.newTab({ url: p.srcURL, after: tab }) },
        { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.selectionText.trim()) {
      const sel = p.selectionText.trim().slice(0, 20000);
      items.push(
        { label: 'Copy', role: 'copy' },
        { label: `Search for “${sel.slice(0, 28)}${sel.length > 28 ? '…' : ''}”`, click: () => this.newTab({ url: this.host.searchUrl(sel), after: tab }) },
        { label: 'Explain with Raven AI', click: () => this.host.askAi(this, 'explain', sel) },
        { label: 'Ask Raven AI about this…', click: () => this.host.askAi(this, 'ask', sel) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push({ label: 'Undo', role: 'undo' }, { label: 'Cut', role: 'cut' }, { label: 'Copy', role: 'copy' }, { label: 'Paste', role: 'paste' }, { label: 'Select all', role: 'selectAll' });
      if (p.misspelledWord && p.dictionarySuggestions.length) {
        items.unshift(...p.dictionarySuggestions.slice(0, 4).map((s) => ({ label: s, click: () => wc.replaceMisspelling(s) })), { type: 'separator' as const });
      }
      items.push({ type: 'separator' });
    }
    if (!p.linkURL && !p.selectionText && !p.isEditable && p.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => tab.back() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => tab.forward() },
        { label: 'Reload', click: () => tab.reload() },
        { type: 'separator' },
        { label: 'Summarize this page with Raven AI', click: () => this.host.askAi(this, 'summarize') },
        { label: 'Save page for offline reading', click: () => this.window.webContents.send('raven:cmd', 'save-page') },
        { label: 'Print…', click: () => wc.print({}) },
        { type: 'separator' },
      );
    }
    if (this.host.isDev) items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    while (items.length && items[items.length - 1].type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: this.window });
  }

  // ---------------------------------------------------------------- state
  changed(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    setTimeout(() => {
      this.changeQueued = false;
      if (this.window.isDestroyed()) return;
      this.window.webContents.send('raven:win', this.state());
      this.host.saveSession();
    }, 16);
  }

  state(): WindowState {
    const active = this.active;
    const url = active ? (active.internal ? active.url : active.wc?.getURL() || active.url) : '';
    return {
      windowId: this.id,
      private: this.private,
      tabs: this.tabs.map((t) => t.view_()),
      activeId: this.activeId,
      closedCount: this.closed.length,
      sidebar: this.sidebar,
      find: this.find,
      fullscreen: this.htmlFullscreen,
      maximized: this.window.isMaximized(),
      perms: this.perms.map(({ resolve: _r, ...p }) => p),
      pwOffer: this.pwOffer,
      backdrop: this.backdrop,
      bookmarked: !!url && !this.private && this.host.memory().isBookmarked(url),
    };
  }

  // ---------------------------------------------------------------- permissions
  askPermission(tabId: number, origin: string, permission: string): Promise<{ ok: boolean; remember: boolean }> {
    return new Promise((resolve) => {
      const id = permSeq++;
      this.perms.push({ id, tabId, origin, permission, resolve: (ok, remember) => resolve({ ok, remember }) });
      this.changed();
    });
  }

  answerPermission(id: number, ok: boolean, remember: boolean): void {
    const i = this.perms.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = this.perms.splice(i, 1);
    p.resolve(ok, remember);
    this.changed();
  }

  tabFor(wc: WebContents): Tab | undefined {
    return this.tabs.find((t) => t.wc === wc);
  }
}

/** Decide whether typed text is an address. Returns a URL, or null to search for it. */
export function toUrl(text: string): string | null {
  const t = text.trim();
  if (/^raven:\/\//i.test(t)) return t.toLowerCase();
  if (/^(https?|file|about|data|view-source):/i.test(t)) return t;
  if (/\s/.test(t)) return null;
  if (/^[a-z]:\\/i.test(t)) return 'file:///' + t.replace(/\\/g, '/');
  if (/^localhost(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(t)) return `http://${t}`;
  if (/^\[[0-9a-f:]+\](:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
  if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(:\d+)?([/?#].*)?$/iu.test(t)) return `https://${t}`;
  return null;
}

export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
