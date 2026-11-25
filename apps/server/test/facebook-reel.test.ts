import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ClipFlowDb } from '../src/db/database.js';
import { facebookReelRuntime, SchedulerEngine } from '../src/scheduler/engine.js';
import { StorageService } from '../src/services/storage.js';
import { createApp } from '../src/app.js';

const pageId = '12345';
const videoId = '98765';
const postId = '43210';
const credential = 'never-log-this-page-credential';
const now = new Date('2026-11-25T05:00:00.000Z');
const complete = 'complete';
const published = {
  video_status: 'ready',
  uploading_phase: { status: complete, bytes_transferred: 100 },
  processing_phase: { status: complete },
  publishing_phase: { status: complete, publish_status: 'published', publish_time: '2026-11-25T05:00:13+0000' },
};

function fixture(t: TestContext, scheduledAt = now, owner = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncflow-reel-'));
  const file = path.join(dir, 'test.sqlite');
  const key = 'b'.repeat(64);
  let db = new ClipFlowDb(file, key);
  const storage = new StorageService(dir);
  const channel = db.createChannel({ name: 'Local test' });
  const account = db.createAccount({
    channelId: channel.id, platform: 'FACEBOOK', accountName: 'Test Page',
    connectionMode: 'LIVE_OFFICIAL', externalAccountId: pageId, accessToken: credential,
  });
  const storageKey = 'fixture.mp4';
  fs.writeFileSync(storage.resolveLocalPath(storageKey), Buffer.alloc(100, 1));
  const asset = db.createMediaAsset({
    id: 'med_fb_fixture', channelId: channel.id, originalFilename: storageKey, storageProvider: 'LOCAL', storageKey,
    sourceMeta: { sourceApp: 'SyncCut Studio', episodeId: 'episode-test', exportId: 'export-test' },
    thumbnailPaths: [], mimeType: 'video/mp4', fileSizeBytes: 100, orientation: 'VERTICAL', clipCategory: 'SHORT',
    probe: {
      durationSec: 12, width: 720, height: 1280, rotation: 0, fps: 30, videoCodec: 'h264',
      audioCodec: 'aac', audioSampleRate: 48000, bitrateKbps: 1000, fileSizeBytes: 100, hasFaststartMoov: true,
    },
  });
  const options = {
    channelId: channel.id, mediaAssetId: asset.id, targetDate: '2026-11-25',
    masterBrief: { topic: 'Test', hook: '', summary: '', keyPoints: [], cta: '', coreHashtags: [], language: 'en' as const, tone: 'FRIENDLY' as const },
    platformMetadata: {},
    jobs: [{
      socialAccountId: account.id, platform: 'FACEBOOK' as const, format: 'FACEBOOK_REELS' as const,
      strategy: 'NATIVE_PREUPLOAD' as const, scheduledAt: scheduledAt.toISOString(), prewarmAt: null,
      metadataSnapshot: { title: 'Reel test', isAiGenerated: true },
    }],
  };
  const jobId = db.createContentWithJobs(options).jobs![0].id;
  let scheduler = new SchedulerEngine(db, storage, owner);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    jobId, options,
    get db() { return db; },
    get scheduler() { return scheduler; },
    get job() { return db.getJob(jobId)!; },
    restart() {
      db.close();
      db = new ClipFlowDb(file, key);
      scheduler = new SchedulerEngine(db, storage, owner);
    },
    async runNext() {
      const next = db.getJob(jobId)!.nextRetryAt;
      assert.ok(next, 'expected job to have a verification due time');
      await scheduler.tick(new Date(next));
    },
  };
}

