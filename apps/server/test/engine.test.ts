import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTENT_FORMATS,
  validateFormatMetadata,
  type MasterBrief,
} from '@clipflow/shared';
import { SecretCipher } from '../src/db/crypto.js';
import { ClipFlowDb } from '../src/db/database.js';
import { seedDefaultChannelData } from '../src/db/seed.js';
import { StorageService } from '../src/services/storage.js';
import { generateMetadataDeterministic } from '../src/services/metadata-engine.js';
import { SchedulerEngine } from '../src/scheduler/engine.js';
import {
  formatErrorWithCause,
  isTransientNetworkError,
} from '../src/services/net-resilience.js';

describe('SecretCipher AES-256-GCM', () => {
  it('encrypts and decrypts secrets and rejects tampered ciphertext', () => {
    const keyHex = 'a'.repeat(64);
    const cipher = new SecretCipher(keyHex);
    const enc = cipher.encrypt('ya29.secret_oauth_token_123');
    assert.ok(enc && enc.startsWith('v1:'));
    assert.equal(cipher.decrypt(enc), 'ya29.secret_oauth_token_123');

    const parts = enc.split(':');
    parts[3] = parts[3].slice(0, -2) + 'ff';
    assert.throws(() => cipher.decrypt(parts.join(':')));
  });
});

