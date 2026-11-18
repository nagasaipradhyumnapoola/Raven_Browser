// Publishes a GitHub Release with the downloadable files and the one-click bundle.
//   node scripts/release.mjs <owner/repo> <tag> <file>...
// Uses the GitHub login already saved for git on this computer (Git Credential Manager); it is never printed
// and never put on a command line.
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
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
};

/** Big uploads go through curl (no response-time limit); the login is handed over on stdin. */
function curlUpload(url, file) {
  const headers = ['Authorization: Bearer ' + token, 'Accept: application/vnd.github+json', 'User-Agent: raven-release', ''].join('\n');
  const r = spawnSync('curl', ['-sS', '-X', 'POST', '-H', '@-', '-H', 'Content-Type: application/octet-stream', '--data-binary', '@' + file, '--max-time', '1800', '-w', '\n%{http_code}', url], {
    input: headers,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error('curl: ' + String(r.stderr || '').trim().slice(0, 200));
  const out = String(r.stdout);
  const i = out.lastIndexOf('\n');
  const status = Number(out.slice(i + 1));
  let data = null;
  try {
    data = JSON.parse(out.slice(0, i));
  } catch {
    data = null;
  }
  return { status, data };
}

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

for (const f of files) {
  const name = path.basename(f);
  const size = fs.statSync(f).size;
  const t0 = Date.now();
  let up = null;
  // Try up to 3 times; a half-finished upload can leave a broken asset with the same name, so clear it first.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const now = await api('GET', `/repos/${repo}/releases/${id}/assets?per_page=100`);
    const old = (Array.isArray(now.data) ? now.data : []).find((a) => a.name === name);
    if (old) await api('DELETE', `/repos/${repo}/releases/assets/${old.id}`);
    console.log(`uploading ${name} (${(size / 1e6).toFixed(1)} MB), attempt ${attempt}`);
    try {
      up = curlUpload(`https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, f);
      if (up.status < 300) break;
      console.log(`  HTTP ${up.status} ${up.data?.message ?? ''}`);
    } catch (e) {
      console.log(`  ${e.message}`);
    }
    up = null;
  }
  if (!up) throw new Error(`Upload of ${name} failed after 3 attempts.`);
  console.log(`uploaded ${name} in ${Math.round((Date.now() - t0) / 1000)} s -> ${up.data.browser_download_url}`);
}
