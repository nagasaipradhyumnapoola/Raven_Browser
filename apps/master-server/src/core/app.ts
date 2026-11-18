// The whole master server minus its window: config, devices, gateway, AI providers, assistant router,
// router port forwarding, LAN discovery, the dashboard's actions and its live snapshot.
// The desktop app (Electron) and the headless master (phones, servers) both run this; each host adds
// what only it can do (window, tray, clipboard, hidden browsers, built-in FreeLLMAPI).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SWITCHES, isPlainObject, type AgentTaskView, type DeviceRecord, type RouteDecision, type ServiceSwitches } from '@raven/shared';
import { hashPin, verifyPin } from '@raven/security';
import { AiService, type AiEndpoint } from './ai';
import { ConfigStore, type MasterConfig, type SecretStore } from './config';
import { DeviceRegistry } from './devices';
import { Advertiser } from './discovery';
import { GatewayServer } from './gateway';
import { httpSearch, type Engine, type SearchResponse } from './httpsearch';
import { routeInput } from './router';
import { loadOrCreateTls } from './tls';
import { PortMapper } from './upnp';
import type { InvokeResult, MasterSnapshot } from '../types';

/** The bundled FreeLLMAPI (desktop only). */
export interface SupervisorLike {
  state: string;
  port: number;
  error: string | null;
  available: boolean;
  version: { commit?: string } | null;
  endpoint(): { baseUrl: string; apiKey: string } | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  regenerateKey(): Promise<void>;
  providers(): Promise<unknown>;
  recentLog(): string[];
  on(ev: 'change', fn: () => void): unknown;
}

/** Tasks and remote tabs in a hidden browser (desktop only). */
export interface AgentLike {
  start(d: DeviceRecord, goal: string): AgentTaskView;
  list(d: DeviceRecord): AgentTaskView[];
  cancel(d: DeviceRecord, id: string): boolean;
  answer(d: DeviceRecord, id: string, promptId: string, ok: boolean, value: string | undefined, remember: boolean): boolean;
  frame(d: DeviceRecord, id: string): Promise<unknown>;
  input(d: DeviceRecord, id: string, p: { kind: string; x?: number; y?: number; text?: string; key?: string; url?: string }): boolean;
  forgetPasswords(d: DeviceRecord): number;
  openRemote(d: DeviceRecord, url: string, internetDenied: { code: string; message: string } | null): AgentTaskView;
  dropDevice(id: string): Promise<void>;
  shutdown(): void;
}

export interface SearchLike {
  search(d: DeviceRecord, q: string, engine: Engine, page: number): Promise<SearchResponse>;
  shutdown?(): void;
}

/** What the surrounding app provides. Everything is optional except the basics. */
export interface MasterHost {
  version: string;
  dataDir: string;
  secrets: SecretStore;
  /** extras created once the core exists (they need its AI and gateway) */
  attach?(core: MasterCore): { supervisor?: SupervisorLike; agents?: AgentLike; search?: SearchLike };
  clipboard?: { write(text: string): void; read(): string | Promise<string>; clear(): void };
  openPath?(p: string): void;
  setAutoStart?(on: boolean): void;
  confirm?(message: string, detail?: string): Promise<boolean>;
  show?(): void;
  quit(): void;
  openFreeLlmDashboard?(): void;
}

const NO_SUPERVISOR: SupervisorLike = {
  state: 'off',
  port: 0,
  error: null,
  available: false,
  version: null,
  endpoint: () => null,
  start: async () => {},
  stop: async () => {},
  restart: async () => {},
  regenerateKey: async () => {
    throw new Error('There is no built-in FreeLLMAPI on this master.');
  },
  providers: async () => [],
  recentLog: () => [],
  on: () => undefined,
};

type Denial = { code: string; message: string };
const refuse = (d: Denial) => Object.assign(new Error(d.message), { code: d.code });
const str = (v: unknown, max = 300): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid value.');
  return v;
};
const strList = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length > 500) throw new Error('Invalid list.');
  return v.map((x) => str(x, 200));
};

