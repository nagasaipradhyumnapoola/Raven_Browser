// Lightweight ad and tracker blocking: third-party requests to well-known
// advertising and tracking hosts are cancelled. Domain list only (no cosmetic
// filtering), so it cannot break page layout; the user can switch it off
// globally or per site.
const HOSTS = `
doubleclick.net googlesyndication.com googleadservices.com google-analytics.com googletagmanager.com
googletagservices.com adservice.google.com pagead2.googlesyndication.com analytics.google.com
adnxs.com adsrvr.org advertising.com adform.net adition.com adroll.com adsafeprotected.com
amazon-adsystem.com appnexus.com bidswitch.net casalemedia.com criteo.com criteo.net demdex.net
everesttech.net exelator.com eyeota.net hotjar.com id5-sync.com imrworldwide.com indexww.com
krxd.net lijit.com mathtag.com media.net moatads.com mookie1.com openx.net outbrain.com
pubmatic.com quantserve.com quantcount.com rubiconproject.com scorecardresearch.com serving-sys.com
sharethrough.com smartadserver.com spotxchange.com taboola.com teads.tv tapad.com
yieldmo.com zedo.com 3lift.com agkn.com bluekai.com chartbeat.com chartbeat.net clarity.ms
contextweb.com crwdcntrl.net dotomi.com doubleverify.com ezoic.net gumgum.com inmobi.com
liadm.com mgid.com mixpanel.com newrelic.com nr-data.net omtrdc.net onetrust.io optimizely.com
segment.io segment.com sentry-cdn.com rlcdn.com revcontent.com samba.tv simpli.fi sitescout.com
statcounter.com stickyadstv.com tremorhub.com turn.com undertone.com unrulymedia.com yandex.ru/ads
facebook.net/tr connect.facebook.net ads.linkedin.com px.ads.linkedin.com analytics.twitter.com
ads-twitter.com static.ads-twitter.com ads.yahoo.com adtech.de bat.bing.com ads.pinterest.com
ct.pinterest.com analytics.tiktok.com ads.tiktok.com branch.io adjust.com appsflyer.com kochava.com
`;

const BLOCKED = new Set<string>();
const PATH_RULES: { host: string; path: string }[] = [];
for (const entry of HOSTS.split(/\s+/).filter(Boolean)) {
  const slash = entry.indexOf('/');
  if (slash > 0) PATH_RULES.push({ host: entry.slice(0, slash), path: entry.slice(slash) });
  else BLOCKED.add(entry);
}

function hostBlocked(host: string): boolean {
  let h = host.toLowerCase();
  for (;;) {
    if (BLOCKED.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
}

function siteOf(host: string): string {
  const parts = host.toLowerCase().split('.');
  return parts.slice(-2).join('.');
}

/** Decide whether a subresource request should be cancelled. */
export function shouldBlock(requestUrl: string, pageUrl: string | undefined, allowSites: string[]): boolean {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  let page: URL | null = null;
  try {
    page = pageUrl ? new URL(pageUrl) : null;
  } catch {
    page = null;
  }
  if (page && allowSites.includes(page.hostname.toLowerCase())) return false;
  // First-party requests are never blocked.
  if (page && siteOf(page.hostname) === siteOf(u.hostname)) return false;
  if (hostBlocked(u.hostname)) return true;
  return PATH_RULES.some((r) => u.hostname.endsWith(r.host) && u.pathname.startsWith(r.path));
}
