// Builds both Electron apps (and optionally the test bundles) with esbuild.
//   node scripts/build.mjs            -> build/master-server, build/raven-browser
//   node scripts/build.mjs --tests    -> also build/tests/*.test.cjs
// Each app also gets build/meta-<app>.json: the exact list of bundled source
// files, used by scripts/notices.mjs to produce third-party license notices.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
const withTests = process.argv.includes('--tests');
const onlyTests = process.argv.includes('--only-tests');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = pkg.devDependencies.electron;

const common = {
  bundle: true,
  metafile: true,
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  tsconfig: path.join(root, 'tsconfig.json'),
  define: { 'process.env.RAVEN_VERSION': JSON.stringify(pkg.version) },
};

const nodeExternal = ['electron', 'bufferutil', 'utf-8-validate'];

async function bundle(opts, inputs) {
  const r = await build({ ...common, ...opts, define: { ...common.define, ...(opts.define ?? {}) } });
  if (inputs) for (const k of Object.keys(r.metafile.inputs)) inputs.add(k);
}

async function buildApp(name, productName, exeName, extra = {}) {
  const src = path.join(root, 'apps', name, 'src');
  if (!fs.existsSync(path.join(src, 'main', 'main.ts'))) {
    console.log(`skipped ${name} (no sources yet)`);
    return;
  }
  const dest = path.join(out, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'renderer'), { recursive: true });
  const inputs = new Set();

  await bundle({ entryPoints: [path.join(src, 'main', 'main.ts')], platform: 'node', format: 'cjs', target: 'node22', external: nodeExternal, outfile: path.join(dest, 'main.cjs') }, inputs);
  // Every preload*.ts becomes its own sandbox-safe CommonJS file.
  for (const f of fs.readdirSync(path.join(src, 'main')).filter((n) => /^preload.*\.ts$/.test(n))) {
    await bundle({ entryPoints: [path.join(src, 'main', f)], platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: path.join(dest, f.replace(/\.ts$/, '.cjs')) }, inputs);
  }
  await bundle(
    {
      entryPoints: [path.join(src, 'renderer', 'index.tsx')],
      platform: 'browser',
      format: 'iife',
      target: 'chrome130',
      jsx: 'automatic',
      minify: true,
      outfile: path.join(dest, 'renderer', 'app.js'),
      loader: { '.woff2': 'file', '.woff': 'file', '.png': 'file', '.svg': 'file', '.jpg': 'file' },
      assetNames: 'assets/[name]-[hash]',
      define: { 'process.env.NODE_ENV': '"production"' },
    },
    inputs,
  );
  fs.copyFileSync(path.join(src, 'renderer', 'index.html'), path.join(dest, 'renderer', 'index.html'));
  fs.copyFileSync(path.join(root, 'assets', 'raven-logo.png'), path.join(dest, 'icon.png'));
  if (extra.copy) extra.copy(dest);
  fs.writeFileSync(
    path.join(dest, 'package.json'),
    JSON.stringify({ name, productName, version: pkg.version, description: productName, author: 'Raven', license: 'MIT', main: 'main.cjs', ravenExe: exeName, ravenElectron: electronVersion }, null, 2),
  );
  fs.writeFileSync(path.join(out, `meta-${name}.json`), JSON.stringify([...inputs].sort(), null, 1));
  console.log(`built ${name}`);
}

async function buildTests() {
  const dir = path.join(root, 'tests');
  const dest = path.join(out, 'tests');
  fs.rmSync(dest, { recursive: true, force: true });
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
  for (const f of entries) {
    await bundle({ entryPoints: [path.join(dir, f)], platform: 'node', format: 'cjs', target: 'node22', external: nodeExternal, outfile: path.join(dest, f.replace(/\.ts$/, '.cjs')) });
  }
  console.log(`built ${entries.length} test bundle(s)`);
}

if (!onlyTests) {
  await buildApp('master-server', 'Raven Master Server', 'MasterServer', {
    copy: (dest) => {
      // Bundled FreeLLMAPI (built by scripts/bundle-freellm.mjs).
      const fl = path.join(out, 'freellm');
      if (fs.existsSync(fl)) fs.cpSync(fl, path.join(dest, 'freellm'), { recursive: true });
    },
  });
  await buildApp('raven-browser', 'Raven Browser', 'RavenBrowser');
  await buildHeadless();
}
if (withTests || onlyTests) await buildTests();

/** The master without a window (Android app, Termux, Linux): one Node.js file plus the dashboard files. */
async function buildHeadless() {
  const dest = path.join(out, 'master-headless');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const inputs = new Set();
  await bundle(
    {
      entryPoints: [path.join(root, 'apps', 'master-server', 'src', 'headless', 'main.ts')],
      platform: 'node',
      format: 'cjs',
      // nodejs-mobile on Android ships Node 18.
      target: 'node18',
      external: ['electron', 'bufferutil', 'utf-8-validate'],
      outfile: path.join(dest, 'raven-master.cjs'),
    },
    inputs,
  );
  fs.cpSync(path.join(out, 'master-server', 'renderer'), path.join(dest, 'renderer'), { recursive: true });
  fs.writeFileSync(path.join(out, 'meta-master-headless.json'), JSON.stringify([...inputs].sort(), null, 1));
  console.log('built master-headless');
}
