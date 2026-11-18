// Raven Browser memory: plain files on the local SSD, no database.
//
//   <root>/history/2026-11.jsonl          visited pages (append-only)
//   <root>/searches/2026-11.jsonl         address-bar searches
//   <root>/bookmarks/bookmarks.json
//   <root>/ai-conversations/<id>.json     one file per conversation
//   <root>/page-notes/<id>.md             Markdown with a small header
//   <root>/saved-pages/<id>.html + .json  pages the user chose to keep
//   <root>/downloads-metadata/downloads.jsonl
//   <root>/memory-index/manifest.json     derived, rebuildable
//   <root>/backups/<stamp>/...            incremental copies
//
// Full-text search runs over an in-memory inverted index built from those
// files. The index is derived data: delete it, or call rebuildIndex(), and it
// is recreated from the source files.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendJsonl, atomicWrite, flushWrites, listFiles, queuedWrite, readJsonl, readJsonSync, rewriteJsonl, dirSize } from './fsutil';

export type MemKind = 'visit' | 'search' | 'bookmark' | 'note' | 'chat' | 'download' | 'page';

export interface VisitRec {
  ts: number;
  url: string;
  title: string;
}
export interface SearchRec {
  ts: number;
  q: string;
  engine: string;
}
export interface Bookmark {
  id: string;
  url: string;
  title: string;
  ts: number;
  folder?: string;
}
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  model?: string | null;
  /** short description of page context that was attached, if any */
  context?: string;
  error?: string;
}
export interface Conversation {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
}
export interface ConversationMeta {
  id: string;
  title: string;
  created: number;
  updated: number;
  count: number;
}
export interface Note {
  id: string;
  title: string;
  url?: string;
  ts: number;
  body: string;
}
export interface DownloadRec {
  id: string;
  ts: number;
  url: string;
  filename: string;
  path: string;
  size: number;
  received: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  mime?: string;
  done?: number;
}
export interface SavedPage {
  id: string;
  url: string;
  title: string;
  ts: number;
  bytes: number;
}

export interface MemDoc {
  kind: MemKind;
  ts: number;
  title: string;
  url?: string;
  snippet: string;
  /** conversation id, note id, bookmark id, ... */
  ref?: string;
}
export interface SearchHit extends MemDoc {
  score: number;
}

const MAX_DOCS = 60_000;
const DIRS = ['history', 'searches', 'bookmarks', 'ai-conversations', 'page-notes', 'saved-pages', 'downloads-metadata', 'memory-index', 'backups', 'logs', 'offline-reference'];
/** Folders that hold user memory (what backup / export / "delete everything" cover). */
const USER_DIRS = ['history', 'searches', 'bookmarks', 'ai-conversations', 'page-notes', 'saved-pages', 'downloads-metadata'];

