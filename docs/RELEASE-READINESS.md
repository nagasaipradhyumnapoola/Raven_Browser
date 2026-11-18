# Release readiness

**Verdict: ready for personal use on your own devices, after one live check with your AI provider keys. Not ready for distribution to other people** (unsigned apps, Mac build untested, provider terms).

## Works and was tested

| Area | Evidence |
|---|---|
| Pairing without accounts, approval, revoke, suspend, rotate | unit tests + desktop e2e |
| Browsing through the master, master-only mode, downloads, uploads, WebSockets | unit tests + desktop, headless and Android e2e |
| Any AI provider by address + key, several at once, keys encrypted, never sent to browsers | desktop, headless and Android e2e |
| AI first: typed text answered, opened, searched or turned into a task by the AI | desktop e2e |
| Tasks on the master's hidden browser, password prompt (never to the AI), approval before sending, live view | desktop e2e (test site, scripted model) |
| Search run on the master, shown in Raven, engine fallback | desktop, headless and Android e2e |
| Remote tab: a master page used from the user PC | desktop e2e |
| Reconnect after master restart; finding the master at another address after a network change | desktop e2e |
| Master on Android (embedded Node.js), Keystore-protected secrets, token-locked local dashboard | Android e2e on the emulator |
| Headless master for Termux / Linux | headless e2e |
| Packaged Windows EXEs start with no installer, secrets encrypted | packaged test |
| No overlapping or overflowing UI on the 20 main screens | UI check |

## Built, not exercised by automation

Mac apps (script + CI workflow ready), router port forwarding (UPnP) against a real router, video and camera prompts, print, PDF viewer, private windows, tray menu, dashboard PIN, start at sign-in, phone start at boot.

## Still needs you

1. Add at least one AI provider (name, API address, key) on the master and ask a real question.
2. Try one real second computer over Wi-Fi or a hotspot, and allow the network prompt on the master.
3. Try a real task (for example reading your inbox) and watch it in the live view.
4. For the phone master: install `RavenMaster-arm64.apk`, set battery use to *Unrestricted*, connect a computer to the phone's hotspot.
5. For other networks: turn on Remote access; if your router or provider does not allow it, set up a VPN or tunnel.
6. Optional: code-sign the Windows and Mac apps; run the GitHub workflow to get Mac builds.

See KNOWN-LIMITATIONS.md for what is not supported.
