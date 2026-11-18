// New-tab background: the world drawn in faint orange ASCII. Static layer is drawn once per size;
// only a few twinkling cells and the cells under the cursor are redrawn each frame.
import React, { useEffect, useRef } from 'react';
import { WORLD_COLS, WORLD_ROWS } from './worldmap';

const RAMP = ['', '.', ':', '+', '#'];
const SCRAMBLE = '#%&*+=-:;<>/\\|01';
const ACCENT = [223, 106, 51]; // --accent

export function AsciiMap() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const base = document.createElement('canvas');
    const bctx = base.getContext('2d')!;
    const land: { c: number; r: number; v: number }[] = [];
    WORLD_ROWS.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        const v = row.charCodeAt(c) - 48;
        if (v > 0) land.push({ c, r, v });
      }
    });
    let cw = 0, ch = 0, ox = 0, oy = 0, dpr = 1, W = 0, H = 0;
    let mouse: { x: number; y: number } | null = null;
    let raf = 0;
    let last = 0;
    const twinkle = new Map<number, number>(); // land index -> expiry time

    const font = () => `${Math.max(7, cw / 0.6) * dpr}px "JetBrains Mono", Consolas, monospace`;
    const glyph = (ctx2: CanvasRenderingContext2D, ch2: string, c: number, r: number, a: number) => {
      ctx2.fillStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${a})`;
      ctx2.fillText(ch2, (ox + c * cw) * dpr, (oy + r * ch + ch * 0.75) * dpr);
    };

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = rect.width;
      H = rect.height;
      canvas.width = base.width = Math.round(W * dpr);
      canvas.height = base.height = Math.round(H * dpr);
      // Fit the whole map to the width; a cell is twice as tall as it is wide (equirectangular).
      cw = Math.max(5, (W * 0.96) / WORLD_COLS);
      ch = cw * 2;
      ox = (W - cw * WORLD_COLS) / 2;
      oy = Math.max(H - ch * WORLD_ROWS.length - 24, (H - ch * WORLD_ROWS.length) * 0.7);
      bctx.clearRect(0, 0, base.width, base.height);
      bctx.font = font();
      // Sparse sea grid so the map reads as a map.
      for (let r = 0; r < WORLD_ROWS.length; r += 2)
        for (let c = r % 4 === 0 ? 0 : 2; c < WORLD_COLS; c += 4) {
          if ((WORLD_ROWS[r].charCodeAt(c) || 48) === 48) glyph(bctx, '.', c, r, 0.035);
        }
      for (const p of land) glyph(bctx, RAMP[p.v], p.c, p.r, 0.06 + p.v * 0.03);
      draw(performance.now());
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0);
      ctx.font = font();
      for (const [i, until] of twinkle) {
        if (t > until) {
          twinkle.delete(i);
          continue;
        }
        const p = land[i];
        const k = (until - t) / 1400;
        glyph(ctx, RAMP[Math.min(4, p.v + 1)], p.c, p.r, 0.1 + 0.25 * Math.sin(k * Math.PI));
      }
      if (mouse) {
        const R = 110;
        const c0 = Math.floor((mouse.x - R - ox) / cw), c1 = Math.ceil((mouse.x + R - ox) / cw);
        const r0 = Math.floor((mouse.y - R - oy) / ch), r1 = Math.ceil((mouse.y + R - oy) / ch);
        for (let r = Math.max(0, r0); r <= Math.min(WORLD_ROWS.length - 1, r1); r++) {
          const row = WORLD_ROWS[r];
          for (let c = Math.max(0, c0); c <= Math.min(row.length - 1, c1); c++) {
            const v = row.charCodeAt(c) - 48;
            if (v <= 0) continue;
            const dx = ox + c * cw + cw / 2 - mouse.x, dy = oy + r * ch + ch / 2 - mouse.y;
            const d = Math.hypot(dx, dy);
            if (d > R) continue;
            const f = 1 - d / R;
            const g = f > 0.55 && Math.random() < 0.35 ? SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0] : RAMP[Math.min(4, v + 1)];
            glyph(ctx, g, c, r, 0.12 + 0.45 * f * f);
          }
        }
      }
    };

    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 50) return; // ~20 fps is plenty for a background
      last = t;
      if (land.length && twinkle.size < 26 && Math.random() < 0.5) twinkle.set((Math.random() * land.length) | 0, t + 1400);
      draw(t);
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onLeave = () => (mouse = null);
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduce) raf = requestAnimationFrame(tick);
    };
    const ro = new ResizeObserver(layout);
    ro.observe(canvas);
    layout();
    const host = canvas.parentElement;
    if (!reduce) {
      host?.addEventListener('mousemove', onMove);
      host?.addEventListener('mouseleave', onLeave);
      document.addEventListener('visibilitychange', onVis);
      raf = requestAnimationFrame(tick);
    }
    void document.fonts?.ready.then(layout);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host?.removeEventListener('mousemove', onMove);
      host?.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return <canvas ref={ref} className="ascii-map" aria-hidden="true" />;
}
