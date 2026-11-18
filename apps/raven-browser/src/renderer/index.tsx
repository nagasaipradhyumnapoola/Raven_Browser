import '../../../../packages/ui/src/styles.css';
import 'highlight.js/styles/github-dark.css';
import './browser.css';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, Btn, Chip, Dot, motion, useToasts } from '@raven/ui';
import type { Bookmark } from '@raven/local-memory';
import type { AppState, TabView, WindowState } from '../types';
import type { RouteDecision } from '@raven/shared';
import { C, Fav, classifyInput, hostOf, useC, type AiBridge, type Ctx } from './ctx';
import { AiSidebar } from './sidebar';
import { BookmarksPage, ConnectCard, ConnectPage, DownloadRow, DownloadsPage, HistoryPage, MemoryPage, NewTab, ReferencePage, SettingsPage, connTone } from './pages';
import { RemotePage, SearchPage } from './remotepages';
import { PasswordsPage } from './passwordspage';
import * as I from './icons';
import logoUrl from '../../../../assets/raven-logo.png';

type PopKind = 'menu' | 'downloads' | 'conn' | null;

function Pop({ x, y, right, children, onClose, width }: { x?: number; y: number; right?: number; children: React.ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 299 }} onMouseDown={onClose} />
      <motion.div className="pop" style={{ top: y, ...(right !== undefined ? { right } : { left: x }), width }} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.12 }}>
        {children}
      </motion.div>
    </>
  );
}

function MI({ icon, label, kb, onClick }: { icon?: React.ReactNode; label: string; kb?: string; onClick: () => void }) {
  return (
    <button className="mi" onClick={onClick}>
      <span className="ic">{icon}</span>
      {label}
      {kb && <span className="kb">{kb}</span>}
    </button>
  );
}

