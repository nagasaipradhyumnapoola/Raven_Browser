// AI service: the only component that talks to AI providers. It holds every
// provider key (never sent to clients), keeps a merged live model catalog from
// all configured OpenAI-compatible providers (FreeLLMAPI, OpenAI, Groq,
// OpenRouter, Ollama, ...), and enforces global + per-device model policy on
// every request, including every fallback attempt.
import { EventEmitter } from 'node:events';
import { RavenError, type AiMeta, type AiRequest, type DeviceRecord, type ErrCode, type ModelInfo } from '@raven/shared';
import { RateWindow, redact } from '@raven/security';
import type { MasterConfig } from './config';

/** One OpenAI-compatible provider configured by the owner. */
export interface AiEndpoint {
  id: string;
  name: string;
  /** what the owner typed: with or without /v1 */
  baseUrl: string;
  apiKey: string;
}

/** Where providers come from (config + secret storage in the app, a fixture in tests). */
export interface AiBackend {
  endpoints?(): AiEndpoint[];
  /** single-endpoint form kept for simple embedders and tests */
  endpoint?(): { baseUrl: string; apiKey: string } | null;
}

interface CatalogEntry {
  /** id shown to devices and used in policy (unique across providers) */
  id: string;
  /** id the provider itself expects */
  remoteId: string;
  endpointId: string;
  name: string;
  provider: string;
  available: boolean;
  status: string;
  capabilities: string[];
  /** router alias (FreeLLMAPI auto, fusion, named chains): may resolve to ANY model */
  alias: boolean;
}

export interface EndpointStatus {
  id: string;
  name: string;
  health: 'ok' | 'down';
  error: string | null;
  models: number;
}

export type BackendHealth = 'ok' | 'down' | 'unconfigured';

interface Attempt {
  ok: boolean;
  status: number;
  code: ErrCode;
  detail: string;
  response?: Response;
}

