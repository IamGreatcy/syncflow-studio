import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ClipFlowDb } from './db/database.js';
import { ensureInitialSeed } from './db/seed.js';
import { StorageService } from './services/storage.js';
import { SchedulerEngine } from './scheduler/engine.js';
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
const scheduler = new SchedulerEngine(db, storage);
const webDistDir = path.join(repoRoot, 'apps', 'web', 'dist');

const app = createApp({
  db,
  storage,
  scheduler,
  webDistDir,
  onRestartRequested: () => {
    // Exit non-zero so the host (Railway restart policy / Docker) restarts the container
    // and the start command re-pulls the latest release.
    scheduler.stop();
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(1);
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

function shutdown() {
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
