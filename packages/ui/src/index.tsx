// Raven UI kit shared by both apps. Deliberately plain: small set of
// components, quiet motion (short fades), no decorative effects.
import { AnimatePresence, motion } from 'motion/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export { AnimatePresence, motion };

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// ---------------------------------------------------------------- Smoke
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number): number {
  return vnoise(x, y) * 0.55 + vnoise(x * 2.03, y * 2.03) * 0.3 + vnoise(x * 4.1, y * 4.1) * 0.15;
}

/**
 * Very soft drifting smoke, painted at low resolution and blurred: a warm
 * glow low on the page with a cool pocket, in the spirit of the Raven
 * background art. Slow, low contrast, pauses when the tab is hidden.
 */
export function Smoke({ className, style, intensity = 1 }: { className?: string; style?: React.CSSProperties; intensity?: number; density?: number; coolAt?: number | null; interactive?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = 96;
    const H = 54;
    canvas.width = W;
    canvas.height = H;
    const img = ctx.createImageData(W, H);
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 66 || document.hidden) return;
      last = now;
      const t = now / 1000;
      for (let y = 0; y < H; y++) {
        const fy = y / H;
        for (let x = 0; x < W; x++) {
          const fx = x / W;
          const warp = fbm(fx * 2.2 + t * 0.012, fy * 2.2 - t * 0.01);
          const n = fbm(fx * 3 + warp * 1.6 + t * 0.02, fy * 3.4 - t * 0.035 + warp);
          const band = Math.pow(fy, 1.6);
          const v = Math.max(0, Math.min(1, (n - 0.42) * 2.2)) * band * intensity;
          const cool = Math.max(0, 1 - Math.hypot((fx - 0.3) / 0.28, (fy - 1) / 0.4));
          const i = (y * W + x) * 4;
          // warm: #df6a33, cool: #4f8a94
          img.data[i] = 223 * (1 - cool) + 79 * cool;
          img.data[i + 1] = 106 * (1 - cool) + 138 * cool;
          img.data[i + 2] = 51 * (1 - cool) + 148 * cool;
          img.data[i + 3] = Math.round(v * 120);
        }
      }
      ctx.putImageData(img, 0, 0);
      if (reducedMotion()) cancelAnimationFrame(raf);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [intensity]);
  return <canvas ref={ref} className={`smoke ${className ?? ''}`} style={{ filter: 'blur(28px)', transform: 'scale(1.1)', ...style }} aria-hidden="true" />;
}

// ---------------------------------------------------------------- basics
/** Kept for API compatibility; no movement (plain UI). */
export function Magnetic({ children }: { children: React.ReactNode; strength?: number; className?: string }) {
  return <>{children}</>;
}

export interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'orbit' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  magnetic?: boolean;
  bare?: boolean;
}

export function Btn({ variant = 'default', size = 'md', magnetic: _m, bare: _b, className, children, ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'default' ? variant : '', size === 'sm' ? 'sm' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} aria-disabled={disabled} className="toggle" data-on={on} onClick={() => !disabled && onChange(!on)}>
      <motion.span className="thumb" layout transition={{ type: 'spring', stiffness: 700, damping: 40 }} />
    </button>
  );
}

export function Card({ children, className, style, corners: _c, ...rest }: React.HTMLAttributes<HTMLDivElement> & { corners?: boolean }) {
  return (
    <div className={`card ${className ?? ''}`} style={style} {...rest}>
      {children}
    </div>
  );
}

/** Kept for API compatibility: renders the text as is. */
export function Scramble({ text, className }: { text: string; className?: string; speed?: number }) {
  return <span className={className}>{text}</span>;
}

export function Dot({ tone = 'off' }: { tone?: 'ok' | 'warn' | 'bad' | 'off'; live?: boolean }) {
  return <span className={`dot ${tone === 'off' ? '' : tone}`} />;
}

export function Chip({ tone, children, title }: { tone?: 'ok' | 'warn' | 'bad' | 'hot'; children: React.ReactNode; title?: string }) {
  return (
    <span className={`chip ${tone ?? ''}`} title={title}>
      {children}
    </span>
  );
}

export function Meter({ value, className }: { value: number; width?: number; className?: string }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <span className={`meter ${className ?? ''}`}>
      <i style={{ width: `${v * 100}%` }} />
    </span>
  );
}

/** Small line chart of recent samples. */
export function Spark({ data, className }: { data: number[]; className?: string }) {
  const max = Math.max(1, ...data);
  const n = Math.max(2, data.length);
  const pts = data.map((d, i) => `${(i / (n - 1)) * 100},${28 - (d / max) * 24 - 2}`).join(' ');
  return (
    <svg className={`spark ${className ?? ''}`} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={`0,28 ${pts} 100,28`} fill="var(--accent-soft)" stroke="none" />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div
            className="modal"
            style={wide ? { width: 'min(820px, calc(100vw - 48px))' } : undefined}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
            role="dialog"
            aria-modal="true"
          >
            {title && <h2 style={{ marginBottom: 14 }}>{title}</h2>}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface Toast {
  id: number;
  text: string;
  tone?: 'ok' | 'bad';
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(1);
  const push = useCallback((text: string, tone?: 'ok' | 'bad') => {
    const id = seq.current++;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  const view = useMemo(
    () => (
      <div className="toasts">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} className={`toast ${t.tone ?? ''}`} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    ),
    [toasts],
  );
  return { push, view };
}

/** Fade in place (short, subtle). */
export function Rise({ children, delay = 0, className, style }: { children: React.ReactNode; delay?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <motion.div className={className} style={style} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, delay: Math.min(delay, 0.1) }}>
      {children}
    </motion.div>
  );
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
