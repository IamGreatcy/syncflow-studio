import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { ClipFlowDb } from '../apps/server/dist/db/database.js';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: node scripts/check-facebook-reel-migration.mjs PATH_TO_SQLITE');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncflow-reel-migration-'));
const copyPath = path.join(directory, 'snapshot.sqlite');

function readSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    return {
      accounts: db.prepare('SELECT COUNT(*) AS count FROM social_accounts').get().count,
      contents: db.prepare('SELECT COUNT(*) AS count FROM content_items').get().count,
      jobs: db.prepare(
        'SELECT j.*,a.connection_mode FROM publish_jobs j JOIN social_accounts a ON a.id = j.social_account_id ORDER BY j.id',
      ).all(),
      logs: db.prepare('SELECT COUNT(*) AS count FROM job_logs').get().count,
    };
  } finally {
    db.close();
  }
}

try {
  const source = new DatabaseSync(path.resolve(sourcePath), { readOnly: true });
  try {
    await backup(source, copyPath);
  } finally {
    source.close();
  }
  const before = readSnapshot(copyPath);
  // The migration stores IDs and statuses and does not decrypt account tokens.
  new ClipFlowDb(copyPath, '0'.repeat(64)).close();
  const after = readSnapshot(copyPath);

  assert.equal(after.accounts, before.accounts);
  assert.equal(after.contents, before.contents);
  assert.equal(after.jobs.length, before.jobs.length);
  assert.equal(after.logs, before.logs);
  let migrated = 0;
  for (let i = 0; i < before.jobs.length; i++) {
    const original = before.jobs[i];
    const result = after.jobs[i];
    assert.equal(original.id, result.id);
    const { facebook_reel_json: oldReceipt, ...oldColumns } = original;
    const { facebook_reel_json: newReceipt, ...newColumns } = result;
    if (original.format !== 'FACEBOOK_REELS' || original.connection_mode !== 'LIVE_OFFICIAL' || oldReceipt || !newReceipt) {
      assert.deepEqual(newColumns, oldColumns);
      assert.equal(newReceipt ?? null, oldReceipt ?? null);
      continue;
    }
    const receipt = JSON.parse(newReceipt);
    assert.equal(receipt.legacy, true);
    assert.equal(result.external_post_id, null);
    assert.equal(result.status, receipt.videoId ? 'PUBLISH_REQUESTED' : 'UNKNOWN');
    if (receipt.videoId) assert.equal(receipt.videoId, original.external_post_id);
    migrated++;
  }

  new ClipFlowDb(copyPath, '0'.repeat(64)).close();
  assert.deepEqual(readSnapshot(copyPath), after);
  console.log(JSON.stringify({
    integrity: 'ok', idempotent: true, jobs: after.jobs.length,
    facebookReelReceiptsMigrated: migrated, logsPreserved: after.logs,
  }));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

