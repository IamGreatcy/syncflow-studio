import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Busboy from 'busboy';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  CONTENT_FORMATS,
  PLATFORMS,
  computePrewarmIso,
  detectRecommendedFormats,
  determinePublishStrategy,
  formatToPlatform,
  resolveScheduledTimesForDate,
  validateFormatMetadata,
  validateVideoCompatibility,
  zonedDateTimeToUtcIso,
  type ContentFormat,
  type MasterBrief,
  type Platform,
  type PlatformMetadataMap,
  type ValidationIssue,
} from '@clipflow/shared';
import type { ClipFlowDb } from './db/database.js';
import { seedDefaultChannelData } from './db/seed.js';
import type { StorageService } from './services/storage.js';
import {
  checkFfmpegAvailability,
  extractThumbnails,
  optimizeVideoForPlatforms,
  probeVideo,
} from './services/media.js';
import { generateMetadataWithAI } from './services/metadata-engine.js';
import {
  getSyncCutCoverPath,
  importSyncCutEpisode,
  listSyncCutEpisodes,
} from './services/synccut-bridge.js';
import type { SchedulerEngine } from './scheduler/engine.js';
import { getAdapter, tiktokAdapter } from './adapters/registry.js';
import {
  discoverMetaPages,
  type DiscoveredMetaPageFull,
} from './adapters/facebook.js';

interface OAuthStateEntry {
  accountId: string;
  platform: Platform;
  redirectUri: string;
  createdAt: number;
}

interface PendingMetaSession {
  accountId: string;
  pages: DiscoveredMetaPageFull[];
  createdAt: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SyncFlow Studio — เข้าสู่ระบบ</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;
    background:linear-gradient(160deg,#eef1ff,#f7f7fb 55%,#e9f6ff);color:#1c1c1e}
  .card{width:min(92vw,380px);background:#fff;border-radius:22px;padding:32px 28px;
    box-shadow:0 18px 50px rgba(30,40,90,.14)}
  h1{font-size:20px;margin:0 0 4px}
  p{margin:0 0 20px;color:#6b6b73;font-size:13.5px}
  input{width:100%;padding:13px 14px;font-size:16px;border:1px solid #d9d9e0;border-radius:12px;outline:none}
  input:focus{border-color:#007aff;box-shadow:0 0 0 3px rgba(0,122,255,.15)}
  button{width:100%;margin-top:14px;padding:13px;font-size:16px;font-weight:600;color:#fff;
    background:#007aff;border:0;border-radius:12px;cursor:pointer}
  button:disabled{opacity:.6}
  .err{min-height:20px;margin-top:12px;color:#ff3b30;font-size:13px}
</style>
</head>
<body>
<form class="card" id="f">
  <h1>SyncFlow Studio</h1>
  <p>กรอกรหัสผ่านครั้งเดียว ระบบจะจำไว้ในอุปกรณ์นี้ 30 วัน</p>
  <input id="p" name="passcode" type="password" placeholder="รหัสผ่าน" autocomplete="current-password" autofocus />
  <button id="b" type="submit">เข้าสู่ระบบ</button>
  <div class="err" id="e"></div>
</form>
<script>
  const f=document.getElementById('f'),p=document.getElementById('p'),b=document.getElementById('b'),e=document.getElementById('e');
  f.addEventListener('submit',async(ev)=>{
    ev.preventDefault();e.textContent='';b.disabled=true;
    try{
      const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:p.value})});
      const d=await r.json().catch(()=>({}));
      if(r.ok){location.reload();return;}
      e.textContent=d.error||'เข้าสู่ระบบไม่สำเร็จ';
    }catch{e.textContent='เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';}
    b.disabled=false;
  });
</script>
</body>
</html>`;

export function createApp(params: {
  db: ClipFlowDb;
  storage: StorageService;
  scheduler: SchedulerEngine;
  webDistDir?: string;
  onRestartRequested?: () => void;
}) {
  const { db, storage, scheduler } = params;
  const app = new Hono();
  const oauthStates = new Map<string, OAuthStateEntry>();
  const pendingMetaSessions = new Map<string, PendingMetaSession>();

  function applyMetaPageToAccounts(params: {
    targetAccountId: string;
    page: DiscoveredMetaPageFull;
    alsoLinkPairedMeta: boolean;
  }) {
    const account = db.getAccount(params.targetAccountId);
    if (!account) throw new Error('Account not found');

    const linked: string[] = [];
    if (account.platform === 'FACEBOOK') {
      db.updateAccount(account.id, {
        connectionMode: 'LIVE_OFFICIAL',
        accessToken: params.page.pageAccessToken,
        externalAccountId: params.page.pageId,
        accountName: params.page.pageName,
        status: 'CONNECTED',
      });
      linked.push(`Facebook (${params.page.pageName})`);

      if (params.alsoLinkPairedMeta && params.page.igUserId) {
        const igSibling = db
          .listAccounts(account.channelId)
          .find((a) => a.platform === 'INSTAGRAM');
        if (igSibling) {
          db.updateAccount(igSibling.id, {
            connectionMode: 'LIVE_OFFICIAL',
            accessToken: params.page.pageAccessToken,
            externalAccountId: params.page.igUserId,
            accountName: params.page.igUsername
              ? `@${params.page.igUsername}`
              : params.page.igName || params.page.pageName,
            status: 'CONNECTED',
          });
          linked.push(`Instagram (${params.page.igUsername || params.page.igUserId})`);
        }
      }
    } else if (account.platform === 'INSTAGRAM') {
      if (!params.page.igUserId) {
        throw new Error(
          `เพจ "${params.page.pageName}" ยังไม่ได้เชื่อมกับ Instagram Business Account`
        );
      }
      db.updateAccount(account.id, {
        connectionMode: 'LIVE_OFFICIAL',
        accessToken: params.page.pageAccessToken,
        externalAccountId: params.page.igUserId,
        accountName: params.page.igUsername
          ? `@${params.page.igUsername}`
          : params.page.igName || params.page.pageName,
        status: 'CONNECTED',
      });
      linked.push(`Instagram (${params.page.igUsername || params.page.igUserId})`);

      if (params.alsoLinkPairedMeta) {
        const fbSibling = db
          .listAccounts(account.channelId)
          .find((a) => a.platform === 'FACEBOOK');
        if (fbSibling) {
          db.updateAccount(fbSibling.id, {
            connectionMode: 'LIVE_OFFICIAL',
            accessToken: params.page.pageAccessToken,
            externalAccountId: params.page.pageId,
            accountName: params.page.pageName,
            status: 'CONNECTED',
          });
          linked.push(`Facebook (${params.page.pageName})`);
        }
      }
    }

    return {
      linked,
      accounts: db.listAccounts(account.channelId),
    };
  }

  function getPublicBaseUrl(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
    const envUrl = process.env.APP_BASE_URL?.trim();
    if (envUrl) return envUrl.replace(/\/+$/, '');
    const fwdProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    const fwdHost = (
      c.req.header('x-forwarded-host')?.split(',')[0] ||
      c.req.header('host')
    )?.trim();
    if (fwdHost) {
      const proto = fwdProto || new URL(c.req.url).protocol.replace(/:$/, '') || 'http';
      return `${proto}://${fwdHost}`;
    }
    return new URL(c.req.url).origin;
  }

  function safePasscodeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  const SESSION_COOKIE = 'sf_session';
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  function sessionTokenFor(passcode: string): string {
    return createHmac('sha256', passcode).update('syncflow-session-v1').digest('hex');
  }

