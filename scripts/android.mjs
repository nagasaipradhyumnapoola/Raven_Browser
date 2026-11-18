// Builds the Android master app (Raven Master): headless master + nodejs-mobile + WebView dashboard.
//   node scripts/android.mjs            -> dist/RavenMaster.apk (release, signed with a local key) + build/android/RavenMaster-debug.apk
// Needs: Android SDK (ANDROID_HOME), NDK 27.1, CMake 3.22.1, and vendor/nodejs-mobile (see docs/BUILDING.md).
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proj = path.join(root, 'apps', 'master-android');
const main = path.join(proj, 'app', 'src', 'main');
const libnode = path.join(root, 'vendor', 'nodejs-mobile', 'package', 'android', 'libnode');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const win = process.platform === 'win32';

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
if (!fs.existsSync(sdk)) throw new Error(`Android SDK not found (${sdk}). Set ANDROID_HOME.`);
if (!fs.existsSync(path.join(libnode, 'bin'))) {
  throw new Error('vendor/nodejs-mobile is missing. Run:\n  cd vendor/nodejs-mobile && npm pack nodejs-mobile-react-native@18.20.4 && tar -xzf nodejs-mobile-react-native-18.20.4.tgz package/android/libnode');
}
// Gradle 8.x needs Java 17 or 21 (newer Android Studio ships Java 25).
const jdkCandidates = [];
const gjdks = path.join(os.homedir(), '.gradle', 'jdks');
if (fs.existsSync(gjdks)) for (const d of fs.readdirSync(gjdks)) if (/-(21|17)-/.test(d) && fs.existsSync(path.join(gjdks, d, 'bin'))) jdkCandidates.push(path.join(gjdks, d));
for (const base of ['C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java', 'C:/Program Files/Microsoft', '/Library/Java/JavaVirtualMachines']) {
  if (fs.existsSync(base)) for (const d of fs.readdirSync(base)) if (/(^|-)(21|17)[.+]/.test(d)) jdkCandidates.push(path.join(base, d, process.platform === 'darwin' ? 'Contents/Home' : ''));
}
const javaHome = process.env.JAVA_HOME_ANDROID || jdkCandidates.find((p) => fs.existsSync(path.join(p, 'bin')));
if (!javaHome) throw new Error('No Java 17 or 21 found. Install one (for example Eclipse Temurin 21) or set JAVA_HOME_ANDROID.');

// 1. The master itself (one Node.js file + dashboard).
execSync('node scripts/build.mjs', { cwd: root, stdio: 'inherit' });
const assets = path.join(main, 'assets', 'nodejs-project');
fs.rmSync(path.join(main, 'assets'), { recursive: true, force: true });
fs.cpSync(path.join(root, 'build', 'master-headless'), assets, { recursive: true });
execSync('node scripts/notices.mjs', { cwd: root, stdio: 'inherit' });
fs.copyFileSync(path.join(root, 'docs', 'THIRD-PARTY-NOTICES.txt'), path.join(assets, 'THIRD-PARTY-NOTICES.txt'));

// 2. The Node.js runtime for each phone architecture.
for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
  const dest = path.join(main, 'jniLibs', abi);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(libnode, 'bin', abi, 'libnode.so'), path.join(dest, 'libnode.so'));
}

// 3. Gradle (the cached distribution; the build itself runs offline).
fs.writeFileSync(path.join(proj, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`);
const dists = path.join(os.homedir(), '.gradle', 'wrapper', 'dists');
const gradleBin = fs
  .readdirSync(dists)
  .filter((d) => /^gradle-8\.(1[3-9])/.test(d))
  .flatMap((d) => fs.readdirSync(path.join(dists, d)).map((h) => path.join(dists, d, h, d.replace(/-(all|bin)$/, ''), 'bin', win ? 'gradle.bat' : 'gradle')))
  .find((p) => fs.existsSync(p));
if (!gradleBin) throw new Error('Gradle 8.13+ not found in ~/.gradle (open the project once in Android Studio, or install Gradle).');

// Release key: generated once, kept outside the source tree.
const signDir = path.join(root, 'vendor', 'android-signing');
const jks = path.join(signDir, 'raven-master.jks');
const passFile = path.join(signDir, 'password.txt');
if (!fs.existsSync(jks)) {
  fs.mkdirSync(signDir, { recursive: true });
  const pass = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(passFile, pass, { mode: 0o600 });
  execFileSync(path.join(javaHome, 'bin', win ? 'keytool.exe' : 'keytool'), ['-genkeypair', '-keystore', jks, '-alias', 'raven', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-storepass', pass, '-keypass', pass, '-dname', 'CN=Raven Master'], { stdio: 'inherit' });
}
const pass = fs.readFileSync(passFile, 'utf8').trim();
const code = Number(pkg.version.split('.').reduce((a, n) => a * 100 + Number(n), 0)) || 1;
const args = ['--offline', '--no-daemon', '-q', `-PravenVersion=${pkg.version}`, `-PravenCode=${code}`, 'assembleDebug', 'assembleRelease'];
// Signing settings go through the environment so they never appear in a command line or log.
execFileSync(gradleBin, args, {
  cwd: proj,
  stdio: 'inherit',
  shell: win, // .bat files need a shell on Windows; the arguments above are fixed, never user input
  env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ORG_GRADLE_PROJECT_ravenKeystore: jks, ORG_GRADLE_PROJECT_ravenKeystorePassword: pass },
});

const outDir = path.join(proj, 'app', 'build', 'outputs', 'apk');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.mkdirSync(path.join(root, 'build', 'android'), { recursive: true });
// RavenMaster.apk runs on every phone; RavenMaster-arm64.apk is the smaller one for almost all modern phones.
fs.copyFileSync(path.join(outDir, 'release', 'app-universal-release.apk'), path.join(root, 'dist', 'RavenMaster.apk'));
fs.copyFileSync(path.join(outDir, 'release', 'app-arm64-v8a-release.apk'), path.join(root, 'dist', 'RavenMaster-arm64.apk'));
fs.copyFileSync(path.join(outDir, 'debug', 'app-universal-debug.apk'), path.join(root, 'build', 'android', 'RavenMaster-debug.apk'));
const size = (f) => `${(fs.statSync(f).size / 1e6).toFixed(1)} MB`;
console.log(`built dist/RavenMaster.apk (${size(path.join(root, 'dist', 'RavenMaster.apk'))}), dist/RavenMaster-arm64.apk (${size(path.join(root, 'dist', 'RavenMaster-arm64.apk'))}) and build/android/RavenMaster-debug.apk`);