function mockMeta(t: TestContext, handlers: {
  start?: () => Response;
  upload?: (init: RequestInit) => Response | Promise<Response>;
  finish?: (body: URLSearchParams) => Response;
  status?: () => Response;
}) {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.ok(['https://graph.facebook.com', 'https://rupload.facebook.com'].includes(url.origin));
    if (url.pathname.endsWith('/me')) {
      calls.push('identity');
      return Response.json({ id: pageId });
    }
    if (url.pathname.endsWith('/video_reels')) {
      assert.match(url.pathname, new RegExp('^/v(?:22|27)\\.0/' + pageId + '/video_reels$'));
      assert.equal(init.method, 'POST');
      const body = init.body as URLSearchParams;
      if (body.get('upload_phase') === 'start') {
        calls.push('start');
        return handlers.start?.() ?? Response.json({ video_id: videoId, upload_url: 'https://rupload.facebook.com/video-upload/v22.0/' + videoId });
      }
      assert.equal(body.get('upload_phase'), 'finish');
      assert.equal(body.get('video_id'), videoId);
      assert.equal(body.get('is_ai_generated'), 'true');
      calls.push('finish');
      return handlers.finish?.(body) ?? Response.json({ success: true });
    }
    if (url.host === 'rupload.facebook.com') {
      calls.push('upload');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('Authorization'), 'OAuth ' + credential);
      assert.equal(headers.get('file_size'), '100');
      return handlers.upload?.(init) ?? Response.json({ success: true });
    }
    assert.match(url.pathname, new RegExp('^/v(?:22|27)\\.0/' + videoId + '$'));
    assert.equal(init.method, undefined);
    if (url.searchParams.get('fields') === 'status') {
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ' + credential);
      calls.push('status');
      return handlers.status?.() ?? Response.json({ id: videoId, status: published }, { headers: { 'facebook-api-version': 'v27.0' } });
    }
    calls.push('metadata');
    return Response.json({ id: videoId, published: true, post_id: postId, permalink_url: '/reel/' + videoId + '/' });
  });
  return calls;
}

test('finish acknowledgement is pending until a separate GET confirms all publication evidence', async (t) => {
  const f = fixture(t);
  let checks = 0;
  const calls = mockMeta(t, {
    finish(body) {
      assert.equal(body.get('video_state'), 'PUBLISHED');
      return Response.json({ success: true });
    },
    status: () => ++checks === 1
      ? Response.json({ id: videoId, status: { video_status: 'processing', processing_phase: { status: 'in_progress' } } })
      : Response.json({ id: videoId, status: published }, { headers: { 'facebook-api-version': 'v27.0' } }),
  });
  await f.scheduler.tick(now);
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  assert.equal(f.job.externalPostId, null);
  assert.equal(f.job.externalUrl, null);
  assert.ok(f.job.facebookReel?.initializedAt);
  assert.ok(f.job.facebookReel?.uploadedAt);
  assert.ok(f.job.facebookReel?.finishAcceptedAt);
  assert.deepEqual(calls, ['identity', 'start', 'upload', 'finish']);
  await f.runNext();
  assert.equal(f.job.status, 'PROCESSING');
  await f.runNext();
  assert.equal(f.job.status, 'PUBLISHED');
  assert.equal(f.job.facebookReel?.effectiveGraphVersion, 'v27.0');
  assert.equal(f.job.facebookReel?.videoId, videoId);
  assert.equal(f.job.externalPostId, postId);
  assert.equal(f.job.externalUrl, 'https://www.facebook.com/reel/' + videoId + '/');
  assert.equal(f.job.facebookReel?.publishTime, '2026-11-25T05:00:13.000Z');
  assert.deepEqual(calls.slice(4), ['status', 'status', 'metadata']);
});

test('scheduled finish stays separate from publication when the clock reaches the scheduled time', async (t) => {
  const due = new Date(now.getTime() + 3600_000);
  const f = fixture(t, due);
  let ready = false;
  const calls = mockMeta(t, {
    finish(body) {
      assert.equal(body.get('video_state'), 'SCHEDULED');
      assert.equal(body.get('scheduled_publish_time'), String(due.getTime() / 1000));
      return Response.json({ success: true });
    },
    status: () => Response.json({ id: videoId, status: ready ? published : {
      ...published, publishing_phase: { status: complete, publish_status: 'scheduled' },
    } }),
  });
  await f.scheduler.tick(now);
  await f.runNext();
  assert.equal(f.job.status, 'NATIVE_SCHEDULED');
  await f.scheduler.tick(due);
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  ready = true;
  await f.runNext();
  assert.equal(f.job.status, 'PUBLISHED');
  assert.equal(calls.filter((c) => c === 'finish').length, 1);
});

