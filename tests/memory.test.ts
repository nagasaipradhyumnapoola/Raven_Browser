// Tests for the file-based browser memory. Everything is checked against the
// real files on disk; there is no database to inspect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore, appendJsonl, atomicWrite, flushWrites, readJsonl, readJsonSync, searchReference, REFERENCE } from '@raven/local-memory';
import { isBlockedAddress, isLanPeer, redact, TokenBucket, RateWindow, validateTarget, hashPin, verifyPin, pairingCode } from '@raven/security';
import { tmpDir } from './helpers';

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

test('memory: searches, visits, bookmarks, notes and AI conversations are found again after a restart', async () => {
  const root = tmpDir('raven-mem-');
  let m = new MemoryStore(root);
  await m.init();
  m.addSearch('binary search tree in C', 'Google');
  m.addVisit('https://www.geeksforgeeks.org/binary-search-tree-data-structure/', 'Binary Search Tree - GeeksforGeeks');
  m.addVisit('https://example.com/unrelated', 'Cooking pasta');
  m.addBookmark('https://en.cppreference.com/w/c', 'C reference');
  m.saveNote({ title: 'BST insert', url: 'https://example.com/bst', body: 'Remember: insert goes left when key is smaller.\n```c\nstruct Node *insert(struct Node *root, int key);\n```' });
  const conv = m.saveConversation({
    title: 'Linked list in C',
    messages: [
      { role: 'user', content: 'Write a C program for a linked list.', ts: Date.now() },
      { role: 'assistant', content: 'Here is a singly linked list:\n```c\ntypedef struct Node { int data; struct Node *next; } Node;\n```', ts: Date.now(), model: 'm1' },
    ],
  });
  await m.flush();

  // Simulate closing the browser and restarting the PC: brand-new object, same folder.
  m = new MemoryStore(root);
  await m.init();

  const hits = await m.search('binary search tree');
  const kinds = new Set(hits.map((h) => h.kind));
  assert.ok(kinds.has('search'), 'the search query is found');
  assert.ok(kinds.has('visit'), 'the visited page is found');
  assert.ok(!hits.some((h) => h.title.includes('pasta')));
  assert.equal((await m.search('bst insert'))[0].kind, 'note');
  assert.ok((await m.search('struct node')).some((h) => h.kind === 'chat' && h.ref === conv.id), 'saved code in an AI answer is found');
  assert.ok((await m.search('cppref')).some((h) => h.kind === 'bookmark'), 'prefix match on the last word');
  assert.equal(m.listBookmarks().length, 1);
  assert.equal(m.listConversations()[0].title, 'Linked list in C');
  assert.equal(m.getConversation(conv.id)?.messages.length, 2);
  assert.equal((await m.listHistory()).length, 2);
  assert.equal((await m.listSearches())[0].q, 'binary search tree in C');
  assert.equal((await m.listNotes())[0].title, 'BST insert');
});

test('memory: only ordinary text files are written, in a readable folder layout, and no database appears', async () => {
  const root = tmpDir('raven-mem-');
  const m = new MemoryStore(root);
  await m.init();
  m.addVisit('https://example.com/a', 'A');
  m.addSearch('hello', 'Google');
  m.addBookmark('https://example.com/a', 'A');
  m.saveNote({ title: 'n', body: 'note body' });
  m.saveConversation({ title: 'c', messages: [{ role: 'user', content: 'q', ts: 1 }] });
  await m.savePage({ url: 'https://example.com/a', title: 'A', html: '<html><body>saved</body></html>', text: 'saved' });
  m.recordDownload({ id: 'd1', ts: Date.now(), url: 'https://example.com/f.zip', filename: 'f.zip', path: 'C:/Downloads/f.zip', size: 10, received: 10, state: 'completed' });
  await m.flush();
  const files = allFiles(root).map((f) => path.relative(root, f).split(path.sep).join('/'));
  for (const f of files) {
    assert.match(f, /\.(jsonl|json|md|html|txt)$/, `unexpected file type: ${f}`);
    assert.doesNotMatch(f, /\.(db|sqlite|sqlite3|mdb|ldb|wal)$/i);
    const head = fs.readFileSync(path.join(root, f)).subarray(0, 16).toString('latin1');
    assert.ok(!head.startsWith('SQLite format'), `${f} is a database file`);
  }
  const month = new Date().toISOString().slice(0, 7);
  assert.ok(files.includes(`history/${month}.jsonl`));
  assert.ok(files.includes(`searches/${month}.jsonl`));
  assert.ok(files.includes('bookmarks/bookmarks.json'));
  assert.ok(files.includes('downloads-metadata/downloads.jsonl'));
  assert.ok(files.some((f) => f.startsWith('ai-conversations/') && f.endsWith('.json')));
  assert.ok(files.some((f) => f.startsWith('page-notes/') && f.endsWith('.md')));
  assert.ok(files.includes('memory-index/manifest.json'));
  // Human readable: a history line is plain JSON with url, title and timestamp.
  const line = JSON.parse(fs.readFileSync(path.join(root, 'history', `${month}.jsonl`), 'utf8').trim().split('\n')[0]);
  assert.equal(line.url, 'https://example.com/a');
  assert.ok(line.ts > 0 && line.title === 'A');
});

