# Setup and everyday use

No terminal is needed for anything on this page. The [README](../README.md) has the short version.

## The master

Pick the device that has internet. It can be a Windows PC, a Mac, or an Android phone.

### Windows or Mac

1. Put `MasterServer.exe` anywhere (Windows), or open `MasterServer-mac.dmg` and drag *Raven Master Server* to Applications (Mac).
2. Start it. Windows SmartScreen: *More info → Run anyway*. Mac: right-click the app → **Open** the first time (not code-signed).
3. When asked about network access, choose **Allow** (on Windows, for **private** networks; your Wi-Fi should be marked *Private* in Settings → Network & internet → your network).
4. First-time setup: add an **AI provider** (any name, its API address, your key). Any OpenAI-compatible service works: your own FreeLLMAPI, OpenRouter, Groq, a local model server… The key is checked before it is saved. Then choose whether it starts when you sign in.

The window can be closed; the server keeps running in the tray (menu bar on Mac). The tray menu has status, **Emergency stop** and **Quit**.

### Android phone

1. Install `RavenMaster-arm64.apk` (or `RavenMaster.apk` on 32-bit or unusual phones). Allow your file manager to install apps when asked.
2. Open **Raven Master**, allow notifications. The master runs in the background with an ongoing notification; the app shows the dashboard.
3. Add an AI provider as above.
4. In Android settings, set Raven Master's battery use to *Unrestricted* so the phone does not pause it.
5. Optional: *Settings → Start when you sign in* makes it start after the phone restarts.

The phone master does everything the desktop master does except **tasks** and **remote tabs** (they need a hidden desktop browser). Searches still run on the phone.

## Connecting other computers

Any network path to the master works:

- **The master's hotspot** (phone or laptop): connect the other computer to that Wi-Fi.
- **The same Wi-Fi router**, or a **network cable**.
- **Another network entirely**: turn on *Server control → Remote access*. The master asks your router to forward its port. Paired computers learn every address the master can be reached at and switch to another one when they change networks. If your router or internet provider does not allow that, use a VPN or tunnel (see [NETWORKING-AND-SECURITY.md](NETWORKING-AND-SECURITY.md)).

On the other computer:

1. Start Raven Browser (`RavenBrowser.exe`, or the Mac app).
2. On the same network, the new tab page lists the master: click **Connect**. Otherwise type the address from the master's dashboard (*Overview → How other PCs connect → show address*).
3. A 6-digit code appears. On the master, open *Devices*, check the code matches, click **Approve**.

From then on it reconnects by itself whenever both are running.

## Using Raven Browser

- **Type anything** in the address bar or the new tab box. Addresses open; everything else goes to the AI first, which answers it, opens a site, searches, or starts a task.
- **Search** runs on the master; results appear on Raven's own results page. *Open on Google/DuckDuckGo…* opens the engine itself (images, maps, news).
- **Tasks** (desktop master): "check my Gmail for mails from the bank", "reply to Alex on WhatsApp that I'm late"… The Tasks tab (Ctrl+K) shows each step. Type passwords into the *Password for …* box when asked (filled on the master, never shown to the AI); approve steps that send, post, pay or delete.
- **Live view** of a task, and **Open this page on the master** (menu ···): use a page that runs on the master from this computer — click, scroll, type, paste.
- Tabs show a Raven icon for Raven's own pages and a globe for websites; point at a tab to see its title.

## Portable use from a USB stick (Windows)

In *Settings → Portable mode*, choose **Turn on** and restart Raven. Its data then lives in a `RavenBrowserData` folder next to `RavenBrowser.exe`. Moving that folder to another account or computer keeps history, bookmarks, notes and chats, but the device credential is tied to the account, so that copy pairs once as a new device.

## Moving memory to another drive

*Settings → Privacy and memory → Memory folder → Move* copies your memory to the chosen drive and uses it from then on. If that drive is later missing, Raven keeps working in its default folder and offers to merge when the drive is back.

## Updates

Nothing updates by itself. When the owner enters a newer version number in the master's *Settings → Browser update notice*, browsers on older versions show a quiet notice. To update, replace the app file (or install the new APK over the old one); data is kept.
