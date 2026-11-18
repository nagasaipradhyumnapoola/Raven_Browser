// Internal pages: new tab, history, bookmarks, downloads, memory, master
// server connection, settings, programming reference.
import React, { useEffect, useMemo, useState } from 'react';
import { Btn, Card, Chip, Dot, Smoke, Toggle, ago, fmtBytes } from '@raven/ui';
import type { Bookmark, DownloadRec, MemoryStats, Note, SearchHit, SearchRec, VisitRec } from '@raven/local-memory';
import type { BrowserSettings, ConnView } from '../types';
import { Fav, dayLabel, hostOf, useC } from './ctx';
import { AsciiMap } from './asciimap';
import { ReferencePane } from './sidebar';
import * as I from './icons';
import logoUrl from '../../../../assets/raven-logo.png';

export function connTone(c: ConnView): 'ok' | 'warn' | 'bad' {
  if (c.state === 'gateway_online') return 'ok';
  if (c.state === 'direct' || c.state === 'gateway_degraded' || c.state === 'ai_unavailable' || c.state === 'connecting' || c.state === 'awaiting_authorization' || c.state === 'discovering') return 'warn';
  return 'bad';
}

// ------------------------------------------------------------ connection card
export function ConnectCard({ full }: { full?: boolean }) {
  const { app, run, toast } = useC();
  const c = app.conn;
  const [addr, setAddr] = useState(app.settings.manualServer);
  const [ca, setCa] = useState(app.settings.manualServerCa);
  const s = c.server;
  const connectAddr = async () => {
    await run('settings', { manualServer: addr.trim(), manualServerCa: ca });
    await run('connectAddress', addr.trim(), ca);
  };
  return (
    <Card className="conn-card">
      <div className="row between wrap">
        <div className="row" style={{ gap: 10 }}>
          <Dot tone={connTone(c)} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{c.label}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {c.detail}
            </div>
          </div>
        </div>
        {s && (
          <div className="row wrap" style={{ gap: 6 }}>
            <Chip tone={s.permissions.internet && s.services.internet ? 'ok' : 'warn'}>Internet {s.permissions.internet && s.services.internet ? 'on' : 'off'}</Chip>
            <Chip tone={s.permissions.ai && s.services.ai && s.aiBackend === 'ok' ? 'ok' : 'warn'}>AI {s.permissions.ai && s.services.ai ? (s.aiBackend === 'ok' ? 'on' : 'unavailable') : 'off'}</Chip>
          </div>
        )}
      </div>

      {c.pairingCode && (
        <div className="row wrap" style={{ marginTop: 16, gap: 16, padding: 12, borderRadius: 8, background: 'var(--surface-2)' }}>
          <div className="selectable" style={{ font: '600 26px/1 var(--mono)', letterSpacing: '0.18em' }}>
            {c.pairingCode}
          </div>
          <div className="muted" style={{ fontSize: 13, maxWidth: 380 }}>
            In Raven Master Server, approve <b style={{ color: 'var(--text)' }}>{c.deviceName}</b> if it shows this same code. You only do this once.
          </div>
        </div>
      )}

      {!c.endpoint && (
        <div style={{ marginTop: 16 }}>
          <div className="label">Master servers on this network</div>
          <div className="col" style={{ marginTop: 8, gap: 6 }}>
            {c.discovered.map((d) => (
              <div key={`${d.fp}${d.host}`} className="row between" style={{ padding: '6px 6px 6px 10px', borderRadius: 8, background: 'var(--surface-2)' }}>
                <span>
                  {d.name}
                </span>
                <Btn size="sm" variant="primary" onClick={() => run('connect', d)}>
                  Connect
                </Btn>
              </div>
            ))}
            {c.discovered.length === 0 && (
              <span className="muted row" style={{ fontSize: 13 }}>
                <span className="spinner" /> Searching. Raven Master Server must be running on the same network.
              </span>
            )}
          </div>
        </div>
      )}

      {(full || !c.endpoint || c.link.set || c.state === 'server_unreachable') && <LinkSection />}

      {(full || !c.endpoint) && (
        <div style={{ marginTop: 16 }}>
          <div className="label">Or enter the address</div>
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input" placeholder="Address from the master's dashboard" value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addr.trim() && void connectAddr()} />
            <Btn variant="primary" disabled={!addr.trim()} onClick={() => void connectAddr()}>
              Connect
            </Btn>
          </div>
          <label className="row muted" style={{ marginTop: 10, fontSize: 12.5, cursor: 'pointer' }}>
            <Toggle on={ca} onChange={setCa} label="Public tunnel address" /> Public tunnel address with a regular HTTPS certificate (remote access)
          </label>
        </div>
      )}

      {c.endpoint && (
        <div className="row wrap" style={{ marginTop: 14 }}>
          <span className="faint selectable" style={{ fontSize: 12 }}>
            {c.endpoint.paired ? 'Paired' : 'Not approved yet'}
          </span>
          <span className="grow" />
          {!s && (
            <Btn size="sm" onClick={() => run('reconnect')}>
              Reconnect
            </Btn>
          )}
          {full && (
            <Btn size="sm" variant="ghost" onClick={async () => (await run('forgetServer')) !== undefined && toast('Server removed.', 'ok')}>
              Forget server
            </Btn>
          )}
        </div>
      )}
      {c.lastError && !s && <div className="warn" style={{ marginTop: 10, fontSize: 12.5 }}>{c.lastError}</div>}
    </Card>
  );
}

