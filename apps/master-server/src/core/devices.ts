// Device registry: approved / pending / suspended / revoked browser installs.
// Persisted as devices.json (atomic writes). Revoked keys are tombstoned so an
// old credential can never be paired again.
import path from 'node:path';
import { DEFAULT_LIMITS, isPlainObject, type DeviceLimits, type DeviceRecord, type DeviceStatus } from '@raven/shared';
import { sha256Hex } from '@raven/security';
import { atomicWriteSync, readJsonSync } from '../../../../packages/local-memory/src/fsutil';

interface DevicesFile {
  version: 1;
  devices: DeviceRecord[];
  /** sha256 of every public key that was revoked or rotated away */
  revokedKeys: string[];
}

function sanitizeLimits(v: unknown): DeviceLimits {
  const d = { ...DEFAULT_LIMITS };
  if (!isPlainObject(v)) return d;
  for (const k of Object.keys(d) as (keyof DeviceLimits)[]) {
    const n = (v as any)[k];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) d[k] = Math.floor(n);
  }
  if (d.maxConnections < 1) d.maxConnections = 1;
  if (d.aiConcurrent < 1) d.aiConcurrent = 1;
  if (d.maxPayloadBytes < 1024) d.maxPayloadBytes = 1024;
  return d;
}

function sanitizeDevice(v: unknown): DeviceRecord | null {
  if (!isPlainObject(v)) return null;
  const r = v as any;
  if (typeof r.id !== 'string' || typeof r.publicKey !== 'string') return null;
  const status: DeviceStatus = ['pending', 'approved', 'suspended', 'revoked'].includes(r.status) ? r.status : 'pending';
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name.slice(0, 60) : 'Unnamed device',
    publicKey: r.publicKey,
    status,
    internet: r.internet !== false,
    ai: r.ai !== false,
    allowedModels: Array.isArray(r.allowedModels) ? r.allowedModels.filter((x: unknown) => typeof x === 'string') : null,
    defaultModel: typeof r.defaultModel === 'string' ? r.defaultModel : null,
    limits: sanitizeLimits(r.limits),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    approvedAt: typeof r.approvedAt === 'number' ? r.approvedAt : null,
    lastSeen: typeof r.lastSeen === 'number' ? r.lastSeen : null,
    lastIp: typeof r.lastIp === 'string' ? r.lastIp : null,
    lastScope: r.lastScope === 'lan' || r.lastScope === 'remote' ? r.lastScope : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
    totalUp: typeof r.totalUp === 'number' ? r.totalUp : 0,
    totalDown: typeof r.totalDown === 'number' ? r.totalDown : 0,
    aiRequests: typeof r.aiRequests === 'number' ? r.aiRequests : 0,
    pairingCode: typeof r.pairingCode === 'string' ? r.pairingCode : '',
  };
}

export type DevicePatch = Partial<
  Pick<DeviceRecord, 'name' | 'internet' | 'ai' | 'allowedModels' | 'defaultModel' | 'limits' | 'lastError' | 'lastSeen' | 'lastIp' | 'lastScope'>
>;

