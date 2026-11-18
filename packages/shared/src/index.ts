// Shared types and constants for Raven Browser and Raven Master Server.

export const PRODUCT = {
  browserName: 'Raven Browser',
  serverName: 'Raven Master Server',
  protocolVersion: 1,
  mdnsType: 'ravengw',
  defaultGatewayPort: 47800,
} as const;

// ---------- Connection state machine (browser side) ----------
export type ConnState =
  | 'discovering'
  | 'awaiting_authorization'
  | 'connecting'
  | 'gateway_online'
  | 'gateway_degraded'
  | 'ai_unavailable'
  | 'server_unreachable'
  | 'direct'
  | 'offline';

// ---------- Structured error codes ----------
export type ErrCode =
  | 'server_unreachable'
  | 'internet_gateway_disabled'
  | 'ai_gateway_disabled'
  | 'device_unauthorized'
  | 'device_pending'
  | 'device_revoked'
  | 'device_suspended'
  | 'internet_not_permitted'
  | 'ai_not_permitted'
  | 'model_not_permitted'
  | 'model_unavailable'
  | 'no_permitted_model'
  | 'provider_rate_limited'
  | 'providers_unavailable'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'too_many_connections'
  | 'payload_too_large'
  | 'blocked_destination'
  | 'dns_failure'
  | 'connect_failed'
  | 'connect_timeout'
  | 'master_no_internet'
  | 'maintenance'
  | 'ai_backend_unreachable'
  | 'bad_request'
  | 'pairing_disabled'
  | 'access_scope_disabled'
  | 'internal';

export const ERR_TEXT: Record<ErrCode, string> = {
  server_unreachable: 'Master server is unreachable.',
  internet_gateway_disabled: 'Internet gateway is turned off on the master server.',
  ai_gateway_disabled: 'AI is disabled by the master server.',
  device_unauthorized: 'This device is not authorized on the master server.',
  device_pending: 'Waiting for the server owner to approve this device.',
  device_revoked: 'This device was revoked by the server owner.',
  device_suspended: 'This device is temporarily suspended by the server owner.',
  internet_not_permitted: 'Internet access is not permitted for this device.',
  ai_not_permitted: 'AI access is not permitted for this device.',
  model_not_permitted: 'That AI model is not permitted for this device.',
  model_unavailable: 'That AI model is temporarily unavailable.',
  no_permitted_model: 'No permitted AI model is available right now.',
  provider_rate_limited: 'The AI provider rate limit was reached. Try again shortly.',
  providers_unavailable: 'All configured AI providers are unavailable.',
  rate_limited: 'Request limit reached for this device. Try again shortly.',
  quota_exceeded: 'Usage allowance for this device is used up.',
  too_many_connections: 'Too many simultaneous connections for this device.',
  payload_too_large: 'The request is too large.',
  blocked_destination: 'The master server does not allow access to that address.',
  dns_failure: 'The site name could not be resolved.',
  connect_failed: 'The site could not be reached from the master server.',
  connect_timeout: 'The site took too long to respond.',
  master_no_internet: 'The master laptop has no internet connection.',
  maintenance: 'The master server is in maintenance mode.',
  ai_backend_unreachable: 'FreeLLMAPI is not responding on the master server.',
  bad_request: 'The request was malformed.',
  pairing_disabled: 'New device pairing is turned off on the master server.',
  access_scope_disabled: 'This kind of connection (LAN or remote) is turned off on the master server.',
  internal: 'Unexpected error.',
};

export class RavenError extends Error {
  code: ErrCode;
  detail?: string;
  constructor(code: ErrCode, detail?: string) {
    super(detail ? `${ERR_TEXT[code]} (${detail})` : ERR_TEXT[code]);
    this.code = code;
    this.detail = detail;
  }
}

// ---------- Devices ----------
export type DeviceStatus = 'pending' | 'approved' | 'suspended' | 'revoked';

export interface DeviceLimits {
  /** bytes per second, 0 = unlimited */
  bandwidthBps: number;
  maxConnections: number;
  maxDownloads: number;
  aiPerMinute: number;
  aiPerHour: number;
  aiPerDay: number;
  aiConcurrent: number;
  /** bytes, AI request payload */
  maxPayloadBytes: number;
  /** 0 = backend default */
  maxOutputTokens: number;
}

