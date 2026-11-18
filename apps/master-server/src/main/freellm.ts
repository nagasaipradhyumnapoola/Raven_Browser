// Supervises the bundled FreeLLMAPI server as a child process of this app
// (Electron binary in Node mode: no separate Node.js install is needed).
import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { redact } from '@raven/security';
import type { SecretStore } from '../core';

export type ManagedState = 'stopped' | 'starting' | 'running' | 'failed' | 'missing';

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export class FreeLlmSupervisor extends EventEmitter {
  state: ManagedState = 'stopped';
  port = 0;
  error: string | null = null;
  private child: ChildProcess | null = null;
  private apiKey: string | null = null;
  private sessionToken: string | null = null;
  private restarts = 0;
  private wantRunning = false;
  private logTail: string[] = [];

  constructor(
    private bundleDir: string,
    private dataDir: string,
    private secrets: SecretStore,
    private preferredPort: () => number,
    private log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  ) {
    super();
  }

  get available(): boolean {
    return fs.existsSync(path.join(this.bundleDir, 'server.mjs'));
  }

  get version(): { commit: string } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.bundleDir, 'VERSION.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  endpoint(): { baseUrl: string; apiKey: string } | null {
    if (this.state !== 'running' || !this.apiKey) return null;
    return { baseUrl: `http://127.0.0.1:${this.port}`, apiKey: this.apiKey };
  }

  get dashboardUrl(): string | null {
    return this.state === 'running' ? `http://127.0.0.1:${this.port}/` : null;
  }

  get session(): string | null {
    return this.sessionToken;
  }

  recentLog(): string[] {
    return this.logTail.slice(-80);
  }

  private setState(s: ManagedState, error: string | null = null): void {
    this.state = s;
    this.error = error;
    this.emit('change');
  }

  async start(): Promise<void> {
    this.wantRunning = true;
    if (this.child || this.state === 'starting') return;
    if (!this.available) {
      this.setState('missing', 'The bundled FreeLLMAPI files are not present in this build.');
      return;
    }
    this.setState('starting');
    // FreeLLMAPI encrypts provider keys with this key; it lives in OS-protected storage, not on disk in the clear.
    let encKey = this.secrets.get('freellm-encryption-key');
    if (!encKey) {
      encKey = crypto.randomBytes(32).toString('hex');
      this.secrets.set('freellm-encryption-key', encKey);
    }
    // If something (another FreeLLMAPI, or anything else) already holds the port, move to the next free one.
    let port = this.preferredPort();
    for (let i = 0; i < 20 && !(await portFree(port)); i++) port++;
    this.port = port;
    const dir = path.join(this.dataDir, 'freellmapi');
    fs.mkdirSync(dir, { recursive: true });
    const child = fork(path.join(this.bundleDir, 'server.mjs'), [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        RAVEN_FL_DB: path.join(dir, 'freeapi.db'),
        RAVEN_FL_PORT: String(port),
        RAVEN_FL_CLIENT_DIST: path.join(this.bundleDir, 'client'),
        ENCRYPTION_KEY: encKey,
        FREEAPI_ENV_PATH: path.join(dir, 'unused.env'),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    const tail = (d: Buffer) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.logTail.push(redact(line).slice(0, 400));
      }
      if (this.logTail.length > 300) this.logTail.splice(0, this.logTail.length - 300);
    };
    child.stdout?.on('data', tail);
    child.stderr?.on('data', tail);
    const bootTimer = setTimeout(() => {
      if (this.state === 'starting') {
        this.log('error', 'FreeLLMAPI did not start within 60 seconds.');
        child.kill();
      }
    }, 60_000);
    child.on('message', (m: any) => {
      if (m?.t === 'ready') {
        clearTimeout(bootTimer);
        this.apiKey = String(m.apiKey);
        this.sessionToken = String(m.sessionToken);
        this.port = Number(m.port) || port;
        this.restarts = 0;
        this.log('info', `FreeLLMAPI is running on 127.0.0.1:${this.port} (local only).`);
        this.setState('running');
      } else if (m?.t === 'fatal') {
        this.error = redact(String(m.error)).slice(0, 300);
      } else if (m?.t === 'session') {
        this.sessionToken = String(m.sessionToken);
      } else if (m?.t === 'key') {
        this.apiKey = String(m.apiKey);
        this.emit('change');
      }
    });
    child.on('exit', (code) => {
      clearTimeout(bootTimer);
      if (this.child === child) this.child = null;
      this.apiKey = null;
      this.sessionToken = null;
      if (!this.wantRunning) {
        this.setState('stopped');
        return;
      }
      this.restarts++;
      const msg = this.error ?? `FreeLLMAPI stopped unexpectedly (code ${code}).`;
      this.log('error', msg);
      if (this.restarts > 5) {
        this.setState('failed', `${msg} Giving up after 5 restarts.`);
        return;
      }
      this.setState('starting', msg);
      setTimeout(() => {
        if (this.wantRunning) void this.start();
      }, Math.min(15_000, 1000 * 2 ** this.restarts));
    });
  }

  async stop(): Promise<void> {
    this.wantRunning = false;
    const child = this.child;
    if (!child) {
      this.setState('stopped');
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.send({ t: 'shutdown' });
      } catch {
        child.kill();
      }
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.restarts = 0;
    await this.start();
  }

  /** Call FreeLLMAPI's own admin API (the same one its dashboard uses). */
  private async admin(pathname: string, init: RequestInit = {}): Promise<any> {
    if (this.state !== 'running' || !this.sessionToken) throw new Error('FreeLLMAPI is not running.');
    const res = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.sessionToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FreeLLMAPI admin API answered HTTP ${res.status}.`);
    return res.json();
  }

  /** Regenerate the unified key through FreeLLMAPI's documented endpoint. */
  async regenerateKey(): Promise<void> {
    const out = await this.admin('/api/settings/api-key/regenerate', { method: 'POST' });
    if (typeof out?.apiKey !== 'string') throw new Error('FreeLLMAPI did not return a new key.');
    this.apiKey = out.apiKey;
    this.emit('change');
  }

  async providers(): Promise<{ platform: string; name: string; kind: string; keyless: boolean; configured: boolean; keyCount: number; enabledKeyCount: number }[]> {
    const out = await this.admin('/api/keys/providers');
    return Array.isArray(out?.providers) ? out.providers : [];
  }
}