test('HTTP 200 success:false, invalid JSON, and a timeout never repeat the finish POST', async (t) => {
  for (const result of ['false', 'broken', 'timeout']) await t.test(result, async (t) => {
    const f = fixture(t);
    const calls = mockMeta(t, {
      finish() {
        // A second worker sees the intent already written, before the HTTP call returns.
        assert.ok(f.job.facebookReel?.finishRequestedAt);
        assert.equal(f.db.claimSpecificJob(f.jobId, now.toISOString()), null);
        if (result === 'timeout') throw new DOMException('timed out', 'TimeoutError');
        if (result === 'broken') return new Response('not json', { status: 200 });
        return Response.json({ success: false });
      },
    });
    await f.scheduler.tick(now);
    assert.equal(f.job.status, 'PUBLISH_REQUESTED');
    assert.equal(f.job.facebookReel?.finishAcceptedAt, undefined);
    f.restart();
    await f.runNext();
    assert.equal(f.job.status, 'PUBLISHED');
    assert.deepEqual(calls, ['identity', 'start', 'upload', 'finish', 'status', 'metadata']);
  });
});

test('partial uploads resume at Meta’s offset after restart without starting a second session', async (t) => {
  const f = fixture(t);
  let uploads = 0;
  const calls = mockMeta(t, {
    upload(init) {
      const headers = new Headers(init.headers);
      if (++uploads === 1) {
        assert.equal(headers.get('offset'), '0');
        throw new DOMException('timed out', 'TimeoutError');
      }
      assert.equal(headers.get('offset'), '40');
      assert.equal((init.body as Buffer).length, 60);
      return Response.json({ success: true });
    },
    status: () => Response.json({ id: videoId, status: {
      video_status: 'uploading',
      uploading_phase: { status: 'in_progress', bytes_transferred: 40, source_file_size: 100 },
    } }),
  });
  await f.scheduler.tick(now);
  assert.equal(f.job.status, 'PROCESSING');
  f.restart();
  await f.runNext();
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  assert.deepEqual(calls, ['identity', 'start', 'upload', 'status', 'upload', 'finish']);
});

test('rate-limited verification honors Retry-After and stores redacted structured errors', async (t) => {
  const f = fixture(t);
  let checks = 0;
  const calls = mockMeta(t, {
    status: () => ++checks === 1
      ? Response.json({ error: { message: credential, code: 32, error_subcode: 99, fbtrace_id: 'TRACE_123' } }, {
          status: 429, headers: { 'retry-after': '120' },
        })
      : Response.json({ id: videoId, status: published }),
  });
  await f.scheduler.tick(now);
  const firstCheck = Date.parse(f.job.nextRetryAt!);
  await f.runNext();
  assert.ok(Date.parse(f.job.nextRetryAt!) - firstCheck >= 120_000);
  assert.equal(f.job.facebookReel?.lastApiError?.code, 32);
  assert.equal(f.job.facebookReel?.lastApiError?.subcode, 99);
  assert.equal(f.job.facebookReel?.lastApiError?.fbtraceId, 'TRACE_123');
  assert.doesNotMatch(JSON.stringify(f.db.listJobLogs(f.jobId)), new RegExp(credential));
  assert.doesNotMatch(JSON.stringify(f.job), new RegExp(credential));
  assert.equal(f.db.claimSpecificJob(f.jobId, new Date(firstCheck + 1000).toISOString()), null);
  await f.runNext();
  assert.equal(f.job.status, 'PUBLISHED');
  assert.equal(calls.filter((c) => c === 'finish').length, 1);
});

