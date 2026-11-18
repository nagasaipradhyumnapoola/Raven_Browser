// Shape of the live snapshot the dashboard renders (main -> renderer).
import type { DeviceView, ModelInfo, ServiceSwitches } from '@raven/shared';
import type { LogEvent, MasterConfig } from './core';

export interface MasterSnapshot {
  version: string;
  locked: boolean;
  hasPin: boolean;
  switches: ServiceSwitches;
  stats: {
    listening: boolean;
    listenError: string | null;
    port: number;
    addresses: string[];
    fingerprint: string;
    masterOnline: boolean;
    clients: number;
    pending: number;
    streams: number;
    aiActive: number;
    bpsUp: number;
    bpsDown: number;
    totalUp: number;
    totalDown: number;
    aiRequests: number;
    uptimeMs: number;
  };
  devices: DeviceView[];
  models: ModelInfo[];
  aliases: string[];
  config: Pick<
    MasterConfig,
    | 'serverName'
    | 'port'
    | 'drainPolicy'
    | 'remoteHosts'
    | 'remoteEndpoint'
    | 'lanAllowlist'
    | 'maxClients'
    | 'restoreSwitches'
    | 'minimizeToTray'
    | 'autoStart'
    | 'latestBrowserVersion'
    | 'autoApproveUntil'
    | 'models'
    | 'setupDone'
  >;
  ai: {
    health: 'ok' | 'down' | 'unconfigured';
    lastError: string | null;
    builtin: boolean;
    providers: { id: string; name: string; address: string; keyMasked: string; health: 'ok' | 'down' | 'starting'; error: string | null; models: number }[];
    managed: { state: string; port: number; error: string | null; available: boolean; commit: string | null };
    totalRequests: number;
    totalErrors: number;
  };
  /** router port forwarding for Remote access (public address itself is never shown) */
  remote: { state: 'off' | 'searching' | 'mapped' | 'unsupported' | 'error'; externalIp: string | null; port: number | null; error: string | null };
  /** what this master can do: hidden-browser tasks (desktop), bundled FreeLLMAPI, a desktop window */
  host: { agents: boolean; builtinAi: boolean; desktop: boolean };
  dataDir: string;
  history: { up: number[]; down: number[] };
  events: LogEvent[];
}

export interface InvokeResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}
