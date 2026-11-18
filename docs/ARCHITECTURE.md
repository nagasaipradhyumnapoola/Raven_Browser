# Architecture

```
D:\ai browser
├── apps/
│   ├── master-server/            the master
│   │   └── src/
│   │       ├── core/              everything without a window (no Electron imports; unit-tested):
│   │       │                      app.ts (MasterCore: config, devices, gateway, AI providers, router,
│   │       │                      search, port forwarding, discovery, dashboard actions + snapshot),
│   │       │                      gateway, ai, router, httpsearch, upnp, tls, devices, config
│   │       ├── main/              desktop shell (Electron): window, tray, clipboard, DPAPI/Keychain secrets,
│   │       │                      agent.ts (tasks + remote tabs), search.ts (hidden-browser search),
│   │       │                      freellm.ts (bundled FreeLLMAPI supervisor)
│   │       ├── headless/          phone / server shell (plain Node.js 18+): AES secrets, loopback dashboard API
│   │       ├── freellm-host/      boots the real FreeLLMAPI in a child process (desktop)
│   │       └── renderer/          dashboard (React); webbridge.ts talks to the headless shell
│   ├── master-android/           Android app: foreground service running the headless master inside
│   │                             nodejs-mobile, WebView dashboard, Keystore-wrapped secret key
│   └── raven-browser/            the browser (Electron)
│       └── src/
│           ├── main/              windows + tabs, connection manager (routes, reconnect), downloads,
│           │                      permissions, ad blocking, AI chat, master RPC (router, tasks, search)
│           └── renderer/          browser UI, internal pages (search results, remote tab, tasks), assistant
├── packages/                     shared types · security · network protocol · file memory · UI kit
├── vendor/                       FreeLLMAPI (pinned), nodejs-mobile (Android runtime) — not in git
├── tests/                        unit + integration tests (node:test)
├── scripts/                      build, packaging (Windows/Mac/Android), end-to-end runs
└── dist/                         packaged apps + SHA256SUMS.txt
```

## Runtime picture

```
                ┌──────────────────────── Master (desktop shell or phone shell) ─────────────────────────┐
                │                         MasterCore                                                      │
 Raven Browser ─┼─ TLS WebSocket ──▶ GatewayServer :47800 ─┬─ TCP streams ───────────────────────────────┼─▶ websites
 (any computer) │   (pinned cert,      device auth,         ├─ AI streams ─▶ AiService ─▶ providers ───────┼─▶ any OpenAI-compatible API
                │    Ed25519)          switches, limits     ├─ RPC: route ─▶ router (AI decides)           │
                │                                           ├─ RPC: search ─▶ hidden browser | HTTP search ─┼─▶ search engines
                │   ◀──── task events ──────────────────────┤─ RPC: tasks / remote tabs ─▶ AgentManager ───┼─▶ websites (desktop)
                │                                           └─ UPnP port mapping, mDNS                     │
                │   dashboard ◀─ IPC (desktop) / 127.0.0.1 + token (phone)                                 │
                └─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Key decisions

| Decision | Why |
|---|---|
| One `MasterCore`, thin shells per platform | The desktop app, the phone app and a plain server run the same tested code; each shell only adds what it alone can do. |
| Android: real Node.js (nodejs-mobile) instead of a rewrite | Same protocol and security code on the phone; one test suite covers it. |
| Electron 45 (Chromium 156), `WebContentsView` per tab | Real Chromium engine, sandboxed pages. |
| One multiplexed TLS WebSocket per browser | Works on LAN, VPNs and HTTPS tunnels; one authenticated session carries everything, with per-stream flow control and RPC. |
| Local loopback proxy in the browser | Every connection routed (gateway, direct, refused) in one place, below Chromium. |
| Self-signed certificate + pinning + pairing code | Secure without a CA or domain, on any address the master is reached at. |
| AI decides what typed text means (router) | Questions get answers, errands become tasks, plain searches still search. Failures fall back to answering. |
| Tasks as one-step-at-a-time tool calls (goto, click, type, password, ask, done) on a page snapshot | Works with any chat model; safety rules (passwords, approvals, page text as data) live in code, not in the prompt. |
| Search results fetched by the master, shown by Raven | Works when the user computer has no internet and when engines challenge it. |
| Browser memory as plain files | Readable, crash tolerant, no database. |

## Connection state machine (browser)

`discovering → connecting → awaiting_authorization → gateway_online`, with `gateway_degraded` and `ai_unavailable`; on loss `server_unreachable` → try the master's other saved addresses → retries with back-off (1 s to 30 s), immediate retry on network change or wake, mDNS rediscovery. `direct` when allowed and the master is unavailable; `offline` when nothing is reachable.
