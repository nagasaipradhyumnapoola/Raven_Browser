import '../../../../packages/ui/src/styles.css';
import './dash.css';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_LIMITS, type DeviceLimits, type DeviceView, type ServiceSwitches } from '@raven/shared';
import { AnimatePresence, Btn, Card, Chip, Dot, Meter, Modal, Rise, Scramble, Smoke, Spark, Toggle, ago, fmtBytes, motion, useToasts } from '@raven/ui';
import type { InvokeResult, MasterSnapshot } from '../types';
import logoUrl from '../../../../assets/raven-logo.png';
import { webBridge, type Bridge } from './webbridge';

// Desktop: Electron preload. Phone / server: the headless master's loopback API.
const bridge: Bridge = (window as unknown as { raven?: Bridge }).raven ?? webBridge();

interface Ctx {
  s: MasterSnapshot;
  /** run an action; shows a toast on failure and returns undefined */
  run<T = unknown>(method: string, ...args: unknown[]): Promise<T | undefined>;
  toast(text: string, tone?: 'ok' | 'bad'): void;
  /** ask before something disruptive */
  confirm(message: string, detail?: string): Promise<boolean>;
}
const C = createContext<Ctx>(null as unknown as Ctx);
const useC = () => useContext(C);

type Page = 'overview' | 'control' | 'devices' | 'gateway' | 'ai' | 'models' | 'logs' | 'settings';
const PAGES: { id: Page; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'control', label: 'Server control' },
  { id: 'devices', label: 'Devices' },
  { id: 'gateway', label: 'Internet gateway' },
  { id: 'ai', label: 'AI providers' },
  { id: 'models', label: 'Models' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];

const bps = (n: number) => `${fmtBytes(n)}/s`;

function Head({ title, children, right }: { title: string; children?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>
          <Scramble text={title} />
        </h1>
        {children && <p>{children}</p>}
      </div>
      {right}
    </div>
  );
}

/** Addresses stay hidden until the owner asks for them. */
function Hidden({ text, empty }: { text: string; empty: string }) {
  const [show, setShow] = useState(false);
  if (!text) return <span className="faint">{empty}</span>;
  return (
    <span>
      {show ? <span className="selectable mono">{text}</span> : <span className="faint">hidden</span>}{' '}
      <button className="linkish" onClick={() => setShow(!show)}>
        {show ? 'hide' : 'show address'}
      </button>
    </span>
  );
}

