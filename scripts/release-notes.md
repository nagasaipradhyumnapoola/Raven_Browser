**One click:** `Raven-all.zip` has everything below.

| File | For |
|---|---|
| `MasterServer.exe` | Master on Windows: shares its internet and AI with approved devices, does tasks for them. Portable. |
| `RavenBrowser.exe` | Browser on Windows: everything typed goes to the AI first. Portable, no account. |
| `MasterServer-mac-arm64.dmg`, `RavenBrowser-mac-arm64.dmg` | Master and browser on Apple Silicon Macs (M1–M4). |
| `MasterServer-mac-x64.dmg`, `RavenBrowser-mac-x64.dmg` | Master and browser on Intel Macs. |
| `RavenMaster-arm64.apk` | Master on most Android phones (53 MB). |
| `RavenMaster.apk` | Master on any Android phone (all CPU types). |
| `SHA256SUMS.txt` | Checksums. |

**Start:** open the master, add an AI provider (name, API address, key). Open Raven Browser on the other computer, click Connect, approve the 6-digit code on the master. No cables, no accounts.

**No Wi-Fi or internet on the other computer?** A Windows master runs its own network, **Raven Wi-Fi**, and shows a link code on its Overview page. Type the code once in Raven Browser: it joins that network by itself (turning Wi-Fi on if needed) and connects to the master.

Not code-signed: Windows SmartScreen → *More info → Run anyway*; Mac → right-click the app → *Open* (or System Settings → Privacy & Security → *Open Anyway*); Android asks to allow installing the APK.

**Tested on this build (Windows):** unit 35/35 · desktop end to end 47/47 · headless master 14/14 · Android app on Android 15 emulator 13/13 · packaged EXEs 12/12 · Raven Wi-Fi started and stopped live on a Windows PC. **Also run on every push on Windows, an Apple Silicon Mac and an Intel Mac (GitHub runners).** Live with real AI models 9/9 on the previous build.

**Not yet tested:** a second computer actually joining Raven Wi-Fi, a physical Android phone, two different real networks, tasks on sites that need your sign-in. Details: [docs/KNOWN-LIMITATIONS.md](https://github.com/nagasaipradhyumnapoola/Raven_Browser/blob/main/docs/KNOWN-LIMITATIONS.md).