test('memory: the index is derived and can be deleted and rebuilt from the source files', async () => {
  const root = tmpDir('raven-mem-');
  let m = new MemoryStore(root);
  await m.init();
  for (let i = 0; i < 300; i++) m.addVisit(`https://example.com/page/${i}`, `Quantum widget number ${i}`, Date.now() - i * 60_000);
  await m.flush();
  fs.rmSync(path.join(root, 'memory-index'), { recursive: true, force: true });
  m = new MemoryStore(root);
  await m.init();
  assert.equal((await m.search('quantum widget', { limit: 200 })).length, 200);
  assert.ok(fs.existsSync(path.join(root, 'memory-index', 'manifest.json')));
  assert.equal((await m.stats()).counts.visit, 300);
});

test('memory: crash recovery — a torn last line and a corrupt JSON file do not lose the rest', async () => {
  const root = tmpDir('raven-mem-');
  let m = new MemoryStore(root);
  await m.init();
  m.addVisit('https://example.com/one', 'First good page');
  m.addBookmark('https://example.com/one', 'One');
  await m.flush();
  const month = new Date().toISOString().slice(0, 7);
  const hist = path.join(root, 'history', `${month}.jsonl`);
  // Power loss in the middle of an append: half a record, no newline.
  fs.appendFileSync(hist, '{"ts":123,"url":"https://exa');
  // A conversation file that was damaged.
  fs.writeFileSync(path.join(root, 'ai-conversations', 'broken123.json'), '{"id":"broken123","messages":[{');
  m = new MemoryStore(root);
  await m.init();
  m.addVisit('https://example.com/two', 'Second good page');
  await m.flush();
  const list = await m.listHistory();
  assert.deepEqual(list.map((r) => r.title), ['Second good page', 'First good page']);
  assert.ok((await m.stats()).badLines >= 1, 'the torn line is counted, not fatal');
  assert.equal(m.listBookmarks().length, 1);
  assert.equal(m.listConversations().length, 0);
  assert.ok(fs.readdirSync(path.join(root, 'ai-conversations')).some((f) => f.includes('.corrupt-')), 'the damaged file is kept aside, not deleted');
  // The repaired append did not glue the new record onto the torn one.
  const lines = fs.readFileSync(hist, 'utf8').split('\n').filter(Boolean);
  assert.equal(JSON.parse(lines[lines.length - 1]).title, 'Second good page');
});

test('memory: separate deletion controls; deleting history never deletes downloaded files', async () => {
  const root = tmpDir('raven-mem-');
  const m = new MemoryStore(root);
  await m.init();
  const downloaded = path.join(tmpDir('raven-dl-'), 'report.pdf');
  fs.writeFileSync(downloaded, 'PDF BYTES');
  m.addVisit('https://example.com/a', 'Alpha page');
  m.addVisit('https://example.com/b', 'Beta page');
  m.addSearch('alpha query', 'Google');
  m.addBookmark('https://example.com/a', 'Alpha bookmark');
  m.saveNote({ title: 'Alpha note', body: 'x' });
  const c = m.saveConversation({ title: 'Alpha chat', messages: [{ role: 'user', content: 'alpha question', ts: 1 }] });
  m.recordDownload({ id: 'd1', ts: Date.now(), url: 'https://example.com/report.pdf', filename: 'report.pdf', path: downloaded, size: 9, received: 9, state: 'completed' });
  await m.flush();

  assert.equal(await m.clearHistory({ url: 'https://example.com/b' }), 1);
  assert.deepEqual((await m.listHistory()).map((r) => r.url), ['https://example.com/a']);
  await m.clearHistory();
  assert.equal((await m.listHistory()).length, 0);
  assert.ok(!(await m.search('alpha')).some((h) => h.kind === 'visit'));
  assert.ok((await m.search('alpha')).some((h) => h.kind === 'search'), 'search history is separate');
  await m.clearSearches();
  assert.equal((await m.listSearches()).length, 0);
  assert.ok((await m.search('alpha')).some((h) => h.kind === 'chat'));
  await m.deleteConversation(c.id);
  assert.ok(!(await m.search('alpha')).some((h) => h.kind === 'chat'));
  await m.clearNotes();
  assert.ok(!(await m.search('alpha')).some((h) => h.kind === 'note'));
  await m.clearDownloads();
  assert.equal(m.listDownloads().length, 0);
  assert.equal(fs.readFileSync(downloaded, 'utf8'), 'PDF BYTES', 'the downloaded file itself is untouched');
  assert.ok((await m.search('alpha')).some((h) => h.kind === 'bookmark'), 'bookmarks survive history deletion');
  await m.clearAll();
  assert.equal((await m.search('alpha')).length, 0);
  assert.equal(fs.readFileSync(downloaded, 'utf8'), 'PDF BYTES');
});

