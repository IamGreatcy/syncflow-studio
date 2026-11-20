import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcDataDir = path.resolve(process.env.DATA_DIR || path.join(repoRoot, 'data'));
const bundleDir = path.join(repoRoot, 'cloud-bundle');
const bundleDataDir = path.join(bundleDir, 'data');

function loadConnectionConfig() {
  const connFile = path.join(bundleDir, 'cloud-connection.json');
  let fileCfg = {};
  if (fs.existsSync(connFile)) {
    fileCfg = JSON.parse(fs.readFileSync(connFile, 'utf8'));
  }
  const cloudUrl = (process.env.CLOUD_URL || fileCfg.cloudUrl || '').replace(/\/+$/, '');
  const passcode = process.env.STUDIO_PASSCODE || fileCfg.passcode || '';
  if (!cloudUrl || !passcode) {
    throw new Error(
      'Missing CLOUD_URL / STUDIO_PASSCODE (set env vars or populate cloud-bundle/cloud-connection.json)'
    );
  }
  return { cloudUrl, passcode };
}

function collectThumbnails(rootThumbDir) {
  const thumbs = {};
  if (!fs.existsSync(rootThumbDir)) return thumbs;
  for (const assetId of fs.readdirSync(rootThumbDir)) {
    const assetDir = path.join(rootThumbDir, assetId);
    if (!fs.statSync(assetDir).isDirectory()) continue;
    for (const file of fs.readdirSync(assetDir)) {
      const fullPath = path.join(assetDir, file);
      if (!fs.statSync(fullPath).isFile()) continue;
      thumbs[`${assetId}/${file}`] = fs.readFileSync(fullPath).toString('base64');
    }
  }
  return thumbs;
}

async function main() {
  const { cloudUrl, passcode } = loadConnectionConfig();

  const syncflowDb = path.join(srcDataDir, 'syncflow.sqlite');
  const legacyDb = path.join(srcDataDir, 'clipflow.sqlite');
  const sourceDbPath = fs.existsSync(syncflowDb) ? syncflowDb : legacyDb;
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source database not found in ${srcDataDir}`);
  }

  fs.mkdirSync(bundleDataDir, { recursive: true });
  const snapshotDbPath = path.join(bundleDataDir, 'syncflow.sqlite');
  fs.rmSync(snapshotDbPath, { force: true });

  const db = new DatabaseSync(sourceDbPath);
  try {
    const escaped = snapshotDbPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}';`);
  } finally {
    db.close();
  }

  const sqliteBase64 = fs.readFileSync(snapshotDbPath).toString('base64');
  const thumbnails = collectThumbnails(path.join(srcDataDir, 'thumbnails'));

  console.log(`Syncing snapshot (${snapshotDbPath}) + ${Object.keys(thumbnails).length} thumbnail(s) to ${cloudUrl}...`);

  const res = await fetch(`${cloudUrl}/api/admin/import-db`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${passcode}`,
    },
    body: JSON.stringify({ sqliteBase64, thumbnails }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cloud DB sync failed (${res.status}): ${text}`);
  }
  console.log('Sync complete:', text);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
