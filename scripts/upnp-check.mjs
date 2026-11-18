// Live check of automatic router port forwarding (UPnP) against the real router of this network.
// Maps a throwaway port to a dummy listener, reports what the router said, then removes the mapping.
// The public address itself is never printed.
//   node scripts/upnp-check.mjs
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'upnp-check.cjs');
execFileSync(process.execPath, [path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), path.join(root, 'apps', 'master-server', 'src', 'core', 'upnp.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error', `--tsconfig=${path.join(root, 'tsconfig.json')}`]);
const { PortMapper } = createRequire(import.meta.url)(out);

const server = net.createServer((s) => s.end());
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const port = server.address().port;
const mapper = new PortMapper(() => {});
const t0 = Date.now();
await mapper.enable(port);
while (mapper.status.state === 'searching' && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 250));
const st = mapper.status;
const ip = st.externalIp;
const kind = !ip ? 'none' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) ? 'private (shared by the provider)' : 'public';
console.log(JSON.stringify({ router: st.state, publicAddress: kind, error: st.error, tookMs: Date.now() - t0 }));
const leftWhileOn = await mapper.stillMapped(port);
await mapper.disable();
console.log(JSON.stringify({ afterRemove: mapper.status.state, mappingLeftOnRouter: await mapper.stillMapped(port), mappingWhileOn: leftWhileOn }));
server.close();
