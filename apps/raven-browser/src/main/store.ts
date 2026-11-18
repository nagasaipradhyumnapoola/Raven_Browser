// Where Raven keeps its files, its settings, and its device identity.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPlainObject } from '@raven/shared';
import { deviceIdFromPublicKey, generateDeviceKeyPair } from '@raven/security';
import { atomicWriteSync, isWritableDir, readJsonSync } from '../../../../packages/local-memory/src/fsutil';
import type { BrowserSettings } from '../types';

export const DATA_FOLDER = 'RavenBrowserData';

/** Folder that holds RavenBrowser.exe (portable build), or null when running unpacked. */
export function exeDir(): string | null {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable) return portable;
  if (app.isPackaged) return path.dirname(process.execPath);
  return null;
}

/**
 * Data root:
 *  1. RAVEN_DATA_DIR (testing),
 *  2. a RavenBrowserData folder already sitting beside the EXE and writable (portable mode),
 *  3. %APPDATA%\Raven Browser\RavenBrowserData.
 */
export function resolveDataRoot(): { root: string; portable: boolean } {
  if (process.env.RAVEN_DATA_DIR) return { root: process.env.RAVEN_DATA_DIR, portable: false };
  const dir = exeDir();
  if (dir) {
    const beside = path.join(dir, DATA_FOLDER);
    if (fs.existsSync(beside) && isWritableDir(beside)) return { root: beside, portable: true };
  }
  return { root: path.join(app.getPath('appData'), 'Raven Browser', DATA_FOLDER), portable: false };
}

export function defaultSettings(root: string): BrowserSettings {
  return {
    theme: 'dark',
    searchEngine: 'google',
    customSearch: 'https://www.google.com/search?q=%s',
    homepage: 'raven://newtab',
    directFallback: true,
    strictGateway: false,
    adblock: true,
    adblockAllow: [],
    askWhereToSave: true,
    downloadDir: app.getPath('downloads'),
    pauseHistory: false,
    masterSearch: true,
    aiSaveConversations: true,
    restoreSession: true,
    memoryDir: root,
    deviceName: os.hostname() || 'Raven PC',
    manualServer: '',
    manualServerCa: false,
    smoke: true,
    addressBarAi: true,
    aiWidth: 420,
    showBookmarksBar: true,
  };
}

export class SettingsStore {
  private file: string;
  value: BrowserSettings;

  constructor(private root: string) {
    this.file = path.join(root, 'settings.json');
    const d = defaultSettings(root);
    const raw = readJsonSync<unknown>(this.file, null);
    this.value = { ...d };
    if (isPlainObject(raw)) {
      for (const k of Object.keys(d) as (keyof BrowserSettings)[]) {
        const v = (raw as any)[k];
        if (v !== undefined && typeof v === typeof d[k] && Array.isArray(v) === Array.isArray(d[k])) (this.value as any)[k] = v;
      }
    }
    if (this.value.strictGateway) this.value.directFallback = false;
  }

  update(patch: Partial<BrowserSettings>): BrowserSettings {
    const d = defaultSettings(this.root);
    for (const k of Object.keys(patch) as (keyof BrowserSettings)[]) {
      const v = patch[k];
      if (v === undefined || typeof v !== typeof d[k] || Array.isArray(v) !== Array.isArray(d[k])) continue;
      (this.value as any)[k] = v;
    }
    if (patch.strictGateway === true) this.value.directFallback = false;
    if (patch.directFallback === true) this.value.strictGateway = false;
    this.value.aiWidth = Math.max(320, Math.min(760, this.value.aiWidth));
    atomicWriteSync(this.file, JSON.stringify(this.value, null, 2));
    return this.value;
  }

  save(): void {
    atomicWriteSync(this.file, JSON.stringify(this.value, null, 2));
  }
}

export interface PairingRecord {
  host: string;
  port: number;
  tls: 'pin' | 'ca';
  pin: string | null;
  serverName: string;
  /** set once the owner approved this device */
  paired: boolean;
  /** first 16 hex chars of the server fingerprint, to recognise it in discovery after an IP change */
  fpPrefix: string;
  /** other addresses the master said it can be reached at (other adapters, router mapping); tried when this one fails */
  routes?: string[];
}

interface IdentityFile {
  v: 1;
  deviceId: string;
  publicKey: string;
  privateKeyEnc: string;
  createdAt: number;
  server: PairingRecord | null;
  /** Raven Wi-Fi link code, encrypted like the private key */
  linkEnc?: string;
}

/**
 * Per-installation device identity. The private key is encrypted with Windows
 * DPAPI (Electron safeStorage): copying the data folder to another PC or user
 * does not copy the credential; that PC simply pairs as a new device.
 */
export class IdentityStore {
  private file: string;
  deviceId = '';
  publicKey = '';
  privateKey = '';
  server: PairingRecord | null = null;
  regenerated = false;

  constructor(root: string) {
    this.file = path.join(root, 'identity.json');
  }

  load(): void {
    const raw = readJsonSync<IdentityFile | null>(this.file, null);
    if (raw && raw.v === 1 && typeof raw.privateKeyEnc === 'string') {
      try {
        const pk = safeStorage.decryptString(Buffer.from(raw.privateKeyEnc, 'base64'));
        if (typeof raw.linkEnc === 'string') {
          try {
            this.linkCode = safeStorage.decryptString(Buffer.from(raw.linkEnc, 'base64'));
          } catch {
            this.linkCode = null;
          }
        }
        if (deviceIdFromPublicKey(raw.publicKey) === raw.deviceId) {
          this.deviceId = raw.deviceId;
          this.publicKey = raw.publicKey;
          this.privateKey = pk;
          this.server = raw.server ?? null;
          return;
        }
      } catch {
        /* encrypted for another Windows user or PC: start over below */
      }
    }
    const prevServer = raw?.server ?? null;
    this.create();
    // Keep the server address (not the approval) so re-pairing is one click.
    if (prevServer) this.server = { ...prevServer, paired: false };
    this.regenerated = !!raw;
    this.save();
  }

  private create(): void {
    const kp = generateDeviceKeyPair();
    this.deviceId = deviceIdFromPublicKey(kp.publicKey);
    this.publicKey = kp.publicKey;
    this.privateKey = kp.privateKey;
    this.server = null;
  }

  save(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The system secure storage is not available.');
    const data: IdentityFile = {
      v: 1,
      deviceId: this.deviceId,
      publicKey: this.publicKey,
      privateKeyEnc: safeStorage.encryptString(this.privateKey).toString('base64'),
      createdAt: Date.now(),
      server: this.server,
      ...(this.linkCode ? { linkEnc: safeStorage.encryptString(this.linkCode).toString('base64') } : {}),
    };
    atomicWriteSync(this.file, JSON.stringify(data, null, 2));
  }

  /** Raven Wi-Fi link code typed once by the person (null = not set). */
  linkCode: string | null = null;

  setLinkCode(code: string | null): void {
    this.linkCode = code;
    this.save();
  }

  setServer(rec: PairingRecord | null): void {
    this.server = rec;
    this.save();
  }

  /** Replace the key pair (after the server accepted the new public key). */
  adoptKey(publicKey: string, privateKey: string): void {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.save();
  }

  get identity() {
    return { deviceId: this.deviceId, publicKey: this.publicKey, privateKey: this.privateKey };
  }
}
