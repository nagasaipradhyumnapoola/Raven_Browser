// Raven Wi-Fi link: the master runs its own Wi-Fi network; a user PC that has no network (and no internet) joins
// it after the person types the master's link code once. Both sides derive the network name and its WPA2 password
// from the code, so nothing has to be exchanged over a network that does not exist yet.
//
// 10 characters from a 31-letter alphabet (no 0/O/1/I/L): about 8 x 10^14 possibilities, far beyond what someone in
// radio range could try against a WPA2 handshake. Joining the network still does not bypass Raven's own device
// approval and pinned, encrypted connection.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** The address Windows Mobile Hotspot gives the master on its own network. */
export const LINK_HOST = '192.168.137.1';

export function generateLinkCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Accepts what a person types (any case, spaces or dashes); returns XXXXX-XXXXX or null. */
export function normalizeLinkCode(input: string): string | null {
  const c = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
  if (c.length !== 10 || [...c].some((ch) => !ALPHABET.includes(ch))) return null;
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

/** Network name and WPA2 password for a link code (same on master and user PC). */
export function linkNetwork(code: string): { ssid: string; passphrase: string } {
  const c = normalizeLinkCode(code);
  if (!c) throw new Error('That link code is not valid.');
  const raw = c.replace('-', '');
  const digest = crypto.createHash('sha256').update(`raven-link-v1|${raw}`).digest();
  // 24 characters of base32 for the WPA2 passphrase (8..63 allowed).
  const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let pass = '';
  for (let i = 0; i < 24; i++) pass += b32[digest[i] % 32];
  // The name comes from a separate hash: it is broadcast, so it must not reveal any part of the code.
  const tag = crypto.createHash('sha256').update(`raven-link-ssid-v1|${raw}`).digest();
  let name = '';
  for (let i = 0; i < 4; i++) name += ALPHABET[tag[i] % ALPHABET.length];
  return { ssid: `Raven-${name}`, passphrase: pass };
}
