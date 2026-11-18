// The assistant router: decides what to do with text typed in a Raven Browser.
// Obvious cases are decided by fixed rules (so free models changing from call to call cannot get them wrong);
// the AI decides the rest.
import type { DeviceRecord, RouteDecision } from '@raven/shared';
import type { AiService } from './ai';

const ROUTER = `You route what a person typed into their browser's address bar. Reply with ONE JSON object only:
{"action":"answer"}                       a question or request the assistant can answer in chat (facts, explanations, code, writing, advice)
{"action":"open","url":"https://..."}    they want a specific website opened
{"action":"search","query":"..."}        they want a list of web results (shopping, news, local places, "best ... near me")
{"action":"task","goal":"..."}           they want something DONE on a website or in an account: send/read email, message someone, post, fill a form, book, buy, check an inbox or order status, log in somewhere
If they explicitly ask to go to, use, open or check a website, app or their own account to do or find something ("go to wikipedia and…", "on amazon find…", "check my gmail…"), it is a "task" even if you already know the answer.
Otherwise prefer "answer" when unsure. For "task", restate the goal clearly in one sentence with every detail they gave.`;

export function jsonFrom(text: string): any {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** "open youtube", "go to github.com", "visit the wikipedia website" -> the site's address (no AI needed). */
export function openTarget(text: string): string | null {
  const m = /^(?:please\s+)?(?:open|go to|goto|visit|launch|take me to)\s+(?:the\s+)?([a-z0-9][a-z0-9.-]*?)(?:\s+(?:website|site|page|app))?\s*[.!]?$/i.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  return `https://${name.includes('.') ? name : `www.${name}.com`}`;
}

/** Plain errands on a site or in an account: these become tasks whatever the model says. */
const ERRAND =
  /\b(check|read|open) my\b|\b(send|reply|forward|message|text|email|mail|post|tweet|book|order|buy|purchase|pay|log ?in|sign ?in|sign up|subscribe|unsubscribe|fill (in|out))\b.+\b(to|on|in|for|at|from)\b|^(go to|on|in|use) \S+ (and|to) /i;
/** Questions ("how do I send…", "explain…") are never errands. */
const QUESTION = /^(how|what|why|when|where|who|which|explain|describe|define|tell me about|teach|write|show me how|can you explain|is|are|does|do)\b|\?\s*$/i;

export function isErrand(text: string): boolean {
  return ERRAND.test(text) && !QUESTION.test(text);
}

/** Ask the AI. Anything unclear, refused or slow becomes "answer" so typing always does something useful. */
export async function routeInput(ai: AiService, device: DeviceRecord, text: string, tasksAllowed: boolean): Promise<RouteDecision> {
  const t = text.trim().slice(0, 2000);
  if (!t) return { action: 'answer' };
  const site = openTarget(t);
  if (site) return { action: 'open', url: site };
  const errand = tasksAllowed && isErrand(t);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const r = await ai.complete(device, [{ role: 'system', content: ROUTER }, { role: 'user', content: t }], ctl.signal, { max_tokens: 160, temperature: 0 });
    const j = jsonFrom(r.text);
    if (j?.action === 'open' && typeof j.url === 'string' && /^https?:\/\//i.test(j.url)) return { action: 'open', url: j.url.slice(0, 2000) };
    if (j?.action === 'search' && typeof j.query === 'string' && j.query.trim()) return { action: 'search', query: j.query.slice(0, 500) };
    if (j?.action === 'task' && typeof j.goal === 'string' && j.goal.trim()) return tasksAllowed ? { action: 'task', goal: j.goal.slice(0, 1000) } : { action: 'answer' };
    return errand ? { action: 'task', goal: t } : { action: 'answer' };
  } catch {
    return errand ? { action: 'task', goal: t } : { action: 'answer' };
  } finally {
    clearTimeout(timer);
  }
}
