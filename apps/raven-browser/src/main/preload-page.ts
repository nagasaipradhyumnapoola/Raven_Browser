// Runs in every web page, in an isolated world the page's own scripts cannot reach.
// It only (1) notices when a login form is sent so Raven can offer to save it, and (2) fills a saved login
// when the person clicks into a login field. The site (origin) is decided by Raven's main process from the frame
// itself, never from anything this script says.
import { contextBridge, ipcRenderer } from 'electron';
import { isSignInHost } from '../../../../packages/shared/src/signin';

// (3) Google's sign-in page only: its scripts see Firefox, the same as the request headers say. Google refuses
// Chromium-based "embedded" browsers, and a Firefox user agent next to Chromium-only JavaScript features reads
// as a disguised browser and is rejected too. Runs before any page script.
if (isSignInHost(location.hostname)) {
  try {
    contextBridge.executeInMainWorld({
      func: (ua: string, oscpu: string) => {
        const def = (o: object, k: string, v: unknown) => {
          try {
            Object.defineProperty(o, k, { get: () => v, configurable: true });
          } catch {
            /* keep going */
          }
        };
        const N = Navigator.prototype;
        def(N, 'userAgent', ua);
        def(N, 'appVersion', '5.0 (Windows)');
        def(N, 'vendor', '');
        def(N, 'productSub', '20100101');
        def(N, 'oscpu', oscpu);
        def(N, 'buildID', '20181001000000');
        def(N, 'userAgentData', undefined);
        try {
          delete (window as any).chrome;
        } catch {
          /* not deletable */
        }
        def(window, 'chrome', undefined);
      },
      args: [navigator.userAgent, /Macintosh/.test(navigator.userAgent) ? 'Intel Mac OS X 10.15' : 'Windows NT 10.0; Win64; x64'],
    });
  } catch {
    /* older Electron: headers alone */
  }
}

const USERISH = /user|login|email|e-mail|identifier|account|phone|mobile|handle/i;

const visible = (el: Element) => {
  const r = (el as HTMLElement).getBoundingClientRect();
  const cs = getComputedStyle(el as HTMLElement);
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
};
const isPassword = (el: unknown): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'password';
const isUserField = (el: unknown): el is HTMLInputElement =>
  el instanceof HTMLInputElement &&
  ['text', 'email', 'tel', ''].includes(el.type) &&
  (USERISH.test(`${el.name} ${el.id} ${el.autocomplete} ${el.getAttribute('aria-label') ?? ''} ${el.placeholder}`) || el.type === 'email');

function scopeOf(el: Element): ParentNode {
  return el.closest('form') ?? document;
}

function userFieldNear(pw: HTMLInputElement): HTMLInputElement | null {
  const all = [...scopeOf(pw).querySelectorAll('input')].filter((i) => visible(i));
  const before = all.slice(0, all.indexOf(pw)).reverse();
  return before.find(isUserField) ?? before.find((i) => i instanceof HTMLInputElement && ['text', 'email', 'tel'].includes(i.type)) ?? null;
}

// Multi-step sign-ins (email first, password on the next screen): remember the last username typed on this page.
let lastUser = '';
document.addEventListener(
  'change',
  (e) => {
    if (isUserField(e.target) && e.target.value.trim()) lastUser = e.target.value.trim();
  },
  true,
);

let lastSent = '';
function captureFrom(root: ParentNode) {
  const pw = [...root.querySelectorAll('input[type=password]')].find((i): i is HTMLInputElement => isPassword(i) && !!i.value && visible(i));
  if (!pw) {
    // A username-only step: tell Raven, so the password step can be matched with it.
    const u = [...root.querySelectorAll('input')].find((i): i is HTMLInputElement => isUserField(i) && !!i.value.trim() && visible(i));
    if (u) ipcRenderer.send('raven-page:username', u.value.trim().slice(0, 200));
    return;
  }
  const username = (userFieldNear(pw)?.value ?? '').trim() || lastUser;
  const key = `${username}\u0000${pw.value}`;
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send('raven-page:submitted', { username: username.slice(0, 200), password: pw.value.slice(0, 1000) });
}

// Forms sent the classic way, and sign-in buttons on script-driven pages.
document.addEventListener('submit', (e) => e.isTrusted && captureFrom(e.target instanceof Element ? scopeOf(e.target) : document), true);
document.addEventListener(
  'click',
  (e) => {
    if (!e.isTrusted) return;
    const b = e.target instanceof Element ? e.target.closest('button, input[type=submit], [role=button]') : null;
    if (b) setTimeout(() => captureFrom(scopeOf(b)), 0);
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.isTrusted && e.key === 'Enter' && e.target instanceof HTMLInputElement) captureFrom(scopeOf(e.target));
  },
  true,
);

// Fill: only after the person clicks into an empty login field (a real user action), once per field.
const filled = new WeakSet<HTMLInputElement>();
function setValue(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
document.addEventListener(
  'mousedown',
  async (e) => {
    // Only a real click by the person (scripts cannot fake isTrusted).
    if (!e.isTrusted) return;
    const el = e.target;
    if (!(isPassword(el) || isUserField(el)) || filled.has(el) || el.value) return;
    filled.add(el);
    const r = el.getBoundingClientRect();
    const login = (await ipcRenderer.invoke('raven-page:fill', { x: Math.round(r.left), y: Math.round(r.bottom), field: isPassword(el) ? 'password' : 'username' })) as { username: string; password: string } | null;
    if (!login) return;
    const pw = isPassword(el) ? el : ([...scopeOf(el).querySelectorAll('input[type=password]')].find((i) => visible(i)) as HTMLInputElement | undefined);
    const user = isPassword(el) ? userFieldNear(el) : el;
    if (user && !user.value && login.username) setValue(user, login.username);
    if (pw && !pw.value) setValue(pw, login.password);
  },
  true,
);
