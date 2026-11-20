import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { addDaysToDateStr, getLocalDateTimeParts } from '@clipflow/shared';
import { ClipFlowDb } from '../src/db/database.js';
import { seedDefaultChannelData } from '../src/db/seed.js';
import { SchedulerEngine } from '../src/scheduler/engine.js';
import { StorageService } from '../src/services/storage.js';

describe('Schedule Past-Time Guard on POST /api/contents', () => {
  it('blocks accidental past target timestamps unless allowImmediate is explicitly set, and supports per-target future dates', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-guard-'));
    const db = new ClipFlowDb(':memory:', 'c'.repeat(64));
    try {
      const storage = new StorageService(tmpDir);
      const scheduler = new SchedulerEngine(db, storage);
      const channel = db.createChannel({ name: 'Guard Test Channel', timezone: 'Asia/Bangkok' });
      seedDefaultChannelData(db, channel.id);
      const accounts = db.listAccounts(channel.id);
      const fbAcc = accounts.find((a) => a.platform === 'FACEBOOK')!;
      const ytAcc = accounts.find((a) => a.platform === 'YOUTUBE')!;

      const dummyKey = 'guard_clip.mp4';
      fs.writeFileSync(storage.resolveLocalPath(dummyKey), Buffer.alloc(1024, 1));
      const asset = db.createMediaAsset({
        id: 'med_guard',
        channelId: channel.id,
        originalFilename: 'clip.mp4',
        storageProvider: 'LOCAL',
        storageKey: dummyKey,
        thumbnailPaths: [],
        mimeType: 'video/mp4',
        fileSizeBytes: 1024,
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
          fileSizeBytes: 1024,
          hasFaststartMoov: true,
        },
        orientation: 'VERTICAL',
        clipCategory: 'SHORT',
      });

      const app = createApp({ db, storage, scheduler });

      const baseBody = {
        channelId: channel.id,
        mediaAssetId: asset.id,
        targetDate: '2020-01-01',
        masterBrief: {
          topic: 'Guard Test',
          hook: 'Hook',
          summary: 'Summary',
          keyPoints: [],
          cta: 'Follow',
          coreHashtags: ['#test'],
          language: 'th',
          tone: 'FRIENDLY',
        },
        platformMetadata: {
          FACEBOOK_REELS: { title: 'FB Test', description: 'Desc' },
          YOUTUBE_SHORTS: {
            title: 'YT Test #Shorts',
            description: 'Desc',
            tags: ['test'],
            categoryId: '22',
            privacyStatus: 'public',
            madeForKids: false,
            notifySubscribers: true,
          },
        },
      };

      // 1. Past timestamp without allowImmediate must fail with 400 PAST_SCHEDULE_TIME and create 0 jobs
      const blockedRes = await app.request('http://localhost:3001/api/contents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseBody,
          targets: [
            { socialAccountId: fbAcc.id, format: 'FACEBOOK_REELS', localTime: '11:30' },
          ],
          dispatchImmediately: false,
        }),
      });
      assert.equal(blockedRes.status, 400);
      const blockedJson = (await blockedRes.json()) as { code?: string };
      assert.equal(blockedJson.code, 'PAST_SCHEDULE_TIME');
      assert.equal(db.listJobs({ channelId: channel.id }).length, 0);

      // 2. Per-target future targetDate succeeds and schedules cleanly at that future date
      const todayBkk = getLocalDateTimeParts(new Date(), 'Asia/Bangkok').dateStr;
      const tomorrowBkk = addDaysToDateStr(todayBkk, 1);
      const dayAfterBkk = addDaysToDateStr(todayBkk, 2);

      const futureRes = await app.request('http://localhost:3001/api/contents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseBody,
          targetDate: tomorrowBkk,
          targets: [
            {
              socialAccountId: fbAcc.id,
              format: 'FACEBOOK_REELS',
              targetDate: dayAfterBkk,
              localTime: '10:30',
            },
            {
              socialAccountId: ytAcc.id,
              format: 'YOUTUBE_SHORTS',
              targetDate: tomorrowBkk,
              localTime: '16:30',
            },
          ],
          dispatchImmediately: false,
        }),
      });
      assert.equal(futureRes.status, 201);
      const createdJobs = db.listJobs({ channelId: channel.id });
      assert.equal(createdJobs.length, 2);
      const fbJob = createdJobs.find((j) => j.platform === 'FACEBOOK')!;
      assert.equal(fbJob.scheduledAt.slice(0, 10), dayAfterBkk);
      assert.equal(fbJob.strategy, 'NATIVE_PREUPLOAD');

      // 3. Explicit allowImmediate overrides guard when user consciously opts in
      const immediateRes = await app.request('http://localhost:3001/api/contents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseBody,
          targets: [
            {
              socialAccountId: fbAcc.id,
              format: 'FACEBOOK_REELS',
              localTime: '11:30',
              allowImmediate: true,
            },
          ],
          dispatchImmediately: false,
        }),
      });
      assert.equal(immediateRes.status, 201);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