test('memory: incremental backup, export and import', async () => {
  const root = tmpDir('raven-mem-');
  const m = new MemoryStore(root);
  await m.init();
  m.addVisit('https://example.com/a', 'Page A');
  m.addBookmark('https://example.com/a', 'A');
  await m.flush();
  const b1 = await m.backup();
  assert.ok(b1.files >= 2);
  const b2 = await m.backup();
  assert.equal(b2.files, 0, 'nothing changed, nothing copied');
  await new Promise((r) => setTimeout(r, 30));
  m.saveNote({ title: 'later', body: 'added after the first backup' });
  await m.flush();
  const b3 = await m.backup();
  assert.equal(b3.files, 1, 'only the changed file is copied');

  const bundle = path.join(tmpDir('raven-exp-'), 'memory.ravenexport.json');
  assert.ok((await m.exportTo(bundle)) >= 3);

  const other = new MemoryStore(tmpDir('raven-mem2-'));
  await other.init();
  other.addVisit('https://example.com/z', 'Page Z');
  await other.flush();
  await other.importFrom(bundle);
  const urls = (await other.listHistory()).map((r) => r.url).sort();
  assert.deepEqual(urls, ['https://example.com/a', 'https://example.com/z'], 'import merges, it does not overwrite');
  assert.equal(other.listBookmarks().length, 1);
  await other.importFrom(bundle);
  assert.equal((await other.listHistory()).length, 2, 'importing twice does not duplicate');

  // A hostile bundle cannot write outside the memory folders.
  const evil = path.join(tmpDir('raven-evil-'), 'evil.json');
  fs.writeFileSync(evil, JSON.stringify({ format: 'raven-memory-export', version: 1, files: { '../../escape.txt': 'x', 'settings.json': '{}', 'history/../../up.jsonl': '{}' } }));
  await other.importFrom(evil);
  assert.ok(!fs.existsSync(path.join(other.root, '..', '..', 'escape.txt')));
  assert.ok(!fs.existsSync(path.join(other.root, '..', 'up.jsonl')));
});

test('memory: large history stays bounded and search stays fast', async () => {
  const root = tmpDir('raven-mem-');
  fs.mkdirSync(path.join(root, 'history'), { recursive: true });
  // 90,000 visits spread over three months, written straight to disk.
  const base = Date.UTC(2026, 8, 1);
  for (let mth = 0; mth < 3; mth++) {
    const lines: string[] = [];
    for (let i = 0; i < 30_000; i++) {
      const ts = base + mth * 30 * 86_400_000 + i * 60_000;
      lines.push(JSON.stringify({ ts, url: `https://site${i % 500}.example/item/${mth}-${i}`, title: `Article ${mth}-${i} about ${i % 7 === 0 ? 'ravens' : 'crows'}` }));
    }
    fs.writeFileSync(path.join(root, 'history', `2026-${String(9 + mth).padStart(2, '0')}.jsonl`), lines.join('\n') + '\n');
  }
  const before = process.memoryUsage().heapUsed;
  const m = new MemoryStore(root);
  const t0 = Date.now();
  await m.init();
  const buildMs = Date.now() - t0;
  const st = await m.stats();
  assert.equal(st.indexedDocs, 60_000, 'index is capped');
  const t1 = Date.now();
  for (let i = 0; i < 50; i++) await m.search('article ravens');
  const perSearch = (Date.now() - t1) / 50;
  const heapMb = (process.memoryUsage().heapUsed - before) / 1e6;
  console.log(`      measured: index build ${buildMs} ms for 90k records, ${perSearch.toFixed(1)} ms per search, +${heapMb.toFixed(0)} MB heap`);
  assert.ok(perSearch < 150, `search took ${perSearch} ms`);
  assert.ok(heapMb < 400, `index used ${heapMb} MB`);
  // Old data beyond the cap is still reachable with a deep search over the files.
  const deep = await m.search('article 0-5 ', { deep: true, limit: 5 });
  assert.ok(deep.length > 0);
  assert.equal((await m.listHistory({ limit: 10 })).length, 10);
});

