// Assistant sidebar: streaming chat through the master server, page-aware
// attachments, saved conversations, and the offline programming reference.
import React, { useEffect, useRef, useState } from 'react';
import { Chip, Dot, ago } from '@raven/ui';
import type { ChatMessage, ConversationMeta, RefEntry } from '@raven/local-memory';
import type { ChatEvent, PageContext } from '../types';
import { Markdown } from './markdown';
import { useC } from './ctx';
import { TasksPane, useAgentTasks } from './tasks';
import * as I from './icons';

type Pane = 'chat' | 'tasks' | 'history' | 'reference';

const SUMMARIZE = 'Summarize this page in clear bullet points, then give the three most important takeaways.';
const EXPLAIN = 'Explain this text simply. If it is code or an error message, explain what it means and how to fix it.';

export function AiSidebar({ width }: { width: number }) {
  const { app, win, run, toast, go, ai } = useC();
  const [pane, setPane] = useState<Pane>('chat');
  const [tasks, upsertTask] = useAgentTasks();
  const [taskGoal, setTaskGoal] = useState<string | null>(null);
  const waiting = tasks.filter((t) => t.status === 'waiting').length;
  const [convId, setConvId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [context, setContext] = useState<PageContext[]>([]);
  const [streaming, setStreaming] = useState<{ text: string; model: string | null } | null>(null);
  const [mode, setMode] = useState<'auto' | 'general' | 'coding'>('auto');
  const [model, setModel] = useState('auto');
  const [convs, setConvs] = useState<ConversationMeta[]>([]);
  const [convQuery, setConvQuery] = useState('');
  const [found, setFound] = useState<Set<string> | null>(null);
  const reqRef = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const server = app.conn.server;
  const online = !!server;
  const aiReady = online && server.permissions.ai && server.services.ai && !server.services.maintenance && server.aiBackend === 'ok';
  const why = !online
    ? app.conn.state === 'awaiting_authorization'
      ? 'Waiting for the server owner to approve this PC.'
      : !app.conn.endpoint
        ? 'Answers come from your Raven Master Server. Connect to it from the new tab page. Saved chats and the reference work without it.'
        : 'The master server is not reachable, so new answers are not available. Saved chats and the reference still work.'
    : !server.services.ai
      ? 'AI is turned off on the master server.'
      : !server.permissions.ai
        ? 'AI is not allowed for this device. Ask the server owner.'
        : server.services.maintenance
          ? 'The master server is in maintenance mode.'
          : server.aiBackend !== 'ok'
            ? 'FreeLLMAPI is not responding on the master server.'
            : '';
  const models = server?.models ?? [];
  const ready = models.filter((m) => m.available).length;

  useEffect(() => {
    if (model !== 'auto' && !models.some((m) => m.id === model)) setModel('auto');
  }, [models, model]);

  const loadConvs = () => void run<ConversationMeta[]>('conversations').then((c) => c && setConvs(c));
  useEffect(loadConvs, []);
  useEffect(() => {
    if (!convQuery.trim()) return setFound(null);
    const t = setTimeout(async () => {
      const hits = await run<{ ref?: string }[]>('memorySearch', convQuery, ['chat']);
      setFound(new Set((hits ?? []).map((h) => h.ref ?? '')));
    }, 200);
    return () => clearTimeout(t);
  }, [convQuery]);

  useEffect(() => {
    return window.raven.on('raven:chat', (e: ChatEvent) => {
      if (e.requestId !== reqRef.current) return;
      if (e.t === 'start') setStreaming((s) => (s ? { ...s, model: e.meta.model } : s));
      else if (e.t === 'delta') setStreaming((s) => (s ? { ...s, text: s.text + e.text } : s));
      else {
        reqRef.current = null;
        setStreaming(null);
        if (e.conversation) {
          setConvId(win.private ? null : e.conversation.id);
          setTitle(e.conversation.title);
          setMessages(e.conversation.messages);
        }
        if (e.t === 'error' && e.code !== 'cancelled' && !e.conversation?.messages.some((m) => m.error)) toast(e.message, 'bad');
        loadConvs();
      }
    });
  }, [win.private]);

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 140) el.scrollTop = el.scrollHeight;
  }, [messages, streaming?.text]);

  // Requests from the page's right-click menu.
  useEffect(() => {
    const a = ai.pendingAction;
    if (!a) return;
    ai.clearAction();
    if (a.action === 'task' || a.action === 'tasks') {
      setPane('tasks');
      if (a.action === 'task') setTaskGoal(a.text);
      return;
    }
    setPane('chat');
    const active = win.tabs.find((t) => t.id === win.activeId);
    if (a.action === 'send') {
      void send(a.text, []);
      return;
    }
    if (a.action === 'summarize') {
      void attach('page').then((ctx) => {
        if (ctx) void send(SUMMARIZE, ctx);
      });
    } else {
      const ctx: PageContext = { kind: 'selection', title: active?.title ?? 'Selection', url: active?.url ?? '', text: a.text, chars: a.text.length };
      if (a.action === 'explain') void send(EXPLAIN, [ctx]);
      else {
        setContext([ctx]);
        setTimeout(() => input.current?.focus(), 50);
      }
    }
  }, [ai.pendingAction]);

  async function attach(kind: 'page' | 'selection'): Promise<PageContext[] | false> {
    const r = await window.raven.invoke('pageContext', kind);
    if (!r.ok) {
      toast(r.error ?? 'Could not read the page.', 'bad');
      return false;
    }
    const ctx = r.data as PageContext[];
    setContext(ctx);
    return ctx;
  }

  async function send(text: string, ctxOverride?: PageContext[], historyOverride?: ChatMessage[]) {
    const q = text.trim();
    if (!q || streaming) return;
    if (!aiReady) return toast(why || 'AI is not available right now.', 'bad');
    const ctx = ctxOverride ?? context;
    const history = (historyOverride ?? messages).filter((m) => !m.error);
    const optimistic: ChatMessage = { role: 'user', content: q, ts: Date.now(), ...(ctx.length ? { context: ctx.map((c) => `${c.title} (${c.chars.toLocaleString()} characters)`).join('; ') } : {}) };
    setMessages([...history, optimistic]);
    setDraft('');
    setContext([]);
    setStreaming({ text: '', model: null });
    const r = await window.raven.invoke('aiSend', { conversationId: convId, title: title || undefined, history, text: q, context: ctx, model, mode });
    if (!r.ok) {
      setStreaming(null);
      setMessages(history);
      setDraft(q);
      setContext(ctx);
      toast(r.error ?? 'Could not send.', 'bad');
      return;
    }
    reqRef.current = r.data as number;
  }

  function stop() {
    if (reqRef.current !== null) void run('aiStop', reqRef.current);
  }

  function regenerate() {
    const idx = messages.map((m) => m.role).lastIndexOf('user');
    if (idx < 0) return;
    void send(messages[idx].content, [], messages.slice(0, idx));
  }

  function newChat() {
    if (streaming) stop();
    setConvId(null);
    setTitle('');
    setMessages([]);
    setContext([]);
    setPane('chat');
    setTimeout(() => input.current?.focus(), 30);
  }

  async function openConv(id: string) {
    const c = await run<{ id: string; title: string; messages: ChatMessage[] }>('conversation', id);
    if (!c) return;
    setConvId(c.id);
    setTitle(c.title);
    setMessages(c.messages);
    setPane('chat');
  }

  const visibleConvs = convs.filter((c) => !found || found.has(c.id) || c.title.toLowerCase().includes(convQuery.toLowerCase()));
  const lastIsAnswer = messages[messages.length - 1]?.role === 'assistant';

  return (
    <aside className="side-ai" style={{ width }}>
      <div className="head">
        <h3>Assistant</h3>
        <span className="row muted" style={{ fontSize: 12, gap: 6, marginLeft: 6 }} title={why || `${ready} model(s) available`}>
          <Dot tone={aiReady ? 'ok' : online ? 'warn' : 'off'} />
          {aiReady ? 'Ready' : online ? 'Limited' : 'Offline'}
        </span>
        <span className="grow" />
        <button className="icon-btn" title="New chat" onClick={newChat}>
          <I.IPlus />
        </button>
        <button className="icon-btn" title="Close (Ctrl+K)" onClick={() => void run('sidebar', false)}>
          <I.IClose />
        </button>
      </div>
      <div className="tabsw">
        <button className={pane === 'chat' ? 'on' : ''} onClick={() => setPane('chat')}>
          Chat
        </button>
        <button className={pane === 'tasks' ? 'on' : ''} onClick={() => setPane('tasks')}>
          Tasks{waiting ? <span className="badge">{waiting}</span> : null}
        </button>
        <button className={pane === 'history' ? 'on' : ''} onClick={() => setPane('history')}>
          Saved chats
        </button>
        <button className={pane === 'reference' ? 'on' : ''} onClick={() => setPane('reference')}>
          Reference
        </button>
      </div>

      {pane === 'tasks' && <TasksPane tasks={tasks} upsert={upsertTask} startGoal={taskGoal} clearGoal={() => setTaskGoal(null)} />}
      {pane === 'chat' && (
        <>
          <div className="msgs selectable" ref={scroller}>
            {messages.length === 0 && !streaming && (
              <div className="empty-ai">
                <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 500, marginBottom: 6 }}>{aiReady ? 'Ask a question' : 'Assistant unavailable'}</div>
                <div style={{ fontSize: 13, lineHeight: 1.55 }}>{aiReady ? 'Use the paperclip to include the current page, or the quote button to include selected text.' : why}</div>
              </div>
            )}
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={`${m.ts}-${i}`} className="msg user">
                  {m.content}
                  {m.context && <div className="ctx">Included: {m.context}</div>}
                </div>
              ) : (
                <div key={`${m.ts}-${i}`} className="msg bot">
                  <div className="who">
                    {m.model ?? 'Assistant'} · {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <Markdown text={m.content} onLink={(u) => go(u, true)} />
                  {m.error && <div className="err">Stopped: {m.error}</div>}
                  <div className="msg-actions">
                    <button className="icon-btn" title="Copy answer" onClick={() => void navigator.clipboard.writeText(m.content).then(() => toast('Copied.', 'ok'))}>
                      <I.ICopy size={15} />
                    </button>
                    {i === messages.length - 1 && lastIsAnswer && !streaming && (
                      <button className="icon-btn" title="Regenerate" disabled={!aiReady} onClick={regenerate}>
                        <I.IRegenerate size={15} />
                      </button>
                    )}
                  </div>
                </div>
              ),
            )}
            {streaming && (
              <div className="msg bot">
                <div className="who">{streaming.model ?? 'Assistant'} · {streaming.text ? 'writing' : 'thinking'}</div>
                {streaming.text ? <Markdown text={streaming.text} streaming /> : <span className="cursor-blink" />}
              </div>
            )}
          </div>

          <div className="composer">
            {context.length > 0 && (
              <div className="ctxchips">
                {context.map((c, i) => (
                  <Chip key={i} tone="hot" title={c.text.slice(0, 500)}>
                    {c.kind === 'selection' ? 'Selected text' : 'Page'}: {c.title.slice(0, 30)} · {c.chars.toLocaleString()} chars
                    <button
                      style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, display: 'grid' }}
                      title="Remove"
                      onClick={() => setContext(context.filter((_, j) => j !== i))}
                    >
                      <I.IClose size={12} />
                    </button>
                  </Chip>
                ))}
              </div>
            )}
            <div className="cbox">
              <textarea
                ref={input}
                value={draft}
                placeholder={aiReady ? 'Message' : 'Not available'}
                disabled={!aiReady}
                rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <div className="tools">
                <button className="icon-btn" title="Include this page's text" disabled={!aiReady} onClick={() => void attach('page')}>
                  <I.IAttach />
                </button>
                <button className="icon-btn" title="Include the selected text" disabled={!aiReady} onClick={() => void attach('selection')}>
                  <I.ISelection />
                </button>
                <button className="icon-btn" title="Summarize this page" disabled={!aiReady || !!streaming} onClick={async () => {
                  const ctx = await attach('page');
                  if (ctx) void send(SUMMARIZE, ctx);
                }}>
                  <I.IFile />
                </button>
                <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'auto' | 'general' | 'coding')} title="Answer style">
                  <option value="auto">Auto</option>
                  <option value="coding">Code</option>
                  <option value="general">General</option>
                </select>
                <select className="select" value={model} onChange={(e) => setModel(e.target.value)} title="Model" disabled={!online}>
                  {(server?.autoAllowed ?? true) && <option value="auto">{server?.defaultModel ? server.defaultModel : 'Best available'}</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.available}>
                      {m.id}
                      {m.available ? '' : ' (unavailable)'}
                    </option>
                  ))}
                </select>
                <span className="grow" />
                {streaming ? (
                  <button className="send stop" title="Stop" onClick={stop}>
                    <I.IStop size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button className="send" title="Send (Enter)" disabled={!draft.trim() || !aiReady} onClick={() => void send(draft)}>
                    <I.ISend />
                  </button>
                )}
              </div>
            </div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
              {win.private ? 'Private window: not saved.' : app.settings.aiSaveConversations ? 'Saved on this PC.' : 'Saving is off.'} Answers can be wrong; check code before using it.
            </div>
          </div>
        </>
      )}

      {pane === 'history' && (
        <div className="msgs" style={{ gap: 2 }}>
          <input className="input" placeholder="Search saved chats" value={convQuery} onChange={(e) => setConvQuery(e.target.value)} style={{ marginBottom: 8 }} />
          {visibleConvs.map((c) => (
            <div key={c.id} className="conv-item" onClick={() => void openConv(c.id)}>
              <span className="t">{c.title}</span>
              <span className="faint" style={{ fontSize: 12 }}>
                {ago(c.updated)}
              </span>
              <button
                className="icon-btn"
                title="Delete"
                onClick={async (e) => {
                  e.stopPropagation();
                  await run('deleteConversation', c.id);
                  if (convId === c.id) newChat();
                  loadConvs();
                }}
              >
                <I.ITrash size={14} />
              </button>
            </div>
          ))}
          {visibleConvs.length === 0 && (
            <div className="faint" style={{ padding: 10 }}>
              {convs.length ? 'No match.' : 'No saved chats yet.'}
            </div>
          )}
        </div>
      )}

      {pane === 'reference' && (
        <div className="msgs">
          <ReferencePane />
        </div>
      )}
    </aside>
  );
}

