import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ClipFlowDb } from '../src/db/database.js';
import { seedDefaultChannelData } from '../src/db/seed.js';
import { SchedulerEngine } from '../src/scheduler/engine.js';
import { StorageService } from '../src/services/storage.js';

function setupTestApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-auth-'));
  const db = new ClipFlowDb(':memory:', 'd'.repeat(64));
  const storage = new StorageService(tmpDir);
  const scheduler = new SchedulerEngine(db, storage);
  const channel = db.createChannel({ name: 'Auth Test Channel' });
  seedDefaultChannelData(db, channel.id);
  const accounts = db.listAccounts(channel.id);
  const app = createApp({ db, storage, scheduler });
  return { tmpDir, db, app, accounts };
}

describe('Local-First OAuth & Token Connection Routes', () => {
  it('saves OAuth app keys in DB settings and immediately builds Google/Meta/TikTok OAuth URLs without .env', async () => {
    const { tmpDir, db, app, accounts } = setupTestApp();
    try {
      const saveRes = await app.request('http://localhost:3001/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          googleClientId: 'google-id-in-db',
          googleClientSecret: 'google-secret-in-db',
          metaAppId: 'meta-app-in-db',
          metaAppSecret: 'meta-secret-in-db',
          tiktokClientKey: 'tiktok-key-in-db',
          tiktokClientSecret: 'tiktok-secret-in-db',
        }),
      });
      assert.equal(saveRes.status, 200);
      const savedJson = (await saveRes.json()) as {
        settings: {
          googleClientId: string;
          hasGoogleClientSecret: boolean;
          metaAppId: string;
          hasMetaAppSecret: boolean;
          tiktokClientKey: string;
          hasTiktokClientSecret: boolean;
        };
      };
      assert.equal(savedJson.settings.googleClientId, 'google-id-in-db');
      assert.equal(savedJson.settings.hasGoogleClientSecret, true);
      assert.equal(savedJson.settings.metaAppId, 'meta-app-in-db');
      assert.equal(savedJson.settings.hasMetaAppSecret, true);
      assert.equal(savedJson.settings.tiktokClientKey, 'tiktok-key-in-db');
      assert.equal(savedJson.settings.hasTiktokClientSecret, true);

      const ytAcc = accounts.find((a) => a.platform === 'YOUTUBE')!;
      const fbAcc = accounts.find((a) => a.platform === 'FACEBOOK')!;
      const igAcc = accounts.find((a) => a.platform === 'INSTAGRAM')!;
      const ttAcc = accounts.find((a) => a.platform === 'TIKTOK')!;

      const ytRes = await app.request(
        `http://localhost:3001/api/accounts/${ytAcc.id}/oauth-url`
      );
      assert.equal(ytRes.status, 200);
      const ytJson = (await ytRes.json()) as { url: string };
      assert.ok(ytJson.url.includes('accounts.google.com/o/oauth2/v2/auth'));
      assert.ok(ytJson.url.includes('client_id=google-id-in-db'));

      const fbRes = await app.request(
        `http://localhost:3001/api/accounts/${fbAcc.id}/oauth-url`
      );
      assert.equal(fbRes.status, 200);
      const fbJson = (await fbRes.json()) as { url: string };
      assert.ok(fbJson.url.includes('facebook.com'));
      assert.ok(fbJson.url.includes('client_id=meta-app-in-db'));
      assert.ok(fbJson.url.includes('instagram_content_publish'));

      const igRes = await app.request(
        `http://localhost:3001/api/accounts/${igAcc.id}/oauth-url`
      );
      assert.equal(igRes.status, 200);
      const igJson = (await igRes.json()) as { url: string };
      assert.ok(igJson.url.includes('client_id=meta-app-in-db'));

      const ttRes = await app.request(
        `http://localhost:3001/api/accounts/${ttAcc.id}/oauth-url`
      );
      assert.equal(ttRes.status, 200);
      const ttJson = (await ttRes.json()) as { url: string };
      assert.ok(ttJson.url.includes('tiktok.com'));
      assert.ok(ttJson.url.includes('client_key=tiktok-key-in-db'));

      const customRedirectRes = await app.request(
        `http://localhost:3001/api/accounts/${ttAcc.id}/oauth-url?redirectUri=${encodeURIComponent('https://synccut.pages.dev/')}`
      );
      assert.equal(customRedirectRes.status, 200);
      const customRedirectJson = (await customRedirectRes.json()) as {
        url: string;
        callbackUrl: string;
      };
      assert.equal(customRedirectJson.callbackUrl, 'https://synccut.pages.dev/');
      assert.ok(
        customRedirectJson.url.includes(
          encodeURIComponent('https://synccut.pages.dev/')
        )
      );

      const noCodeRes = await app.request(
        `http://localhost:3001/api/accounts/${ttAcc.id}/oauth-complete-url`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirectedUrl: 'https://synccut.pages.dev/?state=abc',
          }),
        }
      );
      assert.equal(noCodeRes.status, 400);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates connect-token and select-meta-page payloads cleanly', async () => {
    const { tmpDir, db, app, accounts } = setupTestApp();
    try {
      const ytAcc = accounts.find((a) => a.platform === 'YOUTUBE')!;
      const fbAcc = accounts.find((a) => a.platform === 'FACEBOOK')!;

      const emptyTokenRes = await app.request(
        `http://localhost:3001/api/accounts/${ytAcc.id}/connect-token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: '   ' }),
        }
      );
      assert.equal(emptyTokenRes.status, 400);

      const missingAccRes = await app.request(
        'http://localhost:3001/api/accounts/acc_does_not_exist/connect-token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: 'ya29.fake' }),
        }
      );
      assert.equal(missingAccRes.status, 404);

      const badSessionRes = await app.request(
        `http://localhost:3001/api/accounts/${fbAcc.id}/select-meta-page`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'expired', pageId: '123' }),
        }
      );
      assert.equal(badSessionRes.status, 400);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
