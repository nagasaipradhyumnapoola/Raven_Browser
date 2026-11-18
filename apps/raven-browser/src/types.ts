// IPC contract between the Raven Browser main process and its UI.
import type { ClientState, ConnState, ErrCode } from '@raven/shared';
import type { ChatMessage, ConversationMeta, DownloadRec } from '@raven/local-memory';

export type InternalPage = 'newtab' | 'search' | 'remote' | 'passwords' | 'history' | 'bookmarks' | 'downloads' | 'settings' | 'memory' | 'reference' | 'connect';

export interface TabView {
  id: number;
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  pinned: boolean;
  /** internal pages are drawn by the UI itself, no web page behind them */
  internal: InternalPage | null;
  zoom: number;
  audible: boolean;
  muted: boolean;
  error: { code: string; text: string; url: string; raven?: ErrCode } | null;
  secure: boolean;
  blocked: number;
  crashed: boolean;
}

export interface PermissionAsk {
  id: number;
  tabId: number;
  origin: string;
  permission: string;
}

export interface PasswordOffer {
  id: number;
  tabId: number;
  origin: string;
  username: string;
  /** the site already has this username saved with another password */
  update: boolean;
}

export interface FindState {
  open: boolean;
  text: string;
  active: number;
  matches: number;
}

export interface ServerSeen {
  name: string;
  host: string;
  port: number;
  fp: string;
}

export interface ConnView {
  state: ConnState;
  /** short human status */
  label: string;
  detail: string;
  endpoint: { host: string; port: number; tls: 'pin' | 'ca'; paired: boolean } | null;
  pairingCode: string | null;
  denied: ErrCode | null;
  server: ClientState | null;
  route: 'gateway' | 'direct' | 'none';
  directAvailable: boolean;
  discovered: ServerSeen[];
  /** Raven Wi-Fi: link code set, joining state, last problem */
  link: { set: boolean; state: string; error: string | null };
  deviceId: string;
  deviceName: string;
  lastError: string | null;
  nextRetryAt: number | null;
}

export interface BrowserSettings {
  theme: 'dark' | 'light' | 'system';
  searchEngine: 'google' | 'duckduckgo' | 'bing' | 'brave' | 'custom';
  customSearch: string;
  homepage: string;
  /** use this PC's own internet when the master gateway is not available */
  directFallback: boolean;
  /** never use anything but the master gateway */
  strictGateway: boolean;
  adblock: boolean;
  adblockAllow: string[];
  askWhereToSave: boolean;
  downloadDir: string;
  pauseHistory: boolean;
  /** searches run on the master and show on Raven's own results page */
  masterSearch: boolean;
  aiSaveConversations: boolean;
  restoreSession: boolean;
  memoryDir: string;
  deviceName: string;
  manualServer: string;
  manualServerCa: boolean;
  smoke: boolean;
  /** questions typed in the address bar are answered by the assistant instead of a search engine */
  addressBarAi: boolean;
  aiWidth: number;
  showBookmarksBar: boolean;
}

export interface WindowState {
  windowId: number;
  private: boolean;
  tabs: TabView[];
  activeId: number;
  closedCount: number;
  sidebar: boolean;
  find: FindState;
  fullscreen: boolean;
  maximized: boolean;
  perms: PermissionAsk[];
  /** "Save password for this site?" waiting for an answer (the password itself never leaves the main process) */
  pwOffer: PasswordOffer | null;
  /** snapshot of the page shown behind overlays, data URL */
  backdrop: string | null;
  bookmarked: boolean;
}

export interface AppState {
  version: string;
  conn: ConnView;
  settings: BrowserSettings;
  memoryRoot: string;
  memoryWarning: string | null;
  downloads: DownloadRec[];
  updateAvailable: string | null;
  dataRoot: string;
  portable: boolean;
}

export interface ChatView {
  id: string | null;
  title: string;
  messages: ChatMessage[];
  streaming: boolean;
  meta: { model: string | null; provider: string | null } | null;
}

export type ChatEvent =
  | { t: 'start'; requestId: number; meta: { model: string | null; provider: string | null } }
  | { t: 'delta'; requestId: number; text: string }
  | { t: 'done'; requestId: number; conversation: ConversationMeta & { messages: ChatMessage[] } }
  | { t: 'error'; requestId: number; code: string; message: string; conversation: (ConversationMeta & { messages: ChatMessage[] }) | null };

export interface PageContext {
  kind: 'page' | 'selection' | 'tabs' | 'saved';
  title: string;
  url: string;
  text: string;
  chars: number;
}

export interface InvokeResult<T = unknown> {
  ok: boolean;
  error?: string;
  code?: string;
  data?: T;
}