export class DeviceRegistry {
  private file: string;
  private devices = new Map<string, DeviceRecord>();
  private revokedKeys = new Set<string>();
  private dirty = false;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'devices.json');
    const raw = readJsonSync<unknown>(this.file, null);
    if (isPlainObject(raw)) {
      const list = Array.isArray((raw as any).devices) ? (raw as any).devices : [];
      for (const d of list) {
        const rec = sanitizeDevice(d);
        if (rec) this.devices.set(rec.id, rec);
      }
      const rk = Array.isArray((raw as any).revokedKeys) ? (raw as any).revokedKeys : [];
      for (const k of rk) if (typeof k === 'string') this.revokedKeys.add(k);
    }
  }

  save(): void {
    const data: DevicesFile = { version: 1, devices: [...this.devices.values()], revokedKeys: [...this.revokedKeys] };
    atomicWriteSync(this.file, JSON.stringify(data, null, 2));
    this.dirty = false;
  }

  /** Counters change constantly; they are flushed on a timer instead of per byte. */
  markDirty(): void {
    this.dirty = true;
  }

  flushIfDirty(): void {
    if (this.dirty) this.save();
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): DeviceRecord | undefined {
    return this.devices.get(id);
  }

  isKeyRevoked(publicKey: string): boolean {
    return this.revokedKeys.has(sha256Hex(Buffer.from(publicKey, 'base64')));
  }

  pendingCount(): number {
    let n = 0;
    for (const d of this.devices.values()) if (d.status === 'pending') n++;
    return n;
  }

  addPending(id: string, publicKey: string, name: string, pairingCode: string): DeviceRecord {
    const rec: DeviceRecord = {
      id,
      name: name.slice(0, 60) || 'Unnamed device',
      publicKey,
      status: 'pending',
      internet: true,
      ai: true,
      allowedModels: null,
      defaultModel: null,
      limits: { ...DEFAULT_LIMITS },
      createdAt: Date.now(),
      approvedAt: null,
      lastSeen: Date.now(),
      lastIp: null,
      lastScope: null,
      lastError: null,
      totalUp: 0,
      totalDown: 0,
      aiRequests: 0,
      pairingCode,
    };
    this.devices.set(id, rec);
    this.save();
    return rec;
  }

  setStatus(id: string, status: DeviceStatus): DeviceRecord | undefined {
    const d = this.devices.get(id);
    if (!d) return undefined;
    if (d.status === 'revoked' && status !== 'revoked') return d; // revocation is final
    d.status = status;
    if (status === 'approved' && !d.approvedAt) d.approvedAt = Date.now();
    if (status === 'revoked') this.revokedKeys.add(sha256Hex(Buffer.from(d.publicKey, 'base64')));
    this.save();
    return d;
  }

  update(id: string, patch: DevicePatch): DeviceRecord | undefined {
    const d = this.devices.get(id);
    if (!d) return undefined;
    if (typeof patch.name === 'string' && patch.name.trim()) d.name = patch.name.trim().slice(0, 60);
    if (typeof patch.internet === 'boolean') d.internet = patch.internet;
    if (typeof patch.ai === 'boolean') d.ai = patch.ai;
    if (patch.allowedModels === null) d.allowedModels = null;
    else if (Array.isArray(patch.allowedModels)) d.allowedModels = patch.allowedModels.filter((x) => typeof x === 'string');
    if (patch.defaultModel === null || typeof patch.defaultModel === 'string') d.defaultModel = patch.defaultModel;
    if (patch.limits) d.limits = sanitizeLimits({ ...d.limits, ...patch.limits });
    if (patch.lastError !== undefined) d.lastError = patch.lastError;
    if (patch.lastSeen !== undefined) d.lastSeen = patch.lastSeen;
    if (patch.lastIp !== undefined) d.lastIp = patch.lastIp;
    if (patch.lastScope !== undefined) d.lastScope = patch.lastScope;
    this.save();
    return d;
  }

  /** Replace a device's key (credential rotation); the old key is tombstoned. */
  rotateKey(id: string, newPublicKey: string): boolean {
    const d = this.devices.get(id);
    if (!d || d.status === 'revoked') return false;
    this.revokedKeys.add(sha256Hex(Buffer.from(d.publicKey, 'base64')));
    d.publicKey = newPublicKey;
    this.save();
    return true;
  }

  /** Delete a record. Revoked keys stay tombstoned forever. */
  remove(id: string): boolean {
    const d = this.devices.get(id);
    if (!d) return false;
    if (d.status === 'approved' || d.status === 'suspended') {
      this.revokedKeys.add(sha256Hex(Buffer.from(d.publicKey, 'base64')));
    }
    this.devices.delete(id);
    this.save();
    return true;
  }

  /** Drop stale pending requests and long-revoked records. */
  removeExpired(now = Date.now()): number {
    let n = 0;
    for (const d of [...this.devices.values()]) {
      const stalePending = d.status === 'pending' && now - (d.lastSeen ?? d.createdAt) > 24 * 3600_000;
      const oldRevoked = d.status === 'revoked' && now - (d.lastSeen ?? d.createdAt) > 30 * 24 * 3600_000;
      if (stalePending || oldRevoked) {
        this.devices.delete(d.id);
        n++;
      }
    }
    if (n) this.save();
    return n;
  }
}