test('file helpers: atomic writes never leave a half-written file; concurrent appends do not interleave', async () => {
  const dir = tmpDir('raven-fs-');
  const f = path.join(dir, 'state.json');
  await Promise.all(Array.from({ length: 40 }, (_, i) => atomicWrite(f, JSON.stringify({ n: i, pad: 'x'.repeat(5000) }))));
  assert.equal(typeof readJsonSync<{ n: number }>(f, { n: -1 }).n, 'number');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
  const log = path.join(dir, 'log.jsonl');
  await Promise.all(Array.from({ length: 500 }, (_, i) => appendJsonl(log, { i, text: 'y'.repeat(200) })));
  await flushWrites();
  let n = 0;
  const res = await readJsonl<{ i: number }>(log, () => void n++);
  assert.equal(n, 500);
  assert.equal(res.bad, 0);
});

test('offline programming reference: works with no network and covers the required topics', () => {
  assert.ok(REFERENCE.length >= 40);
  for (const lang of ['Python', 'Java', 'C', 'C++', 'JavaScript', 'Data structures', 'Errors', 'Examples']) {
    assert.ok(REFERENCE.some((r) => r.lang === lang), `has ${lang}`);
  }
  assert.equal(searchReference('linked list in C')[0].entry.id, 'c-linked-list');
  assert.equal(searchReference('recursion python')[0].entry.id, 'py-recursion');
  assert.equal(searchReference('binary search tree')[0].entry.id, 'ds-bst');
  assert.equal(searchReference('html login page')[0].entry.id, 'ex-html-login');
  assert.equal(searchReference('javascript calculator')[0].entry.id, 'ex-js-calculator');
  assert.ok(searchReference('NullPointerException')[0].entry.id === 'err-java');
  assert.ok(searchReference('segmentation fault')[0].entry.id === 'err-c');
  assert.ok(searchReference('', 'Java').every((h) => h.entry.lang === 'Java'));
});

test('security primitives: address guard, target validation, limits, PIN, redaction', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'ff02::1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
  }
  assert.equal(isLanPeer('192.168.1.20'), true);
  assert.equal(isLanPeer('::ffff:10.0.0.4'), true);
  assert.equal(isLanPeer('8.8.8.8'), false);
  assert.equal(validateTarget('example.com', 443).ok, true);
  assert.equal(validateTarget('localhost', 80).ok, false);
  assert.equal(validateTarget('router.local', 80).ok, false);
  assert.equal(validateTarget('example.com', 25).ok, false);
  assert.equal(validateTarget('exa mple.com', 80).ok, false);
  assert.equal(validateTarget('a'.repeat(300), 80).ok, false);
  assert.equal(validateTarget('example.com', 0).ok, false);

  let now = 0;
  const b = new TokenBucket(1000, 1000, () => now);
  assert.equal(b.take(1000), 0);
  assert.equal(b.take(500), 500, 'half a second of debt');
  now += 2000;
  assert.equal(b.take(100), 0);
  const w = new RateWindow(() => now);
  w.record();
  now += 61_000;
  w.record();
  assert.deepEqual(w.usage(), { minute: 1, hour: 2, day: 2 });

  const h = hashPin('1234');
  assert.ok(verifyPin('1234', h));
  assert.ok(!verifyPin('1235', h));
  assert.ok(!h.includes('1234'));
  assert.match(pairingCode('ab'.repeat(32), 'cHVibGlj'), /^\d{6}$/);
  assert.notEqual(pairingCode('ab'.repeat(32), 'cHVibGlj'), pairingCode('ac'.repeat(32), 'cHVibGlj'));

  const line = redact('calling with Authorization: Bearer freellmapi-abcdef1234567890 and api_key=sk-proj-AAAABBBBCCCCDDDD1234 done');
  assert.ok(!line.includes('abcdef1234567890'));
  assert.ok(!line.includes('AAAABBBBCCCCDDDD1234'));
});
