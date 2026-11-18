// Web search without a browser engine (phones, servers): fetch the engines' plain HTML result pages and read them.
// The desktop master uses its hidden browser instead and falls back to this.
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
  skipped: Engine[];
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function clean(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function result(title: string, href: string, snippet: string): SearchResult | null {
  try {
    let u = new URL(href.replace(/&amp;/g, '&'), 'https://duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com') && u.searchParams.get('uddg')) u = new URL(u.searchParams.get('uddg')!);
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/') && u.searchParams.get('u')) {
      u = new URL(Buffer.from(u.searchParams.get('u')!.replace(/^a1/, ''), 'base64url').toString('utf8'));
    }
    if (!/^https?:$/.test(u.protocol) || /(^|\.)(duckduckgo|bing)\.com$/.test(u.hostname)) return null;
    const t = clean(title);
    if (!t) return null;
    return { title: t.slice(0, 200), url: u.href, snippet: clean(snippet).slice(0, 400), site: u.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

async function get(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function duckduckgo(q: string): Promise<SearchResult[]> {
  const html = await get('https://html.duckduckgo.com/html/', { method: 'POST', body: new URLSearchParams({ q }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const out: SearchResult[] = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result results_links)/g;
  for (let m; (m = re.exec(html)) && out.length < 20; ) {
    const r = result(m[2], m[1], m[3] ?? '');
    if (r && !out.some((x) => x.url === r.url)) out.push(r);
  }
  return out;
}

async function bing(q: string, page: number): Promise<SearchResult[]> {
  const html = await get(`https://www.bing.com/search?q=${encodeURIComponent(q)}${page ? `&first=${page * 10 + 1}` : ''}`);
  const out: SearchResult[] = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>|<\/li>)/g;
  for (let m; (m = re.exec(html)) && out.length < 20; ) {
    const r = result(m[2], m[1], m[3] ?? '');
    if (r && !out.some((x) => x.url === r.url)) out.push(r);
  }
  return out;
}

export async function httpSearch(query: string, page = 0): Promise<SearchResponse> {
  const q = query.trim().slice(0, 400);
  if (!q) throw Object.assign(new Error('Type something to search for.'), { code: 'bad_request' });
  const skipped: Engine[] = [];
  const tries: [Engine, () => Promise<SearchResult[]>][] = page === 0 ? [['duckduckgo', () => duckduckgo(q)], ['bing', () => bing(q, 0)]] : [['bing', () => bing(q, page)]];
  for (const [engine, run] of tries) {
    try {
      const results = await run();
      if (results.length) return { query: q, engine, page, results, skipped };
    } catch {
      /* next engine */
    }
    skipped.push(engine);
  }
  throw Object.assign(new Error('No search engine answered from the master right now. Try again in a minute.'), { code: 'providers_unavailable' });
}
