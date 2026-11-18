// raven://passwords — saved logins: search, reveal, copy, delete; sites set to "never save".
import React, { useEffect, useState } from 'react';
import { Btn } from '@raven/ui';
import { hostOf, useC } from './ctx';
import * as I from './icons';

interface Login {
  id: string;
  origin: string;
  username: string;
  created: number;
  lastUsed: number;
}

export function PasswordsPage() {
  const { run, toast } = useC();
  const [logins, setLogins] = useState<Login[]>([]);
  const [never, setNever] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState<Record<string, string>>({});
  const load = async () => {
    const r = await run<{ logins: Login[]; never: string[] }>('passwordsList');
    if (r) {
      setLogins(r.logins);
      setNever(r.never);
    }
  };
  useEffect(() => void load(), []);
  // Revealed passwords hide again after 20 seconds.
  useEffect(() => {
    if (!Object.keys(shown).length) return;
    const t = setTimeout(() => setShown({}), 20_000);
    return () => clearTimeout(t);
  }, [shown]);
  const list = logins.filter((l) => !q || `${l.origin} ${l.username}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="internal">
      <div className="internal-inner">
        <div className="ip-head">
          <div>
            <h1>Passwords</h1>
            <div className="muted" style={{ fontSize: 13, marginTop: 6, maxWidth: 620 }}>
              Saved on this computer, encrypted by the system. Filled only on the exact site they belong to, when you click into the sign-in box.
            </div>
          </div>
        </div>
        <input className="input" placeholder="Search passwords" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340, marginBottom: 12 }} />
        {list.map((l) => (
          <div className="list-row pw-row" key={l.id}>
            <I.IGlobe size={14} />
            <span className="tt">{hostOf(l.origin)}</span>
            <span className="uu selectable">{l.username || <span className="faint">no username</span>}</span>
            <span className="mono selectable pw-val">{shown[l.id] ?? '••••••••'}</span>
            <button
              className="icon-btn"
              title={shown[l.id] ? 'Hide' : 'Show'}
              onClick={async () => {
                if (shown[l.id]) return setShown(({ [l.id]: _x, ...rest }) => rest);
                const p = await run<string>('passwordReveal', l.id);
                if (p !== undefined) setShown((s) => ({ ...s, [l.id]: p }));
              }}
            >
              {shown[l.id] ? <I.IPrivate size={15} /> : <I.ISearch size={15} />}
            </button>
            <button className="icon-btn" title="Copy password (cleared from the clipboard after 30 seconds)" onClick={async () => (await run('passwordCopy', l.id)) && toast('Password copied.', 'ok')}>
              <I.ICopy size={15} />
            </button>
            <button
              className="icon-btn"
              title="Delete"
              onClick={async () => {
                if (!confirm(`Delete the saved password for ${l.username || 'this login'} on ${hostOf(l.origin)}?`)) return;
                await run('passwordDelete', l.id);
                void load();
              }}
            >
              <I.ITrash size={15} />
            </button>
          </div>
        ))}
        {list.length === 0 && <div className="faint">{q ? 'No match.' : 'No saved passwords yet. Sign in to a site and choose Save when Raven asks.'}</div>}
        {never.length > 0 && (
          <>
            <div className="label" style={{ margin: '24px 0 8px' }}>
              Never saved for
            </div>
            {never.map((o) => (
              <div className="list-row" key={o}>
                <span className="tt">{hostOf(o)}</span>
                <span className="grow" />
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await run('passwordNever', o, false);
                    void load();
                  }}
                >
                  Remove
                </Btn>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
