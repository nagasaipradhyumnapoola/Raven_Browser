# Test results

Run on Windows 11 (x64), Node.js 24, Electron 45, on the final build of 2026-11-18. Every end-to-end run uses the real built apps, off-screen, with real HTTPS sites on the internet. AI answers come from a local stand-in provider speaking the OpenAI-compatible API (real models need your keys).

| Suite | Result | Command |
|---|---|---|
| Unit + integration | **35 / 35** | `npm test` |
| Desktop end to end (MasterServer + RavenBrowser) | **47 / 47** | `node scripts/e2e.mjs` |
| Headless master end to end (plain Node.js + RavenBrowser) | **14 / 14** | `node scripts/e2e-headless.mjs` |
| Android end to end (real APK on Android 15 emulator, x86_64 + RavenBrowser on the PC) | **13 / 13** | `node scripts/e2e-android.mjs` |
| Packaged Windows EXEs | **12 / 12** | `node scripts/packaged-test.mjs` |
| **Live, real AI models** (owner's FreeLLMAPI: Groq, Cloudflare, OpenRouter… chosen by its router) | **9 / 9** | `node scripts/e2e-real.mjs` |
| **Live, Raven Wi-Fi** (Windows Mobile Hotspot on the development PC) | started in 1.4 s, Windows reported it On, stopped, owner's own hotspot name and password restored | scratch script around `Hotspot` |
| **Live, real router** (UPnP port forwarding on the development network) | works; provider uses a shared address (CGNAT) → reported, forwarding removed | `node scripts/upnp-check.mjs` |
| UI check (20 screens of both apps, overlap / overflow / clipping detector + screenshots) | **no layout defects** (only expected: the menu drawn over the open assistant panel) | `node scripts/ui-audit.mjs` |

## Desktop end to end (47)

Pairing with a 6-digit code and owner approval · only permitted models visible · real HTTPS site in master-only mode · AI answer streams through the gateway · provider key never reaches the browser · visited page and chat searchable in local files · a question typed in the new tab answered by the assistant · an errand typed in the new tab routed by the AI to a task on the master · the master's hidden browser logs in, types and sends on a test site · the password asked in the browser, filled on the master, never in any AI request · sending needed approval · live view picture reaches the browser · a typed search runs on the master and the results show in Raven (Google showed a robot check; DuckDuckGo answered automatically) · a page opened on the master shown and driven from the browser · direct engine pages through the gateway (DuckDuckGo, Google) · Gmail sign-in page · 500 KB download lands on the user PC · master stopped: browser reports it, AI refuses honestly, no direct leak, offline memory and reference work, tabs kept · master restarted: reconnects alone · browser stores the master's other addresses, pinned · after a network change it finds the master at another address · master recorded traffic and AI use · secrets encrypted · logs contain no secret · Raven Wi-Fi: the master has a link code and keeps its own network on (switch off/on works) · a wrong link code refused clearly · with the master unreachable, the typed code makes Raven try to join Raven Wi-Fi and say why it could not · the connection page shows Raven Wi-Fi and Change code · typing the code while online never switches Wi-Fi · the code is stored encrypted · password manager: save offer, encrypted store, fill on a real click, nothing filled on a fake click · page fits the window, zoom buttons, Google robot check falls back to DuckDuckGo, Google sign-in presents as Firefox, in its headers and to its own page scripts.

## Headless master (14)

Starts under plain Node.js and prints its dashboard link · dashboard served with its API · API refuses calls without the token and pages under another host name · provider added from the dashboard · reports no tasks on this kind of master · real browser pairs and goes online · HTTPS site, AI answer, assistant router and search through it · tasks clearly refused (no fake result) · provider key encrypted (AES-256-GCM) · no secret in logs · quits cleanly.

## Android (13)

Device ready (Android 15) · the app starts the master inside the phone (embedded Node.js 18) and its dashboard answers · reports no tasks on a phone · dashboard page served by the phone · provider added and checked from the phone · Raven Browser on the PC pairs with the phone master · the phone shows a notification the moment a device asks to connect · HTTPS site through the phone · AI answer through the phone · search on the phone · 500 KB download through the phone intact · provider key encrypted with the Android Keystore-protected key · neither the key nor the dashboard token in the system log.

## Live with real AI models (9)

The new master on a copy of the owner's real profile takes over the existing AI setup (152 models ready) · a real model answers "capital of France" with "Paris" · the AI router with real models: a question → answered, "open youtube" → opened, "best budget laptops 2026 reviews" → searched, "go to wikipedia and find out…" → task · a real search on the master (11 results) · a real task: open Wikipedia's Alan Turing page and report the birth year → "23 June 1912" · a harder real task: use Wikipedia's search box for Ada Lovelace, open the article, report → "10 December 1815".

The first live run found two real weaknesses, both fixed and covered by unit tests: free models changing between calls sometimes answered "open youtube" or "go to wikipedia and…" themselves, so obvious opens and errands are now decided by fixed rules (questions are never turned into tasks).

## Live router check

The router answered UPnP, but the internet provider shares one public address between customers (carrier-grade NAT), so a forwarded port can't be reached from outside on this network. The app reports exactly that and now removes the forwarding at once (the first run showed it was left until its 1-hour lease ran out; fixed and re-checked: nothing left on the router).

## Not covered

Gmail or WhatsApp tasks (need the owner's own sign-in) · a second computer actually joining Raven Wi-Fi (only one PC available; the join steps are covered by a stand-in) · two computers on two different real networks · a physical Android phone (can be tested over Wi-Fi once the APK is installed on it — no cable needed), mobile data, the phone's hotspot · macOS (no Mac available; CI workflow provided) · video, camera and microphone prompts, printing, PDF viewer, tray menu, PIN lock, start at sign-in.
