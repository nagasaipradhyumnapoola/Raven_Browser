// Google refuses to sign people in from browsers it classifies as "embedded" (Electron-based browsers included):
// "Couldn't sign you in - This browser or app may not be secure". It accepts Firefox. On Google's sign-in host
// only, a tab therefore presents itself exactly as Firefox does: Firefox's user agent, and none of the
// Chromium-only client-hint headers. Everywhere else Raven stays a normal Chromium browser.
// (Pure functions, no Electron imports: unit-tested.)

/** Google's own domain forms only: google.com, google.co.xx, google.com.xx, google.xx (never look-alikes). */
const GOOGLE = String.raw`google\.(?:com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})`;
const SIGNIN_HOST = new RegExp(String.raw`^(?:accounts\.${GOOGLE}|accounts\.youtube\.com|myaccount\.google\.com|gds\.google\.com)$`, 'i');

export function isSignInHost(host: string): boolean {
  return SIGNIN_HOST.test(host);
}

export function isSignInUrl(url: string): boolean {
  try {
    return isSignInHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Firefox's own user agent for this operating system. */
export function firefoxUserAgent(platform: string = process.platform): string {
  const os = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${os}; rv:140.0) Gecko/20100101 Firefox/140.0`;
}

/** Request headers for a sign-in page: Firefox user agent, no Chromium client hints. */
export function signInHeaders(headers: Record<string, string>, platform: string = process.platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (!/^sec-ch-ua/i.test(k) && k.toLowerCase() !== 'user-agent') out[k] = v;
  out['User-Agent'] = firefoxUserAgent(platform);
  return out;
}