export interface AiRun {
  meta: AiMeta;
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

/** Models that cannot hold a chat (embeddings, speech, images, moderation...). */
const NOT_CHAT = /(embed|whisper|tts|dall-e|davinci-00|babbage|moderation|transcri|speech|audio|realtime|image-gen|imagen|image-generation|rerank|text-search|guard)/i;

function mapStatus(status: number, text: string, code = ''): ErrCode {
  const t = text.toLowerCase();
  // FreeLLMAPI reports "no provider key configured" as 503 code no_providers; its text also mentions rate limits.
  if (code === 'no_providers' || t.includes('no candidate model has a configured') || t.includes('add provider api keys')) return 'providers_unavailable';
  if (status === 401 || status === 403) return 'ai_backend_unreachable';
  if (status === 429) return 'provider_rate_limited';
  if (status === 413) return 'payload_too_large';
  if (status === 400 || status === 404) {
    if (t.includes('model')) return 'model_unavailable';
    return 'bad_request';
  }
  if (/rate limit (exceeded|reached)|too many requests|quota exceeded/.test(t)) return 'provider_rate_limited';
  return 'providers_unavailable';
}

/** Candidate API roots for what the owner typed ("https://x/v1", "https://x", "https://x/openai/v1"). */
function apiRoots(baseUrl: string): string[] {
  const b = baseUrl.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
  if (/\/v\d+[a-z]*$/i.test(b)) return [b];
  return [`${b}/v1`, b];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';

export class AiService extends EventEmitter {
  private catalog: CatalogEntry[] = [];
  private roots = new Map<string, string>();
  private status: EndpointStatus[] = [];
  health: BackendHealth = 'unconfigured';
  lastError: string | null = null;
  private failures = new Map<string, { count: number; last: string }>();
  private modelWindows = new Map<string, RateWindow>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  totalRequests = 0;
  totalErrors = 0;

  constructor(
    private backend: AiBackend,
    private cfg: () => MasterConfig,
    private log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
  ) {
    super();
  }

  private endpoints(): AiEndpoint[] {
    if (this.backend.endpoints) return this.backend.endpoints();
    const one = this.backend.endpoint?.();
    return one ? [{ id: 'default', name: 'Provider', baseUrl: one.baseUrl, apiKey: one.apiKey }] : [];
  }

  start(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 45_000);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Reload the model catalog from every provider's /models endpoint. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Fetch one provider's model list, trying the API roots the typed address could mean. */
  static async listModels(baseUrl: string, apiKey: string): Promise<{ ok: true; root: string; data: any[] } | { ok: false; error: string; auth?: boolean }> {
    let lastErr = 'Not reachable.';
    for (const root of apiRoots(baseUrl)) {
      try {
        const res = await fetch(`${root}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) });
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'The API key was rejected.', auth: true };
        if (!res.ok) {
          lastErr = `HTTP ${res.status} from ${root}/models`;
          continue;
        }
        const json: any = await res.json().catch(() => null);
        const data = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : null;
        if (!data) {
          lastErr = 'That address did not return a model list. Use the provider’s OpenAI-compatible API address.';
          continue;
        }
        return { ok: true, root, data };
      } catch (e) {
        lastErr = `Not reachable: ${redact((e as Error).message)}`;
      }
    }
    return { ok: false, error: lastErr };
  }

  /** Validate an address + key without adopting it. */
  static async probe(baseUrl: string, apiKey: string): Promise<{ ok: boolean; models: number; error?: string }> {
    const r = await AiService.listModels(baseUrl, apiKey);
    return r.ok ? { ok: true, models: r.data.length } : { ok: false, models: 0, error: r.error };
  }

  private async doRefresh(): Promise<void> {
    const eps = this.endpoints();
    const before = `${this.health}|${this.catalog.map((c) => `${c.id}:${c.available}`).join(',')}`;
    if (eps.length === 0) {
      this.health = 'unconfigured';
      this.catalog = [];
      this.status = [];
      this.lastError = 'No AI provider is set up. Add one with its address and key.';
    } else {
      const results = await Promise.all(eps.map(async (ep) => ({ ep, r: await AiService.listModels(ep.baseUrl, ep.apiKey) })));
      const catalog: CatalogEntry[] = [];
      const seen = new Set<string>();
      const status: EndpointStatus[] = [];
      for (const { ep, r } of results) {
        if (!r.ok) {
          status.push({ id: ep.id, name: ep.name, health: 'down', error: r.error, models: 0 });
          continue;
        }
        this.roots.set(ep.id, r.root);
        let count = 0;
        for (const m of r.data) {
          const remoteId = typeof m === 'string' ? m : typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : null;
          if (!remoteId) continue;
          const isFreeLlm = typeof m?.execution_status === 'string' || m?.owned_by === 'freellmapi';
          // FreeLLMAPI marks real rows with execution_status; its router aliases may resolve to ANY model.
          const alias = isFreeLlm && (typeof m.execution_status !== 'string' || remoteId === 'auto' || remoteId === 'fusion' || remoteId.startsWith('auto:'));
          if (!alias && NOT_CHAT.test(remoteId)) continue;
          let id = remoteId;
          if (seen.has(id)) id = `${slug(ep.name)}:${remoteId}`;
          seen.add(id);
          catalog.push({
            id,
            remoteId,
            endpointId: ep.id,
            name: typeof m?.name === 'string' && m.name ? m.name : remoteId,
            provider: typeof m?.owned_by === 'string' && m.owned_by !== 'freellmapi' && m.owned_by !== 'system' ? `${ep.name} · ${m.owned_by}` : ep.name,
            available: m?.available !== false,
            status: typeof m?.execution_status === 'string' ? m.execution_status : m?.available === false ? String(m.unavailable_reason ?? 'unavailable') : 'ready',
            capabilities: Array.isArray(m?.supported_parameters) ? m.supported_parameters.filter((x: unknown) => typeof x === 'string') : [],
            alias,
          });
          // Count only models the provider says it can serve right now (FreeLLMAPI lists keyless ones as unavailable).
          if (!alias && m?.available !== false) count++;
        }
        status.push({ id: ep.id, name: ep.name, health: 'ok', error: null, models: count });
      }
      this.catalog = catalog;
      this.status = status;
      const okCount = status.filter((s) => s.health === 'ok').length;
      this.health = okCount > 0 ? 'ok' : 'down';
      const bad = status.filter((s) => s.health === 'down');
      this.lastError = okCount === 0 ? bad.map((b) => `${b.name}: ${b.error}`).join(' ') : bad.length ? `Not responding: ${bad.map((b) => b.name).join(', ')}.` : null;
    }
    const after = `${this.health}|${this.catalog.map((c) => `${c.id}:${c.available}`).join(',')}`;
    if (before !== after) this.emit('change');
  }

  providerStatus(): EndpointStatus[] {
    return this.status;
  }

  /** Real (non-alias) models with the master's global enable flag applied. */
  models(): ModelInfo[] {
    const disabled = new Set(this.cfg().models.disabled);
    return this.catalog
      .filter((c) => !c.alias)
      .map((c) => {
        const f = this.failures.get(c.id);
        return {
          id: c.id,
          name: c.name,
          provider: c.provider,
          available: c.available,
          capabilities: c.capabilities,
          enabled: !disabled.has(c.id),
          recentFailures: f?.count ?? 0,
          lastError: f?.last ?? null,
          status: c.status,
        };
      });
  }

  aliases(): string[] {
    return this.catalog.filter((c) => c.alias).map((c) => c.id);
  }

  /** Model ids a device is allowed to use right now (global enable ∩ device allowlist). */
  permittedFor(device: DeviceRecord): ModelInfo[] {
    const allow = device.allowedModels ? new Set(device.allowedModels) : null;
    return this.models().filter((m) => m.enabled && (!allow || allow.has(m.id)));
  }

  private routerAlias(): CatalogEntry | undefined {
    return this.catalog.find((c) => c.alias && c.remoteId === 'auto');
  }

  /**
   * A provider's own router ("auto" in FreeLLMAPI) may pick any model, so it is
   * only used for devices with no restriction at all while nothing is disabled.
   */
  autoAllowed(device: DeviceRecord): boolean {
    return !!this.routerAlias() && device.allowedModels === null && this.cfg().models.disabled.length === 0;
  }

  private noteFailure(model: string, detail: string): void {
    const f = this.failures.get(model) ?? { count: 0, last: '' };
    f.count++;
    f.last = detail.slice(0, 200);
    this.failures.set(model, f);
  }

  private modelRateOk(model: string): boolean {
    const limit = this.cfg().models.perMinute[model];
    if (!limit) return true;
    let w = this.modelWindows.get(model);
    if (!w) {
      w = new RateWindow();
      this.modelWindows.set(model, w);
    }
    if (w.count(60_000) >= limit) return false;
    w.record();
    return true;
  }

  /** Ordered list of concrete models to try for this request. Every entry is permitted. */
  private candidates(device: DeviceRecord, req: AiRequest): { list: string[]; useAuto: boolean } {
    const cfg = this.cfg();
    const permitted = this.permittedFor(device);
    const permittedIds = new Set(permitted.map((m) => m.id));
    const availableIds = new Set(permitted.filter((m) => m.available).map((m) => m.id));
    const fallbacks = cfg.models.fallbacks.filter((id) => availableIds.has(id));

    if (req.model && req.model !== 'auto') {
      if (!permittedIds.has(req.model)) {
        const known = this.catalog.some((c) => c.id === req.model);
        throw new RavenError(known ? 'model_not_permitted' : 'model_unavailable', req.model);
      }
      if (!availableIds.has(req.model) && fallbacks.length === 0) throw new RavenError('model_unavailable', req.model);
      const list = [req.model, ...fallbacks.filter((f) => f !== req.model)].filter((id) => availableIds.has(id));
      if (list.length === 0) throw new RavenError('model_unavailable', req.model);
      return { list, useAuto: false };
    }

    const preferred = [req.profile === 'coding' ? cfg.models.codingModel : null, device.defaultModel, cfg.models.defaultModel].filter(
      (id): id is string => !!id && availableIds.has(id),
    );

    if (preferred.length === 0 && this.autoAllowed(device)) return { list: [], useAuto: true };

    const ordered = [...preferred, ...fallbacks, ...permitted.filter((m) => m.available).map((m) => m.id)];
    const list = [...new Set(ordered)].slice(0, 5);
    if (list.length === 0) {
      if (this.autoAllowed(device)) return { list: [], useAuto: true };
      throw new RavenError('no_permitted_model');
    }
    return { list, useAuto: this.autoAllowed(device) };
  }

  private async attempt(entry: CatalogEntry, req: AiRequest, device: DeviceRecord, signal: AbortSignal): Promise<Attempt> {
    const ep = this.endpoints().find((e) => e.id === entry.endpointId);
    const root = this.roots.get(entry.endpointId);
    if (!ep || !root) return { ok: false, status: 0, code: 'ai_backend_unreachable', detail: 'provider not configured' };
    const body: Record<string, unknown> = { model: entry.remoteId, messages: req.messages, stream: true };
    const cap = device.limits.maxOutputTokens;
    const want = typeof req.maxTokens === 'number' && req.maxTokens > 0 ? Math.floor(req.maxTokens) : 0;
    if (cap > 0) body.max_tokens = want > 0 ? Math.min(want, cap) : cap;
    else if (want > 0) body.max_tokens = want;
    const headerTimeout = AbortSignal.timeout(75_000);
    let res: Response;
    try {
      res = await fetch(`${root}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}`, Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, headerTimeout]),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      return { ok: false, status: 0, code: 'ai_backend_unreachable', detail: redact((e as Error).message) };
    }
    if (!res.ok) {
      let text = '';
      try {
        text = (await res.text()).slice(0, 600);
      } catch {
        /* ignore */
      }
      let msg = text;
      let errCode = '';
      try {
        const j = JSON.parse(text)?.error;
        msg = j?.message ?? text;
        errCode = typeof j?.code === 'string' ? j.code : '';
      } catch {
        /* not json */
      }
      return { ok: false, status: res.status, code: mapStatus(res.status, msg, errCode), detail: redact(String(msg)).slice(0, 300) };
    }
    return { ok: true, status: res.status, code: 'internal', detail: '', response: res };
  }

  /**
   * Run one generation for a device. Throws RavenError with a structured code
   * when nothing permitted can serve it. Never falls back to a model outside
   * the device's allowlist: router answers are verified against the model the
   * provider reports it actually served.
   */
  async run(device: DeviceRecord, req: AiRequest, signal: AbortSignal): Promise<AiRun> {
    this.totalRequests++;
    if (this.health !== 'ok') await this.refresh();
    if (this.health === 'unconfigured') throw new RavenError('ai_backend_unreachable', 'No AI provider is set up on the master');
    if (this.health === 'down') throw new RavenError('ai_backend_unreachable', this.lastError ?? undefined);

    const { list, useAuto } = this.candidates(device, req);
    const permittedIds = new Set(this.permittedFor(device).map((m) => m.id));
    const plan: CatalogEntry[] = list.map((id) => this.catalog.find((c) => c.id === id)).filter((c): c is CatalogEntry => !!c);
    const router = this.routerAlias();
    if (useAuto && router) plan.push(router);
    let last: Attempt | null = null;

    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i];
      if (!entry.alias && !this.modelRateOk(entry.id)) {
        last = { ok: false, status: 429, code: 'rate_limited', detail: `per-model limit for ${entry.id}` };
        continue;
      }
      let a = await this.attempt(entry, req, device, signal);
      // One controlled retry for transient trouble on the final option.
      if (!a.ok && i === plan.length - 1 && (a.status === 0 || a.status >= 500)) {
        await new Promise((r) => setTimeout(r, 900));
        if (signal.aborted) throw new RavenError('internal', 'cancelled');
        a = await this.attempt(entry, req, device, signal);
      }
      if (!a.ok || !a.response) {
        last = a;
        if (!entry.alias) this.noteFailure(entry.id, a.detail || a.code);
        this.log('warn', `AI attempt on ${entry.id} failed: ${a.code} ${a.detail}`);
        if (a.code === 'payload_too_large' || a.code === 'bad_request') break;
        continue;
      }
      const res = a.response;
      // FreeLLMAPI reports what it actually served as `X-Routed-Via: <platform>/<model id>`.
      const routedVia = res.headers.get('x-routed-via');
      let served = res.headers.get('x-model');
      let provider = res.headers.get('x-provider');
      if (!served && routedVia && routedVia.includes('/')) {
        const cut = routedVia.indexOf('/');
        provider = provider ?? routedVia.slice(0, cut);
        served = routedVia.slice(cut + 1);
      }
      // Enforcement: a router answer from a catalog model outside the permitted set
      // is discarded before a single byte reaches the device.
      const servedKnown = served ? this.catalog.find((c) => !c.alias && c.endpointId === entry.endpointId && c.remoteId === served) : undefined;
      if (servedKnown && !permittedIds.has(servedKnown.id)) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        this.log('warn', `Blocked response from non-permitted model ${servedKnown.id} for device ${device.id}`);
        last = { ok: false, status: 403, code: 'model_not_permitted', detail: servedKnown.id };
        continue;
      }
      if (!res.body) {
        last = { ok: false, status: 502, code: 'providers_unavailable', detail: 'empty response' };
        continue;
      }
      return {
        meta: { model: entry.alias ? servedKnown?.id ?? served : entry.id, provider: provider ?? entry.provider, routedVia },
        body: res.body,
        contentType: res.headers.get('content-type') ?? 'text/event-stream',
      };
    }

    this.totalErrors++;
    if (!last) throw new RavenError('no_permitted_model');
    if (last.code === 'ai_backend_unreachable') void this.refresh();
    throw new RavenError(last.code, last.detail || undefined);
  }

  /**
   * Non-streaming completion for the master's own use (agent planning).
   * Uses the same policy as the device it acts for.
   */
  async complete(device: DeviceRecord, messages: AiRequest['messages'], signal: AbortSignal, extra: Record<string, unknown> = {}): Promise<{ text: string; model: string | null; raw: any }> {
    const run = await this.run(device, { messages, model: 'auto', profile: 'general', ...extra }, signal);
    const reader = run.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          text += j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
        } catch {
          /* partial */
        }
      }
    }
    return { text, model: run.meta.model, raw: null };
  }
}
