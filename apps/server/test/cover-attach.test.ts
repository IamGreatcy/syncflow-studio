import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContentFormat, MediaAsset, Platform, PublishJob, SocialAccount } from '@clipflow/shared';
import { StorageService } from '../src/services/storage.js';
import { probeVideo } from '../src/services/media.js';
import type { AdapterContext } from '../src/adapters/types.js';
import { prepareFacebookReelMedia, runFacebookReel } from '../src/adapters/facebook-reel.js';
import { TikTokAdapter } from '../src/adapters/tiktok.js';
import { YouTubeAdapter } from '../src/adapters/youtube.js';
import { InstagramAdapter } from '../src/adapters/instagram.js';

function createMockContext(params: {
  platform: Platform;
  format: ContentFormat;
  localFilePath: string;
  coverVideoPath?: string;
  thumbnailPath: string;
  fileSizeBytes: number;
  customCoverPublicUrl?: string | null;
  publicUrl?: string | null;
  metadataSnapshot: Record<string, unknown>;
}): { ctx: AdapterContext; logs: Array<{ stage: string; details?: Record<string, unknown> }> } {
  const nowIso = new Date().toISOString();
  const logs: Array<{ stage: string; details?: Record<string, unknown> }> = [];
  const asset: MediaAsset = {
    id: 'med_testcov',
    channelId: 'ch_test',
    originalFilename: 'clip.mp4',
    storageProvider: params.publicUrl ? 'R2' : 'LOCAL',
    storageKey: 'med_testcov_clip.mp4',
    optimizedStorageKey: null,
    publicUrl: params.publicUrl ?? null,
    thumbnailPaths: ['thumb_0.jpg'],
    customCoverKey: 'custom_cover.jpg',
    customCoverPublicUrl: params.customCoverPublicUrl ?? null,
    sourceMeta: { sourceApp: 'SyncCut Studio', syntheticMedia: true },
    mimeType: 'video/mp4',
    fileSizeBytes: params.fileSizeBytes,
    probe: {
      durationSec: 12,
      width: 720,
      height: 1280,
      rotation: 0,
      fps: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioSampleRate: 48000,
      bitrateKbps: 1500,
      fileSizeBytes: params.fileSizeBytes,
      hasFaststartMoov: true,
    },
    orientation: 'VERTICAL',
    clipCategory: 'SHORT',
    status: 'READY',
    createdAt: nowIso,
  };
  const job: PublishJob = {
    id: 'job_testcov',
    idempotencyKey: `cnt:acc:${params.platform}`,
    contentItemId: 'cnt_test',
    channelId: 'ch_test',
    socialAccountId: 'acc_test',
    platform: params.platform,
    format: params.format,
    strategy: 'JIT_PUBLISH',
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    prewarmAt: null,
    status: 'QUEUED',
    externalPostId: null,
    externalContainerId: null,
    externalUrl: null,
    metadataSnapshot: params.metadataSnapshot,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    lastError: null,
    lockedUntil: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const account: SocialAccount = {
    id: 'acc_test',
    channelId: 'ch_test',
    platform: params.platform,
    accountName: 'Test Account',
    externalAccountId: 'ext_123',
    connectionMode: 'LIVE_OFFICIAL',
    config: {},
    hasAccessToken: true,
    hasRefreshToken: false,
    tokenExpiresAt: null,
    creatorInfo: null,
    status: 'CONNECTED',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const ctx: AdapterContext = {
    job,
    account,
    accessToken: 'test_access_token',
    refreshToken: null,
    asset,
    localFilePath: params.localFilePath,
    thumbnailPath: params.thumbnailPath,
    hasCustomCover: Boolean(params.coverVideoPath),
    getCoverVideoPath: params.coverVideoPath
      ? async () => params.coverVideoPath!
      : undefined,
    settings: {
      defaultTimezone: 'Asia/Bangkok',
      r2AccountId: '',
      r2BucketName: '',
      r2PublicBaseUrl: '',
      notificationWebhookUrl: '',
      hasGeminiKey: false,
      hasR2Credentials: false,
      hasGoogleOAuth: false,
      hasMetaOAuth: false,
      hasTikTokOAuth: false,
      hasUnifiedApi: false,
      unifiedApiBaseUrl: '',
      r2AccessKeyId: '',
      r2SecretAccessKey: '',
      geminiApiKey: '',
      unifiedApiKey: '',
      googleClientId: '',
      googleClientSecret: '',
      metaAppId: '',
      metaAppSecret: '',
      tiktokClientKey: '',
      tiktokClientSecret: '',
    },
    log: (_level, stage, _message, details) => {
      logs.push({ stage, details });
    },
  };
  return { ctx, logs };
}

describe('Automatic Cover Attachment Pipeline', () => {
  it('prepends custom cover as Frame 0 cleanly and reuses cache on repeat calls', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncflow-prepend-'));
    try {
      const storage = new StorageService(path.join(tmpDir, 'data'));
      const srcVideo = path.join(tmpDir, 'green.mp4');
      const coverImg = path.join(tmpDir, 'red_cover.jpg');

      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=green:s=720x1280:r=24:d=1.0',
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=48000:cl=stereo:d=1.0',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          srcVideo,
        ],
        { stdio: 'pipe' }
      );
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=720x1280',
          '-frames:v',
          '1',
          coverImg,
        ],
        { stdio: 'pipe' }
      );

      const probe = await probeVideo(srcVideo);
      const outPath1 = await storage.ensureCoverPrependedVideo({
        assetId: 'med_unit',
        videoPath: srcVideo,
        coverPath: coverImg,
        probe,
      });

      assert.ok(fs.existsSync(outPath1));
      const outProbe = await probeVideo(outPath1);
      assert.ok(outProbe.durationSec >= 1.1, `Expected duration >= 1.1s, got ${outProbe.durationSec}`);
      assert.equal(outProbe.width, 720);
      assert.equal(outProbe.height, 1280);
      assert.equal(outProbe.audioCodec, 'aac');
      assert.equal(outProbe.hasFaststartMoov, true);

      // Verify Frame 0 pixels are red (center pixel R > 200, G < 40, B < 40)
      const rgb = execFileSync(
        'ffmpeg',
        ['-v', 'error', '-i', outPath1, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { maxBuffer: 5 * 1024 * 1024 }
      );
      const centerIdx = ((Math.floor(1280 / 2) * 720) + Math.floor(720 / 2)) * 3;
      assert.ok(rgb[centerIdx] > 200, `Expected high R channel, got ${rgb[centerIdx]}`);
      assert.ok(rgb[centerIdx + 1] < 40, `Expected low G channel, got ${rgb[centerIdx + 1]}`);
      assert.ok(rgb[centerIdx + 2] < 40, `Expected low B channel, got ${rgb[centerIdx + 2]}`);

      // Second call returns cached file without modifying mtime
      const mtimeBefore = fs.statSync(outPath1).mtimeMs;
      const outPath2 = await storage.ensureCoverPrependedVideo({
        assetId: 'med_unit',
        videoPath: srcVideo,
        coverPath: coverImg,
        probe,
      });
      assert.equal(outPath2, outPath1);
      assert.equal(fs.statSync(outPath2).mtimeMs, mtimeBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Facebook Reels injects cover frame and uploads custom cover via /{videoId}/thumbnails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncflow-fb-'));
    const origFetch = globalThis.fetch;
    try {
      const origFile = path.join(tmpDir, 'orig.mp4');
      const coverVideo = path.join(tmpDir, 'cover.mp4');
      const thumbFile = path.join(tmpDir, 'cover.jpg');
      fs.writeFileSync(origFile, Buffer.alloc(100, 1));
      fs.writeFileSync(coverVideo, Buffer.alloc(240, 2));
      fs.writeFileSync(thumbFile, Buffer.from('jpeg-cover-bytes'));

      let uploadedSize = 0;
      let thumbnailCalled = false;
      let isPreferredValue: FormDataEntryValue | null = null;
      let hasSourceFile = false;

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/me?')) return Response.json({ id: '789' });
        if (url.includes('/video_reels')) {
          const bodyStr = String(init?.body ?? '');
          if (bodyStr.includes('start')) {
            return Response.json({
              video_id: '123',
              upload_url: 'https://rupload.facebook.com/video-upload/v22.0/123',
            });
          }
          return Response.json({ success: true });
        }
        if (url.includes('rupload.facebook.com')) {
          const headers = init?.headers as Record<string, string>;
          uploadedSize = Number(headers?.file_size || 0);
          return Response.json({ success: true });
        }
        if (url.includes('/123/thumbnails')) {
          thumbnailCalled = true;
          const form = init?.body as FormData;
          isPreferredValue = form.get('is_preferred');
          hasSourceFile = form.get('source') instanceof Blob;
          return Response.json({ success: true });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const { ctx, logs } = createMockContext({
        platform: 'FACEBOOK',
        format: 'FACEBOOK_REELS',
        localFilePath: origFile,
        coverVideoPath: coverVideo,
        thumbnailPath: thumbFile,
        fileSizeBytes: 100,
        metadataSnapshot: { title: 'Test Reel', description: 'Desc', isAiGenerated: true },
      });

      let saved = ctx.job;
      await runFacebookReel({
        job: ctx.job, pageId: '789', token: ctx.accessToken, now: new Date(),
        nativeSchedule: true, verifyOnly: false, loadMedia: () => prepareFacebookReelMedia(ctx),
        save: (patch) => { saved = { ...saved, ...patch }; }, log: ctx.log,
      });
      assert.equal(saved.facebookReel?.videoId, '123');
      assert.equal(saved.status, 'PUBLISH_REQUESTED');
      assert.equal(uploadedSize, 240);
      assert.equal(thumbnailCalled, true);
      assert.equal(isPreferredValue, 'true');
      assert.equal(hasSourceFile, true);
      assert.ok(logs.some((l) => l.stage === 'FB_REELS_COVER_FRAME_INJECTED'));
      assert.ok(logs.some((l) => l.stage === 'FB_THUMBNAIL_SET'));
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('TikTok uploads cover-prepended video and overrides video_cover_timestamp_ms to 0', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncflow-tt-'));
    const origFetch = globalThis.fetch;
    try {
      const origFile = path.join(tmpDir, 'orig.mp4');
      const coverVideo = path.join(tmpDir, 'cover.mp4');
      const thumbFile = path.join(tmpDir, 'cover.jpg');
      fs.writeFileSync(origFile, Buffer.alloc(300, 1));
      fs.writeFileSync(coverVideo, Buffer.alloc(620, 2));
      fs.writeFileSync(thumbFile, Buffer.from('jpeg-cover-bytes'));

      let initPayload: Record<string, unknown> | null = null;
      let putLength = 0;

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('creator_info/query')) {
          return Response.json({
            data: {
              creator_username: 'tester',
              privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
            },
            error: { code: 'ok' },
          });
        }
        if (url.includes('post/publish/video/init')) {
          initPayload = JSON.parse(String(init?.body ?? '{}'));
          return Response.json({
            data: {
              publish_id: 'tt_pub_1',
              upload_url: 'https://open-upload.tiktokapis.com/chunk/1',
            },
            error: { code: 'ok' },
          });
        }
        if (url.includes('open-upload.tiktokapis.com')) {
          const buf = init?.body as Buffer;
          putLength = buf.length;
          return new Response('', { status: 201 });
        }
        if (url.includes('status/fetch')) {
          return Response.json({
            data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['771122'] },
            error: { code: 'ok' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const { ctx, logs } = createMockContext({
        platform: 'TIKTOK',
        format: 'TIKTOK',
        localFilePath: origFile,
        coverVideoPath: coverVideo,
        thumbnailPath: thumbFile,
        fileSizeBytes: 300,
        metadataSnapshot: {
          caption: 'Hi TikTok',
          privacyLevel: 'PUBLIC_TO_EVERYONE',
          allowComment: true,
          allowDuet: true,
          allowStitch: true,
          brandOrganicToggle: false,
          brandContentToggle: false,
          isAigc: true,
          coverTimestampMs: 3200,
        },
      });

      const adapter = new TikTokAdapter();
      const res = await adapter.publishNow(ctx);
      assert.equal(res.externalPostId, '771122');
      const postInfo = (initPayload as { post_info?: { video_cover_timestamp_ms?: number } })?.post_info;
      const sourceInfo = (initPayload as { source_info?: { video_size?: number; chunk_size?: number } })?.source_info;
      assert.equal(postInfo?.video_cover_timestamp_ms, 0);
      assert.equal(sourceInfo?.video_size, 620);
      assert.equal(sourceInfo?.chunk_size, 620);
      assert.equal(putLength, 620);
      assert.ok(logs.some((l) => l.stage === 'TIKTOK_COVER_FRAME_INJECTED'));
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('YouTube Shorts injects cover frame and calls thumbnails/set while Long keeps original video', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncflow-yt-'));
    const origFetch = globalThis.fetch;
    try {
      const origFile = path.join(tmpDir, 'orig.mp4');
      const coverVideo = path.join(tmpDir, 'cover.mp4');
      const thumbFile = path.join(tmpDir, 'cover.jpg');
      fs.writeFileSync(origFile, Buffer.alloc(150, 1));
      fs.writeFileSync(coverVideo, Buffer.alloc(290, 2));
      fs.writeFileSync(thumbFile, Buffer.from('jpeg-cover-bytes'));

      const uploadedSizes: number[] = [];
      let thumbSetCalls = 0;

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('upload/youtube/v3/videos')) {
          return new Response('', {
            status: 200,
            headers: { Location: 'https://www.googleapis.com/upload/session/1' },
          });
        }
        if (url.includes('upload/session/1')) {
          const buf = init?.body as Buffer;
          uploadedSizes.push(buf.length);
          return Response.json({ id: 'yt_vid_1' });
        }
        if (url.includes('thumbnails/set')) {
          thumbSetCalls++;
          return Response.json({ kind: 'youtube#thumbnailSetResponse' });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const adapter = new YouTubeAdapter();
      const shortsCtx = createMockContext({
        platform: 'YOUTUBE',
        format: 'YOUTUBE_SHORTS',
        localFilePath: origFile,
        coverVideoPath: coverVideo,
        thumbnailPath: thumbFile,
        fileSizeBytes: 150,
        metadataSnapshot: { title: 'Shorts', description: 'Desc', tags: [] },
      });
      await adapter.preUploadSchedule(shortsCtx.ctx);

      const longCtx = createMockContext({
        platform: 'YOUTUBE',
        format: 'YOUTUBE_LONG',
        localFilePath: origFile,
        coverVideoPath: coverVideo,
        thumbnailPath: thumbFile,
        fileSizeBytes: 150,
        metadataSnapshot: { title: 'Long', description: 'Desc', tags: [] },
      });
      await adapter.preUploadSchedule(longCtx.ctx);

      assert.deepEqual(uploadedSizes, [290, 150]);
      assert.equal(thumbSetCalls, 2);
      assert.ok(shortsCtx.logs.some((l) => l.stage === 'YT_SHORTS_COVER_FRAME_INJECTED'));
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Instagram Reels attaches cover_url and falls back to thumb_offset if Meta rejects cover_url', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncflow-ig-'));
    const origFetch = globalThis.fetch;
    try {
      const origFile = path.join(tmpDir, 'orig.mp4');
      const thumbFile = path.join(tmpDir, 'cover.jpg');
      fs.writeFileSync(origFile, Buffer.alloc(120, 1));
      fs.writeFileSync(thumbFile, Buffer.from('jpeg-cover-bytes'));

      const bodies: string[] = [];
      let mediaCalls = 0;

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/media')) {
          mediaCalls++;
          const bodyStr = String(init?.body ?? '');
          bodies.push(bodyStr);
          if (mediaCalls === 1) {
            return new Response('Invalid parameter cover_url could not be downloaded', { status: 400 });
          }
          return Response.json({ id: 'ig_cnt_ok' });
        }
        if (url.includes('ig_cnt_ok?fields=status_code')) {
          return Response.json({ status_code: 'FINISHED' });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const { ctx, logs } = createMockContext({
        platform: 'INSTAGRAM',
        format: 'INSTAGRAM_REELS',
        localFilePath: origFile,
        thumbnailPath: thumbFile,
        fileSizeBytes: 120,
        customCoverPublicUrl: 'https://cdn.example.com/cover.jpg',
        publicUrl: 'https://cdn.example.com/video.mp4',
        metadataSnapshot: {
          caption: 'IG Reel',
          shareToFeed: true,
          thumbOffsetMs: 3200,
          isAiGenerated: true,
        },
      });

      const adapter = new InstagramAdapter();
      const warm = await adapter.preWarm(ctx);
      assert.equal(warm.externalContainerId, 'ig_cnt_ok');
      assert.equal(mediaCalls, 2);
      assert.ok(bodies[0].includes('cover_url='));
      assert.ok(!bodies[1].includes('cover_url='));
      assert.ok(bodies[1].includes('thumb_offset=3200'));
      assert.ok(logs.some((l) => l.stage === 'IG_COVER_URL_SET'));
      assert.ok(logs.some((l) => l.stage === 'IG_COVER_URL_FALLBACK'));
    } finally {
      globalThis.fetch = origFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