const LANGS = ['All', 'Python', 'Java', 'C', 'C++', 'JavaScript', 'Data structures', 'Errors', 'Examples'];

export function ReferencePane() {
  const { run, go } = useC();
  const [q, setQ] = useState('');
  const [lang, setLang] = useState('All');
  const [list, setList] = useState<RefEntry[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(async () => setList((await run<RefEntry[]>('reference', q, lang)) ?? []), 80);
    return () => clearTimeout(t);
  }, [q, lang]);
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="faint" style={{ fontSize: 12 }}>
        Built-in documentation, searched on this PC. Not an AI model.
      </div>
      <input className="input" placeholder="Search, for example: linked list in C" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="select" value={lang} onChange={(e) => setLang(e.target.value)} style={{ width: 200 }}>
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {l === 'All' ? 'All topics' : l}
          </option>
        ))}
      </select>
      {list.slice(0, 60).map((e) => (
        <div key={e.id} className="card selectable" style={{ padding: 12, cursor: open === e.id ? 'auto' : 'pointer' }} onClick={() => open !== e.id && setOpen(e.id)}>
          <div className="row between">
            <span style={{ fontWeight: 500 }}>{e.title}</span>
            <span className="faint" style={{ fontSize: 12 }}>
              {e.lang}
            </span>
          </div>
          {open === e.id && (
            <div style={{ marginTop: 10 }}>
              <Markdown text={e.body} onLink={(u) => go(u, true)} />
            </div>
          )}
        </div>
      ))}
      {list.length === 0 && <div className="faint">Nothing found. Try a shorter word.</div>}
    </div>
  );
}
