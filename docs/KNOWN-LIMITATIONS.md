# Known limitations

Stated plainly, so nothing is claimed that was not built or tested.

## Network

- **No path, no internet.** The user computer needs some link to the master: Wi-Fi, a hotspot, a cable, the internet (Remote access), a VPN or a tunnel.
- **Remote access by router forwarding** needs UPnP on the router and a real public address. Mobile data and many home providers share one public address between customers (carrier-grade NAT); then use a VPN (Tailscale, ZeroTier) or a tunnel. **Checked live on the development network: the router accepted forwarding, but the provider uses a shared address, so on that network other-network access needs a VPN or tunnel.** The app detects this, says so, and removes the forwarding again. Moving between networks was tested on one machine (the saved address made unreachable, the browser found another), not across two real networks.
- **Raven Wi-Fi** needs a Windows master whose Wi-Fi adapter supports Mobile Hotspot, and an internet connection on the master that Windows allows sharing (the dashboard says when it does not). Mac and Android masters cannot start it; use the device's own hotspot. When the master's internet also comes over its Wi-Fi card, starting Raven Wi-Fi drops that Wi-Fi for a few seconds, once. Windows normally switches a hotspot off after 5 minutes with no devices; Raven turns that timer off while Raven Wi-Fi runs (and back on when it is switched off), because each restart would drop the master's Wi-Fi again. The first build did not, and dropped the master's Wi-Fi every 5 minutes; fixed. If Windows still switches it off 3 times in 30 minutes, Raven stops restarting it and says so on the dashboard. Joining automatically works on Windows and Mac user computers. **Starting and stopping the hotspot was checked live on the development PC; joining it from a second computer was not tested (only one PC was available).**
- **No cables are ever needed.** Every connection is Wi-Fi, a hotspot, a LAN or the internet.
- **TCP only.** UDP is not carried, so HTTP/3 falls back to HTTP/2, and video calls that need UDP may fail through the master. *Open this page on the master* shows such a site but carries no sound or camera.
- **Google** sometimes shows "unusual traffic" checks to Electron browsers and to the master's hidden browser; search then falls back to DuckDuckGo, Bing or Brave automatically.
- mDNS discovery can be blocked by guest Wi-Fi or "client isolation"; typing the address always works.
- One master per browser at a time.

## Master on Android

- **No tasks and no remote tabs** on a phone master (they need a desktop browser engine). Everything else works: gateway, pairing, AI providers, router, search, limits, remote access.
- No built-in FreeLLMAPI on the phone; add a provider by address and key.
- The phone may pause the app to save battery unless its battery use is set to *Unrestricted*. The app keeps a wake lock while serving, which uses battery.
- Tested on the Android 15 emulator (x86_64). Not yet tested on a physical phone, on mobile data, or with the phone's hotspot.
- The APK is signed with a local key (not from a store), so Android asks to allow installing it.

## Tasks (desktop master)

- Done by AI models step by step; they can be slow, misread a page, or stop. Free models are weaker at this than at chat.
- Sites with strong bot checks may need you to solve a check in the live view.
- Each device's master-side profile has its own logins; logging in to two accounts of the same site at once from one device needs a private window on that site (not built).
- Tested with real models on real public pages (Wikipedia: open a page and read it; use the site's search box, open the result, read it). Not tested on Gmail or WhatsApp, which need the owner's own sign-in.

## Browser

- No Chrome extensions, no Chrome Web Store, no DRM video (Netflix and similar), no casting, no Chrome sync.
- No built-in password manager for the browser itself (task passwords can be remembered on the master).
- Spell check uses English (US).

## AI

- Answer quality depends on the providers you add. Free quotas run out; the assistant then reports the provider's limit.
- With no master, new AI answers are not possible; saved chats and the offline reference stay available.

## Packaging and platforms

- **Mac builds have not been built or run** here (no Mac available). The packaging script and a CI workflow for macOS are in place. The apps are unsigned: first open with right-click → Open.
- Windows EXEs are not code-signed; SmartScreen warns on first run. Portable EXEs unpack to a temporary folder on each start.
- The desktop master is a startup app, not a system service: it runs while a user is signed in.
- Copying the browser's data folder to another account keeps memory but not the device credential (by design).
