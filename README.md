# Raven

## Download

**[⬇ Download everything (one zip)](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/Raven-all.zip)** — Windows, Mac and Android apps, checksums and a short guide.

Or one file at a time:

| File | For |
|---|---|
| [MasterServer.exe](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/MasterServer.exe) | Master on Windows |
| [RavenBrowser.exe](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/RavenBrowser.exe) | Browser on Windows |
| [MasterServer-mac-arm64.dmg](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/MasterServer-mac-arm64.dmg) | Master on Apple Silicon Macs (M1/M2/M3/M4) |
| [RavenBrowser-mac-arm64.dmg](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/RavenBrowser-mac-arm64.dmg) | Browser on Apple Silicon Macs |
| [MasterServer-mac-x64.dmg](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/MasterServer-mac-x64.dmg) | Master on Intel Macs |
| [RavenBrowser-mac-x64.dmg](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/RavenBrowser-mac-x64.dmg) | Browser on Intel Macs |
| [RavenMaster-arm64.apk](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/RavenMaster-arm64.apk) | Master on most Android phones (53 MB) |
| [RavenMaster.apk](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/RavenMaster.apk) | Master on any Android phone |
| [SHA256SUMS.txt](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases/latest/download/SHA256SUMS.txt) | Checksums to verify the files |

Mac apps are built and tested on GitHub's Macs by the [build workflow](.github/workflows/build.yml). They are not code-signed by Apple: the first time, right-click the app → **Open** (or System Settings → Privacy & Security → **Open Anyway**). All releases: [Releases page](https://github.com/nagasaipradhyumnapoola/Raven_Browser/releases).

---

Two programs:

| File | Runs on | What it does |
|---|---|---|
| `MasterServer.exe` (Windows) / `MasterServer-mac.dmg` (Mac) | The computer that has internet | Shares its internet and AI with approved devices, and does tasks for them in its own hidden browser. Lives in the system tray (menu bar on Mac). |
| `RavenMaster-arm64.apk` (most phones) / `RavenMaster.apk` (any Android) | An Android phone that has internet | The same master on a phone: shares the phone's internet (Wi-Fi or mobile data) and AI with approved devices. Tasks and remote tabs need a desktop master. |
| `RavenBrowser.exe` / `RavenBrowser-mac.dmg` | Any other computer | A Chromium browser where everything you type goes to the AI first. Uses the master's internet and AI. No account, no installer. |

Any computer or phone can be the master and any computer can be a user; a computer can even run both. The Windows files are portable: copy, double-click, done.

### Master on an Android phone

1. Copy `RavenMaster-arm64.apk` to the phone and open it (allow *Install unknown apps* for your file manager once). On an older or unusual phone use `RavenMaster.apk`.
2. Open **Raven Master**. It starts the master in the background with a small "Raven Master is running" notification, and shows the same dashboard as on a computer.
3. Add an AI provider (name, API address, key), exactly as on a computer.
4. Connect the computer running Raven Browser to the phone's Wi-Fi or **the phone's hotspot**, then connect and approve as below. The phone's internet can be Wi-Fi or mobile data.

Keep the app allowed to run in the background (Android settings → Apps → Raven Master → Battery → *Unrestricted*), or the phone may pause it to save battery.

## Quick start

### 1. On the computer with internet

1. Open **MasterServer**. Windows SmartScreen: *More info → Run anyway*. Mac: right-click the app → **Open** the first time (the apps are not code-signed).
2. If the system asks whether to allow *Raven Master Server* on networks, choose **Allow** (private networks on Windows).
3. The setup screen asks for an **AI provider**: any name, the provider's **API address** and your **API key**. Any OpenAI-compatible service works (your own FreeLLMAPI, OpenRouter, Groq, a local server…). Raven checks the key against the provider's model list before saving it. You can add several providers later on the *AI providers* page; the built-in FreeLLMAPI is an optional switch there.
4. Choose whether it starts when you sign in.

Closing the window keeps the server running in the tray / menu bar. Use **Quit** in the tray menu to stop it.

### 2. On another computer

1. Open **RavenBrowser**.
2. On the same network, the new tab page lists the master it found: click **Connect**. On another network, type the address from the master's dashboard (*Overview → How other PCs connect → show address*).
3. A 6-digit code appears. On the master, open *Devices*, check the code matches, and click **Approve**.

**No Wi-Fi network and no internet on that computer?** Use **Raven Wi-Fi**. A Windows master runs its own Wi-Fi network (Windows Mobile Hotspot, started by Raven) and shows a **link code** on its *Overview* page. Type that code once in Raven Browser (new tab or *Master server* page). The browser works out the network's name and password from the code, joins it by itself, turns Wi-Fi on if it was off, and connects to the master. If the Wi-Fi adapter is disabled in Windows, one **Turn on Wi-Fi** click asks Windows for permission and enables it.

