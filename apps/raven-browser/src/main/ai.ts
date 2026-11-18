// AI chat runner: streams answers from the master gateway, saves conversations
// as files, and extracts page text with a restricted script that skips form
// fields, passwords and anything the user typed.
import type { WebContents } from 'electron';
import { ERR_TEXT, type AiMessage, type ErrCode } from '@raven/shared';
import type { ChatMessage, MemoryStore } from '@raven/local-memory';
import type { ConnectionManager } from './connection';
import type { ChatEvent, PageContext } from '../types';

const SYSTEM_GENERAL =
  'You are Raven, the assistant built into Raven Browser. Answer clearly and correctly. Use Markdown. Put code in fenced code blocks with the language name. If you are not sure, say so.';
const SYSTEM_CODING =
  'You are Raven, a programming tutor and assistant built into Raven Browser. The user is a beginner or intermediate programmer. Explain step by step, give complete runnable code in fenced code blocks with the language name (python, java, c, cpp, javascript, html, css), point out common mistakes, and keep explanations short and concrete. If a question is ambiguous, state your assumption.';

const CODE_HINT = /\b(code|program|function|class|compile|error|exception|debug|bug|python|java|javascript|typescript|c\+\+|cpp|html|css|sql|algorithm|array|linked list|stack|queue|tree|recursion|loop|pointer|segfault|syntax)\b|```|[{};]\s*$/im;

/** Runs inside the page (isolated world). Reads visible text only; never form values. */
const EXTRACT_PAGE = `(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','CANVAS','IFRAME','INPUT','TEXTAREA','SELECT','OPTION','BUTTON','FORM','NAV','FOOTER','ASIDE','HEADER']);
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  if (!root) return { title: document.title, text: '' };
  const out = [];
  let size = 0;
  const walk = (el) => {
    if (size > 60000) return;
    if (SKIP.has(el.tagName)) return;
    if (el.isContentEditable) return;
    if (el.getAttribute && (el.getAttribute('aria-hidden') === 'true' || el.hidden)) return;
    const cs = el.nodeType === 1 ? getComputedStyle(el) : null;
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\\s+/g, ' ').trim();
        if (t) { out.push(t); size += t.length + 1; }
      } else if (n.nodeType === 1) {
        const tag = n.tagName;
        if (tag === 'PRE' || tag === 'CODE') {
          const t = n.innerText || '';
          if (t.trim()) { out.push(tag === 'PRE' ? '\\n\`\`\`\\n' + t.trim() + '\\n\`\`\`\\n' : t.trim()); size += t.length; }
        } else {
          if (/^(P|DIV|LI|H[1-6]|TR|BR|SECTION|BLOCKQUOTE)$/.test(tag)) out.push('\\n');
          walk(n);
        }
      }
    }
  };
  walk(root);
  return { title: document.title, text: out.join(' ').replace(/ *\\n[ \\n]*/g, '\\n').trim().slice(0, 60000) };
})()`;

const EXTRACT_SELECTION = `(() => {
  const a = document.activeElement;
  // Never read from inside an editable field the user is typing in.
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return '';
  return String(window.getSelection() || '').slice(0, 20000);
})()`;

/** Sites whose content is private by nature; the AI never reads them automatically. */
const SENSITIVE = /(^|\.)(mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com|web\.whatsapp\.com|messenger\.com|accounts\.google\.com|login\.|signin\.|paypal\.com|bank|checkout\.)/i;

export function isSensitiveUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return SENSITIVE.test(u.hostname) || /\/(login|signin|checkout|payment|account\/security)/i.test(u.pathname);
  } catch {
    return true;
  }
}

export async function extractPage(wc: WebContents, url: string): Promise<PageContext> {
  if (!/^https?:|^file:/i.test(url)) throw new Error('This page cannot be read.');
  if (isSensitiveUrl(url)) throw new Error('This looks like a private page (mail, sign-in or payment). Raven does not send it to the AI. Select the exact text you want explained instead.');
  const r = (await wc.executeJavaScriptInIsolatedWorld(999, [{ code: EXTRACT_PAGE }])) as { title: string; text: string };
  const text = String(r?.text ?? '').trim();
  if (!text) throw new Error('No readable text was found on this page.');
  return { kind: 'page', title: String(r?.title || url), url, text, chars: text.length };
}

export async function extractSelection(wc: WebContents, url: string, title: string): Promise<PageContext> {
  const t = String((await wc.executeJavaScriptInIsolatedWorld(999, [{ code: EXTRACT_SELECTION }])) ?? '').trim();
  if (!t) throw new Error('Select some text on the page first.');
  return { kind: 'selection', title, url, text: t, chars: t.length };
}

interface Running {
  abort: () => void;
}

export class ChatRunner {
  private seq = 1;
  private running = new Map<number, Running>();

  constructor(
    private conn: ConnectionManager,
    private memory: () => MemoryStore,
    private canSave: () => boolean,
  ) {}

  /**
   * Send a message. History is the conversation so far (without the new
   * message). Emits ChatEvents through `emit`. Returns the request id.
   */
  send(opts: {
    conversationId: string | null;
    title?: string;
    history: ChatMessage[];
    text: string;
    context: PageContext[];
    model: string;
    mode: 'auto' | 'general' | 'coding';
    private: boolean;
    emit: (e: ChatEvent) => void;
  }): number {
    const requestId = this.seq++;
    const now = Date.now();
    const ctxLabel = opts.context.map((c) => `${c.kind === 'selection' ? 'Selected text' : c.kind === 'saved' ? 'Saved page' : 'Page'}: ${c.title} (${c.chars.toLocaleString()} chars)`).join('; ');
    const userMsg: ChatMessage = { role: 'user', content: opts.text, ts: now, ...(ctxLabel ? { context: ctxLabel } : {}) };
    const messages: ChatMessage[] = [...opts.history.filter((m) => !m.error), userMsg];
    const coding = opts.mode === 'coding' || (opts.mode === 'auto' && (CODE_HINT.test(opts.text) || opts.history.some((m) => m.content.includes('```'))));
    const wire: AiMessage[] = [{ role: 'system', content: coding ? SYSTEM_CODING : SYSTEM_GENERAL }];
    // Keep the request a reasonable size: newest messages first, about 24k characters of history.
    let budget = 24_000;
    const past: AiMessage[] = [];
    for (let i = messages.length - 2; i >= 0 && budget > 0; i--) {
      const m = messages[i];
      if (m.role === 'system') continue;
      const c = m.content.slice(0, budget);
      budget -= c.length;
      past.unshift({ role: m.role, content: c });
    }
    wire.push(...past);
    let content = opts.text;
    if (opts.context.length) {
      const blocks = opts.context.map((c) => `--- ${c.kind === 'selection' ? 'Selected text' : 'Content'} from "${c.title}" (${c.url}) ---\n${c.text.slice(0, 40_000 / opts.context.length)}`);
      content = `${blocks.join('\n\n')}\n\n--- Question ---\n${opts.text}`;
    }
    wire.push({ role: 'user', content });

    const title = opts.title || opts.text.replace(/\s+/g, ' ').slice(0, 60) || 'Conversation';
    let convId = opts.conversationId;
    const persist = (msgs: ChatMessage[]) => {
      if (opts.private || !this.canSave()) return { id: convId ?? `p${requestId}x0000`, title, created: now, updated: Date.now(), count: msgs.length, messages: msgs };
      const saved = this.memory().saveConversation({ id: convId ?? undefined, title, messages: msgs });
      convId = saved.id;
      return { id: saved.id, title: saved.title, created: saved.created, updated: saved.updated, count: saved.messages.length, messages: saved.messages };
    };

    let cancelled = false;
    let stream: { destroy: () => void } | null = null;
    this.running.set(requestId, {
      abort: () => {
        cancelled = true;
        stream?.destroy();
      },
    });

    void (async () => {
      let answer = '';
      let model: string | null = null;
      try {
        const opened = await this.conn.client.openAi({ messages: wire, model: opts.model || 'auto', profile: coding ? 'coding' : 'general' });
        stream = opened.stream;
        model = opened.meta.model;
        if (cancelled) {
          opened.stream.destroy();
          throw Object.assign(new Error('Stopped.'), { code: 'cancelled' });
        }
        opts.emit({ t: 'start', requestId, meta: { model: opened.meta.model, provider: opened.meta.provider } });
        let buf = '';
        for await (const chunk of opened.stream) {
          buf += chunk.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              if (j.error) throw Object.assign(new Error(j.error.message ?? 'The provider returned an error.'), { code: 'providers_unavailable' });
              const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
              if (!model && typeof j.model === 'string') model = j.model;
              if (delta) {
                answer += delta;
                opts.emit({ t: 'delta', requestId, text: delta });
              }
            } catch (e) {
              if ((e as any).code) throw e;
            }
          }
        }
        if (!answer.trim()) throw Object.assign(new Error('The model returned an empty answer.'), { code: 'providers_unavailable' });
        const conv = persist([...messages, { role: 'assistant', content: answer, ts: Date.now(), model }]);
        opts.emit({ t: 'done', requestId, conversation: conv });
      } catch (e) {
        const code = String((e as any)?.code ?? 'server_unreachable');
        const raw = String((e as Error)?.message ?? '');
        const message =
          code === 'cancelled'
            ? 'Stopped.'
            : code === 'providers_unavailable' && /no candidate model has a configured|provider key/i.test(raw)
              ? 'No AI provider key is set up on the master server yet. The server owner adds one under AI and API keys.'
              : ERR_TEXT[code as ErrCode] ?? (raw || 'The answer failed.');
        const tail: ChatMessage[] = answer ? [{ role: 'assistant', content: answer, ts: Date.now(), model, ...(code === 'cancelled' ? {} : { error: message }) }] : [];
        const conv = answer || code !== 'cancelled' ? persist([...messages, ...tail]) : null;
        opts.emit({ t: 'error', requestId, code, message, conversation: conv });
      } finally {
        this.running.delete(requestId);
      }
    })();
    return requestId;
  }

  stop(requestId: number): void {
    this.running.get(requestId)?.abort();
  }
}
