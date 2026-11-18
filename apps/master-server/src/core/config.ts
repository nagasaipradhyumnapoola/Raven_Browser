// Master-server configuration persisted as a plain JSON file (atomic writes).
import path from 'node:path';
import { DEFAULT_SWITCHES, PRODUCT, isPlainObject, type ServiceSwitches } from '@raven/shared';
import { atomicWriteSync, readJsonSync } from '../../../../packages/local-memory/src/fsutil';

export interface MasterConfig {
  serverName: string;
  port: number;
  switches: ServiceSwitches;
  /** restore the last switch positions at startup (false = start with safe defaults) */
  restoreSwitches: boolean;
  /** epoch ms until which new LAN devices are approved automatically (0 = off) */
  autoApproveUntil: number;
  /** what happens to active transfers when a service or permission is turned off */
  drainPolicy: 'cancel' | 'finish';
  /** public hostnames clients may use with CA-validated TLS (remote tunnel / reverse proxy) */
  remoteHosts: string[];
  /** note shown to the owner: externally reachable address clients should use */
  remoteEndpoint: string;
  /** private targets the owner explicitly allows through the gateway: "host", "ip" or "host:port" */
  lanAllowlist: string[];
  blockedPorts: number[];
  maxClients: number;
  models: {
    disabled: string[];
    defaultModel: string | null;
    codingModel: string | null;
    fallbacks: string[];
    /** global per-model requests per minute (0/absent = unlimited) */
    perMinute: Record<string, number>;
  };
  ai: {
    /** run the bundled FreeLLMAPI inside the app as one more provider */
    builtin: boolean;
    managedPort: number;
    /** OpenAI-compatible providers the owner added; keys live in secret storage as provider-key:<id> */
    providers: { id: string; name: string; baseUrl: string }[];
    /** legacy (before multi-provider); read once for migration */
    mode?: 'managed' | 'external';
    externalUrl?: string;
  };
  autoStart: boolean;
  minimizeToTray: boolean;
  pinHash: string | null;
  latestBrowserVersion: string | null;
  setupDone: boolean;
}

export function defaultConfig(): MasterConfig {
  return {
    serverName: 'Raven Master',
    port: PRODUCT.defaultGatewayPort,
    switches: { ...DEFAULT_SWITCHES },
    restoreSwitches: true,
    autoApproveUntil: 0,
    drainPolicy: 'cancel',
    remoteHosts: [],
    remoteEndpoint: '',
    lanAllowlist: [],
    blockedPorts: [25],
    maxClients: 32,
    models: { disabled: [], defaultModel: null, codingModel: null, fallbacks: [], perMinute: {} },
    ai: { builtin: false, managedPort: 47811, providers: [] },
    autoStart: false,
    minimizeToTray: true,
    pinHash: null,
    latestBrowserVersion: null,
    setupDone: false,
  };
}

function mergeConfig(raw: unknown): MasterConfig {
  const d = defaultConfig();
  if (!isPlainObject(raw)) return d;
  const r = raw as Partial<MasterConfig>;
  const strArr = (v: unknown, fb: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fb);
  const sw = isPlainObject(r.switches) ? (r.switches as Partial<ServiceSwitches>) : {};
  const models = isPlainObject(r.models) ? (r.models as Partial<MasterConfig['models']>) : {};
  const ai = isPlainObject(r.ai) ? (r.ai as Partial<MasterConfig['ai']>) : {};
  const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb);
  const port = (v: unknown, fb: number) => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536 ? (v as number) : fb);
  return {
    serverName: typeof r.serverName === 'string' && r.serverName.trim() ? r.serverName.trim().slice(0, 60) : d.serverName,
    port: port(r.port, d.port),
    switches: {
      master: bool(sw.master, d.switches.master),
      internet: bool(sw.internet, d.switches.internet),
      ai: bool(sw.ai, d.switches.ai),
      lan: bool(sw.lan, d.switches.lan),
      remote: bool(sw.remote, d.switches.remote),
      pairing: bool(sw.pairing, d.switches.pairing),
      maintenance: bool(sw.maintenance, d.switches.maintenance),
    },
    restoreSwitches: bool(r.restoreSwitches, d.restoreSwitches),
    autoApproveUntil: typeof r.autoApproveUntil === 'number' ? r.autoApproveUntil : 0,
    drainPolicy: r.drainPolicy === 'finish' ? 'finish' : 'cancel',
    remoteHosts: strArr(r.remoteHosts, []).map((h) => h.toLowerCase()),
    remoteEndpoint: typeof r.remoteEndpoint === 'string' ? r.remoteEndpoint : '',
    lanAllowlist: strArr(r.lanAllowlist, []),
    blockedPorts: Array.isArray(r.blockedPorts) ? r.blockedPorts.filter((n): n is number => Number.isInteger(n)) : d.blockedPorts,
    maxClients: Number.isInteger(r.maxClients) && (r.maxClients as number) > 0 ? (r.maxClients as number) : d.maxClients,
    models: {
      disabled: strArr(models.disabled, []),
      defaultModel: typeof models.defaultModel === 'string' ? models.defaultModel : null,
      codingModel: typeof models.codingModel === 'string' ? models.codingModel : null,
      fallbacks: strArr(models.fallbacks, []),
      perMinute: isPlainObject(models.perMinute)
        ? Object.fromEntries(Object.entries(models.perMinute).filter(([, v]) => typeof v === 'number' && v > 0)) as Record<string, number>
        : {},
    },
    ai: {
      builtin: typeof ai.builtin === 'boolean' ? ai.builtin : ai.mode === 'managed',
      managedPort: port(ai.managedPort, d.ai.managedPort),
      providers: Array.isArray(ai.providers)
        ? ai.providers
            .filter((x: any) => x && typeof x.id === 'string' && typeof x.baseUrl === 'string')
            .map((x: any) => ({ id: String(x.id).slice(0, 40), name: String(x.name ?? 'Provider').slice(0, 40), baseUrl: String(x.baseUrl).slice(0, 300) }))
        : [],
      ...(ai.mode ? { mode: ai.mode } : {}),
      ...(typeof ai.externalUrl === 'string' ? { externalUrl: ai.externalUrl } : {}),
    },
    autoStart: bool(r.autoStart, false),
    minimizeToTray: bool(r.minimizeToTray, true),
    pinHash: typeof r.pinHash === 'string' ? r.pinHash : null,
    latestBrowserVersion: typeof r.latestBrowserVersion === 'string' ? r.latestBrowserVersion : null,
    setupDone: bool(r.setupDone, false),
  };
}

export class ConfigStore {
  private file: string;
  value: MasterConfig;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'config.json');
    this.value = mergeConfig(readJsonSync<unknown>(this.file, null));
    if (!this.value.restoreSwitches) {
      this.value.switches = { ...DEFAULT_SWITCHES };
    }
    // Maintenance mode never survives a restart silently.
    this.value.switches.maintenance = false;
  }

  save(): void {
    atomicWriteSync(this.file, JSON.stringify(this.value, null, 2));
  }

  update(patch: Partial<MasterConfig>): MasterConfig {
    this.value = mergeConfig({ ...this.value, ...patch });
    this.save();
    return this.value;
  }
}

/** Secrets live outside config.json, behind OS-backed encryption supplied by the host app. */
export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string | null): void;
}

export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  get(name: string): string | null {
    return this.m.get(name) ?? null;
  }
  set(name: string, value: string | null): void {
    if (value === null) this.m.delete(name);
    else this.m.set(name, value);
  }
}
