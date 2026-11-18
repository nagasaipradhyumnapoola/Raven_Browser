// Narrow bridge for the browser UI (never loaded into web pages).
import { contextBridge, ipcRenderer } from 'electron';

const channels = ['raven:win', 'raven:app', 'raven:chat', 'raven:cmd', 'raven:toast', 'raven:ai-action', 'raven:agent'] as const;

contextBridge.exposeInMainWorld('raven', {
  invoke: (method: string, ...args: unknown[]) => ipcRenderer.invoke('raven:invoke', method, ...args),
  on: (channel: (typeof channels)[number], cb: (payload: unknown) => void) => {
    if (!channels.includes(channel)) throw new Error('unknown channel');
    const fn = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
