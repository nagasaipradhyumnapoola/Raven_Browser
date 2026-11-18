// Bundles the real FreeLLMAPI server (vendor/freellmapi, pinned commit) plus
// its built dashboard into build/freellm/ for embedding in MasterServer.exe.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor', 'freellmapi');
const out = path.join(root, 'build', 'freellm');
if (!fs.existsSync(path.join(vendor, 'server', 'src', 'app.ts'))) {
  console.error(
    'vendor/freellmapi is missing. Run:\n  git clone https://github.com/tashfeenahmed/freellmapi vendor/freellmapi\n  cd vendor/freellmapi && npm ci --ignore-scripts',
  );
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: vendor }).toString().trim();
} catch {
  /* not a git checkout */
}

const res = await build({
  metafile: true,
  entryPoints: [path.join(root, 'apps', 'master-server', 'src', 'freellm-host', 'host.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(out, 'server.mjs'),
  // sharp is a prebuilt N-API module shipped beside the bundle; better-sqlite3 is never loaded (node:sqlite is used).
  external: ['better-sqlite3', 'sharp'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

fs.writeFileSync(path.join(root, 'build', 'meta-freellm.json'), JSON.stringify(Object.keys(res.metafile.inputs).sort(), null, 1));

// FreeLLMAPI's own dashboard (provider keys, routing, analytics) is reused as-is.
const clientDist = path.join(vendor, 'client', 'dist');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  fs.cpSync(clientDist, path.join(out, 'client'), { recursive: true });
} else {
  console.warn('WARNING: vendor/freellmapi/client/dist is not built; the embedded provider dashboard will be unavailable. Run `npx vite build` in vendor/freellmapi/client.');
}
// sharp (image resizing for vision requests) is loaded on demand by FreeLLMAPI; ship the build for this platform beside the bundle.
const nm = path.join(root, 'node_modules');
const plat = `${process.platform}-${process.arch}`;
const native = [`@img/sharp-${plat}`, ...(process.platform === 'win32' ? [] : [`@img/sharp-libvips-${plat}`])];
for (const mod of ['sharp', '@img/colour', ...native, 'detect-libc', 'semver']) {
  const src = path.join(nm, mod);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, 'node_modules', mod), { recursive: true });
  else console.warn(`WARNING: ${mod} not installed; image resizing in FreeLLMAPI will be disabled.`);
}
fs.copyFileSync(path.join(vendor, 'LICENSE'), path.join(out, 'FREELLMAPI-LICENSE.txt'));
fs.writeFileSync(
  path.join(out, 'VERSION.json'),
  JSON.stringify({ project: 'https://github.com/tashfeenahmed/freellmapi', commit, license: 'MIT' }, null, 2),
);
console.log(`bundled FreeLLMAPI @ ${commit.slice(0, 10)} -> build/freellm (${(fs.statSync(path.join(out, 'server.mjs')).size / 1e6).toFixed(1)} MB)`);
