# Troubleshooting

| What you see | Where | What to do |
|---|---|---|
| Windows "protected your PC" (SmartScreen) | Windows apps, first start | Not code-signed. *More info → Run anyway*. Compare with `SHA256SUMS.txt` if someone sent you the files. |
| "can't be opened because Apple cannot check it" | Mac apps, first start | Right-click the app → **Open** → Open. |
| "Install unknown apps" / "blocked by Play Protect" | Android, installing the APK | Allow your file manager to install apps; if Play Protect asks, choose *Install anyway* (the APK is not from the Play Store). |
| Phone master stops after a while | Android | Settings → Apps → Raven Master → Battery → *Unrestricted*. Keep the notification on. |
| "Searching… Raven Master Server must be running on the same network" | Browser new tab | Check the master is running and both are on the same network. Some Wi-Fi blocks devices from seeing each other; use the master's hotspot, or type the address (*Overview → show address*). |
| Address typed, still not connecting | Browser | On Windows, allow *Raven Master Server* in *Windows Security → Firewall → Allow an app* (private networks). On Mac, allow incoming connections when asked. |
| "Waiting for approval" with a 6-digit code | Browser | Approve the device on the master's *Devices* page after checking the codes match. |
| Works at home, not elsewhere | Browser | Turn on *Server control → Remote access* on the master. If it says the router or provider does not allow it, use a VPN (Tailscale, ZeroTier) or a tunnel. |
| "Port 47800 is already in use" | Dashboard | Change the port on the *Internet gateway* page. |
| "No internet on the master" | Dashboard / browser | The master itself is offline. Browsers recover by themselves when it is back. |
| "No AI provider yet" / "No AI provider is responding" | Dashboard | *AI providers*: add one (name, API address, key), or *Check all*. A provider marked *not responding* shows why. |
| "Your AI providers list no usable chat models" | Dashboard | The provider answered but offers no chat models for your key; check its plan or add another provider. |
| "Rate limit reached" / "providers unavailable" | Assistant | Quotas used up or providers down. Wait or add a provider. |
| Address-bar text opens the assistant instead of searching | Browser | The AI decided it was a question. Add words like "search" or turn off *Settings → Answer questions with the assistant*. |
| "Searching on the master…" then "No search engine answered" | Search page | All engines challenged the master. Try again in a minute, or *Open on the engine* to use its own page. |
| "Tasks and remote tabs need the desktop master" | Tasks tab | The master is a phone or server. Use a Windows or Mac master for tasks. |
| A task waits for "Password for …" | Tasks tab | Type the password there; it is filled on the master and never shown to the AI. |
| A task waits for "Allow this step?" | Tasks tab | It is about to send, post, pay or delete. Check the detail; *Allow* or *Don't allow*. |
| A site asks "are you a robot" during a task | Tasks tab | Open *Live view* and solve it there, the task continues. |
| A site does not work in Raven Browser | Browser | Menu ··· → *Open this page on the master* and use it there. |
| "This device was revoked" | Browser | The owner revoked it. *Settings → Connection → Forget server*, then connect again as a new device. |
| A video site will not play | Browser | DRM sites (Netflix and similar) do not work. Ordinary video does. |
| Browser started with a new identity | Browser | The data folder moved to another account or computer; pair this copy once. |
| Dashboard asks for a PIN | Dashboard | You set a dashboard PIN. The server keeps running while locked. |

Logs: master `MasterServerData/logs/events.jsonl` in its data folder (Windows `%APPDATA%\Raven Master Server\`, Mac `~/Library/Application Support/Raven Master Server/`); Android: `adb logcat -s RavenMaster`.