test('phase error is a confirmed failure and a timed-out verification ends in UNKNOWN', async (t) => {
  for (const scenario of ['failed', 'unknown']) await t.test(scenario, async (t) => {
    const f = fixture(t);
    const calls = mockMeta(t, {
      status: () => Response.json({
        id: videoId, status: scenario === 'failed'
          ? { video_status: 'processing', processing_phase: { status: 'error', error: { code: 123, error_subcode: 456, fbtrace_id: 'phaseTrace' } } }
          : { video_status: 'ready' },
      }),
    });
    await f.scheduler.tick(now);
    if (scenario === 'failed') {
      await f.runNext();
      assert.equal(f.job.status, 'FAILED');
      assert.equal(f.job.facebookReel?.lastApiError?.stage, 'processing');
      assert.equal(f.job.facebookReel?.lastApiError?.fbtraceId, 'phaseTrace');
    } else {
      await f.scheduler.tick(new Date(now.getTime() + 31 * 60_000));
      assert.equal(f.job.status, 'UNKNOWN');
      assert.equal(f.job.nextRetryAt, null);
      await f.scheduler.verifyFacebookReel(f.job.id, new Date(now.getTime() + 32 * 60_000));
      assert.equal(f.job.status, 'UNKNOWN');
    }
    assert.equal(calls.filter((call) => call === 'finish').length, 1);
    const app = createApp({ db: f.db, scheduler: f.scheduler, storage: new StorageService(os.tmpdir()) });
    const retry = await app.request('/api/jobs/' + f.jobId + '/retry', { method: 'POST' });
    assert.equal(retry.status, 409);
  });
});

test('legacy publication rows require a real GET and keep Video and Post IDs separate', async (t) => {
  const f = fixture(t);
  f.db.updateJob(f.jobId, {
    status: 'PUBLISHED', externalPostId: videoId, externalUrl: 'https://www.facebook.com/reel/' + videoId,
  });
  f.restart();
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  assert.equal(f.job.facebookReel?.videoId, videoId);
  assert.equal(f.job.externalPostId, null);
  const calls = mockMeta(t, {});
  await f.scheduler.tick(now);
  assert.deepEqual(calls, ['status', 'metadata']);
  assert.equal(f.job.status, 'PUBLISHED');
  assert.equal(f.job.externalPostId, postId);
});

test('an ambiguous start without a Video ID never issues upload or finish', async (t) => {
  const f = fixture(t);
  const calls = mockMeta(t, { start: () => { throw new DOMException('timed out', 'TimeoutError'); } });
  await f.scheduler.tick(now);
  assert.equal(f.job.status, 'UNKNOWN');
  assert.equal(f.job.facebookReel?.videoId, undefined);
  f.restart();
  await f.scheduler.runJobNow(f.jobId, new Date(now.getTime() + 10 * 60_000));
  assert.equal(f.job.status, 'UNKNOWN');
  assert.deepEqual(calls, ['identity', 'start']);
});


test('a repeated content submission for the same Reel slot preserves the original job', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.db.createContentWithJobs(f.options), /Facebook Reel/);
  const original = f.db.getMediaAsset(f.options.mediaAssetId)!;
  const reimported = f.db.createMediaAsset({ ...original, id: 'med_reimported' });
  assert.throws(() => f.db.createContentWithJobs({ ...f.options, mediaAssetId: reimported.id }), /Facebook Reel/);
  const otherSlot = {
    ...f.options,
    jobs: f.options.jobs.map((job) => ({
      ...job, scheduledAt: new Date(now.getTime() + 3600_000).toISOString(),
    })),
  };
  mockMeta(t, { finish: () => new Response('timeout', { status: 504 }) });
  await f.scheduler.tick(now);
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  assert.throws(() => f.db.createContentWithJobs(otherSlot), /Facebook Reel/);
  assert.equal(f.db.listJobs().length, 1);
});

