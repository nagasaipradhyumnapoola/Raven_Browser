// Tasks the master does for this PC in its own hidden browser: progress, questions, approvals, live view.
import React, { useEffect, useRef, useState } from 'react';
import type { AgentTaskView } from '@raven/shared';
import { Btn, Toggle } from '@raven/ui';
import { useC } from './ctx';
import * as I from './icons';

const STATUS: Record<AgentTaskView['status'], string> = {
  running: 'Working',
  waiting: 'Needs you',
  done: 'Done',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

export function useAgentTasks(): [AgentTaskView[], (t: AgentTaskView) => void] {
  const { app } = useC();
  const [tasks, setTasks] = useState<AgentTaskView[]>([]);
  const online = !!app.conn.server;
  const upsert = (t: AgentTaskView & { closed?: boolean }) =>
    setTasks((list) => {
      const rest = list.filter((x) => x.id !== t.id);
      return t.closed || t.kind === 'remote' ? rest : [t, ...rest].sort((a, b) => b.created - a.created);
    });
  useEffect(() => {
    if (!online) return;
    void window.raven.invoke('agentList').then((r) => r.ok && Array.isArray(r.data) && setTasks((r.data as AgentTaskView[]).filter((t) => t.kind !== 'remote')));
  }, [online]);
  useEffect(() => window.raven.on('raven:agent', (t: AgentTaskView) => upsert(t)), []);
  return [tasks, upsert];
}

export function TasksPane({ tasks, upsert, startGoal, clearGoal }: { tasks: AgentTaskView[]; upsert: (t: AgentTaskView) => void; startGoal: string | null; clearGoal: () => void }) {
  const { app, run, toast } = useC();
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const srv = app.conn.server;
  const can = !!srv?.agents;
  const why = !srv ? 'Connect to a master server to let it do things for you.' : 'The master does not allow tasks for this PC right now (internet or AI is off for it).';

  const start = async (g: string) => {
    const text = g.trim();
    if (!text) return;
    setBusy(true);
    const t = await run<AgentTaskView>('agentStart', text);
    setBusy(false);
    if (t) {
      upsert(t);
      setGoal('');
    }
  };
  useEffect(() => {
    if (startGoal) {
      clearGoal();
      void start(startGoal);
    }
  }, [startGoal]);

  return (
    <div className="tasks selectable">
      <div className="task-new">
        <textarea
          value={goal}
          disabled={!can || busy}
          placeholder={can ? 'What should the master do? e.g. "Check my Gmail for mails from the bank today"' : why}
          rows={2}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void start(goal);
            }
          }}
        />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="faint" style={{ fontSize: 12 }}>
            Runs on the master in its own browser. Passwords you type go only to that page.
          </span>
          <Btn size="sm" variant="primary" disabled={!can || busy || !goal.trim()} onClick={() => void start(goal)}>
            {busy ? 'Starting…' : 'Start'}
          </Btn>
        </div>
      </div>
      {tasks.length === 0 && <div className="faint" style={{ padding: '18px 4px', fontSize: 13 }}>No tasks yet. Anything you type in the address bar that needs doing on a website also starts one here.</div>}
      {tasks.map((t) => (
        <TaskCard key={t.id} t={t} />
      ))}
      {can && (
        <button
          className="linkish"
          style={{ margin: '14px 4px', fontSize: 12 }}
          onClick={async () => {
            if (!confirm('Forget every password this PC asked the master to remember?')) return;
            const n = await run<number>('agentForgetPasswords');
            if (n !== undefined) toast(n ? `Forgot ${n} saved password${n === 1 ? '' : 's'}.` : 'No saved passwords.', 'ok');
          }}
        >
          Forget passwords saved on the master
        </button>
      )}
    </div>
  );
}