const LINK_TEXT: Record<string, string> = {
  idle: 'Raven joins the master’s Wi-Fi by itself whenever the master cannot be reached.',
  joining: 'Joining Raven Wi-Fi…',
  joined: 'On Raven Wi-Fi.',
  'wifi-off': 'Wi-Fi is switched off on this computer.',
  'adapter-disabled': 'The Wi-Fi adapter is turned off in Windows. Turn it on to join Raven Wi-Fi.',
  'no-adapter': 'This computer has no Wi-Fi adapter. Use a cable or a USB Wi-Fi adapter.',
  'not-found': 'Raven Wi-Fi is not in range.',
  error: 'Could not join Raven Wi-Fi.',
};

/** Raven Wi-Fi: type the master's link code once; the browser joins the master's own network by itself. */
function LinkSection() {
  const { app, run, toast } = useC();
  const l = app.conn.link;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const join = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      if ((await run('linkUse', code.trim())) !== undefined) setCode('');
    } finally {
      setBusy(false);
    }
  };
  if (!l.set)
    return (
      <div style={{ marginTop: 16 }}>
        <div className="label">No Wi-Fi or internet here?</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Type the link code shown in Raven Master Server under Raven Wi-Fi. You only do this once.
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            className="input"
            style={{ fontFamily: 'var(--mono)', letterSpacing: '0.06em' }}
            placeholder="Link code, like K7QM2-XW4PH"
            value={code}
            maxLength={16}
            spellCheck={false}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && void join()}
          />
          <Btn variant="primary" disabled={!code.trim() || busy} onClick={() => void join()}>
            {busy ? 'Joining…' : 'Join'}
          </Btn>
        </div>
      </div>
    );
  const tone = l.state === 'joined' ? 'ok' : l.state === 'joining' || l.state === 'idle' ? 'warn' : 'bad';
  return (
    <div style={{ marginTop: 16 }}>
      <div className="label">Raven Wi-Fi</div>
      <div className="row wrap" style={{ marginTop: 8, gap: 10 }}>
        <Dot tone={tone} live={l.state === 'joining'} />
        <span className="muted" style={{ fontSize: 13, flex: 1, minWidth: 200 }}>
          {LINK_TEXT[l.state] ?? LINK_TEXT.error}
          {l.error && l.state !== 'joined' && l.state !== 'adapter-disabled' ? ` ${l.error}` : ''}
        </span>
        {l.state === 'adapter-disabled' && (
          <Btn
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await run('linkEnableWifi');
              } finally {
                setBusy(false);
              }
            }}
          >
            Turn on Wi-Fi
          </Btn>
        )}
        {l.state !== 'joining' && l.state !== 'joined' && l.state !== 'adapter-disabled' && (
          <Btn size="sm" onClick={() => run('reconnect')}>
            Try again
          </Btn>
        )}
        <Btn size="sm" variant="ghost" onClick={async () => (await run('linkForget')) !== undefined && toast('Link code removed.', 'ok')}>
          Change code
        </Btn>
      </div>
      {l.state === 'adapter-disabled' && (
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          Windows asks for permission once.
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ new tab
export function NewTab() {
  const { app, win, run, go, submit, aiAnswersQuestions } = useC();
  const [q, setQ] = useState('');
  const needsServer = app.conn.state !== 'gateway_online' && (app.conn.state !== 'direct' || !!app.conn.pairingCode || !app.conn.endpoint);
  return (
    <div className="ntp">
      {app.settings.smoke && <AsciiMap />}
      <div className="ntp-inner">
        <div className="mast">
          <img src={logoUrl} alt="" />
          <h1 className="swap" aria-label="Raven">
            {'Raven'.split('').map((ch, i) => (
              <span key={i} style={{ transitionDelay: `${i * 35}ms` }} aria-hidden="true">
                <span>{ch}</span>
                <span>{ch}</span>
              </span>
            ))}
          </h1>
        </div>
        <form
          className="ntp-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) submit(q);
          }}
        >
          <div className="box">
            <I.ISearch />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={aiAnswersQuestions ? 'Ask a question, search, or enter address' : win.private ? 'Search privately or enter address' : 'Search or enter address'} />
          </div>
        </form>
        {needsServer && <ConnectCard />}
      </div>
    </div>
  );
}

