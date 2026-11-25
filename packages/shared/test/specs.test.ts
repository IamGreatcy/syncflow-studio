import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThailandScheduleRulesForAccounts,
  calculateYouTubeTagsLength,
  computeTikTokChunkPlan,
  detectRecommendedFormats,
  determinePublishStrategy,
  extractHashtags,
  getLocalTodayDateStr,
  getNextDayDateStr,
  resolveScheduledTimesForDate,
  utf8ByteLength,
  validateFormatMetadata,
  zonedDateTimeToUtcIso,
  type MediaProbeInfo,
  type ScheduleRule,
  type SocialAccount,
} from '../src/index.js';

describe('TikTok FILE_UPLOAD chunk planner (floor division spec)', () => {
  const sizes = [
    2_000_000,
    5_000_000,
    7_500_000,
    12_067_811,
    12_345_678,
    64_000_000,
    130_000_000,
    500_000_000,
  ];

  for (const size of sizes) {
    it(`produces valid contiguous chunks for ${size} bytes`, () => {
      const plan = computeTikTokChunkPlan(size);
      assert.ok(plan.totalChunkCount >= 1);
      assert.ok(plan.totalChunkCount <= 1000);
      assert.equal(plan.chunks.length, plan.totalChunkCount);

      if (plan.totalChunkCount === 1) {
        assert.equal(plan.chunkSize, size);
        assert.equal(plan.chunks[0].size, size);
      } else {
        assert.ok(plan.chunkSize >= 5_000_000 && plan.chunkSize <= 64_000_000);
        assert.equal(
          plan.totalChunkCount,
          Math.floor(size / plan.chunkSize),
          'MUST use Math.floor(videoSize / chunkSize)'
        );
        for (let i = 0; i < plan.chunks.length - 1; i++) {
          assert.equal(plan.chunks[i].size, plan.chunkSize);
        }
      }

      // Contiguous from 0 to size - 1
      let expectedStart = 0;
      let sum = 0;
      for (const ch of plan.chunks) {
        assert.equal(ch.start, expectedStart);
        assert.equal(ch.size, ch.end - ch.start + 1);
        expectedStart = ch.end + 1;
        sum += ch.size;
      }
      assert.equal(sum, size);
      const lastChunk = plan.chunks[plan.chunks.length - 1];
      assert.ok(
        lastChunk.size <= 128_000_000,
        'Final trailing chunk must be <= 128 MB'
      );
    });
  }

  it('splits >64 MB videos into >=2 chunks even with large preferredChunkBytes', () => {
    const plan = computeTikTokChunkPlan(80_000_000, 50_000_000);
    assert.ok(plan.totalChunkCount >= 2);
    assert.ok(plan.chunkSize >= 5_000_000 && plan.chunkSize <= 64_000_000);
    assert.equal(plan.chunks.reduce((acc, ch) => acc + ch.size, 0), 80_000_000);
  });
});

