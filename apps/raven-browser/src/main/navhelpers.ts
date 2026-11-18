// Small navigation helpers with no Electron dependency (unit-tested).

/** The search a Google "unusual traffic" page interrupted, or null. */
export function googleBlockedQuery(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^(?:www\.)?google\.(?:com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/.test(u.hostname) || !u.pathname.startsWith('/sorry/')) return null;
    const cont = u.searchParams.get('continue');
    if (!cont) return null;
    const c = new URL(cont);
    return c.pathname === '/search' ? c.searchParams.get('q') : null;
  } catch {
    return null;
  }
}

/** Zoom steps, as in Chrome. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export function nextZoom(current: number, dir: 'in' | 'out' | 'reset'): number {
  if (dir === 'reset') return 1;
  if (dir === 'in') return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
}