function TaskCard({ t }: { t: AgentTaskView }) {
  const { run } = useC();
  const [open, setOpen] = useState(t.status === 'running' || t.status === 'waiting');
  const [live, setLive] = useState(false);
  const active = t.status === 'running' || t.status === 'waiting';
  useEffect(() => {
    if (t.prompt) setOpen(true);
  }, [t.prompt?.id]);
  return (
    <div className={`task ${t.status}`}>
      <div className="task-head" onClick={() => setOpen(!open)}>
        <span className={`task-dot ${t.status}`} />
        <span className="task-goal">{t.goal}</span>
        <span className="task-st">{STATUS[t.status]}</span>
      </div>
      {t.prompt && <PromptBox t={t} />}
      {t.answer && <div className="task-answer">{t.answer}</div>}
      {open && (
        <div className="task-steps">
          {t.steps.slice(-12).map((s, i) => (
            <div key={i}>
              <span className="faint">{new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> {s.text}
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <Btn size="sm" onClick={() => setLive(!live)}>
          {live ? 'Hide live view' : 'Live view'}
        </Btn>
        {active ? (
          <Btn size="sm" variant="danger" onClick={() => void run('agentCancel', t.id)}>
            Stop
          </Btn>
        ) : (
          <Btn size="sm" variant="ghost" onClick={() => void run('agentCancel', t.id)}>
            Close
          </Btn>
        )}
      </div>
      {live && <LiveView id={t.id} />}
    </div>
  );
}

function PromptBox({ t }: { t: AgentTaskView }) {
  const { run } = useC();
  const p = t.prompt!;
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const [sent, setSent] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setValue('');
    setSent(false);
    setTimeout(() => ref.current?.focus(), 60);
  }, [p.id]);
  const send = async (ok: boolean) => {
    if (sent) return;
    setSent(true);
    const r = await run('agentAnswer', t.id, p.id, ok, ok ? value : undefined, remember);
    setValue('');
    if (r === undefined) setSent(false);
  };
  return (
    <div className={`prompt ${p.kind}`}>
      <div className="prompt-title">{p.title}</div>
      <div className="prompt-detail">{p.detail}</div>
      {p.kind === 'confirm' ? (
        <div className="row" style={{ gap: 6, marginTop: 10 }}>
          <Btn size="sm" variant="primary" disabled={sent} onClick={() => void send(true)}>
            Allow
          </Btn>
          <Btn size="sm" disabled={sent} onClick={() => void send(false)}>
            Don't allow
          </Btn>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value) void send(true);
          }}
        >
          <input
            ref={ref}
            className="input"
            type={p.kind === 'password' ? 'password' : 'text'}
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={p.kind === 'password' ? 'Password' : 'Your answer'}
            style={{ marginTop: 10 }}
          />
          {p.kind === 'password' && p.canRemember && (
            <label className="row faint" style={{ gap: 8, marginTop: 8, fontSize: 12, cursor: 'pointer' }}>
              <Toggle on={remember} onChange={setRemember} label="Remember on the master" /> Remember on the master (encrypted) for {p.site}
            </label>
          )}
          <div className="row" style={{ gap: 6, marginTop: 10 }}>
            <Btn size="sm" variant="primary" disabled={sent || !value}>
              Send
            </Btn>
            <Btn size="sm" disabled={sent} onClick={(e: React.MouseEvent) => (e.preventDefault(), void send(false))}>
              Skip
            </Btn>
          </div>
        </form>
      )}
    </div>
  );
}

/** About one picture a second of the master's hidden page. Click it to click there; type below to type there. */
function LiveView({ id }: { id: string }) {
  const [img, setImg] = useState<{ data: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const pull = async () => {
      const r = await window.raven.invoke('agentFrame', id);
      if (stop) return;
      if (r.ok) {
        setImg(r.data as { data: string; url: string });
        setErr(null);
      } else setErr(r.error ?? 'No picture.');
      timer = setTimeout(pull, document.hidden ? 3000 : 900);
    };
    void pull();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);
  const input = (p: Record<string, unknown>) => void window.raven.invoke('agentInput', id, p);
  return (
    <div className="live">
      {img ? (
        <img
          src={img.data}
          alt="The master's page"
          onClick={(e) => {
            const r = (e.target as HTMLImageElement).getBoundingClientRect();
            input({ kind: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
          }}
          onWheel={(e) => input({ kind: 'scroll', y: e.deltaY })}
        />
      ) : (
        <div className="faint" style={{ padding: 12, fontSize: 12 }}>{err ?? 'Loading…'}</div>
      )}
      <form
        className="row"
        style={{ gap: 6, marginTop: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (text) input({ kind: 'text', text });
          setText('');
        }}
      >
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type into the master's page" style={{ height: 30 }} />
        <button type="button" className="icon-btn" title="Press Enter there" onClick={() => input({ kind: 'key', key: 'Enter' })}>
          <I.ISend size={15} />
        </button>
      </form>
    </div>
  );
}