function Page({ title, sub, right, children }: { title: string; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="internal">
      <div className="internal-inner">
        <div className="ip-head">
          <div>
            <h1>{title}</h1>
            {sub && (
              <div className="muted" style={{ fontSize: 13, marginTop: 6, maxWidth: 620 }}>
                {sub}
              </div>
            )}
          </div>
          {right}
        </div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ history
export function HistoryPage() {
  const { run, go, toast, win } = useC();
  const [tab, setTab] = useState<'pages' | 'searches'>('pages');
  const [q, setQ] = useState('');
  const [visits, setVisits] = useState<VisitRec[]>([]);
  const [searches, setSearches] = useState<SearchRec[]>([]);
  const load = async () => {
    setVisits((await run<VisitRec[]>('history', { limit: 600, q: q || undefined })) ?? []);
    setSearches((await run<SearchRec[]>('searches', { limit: 400, q: q || undefined })) ?? []);
  };
  useEffect(() => {
    const t = setTimeout(load, 120);
    return () => clearTimeout(t);
  }, [q]);
  const groups = useMemo(() => {
    const out: [string, (VisitRec | SearchRec)[]][] = [];
    for (const r of tab === 'pages' ? visits : searches) {
      const d = dayLabel(r.ts);
      if (!out.length || out[out.length - 1][0] !== d) out.push([d, []]);
      out[out.length - 1][1].push(r);
    }
    return out;
  }, [visits, searches, tab]);
  return (
    <Page
      title="History"
      sub={win.private ? 'Private window: nothing from this window is added.' : undefined}
      right={
        <Btn
          variant="danger"
          onClick={async () => {
            if (!confirm(tab === 'pages' ? 'Delete all browsing history? Downloaded files are not affected.' : 'Delete all search history?')) return;
            await run(tab === 'pages' ? 'clearHistory' : 'clearSearches', tab === 'pages' ? { all: true } : undefined);
            toast('Deleted.', 'ok');
            void load();
          }}
        >
          Clear {tab === 'pages' ? 'history' : 'searches'}
        </Btn>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input" placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340 }} />
        <div className="seg">
          <button className={tab === 'pages' ? 'on' : ''} onClick={() => setTab('pages')}>
            Pages
          </button>
          <button className={tab === 'searches' ? 'on' : ''} onClick={() => setTab('searches')}>
            Searches
          </button>
        </div>
      </div>
      {groups.map(([day, rows]) => (
        <div key={day}>
          <div className="label day">{day}</div>
          {rows.map((r, i) =>
            'url' in r ? (
              <div className="list-row" key={`${r.ts}-${i}`} onClick={() => go(r.url)}>
                <span className="tm">{new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <Fav url={r.url} />
                <span className="tt">{r.title}</span>
                <span className="uu">{hostOf(r.url)}</span>
                <button
                  className="icon-btn rm"
                  title="Remove from history"
                  onClick={async (e) => {
                    e.stopPropagation();
                    await run('clearHistory', { url: r.url });
                    void load();
                  }}
                >
                  <I.IClose size={14} />
                </button>
              </div>
            ) : (
              <div className="list-row" key={`${r.ts}-${i}`} onClick={() => run('navigate', r.q)}>
                <span className="tm">{new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <I.ISearch size={15} color="var(--faint)" />
                <span className="tt">{r.q}</span>
                <span className="uu">{r.engine}</span>
              </div>
            ),
          )}
        </div>
      ))}
      {groups.length === 0 && <div className="faint">Nothing here{q ? ' for that search' : ' yet'}.</div>}
    </Page>
  );
}

// ------------------------------------------------------------ bookmarks
export function BookmarksPage() {
  const { run, go } = useC();
  const [list, setList] = useState<Bookmark[]>([]);
  const [q, setQ] = useState('');
  const load = async () => setList((await run<Bookmark[]>('bookmarks')) ?? []);
  useEffect(() => void load(), []);
  const shown = list.filter((b) => !q || `${b.title} ${b.url}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page title="Bookmarks" sub="Press Ctrl+D on any page to bookmark it.">
      <input className="input" placeholder="Search bookmarks" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340, marginBottom: 12 }} />
      {shown.map((b) => (
        <div className="list-row" key={b.id} onClick={() => go(b.url)}>
          <Fav url={b.url} />
          <span className="tt">{b.title}</span>
          <span className="uu">{b.url}</span>
          <button
            className="icon-btn rm"
            title="Delete bookmark"
            onClick={async (e) => {
              e.stopPropagation();
              await run('removeBookmark', b.id);
              void load();
            }}
          >
            <I.ITrash size={14} />
          </button>
        </div>
      ))}
      {shown.length === 0 && <div className="faint">No bookmarks{q ? ' match' : ' yet'}.</div>}
    </Page>
  );
}

// ------------------------------------------------------------ downloads
export function DownloadRow({ d }: { d: DownloadRec & { paused?: boolean } }) {
  const { toast } = useC();
  const pct = d.size > 0 ? Math.min(1, d.received / d.size) : 0;
  const act = async (a: string) => {
    const r = await window.raven.invoke('downloadAction', d.id, a);
    if (!r.ok) toast(r.error ?? 'Failed.', 'bad');
  };
  return (
    <div className="dl-row">
      <span className="fn selectable">{d.filename}</span>
      <span className="row" style={{ gap: 2 }}>
        {d.state === 'progressing' && (
          <>
            <Btn size="sm" variant="ghost" onClick={() => void act(d.paused ? 'resume' : 'pause')}>
              {d.paused ? 'Resume' : 'Pause'}
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => void act('cancel')}>
              Cancel
            </Btn>
          </>
        )}
        {d.state === 'completed' && (
          <>
            <Btn size="sm" variant="ghost" onClick={() => void act('open')}>
              Open
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => void act('show')}>
              Show in folder
            </Btn>
          </>
        )}
        {(d.state === 'interrupted' || d.state === 'cancelled') && (
          <Btn size="sm" variant="ghost" onClick={() => void act(d.state === 'interrupted' ? 'resume' : 'retry')}>
            {d.state === 'interrupted' ? 'Resume' : 'Retry'}
          </Btn>
        )}
        {d.state !== 'progressing' && (
          <button className="icon-btn" title="Remove from list (the file stays)" onClick={() => void act('forget')}>
            <I.IClose size={14} />
          </button>
        )}
      </span>
      {d.state === 'progressing' && (
        <div className="bar">
          <i style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      )}
      <span className="meta">
        {d.state === 'progressing' ? `${fmtBytes(d.received)} of ${d.size ? fmtBytes(d.size) : 'unknown size'}${d.paused ? ' · paused' : ''}` : d.state === 'completed' ? `${fmtBytes(d.size || d.received)} · ${ago(d.done ?? d.ts)}` : d.state === 'interrupted' ? 'Interrupted' : 'Cancelled'} · {hostOf(d.url)}
      </span>
    </div>
  );
}

export function DownloadsPage() {
  const { app, run, toast } = useC();
  return (
    <Page
      title="Downloads"
      sub={`Saved to ${app.settings.downloadDir}${app.settings.askWhereToSave ? ', or wherever you choose' : ''}. Downloaded programs are never opened automatically.`}
      right={
        <div className="row">
          <Btn onClick={() => run('chooseDownloadDir')}>Change folder</Btn>
          <Btn variant="ghost" onClick={async () => (await run('clearDownloads')) && toast('List cleared. Files are still on disk.', 'ok')}>
            Clear list
          </Btn>
        </div>
      }
    >
      <Card style={{ padding: 4 }}>
        {app.downloads.map((d) => (
          <DownloadRow key={d.id} d={d as DownloadRec & { paused?: boolean }} />
        ))}
        {app.downloads.length === 0 && (
          <div className="faint" style={{ padding: 12 }}>
            No downloads yet.
          </div>
        )}
      </Card>
    </Page>
  );
}

// ------------------------------------------------------------ memory
const KIND_LABEL: Record<string, string> = { visit: 'Page', search: 'Search', bookmark: 'Bookmark', note: 'Note', chat: 'Chat', download: 'Download', page: 'Saved page' };

export function MemoryPage() {
  const { run, go, toast, ai } = useC();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [deep, setDeep] = useState(false);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [saved, setSaved] = useState<{ id: string; url: string; title: string; ts: number }[]>([]);
  const [editing, setEditing] = useState<{ id?: string; title: string; body: string; url?: string } | null>(null);
  const load = async () => {
    setStats((await run<MemoryStats>('memoryStats')) ?? null);
    setNotes((await run<Note[]>('notes')) ?? []);
    setSaved((await run<{ id: string; url: string; title: string; ts: number }[]>('savedPages')) ?? []);
  };
  useEffect(() => void load(), []);
  useEffect(() => {
    if (!q.trim()) return setHits([]);
    const t = setTimeout(async () => setHits((await run<SearchHit[]>('memorySearch', q, undefined, deep)) ?? []), 120);
    return () => clearTimeout(t);
  }, [q, deep]);
  const open = (h: SearchHit) => {
    if (h.kind === 'chat') return ai.open();
    if (h.kind === 'note' && h.ref) {
      const n = notes.find((x) => x.id === h.ref);
      if (n) setEditing(n);
      return;
    }
    if (h.kind === 'page' && h.ref) return void run('openSavedPage', h.ref);
    if (h.kind === 'search') return void run('navigate', h.title);
    if (h.url) go(h.url);
  };
  return (
    <Page
      title="Memory"
      sub={stats ? `Pages, searches, bookmarks, notes, saved pages and chats on this PC. ${stats.indexedDocs.toLocaleString()} items, ${fmtBytes(stats.bytes)}. Works offline.` : undefined}
      right={<Btn onClick={() => setEditing({ title: '', body: '' })}>New note</Btn>}
    >
      <div className="row" style={{ marginBottom: 14 }}>
        <input className="input" autoFocus placeholder="Search memory" value={q} onChange={(e) => setQ(e.target.value)} style={{ height: 36 }} />
        <label className="row muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap', cursor: 'pointer' }}>
          <Toggle on={deep} onChange={setDeep} label="Include older history" /> Older history
        </label>
      </div>
      {q && (
        <Card style={{ padding: 4, marginBottom: 16 }}>
          {hits.map((h, i) => (
            <div className="list-row" key={i} onClick={() => open(h)} style={{ height: 'auto', minHeight: 36, padding: '6px 10px' }}>
              <span className="kind faint" style={{ fontSize: 12 }}>
                {KIND_LABEL[h.kind]}
              </span>
              <span className="tt">
                {h.title}
                {h.snippet && h.kind !== 'search' && (
                  <span className="faint" style={{ display: 'block', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {h.snippet}
                  </span>
                )}
              </span>
              <span className="uu">{ago(h.ts)}</span>
            </div>
          ))}
          {hits.length === 0 && (
            <div className="faint" style={{ padding: 10 }}>
              Nothing found.
            </div>
          )}
        </Card>
      )}
      <div className="grid2">
        <Card style={{ padding: 4 }}>
          <div className="label" style={{ padding: '8px 10px' }}>
            Notes
          </div>
          {notes.slice(0, 30).map((n) => (
            <div key={n.id} className="list-row" onClick={() => setEditing(n)}>
              <span className="tt">{n.title}</span>
              <span className="uu">{ago(n.ts)}</span>
            </div>
          ))}
          {notes.length === 0 && (
            <div className="faint" style={{ padding: '0 10px 10px' }}>
              No notes.
            </div>
          )}
        </Card>
        <Card style={{ padding: 4 }}>
          <div className="label" style={{ padding: '8px 10px' }}>
            Saved for offline (Ctrl+S)
          </div>
          {saved.slice(0, 30).map((p) => (
            <div key={p.id} className="list-row" onClick={() => run('openSavedPage', p.id)}>
              <Fav url={p.url} />
              <span className="tt">{p.title}</span>
              <button
                className="icon-btn rm"
                title="Delete"
                onClick={async (e) => {
                  e.stopPropagation();
                  await run('deleteSavedPage', p.id);
                  void load();
                }}
              >
                <I.ITrash size={14} />
              </button>
            </div>
          ))}
          {saved.length === 0 && (
            <div className="faint" style={{ padding: '0 10px 10px' }}>
              Nothing saved.
            </div>
          )}
        </Card>
      </div>
      {editing && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal" style={{ width: 'min(680px, calc(100vw - 48px))' }}>
            <input className="input" placeholder="Title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} style={{ height: 36, fontSize: 15, marginBottom: 10 }} />
            <textarea className="textarea" rows={14} placeholder="Write anything. Markdown and code are fine." value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }} />
            <div className="row" style={{ marginTop: 12 }}>
              <Btn
                variant="primary"
                onClick={async () => {
                  await run('saveNote', editing);
                  setEditing(null);
                  toast('Note saved.', 'ok');
                  void load();
                }}
              >
                Save
              </Btn>
              {editing.id && (
                <Btn
                  variant="danger"
                  onClick={async () => {
                    await run('deleteNote', editing.id);
                    setEditing(null);
                    void load();
                  }}
                >
                  Delete
                </Btn>
              )}
              <span className="grow" />
              <Btn variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

export function ReferencePage() {
  return (
    <Page title="Programming reference" sub="Python, Java, C, C++, JavaScript, data structures, common errors and examples. Included with Raven and available offline.">
      <ReferencePane />
    </Page>
  );
}

export function ConnectPage() {
  return (
    <Page title="Master server" sub="Raven uses the internet connection and AI of your Raven Master Server. There is no account: the server owner approves this PC once.">
      <ConnectCard full />
    </Page>
  );
}

// ------------------------------------------------------------ settings
function Row({ t, d, children }: { t: string; d?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="grow">
        <div className="t">{t}</div>
        {d && <div className="d">{d}</div>}
      </div>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <h2 style={{ fontSize: 14, marginBottom: 4 }}>{title}</h2>
      <Card style={{ padding: '2px 16px' }}>{children}</Card>
    </div>
  );
}

export function SettingsPage() {
  const { app, run, toast } = useC();
  const s = app.settings;
  const set = (patch: Partial<BrowserSettings>) => run('settings', patch);
  const [name, setName] = useState(s.deviceName);
  const [custom, setCustom] = useState(s.customSearch);
  const [perms, setPerms] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => void run<Record<string, Record<string, string>>>('permissionsList').then((p) => p && setPerms(p)), []);
  const confirmRun = async (msg: string, method: string, ...args: unknown[]) => {
    if (!confirm(msg)) return;
    if ((await run(method, ...args)) !== undefined) toast('Done.', 'ok');
  };
  return (
    <Page title="Settings" sub={<span className="selectable">Raven Browser {app.version} · data in {app.dataRoot}{app.portable ? ' (portable)' : ''}</span>}>
      <Section title="Connection">
        <Row t="Use this PC's own internet when the master server is unavailable">
          <Toggle on={s.directFallback} onChange={(v) => set({ directFallback: v })} label="Direct fallback" />
        </Row>
        <Row t="Master server only" d="Never use any other connection. Pages fail instead of going direct.">
          <Toggle on={s.strictGateway} onChange={(v) => set({ strictGateway: v })} label="Master server only" />
        </Row>
        <Row t="Device name" d="How this PC appears on the master server.">
          <div className="row">
            <input className="input" style={{ width: 180 }} value={name} onChange={(e) => setName(e.target.value)} />
            <Btn size="sm" disabled={!name.trim() || name === s.deviceName} onClick={() => set({ deviceName: name.trim() })}>
              Save
            </Btn>
          </div>
        </Row>
        <Row t="Device credential" d="This PC's own key for the master. Replacing it makes the old one stop working.">
          <Btn size="sm" disabled={!app.conn.server} onClick={async () => (await run('rotateKey')) && toast('New credential is active.', 'ok')}>
            Replace
          </Btn>
        </Row>
      </Section>

      <Section title="Search and appearance">
        <Row t="Search engine">
          <select className="select" style={{ width: 180 }} value={s.searchEngine} onChange={(e) => set({ searchEngine: e.target.value as BrowserSettings['searchEngine'] })}>
            <option value="google">Google</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="bing">Bing</option>
            <option value="brave">Brave Search</option>
            <option value="custom">Custom</option>
          </select>
        </Row>
        {s.searchEngine === 'custom' && (
          <Row t="Custom search address" d="Use %s where the search words go.">
            <div className="row">
              <input className="input" style={{ width: 240 }} value={custom} onChange={(e) => setCustom(e.target.value)} />
              <Btn size="sm" disabled={!custom.includes('%s')} onClick={() => set({ customSearch: custom })}>
                Save
              </Btn>
            </div>
          </Row>
        )}
        <Row t="Theme">
          <select className="select" style={{ width: 180 }} value={s.theme} onChange={(e) => set({ theme: e.target.value as BrowserSettings['theme'] })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Same as the system</option>
          </select>
        </Row>
        <Row t="AI first" d="Anything typed that is not an address goes to the AI, which answers it, opens a site, searches, or does it as a task on the master. Off: typed text is searched.">
          <Toggle on={s.addressBarAi} onChange={(v) => set({ addressBarAi: v })} label="Answer questions with the assistant" />
        </Row>
        <Row t="World map behind the new tab">
          <Toggle on={s.smoke} onChange={(v) => set({ smoke: v })} label="Background map" />
        </Row>
        <Row t="Bookmarks bar">
          <Toggle on={s.showBookmarksBar} onChange={(v) => set({ showBookmarksBar: v })} label="Bookmarks bar" />
        </Row>
        <Row t="Reopen tabs from last time">
          <Toggle on={s.restoreSession} onChange={(v) => set({ restoreSession: v })} label="Restore tabs" />
        </Row>
      </Section>

      <Section title="Privacy and memory">
        <Row t="Search through the master" d="When connected, the master runs your searches and Raven shows the results here. Off: searches open the search engine's own page.">
          <Toggle on={s.masterSearch} onChange={(v) => set({ masterSearch: v })} label="Search through the master" />
        </Row>
        <Row t="Pause history" d="Stop saving pages and searches. Existing history is kept.">
          <Toggle on={s.pauseHistory} onChange={(v) => set({ pauseHistory: v })} label="Pause history" />
        </Row>
        <Row t="Save AI chats">
          <Toggle on={s.aiSaveConversations} onChange={(v) => set({ aiSaveConversations: v })} label="Save AI chats" />
        </Row>
        <Row t="Block ads and trackers">
          <Toggle on={s.adblock} onChange={(v) => set({ adblock: v })} label="Block ads" />
        </Row>
        {s.adblockAllow.length > 0 && (
          <Row t="Sites where ads are allowed">
            <div className="row wrap" style={{ maxWidth: 260, justifyContent: 'flex-end' }}>
              {s.adblockAllow.map((h) => (
                <Chip key={h}>
                  {h}
                  <button style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, display: 'grid' }} onClick={() => set({ adblockAllow: s.adblockAllow.filter((x) => x !== h) })}>
                    <I.IClose size={12} />
                  </button>
                </Chip>
              ))}
            </div>
          </Row>
        )}
        <Row t="Memory folder" d={<span className="selectable">{app.memoryRoot}</span>}>
          <div className="row">
            <Btn size="sm" onClick={() => run('openMemoryFolder')}>
              Open
            </Btn>
            <Btn
              size="sm"
              onClick={async () => {
                const d = await run<string>('chooseMemoryFolder', true);
                if (d) toast(`Memory moved to ${d}.`, 'ok');
              }}
            >
              Move
            </Btn>
          </div>
        </Row>
        {app.memoryWarning && (
          <Row t="Memory drive missing" d={app.memoryWarning}>
            <Btn size="sm" onClick={async () => (await run('retryMemoryFolder')) && toast('Drive is back. Everything was merged.', 'ok')}>
              Try again
            </Btn>
          </Row>
        )}
        <Row t="Backup, export and import">
          <div className="row">
            <Btn
              size="sm"
              onClick={async () => {
                const r = await run<{ files: number }>('backup');
                if (r) toast(`Backup done: ${r.files} changed file(s).`, 'ok');
              }}
            >
              Back up
            </Btn>
            <Btn
              size="sm"
              onClick={async () => {
                const n = await run<number>('exportMemory');
                if (n) toast(`Exported ${n} files.`, 'ok');
              }}
            >
              Export
            </Btn>
            <Btn
              size="sm"
              onClick={async () => {
                const n = await run<number>('importMemory');
                if (typeof n === 'number') toast(`Imported ${n} files.`, 'ok');
              }}
            >
              Import
            </Btn>
          </div>
        </Row>
      </Section>

      <Section title="Delete data">
        <Row t="Choose what to delete" d="Each item deletes only that. Downloaded files are never deleted.">
          <span />
        </Row>
        <div className="row wrap" style={{ padding: '4px 0 14px', gap: 6 }}>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Delete all browsing history?', 'clearHistory', { all: true })}>
            Browsing history
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Delete all search history?', 'clearSearches')}>
            Search history
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Delete all saved AI chats?', 'clearConversations')}>
            AI chats
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Delete all notes?', 'clearNotes')}>
            Notes
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Delete all pages saved for offline?', 'clearSavedPages')}>
            Saved pages
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Clear the download list? Files stay on disk.', 'clearDownloads')}>
            Download list
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Clear cached website files?', 'clearCache')}>
            Cached files
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Delete cookies and site data? You will be signed out of websites.', 'clearCookies')}>
            Cookies and site data
          </Btn>
          <Btn size="sm" variant="danger" onClick={() => confirmRun('Delete all Raven memory? This cannot be undone.', 'clearAllMemory')}>
            Everything
          </Btn>
        </div>
      </Section>

      <Section title="Downloads">
        <Row t="Ask where to save each file">
          <Toggle on={s.askWhereToSave} onChange={(v) => set({ askWhereToSave: v })} label="Ask where to save" />
        </Row>
        <Row t="Download folder" d={<span className="selectable">{s.downloadDir}</span>}>
          <Btn size="sm" onClick={() => run('chooseDownloadDir')}>
            Change
          </Btn>
        </Row>
      </Section>

      <Section title="Site permissions">
        {Object.entries(perms).flatMap(([origin, p]) =>
          Object.entries(p).map(([k, v]) => (
            <Row key={origin + k} t={hostOf(origin)} d={`${k}: ${v === 'allow' ? 'allowed' : 'blocked'}`}>
              <Btn size="sm" variant="ghost" onClick={async () => setPerms((await run<Record<string, Record<string, string>>>('revokePermission', origin, k)) ?? {})}>
                Reset
              </Btn>
            </Row>
          )),
        )}
        {Object.keys(perms).length === 0 && (
          <Row t="No saved decisions" d="Sites always ask before using your camera, microphone, location or notifications.">
            <span />
          </Row>
        )}
      </Section>

      <Section title="Portable mode">
        <Row t={app.portable ? 'On' : 'Keep data next to RavenBrowser.exe'} d={app.portable ? 'Data is in the RavenBrowserData folder next to the program.' : 'Useful on a USB drive. Takes effect after restarting Raven.'}>
          {!app.portable && (
            <Btn
              size="sm"
              onClick={async () => {
                const d = await run<string>('enablePortable');
                if (d) toast(`Prepared ${d}. Restart Raven to use it.`, 'ok');
              }}
            >
              Turn on
            </Btn>
          )}
        </Row>
      </Section>
    </Page>
  );
}
