// Web search done on the master: its own hidden browser opens the search engine, reads the result list and
// sends back plain results (title, address, snippet). The user's browser shows them on its own results page,
// so searches work even when the engine would challenge the user's PC, and the user PC never needs its own DNS
// or internet. One hidden window per device (own cookies), closed after a few idle minutes.
import { BrowserWindow, session } from 'electron';
import type { DeviceRecord } from '@raven/shared';
import { httpSearch } from '../core/httpsearch';

export type Engine = 'google' | 'duckduckgo' | 'bing' | 'brave';
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  site: string;
}
export interface SearchResponse {
  query: string;
  engine: Engine;
  page: number;
  results: SearchResult[];
  /** engines that showed a robot check or failed before one answered */
  skipped: Engine[];
}

const URLS: Record<Engine, (q: string, page: number) => string> = {
  google: (q, p) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&num=10${p ? `&start=${p * 10}` : ''}`,
  duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  bing: (q, p) => `https://www.bing.com/search?q=${encodeURIComponent(q)}${p ? `&first=${p * 10 + 1}` : ''}`,
  brave: (q, p) => `https://search.brave.com/search?q=${encodeURIComponent(q)}${p ? `&offset=${p}` : ''}`,
};

/** Runs inside the engine's page. Engine-specific selectors first, then a generic "heading inside a link" fallback. */
const EXTRACT = `(() => {
  const host = location.hostname;
  const text = (el) => (el ? el.innerText || el.textContent || '' : '').replace(/\\s+/g, ' ').trim();
  const blocked = /\\/sorry\\//.test(location.pathname) || !!document.querySelector('#captcha-form, form[action*="captcha"], #challenge-form, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]') || /unusual traffic|are you a robot|verify you are human|confirm you.?re not a robot/i.test(text(document.body).slice(0, 3000));
  const out = [];
  const push = (title, href, snippet) => {
    if (!title || !href) return;
    try {
      let u = new URL(href, location.href);
      if (u.hostname.endsWith('duckduckgo.com') && u.searchParams.get('uddg')) u = new URL(u.searchParams.get('uddg'));
      if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/') && u.searchParams.get('u')) {
        const v = u.searchParams.get('u').replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/');
        u = new URL(atob(v));
      }
      if (u.hostname.endsWith('google.com') && u.pathname === '/url' && u.searchParams.get('q')) u = new URL(u.searchParams.get('q'));
      if (!/^https?:$/.test(u.protocol)) return;
      const h = u.hostname;
      if (h === host || h.endsWith('.google.com') || h.endsWith('google.com') && u.pathname.startsWith('/search') || h.endsWith('duckduckgo.com') || h.endsWith('bing.com') || h.endsWith('search.brave.com')) return;
      if (out.some((r) => r.url === u.href)) return;
      out.push({ title: title.slice(0, 200), url: u.href, snippet: (snippet || '').slice(0, 400), site: h.replace(/^www\\./, '') });
    } catch {}
  };
  if (host.endsWith('google.com')) {
    for (const h3 of document.querySelectorAll('#search a h3, #rso a h3')) {
      const a = h3.closest('a');
      const box = h3.closest('[data-hveid], .g, .MjjYud') || a.parentElement;
      const sn = box ? text(box.querySelector('.VwiC3b, [data-sncf], .IsZvec, [style*="-webkit-line-clamp"]')) : '';
      push(text(h3), a.getAttribute('href'), sn);
    }
  } else if (host.endsWith('duckduckgo.com')) {
    for (const r of document.querySelectorAll('.result, .web-result')) {
      const a = r.querySelector('.result__a, a.result__url, h2 a');
      if (a) push(text(a), a.getAttribute('href'), text(r.querySelector('.result__snippet')));
    }
  } else if (host.endsWith('bing.com')) {
    for (const r of document.querySelectorAll('li.b_algo')) {
      const a = r.querySelector('h2 a');
      if (a) push(text(a), a.getAttribute('href'), text(r.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_paractl')));
    }
  } else if (host.endsWith('brave.com')) {
    for (const r of document.querySelectorAll('#results .snippet[data-type="web"], #results [data-type="web"]')) {
      const a = r.querySelector('a[href^="http"]');
      if (a) push(text(r.querySelector('.title, .search-snippet-title')) || text(a), a.getAttribute('href'), text(r.querySelector('.snippet-description, .generic-snippet .content')));
    }
  }
  if (!out.length && !blocked) {
    for (const hd of document.querySelectorAll('a h3, a h2, h3 a, h2 a')) {
      const a = hd.tagName === 'A' ? hd : hd.closest('a');
      if (a) push(text(hd), a.getAttribute('href'), '');
      if (out.length >= 15) break;
    }
  }
  return { blocked, results: out.slice(0, 20) };
})()`;

