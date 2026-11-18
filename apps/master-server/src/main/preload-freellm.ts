// Preload for the embedded FreeLLMAPI dashboard window. Same approach as
// FreeLLMAPI's own desktop app: seed its session token before the page runs.
import { contextBridge } from 'electron';

const TOKEN_KEY = 'freellmapi_dashboard_token';
const arg = process.argv.find((a) => a.startsWith('--freeapi-token='));
if (arg) {
  try {
    window.localStorage.setItem(TOKEN_KEY, arg.slice('--freeapi-token='.length));
  } catch {
    /* the dashboard will show its own login screen */
  }
}
contextBridge.exposeInMainWorld('__FREEAPI_DESKTOP__', true);
