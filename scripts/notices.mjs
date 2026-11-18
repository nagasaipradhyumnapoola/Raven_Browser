// Writes docs/THIRD-PARTY-NOTICES.txt from the packages that are actually
// bundled (esbuild metafiles) plus the runtime pieces shipped beside them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgs = new Map();

function pkgDirOf(file) {
  const norm = file.split(path.sep).join('/');
  const i = norm.lastIndexOf('node_modules/');
  if (i < 0) return null;
  const rest = norm.slice(i + 13).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return path.join(norm.slice(0, i + 13), name);
}

function addDir(dir, origin) {
  const abs = path.isAbsolute(dir) ? dir : path.join(root, dir);
  const pj = path.join(abs, 'package.json');
  if (!fs.existsSync(pj)) return;
  const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
  const key = `${p.name}@${p.version}`;
  if (pkgs.has(key)) return pkgs.get(key).origins.add(origin);
  const lic = fs.readdirSync(abs).find((f) => /^(licen[sc]e|copying|notice)/i.test(f));
  pkgs.set(key, {
    name: p.name,
    version: p.version,
    license: typeof p.license === 'string' ? p.license : p.license?.type ?? 'see package',
    text: lic ? fs.readFileSync(path.join(abs, lic), 'utf8').trim() : '',
    origins: new Set([origin]),
  });
}

for (const [meta, origin] of [['meta-master-server.json', 'MasterServer.exe'], ['meta-raven-browser.json', 'RavenBrowser.exe'], ['meta-freellm.json', 'MasterServer.exe (FreeLLMAPI)'], ['meta-master-headless.json', 'RavenMaster.apk']]) {
  const f = path.join(root, 'build', meta);
  if (!fs.existsSync(f)) continue;
  for (const input of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    const d = pkgDirOf(path.resolve(root, input));
    if (d) addDir(d, origin);
  }
}
for (const m of ['sharp', '@img/colour', `@img/sharp-${process.platform}-${process.arch}`, 'detect-libc', 'semver']) if (fs.existsSync(path.join(root, 'node_modules', m))) addDir(path.join(root, 'node_modules', m), 'MasterServer (FreeLLMAPI image support)');
addDir(path.join(root, 'node_modules', 'electron'), 'both (Electron runtime, includes Chromium and Node.js)');

let out = `Raven Browser and Raven Master Server - third-party notices
Generated ${new Date().toISOString().slice(0, 10)} from the files actually bundled into the release.

FreeLLMAPI (https://github.com/tashfeenahmed/freellmapi) is included unmodified in
MasterServer.exe under the MIT License; its own license text follows below.
Electron bundles Chromium and Node.js; their licenses are in the LICENSES.chromium.html
file that ships inside each executable's runtime folder.
The fonts (Anton, JetBrains Mono, Space Grotesk, Permanent Marker) are used under the
SIL Open Font License 1.1 or Apache License 2.0 as stated in their packages.
The world map on the new tab page is drawn from Natural Earth land data (public domain).
The Android app (RavenMaster.apk) embeds Node.js from nodejs-mobile (MIT, license below; Node.js's
own licenses are inside libnode).

`;
const vendorLic = path.join(root, 'vendor', 'freellmapi', 'LICENSE');
if (fs.existsSync(vendorLic)) out += `==== FreeLLMAPI (MIT) ====\n${fs.readFileSync(vendorLic, 'utf8').trim()}\n\n`;
const nmLic = path.join(root, 'vendor', 'nodejs-mobile', 'package', 'LICENSE');
if (fs.existsSync(nmLic)) out += `==== nodejs-mobile (MIT) ====\n${fs.readFileSync(nmLic, 'utf8').trim()}\n\n`;
const list = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name));
out += `==== Package list (${list.length}) ====\n`;
for (const p of list) out += `${p.name} ${p.version}  ${p.license}  [${[...p.origins].join(', ')}]\n`;
out += `\n==== License texts ====\n`;
for (const p of list) if (p.text) out += `\n---- ${p.name} ${p.version} (${p.license}) ----\n${p.text}\n`;
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'THIRD-PARTY-NOTICES.txt'), out);
console.log(`notices: ${list.length} packages`);
