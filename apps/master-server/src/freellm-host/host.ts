// Runs the real FreeLLMAPI server (vendor/freellmapi, MIT) as a supervised
// child process of MasterServer.exe. Mirrors the boot sequence of FreeLLMAPI's
// own desktop embedder (desktop/src/server-host.ts) and uses its built-in
// node:sqlite driver so no native module has to be compiled.
//
// Parent -> child env: RAVEN_FL_DB, RAVEN_FL_PORT, RAVEN_FL_CLIENT_DIST,
// ENCRYPTION_KEY (hex), NODE_ENV=production.
// Child -> parent (IPC): { t: 'ready', port, apiKey, sessionToken } | { t: 'fatal', error }
import '../../../../vendor/freellmapi/server/src/env.js';
import { createApp } from '../../../../vendor/freellmapi/server/src/app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../../../vendor/freellmapi/server/src/db/index.js';
import { nodeSqliteFactory } from '../../../../vendor/freellmapi/server/src/db/node-sqlite.js';
import { restoreProxySettings, flushProxyCache } from '../../../../vendor/freellmapi/server/src/lib/proxy.js';
import { startHealthChecker, checkAllKeys } from '../../../../vendor/freellmapi/server/src/services/health.js';
import { startCatalogSync } from '../../../../vendor/freellmapi/server/src/services/catalog-sync.js';
import { startCooldownProbe } from '../../../../vendor/freellmapi/server/src/services/cooldown-probe.js';
import { startModelProbe } from '../../../../vendor/freellmapi/server/src/services/model-probe.js';
import { startCustomModelSync } from '../../../../vendor/freellmapi/server/src/services/custom-model-sync.js';
import { startBuiltinModelDiscovery } from '../../../../vendor/freellmapi/server/src/services/builtin-model-discovery.js';
import { startBackupScheduler } from '../../../../vendor/freellmapi/server/src/services/backups.js';
import { cleanupExpiredCooldowns } from '../../../../vendor/freellmapi/server/src/services/ratelimit.js';
import { loadCacheFromDb } from '../../../../vendor/freellmapi/server/src/services/cache.js';
import { startWakeDetect } from '../../../../vendor/freellmapi/server/src/lib/wake-detect.js';
import { installProcessSafetyNet } from '../../../../vendor/freellmapi/server/src/lib/process-safety-net.js';
import { installLogRedaction } from '../../../../vendor/freellmapi/server/src/lib/log-redaction.js';
import { desktopSessionToken } from '../../../../vendor/freellmapi/server/src/services/auth.js';
import { NodeScheduler } from '../../../../vendor/freellmapi/server/src/lib/scheduler.js';

function send(msg: Record<string, unknown>): void {
  if (typeof process.send === 'function') {
    process.send(msg);
    return;
  }
  // Run by hand (no parent): print the event without any secret.
  const safe: Record<string, unknown> = { ...msg };
  for (const k of ['apiKey', 'sessionToken']) if (k in safe) safe[k] = '[hidden]';
  console.log('[freellm-host]', JSON.stringify(safe));
}

async function main(): Promise<void> {
  installLogRedaction();
  installProcessSafetyNet();
  const dbPath = process.env.RAVEN_FL_DB;
  const port = Number(process.env.RAVEN_FL_PORT ?? 47811);
  if (!dbPath) throw new Error('RAVEN_FL_DB is not set');
  if (process.env.RAVEN_FL_CLIENT_DIST) process.env.CLIENT_DIST = process.env.RAVEN_FL_CLIENT_DIST;
  // Same marker FreeLLMAPI's desktop app sets: loopback callers skip password re-entry.
  process.env.FREEAPI_DESKTOP = '1';
  initDb(dbPath, { factory: nodeSqliteFactory });
  cleanupExpiredCooldowns();
  restoreProxySettings();
  loadCacheFromDb();
  const app = createApp();
  // Loopback only: the master gateway is the single client of this server.
  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 76_000;
  const scheduler = new NodeScheduler();
  startHealthChecker(scheduler);
  startCatalogSync(scheduler);
  startCooldownProbe(scheduler);
  startModelProbe(scheduler);
  startBackupScheduler(scheduler);
  startCustomModelSync(getDb(), scheduler);
  startBuiltinModelDiscovery(getDb(), scheduler);
  startWakeDetect({
    async onWake() {
      flushProxyCache();
      try {
        await checkAllKeys({ force: true });
      } catch {
        /* next health pass will retry */
      }
    },
  });
  send({ t: 'ready', port, apiKey: getUnifiedApiKey(), sessionToken: desktopSessionToken() });

  const shutdown = () => {
    server.close(() => {
      try {
        getDb().close?.();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('message', (m: any) => {
    if (m && m.t === 'shutdown') shutdown();
    if (m && m.t === 'session') send({ t: 'session', sessionToken: desktopSessionToken() });
    if (m && m.t === 'key') send({ t: 'key', apiKey: getUnifiedApiKey() });
  });
  process.on('disconnect', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  send({ t: 'fatal', error: String(err?.message ?? err) });
  console.error('[freellm-host] fatal:', err);
  process.exit(1);
});