/** Methods that only read or that manage the lock itself. Everything else needs an unlocked dashboard. */
const OPEN_METHODS = new Set(['state', 'unlock', 'lock', 'show', 'events']);

export class MasterCore extends EventEmitter {
  config!: ConfigStore;
  devices!: DeviceRegistry;
  ai!: AiService;
  gateway!: GatewayServer;
  readonly advertiser = new Advertiser();
  readonly portMapper: PortMapper;
  supervisor: SupervisorLike = NO_SUPERVISOR;
  agents: AgentLike | null = null;
  search: SearchLike = { search: (_d, q, _e, page) => httpSearch(q, page) };
  readonly history = { up: Array<number>(60).fill(0), down: Array<number>(60).fill(0) };
  private handlers: Record<string, (...args: any[]) => unknown> = {};
  private advertKey = '';
  private unlockedUntil = 0;
  private pushQueued = false;

  constructor(readonly host: MasterHost) {
    super();
    this.portMapper = new PortMapper(() => {
      this.gateway?.pushStateAll();
      this.changed();
    });
  }

  get secrets(): SecretStore {
    return this.host.secrets;
  }

  async init(): Promise<void> {
    const { dataDir } = this.host;
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    this.config = new ConfigStore(dataDir);
    this.devices = new DeviceRegistry(dataDir);
    const tls = await loadOrCreateTls(dataDir, this.secrets);
    this.migrateAiConfig();
    this.ai = new AiService({ endpoints: () => this.aiEndpoints() }, () => this.config.value, (lvl, msg) => this.gateway?.log(lvl, msg));
    this.gateway = new GatewayServer({
      dataDir,
      config: this.config,
      devices: this.devices,
      ai: this.ai,
      tls,
      version: this.host.version,
      rpcHandler: (d, m, p) => this.rpc(d, m, p),
      agentsFor: (d) => !!this.agents && this.agentDenied(d, true) === null,
      extraRoutes: () => (this.portMapper.status.state === 'mapped' && this.portMapper.status.externalIp ? [`${this.portMapper.status.externalIp}:${this.portMapper.status.port}`] : []),
    });
    const extras = this.host.attach?.(this) ?? {};
    if (extras.supervisor) this.supervisor = extras.supervisor;
    if (extras.agents) this.agents = extras.agents;
    if (extras.search) this.search = extras.search;

    this.supervisor.on('change', () => {
      void this.ai.refresh();
      this.changed();
    });
    this.ai.on('change', () => this.changed());
    this.gateway.on('change', () => {
      this.syncAdvertiser();
      this.syncPortMapping();
      this.changed();
    });
    this.gateway.on('log', () => this.changed());
    this.gateway.on('tick', () => {
      const st = this.gateway.stats();
      this.history.up.push(st.bpsUp);
      this.history.down.push(st.bpsDown);
      this.history.up.shift();
      this.history.down.shift();
      this.emit('tick');
    });
    this.gateway.on('pairing-request', (d: { name: string; pairingCode: string }) => {
      this.emit('pairing-request', d);
      this.changed();
    });
    this.handlers = this.buildHandlers();
  }

  async start(): Promise<void> {
    await this.gateway.start();
    this.ai.start();
    if (this.config.value.ai.builtin) void this.supervisor.start();
    this.syncAdvertiser();
    this.syncPortMapping();
  }

  async stop(): Promise<void> {
    this.advertiser.stop();
    try {
      this.agents?.shutdown();
      this.search.shutdown?.();
      await this.portMapper.disable();
      await this.gateway.stop();
      this.ai.stop();
      await this.supervisor.stop();
    } catch {
      /* shutting down anyway */
    }
  }

  /** Debounced "the snapshot changed" signal for hosts. */
  changed(): void {
    if (this.pushQueued) return;
    this.pushQueued = true;
    setTimeout(() => {
      this.pushQueued = false;
      this.emit('state');
    }, 60);
  }