describe('Platform metadata & UTF-8 byte / limit validation', () => {
  it('detects Thai UTF-8 byte overflow on YouTube description even when char count < 2000', () => {
    const thaiText = 'ก'.repeat(1800); // 1800 chars = 5400 UTF-8 bytes
    assert.equal(thaiText.length, 1800);
    assert.equal(utf8ByteLength(thaiText), 5400);

    const issues = validateFormatMetadata('YOUTUBE_LONG', {
      title: 'คลิปทดสอบภาษาไทย',
      description: thaiText,
      tags: ['test'],
    });
    assert.ok(issues.some((i) => i.code === 'DESCRIPTION_TOO_LONG_BYTES'));
  });

  it('rejects < and > in YouTube title and checks 500-char tag budget with multi-word quotes', () => {
    assert.equal(
      calculateYouTubeTagsLength(['foo bar', 'baz']),
      9 + 1 + 3 // "foo bar" (7+2=9) + comma (1) + baz (3)
    );

    const issues = validateFormatMetadata('YOUTUBE_SHORTS', {
      title: 'Bad <Title>',
      description: 'ok',
      tags: Array.from({ length: 60 }, (_, i) => `tag item ${i}`),
    });
    assert.ok(issues.some((i) => i.code === 'TITLE_INVALID_CHARS'));
    assert.ok(issues.some((i) => i.code === 'TAGS_TOO_LONG'));
  });

  it('enforces Instagram 30 hashtag & 2200 char rules and FB Reels 90s limit', () => {
    const tooManyTags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    const igIssues = validateFormatMetadata('INSTAGRAM_REELS', {
      caption: tooManyTags,
      shareToFeed: true,
      thumbOffsetMs: 0,
    });
    assert.ok(igIssues.some((i) => i.code === 'IG_TOO_MANY_HASHTAGS'));

    // Thai hashtags with Unicode combining vowels & tone marks (\p{M}) must stay intact
    assert.deepEqual(
      extractHashtags('ความรู้เกษตร #กรีดยาง #สวนยางพารา #ความรู้เกษตร'),
      ['#กรีดยาง', '#สวนยางพารา', '#ความรู้เกษตร']
    );

    const longProbe: MediaProbeInfo = {
      durationSec: 120,
      width: 1080,
      height: 1920,
      rotation: 0,
      fps: 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioSampleRate: 48000,
      bitrateKbps: 4000,
      fileSizeBytes: 25_000_000,
      hasFaststartMoov: true,
    };
    const fbReelsIssues = validateFormatMetadata(
      'FACEBOOK_REELS',
      { title: 'Too long reel', description: 'desc' },
      longProbe
    );
    assert.ok(fbReelsIssues.some((i) => i.code === 'DURATION_TOO_LONG'));
  });

  it('auto-detects YouTube Shorts up to 180s vertical/square vs Long for >180s or horizontal', () => {
    const shortVert: MediaProbeInfo = {
      durationSec: 150,
      width: 1080,
      height: 1920,
      rotation: 0,
      fps: 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioSampleRate: 48000,
      bitrateKbps: 3000,
      fileSizeBytes: 20_000_000,
      hasFaststartMoov: true,
    };
    const rec1 = detectRecommendedFormats(shortVert);
    assert.equal(rec1.orientation, 'VERTICAL');
    assert.ok(rec1.recommendedFormats.includes('YOUTUBE_SHORTS'));
    assert.ok(rec1.recommendedFormats.includes('FACEBOOK_VIDEO')); // > 90s uses FB Page Video

    const longHoriz: MediaProbeInfo = { ...shortVert, durationSec: 300, width: 1920, height: 1080 };
    const rec2 = detectRecommendedFormats(longHoriz);
    assert.equal(rec2.orientation, 'HORIZONTAL');
    assert.ok(rec2.recommendedFormats.includes('YOUTUBE_LONG'));
  });
});

