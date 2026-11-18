# Networking and security

## How a page reaches the internet

```
Raven Browser (user computer)                          Master (Windows / Mac / Android phone)
┌──────────────────────────────┐                        ┌─────────────────────────────────────────┐
│ Chromium tab                 │                        │ Gateway (TLS WebSocket, port 47800)     │
│   │ every request            │   one TLS connection   │   ├─ device authentication              │
│   ▼                          │ ─────────────────────▶ │   ├─ switches + per-device permissions  │
│ Local proxy 127.0.0.1:random │   many streams inside  │   ├─ limits (bandwidth, AI quotas)      │
│   decides: gateway / direct  │                        │   ├─ destination guard (no private IPs) │
│            / refuse          │                        │   └─ opens TCP to the website ─────────▶ Internet
│ Assistant, router, tasks,    │ ── AI streams, RPC ──▶ │ AI providers · router · search ·        │
│ search, live view            │ ◀── task events ────── │ agents + remote tabs (desktop only)     │
└──────────────────────────────┘                        └─────────────────────────────────────────┘
```

- Chromium sends every connection to Raven's local proxy, which picks the route: through the gateway, directly (only if allowed), or refused. In *Master server only* mode nothing can leak to the computer's own connection.
- HTTPS is tunneled as opaque bytes (HTTP CONNECT). The master never decrypts it; no certificate is installed anywhere.
- Site names are resolved on the master, so the user computer needs no DNS or internet of its own.
- Downloads stream to the user computer; nothing is stored on the master. Flow control keeps memory flat.
- WebSockets, uploads, cookies, redirects and resumable downloads work through the tunnel. UDP is not carried (see KNOWN-LIMITATIONS).

## Device identity and pairing (no accounts)

1. Each Raven Browser creates an Ed25519 key pair on first start. The private key is encrypted by the system (Windows DPAPI, macOS Keychain) and never leaves the computer.
2. On connecting, the browser records the master's certificate fingerprint. Both sides show a 6-digit code computed from that certificate and the device key; matching codes rule out interception.
3. The owner approves the device. From then on the browser pins the master's certificate and signs a fresh challenge that also covers the TLS channel, so a relay cannot reuse it.
4. Revoking a device tombstones its key forever, stops its tasks, and wipes its browser profile and remembered passwords on the master.

There is no shared password and no secret inside any app file.

## Raven Wi-Fi (computers with no network of their own)

- A Windows master runs Windows Mobile Hotspot through the built-in WinRT tethering API (no driver, no admin rights) and keeps it on while the master runs (checked every 45 s, restarted if Windows turns it off). The master is always `192.168.137.1` on that network, and that address is added to every paired browser's saved routes.
- The network name and its WPA2 password are derived from the **link code** (10 characters from a 31-letter alphabet without look-alikes, about 8 x 10^14 possibilities). The password is 24 base32 characters of SHA-256 over the code; the broadcast name comes from a separate hash, so it reveals nothing about the code.
- On the user computer the code is stored encrypted (like the device key). When the master cannot be reached, the browser checks whether Raven Wi-Fi is in range and only then joins it: it saves the network with auto-connect, turns the Wi-Fi radio on if needed (no admin), and points the connection at `192.168.137.1`. It never switches networks while the master is reachable. Enabling a disabled adapter needs one Windows permission prompt, only after the person presses *Turn on Wi-Fi*.
- Joining the network does not bypass anything: new devices still need the owner's approval, and the connection is still TLS with the master's pinned certificate.
- *New code* on the master changes the network name and password; computers using the old code must type the new one.

## Reaching the master from another network

Off by default (*Server control → Remote access*). When on:

