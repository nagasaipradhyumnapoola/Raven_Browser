import React, { createContext, useContext } from 'react';
import type { AppState, InvokeResult, WindowState } from '../types';

declare global {
  interface Window {
    raven: {
      invoke(method: string, ...args: unknown[]): Promise<InvokeResult>;
      on(channel: string, cb: (payload: any) => void): () => void;
    };
  }
}

export interface Ctx {
  win: WindowState;
  app: AppState;
  run<T = unknown>(method: string, ...args: unknown[]): Promise<T | undefined>;
  toast(text: string, tone?: 'ok' | 'bad'): void;
  /** what the address bar does with typed text: open it, search it, or ask the assistant */
  submit(text: string): void;
  /** true when typed questions will go to the assistant */
  aiAnswersQuestions: boolean;
  /** the assistant is deciding what to do with typed text */
  routing: boolean;
  /** open a URL or raven:// page in the current tab (or a new one) */
  go(url: string, newTab?: boolean): void;
  /** while true the web page is replaced by a still picture so popovers can sit on top */
  overlay(on: boolean): void;
  ai: AiBridge;
}

export interface AiBridge {
  open(): void;
  pendingAction: { action: 'explain' | 'summarize' | 'ask' | 'send' | 'task' | 'tasks'; text: string } | null;
  /** send a question straight to the assistant (opens it) */
  ask(text: string): void;
  /** start a task on the master (opens the Tasks pane) */
  task(goal: string): void;
  clearAction(): void;
}

export const C = createContext<Ctx>(null as unknown as Ctx);
export const useC = () => useContext(C);

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function Fav({ url, src, size = 16 }: { url: string; src?: string | null; size?: number }) {
  if (src) return <img src={src} width={size} height={size} alt="" style={{ borderRadius: 3 }} />;
  const h = hostOf(url);
  return (
    <span style={{ width: size, height: size, display: 'inline-grid', placeItems: 'center', font: `800 ${Math.round(size * 0.62)}px/1 var(--mono)`, color: 'var(--orange)', flex: 'none' }}>
      {(h[0] ?? '•').toUpperCase()}
    </span>
  );
}

/** What typed text is: a web address, a question for the assistant, or a web search. */
export function classifyInput(text: string): 'url' | 'ai' | 'search' {
  const t = text.trim();
  if (!t) return 'search';
  if (/^(https?|file|about|raven|view-source):/i.test(t)) return 'url';
  if (!/\s/.test(t) && (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t) || /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(:\d+)?([/?#].*)?$/iu.test(t))) return 'url';
  const words = t.split(/\s+/).filter(Boolean);
  const lower = t.toLowerCase();
  const asks = /^(write|create|make|generate|build|implement|code|explain|describe|summari[sz]e|translate|convert|fix|debug|solve|optimi[sz]e|refactor|help|give|show|tell|teach|list|compare|define|how|what|why|when|which|who|whom|whose|where|can|could|should|would|is|are|was|were|does|do|did|will|difference|example|examples)\b/;
  const codey = /\b(code|program|function|algorithm|in (c|c\+\+|cpp|java|python|javascript|js|html|css|sql|rust|go|kotlin)|error|exception|compile|syntax|loop|array|linked list|recursion|pointer|class|bug)\b/;
  if (t.endsWith('?') && words.length >= 2) return 'ai';
  if (words.length >= 4 && (asks.test(lower) || codey.test(lower))) return 'ai';
  if (words.length >= 3 && asks.test(lower) && codey.test(lower)) return 'ai';
  return 'search';
}
