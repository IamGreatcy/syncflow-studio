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

describe('Cloud / Reverse-Proxy Readiness & STUDIO_PASSCODE Lock', () => {
  it('enforces STUDIO_PASSCODE while keeping /api/health and OAuth callbacks accessible, and resolves https forwarded URLs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-cloud-'));
    const db = new ClipFlowDb(':memory:', 'e'.repeat(64));
    const prevPass = process.env.STUDIO_PASSCODE;
    const prevAppUrl = process.env.APP_BASE_URL;
    try {
      const storage = new StorageService(tmpDir);
      const scheduler = new SchedulerEngine(db, storage);
      const channel = db.createChannel({ name: 'Cloud Channel' });
      seedDefaultChannelData(db, channel.id);
      const ytAcc = db.listAccounts(channel.id).find((a) => a.platform === 'YOUTUBE')!;
      db.updateSettings({
        googleClientId: 'cloud-google-client',
        googleClientSecret: 'cloud-google-secret',
      });

      const app = createApp({ db, storage, scheduler });

      process.env.STUDIO_PASSCODE = 'secret-pass-2026';
      delete process.env.APP_BASE_URL;

      // 1. Protected routes require passcode (JSON for API, friendly login page for browsers)
      const deniedRes = await app.request('http://localhost:3001/api/channels');
      assert.equal(deniedRes.status, 401);
      assert.equal(
        deniedRes.headers.get('www-authenticate'),
        null,
        'must not trigger the browser Basic-Auth popup'
      );
      const pageRes = await app.request('http://localhost:3001/', {
        headers: { accept: 'text/html' },
      });
      assert.equal(pageRes.status, 401);
      assert.ok((await pageRes.text()).includes('name="passcode"'));

      // 1b. Login form: wrong passcode rejected, correct passcode issues a session cookie
      const badLogin = await app.request('http://localhost:3001/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: 'wrong' }),
      });
      assert.equal(badLogin.status, 401);

      const goodLogin = await app.request('http://localhost:3001/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ passcode: 'secret-pass-2026' }),
      });
      assert.equal(goodLogin.status, 200);
      const setCookieHeader = goodLogin.headers.get('set-cookie') || '';
      assert.ok(setCookieHeader.includes('sf_session='));
      assert.ok(/HttpOnly/i.test(setCookieHeader));
      assert.ok(/Secure/i.test(setCookieHeader));
      const cookiePair = setCookieHeader.split(';')[0];

      const cookieRes = await app.request('http://localhost:3001/api/channels', {
        headers: { cookie: cookiePair },
      });
      assert.equal(cookieRes.status, 200);

      const forgedRes = await app.request('http://localhost:3001/api/channels', {
        headers: { cookie: 'sf_session=deadbeef' },
      });
      assert.equal(forgedRes.status, 401);

      // 2. /api/health stays accessible for Railway/Render/Docker probes
      const healthRes = await app.request('http://localhost:3001/api/health');
      assert.equal(healthRes.status, 200);

      // 3. OAuth callback stays accessible so third-party redirects succeed
      const oauthCbRes = await app.request(
        'http://localhost:3001/api/oauth/youtube/callback?error=access_denied'
      );
      assert.notEqual(oauthCbRes.status, 401);

      // 4. Valid Basic Auth unlocks routes + x-forwarded-proto/host builds HTTPS OAuth redirect URI
      const basicHeader =
        'Basic ' + Buffer.from('admin:secret-pass-2026', 'utf8').toString('base64');
      const oauthUrlRes = await app.request(
        `http://localhost:3001/api/accounts/${ytAcc.id}/oauth-url`,
        {
          headers: {
            Authorization: basicHeader,
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'syncflow-prod.up.railway.app',
          },
        }
      );
      assert.equal(oauthUrlRes.status, 200);
      const oauthJson = (await oauthUrlRes.json()) as {
        callbackUrl: string;
        url: string;
      };
      assert.equal(
        oauthJson.callbackUrl,
        'https://syncflow-prod.up.railway.app/api/oauth/youtube/callback'
      );

      // 5. Valid Bearer / x-studio-passcode also works
      const bearerRes = await app.request('http://localhost:3001/api/channels', {
        headers: { Authorization: 'Bearer secret-pass-2026' },
      });
      assert.equal(bearerRes.status, 200);
    } finally {
      if (prevPass === undefined) delete process.env.STUDIO_PASSCODE;
      else process.env.STUDIO_PASSCODE = prevPass;
      if (prevAppUrl === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = prevAppUrl;
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('migrates SQLite database and thumbnails over POST /api/admin/import-db with STUDIO_PASSCODE', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-import-'));
    const encHex = 'f'.repeat(64);
    const prevPass = process.env.STUDIO_PASSCODE;
    const prevEnc = process.env.ENCRYPTION_KEY;
    const srcDbPath = path.join(tmpDir, 'src.sqlite');
    const dstDbPath = path.join(tmpDir, 'dst.sqlite');
    const snapDbPath = path.join(tmpDir, 'snap.sqlite');
    const srcDb = new ClipFlowDb(srcDbPath, encHex);
    const dstDb = new ClipFlowDb(dstDbPath, encHex);

    try {
      process.env.STUDIO_PASSCODE = 'cloud-import-pass';
      process.env.ENCRYPTION_KEY = encHex;

      const ch = srcDb.createChannel({ name: 'Migrated Studio' });
      seedDefaultChannelData(srcDb, ch.id);
      srcDb.updateSettings({ geminiApiKey: undefined, aiProvider: 'GEMINI', aiApiKey: 'test-key-123' } as Record<string, unknown>);

      const escapedSnap = snapDbPath.replace(/'/g, "''");
      srcDb.sqlite.exec(`VACUUM INTO '${escapedSnap}';`);
      const sqliteBase64 = fs.readFileSync(snapDbPath).toString('base64');

      const storage = new StorageService(path.join(tmpDir, 'dst-data'));
      const scheduler = new SchedulerEngine(dstDb, storage);
      const app = createApp({ db: dstDb, storage, scheduler });

      const unauthRes = await app.request('http://localhost:3001/api/admin/import-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sqliteBase64 }),
      });
      assert.equal(unauthRes.status, 401);

      const okRes = await app.request('http://localhost:3001/api/admin/import-db', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer cloud-import-pass',
        },
        body: JSON.stringify({
          sqliteBase64,
          thumbnails: {
            'med_abc123/custom_cover.jpg': Buffer.from('fake-jpeg').toString('base64'),
          },
        }),
      });
      assert.equal(okRes.status, 200);
      const okJson = (await okRes.json()) as {
        ok: boolean;
        imported: { channels: number; accounts: number; rules: number };
      };
      assert.equal(okJson.ok, true);
      assert.equal(okJson.imported.channels, 1);
      assert.equal(okJson.imported.accounts, 4);
      assert.equal(okJson.imported.rules, 42);
      assert.equal(dstDb.getSettingsFull().aiApiKey, 'test-key-123');
      assert.ok(fs.existsSync(path.join(storage.thumbnailsDir, 'med_abc123', 'custom_cover.jpg')));

      // One-click cloud update: restart endpoint is guarded and only fires the injected hook
      let restartCalls = 0;
      const restartApp = createApp({
        db: dstDb,
        storage,
        scheduler,
        onRestartRequested: () => {
          restartCalls++;
        },
      });
      const noAuthRestart = await restartApp.request('http://localhost:3001/api/admin/restart', {
        method: 'POST',
      });
      assert.equal(noAuthRestart.status, 401);
      const okRestart = await restartApp.request('http://localhost:3001/api/admin/restart', {
        method: 'POST',
        headers: { Authorization: 'Bearer cloud-import-pass' },
      });
      assert.equal(okRestart.status, 200);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(restartCalls, 1);
    } finally {
      if (prevPass === undefined) delete process.env.STUDIO_PASSCODE;
      else process.env.STUDIO_PASSCODE = prevPass;
      if (prevEnc === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prevEnc;
      srcDb.close();
      dstDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