const monthOf = (ts: number) => new Date(ts).toISOString().slice(0, 7);
const newId = () => `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const safeId = (id: string) => /^[a-z0-9]{6,40}$/i.test(id);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[\p{L}\p{N}_+#]{2,}/gu;
  let m: RegExpExecArray | null;
  const lower = text.toLowerCase();
  while ((m = re.exec(lower))) {
    out.push(m[0].length > 40 ? m[0].slice(0, 40) : m[0]);
    if (out.length > 4000) break;
  }
  return out;
}

/** Inverted index kept in RAM, bounded to MAX_DOCS most recent documents. */
class Index {
  docs: (MemDoc | null)[] = [];
  private postings = new Map<string, number[]>();
  private sortedTokens: string[] | null = null;
  live = 0;

  clear(): void {
    this.docs = [];
    this.postings.clear();
    this.sortedTokens = null;
    this.live = 0;
  }

  add(doc: MemDoc, extraText = ''): number {
    const i = this.docs.length;
    this.docs.push(doc);
    this.live++;
    const seen = new Set<string>();
    for (const t of tokenize(`${doc.title} ${doc.url ?? ''} ${doc.snippet} ${extraText}`)) {
      if (seen.has(t)) continue;
      seen.add(t);
      let p = this.postings.get(t);
      if (!p) {
        p = [];
        this.postings.set(t, p);
        this.sortedTokens = null;
      }
      p.push(i);
    }
    return i;
  }

  remove(pred: (d: MemDoc) => boolean): number {
    let n = 0;
    for (let i = 0; i < this.docs.length; i++) {
      const d = this.docs[i];
      if (d && pred(d)) {
        this.docs[i] = null;
        this.live--;
        n++;
      }
    }
    return n;
  }

  /** True when tombstones or sheer size mean the index should be rebuilt from files. */
  get bloated(): boolean {
    return this.docs.length > MAX_DOCS * 1.3 || (this.docs.length > 2000 && this.live < this.docs.length / 2);
  }

  private prefixMatches(prefix: string): number[][] {
    if (!this.sortedTokens) this.sortedTokens = [...this.postings.keys()].sort();
    const toks = this.sortedTokens;
    let lo = 0;
    let hi = toks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (toks[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: number[][] = [];
    for (let i = lo; i < toks.length && toks[i].startsWith(prefix) && out.length < 200; i++) out.push(this.postings.get(toks[i])!);
    return out;
  }

  search(query: string, kinds: Set<MemKind> | null, limit: number): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    let candidate: Set<number> | null = null;
    terms.forEach((term, ti) => {
      const last = ti === terms.length - 1;
      const lists = last ? this.prefixMatches(term) : [this.postings.get(term) ?? []];
      const ids = new Set<number>();
      for (const l of lists) for (const id of l) ids.add(id);
      if (candidate === null) candidate = ids;
      else {
        const next = new Set<number>();
        for (const id of candidate) if (ids.has(id)) next.add(id);
        candidate = next;
      }
    });
    const now = Date.now();
    const hits: SearchHit[] = [];
    for (const id of candidate ?? []) {
      const d = this.docs[id];
      if (!d || (kinds && !kinds.has(d.kind))) continue;
      const title = d.title.toLowerCase();
      let score = 1;
      for (const t of terms) if (title.includes(t)) score += 2;
      if (title.includes(query.toLowerCase().trim())) score += 3;
      const ageDays = Math.max(0, (now - d.ts) / 86_400_000);
      score += 2 / (1 + ageDays / 14);
      if (d.kind === 'bookmark' || d.kind === 'note') score += 1;
      hits.push({ ...d, score });
    }
    hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
    return hits.slice(0, limit);
  }
}

export interface MemoryStats {
  root: string;
  indexedDocs: number;
  indexBuiltAt: number;
  badLines: number;
  counts: Record<MemKind, number>;
  bytes: number;
  lastBackup: number;
}

export class MemoryStore {
  readonly root: string;
  private index = new Index();
  private bookmarks: Bookmark[] = [];
  private convMeta = new Map<string, ConversationMeta>();
  private downloads = new Map<string, DownloadRec>();
  private lastVisit: VisitRec | null = null;
  private badLines = 0;
  private indexBuiltAt = 0;
  private counts: Record<MemKind, number> = { visit: 0, search: 0, bookmark: 0, note: 0, chat: 0, download: 0, page: 0 };
  ready: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  p(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  /** Create folders and build the index from the files on disk. */
  init(): Promise<void> {
    for (const d of DIRS) fs.mkdirSync(this.p(d), { recursive: true });
    this.ready = this.rebuildIndex();
    return this.ready;
  }

  // ---------------------------------------------------------------- index
  async rebuildIndex(): Promise<void> {
    const index = new Index();
    const counts: Record<MemKind, number> = { visit: 0, search: 0, bookmark: 0, note: 0, chat: 0, download: 0, page: 0 };
    let bad = 0;

    // Bookmarks, notes, conversations, saved pages, downloads: small, always fully indexed.
    const bm = readJsonSync<unknown>(this.p('bookmarks', 'bookmarks.json'), []);
    this.bookmarks = Array.isArray(bm)
      ? bm.filter((b: any) => b && typeof b.url === 'string' && typeof b.id === 'string').map((b: any) => ({ id: b.id, url: b.url, title: String(b.title ?? b.url), ts: Number(b.ts) || 0, folder: typeof b.folder === 'string' ? b.folder : undefined }))
      : [];
    for (const b of this.bookmarks) {
      index.add({ kind: 'bookmark', ts: b.ts, title: b.title, url: b.url, snippet: '', ref: b.id });
      counts.bookmark++;
    }
    for (const f of await listFiles(this.p('page-notes'), '.md')) {
      const n = this.readNoteFile(path.join(this.p('page-notes'), f));
      if (!n) {
        bad++;
        continue;
      }
      index.add({ kind: 'note', ts: n.ts, title: n.title, url: n.url, snippet: n.body.slice(0, 240), ref: n.id }, n.body.slice(0, 6000));
      counts.note++;
    }
    this.convMeta.clear();
    for (const f of await listFiles(this.p('ai-conversations'), '.json')) {
      const c = this.readConversationFile(path.join(this.p('ai-conversations'), f));
      if (!c) {
        bad++;
        continue;
      }
      this.convMeta.set(c.id, { id: c.id, title: c.title, created: c.created, updated: c.updated, count: c.messages.length });
      for (const m of c.messages) {
        if (m.role === 'system' || !m.content) continue;
        index.add({ kind: 'chat', ts: m.ts, title: c.title, snippet: m.content.slice(0, 240), ref: c.id }, m.content.slice(0, 6000));
        counts.chat++;
      }
    }
    for (const f of await listFiles(this.p('saved-pages'), '.json')) {
      const meta = readJsonSync<any>(path.join(this.p('saved-pages'), f), null);
      if (!meta || typeof meta.url !== 'string') continue;
      index.add({ kind: 'page', ts: Number(meta.ts) || 0, title: String(meta.title ?? meta.url), url: meta.url, snippet: String(meta.excerpt ?? '').slice(0, 240), ref: String(meta.id) }, String(meta.text ?? '').slice(0, 8000));
      counts.page++;
    }
    this.downloads.clear();
    const dl = await readJsonl<DownloadRec>(this.p('downloads-metadata', 'downloads.jsonl'), (r) => {
      if (r && typeof r.id === 'string') this.downloads.set(r.id, { ...(this.downloads.get(r.id) ?? {}), ...r } as DownloadRec);
    });
    bad += dl.bad;
    for (const d of this.downloads.values()) {
      if ((d as any).deleted) {
        this.downloads.delete(d.id);
        continue;
      }
      index.add({ kind: 'download', ts: d.ts, title: d.filename, url: d.url, snippet: d.path, ref: d.id });
      counts.download++;
    }

    // History and searches: newest months first, stop at the document cap.
    const budget = () => MAX_DOCS - index.docs.length;
    for (const dir of ['searches', 'history'] as const) {
      const files = (await listFiles(this.p(dir), '.jsonl')).reverse();
      for (const f of files) {
        if (budget() <= 0) break;
        const recs: any[] = [];
        const res = await readJsonl<any>(path.join(this.p(dir), f), (r) => {
          recs.push(r);
        });
        bad += res.bad;
        const take = recs.slice(-Math.max(0, budget()));
        for (const r of take) {
          if (dir === 'history' && r && typeof r.url === 'string') {
            index.add({ kind: 'visit', ts: Number(r.ts) || 0, title: String(r.title ?? r.url), url: r.url, snippet: '' });
            counts.visit++;
          } else if (dir === 'searches' && r && typeof r.q === 'string') {
            index.add({ kind: 'search', ts: Number(r.ts) || 0, title: r.q, snippet: `searched with ${r.engine ?? 'search engine'}` });
            counts.search++;
          }
        }
      }
    }
    this.index = index;
    this.counts = counts;
    this.badLines = bad;
    this.indexBuiltAt = Date.now();
    await atomicWrite(
      this.p('memory-index', 'manifest.json'),
      JSON.stringify({ note: 'Derived data. Safe to delete; Raven rebuilds it from the other folders.', builtAt: this.indexBuiltAt, documents: index.live, cap: MAX_DOCS, counts, skippedCorruptLines: bad }, null, 2),
    ).catch(() => {});
  }

  private addDoc(doc: MemDoc, extra?: string): void {
    this.index.add(doc, extra);
    this.counts[doc.kind]++;
    if (this.index.bloated) void this.rebuildIndex();
  }

  /** Search local memory. Falls back to scanning older history files when the index (most recent data) has few hits. */
  async search(query: string, opts: { kinds?: MemKind[]; limit?: number; deep?: boolean } = {}): Promise<SearchHit[]> {
    await this.ready;
    const limit = Math.min(200, opts.limit ?? 40);
    const kinds = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : null;
    const hits = this.index.search(query, kinds, limit);
    if (!opts.deep || hits.length >= limit) return hits;
    // Deep search: stream every history/search file once; nothing is held in memory but the matches.
    const terms = tokenize(query);
    if (!terms.length) return hits;
    const seen = new Set(hits.map((h) => `${h.kind}|${h.ts}|${h.url ?? h.title}`));
    for (const dir of ['history', 'searches'] as const) {
      if (kinds && !kinds.has(dir === 'history' ? 'visit' : 'search')) continue;
      for (const f of (await listFiles(this.p(dir), '.jsonl')).reverse()) {
        await readJsonl<any>(path.join(this.p(dir), f), (r) => {
          const text = dir === 'history' ? `${r.title ?? ''} ${r.url ?? ''}` : String(r.q ?? '');
          const lower = text.toLowerCase();
          if (!terms.every((t) => lower.includes(t))) return;
          const doc: SearchHit =
            dir === 'history'
              ? { kind: 'visit', ts: Number(r.ts) || 0, title: String(r.title ?? r.url), url: r.url, snippet: '', score: 0.5 }
              : { kind: 'search', ts: Number(r.ts) || 0, title: String(r.q), snippet: '', score: 0.5 };
          const key = `${doc.kind}|${doc.ts}|${doc.url ?? doc.title}`;
          if (seen.has(key)) return;
          seen.add(key);
          hits.push(doc);
          return hits.length < limit ? undefined : false;
        });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  // ---------------------------------------------------------------- history
  addVisit(url: string, title: string, ts = Date.now()): void {
    if (!/^https?:|^file:/i.test(url)) return;
    const prev = this.lastVisit;
    // Reloads and in-page navigation within a few seconds are one visit.
    if (prev && prev.url === url && ts - prev.ts < 15_000) return;
    const rec: VisitRec = { ts, url: url.slice(0, 2000), title: (title || url).slice(0, 300) };
    this.lastVisit = rec;
    void appendJsonl(this.p('history', `${monthOf(ts)}.jsonl`), rec);
    this.addDoc({ kind: 'visit', ts, title: rec.title, url: rec.url, snippet: '' });
  }

  addSearch(q: string, engine: string, ts = Date.now()): void {
    const query = q.trim().slice(0, 500);
    if (!query) return;
    void appendJsonl(this.p('searches', `${monthOf(ts)}.jsonl`), { ts, q: query, engine } satisfies SearchRec);
    this.addDoc({ kind: 'search', ts, title: query, snippet: `searched with ${engine}` });
  }

  /** Newest first. Streams month files, so memory use is bounded by one month. */
  async listHistory(opts: { limit?: number; before?: number; q?: string } = {}): Promise<VisitRec[]> {
    return this.listJsonl<VisitRec>('history', opts, (r) => typeof r.url === 'string', (r) => `${r.title} ${r.url}`);
  }

  async listSearches(opts: { limit?: number; before?: number; q?: string } = {}): Promise<SearchRec[]> {
    return this.listJsonl<SearchRec>('searches', opts, (r) => typeof r.q === 'string', (r) => r.q);
  }

  private async listJsonl<T extends { ts: number }>(
    dir: string,
    opts: { limit?: number; before?: number; q?: string },
    valid: (r: T) => boolean,
    text: (r: T) => string,
  ): Promise<T[]> {
    await flushWrites();
    const limit = Math.min(2000, opts.limit ?? 200);
    const q = opts.q?.toLowerCase().trim();
    const before = opts.before ?? Infinity;
    const out: T[] = [];
    for (const f of (await listFiles(this.p(dir), '.jsonl')).reverse()) {
      const month: T[] = [];
      await readJsonl<T>(path.join(this.p(dir), f), (r) => {
        if (!r || !valid(r) || r.ts >= before) return;
        if (q && !text(r).toLowerCase().includes(q)) return;
        month.push(r);
      });
      for (let i = month.length - 1; i >= 0 && out.length < limit; i--) out.push(month[i]);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Delete browsing history: one URL, everything since a time, or all of it. */
  async clearHistory(opts: { url?: string; since?: number } = {}): Promise<number> {
    let removed = 0;
    for (const f of await listFiles(this.p('history'), '.jsonl')) {
      const file = path.join(this.p('history'), f);
      if (!opts.url && !opts.since) {
        await rewriteJsonl(file, () => false).then((n) => (removed += n));
      } else {
        removed += await rewriteJsonl<VisitRec>(file, (r) => !((opts.url ? r.url === opts.url : true) && (opts.since ? r.ts >= opts.since : true)));
      }
    }
    this.lastVisit = null;
    await this.rebuildIndex();
    return removed;
  }

  async clearSearches(since?: number): Promise<number> {
    let removed = 0;
    for (const f of await listFiles(this.p('searches'), '.jsonl')) {
      removed += await rewriteJsonl<SearchRec>(path.join(this.p('searches'), f), (r) => (since ? r.ts < since : false));
    }
    await this.rebuildIndex();
    return removed;
  }

  // ---------------------------------------------------------------- bookmarks
  listBookmarks(): Bookmark[] {
    return [...this.bookmarks].sort((a, b) => b.ts - a.ts);
  }

  isBookmarked(url: string): boolean {
    return this.bookmarks.some((b) => b.url === url);
  }

  private saveBookmarks(): Promise<void> {
    return queuedWrite(this.p('bookmarks', 'bookmarks.json'), JSON.stringify(this.bookmarks, null, 2));
  }

  addBookmark(url: string, title: string, folder?: string): Bookmark {
    const existing = this.bookmarks.find((b) => b.url === url);
    if (existing) return existing;
    const b: Bookmark = { id: newId(), url: url.slice(0, 2000), title: (title || url).slice(0, 300), ts: Date.now(), ...(folder ? { folder } : {}) };
    this.bookmarks.push(b);
    void this.saveBookmarks();
    this.addDoc({ kind: 'bookmark', ts: b.ts, title: b.title, url: b.url, snippet: '', ref: b.id });
    return b;
  }

  removeBookmark(idOrUrl: string): boolean {
    const before = this.bookmarks.length;
    const gone = this.bookmarks.filter((b) => b.id === idOrUrl || b.url === idOrUrl);
    this.bookmarks = this.bookmarks.filter((b) => b.id !== idOrUrl && b.url !== idOrUrl);
    if (this.bookmarks.length === before) return false;
    void this.saveBookmarks();
    const ids = new Set(gone.map((g) => g.id));
    this.counts.bookmark -= this.index.remove((d) => d.kind === 'bookmark' && !!d.ref && ids.has(d.ref));
    return true;
  }

  // ---------------------------------------------------------------- conversations
  private readConversationFile(file: string): Conversation | null {
    const c = readJsonSync<any>(file, null);
    if (!c || typeof c.id !== 'string' || !Array.isArray(c.messages)) return null;
    return {
      id: c.id,
      title: String(c.title ?? 'Conversation').slice(0, 200),
      created: Number(c.created) || 0,
      updated: Number(c.updated) || 0,
      messages: c.messages
        .filter((m: any) => m && typeof m.content === 'string' && ['user', 'assistant', 'system'].includes(m.role))
        .map((m: any) => ({ role: m.role, content: m.content, ts: Number(m.ts) || 0, model: m.model ?? null, ...(m.context ? { context: String(m.context) } : {}), ...(m.error ? { error: String(m.error) } : {}) })),
    };
  }

  listConversations(): ConversationMeta[] {
    return [...this.convMeta.values()].sort((a, b) => b.updated - a.updated);
  }

  getConversation(id: string): Conversation | null {
    if (!safeId(id)) return null;
    return this.readConversationFile(this.p('ai-conversations', `${id}.json`));
  }

  /** Create or replace a conversation file; only new messages are added to the index. */
  saveConversation(conv: Omit<Conversation, 'id' | 'created' | 'updated'> & { id?: string; created?: number }): Conversation {
    const id = conv.id && safeId(conv.id) ? conv.id : newId();
    const prev = this.convMeta.get(id);
    const now = Date.now();
    const full: Conversation = { id, title: (conv.title || 'Conversation').slice(0, 200), created: conv.created ?? prev?.created ?? now, updated: now, messages: conv.messages };
    void queuedWrite(this.p('ai-conversations', `${id}.json`), JSON.stringify(full, null, 2));
    const already = prev?.count ?? 0;
    for (const m of full.messages.slice(already)) {
      if (m.role === 'system' || !m.content) continue;
      this.addDoc({ kind: 'chat', ts: m.ts, title: full.title, snippet: m.content.slice(0, 240), ref: id }, m.content.slice(0, 6000));
    }
    this.convMeta.set(id, { id, title: full.title, created: full.created, updated: now, count: full.messages.length });
    return full;
  }

  async deleteConversation(id: string): Promise<boolean> {
    if (!safeId(id) || !this.convMeta.has(id)) return false;
    await flushWrites();
    await fsp.rm(this.p('ai-conversations', `${id}.json`), { force: true });
    this.convMeta.delete(id);
    this.counts.chat -= this.index.remove((d) => d.kind === 'chat' && d.ref === id);
    return true;
  }

  async clearConversations(): Promise<number> {
    await flushWrites();
    const n = this.convMeta.size;
    for (const f of await listFiles(this.p('ai-conversations'), '.json')) await fsp.rm(path.join(this.p('ai-conversations'), f), { force: true });
    await this.rebuildIndex();
    return n;
  }

  // ---------------------------------------------------------------- notes
  private readNoteFile(file: string): Note | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const m = /^<!--raven-note (.+?)-->\r?\n/.exec(raw);
    if (!m) return null;
    try {
      const h = JSON.parse(m[1]);
      if (typeof h.id !== 'string') return null;
      return { id: h.id, title: String(h.title ?? 'Note'), url: typeof h.url === 'string' ? h.url : undefined, ts: Number(h.ts) || 0, body: raw.slice(m[0].length) };
    } catch {
      return null;
    }
  }

  async listNotes(): Promise<Note[]> {
    await flushWrites();
    const out: Note[] = [];
    for (const f of await listFiles(this.p('page-notes'), '.md')) {
      const n = this.readNoteFile(path.join(this.p('page-notes'), f));
      if (n) out.push(n);
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  saveNote(note: { id?: string; title: string; url?: string; body: string }): Note {
    const id = note.id && safeId(note.id) ? note.id : newId();
    const n: Note = { id, title: (note.title || 'Note').slice(0, 200), url: note.url?.slice(0, 2000), ts: Date.now(), body: note.body.slice(0, 500_000) };
    const header = JSON.stringify({ id: n.id, title: n.title, url: n.url, ts: n.ts });
    void queuedWrite(this.p('page-notes', `${id}.md`), `<!--raven-note ${header}-->\n${n.body}`);
    this.counts.note -= this.index.remove((d) => d.kind === 'note' && d.ref === id);
    this.addDoc({ kind: 'note', ts: n.ts, title: n.title, url: n.url, snippet: n.body.slice(0, 240), ref: id }, n.body.slice(0, 6000));
    return n;
  }

  async deleteNote(id: string): Promise<boolean> {
    if (!safeId(id)) return false;
    await flushWrites();
    await fsp.rm(this.p('page-notes', `${id}.md`), { force: true });
    this.counts.note -= this.index.remove((d) => d.kind === 'note' && d.ref === id);
    return true;
  }

  async clearNotes(): Promise<void> {
    await flushWrites();
    for (const f of await listFiles(this.p('page-notes'), '.md')) await fsp.rm(path.join(this.p('page-notes'), f), { force: true });
    await this.rebuildIndex();
  }

  // ---------------------------------------------------------------- saved pages (explicit user action only)
  async savePage(page: { url: string; title: string; html: string; text: string }): Promise<SavedPage> {
    const id = newId();
    const meta = { id, url: page.url.slice(0, 2000), title: (page.title || page.url).slice(0, 300), ts: Date.now(), bytes: Buffer.byteLength(page.html), excerpt: page.text.slice(0, 400), text: page.text.slice(0, 20_000) };
    await atomicWrite(this.p('saved-pages', `${id}.html`), page.html);
    await atomicWrite(this.p('saved-pages', `${id}.json`), JSON.stringify(meta, null, 2));
    this.addDoc({ kind: 'page', ts: meta.ts, title: meta.title, url: meta.url, snippet: meta.excerpt.slice(0, 240), ref: id }, meta.text.slice(0, 8000));
    return { id, url: meta.url, title: meta.title, ts: meta.ts, bytes: meta.bytes };
  }

  async listSavedPages(): Promise<(SavedPage & { excerpt: string })[]> {
    const out: (SavedPage & { excerpt: string })[] = [];
    for (const f of await listFiles(this.p('saved-pages'), '.json')) {
      const m = readJsonSync<any>(path.join(this.p('saved-pages'), f), null);
      if (m && typeof m.id === 'string') out.push({ id: m.id, url: m.url, title: m.title, ts: m.ts, bytes: m.bytes, excerpt: String(m.excerpt ?? '') });
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  getSavedPage(id: string): { meta: SavedPage; text: string; file: string } | null {
    if (!safeId(id)) return null;
    const m = readJsonSync<any>(this.p('saved-pages', `${id}.json`), null);
    if (!m) return null;
    return { meta: { id: m.id, url: m.url, title: m.title, ts: m.ts, bytes: m.bytes }, text: String(m.text ?? ''), file: this.p('saved-pages', `${id}.html`) };
  }

  async deleteSavedPage(id: string): Promise<boolean> {
    if (!safeId(id)) return false;
    await fsp.rm(this.p('saved-pages', `${id}.html`), { force: true });
    await fsp.rm(this.p('saved-pages', `${id}.json`), { force: true });
    this.counts.page -= this.index.remove((d) => d.kind === 'page' && d.ref === id);
    return true;
  }

  async clearSavedPages(): Promise<void> {
    for (const f of await listFiles(this.p('saved-pages'))) await fsp.rm(path.join(this.p('saved-pages'), f), { force: true });
    await this.rebuildIndex();
  }

  // ---------------------------------------------------------------- downloads (metadata only; files are never touched)
  recordDownload(rec: DownloadRec): void {
    const isNew = !this.downloads.has(rec.id);
    this.downloads.set(rec.id, rec);
    // Progress ticks are not persisted; only start and final states are.
    if (isNew || rec.state !== 'progressing') void appendJsonl(this.p('downloads-metadata', 'downloads.jsonl'), rec);
    if (isNew) this.addDoc({ kind: 'download', ts: rec.ts, title: rec.filename, url: rec.url, snippet: rec.path, ref: rec.id });
  }

  listDownloads(): DownloadRec[] {
    return [...this.downloads.values()].sort((a, b) => b.ts - a.ts);
  }

  /** Forget download history. Downloaded files stay where they are. */
  async clearDownloads(id?: string): Promise<void> {
    await flushWrites();
    const file = this.p('downloads-metadata', 'downloads.jsonl');
    if (id) {
      this.downloads.delete(id);
      await rewriteJsonl<DownloadRec>(file, (r) => r.id !== id);
    } else {
      for (const d of [...this.downloads.values()]) if (d.state !== 'progressing') this.downloads.delete(d.id);
      await rewriteJsonl<DownloadRec>(file, (r) => this.downloads.has(r.id));
    }
    await this.rebuildIndex();
  }

  // ---------------------------------------------------------------- everything
  async clearAll(): Promise<void> {
    await flushWrites();
    for (const d of USER_DIRS) {
      await fsp.rm(this.p(d), { recursive: true, force: true });
      await fsp.mkdir(this.p(d), { recursive: true });
    }
    this.lastVisit = null;
    await this.rebuildIndex();
  }

  async stats(): Promise<MemoryStats> {
    await this.ready;
    let bytes = 0;
    for (const d of USER_DIRS) bytes += await dirSize(this.p(d));
    const marker = readJsonSync<{ at?: number }>(this.p('backups', 'last-backup.json'), {});
    return { root: this.root, indexedDocs: this.index.live, indexBuiltAt: this.indexBuiltAt, badLines: this.badLines, counts: { ...this.counts }, bytes, lastBackup: Number(marker.at) || 0 };
  }

  // ---------------------------------------------------------------- backup / export / import
  private async userFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(this.p(rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) await walk(r);
        else if (!e.name.endsWith('.tmp') && !e.name.includes('.corrupt-')) out.push(r);
      }
    };
    for (const d of USER_DIRS) await walk(d);
    return out;
  }

  /** Incremental backup: copies only files changed since the previous backup into backups/<stamp>/. */
  async backup(keep = 10): Promise<{ folder: string; files: number }> {
    await flushWrites();
    const marker = readJsonSync<{ at?: number }>(this.p('backups', 'last-backup.json'), {});
    const since = Number(marker.at) || 0;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const folder = this.p('backups', stamp);
    let files = 0;
    for (const rel of await this.userFiles()) {
      const src = this.p(rel);
      const st = await fsp.stat(src).catch(() => null);
      if (!st || st.mtimeMs <= since) continue;
      const dest = path.join(folder, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      files++;
    }
    await atomicWrite(this.p('backups', 'last-backup.json'), JSON.stringify({ at: Date.now(), folder: files ? stamp : null }));
    const all = (await fsp.readdir(this.p('backups'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) await fsp.rm(this.p('backups', old), { recursive: true, force: true });
    return { folder, files };
  }

  /** Write every memory file into one portable JSON bundle. */
  async exportTo(file: string): Promise<number> {
    await flushWrites();
    const files: Record<string, string> = {};
    for (const rel of await this.userFiles()) files[rel.split(path.sep).join('/')] = await fsp.readFile(this.p(rel), 'utf8');
    await atomicWrite(file, JSON.stringify({ format: 'raven-memory-export', version: 1, exportedAt: Date.now(), files }));
    return Object.keys(files).length;
  }

  /** Merge a bundle into this memory. JSONL logs are unioned line by line; other files are added if missing. */
  async importFrom(file: string): Promise<number> {
    const bundle = readJsonSync<any>(file, null);
    if (!bundle || bundle.format !== 'raven-memory-export' || typeof bundle.files !== 'object') throw new Error('Not a Raven memory export file.');
    await flushWrites();
    let n = 0;
    for (const [rel, content] of Object.entries(bundle.files as Record<string, unknown>)) {
      if (typeof content !== 'string') continue;
      const norm = path.normalize(rel);
      const top = norm.split(path.sep)[0];
      if (norm.startsWith('..') || path.isAbsolute(norm) || !USER_DIRS.includes(top)) continue; // never write outside memory folders
      const dest = this.p(norm);
      if (norm.endsWith('.jsonl')) {
        const have = new Set<string>(fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8').split(/\r?\n/).filter(Boolean) : []);
        const add = content.split(/\r?\n/).filter((l) => l.trim() && !have.has(l));
        if (add.length) {
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.appendFile(dest, add.join('\n') + '\n');
          n++;
        }
      } else if (norm === path.join('bookmarks', 'bookmarks.json')) {
        try {
          const incoming = JSON.parse(content);
          if (Array.isArray(incoming)) {
            const urls = new Set(this.bookmarks.map((b) => b.url));
            for (const b of incoming) if (b && typeof b.url === 'string' && typeof b.id === 'string' && !urls.has(b.url)) this.bookmarks.push(b);
            await this.saveBookmarks();
            n++;
          }
        } catch {
          /* skip */
        }
      } else if (!fs.existsSync(dest)) {
        await atomicWrite(dest, content);
        n++;
      }
    }
    await flushWrites();
    await this.rebuildIndex();
    return n;
  }

  flush(): Promise<void> {
    return flushWrites();
  }
}