describe('Schedule resolver & Hybrid publishing strategy', () => {
  it('converts Asia/Bangkok (+07:00) local time to exact UTC ISO', () => {
    const iso = zonedDateTimeToUtcIso('2026-12-01', '18:30', 'Asia/Bangkok');
    assert.equal(iso, '2026-12-01T11:30:00.000Z');
  });

  it('resolves differentiated per-platform times for weekday vs weekend and selects best strategy', () => {
    const accounts: SocialAccount[] = [
      {
        id: 'acc_yt',
        channelId: 'ch1',
        platform: 'YOUTUBE',
        accountName: 'YT',
        externalAccountId: 'uc1',
        connectionMode: 'SIMULATION',
        config: {},
        hasAccessToken: false,
        hasRefreshToken: false,
        tokenExpiresAt: null,
        creatorInfo: null,
        status: 'CONNECTED',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'acc_tt',
        channelId: 'ch1',
        platform: 'TIKTOK',
        accountName: 'TT',
        externalAccountId: '@tt',
        connectionMode: 'SIMULATION',
        config: { tiktokMode: 'DIRECT_POST' },
        hasAccessToken: false,
        hasRefreshToken: false,
        tokenExpiresAt: null,
        creatorInfo: null,
        status: 'CONNECTED',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'acc_ig',
        channelId: 'ch1',
        platform: 'INSTAGRAM',
        accountName: 'IG',
        externalAccountId: 'ig1',
        connectionMode: 'SIMULATION',
        config: {},
        hasAccessToken: false,
        hasRefreshToken: false,
        tokenExpiresAt: null,
        creatorInfo: null,
        status: 'CONNECTED',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'acc_fb',
        channelId: 'ch1',
        platform: 'FACEBOOK',
        accountName: 'FB',
        externalAccountId: 'fb1',
        connectionMode: 'SIMULATION',
        config: {},
        hasAccessToken: false,
        hasRefreshToken: false,
        tokenExpiresAt: null,
        creatorInfo: null,
        status: 'CONNECTED',
        createdAt: '',
        updatedAt: '',
      },
    ];

    // Tuesday 2026-12-01 (dow=2), Saturday 2026-12-05 (dow=6)
    const rules: ScheduleRule[] = [
      { id: 'r1', channelId: 'ch1', socialAccountId: 'acc_yt', dayOfWeek: 2, clipType: 'ANY', slotOrder: 1, localTime: '18:00', isActive: true, createdAt: '' },
      { id: 'r2', channelId: 'ch1', socialAccountId: 'acc_tt', dayOfWeek: 2, clipType: 'ANY', slotOrder: 1, localTime: '19:30', isActive: true, createdAt: '' },
      { id: 'r3', channelId: 'ch1', socialAccountId: 'acc_ig', dayOfWeek: 2, clipType: 'ANY', slotOrder: 1, localTime: '20:00', isActive: true, createdAt: '' },
      { id: 'r4', channelId: 'ch1', socialAccountId: 'acc_fb', dayOfWeek: 2, clipType: 'ANY', slotOrder: 1, localTime: '18:30', isActive: true, createdAt: '' },
      { id: 'r5', channelId: 'ch1', socialAccountId: 'acc_yt', dayOfWeek: 6, clipType: 'ANY', slotOrder: 1, localTime: '11:00', isActive: true, createdAt: '' },
      { id: 'r6', channelId: 'ch1', socialAccountId: 'acc_tt', dayOfWeek: 6, clipType: 'ANY', slotOrder: 1, localTime: '12:30', isActive: true, createdAt: '' },
    ];

    const now = new Date('2026-11-25T10:00:00.000Z');
    const tueSlots = resolveScheduledTimesForDate({
      dateStr: '2026-12-01',
      timezone: 'Asia/Bangkok',
      rules,
      accounts,
      clipCategory: 'SHORT',
      now,
    });
    const satSlots = resolveScheduledTimesForDate({
      dateStr: '2026-12-05',
      timezone: 'Asia/Bangkok',
      rules,
      accounts,
      clipCategory: 'SHORT',
      now,
    });

    assert.equal(tueSlots.find((s) => s.platform === 'YOUTUBE')?.localTime, '18:00');
    assert.equal(tueSlots.find((s) => s.platform === 'YOUTUBE')?.strategy, 'NATIVE_PREUPLOAD');
    assert.equal(tueSlots.find((s) => s.platform === 'FACEBOOK')?.strategy, 'NATIVE_PREUPLOAD');
    assert.equal(tueSlots.find((s) => s.platform === 'INSTAGRAM')?.strategy, 'JIT_PUBLISH');
    assert.equal(tueSlots.find((s) => s.platform === 'TIKTOK')?.strategy, 'JIT_PUBLISH');

    assert.equal(satSlots.find((s) => s.platform === 'YOUTUBE')?.localTime, '11:00');
    assert.equal(satSlots.find((s) => s.platform === 'TIKTOK')?.localTime, '12:30');

    // Verify TikTok INBOX_DRAFT mode
    const ttDraftStrat = determinePublishStrategy(
      'TIKTOK',
      '2026-12-01T12:30:00.000Z',
      { connectionMode: 'SIMULATION', config: { tiktokMode: 'INBOX_DRAFT' } },
      now
    );
    assert.equal(ttDraftStrat, 'INBOX_DRAFT');
  });

  it('builds Thailand optimal prime-time schedule with Shorts/Reels vs Long-form differentiation', () => {
    const accs = [
      { id: 'yt1', platform: 'YOUTUBE' as const },
      { id: 'fb1', platform: 'FACEBOOK' as const },
      { id: 'tt1', platform: 'TIKTOK' as const },
      { id: 'ig1', platform: 'INSTAGRAM' as const },
    ];
    const generated = buildThailandScheduleRulesForAccounts(accs);
    assert.equal(generated.length, 42);

    const sunShortYt = generated.find(
      (r) => r.socialAccountId === 'yt1' && r.dayOfWeek === 0 && r.clipType === 'ANY'
    );
    const sunLongYt = generated.find(
      (r) => r.socialAccountId === 'yt1' && r.dayOfWeek === 0 && r.clipType === 'LONG'
    );
    assert.equal(sunShortYt?.localTime, '12:00');
    assert.equal(sunLongYt?.localTime, '09:30');

    const tueIg = generated.find(
      (r) => r.socialAccountId === 'ig1' && r.dayOfWeek === 2
    );
    assert.equal(tueIg?.localTime, '12:30');
  });

  it('auto-advances past slots for today to the next future rule slot instead of returning a past timestamp', () => {
    const accounts: SocialAccount[] = [
      { id: 'acc_yt', channelId: 'ch1', platform: 'YOUTUBE', accountName: 'YT', connectionMode: 'SIMULATION', status: 'CONNECTED', createdAt: '' },
      { id: 'acc_tt', channelId: 'ch1', platform: 'TIKTOK', accountName: 'TT', connectionMode: 'SIMULATION', status: 'CONNECTED', createdAt: '' },
      { id: 'acc_ig', channelId: 'ch1', platform: 'INSTAGRAM', accountName: 'IG', connectionMode: 'SIMULATION', status: 'CONNECTED', createdAt: '' },
      { id: 'acc_fb', channelId: 'ch1', platform: 'FACEBOOK', accountName: 'FB', connectionMode: 'SIMULATION', status: 'CONNECTED', createdAt: '' },
    ];
    const generated = buildThailandScheduleRulesForAccounts(accounts);
    const rules: ScheduleRule[] = generated.map((g, idx) => ({
      id: `r_${idx}`,
      channelId: 'ch1',
      socialAccountId: g.socialAccountId,
      dayOfWeek: g.dayOfWeek,
      clipType: g.clipType,
      slotOrder: g.slotOrder,
      localTime: g.localTime,
      isActive: g.isActive,
      createdAt: '',
    }));

    // Exact Friday 2026-11-20 12:23 Asia/Bangkok (05:23:00Z):
    // FB Friday primary rule is 11:30 (53 mins in the past), whereas YT (16:30), TT (17:30), IG (18:30) are still in the future.
    const now = new Date('2026-11-20T05:23:00.000Z');
    const slots = resolveScheduledTimesForDate({
      dateStr: '2026-11-20',
      timezone: 'Asia/Bangkok',
      rules,
      accounts,
      clipCategory: 'SHORT',
      now,
      minLeadMinutes: 2,
    });

    const fbSlot = slots.find((s) => s.platform === 'FACEBOOK')!;
    assert.equal(fbSlot.wasPastSlot, true);
    assert.equal(fbSlot.nominalLocalTime, '11:30');
    assert.equal(fbSlot.targetDate, '2026-11-21');
    assert.equal(fbSlot.localTime, '10:30'); // Saturday FB slot
    assert.equal(fbSlot.strategy, 'NATIVE_PREUPLOAD');
    assert.ok(new Date(fbSlot.scheduledAtIso).getTime() > now.getTime());

    const ytSlot = slots.find((s) => s.platform === 'YOUTUBE')!;
    assert.equal(ytSlot.wasPastSlot, false);
    assert.equal(ytSlot.targetDate, '2026-11-20');
    assert.equal(ytSlot.localTime, '16:30');
    assert.equal(ytSlot.strategy, 'NATIVE_PREUPLOAD');

    // When autoAdvancePastSlots is false, still flags wasPastSlot=true on requested date
    const rawSlots = resolveScheduledTimesForDate({
      dateStr: '2026-11-20',
      timezone: 'Asia/Bangkok',
      rules,
      accounts,
      clipCategory: 'SHORT',
      now,
      autoAdvancePastSlots: false,
    });
    const rawFb = rawSlots.find((s) => s.platform === 'FACEBOOK')!;
    assert.equal(rawFb.wasPastSlot, true);
    assert.equal(rawFb.targetDate, '2026-11-20');
    assert.equal(rawFb.localTime, '11:30');
  });

  it('computes channel-local today and next-day default without UTC off-by-one', () => {
    // 2026-11-24T20:26:00Z == 2026-11-25 03:26 in Asia/Bangkok
    const lateNightUtc = new Date('2026-11-24T20:26:00.000Z');
    assert.equal(getLocalTodayDateStr('Asia/Bangkok', lateNightUtc), '2026-11-25');
    assert.equal(getNextDayDateStr('Asia/Bangkok', lateNightUtc), '2026-11-26');
  });
});
