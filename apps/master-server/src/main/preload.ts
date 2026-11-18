// Narrow bridge for the dashboard page: one invoke channel and two event feeds.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('raven', {
  invoke: (method: string, ...args: unknown[]) => ipcRenderer.invoke('raven:invoke', method, ...args),
  onState: (cb: (s: unknown) => void) => {
    const fn = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('raven:state', fn);
    return () => ipcRenderer.removeListener('raven:state', fn);
  },
});
