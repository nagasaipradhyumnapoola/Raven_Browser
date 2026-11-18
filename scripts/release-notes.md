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

**Start:** open the master, add an AI provider (name, API address, key). Connect the other computer to the master's Wi-Fi or hotspot, open Raven Browser, click Connect, approve the 6-digit code. No cables, no accounts.

Not code-signed: Windows SmartScreen → *More info → Run anyway*; Mac → right-click the app → *Open* (or System Settings → Privacy & Security → *Open Anyway*); Android asks to allow installing the APK.

**Tested on Windows, an Apple Silicon Mac and an Intel Mac (GitHub runners), each:** unit 28/28 · desktop end to end 32/32 · headless master 14/14. **Also:** Android app on Android 15 emulator 12/12 · packaged EXEs 12/12 · live with real AI models 9/9 (including real tasks on Wikipedia) · UI check of 20 screens.

**Not yet tested:** a physical Android phone, two different real networks, tasks on sites that need your sign-in. Details: [docs/KNOWN-LIMITATIONS.md](https://github.com/nagasaipradhyumnapoola/Raven_Browser/blob/main/docs/KNOWN-LIMITATIONS.md).