That computer now browses and uses AI through the master. You approve it once; after that it reconnects by itself whenever both are running — after restarts, sleep, or moving to another network.

## Everything goes to the AI first

Type anything in the address bar or the new tab box:

- an address (`example.com`) opens directly;
- anything else goes to the AI, which decides: **answer** it in the assistant, **open** a site, **search** the web, or **do it** as a task.

**Searches run on the master.** Its own browser asks Google (or DuckDuckGo, Bing, Brave if one shows a robot check) and Raven shows the results on its own page; clicking a result opens it through the master. *Settings → Search through the master* turns this off.

**Open this page on the master** (menu ···): any site that doesn't work on this PC opens on the master instead and appears here as a live tab you click, scroll and type into, with its own address bar.

### Tasks done by the master

A request like *"check my Gmail for mails from the bank today"* or *"send Bob a WhatsApp saying I'm late"* becomes a **task**. The master runs it in its own hidden browser (one separate profile per device, so logins never mix), one step at a time: open, click, type, read. Several tasks can run in parallel. The browser's **Tasks** tab (assistant panel, Ctrl+K) shows each step.

- **Passwords**: when a site asks for one, the browser shows a *Password for …* box. What you type is filled straight into the page on the master and is **never sent to the AI**. You can let the master remember it (encrypted) for that site; *Forget passwords saved on the master* clears them.
- **Approval**: anything that sends, posts, pays, deletes or accepts something waits for **Allow / Don't allow** in the browser.
- **Questions**: codes sent to your phone, which account to use and so on are asked in the Tasks tab. When the browser window isn't focused, a desktop notification appears.
- **Live view**: watch the master's hidden page, click on it and type into it (for example to solve a "are you a robot" check).

## What each part does

### Raven Master Server (dashboard)

- **Overview**: is it serving, devices, traffic, AI requests, problems that need attention. Addresses stay hidden until you click *show address*.
- **Server control**: switches for the whole server, internet gateway, AI gateway, LAN access, **remote access** (lets paired devices reach it from any network; the router is asked to forward the port automatically), new device pairing and maintenance mode, plus emergency buttons.
- **Devices**: approve, rename, suspend, revoke, disconnect; per device internet, AI, models, limits. Revoking a device also stops its tasks and wipes its browser profile and saved passwords on the master.
- **Internet gateway**: live speed, port, tunnel addresses, private addresses devices (and tasks) may reach — none by default.
- **AI providers**: add, check, edit, remove providers; keys are masked (reveal or copy behind the PIN).
- **Models**, **Logs**, **Settings**.

Every switch is enforced by the server itself and applies immediately. Browsers never receive provider keys.

### Raven Browser

- Tabs show one of two icons — Raven for its own pages and the assistant, a globe for websites; the title slides out when the pointer is on the tab.
- Bookmarks, history (saved; not shown on the new tab), downloads, find, zoom, print, PDF viewer, private windows, session restore, light and dark themes.
- **Assistant** (Ctrl+K): chat, include the page or selected text, choose model, **Tasks** tab.
- **Memory**: search pages, searches, bookmarks, notes and chats, even offline. **Programming reference** works offline.

### Connection modes

| Situation | What happens |
|---|---|
| Master reachable (same network, or remote access / tunnel) | Pages, AI and tasks go through the master. |
| Master not reachable, this PC has internet | Pages open directly (unless *Master server only* is on). No AI. |
| Neither | History, bookmarks, notes, saved pages, saved chats and the reference still work. |

## Keyboard shortcuts

Ctrl/Cmd: T new tab · W close · Shift+T reopen · Tab switch · 1…9 go to tab · L address bar · R reload · F find · H history · J downloads · D bookmark · K assistant · S save page · P print · plus/minus/0 zoom · N new window · Shift+N private window. Alt+Left/Right back/forward · F11 full screen.

## Where data is stored

- **Raven Browser**: `%APPDATA%\Raven Browser\RavenBrowserData\` (Mac: `~/Library/Application Support/Raven Browser/RavenBrowserData/`), or next to the EXE in portable mode. Plain files, no database.
- **Master Server**: `%APPDATA%\Raven Master Server\MasterServerData\` (Mac: `~/Library/Application Support/Raven Master Server/MasterServerData/`). Secrets (provider keys, remembered task passwords) are encrypted by the system: Windows DPAPI or the macOS Keychain.

More: [docs/SETUP-AND-USE.md](docs/SETUP-AND-USE.md), [docs/NETWORKING-AND-SECURITY.md](docs/NETWORKING-AND-SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md), [docs/BUILDING.md](docs/BUILDING.md), [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md), [docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md).