export const DEFAULT_LIMITS: DeviceLimits = {
  bandwidthBps: 0,
  maxConnections: 256,
  maxDownloads: 8,
  aiPerMinute: 20,
  aiPerHour: 300,
  aiPerDay: 2000,
  aiConcurrent: 2,
  maxPayloadBytes: 1024 * 1024,
  maxOutputTokens: 0,
};

export interface DeviceRecord {
  id: string;
  name: string;
  /** Ed25519 public key, SPKI DER base64 */
  publicKey: string;
  status: DeviceStatus;
  internet: boolean;
  ai: boolean;
  /** null = every globally enabled model */
  allowedModels: string[] | null;
  defaultModel: string | null;
  limits: DeviceLimits;
  createdAt: number;
  approvedAt: number | null;
  lastSeen: number | null;
  lastIp: string | null;
  lastScope: 'lan' | 'remote' | null;
  lastError: string | null;
  totalUp: number;
  totalDown: number;
  aiRequests: number;
  pairingCode: string;
}

/** Live view of a device shown in the dashboard. */
export interface DeviceView extends DeviceRecord {
  online: boolean;
  activeStreams: number;
  activeAi: number;
  bpsUp: number;
  bpsDown: number;
  aiUsage: { minute: number; hour: number; day: number };
}

// ---------- Service state ----------
export interface ServiceSwitches {
  master: boolean;
  internet: boolean;
  ai: boolean;
  lan: boolean;
  remote: boolean;
  pairing: boolean;
  maintenance: boolean;
}

export const DEFAULT_SWITCHES: ServiceSwitches = {
  master: true,
  internet: true,
  ai: true,
  lan: true,
  remote: false,
  pairing: true,
  maintenance: false,
};

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  available: boolean;
  capabilities: string[];
  /** globally enabled in the master gateway */
  enabled: boolean;
  recentFailures: number;
  lastError: string | null;
  status: string;
}

/** What the server tells a connected browser about its current rights. */
export interface ClientState {
  serverName: string;
  serverVersion: string;
  deviceStatus: DeviceStatus;
  services: { master: boolean; internet: boolean; ai: boolean; maintenance: boolean };
  permissions: { internet: boolean; ai: boolean };
  masterOnline: boolean;
  aiBackend: 'ok' | 'down' | 'unconfigured';
  /** models this device may request ("auto" handled separately) */
  models: { id: string; name: string; provider: string; available: boolean }[];
  defaultModel: string | null;
  autoAllowed: boolean;
  limits: DeviceLimits;
  aiUsage: { minute: number; hour: number; day: number };
  latestBrowserVersion: string | null;
  /** the master can run tasks for this device in its own hidden browser */
  agents?: boolean;
  /** other addresses this master can be reached at (LAN, public, tunnel); host:port */
  routes?: string[];
}

/** What the assistant router decided to do with something the user typed. */
export type RouteDecision =
  | { action: 'answer' }
  | { action: 'open'; url: string }
  | { action: 'search'; query: string }
  | { action: 'task'; goal: string };

export type AgentTaskStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/** Something an agent task needs from the person at the browser. */
export interface AgentPrompt {
  id: string;
  /** password: typed secret, filled on the master, never shown to the AI. text: any answer. confirm: approve an irreversible step */
  kind: 'password' | 'text' | 'confirm';
  title: string;
  detail: string;
  site: string;
  /** a password may be remembered on the master (encrypted) for this site */
  canRemember: boolean;
}

export interface AgentTaskView {
  id: string;
  goal: string;
  status: AgentTaskStatus;
  site: string;
  steps: { ts: number; text: string }[];
  answer: string | null;
  prompt: AgentPrompt | null;
  created: number;
  /** 'remote' = a master page the person uses directly (no AI) */
  kind?: 'task' | 'remote';
  url?: string;
  title?: string;
}

/** Event pushed from the master to a browser. */
export type AgentEvent = { kind: 'agent'; task: AgentTaskView };

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  messages: AiMessage[];
  /** "auto" or an explicit model id */
  model: string;
  profile: 'general' | 'coding';
  maxTokens?: number;
}

export interface AiMeta {
  model: string | null;
  provider: string | null;
  routedVia: string | null;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