describe('Deterministic Metadata Engine', () => {
  it('generates valid platform-tailored metadata across all 6 formats with 0 validation errors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-meta-'));
    try {
      const db = new ClipFlowDb(':memory:', 'b'.repeat(64));
      const ch = db.createChannel({ name: 'Test Channel' });
      seedDefaultChannelData(db, ch.id);
      const templates = db.listTemplates(ch.id);

      const brief: MasterBrief = {
        topic: 'เทคนิคจัดตารางลงคลิปข้ามแพลตฟอร์มให้ปังทุกช่อง',
        hook: 'หยุดเสียเวลาลงคลิปทีละแอป! ทำแบบนี้ครั้งเดียวจบ',
        summary: 'สรุปขั้นตอนวางไฟล์เดียวแล้วตั้งเวลาอัปโหลดอัตโนมัติทั้ง YouTube, TikTok, IG และ Facebook',
        keyPoints: [
          'แยกเวลาลงต่างกันในแต่ละวัน',
          'YouTube/FB อัปโหลดล่วงหน้าได้',
          'IG/TikTok ยิงตรงเวลาไม่หมดอายุ',
        ],
        cta: 'กดติดตามไว้ได้เลยครับ',
        coreHashtags: ['#ตัดต่อคลิป', '#การตลาดออนไลน์', '#ครีเอเตอร์'],
        language: 'th',
        tone: 'FRIENDLY',
        timestampsText: '00:00 ปัญหา\n00:45 วิธีแก้',
      };

      const generated = generateMetadataDeterministic({
        brief,
        formats: [...CONTENT_FORMATS],
        templates,
      });

      for (const fmt of CONTENT_FORMATS) {
        const meta = generated[fmt] as Record<string, unknown> | undefined;
        assert.ok(meta, `Expected generated metadata for ${fmt}`);
        const issues = validateFormatMetadata(fmt, meta);
        const errs = issues.filter((i) => i.severity === 'error');
        assert.equal(errs.length, 0, `Unexpected errors for ${fmt}: ${JSON.stringify(errs)}`);
      }

      // 2026 Contextual SEO & anti-spam rules verification
      assert.ok(!/#fyp|#foryou|#reels/i.test(generated.TIKTOK?.caption ?? ''));
      assert.ok(!/#Shorts/i.test(generated.TIKTOK?.caption ?? ''));
      assert.ok(!/#fyp|#reels|#Shorts/i.test(generated.INSTAGRAM_REELS?.caption ?? ''));
      assert.ok(!/\.\n\./.test(generated.INSTAGRAM_REELS?.caption ?? ''));

      // Overlay-safe concise length checks for mobile vertical feeds
      assert.ok((generated.YOUTUBE_SHORTS?.title.length ?? 999) <= 58);
      assert.ok((generated.TIKTOK?.caption.length ?? 999) <= 185);
      assert.ok((generated.INSTAGRAM_REELS?.caption.length ?? 999) <= 185);
      assert.ok((generated.FACEBOOK_REELS?.title.length ?? 999) <= 55);
      assert.ok((generated.FACEBOOK_REELS?.description.length ?? 999) <= 185);
      for (const shortFmt of ['YOUTUBE_SHORTS', 'TIKTOK', 'INSTAGRAM_REELS', 'FACEBOOK_REELS'] as const) {
        const issues = validateFormatMetadata(shortFmt, generated[shortFmt] as Record<string, unknown>);
        assert.equal(issues.length, 0, `Expected 0 errors/warnings for ${shortFmt}, got ${JSON.stringify(issues)}`);
      }
      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('ClipFlowDb & Hybrid SchedulerEngine', () => {
  it('enforces max 3 channels, atomic job claiming, and executes Hybrid Pre-upload -> JIT Pre-warm -> Publish', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-sched-'));
    try {
      const db = new ClipFlowDb(':memory:', 'c'.repeat(64));
      const storage = new StorageService(tmpDir);
      const scheduler = new SchedulerEngine(db, storage);

      const ch1 = db.createChannel({ name: 'Ch 1' });
      db.createChannel({ name: 'Ch 2' });
      db.createChannel({ name: 'Ch 3' });
      assert.throws(() => db.createChannel({ name: 'Ch 4' }));

      seedDefaultChannelData(db, ch1.id);
      const accounts = db.listAccounts(ch1.id);
      const ytAcc = accounts.find((a) => a.platform === 'YOUTUBE')!;
      const fbAcc = accounts.find((a) => a.platform === 'FACEBOOK')!;
      const igAcc = accounts.find((a) => a.platform === 'INSTAGRAM')!;
      const ttAcc = accounts.find((a) => a.platform === 'TIKTOK')!;

      // Write dummy video file in storage uploadsDir
      const dummyKey = 'med_test_clip.mp4';
      fs.writeFileSync(storage.resolveLocalPath(dummyKey), Buffer.alloc(1024 * 64, 1));

      const asset = db.createMediaAsset({
        id: 'med_test',
        channelId: ch1.id,
        originalFilename: 'clip.mp4',
        storageProvider: 'LOCAL',
        storageKey: dummyKey,
        thumbnailPaths: [],
        mimeType: 'video/mp4',
        fileSizeBytes: 1024 * 64,
        probe: {
          durationSec: 30,
          width: 1080,
          height: 1920,
          rotation: 0,
          fps: 30,
          videoCodec: 'h264',
          audioCodec: 'aac',
          audioSampleRate: 48000,
          bitrateKbps: 2000,
          fileSizeBytes: 1024 * 64,
          hasFaststartMoov: true,
        },
        orientation: 'VERTICAL',
        clipCategory: 'SHORT',
      });

      const tPublish = '2026-12-10T12:00:00.000Z';
      const tPrewarm = '2026-12-10T11:48:00.000Z';

      const content = db.createContentWithJobs({
        channelId: ch1.id,
        mediaAssetId: asset.id,
        targetDate: '2026-12-10',
        masterBrief: {
          topic: 'Test Clip',
          hook: 'Test Hook',
          summary: 'Summary',
          keyPoints: [],
          cta: 'Follow',
          coreHashtags: ['#test'],
          language: 'th',
          tone: 'FRIENDLY',
        },
        platformMetadata: {
          YOUTUBE_SHORTS: {
            title: 'Test YT Short #Shorts',
            description: 'Desc',
            tags: ['test'],
            categoryId: '22',
            privacyStatus: 'public',
            madeForKids: false,
            notifySubscribers: true,
          },
          FACEBOOK_REELS: { title: 'Test FB', description: 'Desc' },
          INSTAGRAM_REELS: { caption: 'Test IG', shareToFeed: true, thumbOffsetMs: 0 },
          TIKTOK: {
            caption: 'Test TT',
            privacyLevel: 'PUBLIC_TO_EVERYONE',
            allowComment: true,
            allowDuet: true,
            allowStitch: true,
            brandOrganicToggle: false,
            brandContentToggle: false,
            isAigc: false,
            coverTimestampMs: 0,
          },
        },
        jobs: [
          {
            socialAccountId: ytAcc.id,
            platform: 'YOUTUBE',
            format: 'YOUTUBE_SHORTS',
            strategy: 'NATIVE_PREUPLOAD',
            scheduledAt: tPublish,
            prewarmAt: null,
            metadataSnapshot: { title: 'Test YT Short #Shorts', description: 'Desc' },
          },
          {
            socialAccountId: fbAcc.id,
            platform: 'FACEBOOK',
            format: 'FACEBOOK_REELS',
            strategy: 'NATIVE_PREUPLOAD',
            scheduledAt: tPublish,
            prewarmAt: null,
            metadataSnapshot: { title: 'Test FB', description: 'Desc' },
          },
          {
            socialAccountId: igAcc.id,
            platform: 'INSTAGRAM',
            format: 'INSTAGRAM_REELS',
            strategy: 'JIT_PUBLISH',
            scheduledAt: tPublish,
            prewarmAt: tPrewarm,
            metadataSnapshot: { caption: 'Test IG', shareToFeed: true, thumbOffsetMs: 0 },
          },
          {
            socialAccountId: ttAcc.id,
            platform: 'TIKTOK',
            format: 'TIKTOK',
            strategy: 'JIT_PUBLISH',
            scheduledAt: tPublish,
            prewarmAt: tPrewarm,
            metadataSnapshot: { caption: 'Test TT', privacyLevel: 'PUBLIC_TO_EVERYONE' },
          },
        ],
      });

      // Tick 1: Well before scheduled time (2026-12-01) -> YT & FB become NATIVE_SCHEDULED; IG & TT stay QUEUED
      await scheduler.tick(new Date('2026-12-01T10:00:00.000Z'));
      let jobs = db.listJobs({ contentItemId: content.id });
      assert.equal(jobs.find((j) => j.platform === 'YOUTUBE')?.status, 'NATIVE_SCHEDULED');
      assert.equal(jobs.find((j) => j.platform === 'FACEBOOK')?.status, 'NATIVE_SCHEDULED');
      assert.equal(jobs.find((j) => j.platform === 'INSTAGRAM')?.status, 'QUEUED');
      assert.equal(jobs.find((j) => j.platform === 'TIKTOK')?.status, 'QUEUED');

      // Reschedule while YT/FB are NATIVE_SCHEDULED
      const ytJob = jobs.find((j) => j.platform === 'YOUTUBE')!;
      await scheduler.rescheduleJobExternal(
        ytJob.id,
        '2026-12-11T12:00:00.000Z',
        null,
        'NATIVE_PREUPLOAD'
      );
      const ytLogs = db.listJobLogs(ytJob.id);
      assert.ok(ytLogs.some((l) => l.stage === 'RESCHEDULED_NATIVE'));

      // Restore YT job back to tPublish for publish verification
      await scheduler.rescheduleJobExternal(ytJob.id, tPublish, null, 'NATIVE_PREUPLOAD');

      // Tick 2: Prewarm window (T - 10 mins) -> IG & TT become READY_TO_PUBLISH (IG gets container ID)
      await scheduler.tick(new Date('2026-12-10T11:50:00.000Z'));
      jobs = db.listJobs({ contentItemId: content.id });
      const igJob = jobs.find((j) => j.platform === 'INSTAGRAM')!;
      assert.equal(igJob.status, 'READY_TO_PUBLISH');
      assert.ok(igJob.externalContainerId);
      assert.equal(jobs.find((j) => j.platform === 'TIKTOK')?.status, 'READY_TO_PUBLISH');

      // Atomic claim check: claiming again at same timestamp returns 0 duplicate claims
      const dupClaims = db.claimDueJobs('2026-12-10T11:50:00.000Z');
      assert.equal(dupClaims.length, 0);

      // Tick 3: Exact publish time -> all 4 jobs transition to PUBLISHED!
      await scheduler.tick(new Date('2026-12-10T12:00:01.000Z'));
      jobs = db.listJobs({ contentItemId: content.id });
      for (const j of jobs) {
        assert.equal(j.status, 'PUBLISHED', `Expected ${j.platform} to be PUBLISHED`);
        assert.ok(j.externalPostId);
      }

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('survives extended Wi-Fi / DNS outage (> maxRetries) for IG & TikTok JIT jobs, unwraps err.cause, auto-heals TikTok account name, and recovers when back online', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-netoutage-'));
    const origFetch = globalThis.fetch;
    try {
      // 1. Verify err.cause unwrapping for undici TypeError: fetch failed
      const dnsCause = Object.assign(new Error('getaddrinfo ENOTFOUND graph.facebook.com'), {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: 'graph.facebook.com',
      });
      const fetchErr = new TypeError('fetch failed', { cause: dnsCause });
      assert.equal(isTransientNetworkError(fetchErr), true);
      const formatted = formatErrorWithCause(fetchErr);
      assert.ok(formatted.includes('ENOTFOUND'), `Expected ENOTFOUND in: ${formatted}`);
      assert.ok(formatted.includes('graph.facebook.com'), `Expected hostname in: ${formatted}`);

      const db = new ClipFlowDb(':memory:', 'd'.repeat(64));
      const storage = new StorageService(tmpDir);
      const scheduler = new SchedulerEngine(db, storage);

      const ch = db.createChannel({ name: 'Resilience Channel' });
      seedDefaultChannelData(db, ch.id);
      const accounts = db.listAccounts(ch.id);
      const igAcc = accounts.find((a) => a.platform === 'INSTAGRAM')!;
      const ttAcc = accounts.find((a) => a.platform === 'TIKTOK')!;

      // Connect IG & TikTok in LIVE_OFFICIAL mode; verify TikTok auto-heals "(Simulation)" name
      db.updateAccount(igAcc.id, {
        connectionMode: 'LIVE_OFFICIAL',
        externalAccountId: '17841437675564069',
        accountName: '@tuenpidyuk',
        accessToken: 'ig_live_token',
      });
      const updatedTt = db.updateAccount(ttAcc.id, {
        connectionMode: 'LIVE_OFFICIAL',
        externalAccountId: 'open_id_tt',
        accessToken: 'tt_live_token',
        creatorInfo: {
          creatorUsername: 'tuenpidyuk5',
          creatorNickname: 'Tuenpidyuk',
          privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          commentDisabled: false,
          duetDisabled: false,
          stitchDisabled: false,
          maxVideoPostDurationSec: 3600,
          fetchedAt: '2026-11-22T00:00:00.000Z',
        },
      });
      assert.equal(updatedTt?.accountName, 'Tuenpidyuk (@tuenpidyuk5)');

      const dummyKey = 'med_outage.mp4';
      fs.writeFileSync(storage.resolveLocalPath(dummyKey), Buffer.alloc(2048, 7));
      const asset = db.createMediaAsset({
        id: 'med_outage',
        channelId: ch.id,
        originalFilename: 'outage.mp4',
        storageProvider: 'R2',
        storageKey: dummyKey,
        publicUrl: 'https://pub-test.r2.dev/med_outage.mp4',
        thumbnailPaths: [],
        mimeType: 'video/mp4',
        fileSizeBytes: 2048,
        probe: {
          durationSec: 15,
          width: 1080,
          height: 1920,
          rotation: 0,
          fps: 30,
          videoCodec: 'h264',
          audioCodec: 'aac',
          audioSampleRate: 48000,
          bitrateKbps: 2000,
          fileSizeBytes: 2048,
          hasFaststartMoov: true,
        },
        orientation: 'VERTICAL',
        clipCategory: 'SHORT',
      });

      const tDue = '2026-11-22T12:30:00.000Z';
      const content = db.createContentWithJobs({
        channelId: ch.id,
        mediaAssetId: asset.id,
        targetDate: '2026-11-22',
        masterBrief: {
          topic: 'Outage Recovery Clip',
          hook: 'Hook',
          summary: 'Summary',
          keyPoints: [],
          cta: 'Follow',
          coreHashtags: ['#test'],
          language: 'th',
          tone: 'FRIENDLY',
        },
        platformMetadata: {},
        jobs: [
          {
            socialAccountId: igAcc.id,
            platform: 'INSTAGRAM',
            format: 'INSTAGRAM_REELS',
            strategy: 'JIT_PUBLISH',
            scheduledAt: tDue,
            prewarmAt: '2026-11-22T12:18:00.000Z',
            metadataSnapshot: { caption: 'IG Outage Test', shareToFeed: true, thumbOffsetMs: 0 },
          },
          {
            socialAccountId: ttAcc.id,
            platform: 'TIKTOK',
            format: 'TIKTOK',
            strategy: 'JIT_PUBLISH',
            scheduledAt: tDue,
            prewarmAt: '2026-11-22T12:18:00.000Z',
            metadataSnapshot: {
              caption: 'TT Outage Test',
              privacyLevel: 'PUBLIC_TO_EVERYONE',
              allowComment: true,
              allowDuet: true,
              allowStitch: true,
            },
          },
        ],
      });

      // Simulate Wi-Fi disconnected across 5 scheduler ticks (> maxRetries = 3)
      let isOffline = true;
      globalThis.fetch = (async (input: string | URL | Request) => {
        if (isOffline) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), {
              code: 'ENOTFOUND',
              syscall: 'getaddrinfo',
              hostname: new URL(String(input)).hostname,
            }),
          });
        }
        const url = String(input);
        if (url.includes('graph.facebook.com') && url.endsWith('/media')) {
          return Response.json({ id: 'ig_cont_999' });
        }
        if (url.includes('graph.facebook.com') && url.includes('fields=status_code')) {
          return Response.json({ status_code: 'FINISHED' });
        }
        if (url.includes('graph.facebook.com') && url.endsWith('/media_publish')) {
          return Response.json({ id: 'ig_post_999' });
        }
        if (url.includes('creator_info/query')) {
          return Response.json({
            data: {
              creator_username: 'tuenpidyuk5',
              creator_nickname: 'Tuenpidyuk',
              privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
            },
            error: { code: 'ok' },
          });
        }
        if (url.includes('post/publish/video/init')) {
          return Response.json({
            data: {
              publish_id: 'tt_pub_999',
              upload_url: 'https://open-upload.tiktokapis.com/upload/999',
            },
            error: { code: 'ok' },
          });
        }
        if (url.includes('open-upload.tiktokapis.com')) {
          return new Response('', { status: 201 });
        }
        if (url.includes('status/fetch')) {
          return Response.json({
            data: {
              status: 'PUBLISH_COMPLETE',
              publicaly_available_post_id: ['tt_post_999'],
            },
            error: { code: 'ok' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      let simTimeMs = new Date('2026-11-22T12:30:10.000Z').getTime();
      for (let attempt = 1; attempt <= 5; attempt++) {
        await scheduler.tick(new Date(simTimeMs));
        simTimeMs += 6 * 60_000;
      }

      // After 5 offline attempts (> 3), jobs must NOT be marked FAILED!
      let jobs = db.listJobs({ contentItemId: content.id });
      for (const j of jobs) {
        assert.notEqual(j.status, 'FAILED', `${j.platform} should not fail permanently during Wi-Fi outage`);
        assert.equal(j.retryCount, 5);
        assert.ok(j.lastError?.includes('ENOTFOUND'), `Expected ENOTFOUND in lastError: ${j.lastError}`);
        const logs = db.listJobLogs(j.id);
        assert.ok(logs.some((l) => l.stage === 'NETWORK_WAIT_RETRY'));
      }

      // Now Wi-Fi reconnects -> next tick publishes both IG Reels & TikTok automatically!
      isOffline = false;
      await scheduler.tick(new Date(simTimeMs));
      jobs = db.listJobs({ contentItemId: content.id });
      for (const j of jobs) {
        assert.equal(j.status, 'PUBLISHED', `Expected ${j.platform} to recover and publish after Wi-Fi reconnect`);
        assert.equal(j.contentTopic, content.masterBrief.topic);
        assert.equal(j.contentTargetDate, '2026-11-22');
        assert.equal(j.mediaAssetId, asset.id);
      }

      db.close();
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
