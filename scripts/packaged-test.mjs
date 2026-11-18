// Runs tests/packaged/packaged-check.ts against dist/MasterServer.exe and dist/RavenBrowser.exe.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'packaged-check.cjs');
await build({
  entryPoints: [path.join(root, 'tests', 'packaged', 'packaged-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: out,
  tsconfig: path.join(root, 'tsconfig.json'),
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, [out, root], { stdio: 'inherit' });
process.exit(r.status ?? 1);