test('a worker interrupted after writing finish intent recovers by GET only after lease expiry', async (t) => {
  const f = fixture(t);
  assert.ok(f.db.claimSpecificJob(f.jobId, now.toISOString()));
  f.db.updateJob(f.jobId, {
    status: 'PUBLISH_REQUESTED',
    facebookReel: {
      graphVersion: 'v22.0', pageId, videoId,
      uploadedAt: now.toISOString(),
      finishRequestedAt: now.toISOString(),
      verificationStartedAt: now.toISOString(),
    },
  });
  const calls = mockMeta(t, {});
  f.restart();
  await f.scheduler.tick(new Date(now.getTime() + 4 * 60_000));
  assert.deepEqual(calls, []);
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  await f.scheduler.tick(new Date(now.getTime() + 6 * 60_000));
  assert.deepEqual(calls, ['status', 'metadata']);
  assert.equal(f.job.status, 'PUBLISHED');
  assert.equal(f.job.externalPostId, postId);
  assert.equal(f.job.facebookReel?.finishAcceptedAt, undefined);
});

test('an interrupted worker with a durable upload checkpoint finishes the same Video ID once', async (t) => {
  const f = fixture(t);
  assert.ok(f.db.claimSpecificJob(f.jobId, now.toISOString()));
  f.db.updateJob(f.jobId, {
    status: 'UPLOADED',
    facebookReel: {
      graphVersion: 'v22.0', pageId, videoId,
      uploadUrl: 'https://rupload.facebook.com/video-upload/v22.0/' + videoId,
      uploadRequestedAt: now.toISOString(),
      uploadedAt: now.toISOString(),
    },
  });
  const calls = mockMeta(t, {
    finish(body) {
      assert.equal(body.get('video_state'), 'PUBLISHED');
      return new Response('', { status: 503 });
    },
  });
  f.restart();
  await f.scheduler.tick(new Date(now.getTime() + 6 * 60_000));
  assert.deepEqual(calls, ['finish']);
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  await f.runNext();
  assert.deepEqual(calls, ['finish', 'status', 'metadata']);
  assert.equal(f.job.status, 'PUBLISHED');
});

test('Run Now requests immediate publication and polls before the job’s old scheduled time', async (t) => {
  const f = fixture(t, new Date(now.getTime() + 3600_000));
  let visible = false;
  const calls = mockMeta(t, {
    finish(body) {
      assert.equal(body.get('video_state'), 'PUBLISHED');
      assert.equal(body.has('scheduled_publish_time'), false);
      return Response.json({ success: true });
    },
    status: () => Response.json({ id: videoId, status: visible ? published : {
      ...published, publishing_phase: { status: 'in_progress' },
    } }),
  });
  await f.scheduler.runJobNow(f.jobId, now);
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  await f.runNext();
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  visible = true;
  await f.runNext();
  assert.equal(f.job.status, 'PUBLISHED');
  assert.equal(calls.filter((c) => c === 'finish').length, 1);
});

test('a native job inside Meta’s ten-minute lead time waits until due before sending finish', async (t) => {
  const due = new Date(now.getTime() + 5 * 60_000);
  const f = fixture(t, due);
  const calls = mockMeta(t, {
    finish(body) {
      assert.equal(body.get('video_state'), 'PUBLISHED');
      assert.equal(body.has('scheduled_publish_time'), false);
      return Response.json({ success: true });
    },
  });
  await f.scheduler.tick(now);
  assert.equal(f.job.status, 'READY_TO_PUBLISH');
  assert.deepEqual(calls, []);
  await f.scheduler.tick(due);
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  await f.runNext();
  assert.equal(f.job.status, 'PUBLISHED');
  assert.deepEqual(calls, ['identity', 'start', 'upload', 'finish', 'status', 'metadata']);
});


test('a Railway-owned Facebook queue cannot dispatch or manually publish on the local worker', async (t) => {
  assert.deepEqual(facebookReelRuntime({}), { environment: 'local', owner: 'disabled', allowed: false });
  assert.equal(facebookReelRuntime({ RAILWAY_DEPLOYMENT_ID: 'test' }).allowed, false);
  assert.equal(facebookReelRuntime({ RAILWAY_DEPLOYMENT_ID: 'test', SYNCFLOW_FACEBOOK_REEL_OWNER: 'railway' }).allowed, true);
  assert.equal(facebookReelRuntime({ SYNCFLOW_FACEBOOK_REEL_OWNER: 'railway' }).allowed, false);
  assert.equal(facebookReelRuntime({ SYNCFLOW_FACEBOOK_REEL_OWNER: 'local' }).allowed, false);
  assert.equal(facebookReelRuntime({ RAILWAY_DEPLOYMENT_ID: 'test', SYNCFLOW_FACEBOOK_REEL_OWNER: 'disabled' }).allowed, false);
  const f = fixture(t, now, false);
  const calls = mockMeta(t, {});
  assert.equal((await f.scheduler.tick(now)).processed, 0);
  await assert.rejects(f.scheduler.runJobNow(f.jobId, now), /designated publisher/);
  assert.equal(f.job.status, 'QUEUED');
  assert.equal(f.job.lockedUntil, null);
  assert.deepEqual(calls, []);
});

