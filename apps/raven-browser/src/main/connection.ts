// Connection manager: finds the master server, keeps one authenticated tunnel
// open, and decides for every new connection Chromium makes whether it goes
// through the gateway, directly, or nowhere. State machine:
//
//   discovering -> connecting -> awaiting_authorization -> gateway_online
//        ^             |                                     |  (degraded / ai_unavailable)
//        +---- server_unreachable <--------------------------+
//   (direct | offline) when no gateway is usable
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { Bonjour, type Browser } from 'bonjour-service';
import { ERR_TEXT, PRODUCT, RavenError, type ClientState, type ConnState, type ErrCode } from '@raven/shared';
import { GatewayClient, LocalProxy, directConnect, StreamError, type Endpoint } from '@raven/network-protocol';
import type { IdentityStore, PairingRecord, SettingsStore } from './store';
import { LINK_HOST, linkNetwork, normalizeLinkCode } from '@raven/security';
import { currentSsid, enableAdapterWithPermission, joinRavenWifi, type WifiLinkState } from './wifilink';
import type { ConnView, ServerSeen } from '../types';

const DENIAL_STOPS_RETRY = new Set<ErrCode>(['device_revoked', 'pairing_disabled']);

function parseAddress(text: string): { host: string; port: number } | null {
  let t = text.trim();
  if (!t) return null;
  t = t.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  let host = t;
  let port: number = PRODUCT.defaultGatewayPort;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else if (t.includes(':') && t.indexOf(':') === t.lastIndexOf(':')) {
    host = t.slice(0, t.indexOf(':'));
    port = Number(t.slice(t.indexOf(':') + 1));
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export class ConnectionManager extends EventEmitter {
  readonly client: GatewayClient;
  readonly proxy: LocalProxy;
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private discovered = new Map<string, ServerSeen>();
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 1000;
  private directTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  private stopped = false;
  state: ConnState = 'discovering';
  pairingCode: string | null = null;
  denied: ErrCode | null = null;
  lastError: string | null = null;
  directAvailable = false;
  nextRetryAt: number | null = null;
  linkState: WifiLinkState = 'idle';
  linkError: string | null = null;
  private linkTried = 0;
  /** pin seen during a pending pairing, saved once the owner approves */
  private pendingPin: string | null = null;

  constructor(
    private identity: IdentityStore,
    private settings: SettingsStore,
    private version: string,
  ) {
    super();
    this.client = new GatewayClient(identity.identity, { name: settings.value.deviceName, appVersion: version });
    this.proxy = new LocalProxy({ connect: (host, port) => this.routeConnect(host, port) });
    this.client.on('state', (s: ClientState) => {
      this.learnRoutes(s);
      this.recompute();
      this.emit('server-state', s);
    });
    this.client.on('approved', () => {
      const rec = this.identity.server;
      if (rec) this.identity.setServer({ ...rec, paired: true, pin: rec.pin ?? this.pendingPin });
      this.pairingCode = null;
      this.recompute();
    });
    this.client.on('denied', (code: ErrCode) => {
      this.denied = code;
      this.lastError = ERR_TEXT[code] ?? code;
      if (code === 'device_revoked' && this.identity.server) this.identity.setServer({ ...this.identity.server, paired: false });
      this.recompute();
    });
    this.client.on('close', () => {
      this.proxy.dropAll();
      this.recompute();
      this.scheduleRetry();
    });
    this.client.on('pin-mismatch', () => {
      this.lastError = 'The server at this address has a different identity than the one you paired with. If you reinstalled the master server, pair again.';
    });
  }

  async start(): Promise<number> {
    const port = await this.proxy.listen();
    this.startDiscovery();
    this.startDirectProbe();
    this.watchNetwork();
    void this.connectNow();
    return port;
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.directTimer) clearInterval(this.directTimer);
    this.client.disconnect();
    try {
      this.browser?.stop();
      this.bonjour?.destroy();
    } catch {
      /* ignore */
    }
    void this.proxy.close();
  }

  // ---------------------------------------------------------------- routing
  private gatewayInternetOk(): boolean {
    const s = this.client.state;
    return this.client.online && !!s && s.deviceStatus === 'approved' && s.permissions.internet && s.services.internet && s.services.master && !s.services.maintenance;
  }

  /** Why the gateway cannot carry web traffic right now. */
  private gatewayBlockCode(): ErrCode {
    const s = this.client.state;
    if (!this.client.online || !s) return this.client.phase === 'pending' ? 'device_pending' : this.denied ?? 'server_unreachable';
    if (s.deviceStatus === 'suspended') return 'device_suspended';
    if (s.deviceStatus !== 'approved') return 'device_pending';
    if (s.services.maintenance) return 'maintenance';
    if (!s.services.internet) return 'internet_gateway_disabled';
    if (!s.permissions.internet) return 'internet_not_permitted';
    return 'server_unreachable';
  }

  get route(): 'gateway' | 'direct' | 'none' {
    if (this.gatewayInternetOk()) return 'gateway';
    if (this.settings.value.directFallback && !this.settings.value.strictGateway) return 'direct';
    return 'none';
  }

  /** Called by the loopback proxy for every connection Chromium opens. */
  private async routeConnect(host: string, port: number): Promise<Duplex> {
    const r = this.route;
    if (r === 'gateway') {
      try {
        return await this.client.openTcp(host, port);
      } catch (e) {
        const code = (e as StreamError).code;
        // Only a lost tunnel may fall through to direct, and only if the user allows it.
        if (code === 'server_unreachable' && this.settings.value.directFallback && !this.settings.value.strictGateway) return directConnect(host, port);
        throw e;
      }
    }
    if (r === 'direct') return directConnect(host, port);
    throw new RavenError(this.gatewayBlockCode());
  }

  // ---------------------------------------------------------------- discovery
  private startDiscovery(): void {
    try {
      this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({ type: PRODUCT.mdnsType });
      this.browser.on('up', async (svc: any) => {
        // A master announces every adapter it has, including virtual ones (WSL, Hyper-V, Docker)
        // that other PCs cannot reach. Use the first address this PC can actually connect to.
        const addrs: string[] = (svc.addresses ?? []).filter((a: string) => net.isIPv4(a));
        const host = await this.pickReachable(addrs, Number(svc.port));
        if (!host) return;
        const fp = String(svc.txt?.fp ?? '');
        const seen: ServerSeen = { name: String(svc.txt?.name ?? svc.name ?? 'Raven Master'), host, port: Number(svc.port), fp };
        this.discovered.set(`${fp}|${host}`, seen);
        // A paired server that moved to a new IP is followed automatically.
        const rec = this.identity.server;
        if (rec && fp && rec.fpPrefix === fp && (rec.host !== host || rec.port !== seen.port)) {
          this.identity.setServer({ ...rec, host, port: seen.port });
          if (!this.client.online) void this.connectNow();
        }
        if (!rec && !this.client.online) this.recompute();
        this.emit('change');
      });
      this.browser.on('down', (svc: any) => {
        for (const [k, v] of this.discovered) if (v.port === svc.port && (svc.addresses ?? []).includes(v.host)) this.discovered.delete(k);
        this.emit('change');
      });
    } catch {
      this.bonjour = null;
    }
  }

  /** Probe the announced addresses in parallel; real LAN ranges first, virtual-adapter ranges last. */
  private async pickReachable(addrs: string[], port: number): Promise<string | null> {
    if (!addrs.length || !Number.isInteger(port)) return null;
    const rank = (a: string) => (/^(192\.168|10)\./.test(a) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : /^169\.254\./.test(a) ? 3 : 1);
    const ordered = [...new Set(addrs)].sort((a, b) => rank(a) - rank(b));
    const probe = (host: string) =>
      new Promise<boolean>((resolve) => {
        const s = net.connect({ host, port });
        const t = setTimeout(() => {
          s.destroy();
          resolve(false);
        }, 2000);
        s.once('connect', () => {
          clearTimeout(t);
          s.destroy();
          resolve(true);
        });
        s.once('error', () => {
          clearTimeout(t);
          resolve(false);
        });
      });
    const ok = await Promise.all(ordered.map(probe));
    const i = ok.indexOf(true);
    return i >= 0 ? ordered[i] : null;
  }

  rediscover(): void {
    try {
      this.browser?.update();
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- direct probe
  private startDirectProbe(): void {
    const probe = () => {
      if (this.client.online && this.gatewayInternetOk()) return;
      const s = net.connect({ host: '1.1.1.1', port: 443 });
      const t = setTimeout(() => done(false), 3500);
      const done = (ok: boolean) => {
        clearTimeout(t);
        s.destroy();
        if (ok !== this.directAvailable) {
          this.directAvailable = ok;
          this.recompute();
        }
      };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    };
    probe();
    this.directTimer = setInterval(probe, 20_000);
    this.directTimer.unref?.();
  }

  // ---------------------------------------------------------------- Raven Wi-Fi
  /** The person typed the master's link code: remember it, join Raven Wi-Fi, connect to the master on it. */
  async useLinkCode(text: string): Promise<void> {
    const code = normalizeLinkCode(text);
    if (!code) throw new Error('That link code does not look right. It has 10 letters and digits, like K7QM2-XW4PH.');
    this.identity.setLinkCode(code);
    this.linkTried = 0;
    const rec = this.identity.server;
    const linkAddr = `${LINK_HOST}:${PRODUCT.defaultGatewayPort}`;
    if (!rec) {
      this.identity.setServer({ host: LINK_HOST, port: PRODUCT.defaultGatewayPort, tls: 'pin', pin: null, serverName: 'Raven Master', paired: false, fpPrefix: '', routes: [linkAddr] });
    } else if (!(rec.routes ?? []).includes(linkAddr)) {
      this.identity.setServer({ ...rec, routes: [...(rec.routes ?? []), linkAddr] });
    }
    // Already reaching the master: keep the current network; Raven Wi-Fi is used when the master cannot be reached.
    if (this.state === 'gateway_online' || this.state === 'gateway_degraded' || this.state === 'ai_unavailable' || this.state === 'awaiting_authorization') {
      this.emit('change');
      return;
    }
    await this.ensureLink(true);
    this.retryDelay = 1000;
    await this.connectNow();
  }

  /** "Try again" from the person: no waiting for the Raven Wi-Fi retry pause. */
  retryNow(): Promise<void> {
    if (this.state === 'gateway_online') return Promise.resolve();
    this.linkTried = 0;
    this.retryDelay = 1000;
    return this.connectNow();
  }

  forgetLinkCode(): void {
    this.identity.setLinkCode(null);
    this.linkState = 'idle';
    this.linkError = null;
    this.emit('change');
  }

  /** Windows asks the person to allow turning on a disabled Wi-Fi adapter, then Raven joins. */
  async enableWifiAdapter(): Promise<void> {
    await enableAdapterWithPermission();
    this.linkTried = 0;
    await this.ensureLink(true);
    await this.connectNow();
  }

  /** Join Raven Wi-Fi when a link code is set and this computer is not on it. True if just joined. */
  private async ensureLink(force = false): Promise<boolean> {
    const code = this.identity.linkCode;
    if (!code) return false;
    if (!force && Date.now() - this.linkTried < 20_000) return false;
    this.linkTried = Date.now();
    const { ssid, passphrase } = linkNetwork(code);
    if ((await currentSsid()) === ssid) {
      this.linkState = 'joined';
      // Already on Raven Wi-Fi: the master is at its fixed address there.
      const rec = this.identity.server;
      if (rec && rec.host !== LINK_HOST && rec.tls === 'pin') {
        const port = Number((rec.routes ?? []).find((r) => r.startsWith(`${LINK_HOST}:`))?.split(':')[1] ?? PRODUCT.defaultGatewayPort);
        this.identity.setServer({ ...rec, host: LINK_HOST, port });
        return true;
      }
      return false;
    }
    this.linkState = 'joining';
    this.linkError = null;
    this.emit('change');
    const r = await joinRavenWifi(ssid, passphrase);
    this.linkState = r.state;
    this.linkError = r.error ?? null;
    this.emit('change');
    if (r.state !== 'joined') return false;
    const rec = this.identity.server;
    if (rec && rec.tls === 'pin') {
      const port = Number((rec.routes ?? []).find((x) => x.startsWith(`${LINK_HOST}:`))?.split(':')[1] ?? PRODUCT.defaultGatewayPort);
      this.identity.setServer({ ...rec, host: LINK_HOST, port });
    }
    return true;
  }

  // ---------------------------------------------------------------- any network
  /** Save every address the master can be reached at, so a move to another network still finds it. */
  private learnRoutes(s: ClientState): void {
    const rec = this.identity.server;
    if (!rec || rec.tls !== 'pin' || !Array.isArray(s.routes)) return;
    const routes = [...new Set(s.routes.filter((r) => typeof r === 'string' && /^[\w.:-]+:\d+$/.test(r)))].slice(0, 12);
    if (JSON.stringify(routes) !== JSON.stringify(rec.routes ?? [])) this.identity.setServer({ ...rec, routes });
  }

  /** The saved address failed: try the others the master told us about. Returns true if it switched. */
  private async tryOtherRoutes(): Promise<boolean> {
    const rec = this.identity.server;
    if (!rec || rec.tls !== 'pin' || !rec.pin || !rec.routes?.length) return false;
    const current = `${rec.host}:${rec.port}`;
    const others = rec.routes.filter((r) => r !== current);
    const probes = await Promise.all(
      others.map(async (r) => {
        const i = r.lastIndexOf(':');
        const host = r.slice(0, i);
        const port = Number(r.slice(i + 1));
        return (await this.pickReachable([host], port)) ? { host, port } : null;
      }),
    );
    const hit = probes.find(Boolean);
    if (!hit) return false;
    // The certificate pin travels with the record, so a new address cannot impersonate the master.
    this.identity.setServer({ ...rec, host: hit.host, port: hit.port });
    return true;
  }

  /** Reconnect at once when this PC joins a network or wakes up, instead of waiting for the back-off. */
  private netSig = '';
  private watchNetwork(): void {
    const sig = () =>
      Object.values(os.networkInterfaces())
        .flat()
        .filter((a) => a && !a.internal && a.family === 'IPv4')
        .map((a) => a!.address)
        .sort()
        .join(',');
    this.netSig = sig();
    const t = setInterval(() => {
      const now = sig();
      if (now === this.netSig) return;
      this.netSig = now;
      this.kick();
    }, 3000);
    t.unref?.();
  }

  /** Try the master right now (network changed, PC woke up). */
  kick(): void {
    if (this.stopped) return;
    this.retryDelay = 1000;
    this.rediscover();
    if (!this.client.online) void this.connectNow();
  }

  // ---------------------------------------------------------------- connecting
  private endpoint(): Endpoint | null {
    const rec = this.identity.server;
    if (!rec) return null;
    return { host: rec.host, port: rec.port, tls: rec.tls, pin: rec.pin };
  }

  /** Pair with (or switch to) a server address. */
  async useServer(target: { host: string; port: number; tls?: 'pin' | 'ca'; name?: string; fp?: string }): Promise<void> {
    const prev = this.identity.server;
    const same = prev && prev.host === target.host && prev.port === target.port;
    const rec: PairingRecord = {
      host: target.host,
      port: target.port,
      tls: target.tls ?? 'pin',
      pin: same ? prev!.pin : null,
      serverName: target.name ?? prev?.serverName ?? 'Raven Master',
      paired: same ? prev!.paired : false,
      fpPrefix: target.fp ?? (same ? prev!.fpPrefix : ''),
    };
    this.identity.setServer(rec);
    this.denied = null;
    this.lastError = null;
    await this.connectNow();
  }

  async useAddress(text: string, ca: boolean): Promise<void> {
    const a = parseAddress(text);
    if (!a) throw new Error('That address does not look right. Use the address shown on the master’s dashboard, like host:47800');
    await this.useServer({ host: a.host, port: ca && !text.includes(':') ? 443 : a.port, tls: ca ? 'ca' : 'pin' });
  }

  forgetServer(): void {
    this.client.disconnect();
    this.identity.setServer(null);
    this.pairingCode = null;
    this.denied = null;
    this.recompute();
  }

  async connectNow(): Promise<void> {
    if (this.stopped || this.connecting) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
    const ep = this.endpoint();
    if (!ep) {
      // Not paired yet: if exactly one server is advertising, offer it in the UI.
      this.recompute();
      return;
    }
    this.connecting = true;
    this.denied = null;
    this.recompute();
    try {
      const res = await this.client.connect(ep);
      const rec = this.identity.server!;
      const fpPrefix = res.pin ? res.pin.slice(0, 16) : rec.fpPrefix;
      if (res.phase === 'pending') {
        this.pairingCode = res.pairingCode ?? null;
        this.pendingPin = res.pin;
        // Remember the certificate now; it is only trusted for good once the owner approves.
        this.identity.setServer({ ...rec, pin: rec.pin ?? res.pin, fpPrefix, paired: false });
      } else {
        this.pairingCode = null;
        this.identity.setServer({ ...rec, pin: rec.pin ?? res.pin, fpPrefix, paired: true, serverName: res.state?.serverName ?? rec.serverName });
      }
      this.retryDelay = 1000;
      this.lastError = null;
    } catch (e) {
      const code = ((e as StreamError).code ?? 'server_unreachable') as ErrCode;
      this.lastError = code === 'server_unreachable' ? ERR_TEXT.server_unreachable : ERR_TEXT[code] ?? (e as Error).message;
      if (code !== 'server_unreachable') this.denied = code;
      if (code === 'server_unreachable') {
        this.rediscover();
        // No network to the master: join Raven Wi-Fi (if a link code was given) and go straight to the master on it.
        if (await this.ensureLink()) {
          this.connecting = false;
          this.retryDelay = 1000;
          return void this.connectNow();
        }
        if (await this.tryOtherRoutes()) {
          this.connecting = false;
          this.retryDelay = 1000;
          return void this.connectNow();
        }
      }
      if (!DENIAL_STOPS_RETRY.has(code)) this.scheduleRetry();
    } finally {
      this.connecting = false;
      this.recompute();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || !this.identity.server) return;
    if (this.denied && DENIAL_STOPS_RETRY.has(this.denied)) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(30_000, Math.round(this.retryDelay * 1.8));
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectNow();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Network came back (Wi-Fi rejoined, cable plugged): try at once instead of waiting. */
  networkChanged(): void {
    this.retryDelay = 1000;
    this.rediscover();
    if (!this.client.online) void this.connectNow();
  }

  setDeviceName(name: string): void {
    // Applies on the next connection (the name is sent during authentication).
    (this.client as any).info.name = name;
  }

  // ---------------------------------------------------------------- state
  /** Re-evaluate state and routing (also after settings change). */
  recompute(): void {
    const prevRoute = (this as any)._lastRoute;
    let st: ConnState;
    const s = this.client.state;
    if (this.client.phase === 'pending') st = 'awaiting_authorization';
    else if (this.client.online && s) {
      if (s.aiBackend !== 'ok' && s.permissions.ai && s.services.ai && (!s.permissions.internet || !s.services.internet)) st = 'ai_unavailable';
      else if (!s.masterOnline || !s.services.internet || s.services.maintenance) st = 'gateway_degraded';
      else st = 'gateway_online';
    } else if (this.connecting) st = 'connecting';
    else if (!this.identity.server) st = this.directAvailable && this.route === 'direct' ? 'direct' : 'discovering';
    else if (this.route === 'direct' && this.directAvailable) st = 'direct';
    else if (this.directAvailable) st = 'server_unreachable';
    else st = 'offline';
    this.state = st;
    const route = this.route;
    if (prevRoute && prevRoute !== route) this.proxy.dropAll();
    (this as any)._lastRoute = route;
    this.emit('change');
  }

  view(): ConnView {
    const s = this.client.state;
    const rec = this.identity.server;
    const labels: Record<ConnState, [string, string]> = {
      discovering: ['Looking for master', 'Searching the local network for a Raven Master Server.'],
      awaiting_authorization: ['Waiting for approval', 'Ask the server owner to approve this PC. Check the code matches.'],
      connecting: ['Connecting', rec ? `Connecting to ${rec.host}:${rec.port}` : 'Connecting'],
      gateway_online: ['Master gateway', `Browsing through ${s?.serverName ?? 'the master server'}.`],
      gateway_degraded: ['Gateway limited', !s ? '' : !s.masterOnline ? 'The master laptop has no internet right now.' : !s.services.internet ? 'The owner turned the internet gateway off.' : 'Maintenance mode.'],
      ai_unavailable: ['AI unavailable', 'Connected, but FreeLLMAPI is not responding on the master.'],
      server_unreachable: ['Master unreachable', this.route === 'none' ? 'Gateway-only mode: no other connection is used.' : 'Reconnecting automatically.'],
      direct: ['Direct internet', 'Using this PC’s own internet connection.'],
      offline: ['Offline', 'No master server and no internet. Saved history, notes, chats and the offline reference still work.'],
    };
    const [label, detail] = labels[this.state];
    return {
      state: this.state,
      label,
      detail: this.denied && this.state !== 'gateway_online' ? ERR_TEXT[this.denied] ?? detail : detail,
      endpoint: rec ? { host: rec.host, port: rec.port, tls: rec.tls, paired: rec.paired } : null,
      pairingCode: this.pairingCode,
      denied: this.denied,
      server: s && this.client.online ? s : null,
      route: this.route,
      directAvailable: this.directAvailable,
      discovered: [...this.discovered.values()],
      deviceId: this.identity.deviceId,
      deviceName: this.settings.value.deviceName,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      link: { set: !!this.identity.linkCode, state: this.linkState, error: this.linkError },
    };
  }
}
