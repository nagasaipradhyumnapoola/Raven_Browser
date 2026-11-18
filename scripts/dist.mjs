// Packages the two apps for the platform this runs on.
//   Windows: node scripts/dist.mjs  ->  dist/MasterServer.exe, dist/RavenBrowser.exe (portable), dist/SHA256SUMS.txt
//   macOS:   node scripts/dist.mjs  ->  dist/MasterServer-mac-<arm64|x64>.dmg, dist/RavenBrowser-mac-<arm64|x64>.dmg, dist/SHA256SUMS.txt
import { build as ebuild, Platform, Arch } from 'electron-builder';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = pkg.devDependencies.electron;
const dist = path.join(root, 'dist');

execSync('node scripts/bundle-freellm.mjs', { cwd: root, stdio: 'inherit' });
execSync('node scripts/build.mjs', { cwd: root, stdio: 'inherit' });
execSync('node scripts/notices.mjs', { cwd: root, stdio: 'inherit' });
fs.mkdirSync(dist, { recursive: true });
const mac = process.platform === 'darwin';
// Apple Silicon or Intel: the build matches the Mac it runs on.
const macArch = process.arch === 'arm64' ? 'arm64' : 'x64';

// macOS wants a 512px+ icon; scale the logo once (sharp is already a dependency of the bundled FreeLLMAPI).
let macIcon = path.join(root, 'assets', 'icon.png');
if (mac) {
  try {
    const sharp = (await import('sharp')).default;
    macIcon = path.join(root, 'stage', 'icon-1024.png');
    fs.mkdirSync(path.dirname(macIcon), { recursive: true });
    await sharp(path.join(root, 'assets', 'raven-logo.png')).resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(macIcon);
  } catch (e) {
    console.warn('could not make the macOS icon, using the default:', e.message);
  }
}

async function pack(app, exe, appId, productName, extra = {}) {
  const out = path.join(root, 'stage', app);
  fs.rmSync(out, { recursive: true, force: true });
  await ebuild({
    targets: mac ? Platform.MAC.createTarget(['dmg'], macArch === 'arm64' ? Arch.arm64 : Arch.x64) : Platform.WINDOWS.createTarget(['portable'], Arch.x64),
    publish: 'never',
    config: {
      appId,
      productName,
      copyright: 'Raven',
      electronVersion,
      electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
      directories: { app: path.join(root, 'build', app), output: out, buildResources: path.join(root, 'assets') },
      // Everything the apps need is already bundled by esbuild; only FreeLLMAPI's native image module ships as a package.
      files: ['**/*', '!node_modules{,/**/*}', 'freellm/node_modules/**/*'],
      afterPack: async (ctx) => {
        // Electron's sample app is not part of Raven.
        fs.rmSync(path.join(ctx.appOutDir, 'resources', 'default_app.asar'), { force: true });
        fs.rmSync(path.join(ctx.appOutDir, `${productName}.app`, 'Contents', 'Resources', 'default_app.asar'), { force: true });
      },
      asar: true,
      compression: 'normal',
      extraResources: [{ from: path.join(root, 'docs', 'THIRD-PARTY-NOTICES.txt'), to: 'THIRD-PARTY-NOTICES.txt' }],
      win: {
        icon: path.join(root, 'assets', 'icon.ico'),
        artifactName: `${exe}.exe`,
        requestedExecutionLevel: 'asInvoker',
      },
      // No fixed unpack folder: every build unpacks into its own folder, so an older copy still running can never hide a new version.
      portable: { artifactName: `${exe}.exe` },
      // Unsigned: on first open, right-click the app and choose Open (see docs/SETUP-AND-USE.md).
      // Ad-hoc signature ('-'): no Apple developer account needed, and Apple Silicon Macs will run it after "Open anyway".
      mac: { icon: macIcon, category: 'public.app-category.productivity', identity: '-', hardenedRuntime: false, gatekeeperAssess: false, artifactName: `${exe}-mac-${macArch}.\${ext}` },
      dmg: { artifactName: `${exe}-mac-${macArch}.\${ext}` },
      ...extra,
    },
  });
  const files = mac ? [`${exe}-mac-${macArch}.dmg`] : [`${exe}.exe`];
  for (const f of files) {
    const built = path.join(out, f);
    if (!fs.existsSync(built)) continue;
    fs.copyFileSync(built, path.join(dist, f));
    console.log(`packed ${f} (${(fs.statSync(built).size / 1e6).toFixed(1)} MB)`);
  }
}

await pack('master-server', 'MasterServer', 'app.raven.masterserver', 'Raven Master Server', { asarUnpack: ['freellm/**'] });
await pack('raven-browser', 'RavenBrowser', 'app.raven.browser', 'Raven Browser');

const lines = [];
for (const f of mac ? [`MasterServer-mac-${macArch}.dmg`, `RavenBrowser-mac-${macArch}.dmg`] : ['MasterServer.exe', 'RavenBrowser.exe']) {
  if (!fs.existsSync(path.join(dist, f))) continue;
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex');
  lines.push(`${h}  ${f}`);
}
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