interface Slot {
  win: BrowserWindow;
  timer: NodeJS.Timeout | null;
  queue: Promise<unknown>;
}

export class MasterSearch {
  private slots = new Map<string, Slot>();

  constructor(private guardSession: (ses: Electron.Session) => void) {}

  private slot(deviceId: string): Slot {
    let s = this.slots.get(deviceId);
    if (s && !s.win.isDestroyed()) return s;
    const ses = session.fromPartition(`persist:search-${deviceId}`);
    this.guardSession(ses);
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: ses, sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true, javascript: true } });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    s = { win, timer: null, queue: Promise.resolve() };
    this.slots.set(deviceId, s);
    return s;
  }

  async search(device: DeviceRecord, query: string, preferred: Engine, page: number): Promise<SearchResponse> {
    const q = query.trim().slice(0, 400);
    if (!q) throw Object.assign(new Error('Type something to search for.'), { code: 'bad_request' });
    const s = this.slot(device.id);
    // One search at a time per device; later ones wait their turn.
    const run = s.queue.then(() => this.run(s, q, preferred, Math.max(0, Math.min(9, Math.floor(page)))));
    s.queue = run.catch(() => {});
    try {
      return await run;
    } finally {
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(() => this.close(device.id), 5 * 60_000);
      s.timer.unref?.();
    }
  }

  /** Engines that showed a robot check recently are skipped for a while (no point waiting on them again). */
  private blockedUntil = new Map<Engine, number>();

  private async run(s: Slot, q: string, preferred: Engine, page: number): Promise<SearchResponse> {
    const now = Date.now();
    const usable = (e: Engine) => (this.blockedUntil.get(e) ?? 0) < now;
    const skipped: Engine[] = (['google', 'duckduckgo', 'bing', 'brave'] as Engine[]).filter((e) => !usable(e));
    const wc = s.win.webContents;
    // 1. The engine the person chose, in the hidden browser (best results), unless it is blocking bots right now.
    // 2. If it is blocked: the fast text-only engines (no page rendering, no robot checks).
    // 3. Then the other engines in the hidden browser.
    const tryBrowser = async (engine: Engine): Promise<SearchResponse | null> => {
      try {
        await Promise.race([wc.loadURL(URLS[engine](q, page)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), engine === 'google' ? 8_000 : 15_000))]);
        let got: { blocked: boolean; results: SearchResult[] } = { blocked: false, results: [] };
        for (let i = 0; i < 6; i++) {
          got = await wc.executeJavaScript(EXTRACT);
          if (got.blocked || got.results.length) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        if (got.blocked) this.blockedUntil.set(engine, Date.now() + 30 * 60_000);
        if (!got.blocked && got.results.length) return { query: q, engine, page, results: got.results, skipped };
      } catch {
        /* next */
      }
      skipped.push(engine);
      return null;
    };
    if (usable(preferred)) {
      const r = await tryBrowser(preferred);
      if (r) return r;
    }
    try {
      const fast = await httpSearch(q, page);
      return { ...fast, skipped: [...skipped, ...fast.skipped] };
    } catch {
      /* the hidden browser is the last resort */
    }
    for (const engine of (['duckduckgo', 'bing', 'brave', 'google'] as Engine[]).filter((e) => e !== preferred && usable(e))) {
      const r = await tryBrowser(engine);
      if (r) return r;
    }
    throw Object.assign(new Error('No search engine answered from the master right now (all showed a robot check or failed). Try again in a minute.'), { code: 'providers_unavailable' });
  }

  close(deviceId: string): void {
    const s = this.slots.get(deviceId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    if (!s.win.isDestroyed()) s.win.destroy();
    this.slots.delete(deviceId);
  }

  shutdown(): void {
    for (const id of [...this.slots.keys()]) this.close(id);
  }
}