  // ------------------------------------------------------------ dashboard entry point
  isLocked(): boolean {
    return !!this.config.value.pinHash && Date.now() > this.unlockedUntil;
  }

  async invoke(method: unknown, args: unknown[]): Promise<InvokeResult> {
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(this.handlers, method)) return { ok: false, error: 'Unknown action.' };
    if (!OPEN_METHODS.has(method) && this.isLocked()) return { ok: false, error: 'The dashboard is locked. Enter your PIN.' };
    try {
      const data = await this.handlers[method](...args);
      if (this.config.value.pinHash && Date.now() <= this.unlockedUntil) this.unlockedUntil = Date.now() + 10 * 60_000;
      this.changed();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'Something went wrong.' };
    }
  }

  // ------------------------------------------------------------ helpers
  private maskKey(k: string | null): string {
    if (!k) return '';
    if (k.length <= 10) return '•'.repeat(k.length);
    return `${k.slice(0, 6)}${'•'.repeat(14)}${k.slice(-4)}`;
  }

  private providerKey(id: string): string | null {
    return id === 'builtin' ? this.supervisor.endpoint()?.apiKey ?? null : this.secrets.get(`provider-key:${id}`);
  }

  /** Every AI provider the master can use right now (owner-added ones plus the optional built-in FreeLLMAPI). */
  aiEndpoints(): AiEndpoint[] {
    const out: AiEndpoint[] = [];
    for (const p of this.config.value.ai.providers) {
      const apiKey = this.secrets.get(`provider-key:${p.id}`);
      if (apiKey !== null) out.push({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey });
    }
    const b = this.config.value.ai.builtin ? this.supervisor.endpoint() : null;
    if (b) out.push({ id: 'builtin', name: 'Built-in FreeLLMAPI', baseUrl: b.baseUrl, apiKey: b.apiKey });
    return out;
  }

  /** Turn what the owner typed into a clean http(s) address (no presets: the owner always supplies it). */
  private cleanAddress(raw: unknown): string {
    let u: URL;
    try {
      u = new URL(str(raw, 300).trim());
    } catch {
      throw new Error('That address is not valid. Use the provider’s API address, starting with http:// or https://');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The address must start with http:// or https://');
    return (u.origin + u.pathname).replace(/\/+$/, '');
  }

  /** One-time move from the single "existing FreeLLMAPI" setting to the provider list. */
  private migrateAiConfig(): void {
    const a = this.config.value.ai;
    if (!a.mode) return;
    const legacyKey = this.secrets.get('external-unified-key');
    const providers = [...a.providers];
    if (a.mode === 'external' && legacyKey && a.externalUrl && !providers.some((p) => p.id === 'freellmapi')) {
      providers.push({ id: 'freellmapi', name: 'FreeLLMAPI', baseUrl: a.externalUrl });
      this.secrets.set('provider-key:freellmapi', legacyKey);
    }
    this.config.update({ ai: { builtin: a.mode === 'managed' && providers.length === 0, managedPort: a.managedPort, providers } });
  }

  syncAdvertiser(): void {
    const s = this.gateway.switches;
    const want = this.gateway.listening && s.master && s.lan && !process.env.RAVEN_BIND;
    const key = want ? `${this.config.value.serverName}|${this.config.value.port}` : '';
    if (key === this.advertKey) return;
    this.advertKey = key;
    if (want) this.advertiser.start(this.config.value.serverName, this.config.value.port, this.gateway.fingerprint);
    else this.advertiser.stop();
  }

  /** Remote access on: ask the router to forward the gateway port. Off: remove it. */
  syncPortMapping(): void {
    const sw = this.config.value.switches;
    if (sw.master && sw.remote && process.env.RAVEN_NO_UPNP !== '1') void this.portMapper.enable(this.config.value.port);
    else if (this.portMapper.status.state !== 'off') void this.portMapper.disable();
  }

  /** Why a device may not use the assistant router (needsInternet=false) or agent tasks (true); null = allowed. */
  agentDenied(d: DeviceRecord, needsInternet: boolean): Denial | null {
    const sw = this.config.value.switches;
    if (!sw.master || sw.maintenance) return { code: 'server_unreachable', message: 'The master server is paused.' };
    if (!sw.ai) return { code: 'ai_gateway_disabled', message: 'The AI gateway is off on the master.' };
    if (!d.ai) return { code: 'ai_not_permitted', message: 'This device may not use the AI.' };
    if (needsInternet) return this.webDenied(d);
    return null;
  }

  /** Web on the master (search, remote tabs) needs internet rights only, not AI. */
  webDenied(d: DeviceRecord): Denial | null {
    const sw = this.config.value.switches;
    if (!sw.master || sw.maintenance) return { code: 'server_unreachable', message: 'The master server is paused.' };
    if (!sw.internet) return { code: 'internet_gateway_disabled', message: 'The internet gateway is off on the master.' };
    if (!d.internet) return { code: 'internet_not_permitted', message: 'This device may not use the internet.' };
    if (this.gateway && !this.gateway.masterOnline) return { code: 'server_unreachable', message: 'The master has no internet right now.' };
    return null;
  }

  private needAgents(): AgentLike {
    if (!this.agents) throw Object.assign(new Error('Tasks and remote tabs need the desktop master (Windows or Mac). This master runs on a phone or server.'), { code: 'bad_request' });
    return this.agents;
  }

  /** Device requests that arrive over the gateway (beyond browsing and AI streams). */
  private async rpc(d: DeviceRecord, method: string, params: unknown): Promise<unknown> {
    const p = isPlainObject(params) ? (params as Record<string, unknown>) : {};
    const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    switch (method) {
      case 'route': {
        const no = this.agentDenied(d, false);
        if (no) throw refuse(no);
        return routeInput(this.ai, d, s(p.text, 2000), !!this.agents && this.agentDenied(d, true) === null) satisfies Promise<RouteDecision>;
      }
      case 'agentStart':
        return this.needAgents().start(d, s(p.goal, 1000));
      case 'agentList':
        return this.agents ? this.agents.list(d) : [];
      case 'agentCancel':
        return this.needAgents().cancel(d, s(p.id, 40));
      case 'agentAnswer':
        return this.needAgents().answer(d, s(p.id, 40), s(p.promptId, 40), p.ok === true, typeof p.value === 'string' ? p.value : undefined, p.remember === true);
      case 'agentFrame':
        return this.needAgents().frame(d, s(p.id, 40));
      case 'agentInput':
        return this.needAgents().input(d, s(p.id, 40), { kind: s(p.kind, 10), x: typeof p.x === 'number' ? p.x : undefined, y: typeof p.y === 'number' ? p.y : undefined, text: typeof p.text === 'string' ? p.text : undefined, key: typeof p.key === 'string' ? p.key : undefined, url: typeof p.url === 'string' ? p.url.slice(0, 2000) : undefined });
      case 'agentForgetPasswords':
        return this.agents ? this.agents.forgetPasswords(d) : 0;
      case 'search': {
        const no = this.webDenied(d);
        if (no) throw refuse(no);
        const eng = (['google', 'duckduckgo', 'bing', 'brave'] as const).includes(p.engine as Engine) ? (p.engine as Engine) : 'google';
        return this.search.search(d, s(p.q, 400), eng, typeof p.page === 'number' ? p.page : 0);
      }
      case 'remoteOpen':
        return this.needAgents().openRemote(d, s(p.url, 2000), this.webDenied(d));
      default:
        throw Object.assign(new Error('Unknown request.'), { code: 'bad_request' });
    }
  }

  // ------------------------------------------------------------ dashboard snapshot
  snapshot(): MasterSnapshot {
    const c = this.config.value;
    const ai = this.ai;
    const sup = this.supervisor;
    const status = new Map(ai.providerStatus().map((x) => [x.id, x]));
    const listed = [...c.ai.providers, ...(c.ai.builtin ? [{ id: 'builtin', name: 'Built-in FreeLLMAPI', baseUrl: '' }] : [])];
    return {
      version: this.host.version,
      locked: this.isLocked(),
      hasPin: !!c.pinHash,
      switches: this.gateway.switches,
      stats: this.gateway.stats(),
      devices: this.gateway.listDevices(),
      models: ai.models(),
      aliases: ai.aliases(),
      config: {
        serverName: c.serverName,
        port: c.port,
        drainPolicy: c.drainPolicy,
        remoteHosts: c.remoteHosts,
        remoteEndpoint: c.remoteEndpoint,
        lanAllowlist: c.lanAllowlist,
        maxClients: c.maxClients,
        restoreSwitches: c.restoreSwitches,
        minimizeToTray: c.minimizeToTray,
        autoStart: c.autoStart,
        latestBrowserVersion: c.latestBrowserVersion,
        autoApproveUntil: c.autoApproveUntil,
        models: c.models,
        setupDone: c.setupDone,
      },
      ai: {
        health: ai.health,
        lastError: ai.lastError,
        builtin: c.ai.builtin,
        providers: listed.map((p) => {
          const st = status.get(p.id);
          return {
            id: p.id,
            name: p.name,
            address: p.baseUrl,
            keyMasked: this.maskKey(this.providerKey(p.id)),
            health: st ? st.health : p.id === 'builtin' && sup.state !== 'running' ? ('starting' as const) : ('down' as const),
            error: st?.error ?? (p.id === 'builtin' ? sup.error : null),
            models: st?.models ?? 0,
          };
        }),
        managed: { state: sup.state, port: sup.port, error: sup.error, available: sup.available, commit: sup.version?.commit ?? null },
        totalRequests: ai.totalRequests,
        totalErrors: ai.totalErrors,
      },
      remote: { ...this.portMapper.status, externalIp: this.portMapper.status.externalIp ? 'set' : null },
      host: { agents: !!this.agents, builtinAi: sup.available, desktop: !!this.host.show },
      dataDir: this.host.dataDir,
      history: this.history,
      events: this.gateway.recentEvents(undefined, 120),
    };
  }

  // ------------------------------------------------------------ dashboard actions
  private buildHandlers(): Record<string, (...args: any[]) => unknown> {
    const { config, gateway, ai, secrets, host } = this;
    const patchModels = (p: Partial<MasterConfig['models']>) => {
      config.update({ models: { ...config.value.models, ...p } });
      gateway.pushStateAll();
    };
    return {
      state: () => this.snapshot(),
      events: (deviceId?: unknown) => gateway.recentEvents(typeof deviceId === 'string' ? deviceId : undefined, 200),
      unlock: (pin: unknown) => {
        const h = config.value.pinHash;
        if (!h) return true;
        if (!verifyPin(str(pin, 64), h)) {
          gateway.log('security', 'Wrong dashboard PIN entered.');
          throw new Error('Wrong PIN.');
        }
        this.unlockedUntil = Date.now() + 10 * 60_000;
        return true;
      },
      lock: () => {
        this.unlockedUntil = 0;
        return true;
      },
      setPin: (next: unknown, current: unknown) => {
        const h = config.value.pinHash;
        if (h && !verifyPin(str(current ?? '', 64), h)) throw new Error('Current PIN is wrong.');
        if (next === null || next === '') {
          config.update({ pinHash: null });
          gateway.log('security', 'Dashboard PIN removed.');
        } else {
          const p = str(next, 64);
          if (p.length < 4) throw new Error('Use at least 4 characters.');
          config.update({ pinHash: hashPin(p) });
          this.unlockedUntil = Date.now() + 10 * 60_000;
          gateway.log('security', 'Dashboard PIN set.');
        }
        return true;
      },

      // --- power ---
      setSwitches: async (patch: unknown) => {
        if (!isPlainObject(patch)) throw new Error('Invalid switches.');
        const clean: Partial<ServiceSwitches> = {};
        for (const k of Object.keys(DEFAULT_SWITCHES) as (keyof ServiceSwitches)[]) {
          if (typeof patch[k] === 'boolean') clean[k] = patch[k] as boolean;
        }
        await gateway.setSwitches(clean);
        this.syncAdvertiser();
        return gateway.switches;
      },
      setAutoStart: (on: unknown) => {
        config.update({ autoStart: on === true });
        host.setAutoStart?.(on === true);
        return true;
      },
      autoApprove: (minutes: unknown) => {
        const m = typeof minutes === 'number' ? Math.max(0, Math.min(60, minutes)) : 0;
        config.update({ autoApproveUntil: m > 0 ? Date.now() + m * 60_000 : 0 });
        gateway.log('security', m > 0 ? `Temporary LAN auto-approve enabled for ${m} minute(s).` : 'Temporary LAN auto-approve turned off.');
        return true;
      },
      disconnectAll: () => gateway.disconnectAll(),

      // --- devices ---
      approveDevice: (id: unknown) => gateway.approveDevice(str(id, 60)),
      revokeDevice: (id: unknown) => {
        const r = gateway.revokeDevice(str(id, 60));
        void this.agents?.dropDevice(str(id, 60));
        return r;
      },
      suspendDevice: (id: unknown, on: unknown) => gateway.suspendDevice(str(id, 60), on === true),
      disconnectDevice: (id: unknown) => gateway.disconnectDevice(str(id, 60)),
      removeDevice: (id: unknown) => {
        const r = gateway.removeDevice(str(id, 60));
        void this.agents?.dropDevice(str(id, 60));
        return r;
      },
      removeExpired: () => gateway.removeExpiredDevices(),
      updateDevice: (id: unknown, patch: unknown) => {
        if (!isPlainObject(patch)) throw new Error('Invalid device settings.');
        const p: any = {};
        if (typeof patch.name === 'string') p.name = str(patch.name, 60);
        if (typeof patch.internet === 'boolean') p.internet = patch.internet;
        if (typeof patch.ai === 'boolean') p.ai = patch.ai;
        if (patch.allowedModels === null) p.allowedModels = null;
        else if (Array.isArray(patch.allowedModels)) p.allowedModels = strList(patch.allowedModels);
        if (patch.defaultModel === null) p.defaultModel = null;
        else if (typeof patch.defaultModel === 'string') p.defaultModel = str(patch.defaultModel, 200);
        if (isPlainObject(patch.limits)) p.limits = patch.limits;
        return gateway.updateDevice(str(id, 60), p);
      },

      // --- models ---
      setModelEnabled: (id: unknown, on: unknown) => {
        const m = str(id, 200);
        const set = new Set(config.value.models.disabled);
        if (on === true) set.delete(m);
        else set.add(m);
        patchModels({ disabled: [...set] });
        gateway.log('security', `Model ${m} ${on === true ? 'enabled' : 'disabled'} globally.`);
        return true;
      },
      setDefaultModel: (id: unknown) => (patchModels({ defaultModel: id === null ? null : str(id, 200) }), true),
      setCodingModel: (id: unknown) => (patchModels({ codingModel: id === null ? null : str(id, 200) }), true),
      setFallbacks: (ids: unknown) => (patchModels({ fallbacks: strList(ids) }), true),
      setModelRate: (id: unknown, perMinute: unknown) => {
        const m = str(id, 200);
        const pm = { ...config.value.models.perMinute };
        if (typeof perMinute === 'number' && perMinute > 0) pm[m] = Math.floor(perMinute);
        else delete pm[m];
        patchModels({ perMinute: pm });
        return true;
      },

      // --- AI providers ---
      aiRefresh: async () => {
        await ai.refresh();
        return { health: ai.health, error: ai.lastError, models: ai.models().length };
      },
      /** Add a provider: validated against its /models list before anything is saved. */
      aiAddProvider: async (name: unknown, address: unknown, key: unknown) => {
        const n = str(name ?? '', 40).trim() || 'Provider';
        const base = this.cleanAddress(address);
        const k = str(key ?? '', 500).trim();
        if (!k) throw new Error('Paste the API key.');
        const probe = await AiService.probe(base, k);
        if (!probe.ok) throw new Error(`Not saved. ${probe.error ?? 'Validation failed.'}`);
        const id = `${n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider'}-${Date.now().toString(36).slice(-4)}`;
        secrets.set(`provider-key:${id}`, k);
        config.update({ ai: { ...config.value.ai, providers: [...config.value.ai.providers, { id, name: n, baseUrl: base }] } });
        await ai.refresh();
        gateway.log('security', `AI provider "${n}" added (${probe.models} models).`);
        return { id, models: probe.models };
      },
      /** Change a provider's name, address or key; the old settings stay if the new ones do not validate. */
      aiUpdateProvider: async (id: unknown, patch: unknown) => {
        const pid = str(id, 60);
        if (!isPlainObject(patch)) throw new Error('Invalid change.');
        const cur = config.value.ai.providers.find((p) => p.id === pid);
        if (!cur) throw new Error('That provider is gone.');
        const base = typeof patch.address === 'string' && patch.address.trim() ? this.cleanAddress(patch.address) : cur.baseUrl;
        const k = typeof patch.key === 'string' && patch.key.trim() ? str(patch.key.trim(), 500) : secrets.get(`provider-key:${pid}`);
        if (!k) throw new Error('Paste the API key.');
        const probe = await AiService.probe(base, k);
        if (!probe.ok) throw new Error(`Not saved. ${probe.error ?? 'Validation failed.'} The previous settings are unchanged.`);
        secrets.set(`provider-key:${pid}`, k);
        const nm = typeof patch.name === 'string' && patch.name.trim() ? str(patch.name.trim(), 40) : cur.name;
        config.update({ ai: { ...config.value.ai, providers: config.value.ai.providers.map((p) => (p.id === pid ? { id: pid, name: nm, baseUrl: base } : p)) } });
        await ai.refresh();
        gateway.log('security', `AI provider "${nm}" updated.`);
        return { models: probe.models };
      },
      aiRemoveProvider: async (id: unknown) => {
        const pid = str(id, 60);
        const cur = config.value.ai.providers.find((p) => p.id === pid);
        if (!cur) return false;
        config.update({ ai: { ...config.value.ai, providers: config.value.ai.providers.filter((p) => p.id !== pid) } });
        secrets.set(`provider-key:${pid}`, null);
        await ai.refresh();
        gateway.log('security', `AI provider "${cur.name}" removed.`);
        return true;
      },
      aiSetBuiltin: async (on: unknown) => {
        if (on === true && !this.supervisor.available) throw new Error('This master has no built-in FreeLLMAPI. Add a provider with its address and key instead.');
        config.update({ ai: { ...config.value.ai, builtin: on === true } });
        if (on === true) await this.supervisor.start();
        else await this.supervisor.stop();
        await ai.refresh();
        gateway.log('info', `Built-in FreeLLMAPI turned ${on === true ? 'on' : 'off'}.`);
        return true;
      },
      aiValidate: async (id: unknown) => {
        const ep = this.aiEndpoints().find((e) => e.id === id);
        if (!ep) throw new Error('That provider is not set up.');
        const probe = await AiService.probe(ep.baseUrl, ep.apiKey);
        if (!probe.ok) throw new Error(probe.error ?? 'Validation failed.');
        return { models: probe.models };
      },
      aiRevealKey: (id: unknown, pin: unknown) => {
        const h = config.value.pinHash;
        if (h && !verifyPin(str(pin ?? '', 64), h)) throw new Error('Enter the dashboard PIN to reveal the key.');
        const k = this.providerKey(str(id, 60));
        if (!k) throw new Error('No key is saved for that provider.');
        gateway.log('security', 'An AI provider key was revealed on the dashboard.');
        return k;
      },
      aiCopyKey: (id: unknown, pin: unknown) => {
        const h = config.value.pinHash;
        if (h && !verifyPin(str(pin ?? '', 64), h)) throw new Error('Enter the dashboard PIN to copy the key.');
        const k = this.providerKey(str(id, 60));
        if (!k) throw new Error('No key is saved for that provider.');
        const cb = host.clipboard;
        if (!cb) throw new Error('Copying is not available here; use Reveal instead.');
        cb.write(k);
        setTimeout(() => {
          void Promise.resolve()
            .then(() => cb.read())
            .then((t) => t === k && cb.clear())
            .catch(() => {});
        }, 30_000);
        gateway.log('security', 'An AI provider key was copied (clipboard cleared after 30 seconds).');
        return true;
      },
      aiRegenerateKey: async () => {
        if (!config.value.ai.builtin) throw new Error('Only the built-in FreeLLMAPI key can be regenerated here. For other providers, create a new key on their site and paste it.');
        await this.supervisor.regenerateKey();
        await ai.refresh();
        if (ai.health !== 'ok') throw new Error(`Key regenerated but verification failed: ${ai.lastError ?? 'unknown error'}`);
        gateway.log('security', 'Built-in FreeLLMAPI key regenerated; no device needs an update.');
        return true;
      },
      aiRestartManaged: async () => {
        await this.supervisor.restart();
        await ai.refresh();
        return true;
      },
      aiBuiltinProviders: async () => (config.value.ai.builtin && this.supervisor.state === 'running' ? this.supervisor.providers() : []),
      aiOpenDashboard: () => {
        if (!host.openFreeLlmDashboard) throw new Error('The built-in FreeLLMAPI screen is only on the desktop master.');
        host.openFreeLlmDashboard();
        return true;
      },
      aiLog: () => this.supervisor.recentLog(),

      // --- settings ---
      updateConfig: async (patch: unknown) => {
        if (!isPlainObject(patch)) throw new Error('Invalid settings.');
        const p: Partial<MasterConfig> = {};
        if (typeof patch.serverName === 'string') p.serverName = str(patch.serverName, 60);
        if (typeof patch.port === 'number') {
          if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535) throw new Error('Choose a port between 1024 and 65535.');
          p.port = patch.port;
        }
        if (patch.drainPolicy === 'cancel' || patch.drainPolicy === 'finish') p.drainPolicy = patch.drainPolicy;
        if (Array.isArray(patch.remoteHosts)) p.remoteHosts = strList(patch.remoteHosts);
        if (typeof patch.remoteEndpoint === 'string') p.remoteEndpoint = str(patch.remoteEndpoint, 300);
        if (Array.isArray(patch.lanAllowlist)) p.lanAllowlist = strList(patch.lanAllowlist);
        if (typeof patch.maxClients === 'number') p.maxClients = Math.max(1, Math.min(200, Math.floor(patch.maxClients)));
        if (typeof patch.restoreSwitches === 'boolean') p.restoreSwitches = patch.restoreSwitches;
        if (typeof patch.minimizeToTray === 'boolean') p.minimizeToTray = patch.minimizeToTray;
        if (typeof patch.setupDone === 'boolean') p.setupDone = patch.setupDone;
        if (patch.latestBrowserVersion === null || typeof patch.latestBrowserVersion === 'string') p.latestBrowserVersion = patch.latestBrowserVersion as string | null;
        const portChanged = p.port !== undefined && p.port !== config.value.port;
        config.update(p);
        if (portChanged) await gateway.rebind();
        this.syncAdvertiser();
        gateway.pushStateAll();
        return true;
      },
      openDataDir: () => {
        if (!host.openPath) throw new Error(`The data folder is ${host.dataDir}`);
        host.openPath(host.dataDir);
        return true;
      },
      openLogs: () => {
        if (!host.openPath) throw new Error(`The logs are in ${path.join(host.dataDir, 'logs')}`);
        host.openPath(path.join(host.dataDir, 'logs'));
        return true;
      },
      show: () => (host.show?.(), true),
      quit: () => (host.quit(), true),
      confirm: async (message: unknown, detail: unknown) => (host.confirm ? host.confirm(str(message, 200), typeof detail === 'string' ? str(detail, 600) : undefined) : true),
    };
  }
}