// ------------------------------------------------------------ tab strip
function Strip({ openTabMenu }: { openTabMenu: (t: TabView, x: number) => void }) {
  const { win, run } = useC();
  const drag = useRef<number | null>(null);
  return (
    <div className="strip">
      <img className="logo" src={logoUrl} alt="" />
      {win.private && (
        <span className="private-tag">
          <Chip tone="hot">Private</Chip>
        </span>
      )}
      <div className="tabs">
        <AnimatePresence initial={false}>
          {win.tabs.map((t, i) => (
            <motion.div
              layout="position"
              key={t.id}
              className={`tab ${t.id === win.activeId ? 'active' : ''} ${t.pinned ? 'pinned' : ''}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              draggable
              onDragStart={() => {
                drag.current = t.id;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (drag.current !== null && drag.current !== t.id) void run('moveTab', drag.current, i);
                drag.current = null;
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void run('closeTab', t.id);
                } else if (e.button === 0) void run('activate', t.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openTabMenu(t, e.clientX);
              }}
            >
              {/* Two icons only: Raven for its own pages and the assistant, a globe for websites. */}
              <span className="fav">{t.loading ? <span className="spinner" /> : t.crashed ? <I.IAlert /> : t.internal && t.internal !== 'search' && t.internal !== 'remote' ? <img src={logoUrl} alt="" className="own" /> : <I.IGlobe />}</span>
              {!t.pinned && <span className="ttl">{t.title}</span>}
              {!t.pinned && t.audible && (
                <span className="snd" onMouseDown={(e) => e.stopPropagation()} onClick={() => run('mute', t.id)} title={t.muted ? 'Unmute' : 'Mute'}>
                  {t.muted ? <I.IMuted /> : <I.ISound />}
                </span>
              )}
              {!t.pinned && (
                <button
                  className="x"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    void run('closeTab', t.id);
                  }}
                  aria-label="Close tab"
                >
                  <I.IClose />
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        <button className="icon-btn newtab-btn" title="New tab (Ctrl+T)" onClick={() => run('newTab')}>
          <I.IPlus />
        </button>
      </div>
      <div className="winctl">
        <button onClick={() => run('minimize')} title="Minimize">
          <I.IMinus />
        </button>
        <button onClick={() => run('maximize')} title={win.maximized ? 'Restore' : 'Maximize'}>
          {win.maximized ? <I.IRestore /> : <I.IMaximize />}
        </button>
        <button className="cls" onClick={() => run('close')} title="Close">
          <I.IClose />
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ address bar
function Omnibox({ tab, focusSignal }: { tab: TabView | undefined; focusSignal: number }) {
  const { run, overlay, win, toast, submit, aiAnswersQuestions, app, routing } = useC();
  const [focus, setFocus] = useState(false);
  const [text, setText] = useState('');
  const [sugs, setSugs] = useState<{ kind: string; title: string; url?: string }[]>([]);
  const [sel, setSel] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const shownUrl = tab ? (tab.internal ? '' : tab.url) : '';
  useEffect(() => {
    if (!focus) setText(shownUrl);
  }, [shownUrl, focus]);
  useEffect(() => {
    if (focusSignal) {
      setFocus(true);
      setTimeout(() => {
        input.current?.focus();
        input.current?.select();
      }, 0);
    }
  }, [focusSignal]);
  useEffect(() => {
    if (!focus || !text.trim() || text === shownUrl) {
      setSugs([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await run<{ kind: string; title: string; url?: string }[]>('suggest', text);
      setSugs(r ?? []);
      setSel(-1);
    }, 60);
    return () => clearTimeout(t);
  }, [text, focus]);
  const open = !!(focus && text.trim() && text !== shownUrl);
  useEffect(() => {
    overlay(open);
    return () => {
      if (open) overlay(false);
    };
  }, [open]);
  const kind = classifyInput(text);
  const engine = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing', brave: 'Brave Search', custom: 'the web' }[app.settings.searchEngine];
  // A question goes to the assistant first; the web search stays one arrow-press away.
  const head = kind === 'ai' && aiAnswersQuestions ? [{ kind: 'ai', title: text }, { kind: 'websearch', title: text }] : [{ kind: 'go', title: text }];
  const items: { kind: string; title: string; url?: string }[] = open ? [...head, ...sugs] : [];
  const commit = (i: number) => {
    const it = items[i] ?? items[0];
    if (!it) return;
    if (it.kind === 'ai' || it.kind === 'go') submit(it.title);
    else void run('navigate', it.kind === 'search' || it.kind === 'websearch' ? it.title : it.url ?? it.title);
    setText(shownUrl);
    input.current?.blur();
  };
  let host = '';
  try {
    host = new URL(shownUrl).hostname;
  } catch {
    host = '';
  }
  const hostAt = host ? shownUrl.indexOf(host) : -1;
  const editing = focus || !shownUrl;
  return (
    <div className="omni">
      <div className={`omni-box ${focus ? 'focus' : ''}`} onMouseDown={(e) => {
        if (!editing) {
          e.preventDefault();
          setFocus(true);
          setTimeout(() => {
            input.current?.focus();
            input.current?.select();
          }, 0);
        }
      }}>
        {tab && !tab.internal && !focus && (
          <span className={`lock ${tab.secure ? '' : 'warn'}`} title={tab.secure ? 'Secure connection (HTTPS)' : 'Not secure'}>
            {tab.secure ? <I.ILock /> : <I.IWarn />}
          </span>
        )}
        {(focus || !shownUrl) && (
          <span className="lock">
            <I.ISearch />
          </span>
        )}
        {editing ? (
          <input
            ref={input}
            value={text}
            placeholder={win.private ? 'Search privately or enter address' : 'Search or enter address'}
            spellCheck={false}
            onFocus={(e) => {
              setFocus(true);
              setTimeout(() => e.target.select(), 0);
            }}
            onBlur={() => setTimeout(() => setFocus(false), 120)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(sel < 0 ? 0 : sel);
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(-1, s - 1));
              } else if (e.key === 'Escape') {
                setText(shownUrl);
                input.current?.blur();
              }
            }}
          />
        ) : (
          <span className="omni-display">
            {hostAt >= 0 ? (
              <>
                <span className="url-rest">{shownUrl.slice(0, hostAt).replace(/^https:\/\//, '')}</span>
                <span className="url-host">{host}</span>
                <span className="url-rest">{shownUrl.slice(hostAt + host.length)}</span>
              </>
            ) : (
              <span className="url-host">{shownUrl}</span>
            )}
          </span>
        )}
        {routing && <span className="routing">Asking the AI…</span>}
        {tab && !tab.internal && !focus && (
          <button
            className="icon-btn"
            style={{ width: 26, height: 26 }}
            title="Copy address"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => void navigator.clipboard.writeText(shownUrl).then(() => toast('Address copied.', 'ok'))}
          >
            <I.ILink />
          </button>
        )}
        {tab && !tab.internal && !win.private && !focus && <BookmarkStar />}
      </div>
      {open && (
        <div className="suggest">
          {items.map((it, i) => (
            <div key={i} className={`it ${i === (sel < 0 ? 0 : sel) ? 'sel' : ''}`} onMouseDown={(e) => {
              e.preventDefault();
              commit(i);
            }} onMouseEnter={() => setSel(i)}>
              <span className="k">{it.kind === 'ai' ? <I.IChat /> : it.kind === 'bookmark' ? <I.IStar /> : it.kind === 'visit' ? <I.IClock /> : it.kind === 'go' && kind === 'url' ? <I.IGlobe /> : <I.ISearch />}</span>
              <span className="t">
                {it.kind === 'ai' ? `Ask the assistant: “${text}”` : it.kind === 'websearch' ? `Search ${engine} for “${text}”` : it.kind === 'go' ? (kind === 'url' ? text : `Search ${engine} for “${text}”`) : it.title}
              </span>
              {it.url && <span className="u">{hostOf(it.url)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BookmarkStar() {
  const { win, run, toast } = useC();
  return (
    <button
      className={`icon-btn ${win.bookmarked ? 'on' : ''}`}
      style={{ width: 26, height: 26, background: 'transparent' }}
      title={win.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark (Ctrl+D)'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={async (e) => {
        e.stopPropagation();
        const on = await run<boolean>('toggleBookmark');
        if (on !== undefined) toast(on ? 'Bookmarked.' : 'Bookmark removed.', 'ok');
      }}
    >
      <I.IStar fill={win.bookmarked ? 'currentColor' : 'none'} />
    </button>
  );
}

// ------------------------------------------------------------ toolbar
function Toolbar({ pop, setPop, focusSignal }: { pop: PopKind; setPop: (p: PopKind) => void; focusSignal: number }) {
  const { win, app, run } = useC();
  const tab = win.tabs.find((t) => t.id === win.activeId);
  const c = app.conn;
  const tone = connTone(c);
  const active = app.downloads.filter((d) => d.state === 'progressing').length;
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!tab?.loading) {
      setProgress((p) => (p ? 1 : 0));
      const t = setTimeout(() => setProgress(0), 300);
      return () => clearTimeout(t);
    }
    setProgress(0.1);
    const id = setInterval(() => setProgress((p) => Math.min(0.9, p + (0.94 - p) * 0.08)), 120);
    return () => clearInterval(id);
  }, [tab?.loading, tab?.id]);
  return (
    <div className="toolbar">
      <button className="icon-btn" title="Back (Alt+Left)" disabled={!tab?.canBack} onClick={() => run('back')}>
        <I.IBack />
      </button>
      <button className="icon-btn" title="Forward (Alt+Right)" disabled={!tab?.canForward} onClick={() => run('forward')}>
        <I.IForward />
      </button>
      {tab?.loading ? (
        <button className="icon-btn" title="Stop (Esc)" onClick={() => run('stop')}>
          <I.IClose />
        </button>
      ) : (
        <button className="icon-btn" title="Reload (Ctrl+R)" onClick={() => run('reload')}>
          <I.IReload />
        </button>
      )}
      <Omnibox tab={tab} focusSignal={focusSignal} />
      {tab && !tab.internal && (
        <div className="zoom-ctl" role="group" aria-label="Zoom">
          <button className="icon-btn" title="Zoom out (Ctrl+−)" onClick={() => run('zoom', 'out')} disabled={tab.zoom <= 25}>
            <I.IMinus />
          </button>
          <button className="zoom-val" title="Reset to 100% (Ctrl+0)" onClick={() => run('zoom', 'reset')}>
            {tab.zoom}%
          </button>
          <button className="icon-btn" title="Zoom in (Ctrl++)" onClick={() => run('zoom', 'in')} disabled={tab.zoom >= 500}>
            <I.IPlus />
          </button>
        </div>
      )}
      <button className="status-btn" onClick={() => setPop(pop === 'conn' ? null : 'conn')} title={c.detail}>
        <Dot tone={tone} />
        {c.label}
      </button>
      <button className={`text-btn ${win.sidebar ? 'on' : ''}`} onClick={() => run('sidebar')} title="Assistant (Ctrl+K)">
        <I.IChat />
        AI
      </button>
      <button className="icon-btn" style={{ position: 'relative' }} title="Downloads (Ctrl+J)" onClick={() => setPop(pop === 'downloads' ? null : 'downloads')}>
        <I.IDownload />
        {active > 0 && <span className="badge">{active}</span>}
      </button>
      <button className="icon-btn" title="Menu" onClick={() => setPop(pop === 'menu' ? null : 'menu')}>
        <I.IMore />
      </button>
      {progress > 0 && <motion.div className="progress" animate={{ width: `${progress * 100}%`, opacity: progress >= 1 ? 0 : 1 }} transition={{ duration: 0.2 }} />}
    </div>
  );
}

function BookmarksBar() {
  const { run, win, app } = useC();
  const [list, setList] = useState<Bookmark[]>([]);
  useEffect(() => {
    if (win.private) return;
    void run<Bookmark[]>('bookmarks').then((b) => b && setList(b.slice(0, 30)));
  }, [win.bookmarked, win.private]);
  if (!app.settings.showBookmarksBar || win.private || list.length === 0) return null;
  return (
    <div className="bmbar">
      {list.map((b) => (
        <button key={b.id} className="bm" onClick={() => run('navigate', b.url)} title={b.url}>
          <Fav url={b.url} size={14} />
          {b.title}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ content area
function ErrorPage({ tab }: { tab: TabView }) {
  const { run, go } = useC();
  const e = tab.error;
  const title = tab.crashed ? 'This page stopped working' : e?.raven === 'blocked_destination' ? 'This address is not allowed' : 'This page could not be opened';
  return (
    <div className="errpage">
      <div className="box">
        <div className="ico">{e?.raven ? <I.IServer size={20} /> : <I.IOffline size={20} />}</div>
        <h1>{title}</h1>
        <p className="selectable" style={{ fontSize: 14, margin: '10px 0 6px', color: 'var(--muted)' }}>
          {tab.crashed ? 'Reloading usually fixes it.' : e?.text}
        </p>
        {e && (
          <p className="faint selectable" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {e.url} · {e.raven ?? `error ${e.code}`}
          </p>
        )}
        <div className="row wrap" style={{ marginTop: 20 }}>
          <Btn variant="primary" onClick={() => run('reload')}>
            Try again
          </Btn>
          <Btn onClick={() => go('raven://connect')}>Connection</Btn>
        </div>
      </div>
    </div>
  );
}

const PERM_TEXT: Record<string, string> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  'camera+microphone': 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'see your screen',
  midi: 'use MIDI devices',
  midiSysex: 'fully control MIDI devices',
  hid: 'use HID devices',
  serial: 'use serial ports',
  usb: 'use USB devices',
  fileSystem: 'edit files on this PC',
  'storage-access': 'use its cookies on this site',
  'top-level-storage-access': 'use its cookies on this site',
  'idle-detection': 'know when you are idle',
  'speaker-selection': 'choose your speakers',
};

function Content() {
  const { win, run, app } = useC();
  const ref = useRef<HTMLDivElement>(null);
  const tab = win.tabs.find((t) => t.id === win.activeId);
  const perm = win.perms.find((p) => p.tabId === win.activeId);
  const pwOffer = win.pwOffer && win.pwOffer.tabId === win.activeId ? win.pwOffer : null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const send = () => {
      const r = el.getBoundingClientRect();
      void window.raven.invoke('setRect', { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener('resize', send);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', send);
    };
  }, [win.sidebar, app.settings.showBookmarksBar, win.fullscreen, !!perm, !!pwOffer]);
  const [findText, setFindText] = useState('');
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (win.find.open) setTimeout(() => findRef.current?.focus(), 30);
  }, [win.find.open]);
  useEffect(() => window.raven.on('raven:cmd', (cmd: string) => cmd === 'focus-find' && setTimeout(() => findRef.current?.select(), 40)), []);
  return (
    <div className="content">
      <div className="infobars">
        {perm && (
          <div className="permbar">
            <div style={{ fontSize: 13.5 }}>
              <b>{hostOf(perm.origin)}</b> wants to {PERM_TEXT[perm.permission] ?? perm.permission}
            </div>
            <PermButtons id={perm.id} />
          </div>
        )}
        {pwOffer && <PasswordBar offer={pwOffer} />}
        {win.find.open && (
          <div className="findbar">
            <input
              ref={findRef}
              value={findText}
              placeholder="Find in page"
              onChange={(e) => {
                setFindText(e.target.value);
                void run('find', e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run('find', findText, !e.shiftKey, true);
                if (e.key === 'Escape') void run('findClose');
              }}
            />
            <span className="faint" style={{ fontSize: 12, minWidth: 40, textAlign: 'right' }}>
              {findText ? `${win.find.active}/${win.find.matches}` : ''}
            </span>
            <button className="icon-btn" title="Previous" onClick={() => run('find', findText, false, true)}>
              <I.IBack style={{ transform: 'rotate(90deg)' }} />
            </button>
            <button className="icon-btn" title="Next" onClick={() => run('find', findText, true, true)}>
              <I.IBack style={{ transform: 'rotate(-90deg)' }} />
            </button>
            <button className="icon-btn" title="Close (Esc)" onClick={() => run('findClose')}>
              <I.IClose />
            </button>
          </div>
        )}
      </div>
      <div className="page-slot" ref={ref}>
      {win.backdrop && <img className="backdrop-img" src={win.backdrop} alt="" />}
      {tab?.internal === 'newtab' && <NewTab />}
      {tab?.internal === 'search' && <SearchPage />}
      {tab?.internal === 'remote' && <RemotePage />}
      {tab?.internal === 'history' && <HistoryPage />}
      {tab?.internal === 'bookmarks' && <BookmarksPage />}
      {tab?.internal === 'downloads' && <DownloadsPage />}
      {tab?.internal === 'settings' && <SettingsPage />}
      {tab?.internal === 'memory' && <MemoryPage />}
      {tab?.internal === 'reference' && <ReferencePage />}
      {tab?.internal === 'connect' && <ConnectPage />}
      {tab?.internal === 'passwords' && <PasswordsPage />}
      {tab && !tab.internal && (tab.error || tab.crashed) && <ErrorPage tab={tab} />}
      </div>
    </div>
  );
}

/** "Save password for this site?" — the password itself stays in Raven's main process. */
function PasswordBar({ offer }: { offer: NonNullable<WindowState['pwOffer']> }) {
  const { run } = useC();
  return (
    <div className="permbar pwbar">
      <I.ILock size={16} />
      <div style={{ fontSize: 13.5, flex: 1, minWidth: 0 }}>
        {offer.update ? 'Update the saved password' : 'Save password'} for <b>{hostOf(offer.origin)}</b>
        {offer.username && <span className="muted"> · {offer.username}</span>}?
      </div>
      <Btn size="sm" variant="primary" onClick={() => run('passwordAnswer', offer.id, 'save')}>
        {offer.update ? 'Update' : 'Save'}
      </Btn>
      {!offer.update && (
        <Btn size="sm" onClick={() => run('passwordAnswer', offer.id, 'never')}>
          Never for this site
        </Btn>
      )}
      <Btn size="sm" variant="ghost" onClick={() => run('passwordAnswer', offer.id, 'dismiss')}>
        Not now
      </Btn>
    </div>
  );
}

function PermButtons({ id }: { id: number }) {
  const { run, win } = useC();
  const [remember, setRemember] = useState(!win.private);
  return (
    <div className="row wrap" style={{ marginTop: 12 }}>
      <Btn size="sm" variant="primary" onClick={() => run('answerPermission', id, true, remember)}>
        Allow
      </Btn>
      <Btn size="sm" onClick={() => run('answerPermission', id, false, remember)}>
        Block
      </Btn>
      {!win.private && (
        <label className="row muted" style={{ fontSize: 12, gap: 6, cursor: 'pointer', marginLeft: 6 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember for this site
        </label>
      )}
    </div>
  );
}

// ------------------------------------------------------------ app
function App() {
  const [win, setWin] = useState<WindowState | null>(null);
  const [app, setApp] = useState<AppState | null>(null);
  const [pop, setPopRaw] = useState<PopKind>(null);
  const [tabMenu, setTabMenu] = useState<{ tab: TabView; x: number } | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [aiAction, setAiAction] = useState<AiBridge['pendingAction']>(null);
  const [routing, setRouting] = useState(false);
  const routeSeq = useRef(0);
  const [width, setWidth] = useState(420);
  const { push, view } = useToasts();
  const overlayCount = useRef(0);

  useEffect(() => {
    void window.raven.invoke('init').then((r) => {
      if (!r.ok) return;
      const d = r.data as { win: WindowState; app: AppState };
      setWin(d.win);
      setApp(d.app);
      setWidth(d.app.settings.aiWidth);
    });
    const offs = [
      window.raven.on('raven:win', setWin),
      window.raven.on('raven:app', setApp),
      window.raven.on('raven:toast', (t: { text: string; tone?: 'ok' | 'bad' }) => push(t.text, t.tone)),
      window.raven.on('raven:ai-action', (a: { action: 'explain' | 'summarize' | 'ask' | 'send'; text: string }) => setAiAction(a)),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  useEffect(() => {
    if (!app) return;
    const apply = () => {
      const dark = app.settings.theme === 'dark' || (app.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [app?.settings.theme]);

  const run = useCallback(
    async <T,>(method: string, ...args: unknown[]): Promise<T | undefined> => {
      const r = await window.raven.invoke(method, ...args);
      if (!r.ok) {
        push(r.error ?? 'Something went wrong.', 'bad');
        return undefined;
      }
      return (r.data === undefined ? (true as T) : (r.data as T));
    },
    [push],
  );

  const overlay = useCallback((on: boolean) => {
    overlayCount.current = Math.max(0, overlayCount.current + (on ? 1 : -1));
    void window.raven.invoke('overlay', overlayCount.current > 0);
  }, []);

  const setPop = useCallback(
    (p: PopKind) => {
      setPopRaw((prev) => {
        if (!prev && p) overlay(true);
        if (prev && !p) overlay(false);
        return p;
      });
    },
    [overlay],
  );

  const ctx = useMemo<Ctx | null>(() => {
    if (!win || !app) return null;
    const srv = app.conn.server;
    const aiReady = !!srv && srv.permissions.ai && srv.services.ai && !srv.services.maintenance && srv.aiBackend === 'ok';
    const aiAnswersQuestions = app.settings.addressBarAi && aiReady;
    const ask = (text: string) => {
      void run('sidebar', true);
      setAiAction({ action: 'send', text });
    };
    const task = (goal: string) => {
      void run('sidebar', true);
      setAiAction({ action: 'task', text: goal });
    };
    return {
      win,
      app,
      run,
      toast: push,
      go: (url, newTab) => void run(newTab ? 'newTab' : 'navigate', url),
      submit: (text: string) => {
        const t = text.trim();
        if (!t) return;
        const kind = classifyInput(t);
        // Addresses open directly. Everything else goes to the AI first, which decides: answer, open, search or do it.
        // Typing again while the AI is still deciding replaces the earlier request (no double actions).
        const my = ++routeSeq.current;
        if (kind === 'url' || !aiAnswersQuestions) {
          setRouting(false);
          return void run('navigate', t);
        }
        setRouting(true);
        void window.raven.invoke('route', t).then((r) => {
          if (my !== routeSeq.current) return;
          setRouting(false);
          const d = r.ok ? (r.data as RouteDecision) : null;
          if (!d) return kind === 'ai' ? ask(t) : void run('navigate', t);
          if (d.action === 'open') void run('navigate', d.url);
          else if (d.action === 'search') void run('navigate', d.query);
          else if (d.action === 'task') task(d.goal);
          else ask(t);
        });
      },
      routing,
      aiAnswersQuestions,
      overlay,
      ai: { open: () => void run('sidebar', true), ask, task, pendingAction: aiAction, clearAction: () => setAiAction(null) },
    };
  }, [win, app, run, push, overlay, aiAction, routing]);

  // A task on the master needs an answer: bring the Tasks pane up.
  useEffect(
    () =>
      window.raven.on('raven:agent', (t: { prompt: unknown; status: string }) => {
        if (t.prompt && t.status === 'waiting') {
          void run('sidebar', true);
          setAiAction((a) => a ?? { action: 'tasks', text: '' });
        }
      }),
    [run],
  );

  useEffect(() => {
    return window.raven.on('raven:cmd', async (cmd: string) => {
      if (cmd === 'focus-omnibox') setFocusSignal((n) => n + 1);
      else if (cmd === 'toggle-ai') void run('sidebar');
      else if (cmd === 'bookmark') {
        const on = await run<boolean>('toggleBookmark');
        if (on !== undefined) push(on ? 'Bookmarked.' : 'Bookmark removed.', 'ok');
      } else if (cmd === 'save-page') {
        const r = await run<{ title: string }>('savePage');
        if (r) push(`Saved “${r.title}” for offline reading.`, 'ok');
      } else if (cmd === 'toggle-bookmarks-bar' && app) void run('settings', { showBookmarksBar: !app.settings.showBookmarksBar });
      else if (cmd === 'clear-data') void run('newTab', 'raven://settings');
    });
  }, [run, push, app?.settings.showBookmarksBar]);

  if (!win || !app || !ctx) return null;
  const closeTabMenu = () => {
    setTabMenu(null);
    overlay(false);
  };
  const tab = win.tabs.find((t) => t.id === win.activeId);
  const tabHost = (() => {
    try {
      return tab && !tab.internal ? new URL(tab.url).hostname : '';
    } catch {
      return '';
    }
  })();
  const close = () => setPop(null);
  return (
    <C.Provider value={ctx}>
      <div className={`app ${win.private ? 'private' : ''} ${win.fullscreen ? 'fs' : ''}`}>
        <Strip
          openTabMenu={(t, x) => {
            overlay(true);
            setTabMenu({ tab: t, x });
          }}
        />
        <Toolbar pop={pop} setPop={setPop} focusSignal={focusSignal} />
        <BookmarksBar />
        <div className="body">
          <Content />
          {win.sidebar && !win.fullscreen && (
            <>
              <div
                className="resizer"
                onMouseDown={(e) => {
                  const startX = e.clientX;
                  const startW = width;
                  overlay(true);
                  const move = (ev: MouseEvent) => setWidth(Math.max(320, Math.min(760, startW + (startX - ev.clientX))));
                  const up = (ev: MouseEvent) => {
                    window.removeEventListener('mousemove', move);
                    window.removeEventListener('mouseup', up);
                    overlay(false);
                    void run('settings', { aiWidth: Math.max(320, Math.min(760, startW + (startX - ev.clientX))) });
                  };
                  window.addEventListener('mousemove', move);
                  window.addEventListener('mouseup', up);
                }}
              />
              <AiSidebar width={width} />
            </>
          )}
        </div>
      </div>

      {pop === 'menu' && (
        <Pop y={86} right={8} onClose={close} width={280}>
          <MI icon={<I.IPlus />} label="New tab" kb="Ctrl+T" onClick={() => (close(), void run('newTab'))} />
          <MI icon={<I.IWindow />} label="New window" kb="Ctrl+N" onClick={() => (close(), void run('newWindow', false))} />
          <MI icon={<I.IPrivate />} label="New private window" kb="Ctrl+Shift+N" onClick={() => (close(), void run('newWindow', true))} />
          <div className="sep" />
          <MI icon={<I.IHistory />} label="History" kb="Ctrl+H" onClick={() => (close(), void run('newTab', 'raven://history'))} />
          <MI icon={<I.ILock />} label="Passwords" onClick={() => (close(), void run('newTab', 'raven://passwords'))} />
          <MI icon={<I.IBookmark />} label="Bookmarks" onClick={() => (close(), void run('newTab', 'raven://bookmarks'))} />
          <MI icon={<I.IDownload />} label="Downloads" kb="Ctrl+J" onClick={() => (close(), void run('newTab', 'raven://downloads'))} />
          <MI icon={<I.IMemory />} label="Memory and notes" onClick={() => (close(), void run('newTab', 'raven://memory'))} />
          <MI icon={<I.IBook />} label="Programming reference" onClick={() => (close(), void run('newTab', 'raven://reference'))} />
          {tab && !tab.internal && (
            <>
              <div className="sep" />
              <MI icon={<I.ISearch />} label="Find in page" kb="Ctrl+F" onClick={() => (close(), void run('find', ''))} />
              {app.conn.server?.permissions.internet && (
                <MI icon={<I.IServer />} label="Open this page on the master" onClick={() => (close(), void run('remoteOpen', tab.url))} />
              )}
              <MI icon={<I.IPrint />} label="Print" kb="Ctrl+P" onClick={() => (close(), void run('print'))} />
              <MI icon={<I.ISave />} label="Save page for offline" kb="Ctrl+S" onClick={async () => {
                close();
                const r = await run<{ title: string }>('savePage');
                if (r) push(`Saved “${r.title}”.`, 'ok');
              }} />
              <div className="row" style={{ padding: '2px 4px 2px 10px', gap: 2 }}>
                <span className="muted" style={{ fontSize: 13, flex: 1 }}>
                  Zoom {tab.zoom}%
                </span>
                <button className="icon-btn" title="Zoom out" onClick={() => run('zoom', 'out')}>
                  <I.IMinus />
                </button>
                <button className="icon-btn" title="Zoom in" onClick={() => run('zoom', 'in')}>
                  <I.IPlus />
                </button>
                <button className="icon-btn" title="Full screen (F11)" onClick={() => (close(), void run('fullscreen'))}>
                  <I.IFullscreen />
                </button>
              </div>
              {app.settings.adblock && tabHost && (
                <MI
                  icon={<I.IShield />}
                  label={app.settings.adblockAllow.includes(tabHost) ? 'Block ads on this site' : 'Allow ads on this site'}
                  onClick={() => (close(), void run('adblockSite', app.settings.adblockAllow.includes(tabHost)))}
                />
              )}
            </>
          )}
          <div className="sep" />
          <MI icon={<I.IServer />} label="Master server" onClick={() => (close(), void run('newTab', 'raven://connect'))} />
          <MI icon={<I.ISettings />} label="Settings" onClick={() => (close(), void run('newTab', 'raven://settings'))} />
          <div className="sep" />
          <MI icon={<I.IPower />} label="Quit" onClick={() => run('quit')} />
          {app.updateAvailable && (
            <div className="hd faint" style={{ fontSize: 12 }}>
              Version {app.updateAvailable} is available from the server owner.
            </div>
          )}
        </Pop>
      )}
      {pop === 'downloads' && (
        <Pop y={86} right={46} onClose={close} width={380}>
          <div className="hd row between">
            <span className="label">Downloads</span>
            <Btn size="sm" variant="ghost" onClick={() => (close(), void run('newTab', 'raven://downloads'))}>
              Show all
            </Btn>
          </div>
          {app.downloads.slice(0, 8).map((d) => (
            <DownloadRow key={d.id} d={d as any} />
          ))}
          {app.downloads.length === 0 && (
            <div className="faint" style={{ padding: '6px 10px 12px' }}>
              No downloads yet.
            </div>
          )}
        </Pop>
      )}
      {pop === 'conn' && (
        <Pop y={86} right={120} onClose={close} width={520}>
          <div style={{ padding: 4 }}>
            <ConnectCard />
          </div>
        </Pop>
      )}
      {tabMenu && (
        <Pop x={Math.min(tabMenu.x, window.innerWidth - 240)} y={40} onClose={closeTabMenu} width={230}>
          <MI icon={<I.IPlus />} label="New tab" onClick={() => (closeTabMenu(), void run('newTab'))} />
          <MI icon={<I.ICopy />} label="Duplicate" onClick={() => (closeTabMenu(), void run('duplicate', tabMenu.tab.id))} />
          <MI icon={<I.IPin />} label={tabMenu.tab.pinned ? 'Unpin' : 'Pin'} onClick={() => (closeTabMenu(), void run('pin', tabMenu.tab.id, !tabMenu.tab.pinned))} />
          {tabMenu.tab.audible && <MI icon={tabMenu.tab.muted ? <I.ISound /> : <I.IMuted />} label={tabMenu.tab.muted ? 'Unmute' : 'Mute'} onClick={() => (closeTabMenu(), void run('mute', tabMenu.tab.id))} />}
          {!tabMenu.tab.internal && <MI icon={<I.ILink />} label="Copy address" onClick={() => (closeTabMenu(), void navigator.clipboard.writeText(tabMenu.tab.url))} />}
          <div className="sep" />
          <MI icon={<I.IClose />} label="Close" kb="Ctrl+W" onClick={() => (closeTabMenu(), void run('closeTab', tabMenu.tab.id))} />
          <MI icon={<I.IClose />} label="Close other tabs" onClick={() => (closeTabMenu(), void run('closeOthers', tabMenu.tab.id))} />
          <MI icon={<I.IHistory />} label="Reopen closed tab" kb="Ctrl+Shift+T" onClick={() => (closeTabMenu(), void run('reopen'))} />
        </Pop>
      )}
      {view}
    </C.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
