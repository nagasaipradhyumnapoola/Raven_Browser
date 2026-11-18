// When the dashboard is served by the headless master (phone, server) there is no Electron preload.
// This bridge speaks to the master over the device's own loopback address with a one-time token.
import type { InvokeResult, MasterSnapshot } from '../types';

export interface Bridge {
  invoke(method: string, ...args: unknown[]): Promise<InvokeResult>;
  onState(cb: (s: MasterSnapshot) => void): () => void;
}

function token(): string {
  const fromHash = /[#&]t=([A-Za-z0-9_-]{16,})/.exec(location.hash)?.[1];
  try {
    if (fromHash) {
      sessionStorage.setItem('raven-token', fromHash);
      history.replaceState(null, '', location.pathname);
    }
    return fromHash ?? sessionStorage.getItem('raven-token') ?? '';
  } catch {
    return fromHash ?? '';
  }
}

export function webBridge(): Bridge {
  const t = token();
  return {
    async invoke(method, ...args) {
      // Confirmation dialogs are shown by the page itself here.
      if (method === 'confirm') return { ok: true, data: window.confirm([args[0], args[1]].filter(Boolean).join('\n\n')) };
      try {
        const res = await fetch('/api/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ method, args }) });
        if (res.status === 401) return { ok: false, error: 'This dashboard link has expired. Open it again from the Raven Master app.' };
        return (await res.json()) as InvokeResult;
      } catch {
        return { ok: false, error: 'The master server is not responding.' };
      }
    },
    onState(cb) {
      let es: EventSource | null = null;
      let stopped = false;
      const open = () => {
        es = new EventSource(`/api/events?t=${encodeURIComponent(t)}`);
        es.onmessage = (e) => {
          try {
            cb(JSON.parse(e.data));
          } catch {
            /* partial */
          }
        };
        es.onerror = () => {
          es?.close();
          if (!stopped) setTimeout(open, 2000);
        };
      };
      open();
      return () => {
        stopped = true;
        es?.close();
      };
    },
  };
}