- **Router forwarding (automatic)**: the master asks the home router (UPnP) to forward its gateway port, learns the public address, and tells paired devices. The mapping is removed when Remote access is turned off or the master quits. It does not work if the router has UPnP off, or if the internet provider shares one public address between customers (carrier-grade NAT, common on mobile data); the dashboard says which.
- **Saved routes**: every paired browser keeps the list of addresses the master told it about (each network adapter, the router mapping). When the usual address stops answering — after moving to another network — it tries the others. The certificate pin travels with the record, so a different address cannot impersonate the master.
- **VPN** (Tailscale, ZeroTier) or an **HTTPS tunnel** (for example Cloudflare Tunnel) always work: type the VPN address, or add the tunnel hostname under *Remote access → public tunnel hostnames* and tick *Public tunnel address* in the browser.
- Reconnection is immediate when the user computer's network changes or it wakes from sleep, otherwise retried with back-off up to 30 s.

Remote connections are refused unless Remote access is on, and can be cut independently of LAN access. New devices still need the owner's approval.

## Tasks, search and remote tabs (master-side browsing)

The desktop master runs its own hidden browser for these. Rules enforced by the master itself, not left to the AI:

- **One profile per device.** Logins made by one device's tasks are never visible to another device.
- **Passwords** are typed by the person in their browser and filled straight into the page's password field on the master. They are never put in an AI prompt (a test checks every AI request), only go into a real password field, and only on the site they were saved for. "Remember" stores them encrypted on the master; *Forget passwords saved on the master* deletes them.
- **Approval** is required before clicking anything that sends, posts, publishes, pays, buys, books, deletes, unsubscribes, accepts or confirms, and before pressing Enter in a message box. Declining is reported to the AI as final.
- **Page text is data.** The AI is told that instructions found on pages, mails or messages are ignored; the approval and password rules above hold even if it is fooled.
- **Same destination guard as the gateway**: this computer, `localhost` and private networks are off limits unless the owner allowed them; only `http(s)` pages; downloads and site permissions (camera, location…) are refused.
- Answers the person types in the Tasks tab (codes, choices) are shared with the AI and say so.
- Remote tabs nobody looks at for 20 minutes are closed; at most 3 tasks and 6 remote tabs per device.

Search uses the same hidden browser (Google first, then DuckDuckGo, Bing, Brave when an engine shows a robot check). The phone master searches with plain web requests instead.

## What the master never allows

- Unauthenticated use. The port only speaks the Raven protocol.
- Reaching the master itself, `localhost`, private ranges (10/8, 172.16/12, 192.168/16), link-local and cloud metadata, CGNAT, multicast, and their IPv6 forms. Each resolved address is checked and the connection goes to the vetted IP. The owner can allow specific private addresses.
- SMTP (port 25) by default.
- Any model a device is not allowed to use; responses from other models are discarded.
- AI provider keys leaving the master.

## The dashboard

- **Desktop**: a local window; actions travel over Electron IPC and are accepted only from that window.
- **Phone**: served only on the phone itself (127.0.0.1), opened by the app with a random one-time token; requests without it, or made under another host name (DNS-rebinding), are refused. The token never goes to the system log.
- Optional PIN (locks after 10 minutes idle). Revealing or copying a provider key needs the PIN when one is set; the clipboard is cleared 30 seconds after copying.
- Addresses are hidden until *show address* is clicked.

## Secrets at rest

| Secret | Where | Protection |
|---|---|---|
| AI provider keys | `MasterServerData/secrets.json` | Windows DPAPI / macOS Keychain; on Android AES-256-GCM with a key wrapped by the Android Keystore |
| Remembered task passwords | same | same |
| Gateway TLS private key | same | same |
| Built-in FreeLLMAPI keys (desktop, optional) | FreeLLMAPI's own database | encrypted by FreeLLMAPI with a key stored as above |
| Device private key | `RavenBrowserData/identity.json` | Windows DPAPI / macOS Keychain |

Logs pass through a redaction filter; tests confirm no key or password appears in them.

## Licensing and terms

FreeLLMAPI (MIT) is included unmodified in the desktop master. Node.js for Android comes from nodejs-mobile (MIT). Each AI provider's terms apply to how you use its keys. Third-party notices are in `docs/THIRD-PARTY-NOTICES.txt` and inside each app.
