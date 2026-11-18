// Publishes a GitHub Release with the downloadable files and the one-click bundle.
//   node scripts/release.mjs <owner/repo> <tag> <file>...
// Uses the GitHub login already saved for git on this computer (Git Credential Manager); it is never printed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [repo, tag, ...files] = process.argv.slice(2);
if (!repo || !tag || !files.length) throw new Error('usage: node scripts/release.mjs <owner/repo> <tag> <file>...');
const cred = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const token = /^password=(.+)$/m.exec(cred.stdout ?? '')?.[1];
if (!token) throw new Error('No saved GitHub login for git on this computer.');
const api = async (method, url, body, headers = {}) => {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'raven-release', ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
};

const notes = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-notes.md'), 'utf8');
let rel = await api('GET', `/repos/${repo}/releases/tags/${tag}`);
if (rel.status === 404) {
  rel = await api('POST', `/repos/${repo}/releases`, JSON.stringify({ tag_name: tag, target_commitish: 'main', name: `Raven ${tag}`, body: notes, make_latest: 'true' }), { 'Content-Type': 'application/json' });
} else if (rel.status === 200) {
  rel = await api('PATCH', `/repos/${repo}/releases/${rel.data.id}`, JSON.stringify({ body: notes, make_latest: 'true' }), { 'Content-Type': 'application/json' });
}
if (rel.status >= 300) throw new Error(`Could not create the release: HTTP ${rel.status} ${rel.data?.message ?? ''}`);
const id = rel.data.id;
console.log(`release ${tag}: ${rel.data.html_url}`);

const existing = await api('GET', `/repos/${repo}/releases/${id}/assets?per_page=100`);
for (const f of files) {
  const name = path.basename(f);
  const old = (existing.data ?? []).find((a) => a.name === name);
  if (old) await api('DELETE', `/repos/${repo}/releases/assets/${old.id}`);
  const buf = fs.readFileSync(f);
  const t0 = Date.now();
  const up = await api('POST', `https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, buf, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) });
  if (up.status >= 300) throw new Error(`Upload of ${name} failed: HTTP ${up.status} ${up.data?.message ?? ''}`);
  console.log(`uploaded ${name} (${(buf.length / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)} s) -> ${up.data.browser_download_url}`);
}
