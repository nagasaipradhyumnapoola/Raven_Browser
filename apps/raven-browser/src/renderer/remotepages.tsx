// Pages backed by the master: search results it fetched, and remote tabs (a master page used from here).
import React, { useEffect, useRef, useState } from 'react';
import { Btn } from '@raven/ui';
import { useC } from './ctx';
import * as I from './icons';

interface Result {
  title: string;
  url: string;
  snippet: string;
  site: string;
}
interface Response {
  query: string;
  engine: string;
  page: number;
  results: Result[];
}
const ENGINE: Record<string, string> = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing', brave: 'Brave' };

function param(url: string, key: string): string {
  try {
    return new URL(url).searchParams.get(key) ?? '';
  } catch {
    return '';
  }
}

// ------------------------------------------------------------ search results
export function SearchPage() {
  const { win, run, go, ai, aiAnswersQuestions } = useC();
  const tab = win.tabs.find((t) => t.id === win.activeId);
  const q = param(tab?.url ?? '', 'q');
  const [text, setText] = useState(q);
  const [pages, setPages] = useState<Response[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Only the newest request may change the page (a slow earlier search must not overwrite a newer one).
  const seq = useRef(0);
  const load = async (page: number) => {
    const my = ++seq.current;
    setBusy(true);
    setErr(null);
    const r = await window.raven.invoke('masterSearch', q, page);
    if (my !== seq.current) return;
    setBusy(false);
    if (r.ok) setPages((p) => (page === 0 ? [r.data as Response] : [...p, r.data as Response]));
    else setErr(r.error ?? 'The search did not work.');
  };
  useEffect(() => {
    setText(q);
    setPages([]);
    if (q) void load(0);
  }, [q]);

  const results = pages.flatMap((p) => p.results);
  const engine = pages[0]?.engine;
  const openEngine = async () => {
    const u = await run<string>('engineUrlFor', q);
    if (u) go(u);
  };

  return (
    <div className="internal serp">
      <div className="internal-inner">
        <form
          className="serp-box"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void run('navigate', text.trim());
          }}
        >
          <I.ISearch />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search" />
        </form>
        <div className="serp-meta">
          {busy && !results.length ? (
            <span className="routing">Searching on the master…</span>
          ) : engine ? (
            <span className="faint">Searched on the master with {ENGINE[engine] ?? engine}</span>
          ) : null}
          <span className="grow" />
          {aiAnswersQuestions && q && (
            <button className="linkish" onClick={() => ai.ask(q)}>
              Ask the assistant
            </button>
          )}
          {q && (
            <button className="linkish" onClick={() => void openEngine()}>
              Open on {ENGINE[engine ?? 'google'] ?? 'the engine'} (images, maps, news)
            </button>
          )}
        </div>
        {err && (
          <div className="serp-err">
            {err}{' '}
            <button className="linkish" onClick={() => void load(0)}>
              Try again
            </button>
          </div>
        )}
        <div className="serp-list selectable">
          {results.map((r, i) => (
            <div className="serp-item" key={`${r.url}-${i}`}>
              <div className="serp-site">
                <I.IGlobe size={13} /> {r.site}
              </div>
              <a
                href={r.url}
                onClick={(e) => {
                  e.preventDefault();
                  go(r.url, e.ctrlKey || e.metaKey);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    go(r.url, true);
                  }
                }}
              >
                {r.title}
              </a>
              {r.snippet && <p>{r.snippet}</p>}
            </div>
          ))}
        </div>
        {results.length > 0 && (pages.at(-1)?.page ?? 0) < 4 && (
          <Btn disabled={busy} onClick={() => void load((pages.at(-1)?.page ?? 0) + 1)}>
            {busy ? 'Loading…' : 'More results'}
          </Btn>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ remote tab
/** A page running on the master, used from here: live picture, click, scroll and type. */
export function RemotePage() {
  const { win, run, toast } = useC();
  const tab = win.tabs.find((t) => t.id === win.activeId);
  const id = param(tab?.url ?? '', 'id');
  const [frame, setFrame] = useState<{ data: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [addr, setAddr] = useState('');
  const [editing, setEditing] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const fast = useRef(0);

  useEffect(() => {
    if (!id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const pull = async () => {
      const r = await window.raven.invoke('agentFrame', id);
      if (stop) return;
      if (r.ok) {
        setFrame(r.data as { data: string; url: string });
        setErr(null);
      } else setErr(r.error ?? 'The master closed this page.');
      // Faster right after input so typing and clicks feel live.
      const quick = Date.now() - fast.current < 3000;
      timer = setTimeout(pull, document.hidden ? 4000 : quick ? 180 : 700);
    };
    void pull();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);
  useEffect(() => {
    if (!editing && frame) setAddr(frame.url);
  }, [frame?.url, editing]);

  const send = (p: Record<string, unknown>) => {
    fast.current = Date.now();
    void window.raven.invoke('agentInput', id, p);
  };
  const keyMap = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

  return (
    <div className="remote">
      <div className="remote-bar">
        <button className="icon-btn" title="Back" onClick={() => send({ kind: 'back' })}>
          <I.IBack />
        </button>
        <button className="icon-btn" title="Forward" onClick={() => send({ kind: 'forward' })}>
          <I.IForward />
        </button>
        <button className="icon-btn" title="Reload" onClick={() => send({ kind: 'reload' })}>
          <I.IReload />
        </button>
        <form
          className="grow"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            if (addr.trim()) send({ kind: 'goto', url: addr.trim() });
          }}
        >
          <input className="input" value={addr} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(e) => setAddr(e.target.value)} spellCheck={false} />
        </form>
        <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          Running on the master
        </span>
        <Btn
          size="sm"
          variant="ghost"
          onClick={async () => {
            await run('agentCancel', id);
            toast('Closed on the master.', 'ok');
            void run('closeTab', win.activeId);
          }}
        >
          Close
        </Btn>
      </div>
      <div
        className="remote-surface"
        ref={surface}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void navigator.clipboard.readText().then((t) => t && send({ kind: 'text', text: t }));
            return;
          }
          if ((e.ctrlKey || e.metaKey) && /^[a-z]$/i.test(e.key)) {
            e.preventDefault();
            send({ kind: 'combo', key: e.key });
            return;
          }
          if (keyMap.has(e.key)) {
            e.preventDefault();
            send({ kind: 'key', key: e.key });
          } else if (e.key.length === 1 && !e.altKey) {
            e.preventDefault();
            send({ kind: 'text', text: e.key });
          }
        }}
        onWheel={(e) => send({ kind: 'scroll', y: e.deltaY })}
      >
        {frame ? (
          <img
            src={frame.data}
            alt=""
            draggable={false}
            onClick={(e) => {
              surface.current?.focus();
              const r = (e.target as HTMLImageElement).getBoundingClientRect();
              send({ kind: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
            }}
          />
        ) : (
          <div className="faint" style={{ padding: 30 }}>{err ?? 'Opening on the master…'}</div>
        )}
      </div>
    </div>
  );
}