// ------------------------------------------------------------ Overview
function Overview({ go }: { go: (p: Page) => void }) {
  const { s, run } = useC();
  const st = s.stats;
  const on = s.switches.master && st.listening;
  const pending = s.devices.filter((d) => d.status === 'pending');
  const problems: string[] = [];
  if (!s.switches.master) problems.push('Master server is OFF. No device can connect.');
  else if (!st.listening) problems.push(st.listenError ?? 'Gateway is not running.');
  if (!st.masterOnline) problems.push('No internet on this laptop. Devices cannot browse through it.');
  if (s.ai.health === 'unconfigured') problems.push('No AI provider yet. Add one on the AI providers page (its API address and key).');
  if (s.ai.health === 'down') problems.push(s.ai.lastError ?? 'No AI provider is responding.');
  if (s.ai.health === 'ok' && !s.models.some((m) => m.available)) problems.push('Your AI providers list no usable chat models.');
  if (on && !s.switches.lan && !s.switches.remote) problems.push('LAN and Remote access are both OFF. Nothing can reach the server.');
  return (
    <>
      <Card className="hero">
        <div>
          <div className="label">Status</div>
          <div className={`state ${on ? '' : 'off'}`}>{on ? 'Serving devices' : s.switches.master ? 'Not running' : 'Stopped'}</div>
          <div className="row wrap" style={{ marginTop: 14 }}>
            <Chip tone={st.masterOnline ? 'ok' : 'bad'}>
              <Dot tone={st.masterOnline ? 'ok' : 'bad'} live={st.masterOnline} /> Internet {st.masterOnline ? 'online' : 'offline'}
            </Chip>
            <Chip tone={s.switches.internet && on ? 'ok' : 'warn'}>Web gateway {s.switches.internet ? 'on' : 'off'}</Chip>
            <Chip tone={s.switches.ai && s.ai.health === 'ok' ? 'ok' : 'warn'}>AI gateway {s.switches.ai ? (s.ai.health === 'ok' ? 'on' : 'unavailable') : 'off'}</Chip>
            {s.switches.maintenance && <Chip tone="hot">Maintenance</Chip>}
          </div>
        </div>
      </Card>

      {problems.length > 0 && (
        <Rise>
          <Card style={{ marginBottom: 14, borderColor: 'rgba(247,126,13,.5)' }}>
            <div className="label warn">Needs attention</div>
            {problems.map((p) => (
              <div key={p} className="help" style={{ marginTop: 6 }}>
                <b className="warn">!</b> {p}
              </div>
            ))}
          </Card>
        </Rise>
      )}

      {pending.length > 0 && (
        <Rise>
          <Card className="pending" style={{ marginBottom: 14 }}>
            <div className="label orange">Waiting for your approval</div>
            {pending.map((d) => (
              <div key={d.id} className="row between wrap" style={{ marginTop: 12 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{d.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    check this code matches the one on that PC
                  </div>
                </div>
                <div className="code">{d.pairingCode}</div>
                <div className="row">
                  <Btn variant="primary" magnetic onClick={() => run('approveDevice', d.id)}>
                    Approve
                  </Btn>
                  <Btn variant="danger" onClick={() => run('revokeDevice', d.id)}>
                    Block
                  </Btn>
                </div>
              </div>
            ))}
          </Card>
        </Rise>
      )}

      <div className="grid g4">
        <Rise delay={0.02}>
          <Card className="stat" onClick={() => go('devices')} style={{ cursor: 'pointer' }}>
            <div className="label">Connected devices</div>
            <div className="big">{st.clients}</div>
            <div className="sub">
              {s.devices.filter((d) => d.status === 'approved').length} approved · {st.pending} pending
            </div>
          </Card>
        </Rise>
        <Rise delay={0.06}>
          <Card className="stat" onClick={() => go('gateway')} style={{ cursor: 'pointer' }}>
            <div className="label">Traffic right now</div>
            <div className="big">{bps(st.bpsDown + st.bpsUp)}</div>
            <div className="sub orange">
              <Spark data={s.history.down.map((d, i) => d + s.history.up[i])} />
            </div>
          </Card>
        </Rise>
        <Rise delay={0.1}>
          <Card className="stat">
            <div className="label">Data forwarded</div>
            <div className="big">{fmtBytes(st.totalDown + st.totalUp)}</div>
            <div className="sub">
              ↓ {fmtBytes(st.totalDown)} · ↑ {fmtBytes(st.totalUp)} · {st.streams} live stream(s)
            </div>
          </Card>
        </Rise>
        <Rise delay={0.14}>
          <Card className="stat" onClick={() => go('ai')} style={{ cursor: 'pointer' }}>
            <div className="label">AI requests</div>
            <div className="big">{st.aiRequests}</div>
            <div className="sub">
              {s.models.filter((m) => m.available && m.enabled).length} model(s) ready · {st.aiActive} generating
            </div>
          </Card>
        </Rise>
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <Card>
          <div className="label">How other PCs connect</div>
          <div className="kv" style={{ marginTop: 12 }}>
            <span className="k">This laptop</span>
            <Hidden text={st.addresses.length ? st.addresses.map((a) => `${a}:${st.port}`).join('   ') : ''} empty="no network adapter is up" />
            <span className="k">Discovery</span>
            <span>{s.switches.lan && on ? 'Raven Browser finds this server by itself on the same network' : 'off'}</span>
            <span className="k">Server id</span>
            <span className="selectable muted">{st.fingerprint.slice(0, 24)}…</span>
            <span className="k">Uptime</span>
            <span>{Math.floor(st.uptimeMs / 60000)} min</span>
          </div>
        </Card>
        <Card>
          <div className="row between">
            <div className="label">Recent activity</div>
            <Btn size="sm" variant="ghost" onClick={() => go('logs')}>
              All logs
            </Btn>
          </div>
          <div className="log selectable" style={{ marginTop: 8, maxHeight: 150 }}>
            {s.events.slice(0, 7).map((e, i) => (
              <div className="ln" key={`${e.ts}-${i}`}>
                <span className="faint">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className={`lv ${e.level}`}>{e.level}</span>
                <span>{e.msg}</span>
              </div>
            ))}
            {s.events.length === 0 && <div className="faint">nothing yet</div>}
          </div>
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------ Server control
/** Router forwarding state for Remote access. The public address itself is never shown. */
function RemoteStatus() {
  const { s } = useC();
  const r = s.remote;
  const text =
    r.state === 'mapped'
      ? 'Reachable from other networks. Paired devices learn the way in automatically.'
      : r.state === 'searching'
        ? 'Asking the router to forward the port…'
        : r.error ?? 'Not reachable from outside yet.';
  return (
    <div className={`d ${r.state === 'mapped' ? 'ok' : r.state === 'searching' ? '' : 'warn'}`} style={{ marginTop: 4 }}>
      {text}
      {r.state !== 'mapped' && r.state !== 'searching' && ' A tunnel address (Internet gateway page) works everywhere.'}
    </div>
  );
}

function Control() {
  const { s, run, confirm } = useC();
  const sw = s.switches;
  const set = async (k: keyof ServiceSwitches, v: boolean, warn?: string) => {
    if (!v && warn && s.stats.streams + s.stats.aiActive > 0 && !(await confirm(warn, 'Transfers that are running now will be affected.'))) return;
    await run('setSwitches', { [k]: v });
  };
  const rows: { k: keyof ServiceSwitches; t: string; d: string; warn?: string }[] = [
    { k: 'master', t: 'Master server', d: 'All client-facing services. OFF disconnects every device and closes the port. This dashboard keeps running.', warn: 'Turn the master server OFF?' },
    { k: 'internet', t: 'Internet gateway', d: 'Lets approved devices browse the web through this laptop. AI keeps working when this is OFF.', warn: 'Turn the internet gateway OFF?' },
    { k: 'ai', t: 'AI gateway', d: 'Lets approved devices use your AI providers. Browsing keeps working when this is OFF.', warn: 'Turn the AI gateway OFF?' },
    { k: 'lan', t: 'LAN access', d: 'Devices on the same Wi-Fi, hotspot or cable.' },
    { k: 'remote', t: 'Remote access', d: 'Let paired devices reach this server from any network. The router is asked to forward the port automatically.' },
    { k: 'pairing', t: 'New device pairing', d: 'Allow PCs you have never approved to ask for access.' },
    { k: 'maintenance', t: 'Maintenance mode', d: 'Refuses new requests for a while. Devices stay connected.' },
  ];
  const autoLeft = Math.max(0, s.config.autoApproveUntil - Date.now());
  return (
    <>
      <Head title="Server control">Every switch here is enforced by the server itself, the moment you flip it. Devices are told straight away.</Head>
      <div className="grid g2">
        <Card>
          {rows.map((r) => (
            <div className="switch-row" key={r.k}>
              <div className="grow">
                <div className="t">{r.t}</div>
                <div className="d">{r.d}</div>
                {r.k === 'remote' && sw.remote && <RemoteStatus />}
              </div>
              <Toggle on={sw[r.k]} label={r.t} onChange={(v) => set(r.k, v, r.warn)} />
            </div>
          ))}
          <div className="switch-row">
            <div className="grow">
              <div className="t">Automatic startup</div>
              <div className="d">Start in the tray (menu bar on Mac) when you sign in.</div>
            </div>
            <Toggle on={s.config.autoStart} label="Automatic startup" onChange={(v) => run('setAutoStart', v)} />
          </div>
        </Card>
        <div className="col" style={{ gap: 14 }}>
          <Card style={{ borderColor: 'rgba(255,90,60,.4)' }}>
            <div className="label bad">Emergency controls</div>
            <div className="row wrap" style={{ marginTop: 12 }}>
              <Btn
                variant="danger"
                onClick={async () => (await confirm('Disconnect all clients?', 'Approved devices keep their identity and reconnect by themselves.')) && run('disconnectAll')}
              >
                Disconnect all clients
              </Btn>
              <Btn variant="danger" onClick={async () => (await confirm('Disable internet for every device?')) && run('setSwitches', { internet: false })}>
                Disable all internet
              </Btn>
              <Btn variant="danger" onClick={async () => (await confirm('Disable AI for every device?')) && run('setSwitches', { ai: false })}>
                Disable all AI
              </Btn>
              <Btn variant="danger" onClick={async () => (await confirm('Stop all gateway services?', 'Internet and AI stop for everyone. The dashboard stays open so you can turn them back on.')) && run('setSwitches', { master: false })}>
                Stop all gateway services
              </Btn>
            </div>
            <div className="help" style={{ marginTop: 10 }}>
              To cut off one device, use <b>Revoke</b> on the Devices page.
            </div>
          </Card>
          <Card>
            <div className="label">When something is switched off</div>
            <div className="row" style={{ marginTop: 10 }}>
              <Btn variant={s.config.drainPolicy === 'cancel' ? 'primary' : 'default'} onClick={() => run('updateConfig', { drainPolicy: 'cancel' })}>
                Stop transfers now
              </Btn>
              <Btn variant={s.config.drainPolicy === 'finish' ? 'primary' : 'default'} onClick={() => run('updateConfig', { drainPolicy: 'finish' })}>
                Let them finish
              </Btn>
            </div>
            <div className="help" style={{ marginTop: 10 }}>New requests are always refused immediately. This only decides what happens to downloads and answers already in progress.</div>
          </Card>
          <Card>
            <div className="label">Temporary auto-approve (LAN only)</div>
            <div className="help" style={{ margin: '8px 0 10px' }}>
              Off by default. While it runs, new PCs on your local network are approved without asking. {autoLeft > 0 && <b className="warn">Active: {Math.ceil(autoLeft / 60000)} min left.</b>}
            </div>
            <div className="row">
              <Btn onClick={async () => (await confirm('Approve new LAN devices automatically for 10 minutes?', 'Only use this on a network you trust.')) && run('autoApprove', 10)}>10 minutes</Btn>
              <Btn variant="ghost" disabled={autoLeft === 0} onClick={() => run('autoApprove', 0)}>
                Turn off
              </Btn>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------ Devices
const LIMIT_FIELDS: { k: keyof DeviceLimits; label: string; unit: string; scale?: number }[] = [
  { k: 'bandwidthBps', label: 'Bandwidth limit', unit: 'KB/s (0 = unlimited)', scale: 1024 },
  { k: 'maxConnections', label: 'Max connections', unit: 'at once' },
  { k: 'maxDownloads', label: 'Max large downloads', unit: 'at once' },
  { k: 'aiPerMinute', label: 'AI requests', unit: 'per minute (0 = unlimited)' },
  { k: 'aiPerHour', label: 'AI requests', unit: 'per hour (0 = unlimited)' },
  { k: 'aiPerDay', label: 'AI requests', unit: 'per day (0 = unlimited)' },
  { k: 'aiConcurrent', label: 'AI answers', unit: 'at once' },
  { k: 'maxPayloadBytes', label: 'Max question size', unit: 'KB', scale: 1024 },
  { k: 'maxOutputTokens', label: 'Max answer length', unit: 'tokens (0 = default)' },
];

function statusChip(d: DeviceView) {
  if (d.status === 'pending') return <Chip tone="hot">Pending</Chip>;
  if (d.status === 'revoked') return <Chip tone="bad">Revoked</Chip>;
  if (d.status === 'suspended') return <Chip tone="warn">Suspended</Chip>;
  return d.online ? (
    <Chip tone="ok">
      <Dot tone="ok" live /> Online
    </Chip>
  ) : (
    <Chip>Offline</Chip>
  );
}

function DeviceModal({ id, close }: { id: string; close: () => void }) {
  const { s, run, confirm } = useC();
  const d = s.devices.find((x) => x.id === id);
  const [name, setName] = useState(d?.name ?? '');
  const [limits, setLimits] = useState<DeviceLimits>(d?.limits ?? DEFAULT_LIMITS);
  const [events, setEvents] = useState<{ ts: number; level: string; msg: string }[]>([]);
  useEffect(() => {
    void bridge.invoke('events', id).then((r) => r.ok && setEvents(r.data as any));
  }, [id, d?.lastSeen, d?.aiRequests]);
  if (!d) return null;
  const allowAll = d.allowedModels === null;
  const allowed = new Set(d.allowedModels ?? []);
  const toggleModel = (m: string) => {
    const next = new Set(allowed);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    void run('updateDevice', id, { allowedModels: [...next] });
  };
  const mode = d.internet && d.ai ? 'Full access' : d.internet ? 'Internet only' : d.ai ? 'AI only' : 'Blocked';
  return (
    <Modal open onClose={close} title={d.name} wide>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        {statusChip(d)}
        <Chip>{mode}</Chip>
        <span className="muted selectable" style={{ fontSize: 11 }}>
          {d.lastScope === 'remote' ? 'other network' : d.lastScope === 'lan' ? 'this network' : '—'} · seen {ago(d.online ? Date.now() : d.lastSeen)}
        </span>
      </div>
      <div className="grid g2">
        <div className="col">
          <div className="field">
            <span className="label">Device name</span>
            <div className="row">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              <Btn size="sm" disabled={!name.trim() || name === d.name} onClick={() => run('updateDevice', id, { name })}>
                Rename
              </Btn>
            </div>
          </div>
          <div className="switch-row">
            <div className="grow">
              <div className="t">Internet access</div>
              <div className="d">Browse the web through this laptop.</div>
            </div>
            <Toggle on={d.internet} label="Internet access" onChange={(v) => run('updateDevice', id, { internet: v })} />
          </div>
          <div className="switch-row">
            <div className="grow">
              <div className="t">AI access</div>
              <div className="d">Ask the AI. Works even when internet access is OFF.</div>
            </div>
            <Toggle on={d.ai} label="AI access" onChange={(v) => run('updateDevice', id, { ai: v })} />
          </div>
          <div className="kv" style={{ marginTop: 6 }}>
            <span className="k">Now</span>
            <span>
              ↓ {bps(d.bpsDown)} · ↑ {bps(d.bpsUp)} · {d.activeStreams} stream(s)
            </span>
            <span className="k">Total</span>
            <span>
              ↓ {fmtBytes(d.totalDown)} · ↑ {fmtBytes(d.totalUp)}
            </span>
            <span className="k">Ai used</span>
            <span>
              {d.aiRequests} total · {d.aiUsage.minute}/min · {d.aiUsage.hour}/h · {d.aiUsage.day}/day
            </span>
            <span className="k">Day allowance</span>
            <span>{d.limits.aiPerDay > 0 ? <Meter value={d.aiUsage.day / d.limits.aiPerDay} /> : 'unlimited'}</span>
            <span className="k">Last error</span>
            <span className={d.lastError ? 'warn' : 'faint'}>{d.lastError ?? 'none'}</span>
          </div>
        </div>
        <div className="col">
          <div className="row between">
            <span className="label">Allowed AI models</span>
            <div className="row">
              <span className="muted" style={{ fontSize: 11 }}>
                all enabled models
              </span>
              <Toggle on={allowAll} label="All models" onChange={(v) => run('updateDevice', id, { allowedModels: v ? null : [] })} />
            </div>
          </div>
          {!allowAll && (
            <div className="models-pick">
              {s.models.length === 0 && <span className="faint">No models yet. Add an AI provider first.</span>}
              {s.models.map((m) => (
                <button key={m.id} className={`pick ${allowed.has(m.id) ? 'on' : ''} ${m.available && m.enabled ? '' : 'dim'}`} title={`${m.name}${m.available ? '' : ' (no provider key)'}${m.enabled ? '' : ' (disabled globally)'}`} onClick={() => toggleModel(m.id)}>
                  {m.id}
                </button>
              ))}
            </div>
          )}
          {!allowAll && <div className="help">{allowed.size} selected. A model that is not selected can never be reached by this device, not even as a fallback.</div>}
          <div className="field">
            <span className="label">Default model for this device</span>
            <select className="select" value={d.defaultModel ?? ''} onChange={(e) => run('updateDevice', id, { defaultModel: e.target.value || null })}>
              <option value="">server default</option>
              {s.models
                .filter((m) => allowAll || allowed.has(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
            </select>
          </div>
        </div>
      </div>

      <div className="label" style={{ margin: '18px 0 8px' }}>
        Limits
      </div>
      <div className="grid g3">
        {LIMIT_FIELDS.map((f) => (
          <div className="field" key={f.k}>
            <span className="muted" style={{ fontSize: 11 }}>
              {f.label} <span className="faint">{f.unit}</span>
            </span>
            <input
              className="input"
              type="number"
              min={0}
              value={Math.round(limits[f.k] / (f.scale ?? 1))}
              onChange={(e) => setLimits({ ...limits, [f.k]: Math.max(0, Number(e.target.value) || 0) * (f.scale ?? 1) })}
            />
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <Btn variant="orbit" onClick={() => run('updateDevice', id, { limits })}>
          Save limits
        </Btn>
        <Btn variant="ghost" onClick={() => setLimits(DEFAULT_LIMITS)}>
          Reset to defaults
        </Btn>
      </div>

      <div className="label" style={{ margin: '18px 0 8px' }}>
        Recent security and usage events
      </div>
      <div className="log selectable" style={{ maxHeight: 130 }}>
        {events.slice(0, 40).map((e, i) => (
          <div className="ln" key={i}>
            <span className="faint">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={`lv ${e.level}`}>{e.level}</span>
            <span>{e.msg}</span>
          </div>
        ))}
        {events.length === 0 && <span className="faint">no events for this device</span>}
      </div>

      <div className="row wrap between" style={{ marginTop: 18 }}>
        <div className="row wrap">
          {d.status === 'pending' && (
            <Btn variant="primary" onClick={() => run('approveDevice', id)}>
              Approve
            </Btn>
          )}
          {d.status === 'approved' && <Btn onClick={() => run('suspendDevice', id, true)}>suspend</Btn>}
          {d.status === 'suspended' && (
            <Btn variant="primary" onClick={() => run('suspendDevice', id, false)}>
              Re-enable
            </Btn>
          )}
          {d.online && <Btn onClick={() => run('disconnectDevice', id)}>disconnect now</Btn>}
          {d.status !== 'revoked' && (
            <Btn variant="danger" onClick={async () => (await confirm(`Revoke "${d.name}"?`, 'Its credential stops working for good. To use it again that PC must pair as a new device.')) && run('revokeDevice', id)}>
              Revoke
            </Btn>
          )}
          {(d.status === 'revoked' || d.status === 'pending') && (
            <Btn
              variant="danger"
              onClick={async () => {
                if (await confirm(`Remove the record for "${d.name}"?`)) {
                  await run('removeDevice', id);
                  close();
                }
              }}
            >
              Remove record
            </Btn>
          )}
        </div>
        <Btn variant="ghost" onClick={close}>
          Close
        </Btn>
      </div>
    </Modal>
  );
}

function Devices() {
  const { s, run } = useC();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <Head
        title="Connected devices"
        right={
          <Btn variant="ghost" onClick={() => run('removeExpired')}>
            Remove expired
          </Btn>
        }
      >
        Every Raven Browser has its own identity. Decide per device whether it gets internet, AI, both or neither, and which models it may use.
      </Head>
      <Card style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Status</th>
              <th>Via</th>
              <th>Internet</th>
              <th>AI</th>
              <th>Models</th>
              <th>Speed</th>
              <th>Total</th>
              <th>AI req</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {s.devices.map((d) => (
              <tr key={d.id}>
                <td>
                  <div style={{ fontWeight: 700 }}>{d.name}</div>
                  <div className="faint selectable" style={{ fontSize: 10.5 }}>
                    {d.id} · {ago(d.online ? Date.now() : d.lastSeen)}
                  </div>
                </td>
                <td>{statusChip(d)}</td>
                <td className="muted">
                  {d.lastScope === 'remote' ? 'other network' : d.lastScope === 'lan' ? 'this network' : '—'}
                </td>
                <td>
                  <Toggle on={d.internet} label="internet" disabled={d.status === 'revoked'} onChange={(v) => run('updateDevice', d.id, { internet: v })} />
                </td>
                <td>
                  <Toggle on={d.ai} label="ai" disabled={d.status === 'revoked'} onChange={(v) => run('updateDevice', d.id, { ai: v })} />
                </td>
                <td className="muted">{d.allowedModels === null ? 'all' : d.allowedModels.length === 0 ? 'none' : `${d.allowedModels.length} picked`}</td>
                <td className="muted">{d.online ? `↓${bps(d.bpsDown)} ↑${bps(d.bpsUp)}` : '—'}</td>
                <td className="muted">{fmtBytes(d.totalDown + d.totalUp)}</td>
                <td className="muted">{d.aiRequests}</td>
                <td>
                  <div className="row">
                    {d.status === 'pending' && (
                      <Btn size="sm" variant="primary" onClick={() => run('approveDevice', d.id)}>
                        Approve {d.pairingCode}
                      </Btn>
                    )}
                    <Btn size="sm" onClick={() => setOpen(d.id)}>
                      Manage
                    </Btn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.devices.length === 0 && (
          <div className="help" style={{ padding: 26, textAlign: 'center' }}>
            No devices yet. Open <b>RavenBrowser.exe</b> on another computer. On the same network it finds this server by itself; otherwise type this server's address. It then shows up here for approval.
          </div>
        )}
      </Card>
      {open && <DeviceModal id={open} close={() => setOpen(null)} />}
    </>
  );
}

// ------------------------------------------------------------ Gateway
function ListEditor({ items, onSave, placeholder }: { items: string[]; onSave: (v: string[]) => void; placeholder: string }) {
  const [v, setV] = useState('');
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row wrap">
        {items.map((it) => (
          <Chip key={it}>
            {it}
            <button className="pick" style={{ height: 16, padding: '0 5px', border: 0 }} onClick={() => onSave(items.filter((x) => x !== it))} aria-label={`remove ${it}`}>
              x
            </button>
          </Chip>
        ))}
        {items.length === 0 && <span className="faint">none</span>}
      </div>
      <div className="row">
        <input className="input" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
        <Btn
          size="sm"
          disabled={!v.trim()}
          onClick={() => {
            onSave([...new Set([...items, v.trim()])]);
            setV('');
          }}
        >
          Add
        </Btn>
      </div>
    </div>
  );
}

function Gateway() {
  const { s, run } = useC();
  const st = s.stats;
  const [port, setPort] = useState(String(s.config.port));
  const [endpoint, setEndpoint] = useState(s.config.remoteEndpoint);
  return (
    <>
      <Head title="Internet gateway">Forwards browser traffic from approved devices to the internet. Secure sites stay encrypted end to end; this laptop never opens them.</Head>
      <div className="grid g4">
        <Card className="stat">
          <div className="label">Status</div>
          <div className="big" style={{ fontSize: 34 }}>
            {!s.switches.master ? 'server off' : !st.listening ? 'error' : s.switches.internet ? 'forwarding' : 'disabled'}
          </div>
          <div className="sub">{st.listenError ?? `port ${st.port}`}</div>
        </Card>
        <Card className="stat">
          <div className="label">Download</div>
          <div className="big" style={{ fontSize: 34 }}>
            {bps(st.bpsDown)}
          </div>
          <div className="sub orange">
            <Spark data={s.history.down} />
          </div>
        </Card>
        <Card className="stat">
          <div className="label">Upload</div>
          <div className="big" style={{ fontSize: 34 }}>
            {bps(st.bpsUp)}
          </div>
          <div className="sub orange">
            <Spark data={s.history.up} />
          </div>
        </Card>
        <Card className="stat">
          <div className="label">Active streams</div>
          <div className="big" style={{ fontSize: 34 }}>
            {st.streams}
          </div>
          <div className="sub">{fmtBytes(st.totalDown + st.totalUp)} total</div>
        </Card>
      </div>
      <div className="grid g2" style={{ marginTop: 14 }}>
        <Card>
          <div className="row between">
            <div className="label">Gateway</div>
            <Toggle on={s.switches.internet} label="Internet gateway" onChange={(v) => run('setSwitches', { internet: v })} />
          </div>
          <div className="kv" style={{ marginTop: 12 }}>
            <span className="k">Lan address</span>
            <Hidden text={st.addresses.map((a) => `${a}:${st.port}`).join('  ')} empty="not connected to a network" />
            <span className="k">Port</span>
            <div className="row">
              <input className="input num" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
              <Btn size="sm" disabled={Number(port) === s.config.port} onClick={() => run('updateConfig', { port: Number(port) })}>
                Change
              </Btn>
            </div>
            <span className="k">Max devices</span>
            <span>{s.config.maxClients}</span>
            <span className="k">Master internet</span>
            <span className={st.masterOnline ? 'ok' : 'bad'}>{st.masterOnline ? 'available' : 'unavailable'}</span>
          </div>
          <div className="help" style={{ marginTop: 12 }}>
            The first time the gateway starts, Windows or macOS may ask whether to allow incoming connections. Choose <b>Allow</b> (private networks on Windows). If devices cannot find the server, check that prompt was not dismissed.
          </div>
        </Card>
        <Card>
          <div className="row between">
            <div className="label">Remote access</div>
            <Toggle on={s.switches.remote} label="Remote access" onChange={(v) => run('setSwitches', { remote: v })} />
          </div>
          <div className="help" style={{ margin: '10px 0' }}>
            For a PC on another network. It needs a route to this laptop: a VPN such as Tailscale, a router port-forward of port {st.port}, or a tunnel service with a public https address. A tunnel or domain may need its own account or subscription.
          </div>
          <div className="field">
            <span className="label">Address you give to remote PCs (note for yourself)</span>
            <div className="row">
              <input className="input" placeholder="e.g. 100.101.102.103 or gateway.example.com" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
              <Btn size="sm" disabled={endpoint === s.config.remoteEndpoint} onClick={() => run('updateConfig', { remoteEndpoint: endpoint })}>
                Save
              </Btn>
            </div>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <span className="label">Public tunnel hostnames (certificate checked by the browser)</span>
            <ListEditor items={s.config.remoteHosts} placeholder="gateway.example.com" onSave={(v) => run('updateConfig', { remoteHosts: v })} />
          </div>
        </Card>
        <Card style={{ gridColumn: '1 / -1' }}>
          <div className="label">Private addresses devices may reach through this laptop</div>
          <div className="help" style={{ margin: '8px 0' }}>
            Empty by default: devices can reach the public internet only, never this laptop or other machines on your home network. Add an entry such as <b>192.168.1.50:8080</b> only if you want that.
          </div>
          <ListEditor items={s.config.lanAllowlist} placeholder="host or ip, optionally :port" onSave={(v) => run('updateConfig', { lanAllowlist: v })} />
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------ AI providers
/** Name + API address + key. No preset providers: the owner always types the address. */
function AddProvider({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { run, toast } = useC();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = url.trim() && key.trim();
  const save = async () => {
    setBusy(true);
    const r = await run<{ models: number }>('aiAddProvider', name, url, key);
    setBusy(false);
    if (r) {
      setName('');
      setUrl('');
      setKey('');
      toast(`Provider added. ${r.models} models found.`, 'ok');
      onDone?.();
    }
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className={compact ? 'col' : 'grid g3'} style={{ gap: 8 }}>
        <label className="field">
          <span className="muted" style={{ fontSize: 11 }}>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Any name you like" />
        </label>
        <label className="field">
          <span className="muted" style={{ fontSize: 11 }}>API address</span>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} />
        </label>
        <label className="field">
          <span className="muted" style={{ fontSize: 11 }}>API key</span>
          <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key" autoComplete="off" />
        </label>
      </div>
      <div className="row">
        <Btn variant="primary" disabled={!ready || busy} onClick={save}>
          {busy ? 'Checking…' : 'Check and add'}
        </Btn>
        <span className="help">Any OpenAI-compatible API works. The key is checked against the provider's model list before it is saved.</span>
      </div>
    </div>
  );
}

function ProviderRow({ p }: { p: MasterSnapshot['ai']['providers'][number] }) {
  const { s, run, toast, confirm } = useC();
  const [edit, setEdit] = useState(false);
  const [showAddr, setShowAddr] = useState(false);
  const [url, setUrl] = useState(p.address);
  const [key, setKey] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 20_000);
    return () => clearTimeout(t);
  }, [revealed]);
  const builtin = p.id === 'builtin';
  const tone = p.health === 'ok' ? 'ok' : p.health === 'starting' ? 'warn' : 'bad';
  return (
    <div className="prov">
      <div className="row between">
        <div className="row" style={{ gap: 10 }}>
          <Dot tone={tone} live={p.health === 'ok'} />
          <b style={{ fontWeight: 500 }}>{p.name}</b>
          <span className="faint">{p.health === 'ok' ? (p.models ? `${p.models} models ready` : 'reachable, no usable models yet') :p.health === 'starting' ? 'starting' : 'not responding'}</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {!builtin && (
            <Btn size="sm" onClick={() => setEdit(!edit)}>
              {edit ? 'Close' : 'Edit'}
            </Btn>
          )}
          {builtin && (
            <Btn size="sm" disabled={s.ai.managed.state !== 'running'} onClick={() => run('aiOpenDashboard')}>
              Provider keys
            </Btn>
          )}
          {!builtin && (
            <Btn
              size="sm"
              variant="danger"
              onClick={async () => {
                if (!(await confirm(`Remove "${p.name}"?`, 'Its saved key is deleted from this laptop. Devices lose its models right away.'))) return;
                if (await run('aiRemoveProvider', p.id)) toast('Provider removed.', 'ok');
              }}
            >
              Remove
            </Btn>
          )}
        </div>
      </div>
      {p.error && p.health !== 'ok' && <div className="help bad" style={{ marginTop: 6 }}>{p.error}</div>}
      {edit && (
        <div className="col" style={{ gap: 8, marginTop: 12 }}>
          <div className="kv">
            <span className="k">Address</span>
            <span className="selectable">
              {showAddr ? p.address : '••••••••'}{' '}
              <button className="linkish" onClick={() => setShowAddr(!showAddr)}>
                {showAddr ? 'hide' : 'show'}
              </button>
            </span>
            <span className="k">Key</span>
            <span className="selectable mono" style={{ wordBreak: 'break-all' }}>
              {revealed ?? p.keyMasked}
            </span>
          </div>
          {s.hasPin && <input className="input" type="password" placeholder="Dashboard PIN (to reveal or copy the key)" value={pin} onChange={(e) => setPin(e.target.value)} />}
          <div className="row wrap" style={{ gap: 6 }}>
            <Btn
              size="sm"
              onClick={async () => {
                if (revealed) return setRevealed(null);
                const k = await run<string>('aiRevealKey', p.id, pin);
                if (k) setRevealed(k);
              }}
            >
              {revealed ? 'Hide key' : 'Reveal key'}
            </Btn>
            <Btn size="sm" onClick={async () => (await run('aiCopyKey', p.id, pin)) && toast('Copied. The clipboard is cleared in 30 seconds.', 'ok')}>
              Copy key
            </Btn>
            <Btn size="sm" onClick={async () => {
              const r = await run<{ models: number }>('aiValidate', p.id);
              if (r) toast(`Working. ${r.models} models.`, 'ok');
            }}>
              Check
            </Btn>
          </div>
          <div className="grid g2" style={{ gap: 8 }}>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="New API address" spellCheck={false} />
            <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="New key (leave empty to keep)" autoComplete="off" />
          </div>
          <div className="row">
            <Btn
              size="sm"
              variant="primary"
              onClick={async () => {
                const r = await run<{ models: number }>('aiUpdateProvider', p.id, { address: url, key });
                if (r) {
                  setKey('');
                  toast(`Saved. ${r.models} models.`, 'ok');
                }
              }}
            >
              Check and save
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function AiPage() {
  const { s, run, toast, confirm } = useC();
  const tone = s.ai.health === 'ok' ? 'ok' : s.ai.health === 'down' ? 'bad' : 'warn';
  return (
    <>
      <Head title="AI providers">Every request from a device goes to these providers first. Keys stay on this computer; devices never see them.</Head>
      <div className="col" style={{ gap: 14 }}>
        <Card>
          <div className="row between">
            <div className="label">Your providers</div>
            <Chip tone={tone}>
              <Dot tone={tone} live={s.ai.health === 'ok'} /> {s.ai.health === 'ok' ? 'Working' : s.ai.health === 'down' ? 'Not responding' : 'None yet'}
            </Chip>
          </div>
          <div className="col" style={{ gap: 8, marginTop: 12 }}>
            {s.ai.providers.length === 0 && <div className="help">No provider yet. Add one below with its API address and key.</div>}
            {s.ai.providers.map((p) => (
              <ProviderRow key={p.id} p={p} />
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <Btn size="sm" onClick={async () => (await run('aiRefresh')) && toast('Checked all providers.', 'ok')}>
              Check all
            </Btn>
            <span className="grow" />
            <span className="faint">
              {s.models.filter((m) => m.available).length} models ready · {s.ai.totalRequests} requests · {s.ai.totalErrors} failed
            </span>
          </div>
        </Card>
        <Card>
          <div className="label" style={{ marginBottom: 10 }}>Add a provider</div>
          <AddProvider />
        </Card>
        <Card>
          <div className="switch-row">
            <div className="grow">
              <div className="t">Built-in FreeLLMAPI</div>
              <div className="d">Optional. Runs a FreeLLMAPI router inside this app as one more provider; you add its provider keys on its own screen.</div>
            </div>
            <Toggle
              on={s.ai.builtin}
              label="built-in FreeLLMAPI"
              onChange={async (v) => {
                if (!v && !(await confirm('Turn off the built-in FreeLLMAPI?', 'Its models disappear for every device until you turn it back on.'))) return;
                await run('aiSetBuiltin', v);
              }}
            />
          </div>
          {s.ai.builtin && (
            <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
              <Btn size="sm" onClick={() => run('aiRestartManaged')}>Restart</Btn>
              <Btn
                size="sm"
                variant="danger"
                disabled={s.ai.managed.state !== 'running'}
                onClick={async () => {
                  if (!(await confirm('Regenerate the built-in key?', 'Other apps using the old key stop working. Raven Browsers are not affected.'))) return;
                  if (await run('aiRegenerateKey')) toast('New key active and verified.', 'ok');
                }}
              >
                Regenerate key
              </Btn>
              {s.ai.managed.error && <span className="help bad">{s.ai.managed.error}</span>}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------ Models
function Models() {
  const { s, run } = useC();
  const [q, setQ] = useState('');
  const [onlyReady, setOnlyReady] = useState(false);
  const cm = s.config.models;
  const list = s.models.filter((m) => (!onlyReady || m.available) && (!q || m.id.toLowerCase().includes(q.toLowerCase()) || m.name.toLowerCase().includes(q.toLowerCase())));
  const pickable = s.models.filter((m) => m.enabled);
  return (
    <>
      <Head title="Models">The live model list from your AI providers. Switch models off for everyone here; choose per device on the Connected devices page.</Head>
      <div className="grid g3" style={{ marginBottom: 14 }}>
        <Card>
          <div className="label">Preferred default model</div>
          <select className="select" style={{ marginTop: 10 }} value={cm.defaultModel ?? ''} onChange={(e) => run('setDefaultModel', e.target.value || null)}>
            <option value="">automatic</option>
            {pickable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </Card>
        <Card>
          <div className="label">Model for programming questions</div>
          <select className="select" style={{ marginTop: 10 }} value={cm.codingModel ?? ''} onChange={(e) => run('setCodingModel', e.target.value || null)}>
            <option value="">same as default</option>
            {pickable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </Card>
        <Card>
          <div className="label">Permitted fallbacks, in order</div>
          <div className="row wrap" style={{ marginTop: 10 }}>
            {cm.fallbacks.map((f) => (
              <Chip key={f}>
                {f}
                <button className="pick" style={{ height: 16, padding: '0 5px', border: 0 }} onClick={() => run('setFallbacks', cm.fallbacks.filter((x) => x !== f))}>
                  x
                </button>
              </Chip>
            ))}
            <select className="select" style={{ width: 170 }} value="" onChange={(e) => e.target.value && run('setFallbacks', [...cm.fallbacks, e.target.value])}>
              <option value="">add fallback…</option>
              {pickable
                .filter((m) => !cm.fallbacks.includes(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
            </select>
          </div>
        </Card>
      </div>
      <Card style={{ padding: 0 }}>
        <div className="row" style={{ padding: 12 }}>
          <input className="input" placeholder={`search ${s.models.length} models`} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
          <span className="muted">ready only</span>
          <Toggle on={onlyReady} label="ready only" onChange={setOnlyReady} />
          <span className="grow" />
          <span className="muted">
            {s.models.filter((m) => m.available && m.enabled).length} usable · {cm.disabled.length} switched off
          </span>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 420px)', minHeight: 220, overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Availability</th>
                <th>Capabilities</th>
                <th>Recent failures</th>
                <th>Limit / min</th>
                <th>Enabled for everyone</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div style={{ fontWeight: 700 }} className="selectable">
                      {m.id}
                    </div>
                    <div className="faint" style={{ fontSize: 10.5 }}>
                      {m.name}
                      {m.provider ? ` · ${m.provider}` : ''}
                    </div>
                  </td>
                  <td>{m.available ? <Chip tone="ok">{m.status}</Chip> : <Chip tone="warn">{m.status === 'needsKey' ? 'needs provider key' : m.status}</Chip>}</td>
                  <td className="muted" style={{ fontSize: 10.5, maxWidth: 220 }}>
                    {['tools', 'response_format', 'reasoning_effort'].filter((c) => m.capabilities.includes(c)).join(' · ') || '—'}
                  </td>
                  <td className={m.recentFailures ? 'warn' : 'faint'} title={m.lastError ?? ''}>
                    {m.recentFailures || '0'}
                  </td>
                  <td>
                    <input className="input" style={{ width: 70, height: 26 }} type="number" min={0} placeholder="∞" defaultValue={cm.perMinute[m.id] ?? ''} onBlur={(e) => run('setModelRate', m.id, Number(e.target.value) || 0)} />
                  </td>
                  <td>
                    <Toggle on={m.enabled} label={`enable ${m.id}`} onChange={(v) => run('setModelEnabled', m.id, v)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.models.length === 0 && (
            <div className="help" style={{ padding: 26, textAlign: 'center' }}>
              No models yet. Add an AI provider on the AI providers page.
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

// ------------------------------------------------------------ Logs
function Logs() {
  const { s, run } = useC();
  const [f, setF] = useState<'all' | 'security' | 'error' | 'warn'>('all');
  const [log, setLog] = useState<string[] | null>(null);
  const list = s.events.filter((e) => f === 'all' || e.level === f);
  return (
    <>
      <Head
        title="Logs"
        right={
          <div className="row">
            <Btn variant="ghost" onClick={() => run('openLogs')}>
              Open log folder
            </Btn>
            <Btn variant="ghost" onClick={async () => setLog((await run<string[]>('aiLog')) ?? [])}>
              FreeLLMAPI output
            </Btn>
          </div>
        }
      >
        Secrets are removed before anything is written. Browsing content is never logged, only what is needed to run the server.
      </Head>
      <div className="row" style={{ marginBottom: 10 }}>
        {(['all', 'security', 'error', 'warn'] as const).map((x) => (
          <Btn key={x} size="sm" variant={f === x ? 'primary' : 'default'} onClick={() => setF(x)}>
            {x}
          </Btn>
        ))}
      </div>
      <Card>
        <div className="log selectable" style={{ maxHeight: 'calc(100vh - 290px)' }}>
          {list.map((e, i) => (
            <div className="ln" key={`${e.ts}-${i}`}>
              <span className="faint">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={`lv ${e.level}`}>{e.level}</span>
              <span>
                {e.msg}
                {e.deviceId && <span className="faint"> · {s.devices.find((d) => d.id === e.deviceId)?.name ?? e.deviceId}</span>}
              </span>
            </div>
          ))}
          {list.length === 0 && <span className="faint">nothing to show</span>}
        </div>
      </Card>
      <Modal open={log !== null} onClose={() => setLog(null)} title="FreeLLMAPI output" wide>
        <pre className="selectable" style={{ font: '500 11px/1.5 var(--mono)', maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>
          {log?.length ? log.join('\n') : 'No output yet (only the built-in FreeLLMAPI writes here).'}
        </pre>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------ Settings
function Settings() {
  const { s, run, toast } = useC();
  const [name, setName] = useState(s.config.serverName);
  const [pin, setPin] = useState('');
  const [cur, setCur] = useState('');
  const [ver, setVer] = useState(s.config.latestBrowserVersion ?? '');
  return (
    <>
      <Head title="Settings" />
      <div className="grid g2">
        <Card>
          <div className="label">Server</div>
          <div className="field" style={{ marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              name shown to browsers
            </span>
            <div className="row">
              <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              <Btn size="sm" disabled={!name.trim() || name === s.config.serverName} onClick={() => run('updateConfig', { serverName: name })}>
                Save
              </Btn>
            </div>
          </div>
          <div className="switch-row">
            <div className="grow">
              <div className="t">Start when you sign in</div>
              <div className="d">Runs quietly in the tray after you sign in. This is a startup app, not a system service, so it needs you to be signed in.</div>
            </div>
            <Toggle on={s.config.autoStart} label="Start when you sign in" onChange={(v) => run('setAutoStart', v)} />
          </div>
          <div className="switch-row">
            <div className="grow">
              <div className="t">Closing the window keeps the server running</div>
              <div className="d">The window hides to the tray. Use Quit from the tray icon to stop everything.</div>
            </div>
            <Toggle on={s.config.minimizeToTray} label="Minimize to tray" onChange={(v) => run('updateConfig', { minimizeToTray: v })} />
          </div>
          <div className="switch-row">
            <div className="grow">
              <div className="t">Remember switch positions</div>
              <div className="d">ON: the server comes back exactly as you left it. OFF: it starts with safe defaults each time.</div>
            </div>
            <Toggle on={s.config.restoreSwitches} label="Restore switches" onChange={(v) => run('updateConfig', { restoreSwitches: v })} />
          </div>
        </Card>
        <Card>
          <div className="label">Dashboard lock</div>
          <div className="help" style={{ margin: '8px 0 10px' }}>
            Optional PIN for this dashboard only. Browsers never need a login. It locks itself after 10 minutes without use. {s.hasPin ? <b className="ok">A PIN is set.</b> : <b>No PIN set.</b>}
          </div>
          {s.hasPin && <input className="input" type="password" placeholder="current PIN" value={cur} onChange={(e) => setCur(e.target.value)} style={{ marginBottom: 8 }} />}
          <div className="row">
            <input className="input" type="password" placeholder={s.hasPin ? 'new PIN' : 'choose a PIN (4+ characters)'} value={pin} onChange={(e) => setPin(e.target.value)} />
            <Btn
              size="sm"
              disabled={pin.length < 4}
              onClick={async () => {
                if (await run('setPin', pin, cur)) {
                  setPin('');
                  setCur('');
                  toast('PIN saved.', 'ok');
                }
              }}
            >
              {s.hasPin ? 'change' : 'set'}
            </Btn>
            {s.hasPin && (
              <>
                <Btn size="sm" variant="danger" onClick={async () => (await run('setPin', null, cur)) && toast('PIN removed.', 'ok')}>
                  Remove
                </Btn>
                <Btn size="sm" onClick={() => run('lock')}>
                  Lock now
                </Btn>
              </>
            )}
          </div>
          <div className="label" style={{ margin: '20px 0 8px' }}>
            Data and backup
          </div>
          <div className="help selectable">{s.dataDir}</div>
          <div className="help" style={{ margin: '6px 0 10px' }}>Settings, approved devices and logs are plain files in this folder. Copy the folder to back it up; put it back to restore.</div>
          <Btn onClick={() => run('openDataDir')}>open folder</Btn>
          <div className="label" style={{ margin: '20px 0 8px' }}>
            Browser update notice
          </div>
          <div className="row">
            <input className="input" placeholder="newest RavenBrowser version, e.g. 1.1.0" value={ver} onChange={(e) => setVer(e.target.value)} />
            <Btn size="sm" onClick={() => run('updateConfig', { latestBrowserVersion: ver.trim() || null })}>
              Save
            </Btn>
          </div>
          <div className="help" style={{ marginTop: 6 }}>Browsers running an older version show a quiet notice. Nothing updates by itself.</div>
        </Card>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <span className="faint">Raven Master Server {s.version}</span>
        <span className="grow" />
        <Btn variant="danger" onClick={() => run('quit')}>
          Quit master server
        </Btn>
      </div>
    </>
  );
}

// ------------------------------------------------------------ First-run setup
function Setup({ done }: { done: () => void }) {
  const { s, run, toast } = useC();
  const [step, setStep] = useState(0);
  const steps = ['AI', 'Startup', 'Network', 'Done'];
  return (
    <Modal open onClose={() => {}} title="First-time setup" wide>
      <div className="row" style={{ marginBottom: 16 }}>
        {steps.map((t, i) => (
          <Chip key={t} tone={i === step ? 'hot' : i < step ? 'ok' : undefined}>
            {i + 1} {t}
          </Chip>
        ))}
      </div>
      {step === 0 && (
        <div className="col">
          <div className="help">Add the AI provider this server should use: any name, its API address and your key. You can add more later.</div>
          <Card>
            <AddProvider compact onDone={() => setStep(1)} />
          </Card>
          <div className="row">
            <Btn onClick={() => setStep(1)}>Skip for now</Btn>
          </div>
        </div>
      )}
      {step === 1 && (
        <div className="col">
          <div className="switch-row">
            <div className="grow">
              <div className="t">Start automatically when you sign in</div>
              <div className="d">The server waits in the tray, ready for your other PCs.</div>
            </div>
            <Toggle on={s.config.autoStart} label="autostart" onChange={(v) => run('setAutoStart', v)} />
          </div>
          <div className="row">
            <Btn variant="primary" onClick={() => setStep(2)}>
              Next
            </Btn>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="col">
          <div className="switch-row">
            <div className="grow">
              <div className="t">LAN access for trusted devices</div>
              <div className="d">PCs on your Wi-Fi, hotspot or cable can find this server. Each one still needs your approval once.</div>
            </div>
            <Toggle on={s.switches.lan} label="lan" onChange={(v) => run('setSwitches', { lan: v })} />
          </div>
          <div className="switch-row">
            <div className="grow">
              <div className="t">Remote access</div>
              <div className="d">Only if a PC outside this network must connect. Needs extra setup (see Internet gateway page). Leave OFF if unsure.</div>
            </div>
            <Toggle on={s.switches.remote} label="remote" onChange={(v) => run('setSwitches', { remote: v })} />
          </div>
          <div className="help">
            If Windows or macOS asks about incoming connections for “Raven Master Server”, choose <b>Allow</b>.
          </div>
          <div className="row">
            <Btn variant="primary" onClick={() => setStep(3)}>
              Next
            </Btn>
          </div>
        </div>
      )}
      {step === 3 && (
        <div className="col">
          <div className="help">
            Ready. On the other PC, double-click <b>RavenBrowser.exe</b>. It finds this server, shows a 6-digit code, and appears here for approval. This laptop’s address is{' '}
            <Hidden text={s.stats.addresses.map((a) => `${a}:${s.stats.port}`).join(' or ')} empty="not available yet" /> if you ever need to type it.
          </div>
          <div className="row">
            <Btn
              variant="primary"
              magnetic
              onClick={async () => {
                await run('updateConfig', { setupDone: true });
                done();
              }}
            >
              Open dashboard
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Lock() {
  const { run } = useC();
  const [pin, setPin] = useState('');
  return (
    <div className="lock">
      <Card style={{ width: 380, padding: 26 }}>
        <h2>
          <Scramble text="Dashboard locked" />
        </h2>
        <div className="help" style={{ margin: '10px 0 14px' }}>The server keeps running. Enter your PIN to change anything.</div>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            await run('unlock', pin);
            setPin('');
          }}
        >
          <input className="input" type="password" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} placeholder="PIN" />
          <Btn variant="primary" type="submit">
            Unlock
          </Btn>
        </form>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------ App
function App() {
  const [s, setS] = useState<MasterSnapshot | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const { push, view } = useToasts();
  useEffect(() => {
    void bridge.invoke('state').then((r) => r.ok && setS(r.data as MasterSnapshot));
    return bridge.onState(setS);
  }, []);
  const run = useCallback(
    async <T,>(method: string, ...args: unknown[]): Promise<T | undefined> => {
      const r = await bridge.invoke(method, ...args);
      if (!r.ok) {
        push(r.error ?? 'Something went wrong.', 'bad');
        return undefined;
      }
      return (r.data ?? true) as T;
    },
    [push],
  );
  const confirm = useCallback(async (message: string, detail?: string) => {
    const r = await bridge.invoke('confirm', message, detail);
    return r.ok && r.data === true;
  }, []);
  const ctx = useMemo<Ctx | null>(() => (s ? { s, run, toast: push, confirm } : null), [s, run, push, confirm]);
  if (!s || !ctx) return null;
  const pending = s.stats.pending;
  return (
    <C.Provider value={ctx}>
      <div className="shell">
        <div className="titlebar">
          <span className="sp" />
          <Chip tone={s.switches.master && s.stats.listening ? 'ok' : 'bad'}>
            <Dot tone={s.switches.master && s.stats.listening ? 'ok' : 'bad'} live={s.switches.master && s.stats.listening} />
            {s.switches.master && s.stats.listening ? `${s.stats.clients} connected` : 'Not serving'}
          </Chip>
        </div>
        <aside className="side">
          <div className="brand">
            <img src={logoUrl} alt="" />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Raven</div>
              <div className="faint" style={{ fontSize: 12 }}>Master Server</div>
            </div>
          </div>
          <nav className="nav">
            {PAGES.map((p) => (
              <button key={p.id} className={page === p.id ? 'on' : ''} onClick={() => setPage(p.id)}>
                <span>{p.label}</span>
                {p.id === 'devices' && pending > 0 && <span className="cnt">{pending}</span>}
              </button>
            ))}
          </nav>
          <div className="foot">v{s.version} · local dashboard</div>
        </aside>
        <main className="main">
          <AnimatePresence mode="wait">
            <motion.div key={page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
              {page === 'overview' && (
                <>
                  <Head title="Overview">One place to see whether this master is giving your other devices internet and AI.</Head>
                  <Overview go={setPage} />
                </>
              )}
              {page === 'control' && <Control />}
              {page === 'devices' && <Devices />}
              {page === 'gateway' && <Gateway />}
              {page === 'ai' && <AiPage />}
              {page === 'models' && <Models />}
              {page === 'logs' && <Logs />}
              {page === 'settings' && <Settings />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      {!s.config.setupDone && !s.locked && <Setup done={() => setPage('ai')} />}
      {s.locked && <Lock />}
      {view}
    </C.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
