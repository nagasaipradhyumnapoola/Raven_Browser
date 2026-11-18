# Building

Requirements: Node.js 22 or 24, Git, internet access for the first install.
Windows apps build on Windows, Mac apps on a Mac (or the CI workflow), the Android app anywhere with the Android SDK.

## Once: dependencies

```bash
git clone https://github.com/tashfeenahmed/freellmapi vendor/freellmapi
```

```bash
git -C vendor/freellmapi checkout fd327a57bc4157b22d483007b522c2152c54ae9a
```

```bash
npm ci --prefix vendor/freellmapi --ignore-scripts
```

```bash
npx --prefix vendor/freellmapi/client vite build vendor/freellmapi/client
```

```bash
npm ci
```

## Windows / Mac apps

```bash
npm run dist
```

On Windows: `dist/MasterServer.exe`, `dist/RavenBrowser.exe` (portable). On a Mac: `dist/MasterServer-mac.dmg`, `dist/RavenBrowser-mac.dmg` (+ `.zip`). Both write `dist/SHA256SUMS.txt` and regenerate `docs/THIRD-PARTY-NOTICES.txt`.

`.github/workflows/build.yml` builds and tests both on GitHub (Windows and macOS runners) and uploads the packages.

## Android master app

Needs the Android SDK with NDK 27.1 and CMake 3.22.1 (install them from Android Studio's SDK Manager), Java 17 or 21, and the Node.js runtime for Android:

```bash
cd vendor/nodejs-mobile && npm pack nodejs-mobile-react-native@18.20.4 && tar -xzf nodejs-mobile-react-native-18.20.4.tgz package/android/libnode package/LICENSE
```

```bash
node scripts/android.mjs
```

Builds the headless master, copies it and `libnode.so` into the app, and runs Gradle (offline when the Android plugin is cached). Output: `dist/RavenMaster-arm64.apk` (most phones), `dist/RavenMaster.apk` (all phones), both signed with a key generated once in `vendor/android-signing/` (keep it: updates must be signed with the same key), and `build/android/RavenMaster-debug.apk` for tests.

## Headless master (Termux, Linux, Raspberry Pi)

`npm run build` also writes `build/master-headless/`: one Node.js file plus the dashboard.

```bash
node build/master-headless/raven-master.cjs --data ./MasterServerData
```

It prints a dashboard link with a one-time token; open it on the same machine. Tasks and remote tabs are not available there.

## Tests

```bash
npm test
```

Unit and integration tests: protocol, pairing, permissions, model policy, limits, security, persistence, file memory, offline reference.

```bash
node scripts/e2e.mjs
```

The two real desktop apps off-screen: pairing, browsing in gateway-only mode, AI, the AI router, a task with a password prompt and an approval, live view, search on the master, a remote tab, downloads, master stop and restart, and a network change.

```bash
node scripts/e2e-headless.mjs
```

The headless master under plain Node.js with a real Raven Browser.

```bash
node scripts/e2e-android.mjs
```

The real APK on an emulator, or on a phone reachable by `adb` (wireless debugging works, no cable needed), with a real Raven Browser on this computer.

```bash
node scripts/packaged-test.mjs
```

Checks the packaged EXEs.

```bash
node scripts/e2e-real.mjs
```

Live run with real AI models: copy a configured master profile (its `Local State` file and `MasterServerData` folder) to `build/real-test/master` first. Real chat, the AI router, real search, two real tasks on Wikipedia.

```bash
node scripts/upnp-check.mjs
```

Live check of automatic port forwarding against this network's router (adds a throwaway mapping and removes it).

```bash
node scripts/ui-audit.mjs
```

Screenshots of every page of both apps plus an automatic overlap / overflow check.

## Code signing

Builds are unsigned. Windows: set `CSC_LINK` (a .pfx) and `CSC_KEY_PASSWORD` before `npm run dist`. Mac: set the usual electron-builder signing variables and change `identity: null` in `scripts/dist.mjs`.
