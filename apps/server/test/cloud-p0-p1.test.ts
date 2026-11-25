import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClipFlowDb } from '../src/db/database.js';
import { ensureInitialSeed } from '../src/db/seed.js';
import { StorageService } from '../src/services/storage.js';
import { SchedulerEngine } from '../src/scheduler/engine.js';
import { createApp } from '../src/app.js';
import {
  generateMetadataDeterministic,
  generateMetadataWithAI,
} from '../src/services/metadata-engine.js';
import { fetchWithRetry } from '../src/services/net-resilience.js';
import { InstagramAdapter } from '../src/adapters/instagram.js';
import { YouTubeAdapter } from '../src/adapters/youtube.js';
import type { AdapterContext } from '../src/adapters/types.js';
import type { MasterBrief } from '@clipflow/shared';

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncflow-p0p1-'));
  const db = new ClipFlowDb(path.join(dir, 'test.sqlite'), path.join(dir, '.key'));
  ensureInitialSeed(db);
  const storage = new StorageService(path.join(dir, 'data'));
  const scheduler = new SchedulerEngine(db, storage, false);
  const app = createApp({ db, storage, scheduler });
  return { dir, db, storage, scheduler, app };
}

describe('SyncFlow Cloud P0/P1 Optimizations', () => {
  it('promotes existing DRAFT via draftContentId without duplicating content_items and responds non-blocking', async () => {
    const env = makeEnv();
    try {
      const ch = env.db.listChannels()[0]!;
      const yt = env.db.listAccounts(ch.id).find((a) => a.platform === 'YOUTUBE')!;
      const asset = env.db.createMediaAsset({
        id: 'med_test_pyramid',
        channelId: ch.id,
        originalFilename: 'คนสร้างพีระมิดกินอะไร.mp4',
        storageProvider: 'LOCAL',
        storageKey: 'med_test_pyramid.mp4',
        thumbnailPaths: [],
        mimeType: 'video/mp4',
        fileSizeBytes: 1024,
        probe: {
          durationSec: 32,
          width: 1080,
          height: 1920,
          rotation: 0,
          fps: 24,
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

      const brief: MasterBrief = {
        topic: 'คนสร้างพีระมิดกินอะไร',
        hook: 'ไม่ได้กินแค่ขนมปัง!',
        summary: 'หลักฐานโบราณคดีรอบพีระมิดกิซา',
        keyPoints: ['ขุดเจอพิมพ์ขนมปัง'],
        cta: '',
        coreHashtags: ['#ประวัติศาสตร์'],
        language: 'th',
        tone: 'FRIENDLY',
      };

      const draft = env.db.createContentWithJobs({
        channelId: ch.id,
        mediaAssetId: asset.id,
        targetDate: '2026-12-01',
        masterBrief: brief,
        platformMetadata: {},
        jobs: [],
      });
      assert.equal(draft.status, 'DRAFT');

      const res = await env.app.request('/api/contents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draftContentId: draft.id,
          channelId: ch.id,
          mediaAssetId: asset.id,
          targetDate: '2026-12-01',
          masterBrief: brief,
          platformMetadata: {
            YOUTUBE_SHORTS: {
              title: 'คนสร้างพีระมิดกินอะไร? #Shorts',
              description: 'หลักฐานจริง #Shorts #ประวัติศาสตร์',
              tags: ['พีระมิด'],
              categoryId: '27',
              privacyStatus: 'public',
              madeForKids: false,
              notifySubscribers: true,
            },
          },
          targets: [
            {
              socialAccountId: yt.id,
              format: 'YOUTUBE_SHORTS',
              targetDate: '2026-12-01',
              localTime: '17:30',
            },
          ],
          dispatchImmediately: false,
        }),
      });
      assert.equal(res.status, 201);
      const data = (await res.json()) as { content: { id: string; status: string; jobs: unknown[] } };
      assert.equal(data.content.id, draft.id, 'Must reuse existing draft ID');
      assert.equal(data.content.status, 'SCHEDULED');
      assert.equal(data.content.jobs.length, 1);
      assert.equal(env.db.listContents({ channelId: ch.id }).length, 1, 'No orphaned duplicate draft row');
    } finally {
      env.scheduler.stop();
      env.db.close();
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('metadata engine ignores generic seeded CTA and sends MINIMAL thinking on gemini-3.5-flash-lite', async () => {
    const env = makeEnv();
    const origFetch = globalThis.fetch;
    try {
      const ch = env.db.listChannels()[0]!;
      const brief: MasterBrief = {
        topic: 'ทำไมเกลือสมัยก่อนแพงกว่าทองคำ',
        hook: 'ทหารโรมันเคยได้ค่าจ้างเป็นเกลือ?',
        summary: 'ประวัติศาสตร์เส้นทางค้าเกลือโบราณ',
        keyPoints: ['เกลือช่วยถนอมอาหาร'],
        cta: '',
        coreHashtags: ['#ประวัติศาสตร์'],
        language: 'th',
        tone: 'FRIENDLY',
      };
      const det = generateMetadataDeterministic({
        brief,
        formats: ['YOUTUBE_SHORTS'],
        templates: [
          {
            id: 'tpl_legacy',
            channelId: ch.id,
            format: 'YOUTUBE_SHORTS',
            name: 'Legacy',
            titlePrefix: '',
            titleSuffix: '',
            descriptionHeader: '',
            descriptionFooter: '',
            defaultHashtags: ['#Shorts'],
            defaultTags: [],
            defaultCta: 'กดติดตามไว้ไม่พลาดคลิปใหม่!',
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      assert.ok(
        !det.YOUTUBE_SHORTS!.description.includes('กดติดตามไว้ไม่พลาดคลิปใหม่!'),
        'Generic seeded CTA must not shadow contextual engagement CTA'
      );

      let seenUrl = '';
      let seenBody: Record<string, unknown> = {};
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(input);
        seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      YOUTUBE_SHORTS: {
                        title: 'ทำไมเกลือเคยแพงกว่าทอง? #Shorts',
                        description: 'รู้แล้วอึ้ง! เกลือคือทองคำขาวโบราณ #Shorts #ประวัติศาสตร์',
                        tags: ['เกลือโบราณ', 'ประวัติศาสตร์'],
                      },
                    }),
                  },
                ],
              },
            },
          ],
        });
      }) as typeof fetch;

      const aiRes = await generateMetadataWithAI({
        brief,
        formats: ['YOUTUBE_SHORTS'],
        templates: [],
        settings: {
          ...env.db.getSettingsFull(),
          aiProvider: 'GEMINI',
          aiApiKey: 'AIzaSyTestCloudKey_000000001',
          aiModel: 'gemini-3.6-flash', // retired/phantom model must be bypassed
        },
      });
      assert.equal(aiRes.engineUsed, 'AI_GEMINI');
      assert.match(seenUrl, /gemini-3\.5-flash-lite/);
      const genCfg = seenBody.generationConfig as { thinkingConfig?: { thinkingLevel?: string } };
      assert.equal(genCfg.thinkingConfig?.thinkingLevel, 'MINIMAL');
    } finally {
      globalThis.fetch = origFetch;
      env.scheduler.stop();
      env.db.close();
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('claimDueJobs recovers non-FB jobs stuck in PREUPLOADING/PUBLISHING after lease expiry', () => {
    const env = makeEnv();
    try {
      const ch = env.db.listChannels()[0]!;
      const yt = env.db.listAccounts(ch.id).find((a) => a.platform === 'YOUTUBE')!;
      const asset = env.db.createMediaAsset({
        id: 'med_test_pyramid',
        channelId: ch.id,
        originalFilename: 'stuck.mp4',
        storageProvider: 'LOCAL',
        storageKey: 'med_stuck.mp4',
        thumbnailPaths: [],
        mimeType: 'video/mp4',
        fileSizeBytes: 512,
        probe: {
          durationSec: 20,
          width: 1080,
          height: 1920,
          rotation: 0,
          fps: 24,
          videoCodec: 'h264',
          audioCodec: 'aac',
          audioSampleRate: 48000,
          bitrateKbps: 1500,
          fileSizeBytes: 512,
          hasFaststartMoov: true,
        },
        orientation: 'VERTICAL',
        clipCategory: 'SHORT',
      });
      const content = env.db.createContentWithJobs({
        channelId: ch.id,
        mediaAssetId: asset.id,
        targetDate: '2026-11-26',
        masterBrief: {
          topic: 'stuck test',
          hook: 'hook',
          summary: 'sum',
          keyPoints: [],
          cta: '',
          coreHashtags: [],
          language: 'th',
          tone: 'FRIENDLY',
        },
        platformMetadata: {},
        jobs: [
          {
            socialAccountId: yt.id,
            platform: 'YOUTUBE',
            format: 'YOUTUBE_SHORTS',
            strategy: 'NATIVE_PREUPLOAD',
            scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
            prewarmAt: null,
            metadataSnapshot: {},
          },
        ],
      });
      const jobId = content.jobs![0]!.id;
      const expiredLease = new Date(Date.now() - 10 * 60_000).toISOString();
      env.db.updateJob(jobId, { status: 'PREUPLOADING', lockedUntil: expiredLease });

      const claimed = env.db.claimDueJobs(new Date().toISOString(), 10, false);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]!.id, jobId);
    } finally {
      env.scheduler.stop();
      env.db.close();
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it('fetchWithRetry enforces timeoutMs and retries timed-out requests', async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        calls++;
        if (calls === 1) {
          assert.ok(init?.signal, 'Expected AbortSignal from timeoutMs');
          return await new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => {
              const err = new Error('Timed out');
              err.name = 'TimeoutError';
              reject(err);
            });
          });
        }
        return Response.json({ ok: true });
      }) as typeof fetch;

      const res = await fetchWithRetry('https://example.com/test', {}, { retries: 1, timeoutMs: 40, baseDelayMs: 10 });
      assert.equal(res.ok, true);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('InstagramAdapter resolves real permalink and YouTubeAdapter verifies NATIVE_SCHEDULED status', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/media_publish')) {
          return Response.json({ id: '179999999999' });
        }
        if (url.includes('fields=permalink')) {
          return Response.json({ permalink: 'https://www.instagram.com/reel/CxRealShortcode/' });
        }
        if (url.includes('youtube/v3/videos?part=status')) {
          return Response.json({
            items: [{ status: { uploadStatus: 'processed', privacyStatus: 'public' } }],
          });
        }
        return Response.json({ ok: true });
      }) as typeof fetch;

      const ig = new InstagramAdapter();
      const igCtx = {
        job: {
          externalContainerId: 'cnt_123',
          metadataSnapshot: { __containerCreatedAt: new Date().toISOString() },
        },
        account: { connectionMode: 'LIVE_OFFICIAL', externalAccountId: 'ig_user_1' },
        accessToken: 'tok_ig',
        log: () => {},
      } as unknown as AdapterContext;
      const igPub = await ig.publishNow(igCtx);
      assert.equal(igPub.externalUrl, 'https://www.instagram.com/reel/CxRealShortcode/');

      const yt = new YouTubeAdapter();
      const ytLogs: string[] = [];
      const ytCtx = {
        job: {
          status: 'NATIVE_SCHEDULED',
          externalPostId: 'vid_abc123',
          externalUrl: 'https://youtube.com/shorts/vid_abc123',
        },
        account: { connectionMode: 'LIVE_OFFICIAL' },
        accessToken: 'tok_yt',
        log: (_l: string, _s: string, msg: string) => ytLogs.push(msg),
      } as unknown as AdapterContext;
      const ytPub = await yt.publishNow(ytCtx);
      assert.equal(ytPub.externalPostId, 'vid_abc123');
      assert.ok(ytLogs.some((m) => m.includes('uploadStatus=processed')));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('SQLite VACUUM INTO backup produces valid database and listExpiredMediaAssets protects active media', () => {
    const env = makeEnv();
    try {
      const ch = env.db.listChannels()[0]!;
      const asset = env.db.createMediaAsset({
        id: 'med_test_pyramid',
        channelId: ch.id,
        originalFilename: 'active.mp4',
        storageProvider: 'LOCAL',
        storageKey: 'med_active.mp4',
        thumbnailPaths: [],
        mimeType: 'video/mp4',
        fileSizeBytes: 512,
        probe: {
          durationSec: 20,
          width: 1080,
          height: 1920,
          rotation: 0,
          fps: 24,
          videoCodec: 'h264',
          audioCodec: 'aac',
          audioSampleRate: 48000,
          bitrateKbps: 1500,
          fileSizeBytes: 512,
          hasFaststartMoov: true,
        },
        orientation: 'VERTICAL',
        clipCategory: 'SHORT',
      });
      assert.equal(env.db.listExpiredMediaAssets(30).length, 0);

      const backupPath = path.join(env.dir, 'backup.sqlite');
      env.db.backupToFile(backupPath);
      assert.ok(fs.existsSync(backupPath));
      assert.ok(fs.statSync(backupPath).size > 0);
      assert.ok(asset.id);
    } finally {
      env.scheduler.stop();
      env.db.close();
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });
});
