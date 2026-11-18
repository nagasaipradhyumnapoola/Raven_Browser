// Saved website logins. Passwords are encrypted with the system's secure storage (Windows DPAPI / macOS Keychain);
// the file holds only site, username and the encrypted password. Filled only on the exact site (origin) they were
// saved on, and only on secure pages.
import crypto from 'node:crypto';
import path from 'node:path';
import { safeStorage } from 'electron';
import { atomicWriteSync, readJsonSync } from '../../../../packages/local-memory/src/fsutil';

export interface SavedLogin {
  id: string;
  origin: string;
  username: string;
  /** base64 of safeStorage.encryptString(password) */
  enc: string;
  created: number;
  lastUsed: number;
}
export type LoginView = Omit<SavedLogin, 'enc'>;

interface FileShape {
  v: 1;
  logins: SavedLogin[];
  /** sites where the person chose "Never save" */
  never: string[];
}

/** Only secure pages may save or receive passwords (plus localhost for development). */
export function passwordOriginAllowed(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

export class PasswordStore {
  private file: string;
  private data: FileShape;

  constructor(root: string) {
    this.file = path.join(root, 'passwords.json');
    const raw = readJsonSync<Partial<FileShape> | null>(this.file, null);
    this.data = {
      v: 1,
      logins: Array.isArray(raw?.logins) ? raw!.logins.filter((l) => l && typeof l.origin === 'string' && typeof l.enc === 'string') : [],
      never: Array.isArray(raw?.never) ? raw!.never.filter((x) => typeof x === 'string') : [],
    };
  }

  private persist(): void {
    atomicWriteSync(this.file, JSON.stringify(this.data, null, 2));
  }

  list(): LoginView[] {
    return this.data.logins.map(({ enc: _e, ...v }) => v).sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  forOrigin(origin: string): LoginView[] {
    return this.list().filter((l) => l.origin === origin).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /** What saving this login would do: nothing (already saved), add, or update the password of a saved username. */
  check(origin: string, username: string, password: string): 'same' | 'new' | 'update' {
    const hit = this.data.logins.find((l) => l.origin === origin && l.username === username);
    if (!hit) return 'new';
    return this.reveal(hit.id) === password ? 'same' : 'update';
  }

  save(origin: string, username: string, password: string): LoginView {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The system secure storage is not available, so passwords cannot be saved.');
    const enc = safeStorage.encryptString(password).toString('base64');
    const now = Date.now();
    let hit = this.data.logins.find((l) => l.origin === origin && l.username === username);
    if (hit) Object.assign(hit, { enc, lastUsed: now });
    else {
      hit = { id: crypto.randomBytes(8).toString('hex'), origin, username, enc, created: now, lastUsed: now };
      this.data.logins.push(hit);
    }
    this.data.never = this.data.never.filter((o) => o !== origin);
    this.persist();
    const { enc: _e, ...v } = hit;
    return v;
  }

  reveal(id: string): string | null {
    const hit = this.data.logins.find((l) => l.id === id);
    if (!hit) return null;
    try {
      return safeStorage.decryptString(Buffer.from(hit.enc, 'base64'));
    } catch {
      return null;
    }
  }

  touch(id: string): void {
    const hit = this.data.logins.find((l) => l.id === id);
    if (hit) {
      hit.lastUsed = Date.now();
      this.persist();
    }
  }

  remove(id: string): boolean {
    const n = this.data.logins.length;
    this.data.logins = this.data.logins.filter((l) => l.id !== id);
    if (this.data.logins.length !== n) this.persist();
    return this.data.logins.length !== n;
  }

  isNever(origin: string): boolean {
    return this.data.never.includes(origin);
  }

  setNever(origin: string, on: boolean): void {
    this.data.never = this.data.never.filter((o) => o !== origin);
    if (on) this.data.never.push(origin);
    this.persist();
  }

  neverList(): string[] {
    return [...this.data.never].sort();
  }

  clearAll(): void {
    this.data = { v: 1, logins: [], never: [] };
    this.persist();
  }
}
