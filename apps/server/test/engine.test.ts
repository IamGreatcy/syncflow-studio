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
});
