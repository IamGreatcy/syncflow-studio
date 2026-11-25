import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ClipFlowDb } from './db/database.js';
import { ensureInitialSeed } from './db/seed.js';
import { StorageService } from './services/storage.js';
import { facebookReelRuntime, SchedulerEngine } from './scheduler/engine.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

dotenv.config({ path: path.join(repoRoot, '.env') });

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(repoRoot, 'data');

const syncflowDbPath = path.join(dataDir, 'syncflow.sqlite');
const legacyDbPath = path.join(dataDir, 'clipflow.sqlite');
const resolvedDbPath =
  !fs.existsSync(syncflowDbPath) && fs.existsSync(legacyDbPath)
    ? legacyDbPath
    : syncflowDbPath;

const encryptionKeyOrPath =
  process.env.ENCRYPTION_KEY?.trim() || path.join(dataDir, '.master.key');

const db = new ClipFlowDb(resolvedDbPath, encryptionKeyOrPath);
ensureInitialSeed(db);

const storage = new StorageService(dataDir);
const facebookRuntime = facebookReelRuntime(process.env);
const railwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const persistentMountConfigured = Boolean(railwayMount &&
  (dataDir === path.resolve(railwayMount) || dataDir.startsWith(path.resolve(railwayMount) + path.sep)));
const facebookPublishingEnabled = facebookRuntime.allowed &&
  (facebookRuntime.environment === 'local' || persistentMountConfigured);
const scheduler = new SchedulerEngine(db, storage, facebookPublishingEnabled);
const webDistDir = path.join(repoRoot, 'apps', 'web', 'dist');

const app = createApp({
  db,
  storage,
  scheduler,
  webDistDir,
  runtime: {
    ...facebookRuntime,
    allowed: facebookPublishingEnabled,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    persistentMountConfigured,
  },
  onRestartRequested: () => {
    // Exit non-zero so the host (Railway restart policy / Docker) restarts the container
    // and the start command re-pulls the latest release.
    void scheduler.stopAndDrain(12_000).finally(() => {
      try {
        db.close();
      } catch {
        // ignore
      }
      process.exit(1);
    });
  },
});

const port = Number(process.env.PORT || 3001);
const hostname = process.env.HOST?.trim() || '0.0.0.0';
scheduler.start(15_000);

const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname,
  },
  (info) => {
    console.log(
      `[SyncFlow Studio] Server running on http://${hostname === '0.0.0.0' ? 'localhost' : hostname}:${info.port} (bind ${hostname})`
    );
    console.log(`[SyncFlow Studio] Data directory: ${dataDir}`);
  }
);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceTimer = setTimeout(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  }, 18_000);
  forceTimer.unref();

  void scheduler.stopAndDrain(15_000).finally(() => {
    server.close(() => {
      try {
        db.close();
      } catch {}
      clearTimeout(forceTimer);
      process.exit(0);
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