  app.use(
    '/api/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'x-studio-passcode'],
    })
  );

  // Optional Public Cloud Access Lock (active whenever STUDIO_PASSCODE env var is set)
  app.use('*', async (c, next) => {
    const passcode = process.env.STUDIO_PASSCODE?.trim();
    if (!passcode || c.req.method === 'OPTIONS') {
      await next();
      return;
    }
    const reqPath = c.req.path;
    if (
      reqPath === '/api/health' ||
      reqPath === '/api/auth/login' ||
      /^\/api\/oauth\/[^/]+\/callback$/i.test(reqPath)
    ) {
      await next();
      return;
    }

    const sessionCookie = getCookie(c, SESSION_COOKIE);
    if (sessionCookie && safePasscodeEquals(sessionCookie, sessionTokenFor(passcode))) {
      await next();
      return;
    }

    const headerPass = c.req.header('x-studio-passcode')?.trim();
    if (headerPass && safePasscodeEquals(headerPass, passcode)) {
      await next();
      return;
    }

    const auth = c.req.header('authorization')?.trim() || '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      if (safePasscodeEquals(token, passcode)) {
        await next();
        return;
      }
    } else if (auth.toLowerCase().startsWith('basic ')) {
      try {
        const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
        const colonIdx = decoded.indexOf(':');
        const supplied = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
        if (safePasscodeEquals(supplied, passcode)) {
          await next();
          return;
        }
      } catch {
        // Invalid base64
      }
    }

    if (reqPath.startsWith('/api/')) {
      return c.json({ error: 'Unauthorized: STUDIO_PASSCODE required' }, 401);
    }
    return c.html(LOGIN_PAGE_HTML, 401);
  });

  app.post('/api/auth/login', async (c) => {
    const passcode = process.env.STUDIO_PASSCODE?.trim();
    if (!passcode) {
      return c.json({ ok: true, authRequired: false });
    }

    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      'local';
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (entry && entry.resetAt > now && entry.count >= 8) {
      return c.json({ error: 'ลองรหัสผิดหลายครั้งเกินไป กรุณารอ 1 นาทีแล้วลองใหม่' }, 429);
    }

    let supplied = '';
    try {
      const body = (await c.req.json()) as { passcode?: unknown };
      supplied = typeof body.passcode === 'string' ? body.passcode.trim() : '';
    } catch {
      supplied = '';
    }

    if (!supplied || !safePasscodeEquals(supplied, passcode)) {
      loginAttempts.set(ip, {
        count: entry && entry.resetAt > now ? entry.count + 1 : 1,
        resetAt: entry && entry.resetAt > now ? entry.resetAt : now + 60_000,
      });
      return c.json({ error: 'รหัสผ่านไม่ถูกต้อง' }, 401);
    }

    loginAttempts.delete(ip);
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || '';
    setCookie(c, SESSION_COOKIE, sessionTokenFor(passcode), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: proto === 'https',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.json({ ok: true });
  });

  // ---------- Health ----------

  app.get('/api/health', async (c) => {
    const tools = await checkFfmpegAvailability();
    const channels = db.listChannels();
    const jobs = db.listJobs();
    return c.json({
      ok: true,
      timestamp: new Date().toISOString(),
      tools,
      stats: {
        channels: channels.length,
        totalJobs: jobs.length,
        queuedJobs: jobs.filter((j) => j.status === 'QUEUED').length,
        nativeScheduledJobs: jobs.filter((j) => j.status === 'NATIVE_SCHEDULED')
          .length,
        publishedJobs: jobs.filter((j) => j.status === 'PUBLISHED').length,
        failedJobs: jobs.filter((j) => j.status === 'FAILED').length,
      },
      schedulerLastTickAt: scheduler.lastTickAt,
    });
  });

  // ---------- Channels (max 3 default) ----------

  app.get('/api/channels', (c) => {
    const channels = db.listChannels().map((ch) => ({
      ...ch,
      accounts: db.listAccounts(ch.id),
    }));
    return c.json({ channels });
  });

  app.post('/api/channels', async (c) => {
    const body = await c.req.json();
    const schema = z.object({
      name: z.string().min(1).max(80),
      color: z.string().optional(),
      timezone: z.string().optional(),
      description: z.string().optional(),
      defaultTone: z
        .enum([
          'FRIENDLY',
          'EDUCATIONAL',
          'ENTERTAINING',
          'PROFESSIONAL',
          'URGENT_HOOK',
        ])
        .optional(),
      seedDefaults: z.boolean().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    try {
      const channel = db.createChannel(parsed.data);
      if (parsed.data.seedDefaults !== false) {
        seedDefaultChannelData(db, channel.id);
      }
      return c.json(
        { channel: { ...channel, accounts: db.listAccounts(channel.id) } },
        201
      );
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.patch('/api/channels/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const updated = db.updateChannel(id, body);
    if (!updated) return c.json({ error: 'Channel not found' }, 404);
    return c.json({ channel: updated });
  });

  app.delete('/api/channels/:id', (c) => {
    const id = c.req.param('id');
    const ok = db.deleteChannel(id);
    if (!ok) return c.json({ error: 'Channel not found' }, 404);
    return c.json({ ok: true });
  });

  // ---------- Social Accounts & OAuth ----------

  app.get('/api/accounts', (c) => {
    const channelId = c.req.query('channelId');
    return c.json({ accounts: db.listAccounts(channelId || undefined) });
  });

  app.post('/api/accounts', async (c) => {
    const body = await c.req.json();
    const schema = z.object({
      channelId: z.string().min(1),
      platform: z.enum(PLATFORMS),
      accountName: z.string().min(1),
      externalAccountId: z.string().optional(),
      connectionMode: z
        .enum(['SIMULATION', 'LIVE_OFFICIAL', 'UNIFIED_API'])
        .optional(),
      config: z.record(z.unknown()).optional(),
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const account = db.createAccount(parsed.data);
    return c.json({ account }, 201);
  });

  app.patch('/api/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const updated = db.updateAccount(id, body);
    if (!updated) return c.json({ error: 'Account not found' }, 404);
    return c.json({ account: updated });
  });

  app.delete('/api/accounts/:id', (c) => {
    const id = c.req.param('id');
    const ok = db.deleteAccount(id);
    if (!ok) return c.json({ error: 'Account not found' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/accounts/:id/oauth-url', (c) => {
    const id = c.req.param('id');
    const account = db.getAccount(id);
    if (!account) return c.json({ error: 'Account not found' }, 404);

    const adapter = getAdapter(account.platform);
    if (!adapter.getAuthUrl) {
      return c.json({ error: 'Platform does not support OAuth' }, 400);
    }

    const customRedirect = c.req.query('redirectUri')?.trim();
    if (customRedirect && !/^https?:\/\//i.test(customRedirect)) {
      return c.json({ error: 'Redirect URI ต้องขึ้นต้นด้วย http:// หรือ https://' }, 400);
    }

    const baseUrl = getPublicBaseUrl(c);
    const redirectUri =
      customRedirect || `${baseUrl}/api/oauth/${account.platform.toLowerCase()}/callback`;
    const state = randomBytes(16).toString('hex');

    oauthStates.set(state, {
      accountId: account.id,
      platform: account.platform,
      redirectUri,
      createdAt: Date.now(),
    });

    try {
      const credentials = db.getSettingsFull();
      const url = adapter.getAuthUrl({
        accountId: account.id,
        redirectUri,
        state,
        credentials,
      });
      return c.json({ url, callbackUrl: redirectUri });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  async function completeOAuthExchange(entry: OAuthStateEntry, code: string) {
    const adapter = getAdapter(entry.platform);
    if (!adapter.exchangeCode) {
      throw new Error('Exchange unsupported');
    }
    const credentials = db.getSettingsFull();
    const tokens = await adapter.exchangeCode({
      code,
      redirectUri: entry.redirectUri,
      credentials,
    });
    const updated = db.updateAccount(entry.accountId, {
      connectionMode: 'LIVE_OFFICIAL',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? undefined,
      tokenExpiresAt: tokens.expiresAt ?? null,
      externalAccountId: tokens.externalAccountId,
      accountName: tokens.accountName,
      status: 'CONNECTED',
    });

    if (entry.platform === 'FACEBOOK' && tokens.pairedIgAccount && updated) {
      const igSibling = db
        .listAccounts(updated.channelId)
        .find((a) => a.platform === 'INSTAGRAM' && !a.hasAccessToken);
      if (igSibling) {
        db.updateAccount(igSibling.id, {
          connectionMode: 'LIVE_OFFICIAL',
          accessToken: tokens.accessToken,
          externalAccountId: tokens.pairedIgAccount.igUserId,
          accountName: tokens.pairedIgAccount.igUsername
            ? `@${tokens.pairedIgAccount.igUsername}`
            : tokens.pairedIgAccount.igName || updated.accountName,
          status: 'CONNECTED',
        });
      }
    }
    return updated;
  }

  app.get('/api/oauth/:platform/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const errorParam = c.req.query('error');
    const webBase = process.env.WEB_BASE_URL || '';

    if (errorParam) {
      return c.html(
        `<h2>OAuth Rejected: ${errorParam}</h2><p><a href="${webBase || '/'}">กลับหน้าหลัก</a></p>`,
        400
      );
    }
    if (!code || !state) {
      return c.json({ error: 'Missing code or state' }, 400);
    }

    const entry = oauthStates.get(state);
    if (!entry || Date.now() - entry.createdAt > 15 * 60_000) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 400);
    }
    oauthStates.delete(state);

    try {
      await completeOAuthExchange(entry, code);

      const fallbackUrl = `${webBase || ''}/?oauth=success&platform=${entry.platform}`;
      return c.html(`<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>SyncFlow Studio OAuth</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f;">
  <div style="background:#fff;padding:28px 32px;border-radius:18px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center;max-width:380px;">
    <div style="font-size:32px;margin-bottom:8px;">✓</div>
    <h2 style="margin:0 0 8px;font-size:18px;">เชื่อมต่อ ${entry.platform} สำเร็จ!</h2>
    <p style="margin:0 0 18px;font-size:13px;color:#6e6e73;">หน้าต่างนี้จะปิดอัตโนมัติในสักครู่</p>
    <a href="${fallbackUrl}" style="display:inline-block;background:#007aff;color:#fff;padding:8px 18px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600;">กลับไปหน้าหลัก</a>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'syncflow_oauth_done', platform: ${JSON.stringify(entry.platform)}, accountId: ${JSON.stringify(entry.accountId)} }, '*');
        setTimeout(() => window.close(), 600);
      } else {
        setTimeout(() => { window.location.href = ${JSON.stringify(fallbackUrl)}; }, 800);
      }
    } catch (e) {}
  </script>
</body></html>`);
    } catch (err) {
      return c.html(
        `<h2>OAuth Exchange Failed</h2><pre>${err instanceof Error ? err.message : String(err)}</pre><a href="${webBase || '/'}">กลับหน้าหลัก</a>`,
        500
      );
    }
  });

  app.post('/api/accounts/:id/oauth-complete-url', async (c) => {
    const id = c.req.param('id');
    const account = db.getAccount(id);
    if (!account) return c.json({ error: 'Account not found' }, 404);

    const body = await c.req.json();
    const schema = z.object({
      redirectedUrl: z.string().min(5),
      redirectUri: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'กรุณาวาง URL ที่ได้หลัง Login' }, 400);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(parsed.data.redirectedUrl.trim());
    } catch {
      return c.json({ error: 'รูปแบบ URL ไม่ถูกต้อง' }, 400);
    }

    const errParam = parsedUrl.searchParams.get('error');
    if (errParam) {
      return c.json({ error: `OAuth error: ${errParam}` }, 400);
    }

    const code = parsedUrl.searchParams.get('code');
    const state = parsedUrl.searchParams.get('state');
    if (!code) {
      return c.json({ error: 'ไม่พบพารามิเตอร์ code= ใน URL นี้' }, 400);
    }

    const entry = state ? oauthStates.get(state) : undefined;
    const resolvedEntry: OAuthStateEntry =
      entry && Date.now() - entry.createdAt <= 15 * 60_000
        ? entry
        : {
            accountId: account.id,
            platform: account.platform,
            redirectUri:
              parsed.data.redirectUri?.trim() ||
              `${parsedUrl.origin}${parsedUrl.pathname}`,
            createdAt: Date.now(),
          };
    if (state) oauthStates.delete(state);

    try {
      const updated = await completeOAuthExchange(resolvedEntry, code);
      return c.json({
        connected: true,
        account: updated,
        accounts: db.listAccounts(account.channelId),
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.post('/api/accounts/:id/connect-token', async (c) => {
    const id = c.req.param('id');
    const account = db.getAccount(id);
    if (!account) return c.json({ error: 'Account not found' }, 404);

    const body = await c.req.json();
    const schema = z.object({
      accessToken: z.string().min(5),
      refreshToken: z.string().optional(),
      expiresInSec: z.number().optional(),
      selectedPageId: z.string().optional(),
      alsoLinkPairedMeta: z.boolean().default(true),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'กรุณาใส่ Access Token ให้ถูกต้อง' }, 400);
    }

    const token = parsed.data.accessToken.trim();
    const expiresAt = parsed.data.expiresInSec
      ? new Date(Date.now() + parsed.data.expiresInSec * 1000).toISOString()
      : null;

    try {
      if (account.platform === 'YOUTUBE') {
        const chRes = await fetch(
          'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!chRes.ok) {
          throw new Error(
            `Google Token ไม่ถูกต้องหรือไม่มีสิทธิ์ YouTube (${chRes.status}): ${await chRes.text()}`
          );
        }
        const chData = (await chRes.json()) as {
          items?: Array<{ id?: string; snippet?: { title?: string } }>;
        };
        const first = chData.items?.[0];
        if (!first?.id) {
          throw new Error('ไม่พบช่อง YouTube ใน Google Token นี้');
        }
        const updated = db.updateAccount(account.id, {
          connectionMode: 'LIVE_OFFICIAL',
          accessToken: token,
          refreshToken: parsed.data.refreshToken?.trim() || undefined,
          tokenExpiresAt: expiresAt,
          externalAccountId: first.id,
          accountName: first.snippet?.title || account.accountName,
          status: 'CONNECTED',
        });
        return c.json({
          connected: true,
          linked: [`YouTube (${updated?.accountName})`],
          accounts: db.listAccounts(account.channelId),
        });
      }

      if (account.platform === 'FACEBOOK' || account.platform === 'INSTAGRAM') {
        const pages = await discoverMetaPages(token);
        if (pages.length === 0) {
          throw new Error(
            'ไม่พบ Facebook Page ที่จัดการได้ใน Token นี้ (ตรวจสอบสิทธิ์ pages_show_list และ pages_manage_posts)'
          );
        }

        if (pages.length > 1 && !parsed.data.selectedPageId) {
          const sessionId = randomBytes(12).toString('hex');
          pendingMetaSessions.set(sessionId, {
            accountId: account.id,
            pages,
            createdAt: Date.now(),
          });
          return c.json({
            needsPageSelection: true,
            sessionId,
            pages: pages.map((p) => ({
              pageId: p.pageId,
              pageName: p.pageName,
              igUserId: p.igUserId,
              igUsername: p.igUsername,
              igName: p.igName,
            })),
          });
        }

        const chosen = parsed.data.selectedPageId
          ? pages.find((p) => p.pageId === parsed.data.selectedPageId)
          : pages[0];
        if (!chosen) {
          throw new Error('ไม่พบ Page ID ที่เลือก');
        }
        const res = applyMetaPageToAccounts({
          targetAccountId: account.id,
          page: chosen,
          alsoLinkPairedMeta: parsed.data.alsoLinkPairedMeta,
        });
        return c.json({ connected: true, ...res });
      }

      // TIKTOK
      let creatorInfo = account.creatorInfo;
      let accountName = account.accountName;
      try {
        creatorInfo = await tiktokAdapter.fetchCreatorInfo(token, false);
        if (creatorInfo.creatorNickname || creatorInfo.creatorUsername) {
          accountName =
            creatorInfo.creatorNickname || `@${creatorInfo.creatorUsername}`;
        }
      } catch {
        // Allow saving sandbox token even if creator_info rate/scope varies
      }
      db.updateAccount(account.id, {
        connectionMode: 'LIVE_OFFICIAL',
        accessToken: token,
        refreshToken: parsed.data.refreshToken?.trim() || undefined,
        tokenExpiresAt: expiresAt,
        creatorInfo,
        accountName,
        status: 'CONNECTED',
      });
      return c.json({
        connected: true,
        linked: [`TikTok (${accountName})`],
        accounts: db.listAccounts(account.channelId),
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.post('/api/accounts/:id/select-meta-page', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const schema = z.object({
      sessionId: z.string().min(1),
      pageId: z.string().min(1),
      alsoLinkPairedMeta: z.boolean().default(true),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const sess = pendingMetaSessions.get(parsed.data.sessionId);
    if (
      !sess ||
      sess.accountId !== id ||
      Date.now() - sess.createdAt > 15 * 60_000
    ) {
      return c.json({ error: 'Session หมดอายุ กรุณาวาง Token ใหม่อีกครั้ง' }, 400);
    }
    const page = sess.pages.find((p) => p.pageId === parsed.data.pageId);
    if (!page) {
      return c.json({ error: 'ไม่พบเพจที่เลือก' }, 404);
    }
    pendingMetaSessions.delete(parsed.data.sessionId);

    try {
      const res = applyMetaPageToAccounts({
        targetAccountId: id,
        page,
        alsoLinkPairedMeta: parsed.data.alsoLinkPairedMeta,
      });
      return c.json({ connected: true, ...res });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.post('/api/accounts/:id/creator-info', async (c) => {
    const id = c.req.param('id');
    const secrets = db.getAccountWithSecrets(id);
    if (!secrets) return c.json({ error: 'Account not found' }, 404);
    if (secrets.account.platform !== 'TIKTOK') {
      return c.json({ error: 'Creator info is only for TikTok accounts' }, 400);
    }

    try {
      const info = await tiktokAdapter.fetchCreatorInfo(
        secrets.accessToken,
        secrets.account.connectionMode === 'SIMULATION'
      );
      const updated = db.updateAccount(id, { creatorInfo: info });
      return c.json({ creatorInfo: info, account: updated });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.post('/api/accounts/:id/refresh-token', async (c) => {
    const id = c.req.param('id');
    const secrets = db.getAccountWithSecrets(id);
    if (!secrets) return c.json({ error: 'Account not found' }, 404);
    if (secrets.account.connectionMode === 'SIMULATION') {
      return c.json({ ok: true, message: 'Simulation account does not require token refresh' });
    }
    const adapter = getAdapter(secrets.account.platform);
    if (!adapter.refreshAccessToken || !secrets.refreshToken) {
      return c.json({ error: 'No refresh token available for this account' }, 400);
    }
    try {
      const credentials = db.getSettingsFull();
      const next = await adapter.refreshAccessToken(
        secrets.refreshToken,
        credentials
      );
      const updated = db.updateAccount(id, {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? secrets.refreshToken,
        tokenExpiresAt: next.expiresAt ?? null,
        status: 'CONNECTED',
      });
      return c.json({ ok: true, account: updated });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  // ---------- Schedule Rules Matrix ----------

  app.get('/api/channels/:channelId/schedule-rules', (c) => {
    const channelId = c.req.param('channelId');
    return c.json({ rules: db.listScheduleRules(channelId) });
  });

  app.put('/api/channels/:channelId/schedule-rules', async (c) => {
    const channelId = c.req.param('channelId');
    const body = await c.req.json();
    const schema = z.object({
      rules: z.array(
        z.object({
          id: z.string().optional(),
          socialAccountId: z.string().min(1),
          dayOfWeek: z.number().int().min(0).max(6),
          clipType: z.enum(['ANY', 'SHORT', 'LONG']).optional(),
          slotOrder: z.number().int().min(1).max(10).optional(),
          localTime: z.string().regex(/^\d{2}:\d{2}$/),
          isActive: z.boolean().optional(),
        })
      ),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const rules = db.replaceScheduleRules(channelId, parsed.data.rules);
    return c.json({ rules });
  });

  app.post('/api/channels/:channelId/resolve-slots', async (c) => {
    const channelId = c.req.param('channelId');
    const channel = db.getChannel(channelId);
    if (!channel) return c.json({ error: 'Channel not found' }, 404);

    const body = await c.req.json();
    const schema = z.object({
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      clipCategory: z.enum(['SHORT', 'LONG']).default('SHORT'),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const rules = db.listScheduleRules(channelId);
    const accounts = db.listAccounts(channelId);
    const slots = resolveScheduledTimesForDate({
      dateStr: parsed.data.targetDate,
      timezone: channel.timezone,
      rules,
      accounts,
      clipCategory: parsed.data.clipCategory,
      minLeadMinutes: 2,
    });
    return c.json({ slots });
  });

  // ---------- Metadata Templates ----------

  app.get('/api/templates', (c) => {
    const channelId = c.req.query('channelId');
    return c.json({ templates: db.listTemplates(channelId || undefined) });
  });

  app.put('/api/templates', async (c) => {
    const body = await c.req.json();
    const schema = z.object({
      channelId: z.string().min(1),
      format: z.enum(CONTENT_FORMATS),
      name: z.string().min(1),
      titlePrefix: z.string().optional(),
      titleSuffix: z.string().optional(),
      descriptionHeader: z.string().optional(),
      descriptionFooter: z.string().optional(),
      defaultHashtags: z.array(z.string()).optional(),
      defaultTags: z.array(z.string()).optional(),
      defaultCta: z.string().optional(),
      platformDefaults: z.record(z.unknown()).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const template = db.upsertTemplate(parsed.data);
    return c.json({ template });
  });

  // ---------- Media Upload, Streaming, Thumbnails & Optimization ----------

  app.get('/api/media', (c) => {
    const channelId = c.req.query('channelId');
    return c.json({ assets: db.listMediaAssets(channelId || undefined) });
  });

  app.post('/api/media/upload', async (c) => {
    const headersObj = Object.fromEntries(c.req.raw.headers.entries());
    const contentType = headersObj['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'Content-Type must be multipart/form-data' }, 400);
    }

    const incomingStream: Readable | null =
      (c.env as { incoming?: Readable } | undefined)?.incoming ??
      (c.req.raw.body
        ? Readable.fromWeb(
            c.req.raw.body as unknown as import('node:stream/web').ReadableStream
          )
        : null);

    if (!incomingStream) {
      return c.json({ error: 'Missing request body stream' }, 400);
    }

    const assetId = `med_${randomUUID().slice(0, 8)}`;
    const settings = db.getSettingsFull();

    try {
      const uploadResult = await new Promise<{
        channelId: string;
        saved: Awaited<ReturnType<StorageService['saveUploadStream']>>;
        originalFilename: string;
        mimeType: string;
      }>((resolve, reject) => {
        const bb = Busboy({
          headers: headersObj,
          limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4 GB ceiling
        });

        let channelId = '';
        let filePromise: Promise<
          Awaited<ReturnType<StorageService['saveUploadStream']>>
        > | null = null;
        let origName = 'video.mp4';
        let mimeType = 'video/mp4';

        bb.on('field', (name, val) => {
          if (name === 'channelId') channelId = val;
        });

        bb.on('file', (_fieldname, fileStream, info) => {
          origName = info.filename || 'video.mp4';
          mimeType = info.mimeType || 'video/mp4';
          filePromise = storage.saveUploadStream({
            assetId,
            originalFilename: origName,
            mimeType,
            stream: fileStream,
            settings,
          });
        });

        bb.on('error', (err) => reject(err));

        bb.on('finish', async () => {
          try {
            if (!filePromise) {
              reject(new Error('ไม่พบไฟล์วิดีโอในคำขออัปโหลด'));
              return;
            }
            const saved = await filePromise;
            if (!channelId) {
              const firstChannel = db.listChannels()[0];
              channelId = firstChannel?.id || '';
            }
            resolve({
              channelId,
              saved,
              originalFilename: origName,
              mimeType,
            });
          } catch (err) {
            reject(err);
          }
        });

        incomingStream.pipe(bb);
      });

      const probe = await probeVideo(uploadResult.saved.localPath);
      const detection = detectRecommendedFormats(probe);
      const thumbDir = storage.resolveThumbnailDir(assetId);
      const thumbFiles = await extractThumbnails(
        uploadResult.saved.localPath,
        thumbDir,
        probe.durationSec
      );

      const asset = db.createMediaAsset({
        id: assetId,
        channelId: uploadResult.channelId,
        originalFilename: uploadResult.originalFilename,
        storageProvider: uploadResult.saved.storageProvider,
        storageKey: uploadResult.saved.storageKey,
        publicUrl: uploadResult.saved.publicUrl,
        thumbnailPaths: thumbFiles,
        mimeType: uploadResult.mimeType,
        fileSizeBytes: uploadResult.saved.sizeBytes,
        probe,
        orientation: detection.orientation,
        clipCategory: detection.clipCategory,
        status: 'READY',
      });

      const warningsByFormat: Record<string, ValidationIssue[]> = {};
      for (const fmt of CONTENT_FORMATS) {
        warningsByFormat[fmt] = validateVideoCompatibility(fmt, probe);
      }

      return c.json(
        {
          asset,
          detection,
          warningsByFormat,
        },
        201
      );
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.post('/api/media/:id/optimize', async (c) => {
    const id = c.req.param('id');
    const asset = db.getMediaAsset(id);
    if (!asset) return c.json({ error: 'Media asset not found' }, 404);

    const settings = db.getSettingsFull();
    const inputPath = await storage.ensureLocalFile(asset.storageKey, settings);
    const optimizedKey = `${asset.id}_optimized.mp4`;
    const outputPath = storage.resolveLocalPath(optimizedKey);

    try {
      const opt = await optimizeVideoForPlatforms(
        inputPath,
        outputPath,
        asset.probe
      );
      const sync = await storage.syncLocalFileToStorage({
        localPath: outputPath,
        storageKey: optimizedKey,
        mimeType: 'video/mp4',
        settings,
      });
      const updated = db.updateMediaAssetOptimized(
        asset.id,
        optimizedKey,
        opt.probe,
        sync.sizeBytes,
        sync.publicUrl
      );
      const detection = detectRecommendedFormats(opt.probe);
      const warningsByFormat: Record<string, ValidationIssue[]> = {};
      for (const fmt of CONTENT_FORMATS) {
        warningsByFormat[fmt] = validateVideoCompatibility(fmt, opt.probe);
      }
      return c.json({
        action: opt.action,
        asset: updated,
        detection,
        warningsByFormat,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });

  app.get('/api/media/:id/thumbnail/:idx', async (c) => {
    const id = c.req.param('id');
    const idx = Number(c.req.param('idx'));
    const asset = db.getMediaAsset(id);
    if (!asset || !asset.thumbnailPaths[idx]) {
      return c.json({ error: 'Thumbnail not found' }, 404);
    }
    const thumbPath = path.join(
      storage.resolveThumbnailDir(asset.id),
      asset.thumbnailPaths[idx]
    );
    if (!fs.existsSync(thumbPath)) {
      return c.json({ error: 'Thumbnail file missing' }, 404);
    }
    const buf = await fs.promises.readFile(thumbPath);
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  });

  app.get('/api/media/:id/custom-cover', async (c) => {
    const id = c.req.param('id');
    const asset = db.getMediaAsset(id);
    if (!asset?.customCoverKey) {
      return c.json({ error: 'Custom cover not found' }, 404);
    }
    const coverPath = storage.resolveCustomCoverPath(asset.id);
    if (!fs.existsSync(coverPath)) {
      return c.json({ error: 'Custom cover file missing' }, 404);
    }
    const buf = await fs.promises.readFile(coverPath);
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache',
      },
    });
  });

  app.post('/api/media/:id/cover', async (c) => {
    const id = c.req.param('id');
    const asset = db.getMediaAsset(id);
    if (!asset) return c.json({ error: 'Media asset not found' }, 404);

    const headersObj = Object.fromEntries(c.req.raw.headers.entries());
    const contentType = headersObj['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'Content-Type must be multipart/form-data' }, 400);
    }

    const incomingStream: Readable | null =
      (c.env as { incoming?: Readable } | undefined)?.incoming ??
      (c.req.raw.body
        ? Readable.fromWeb(
            c.req.raw.body as unknown as import('node:stream/web').ReadableStream
          )
        : null);
    if (!incomingStream) {
      return c.json({ error: 'Missing request body stream' }, 400);
    }

    const tmpCoverPath = path.join(
      os.tmpdir(),
      `syncflow_cover_${asset.id}_${Date.now()}`
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const bb = Busboy({
          headers: headersObj,
          limits: { fileSize: 25 * 1024 * 1024 },
        });
        let filePromise: Promise<void> | null = null;
        bb.on('file', (_name, stream) => {
          filePromise = pipeline(stream, fs.createWriteStream(tmpCoverPath));
        });
        bb.on('error', reject);
        bb.on('finish', async () => {
          try {
            if (!filePromise) {
              reject(new Error('ไม่พบไฟล์ภาพปกในการอัปโหลด'));
              return;
            }
            await filePromise;
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        incomingStream.pipe(bb);
      });

      const settings = db.getSettingsFull();
      const saved = await storage.saveCustomCoverFromPath({
        assetId: asset.id,
        sourceFilePath: tmpCoverPath,
        settings,
      });
      const updated = db.updateMediaAssetCover(
        asset.id,
        saved.customCoverKey,
        saved.customCoverPublicUrl
      );
      return c.json({ asset: updated });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    } finally {
      await fs.promises.unlink(tmpCoverPath).catch(() => {});
    }
  });

  app.get('/api/media/:id/stream', async (c) => {
    const id = c.req.param('id');
    const asset = db.getMediaAsset(id);
    if (!asset) return c.json({ error: 'Media asset not found' }, 404);

    const settings = db.getSettingsFull();
    const storageKey = asset.optimizedStorageKey || asset.storageKey;
    const localPath = await storage.ensureLocalFile(storageKey, settings);
    const stat = await fs.promises.stat(localPath);
    const total = stat.size;
    const rangeHeader = c.req.header('range');

    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(total - 1, Number(match[2])) : total - 1;
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(localPath, { start, end });
        return new Response(
          Readable.toWeb(stream) as unknown as ReadableStream,
          {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': asset.mimeType || 'video/mp4',
            },
          }
        );
      }
    }

    const stream = fs.createReadStream(localPath);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(total),
        'Content-Type': asset.mimeType || 'video/mp4',
      },
    });
  });

  // ---------- Metadata Studio Engine ----------

  app.post('/api/metadata/generate', async (c) => {
    const body = await c.req.json();
    const schema = z.object({
      channelId: z.string().min(1),
      mediaAssetId: z.string().optional(),
      formats: z.array(z.enum(CONTENT_FORMATS)).min(1),
      brief: z.object({
        topic: z.string().default(''),
        hook: z.string().default(''),
        summary: z.string().default(''),
        keyPoints: z.array(z.string()).default([]),
        cta: z.string().default(''),
        coreHashtags: z.array(z.string()).default([]),
        language: z.enum(['th', 'en', 'bilingual']).default('th'),
        tone: z
          .enum([
            'FRIENDLY',
            'EDUCATIONAL',
            'ENTERTAINING',
            'PROFESSIONAL',
            'URGENT_HOOK',
          ])
          .default('FRIENDLY'),
        timestampsText: z.string().optional(),
        transcriptText: z.string().optional(),
        coverKicker: z.string().optional(),
        coverHeadline: z.string().optional(),
        coverSubline: z.string().optional(),
        sources: z
          .array(z.object({ title: z.string(), url: z.string() }))
          .optional(),
        isSyntheticMedia: z.boolean().optional(),
        coverTimestampMs: z.number().optional(),
      }),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const asset = parsed.data.mediaAssetId
      ? db.getMediaAsset(parsed.data.mediaAssetId)
      : null;
    const templates = db.listTemplates(parsed.data.channelId);
    const settings = db.getSettingsFull();

    const gen = await generateMetadataWithAI({
      brief: parsed.data.brief as MasterBrief,
      formats: parsed.data.formats,
      templates,
      probe: asset?.probe,
      settings,
    });

    const issues: ValidationIssue[] = [];
    for (const fmt of parsed.data.formats) {
      const meta = gen.metadata[fmt] as Record<string, unknown> | undefined;
      issues.push(...validateFormatMetadata(fmt, meta, asset?.probe));
    }

    return c.json({
      metadata: gen.metadata,
      engineUsed: gen.engineUsed,
      warning: gen.warning,
      issues,
    });
  });

  app.post('/api/metadata/validate', async (c) => {
    const body = await c.req.json();
    const schema = z.object({
      mediaAssetId: z.string().optional(),
      formats: z.array(z.enum(CONTENT_FORMATS)),
      platformMetadata: z.record(z.unknown()),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const asset = parsed.data.mediaAssetId
      ? db.getMediaAsset(parsed.data.mediaAssetId)
      : null;
    const issues: ValidationIssue[] = [];
    for (const fmt of parsed.data.formats) {
      issues.push(
        ...validateFormatMetadata(
          fmt,
          parsed.data.platformMetadata[fmt] as
            | Record<string, unknown>
            | undefined,
          asset?.probe
        )
      );
    }
    return c.json({ issues });
  });

  // ---------- Content Items & Publishing Jobs ----------

  app.get('/api/contents', (c) => {
    const channelId = c.req.query('channelId');
    const fromDate = c.req.query('fromDate');
    const toDate = c.req.query('toDate');
    return c.json({
      contents: db.listContents({
        channelId: channelId || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      }),
    });
  });

  app.get('/api/contents/:id', (c) => {
    const item = db.getContent(c.req.param('id'));
    if (!item) return c.json({ error: 'Content item not found' }, 404);
    return c.json({ content: item });
  });

  app.post('/api/contents', async (c) => {
    const body = await c.req.json();
    const schema = z.object({
      channelId: z.string().min(1),
      mediaAssetId: z.string().min(1),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      masterBrief: z.record(z.unknown()),
      platformMetadata: z.record(z.unknown()),
      targets: z
        .array(
          z.object({
            socialAccountId: z.string().min(1),
            format: z.enum(CONTENT_FORMATS),
            localTime: z.string().regex(/^\d{2}:\d{2}$/),
            targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            scheduledAtIso: z.string().optional(),
            allowImmediate: z.boolean().optional(),
          })
        )
        .min(1),
      allowImmediate: z.boolean().optional(),
      dispatchImmediately: z.boolean().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const channel = db.getChannel(parsed.data.channelId);
    if (!channel) return c.json({ error: 'Channel not found' }, 404);
    const asset = db.getMediaAsset(parsed.data.mediaAssetId);
    if (!asset) return c.json({ error: 'Media asset not found' }, 404);

    // Block hard errors (e.g. Facebook Reels > 90s or missing YouTube title)
    const hardErrors: ValidationIssue[] = [];
    for (const target of parsed.data.targets) {
      const fmtMeta = parsed.data.platformMetadata[target.format] as
        | Record<string, unknown>
        | undefined;
      const issues = validateFormatMetadata(
        target.format,
        fmtMeta,
        asset.probe
      );
      hardErrors.push(...issues.filter((i) => i.severity === 'error'));
    }
    if (hardErrors.length > 0) {
      return c.json(
        {
          error: hardErrors.map((e) => e.message).join(' | '),
          issues: hardErrors,
        },
        400
      );
    }

    const now = new Date();
    const pastTargets: Array<{
      platform: string;
      targetDate: string;
      localTime: string;
      scheduledAt: string;
    }> = [];

    const jobsToCreate = parsed.data.targets.map((target) => {
      const account = db.getAccount(target.socialAccountId);
      if (!account) {
        throw new Error(`ไม่พบบัญชีโซเชียล ${target.socialAccountId}`);
      }
      const effectiveDate = target.targetDate ?? parsed.data.targetDate;
      const scheduledAt =
        target.scheduledAtIso ||
        zonedDateTimeToUtcIso(effectiveDate, target.localTime, channel.timezone);

      const allowNow = Boolean(parsed.data.allowImmediate || target.allowImmediate);
      if (new Date(scheduledAt).getTime() <= now.getTime() && !allowNow) {
        pastTargets.push({
          platform: account.platform,
          targetDate: effectiveDate,
          localTime: target.localTime,
          scheduledAt,
        });
      }

      const strategy =
        account.connectionMode === 'UNIFIED_API'
          ? 'JIT_PUBLISH'
          : determinePublishStrategy(target.format, scheduledAt, account, now);

      const prewarmAt =
        strategy === 'JIT_PUBLISH'
          ? computePrewarmIso(scheduledAt, 12)
          : null;

      return {
        socialAccountId: account.id,
        platform: formatToPlatform(target.format),
        format: target.format,
        strategy,
        scheduledAt,
        prewarmAt,
        metadataSnapshot:
          (parsed.data.platformMetadata[target.format] as Record<
            string,
            unknown
          >) ?? {},
      };
    });

    if (pastTargets.length > 0) {
      const first = pastTargets[0];
      return c.json(
        {
          error: `เวลาตั้งลงคลิปของ ${pastTargets.map((p) => `${p.platform} (${p.targetDate} ${p.localTime})`).join(', ')} ผ่านมาแล้ว กรุณาเลือกเวลาล่วงหน้าหรือยืนยันโพสต์ทันที เพื่อป้องกันการโพสต์ทันทีโดยไม่ตั้งใจ`,
          code: 'PAST_SCHEDULE_TIME',
          pastTargets,
          scheduledAt: first.scheduledAt,
        },
        400
      );
    }

    const content = db.createContentWithJobs({
      channelId: channel.id,
      mediaAssetId: asset.id,
      targetDate: parsed.data.targetDate,
      masterBrief: parsed.data.masterBrief as unknown as MasterBrief,
      platformMetadata: parsed.data.platformMetadata as PlatformMetadataMap,
      jobs: jobsToCreate,
    });

    for (const j of content.jobs ?? []) {
      db.addJobLog(
        j.id,
        'INFO',
        'JOB_CREATED',
        `สร้างคิวงาน ${j.format} (${j.strategy}) เวลา ${j.scheduledAt}`
      );
    }

    if (parsed.data.dispatchImmediately !== false) {
      await scheduler.tick(new Date());
    }

    return c.json({ content: db.getContent(content.id) }, 201);
  });

  app.patch('/api/contents/:id/reschedule', async (c) => {
    const id = c.req.param('id');
    const content = db.getContent(id);
    if (!content) return c.json({ error: 'Content not found' }, 404);
    const channel = db.getChannel(content.channelId);
    if (!channel) return c.json({ error: 'Channel not found' }, 404);

    const body = await c.req.json();
    const schema = z.object({
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const rules = db.listScheduleRules(channel.id);
    const accounts = db.listAccounts(channel.id);
    const clipCategory = content.mediaAsset?.clipCategory ?? 'SHORT';

    const resolved = resolveScheduledTimesForDate({
      dateStr: parsed.data.targetDate,
      timezone: channel.timezone,
      rules,
      accounts,
      clipCategory,
    });

    const slotByAccount = new Map(resolved.map((s) => [s.socialAccountId, s]));
    const jobs = db.listJobs({ contentItemId: content.id });

    for (const job of jobs) {
      if (job.status === 'PUBLISHED' || job.status === 'CANCELLED') continue;
      const slot = slotByAccount.get(job.socialAccountId);
      const account = db.getAccount(job.socialAccountId);
      if (!slot || !account) continue;

      const newScheduledAt = slot.scheduledAtIso;
      const newStrategy =
        account.connectionMode === 'UNIFIED_API'
          ? 'JIT_PUBLISH'
          : determinePublishStrategy(job.format, newScheduledAt, account);
      const newPrewarm =
        newStrategy === 'JIT_PUBLISH'
          ? computePrewarmIso(newScheduledAt, 12)
          : null;

      await scheduler.rescheduleJobExternal(
        job.id,
        newScheduledAt,
        newPrewarm,
        newStrategy
      );
    }

    db.updateContentFields(content.id, { targetDate: parsed.data.targetDate });
    return c.json({ content: db.getContent(content.id) });
  });

  app.delete('/api/contents/:id', async (c) => {
    const id = c.req.param('id');
    const content = db.getContent(id);
    if (!content) return c.json({ error: 'Content not found' }, 404);

    for (const job of content.jobs ?? []) {
      if (job.status === 'NATIVE_SCHEDULED') {
        await scheduler.cancelJob(job.id).catch(() => {});
      }
    }
    db.deleteContent(id);
    return c.json({ ok: true });
  });

  // ---------- Jobs & Scheduler Controls ----------

  app.get('/api/jobs', (c) => {
    const channelId = c.req.query('channelId');
    const status = c.req.query('status') as
      | import('@clipflow/shared').JobStatus
      | undefined;
    return c.json({
      jobs: db.listJobs({
        channelId: channelId || undefined,
        status: status || undefined,
      }),
    });
  });

  app.get('/api/jobs/:id/logs', (c) => {
    const id = c.req.param('id');
    return c.json({ logs: db.listJobLogs(id) });
  });

  app.post('/api/jobs/:id/run-now', async (c) => {
    const id = c.req.param('id');
    try {
      const job = await scheduler.runJobNow(id);
      return c.json({ job, logs: db.listJobLogs(id) });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.post('/api/jobs/:id/retry', (c) => {
    const id = c.req.param('id');
    const job = db.getJob(id);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    const updated = db.updateJob(id, {
      status: 'QUEUED',
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
      lockedUntil: null,
    });
    db.addJobLog(id, 'INFO', 'MANUAL_RETRY', 'สั่ง Retry งานจากหน้าจอผู้ใช้งาน');
    scheduler.nudge();
    return c.json({ job: updated });
  });

  app.post('/api/jobs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    try {
      const job = await scheduler.cancelJob(id);
      return c.json({ job });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.post('/api/scheduler/tick', async (c) => {
    const result = await scheduler.tick(new Date());
    return c.json(result);
  });

  // ---------- SyncCut Studio Integration ----------

  app.get('/api/integrations/synccut/episodes', (c) => {
    const settings = db.getSettingsFull();
    try {
      const data = listSyncCutEpisodes(settings.synccutDataDir);
      return c.json(data);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });

  app.get('/api/integrations/synccut/episodes/:episodeId/cover', async (c) => {
    const episodeId = c.req.param('episodeId');
    const exportId = c.req.query('exportId');
    const settings = db.getSettingsFull();
    const coverPath = getSyncCutCoverPath(
      settings.synccutDataDir,
      episodeId,
      exportId || undefined
    );
    if (!coverPath) {
      return c.json({ error: 'SyncCut cover not found' }, 404);
    }
    const buf = await fs.promises.readFile(coverPath);
    const ext = path.extname(coverPath).toLowerCase();
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png',
        'Cache-Control': 'public, max-age=300',
      },
    });
  });

  app.post('/api/integrations/synccut/import-episode', async (c) => {
    const body = await c.req.json();
    const schema = z.object({
      channelId: z.string().min(1),
      episodeId: z.string().min(1),
      exportId: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const settings = db.getSettingsFull();
    try {
      const result = await importSyncCutEpisode({
        db,
        storage,
        dataDir: settings.synccutDataDir,
        channelId: parsed.data.channelId,
        episodeId: parsed.data.episodeId,
        exportId: parsed.data.exportId,
      });
      return c.json(result, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  });

  app.post('/api/integrations/synccut/import', async (c) => {
    const headersObj = Object.fromEntries(c.req.raw.headers.entries());
    const contentType = headersObj['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'Content-Type must be multipart/form-data' }, 400);
    }

    const incomingStream: Readable | null =
      (c.env as { incoming?: Readable } | undefined)?.incoming ??
      (c.req.raw.body
        ? Readable.fromWeb(
            c.req.raw.body as unknown as import('node:stream/web').ReadableStream
          )
        : null);
    if (!incomingStream) {
      return c.json({ error: 'Missing request body stream' }, 400);
    }

    const assetId = `med_${randomUUID().slice(0, 8)}`;
    const tmpCoverPath = path.join(os.tmpdir(), `syncflow_push_cover_${assetId}`);
    const settings = db.getSettingsFull();

    try {
      const parsedUpload = await new Promise<{
        channelId: string;
        createDraft: boolean;
        targetDate: string;
        manifestRaw: string;
        hasCover: boolean;
        videoSaved: Awaited<ReturnType<StorageService['saveUploadStream']>>;
        originalFilename: string;
        mimeType: string;
      }>((resolve, reject) => {
        const bb = Busboy({
          headers: headersObj,
          limits: { fileSize: 4 * 1024 * 1024 * 1024 },
        });
        let channelId = '';
        let createDraft = true;
        let targetDate = new Date().toISOString().slice(0, 10);
        let manifestRaw = '';
        let videoPromise: Promise<
          Awaited<ReturnType<StorageService['saveUploadStream']>>
        > | null = null;
        let coverPromise: Promise<void> | null = null;
        let origName = 'synccut_video.mp4';
        let mimeType = 'video/mp4';

        bb.on('field', (name, val) => {
          if (name === 'channelId') channelId = val;
          else if (name === 'createDraft') createDraft = val !== 'false';
          else if (name === 'targetDate' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
            targetDate = val;
          } else if (name === 'manifest') {
            manifestRaw = val;
          }
        });

        bb.on('file', (fieldname, fileStream, info) => {
          if (fieldname === 'cover') {
            coverPromise = pipeline(
              fileStream,
              fs.createWriteStream(tmpCoverPath)
            );
          } else {
            origName = info.filename || 'synccut_video.mp4';
            mimeType = info.mimeType || 'video/mp4';
            videoPromise = storage.saveUploadStream({
              assetId,
              originalFilename: origName,
              mimeType,
              stream: fileStream,
              settings,
            });
          }
        });

        bb.on('error', reject);
        bb.on('finish', async () => {
          try {
            if (!videoPromise) {
              reject(new Error('ไม่พบไฟล์ video ในคำขอ'));
              return;
            }
            const [videoSaved] = await Promise.all([
              videoPromise,
              coverPromise ?? Promise.resolve(),
            ]);
            if (!channelId) {
              channelId = db.listChannels()[0]?.id || '';
            }
            resolve({
              channelId,
              createDraft,
              targetDate,
              manifestRaw,
              hasCover: Boolean(coverPromise),
              videoSaved,
              originalFilename: origName,
              mimeType,
            });
          } catch (err) {
            reject(err);
          }
        });

        incomingStream.pipe(bb);
      });

      const probe = await probeVideo(parsedUpload.videoSaved.localPath);
      const detection = detectRecommendedFormats(probe);
      const thumbDir = storage.resolveThumbnailDir(assetId);
      const thumbFiles = await extractThumbnails(
        parsedUpload.videoSaved.localPath,
        thumbDir,
        probe.durationSec
      );

      let customCoverKey: string | null = null;
      let customCoverPublicUrl: string | null = null;
      if (parsedUpload.hasCover && fs.existsSync(tmpCoverPath)) {
        const cov = await storage.saveCustomCoverFromPath({
          assetId,
          sourceFilePath: tmpCoverPath,
          settings,
        });
        customCoverKey = cov.customCoverKey;
        customCoverPublicUrl = cov.customCoverPublicUrl;
      }

      const manifest = parsedUpload.manifestRaw
        ? (JSON.parse(parsedUpload.manifestRaw) as {
            projectTitle?: string;
            language?: 'th' | 'en' | 'bilingual';
            tone?: MasterBrief['tone'];
            content?: {
              topic?: string;
              hook?: string;
              summary?: string;
              keyPoints?: string[];
              transcriptText?: string;
              chapters?: Array<{ timeSec: number; title: string }>;
              keywords?: string[];
              cta?: string;
              sources?: Array<{ title: string; url: string }>;
            };
            cover?: {
              kicker?: string;
              headline?: string;
              subline?: string;
              timestampMs?: number;
            };
            schedulingHint?: { targetDate?: string };
          })
        : {};

      const chaptersText = (manifest.content?.chapters ?? [])
        .map((ch) => {
          const m = Math.floor(Math.max(0, ch.timeSec) / 60);
          const s = Math.floor(Math.max(0, ch.timeSec) % 60);
          return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ch.title}`;
        })
        .join('\n');

      const brief: MasterBrief = {
        topic:
          manifest.content?.topic ||
          manifest.projectTitle ||
          parsedUpload.originalFilename.replace(/\.[^.]+$/, ''),
        hook:
          manifest.content?.hook ||
          manifest.content?.topic ||
          manifest.projectTitle ||
          '',
        summary: manifest.content?.summary || manifest.projectTitle || '',
        keyPoints: manifest.content?.keyPoints ?? [],
        cta: manifest.content?.cta ?? '',
        coreHashtags: (manifest.content?.keywords ?? []).map((k) =>
          k.startsWith('#') ? k : `#${k}`
        ),
        language: manifest.language ?? 'th',
        tone: manifest.tone ?? 'FRIENDLY',
        timestampsText: chaptersText || undefined,
        transcriptText: manifest.content?.transcriptText || undefined,
        coverKicker: manifest.cover?.kicker,
        coverHeadline: manifest.cover?.headline,
        coverSubline: manifest.cover?.subline,
        sources: manifest.content?.sources,
        isSyntheticMedia: true,
        coverTimestampMs: manifest.cover?.timestampMs ?? 0,
      };

      const asset = db.createMediaAsset({
        id: assetId,
        channelId: parsedUpload.channelId,
        originalFilename: parsedUpload.originalFilename,
        storageProvider: parsedUpload.videoSaved.storageProvider,
        storageKey: parsedUpload.videoSaved.storageKey,
        publicUrl: parsedUpload.videoSaved.publicUrl,
        thumbnailPaths: thumbFiles,
        customCoverKey,
        customCoverPublicUrl,
        sourceMeta: {
          sourceApp: 'SyncCut Studio',
          syntheticMedia: true,
          coverTimeSec: (manifest.cover?.timestampMs ?? 0) / 1000,
        },
        mimeType: parsedUpload.mimeType,
        fileSizeBytes: parsedUpload.videoSaved.sizeBytes,
        probe,
        orientation: detection.orientation,
        clipCategory: detection.clipCategory,
        status: 'READY',
      });

      const templates = db.listTemplates(parsedUpload.channelId);
      const gen = await generateMetadataWithAI({
        brief,
        formats: detection.recommendedFormats,
        templates,
        probe,
        settings,
      });

      const warningsByFormat: Record<string, ValidationIssue[]> = {};
      for (const fmt of CONTENT_FORMATS) {
        warningsByFormat[fmt] = validateVideoCompatibility(fmt, probe);
      }

      const issues: ValidationIssue[] = [];
      for (const fmt of detection.recommendedFormats) {
        issues.push(
          ...validateFormatMetadata(
            fmt,
            gen.metadata[fmt] as Record<string, unknown> | undefined,
            probe
          )
        );
      }

      let draftContentId: string | undefined;
      let openUrl: string | undefined;
      if (parsedUpload.createDraft) {
        const draft = db.createContentWithJobs({
          channelId: parsedUpload.channelId,
          mediaAssetId: asset.id,
          targetDate:
            manifest.schedulingHint?.targetDate || parsedUpload.targetDate,
          masterBrief: brief,
          platformMetadata: gen.metadata,
          jobs: [],
        });
        draftContentId = draft.id;
        const webBase = (
          process.env.WEB_BASE_URL?.trim() ||
          getPublicBaseUrl(c)
        ).replace(/\/+$/, '');
        openUrl = `${webBase}/?draftId=${encodeURIComponent(draft.id)}`;
      }

      return c.json(
        {
          asset,
          brief,
          metadata: gen.metadata,
          engineUsed: gen.engineUsed,
          warning: gen.warning,
          detection,
          warningsByFormat,
          issues,
          draftContentId,
          openUrl,
        },
        201
      );
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    } finally {
      await fs.promises.unlink(tmpCoverPath).catch(() => {});
    }
  });

  // ---------- App Settings ----------

  app.get('/api/settings', (c) => {
    return c.json({ settings: db.getSettingsPublic() });
  });

  app.put('/api/settings', async (c) => {
    const body = await c.req.json();
    const allowed: Record<string, unknown> = {};
    const keys = [
      'aiProvider',
      'aiModel',
      'aiBaseUrl',
      'aiApiKey',
      'r2AccountId',
      'r2AccessKeyId',
      'r2SecretAccessKey',
      'r2BucketName',
      'r2PublicBaseUrl',
      'unifiedApiBaseUrl',
      'unifiedApiKey',
      'notificationWebhookUrl',
      'maxChannels',
      'synccutDataDir',
      'googleClientId',
      'googleClientSecret',
      'metaAppId',
      'metaAppSecret',
      'tiktokClientKey',
      'tiktokClientSecret',
    ];
    for (const k of keys) {
      if (body[k] !== undefined && body[k] !== '********') {
        allowed[k] = body[k];
      }
    }
    const updated = db.updateSettings(allowed);
    return c.json({ settings: updated });
  });

  // ---------- Cloud DB Import Endpoint ----------

  app.post('/api/admin/import-db', async (c) => {
    const passcode = process.env.STUDIO_PASSCODE?.trim();
    const encKey = process.env.ENCRYPTION_KEY?.trim();
    const adminHeader = c.req.header('x-admin-key')?.trim();
    const hasAdminKey = Boolean(encKey && adminHeader && safePasscodeEquals(adminHeader, encKey));
    if (!passcode && !hasAdminKey) {
      return c.json(
        { error: 'Admin endpoint requires STUDIO_PASSCODE or x-admin-key' },
        403
      );
    }

    const body = await c.req.json();
    const schema = z.object({
      sqliteBase64: z.string().min(16),
      thumbnails: z.record(z.string()).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const tmpDbPath = path.join(os.tmpdir(), `syncflow_import_${randomUUID()}.sqlite`);
    try {
      await fs.promises.writeFile(
        tmpDbPath,
        Buffer.from(parsed.data.sqliteBase64, 'base64')
      );
      const imported = db.importDatabaseFile(tmpDbPath);

      if (parsed.data.thumbnails) {
        for (const [relKey, b64] of Object.entries(parsed.data.thumbnails)) {
          const cleanRel = relKey.replace(/\\/g, '/').replace(/^\/+/, '');
          if (!cleanRel || cleanRel.includes('..')) continue;
          const destPath = path.resolve(storage.thumbnailsDir, cleanRel);
          if (!destPath.startsWith(path.resolve(storage.thumbnailsDir) + path.sep)) {
            continue;
          }
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          await fs.promises.writeFile(destPath, Buffer.from(b64, 'base64'));
        }
      }

      return c.json({ ok: true, imported });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    } finally {
      await fs.promises.unlink(tmpDbPath).catch(() => {});
    }
  });

  // ---------- One-click Cloud Update (restart → re-pull latest release) ----------

  app.post('/api/admin/restart', (c) => {
    const passcode = process.env.STUDIO_PASSCODE?.trim();
    const encKey = process.env.ENCRYPTION_KEY?.trim();
    const adminHeader = c.req.header('x-admin-key')?.trim();
    const hasAdminKey = Boolean(encKey && adminHeader && safePasscodeEquals(adminHeader, encKey));
    if (!passcode && !hasAdminKey) {
      return c.json(
        { error: 'Admin endpoint requires STUDIO_PASSCODE or x-admin-key' },
        403
      );
    }
    if (!params.onRestartRequested) {
      return c.json({ error: 'Restart is not supported in this runtime' }, 501);
    }
    const trigger = params.onRestartRequested;
    setTimeout(trigger, 400);
    return c.json({ ok: true, message: 'Restarting to apply the latest release…' });
  });

  // ---------- Production Web SPA Static Fallback ----------

  if (params.webDistDir && fs.existsSync(params.webDistDir)) {
    const distDir = path.resolve(params.webDistDir);
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: 'Not found' }, 404);
      }
      const rel = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\/+/, '');
      const candidate = path.resolve(distDir, rel);
      const isSafe = candidate.startsWith(distDir);
      const target =
        isSafe && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          ? candidate
          : path.join(distDir, 'index.html');

      if (!fs.existsSync(target)) {
        return c.text('Not found', 404);
      }
      const ext = path.extname(target).toLowerCase();
      const buf = await fs.promises.readFile(target);
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream',
        },
      });
    });
  }

  return app;
}