test('diagnostics are read only and preserve false, zero, unknown, unavailable and failed', async (t) => {
  const f = fixture(t, now, false);
  f.db.updateJob(f.jobId, { status: 'PUBLISHED', facebookReel: { graphVersion: 'v22.0', pageId, videoId } });
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    assert.equal(init?.method, 'GET');
    const url = new URL(input);
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.match(url.pathname, /^\/v27\.0\//);
    const fields = url.searchParams.get('fields') ?? '';
    const metric = url.searchParams.get('metric') ?? '';
    calls.push(fields || metric);
    if (fields === 'status') return Response.json({ id: videoId, status: published });
    if (fields.includes('post_id')) return Response.json({ id: videoId, post_id: postId });
    if (fields.includes('promotion_eligible')) return Response.json({ id: pageId, promotion_eligible: true });
    if (fields.includes('is_eligible_for_promotion')) return Response.json({ id: pageId + '_' + postId, is_eligible_for_promotion: false });
    if (fields.includes('copyright_check')) return Response.json({ id: videoId, copyright_check_information: { status: { status: 'complete', matches_found: false } } });
    if (metric === 'fb_reels_total_plays') return Response.json({ data: [{ name: metric, period: 'lifetime', values: [{ value: 0 }] }] });
    if (metric === 'blue_reels_play_count') return Response.json({ error: { code: 200, message: credential } }, { status: 403 });
    if (metric === 'fb_reels_replay_count') throw new DOMException('Timed out', 'TimeoutError');
    return Response.json({ data: [] });
  });
  const app = createApp({ db: f.db, scheduler: f.scheduler, storage: new StorageService(os.tmpdir()) });
  const response = await app.request('/api/jobs/' + f.jobId + '/facebook-diagnostics');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.publication.value.outcome, 'published');
  assert.equal(body.postPromotion.value.eligible, false);
  assert.equal(body.copyright.value.matchesFound, false);
  assert.equal(body.metrics.plays.value.total, 0);
  assert.equal(body.metrics.initialPlays.state, 'unavailable');
  assert.equal(body.metrics.replays.state, 'failed');
  assert.equal(body.visibility.state, 'unknown');
  assert.equal(body.promotionReason.state, 'unsupported');
  assert.doesNotMatch(JSON.stringify(body), new RegExp(credential));
  assert.equal(f.job.facebookReel?.graphVersion, 'v22.0');
  assert.equal(calls.length, 12);
});

test('an upload that crosses the native cutoff keeps its Video ID and waits for the slot', async (t) => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const due = new Date(now.getTime() + 10 * 60_000 + 1_000);
  const f = fixture(t, due);
  const calls = mockMeta(t, {
    upload() {
      elapsed += 2_000;
      return Response.json({ success: true });
    },
    finish(body) {
      assert.equal(body.get('video_state'), 'PUBLISHED');
      assert.equal(body.has('scheduled_publish_time'), false);
      return Response.json({ success: true });
    },
  });
  await f.scheduler.tick(now);
  assert.equal(f.job.status, 'UPLOADED');
  assert.equal(f.job.nextRetryAt, due.toISOString());
  assert.deepEqual(calls, ['identity', 'start', 'upload']);
  await f.scheduler.tick(due);
  assert.equal(f.job.status, 'PUBLISH_REQUESTED');
  assert.deepEqual(calls, ['identity', 'start', 'upload', 'finish']);
});
