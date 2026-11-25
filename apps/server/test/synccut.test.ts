import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTENT_FORMATS,
  utf8ByteLength,
  validateFormatMetadata,
} from '@clipflow/shared';
import {
  extractBriefFromSyncCutEpisode,
  sanitizePromptTitle,
  stripCoverMarkdown,
} from '../src/services/synccut-bridge.js';
import { normalizeCoverImage } from '../src/services/media.js';
import { generateMetadataDeterministic } from '../src/services/metadata-engine.js';

describe('SyncCut Bridge Helpers & Metadata Extraction', () => {
  it('strips AI prompt noise cleanly from Thai and English titles', () => {
    assert.equal(
      sanitizePromptTitle(
        'ทำไมคนใต้ถึงชอบกรีดยาง จงแฝงสาระตามความจริง และความฮาด้วย'
      ),
      'ทำไมคนใต้ถึงชอบกรีดยาง'
    );
    assert.equal(
      sanitizePromptTitle(
        'จงค้นหาตำนานม้าเมืองทรอย และเล่าเรื่องให้น่าสนใจให้คนดูจนจบคลิป'
      ),
      'ตำนานม้าเมืองทรอย'
    );
    assert.equal(
      sanitizePromptTitle(
        'Create an exactly 15-second, photorealistic cinematic Japanese samurai duel, captured as one uninter…'
      ),
      'Japanese samurai duel'
    );
    assert.equal(stripCoverMarkdown('ทำไมต้อง *กรีดตีสอง*'), 'ทำไมต้อง กรีดตีสอง');
  });

  it('extracts MasterBrief with coverDesign, transcript, chapters, sources, and synthetic flags', () => {
    const ep = {
      id: 'ep-1',
      title: 'ทำไมคนใต้ถึงชอบกรีดยาง จงแฝงสาระตามความจริง และความฮาด้วย',
      sources: [
        { title: 'การยางแห่งประเทศไทย', url: 'https://www.raot.co.th' },
      ],
      shots: [
        { id: 's1', narration: 'ตีสองในขณะที่คนฝันหวาน ได้เวลาทำงานของชาวสวนยางแล้ว!', duration: 15 },
        { id: 's2', narration: 'น้ำยางไหลดีที่สุดช่วงเช้ามืดเพราะอากาศเย็นและความชื้นสูง', duration: 20 },
        { id: 's3', narration: 'แดดออกเมื่อไหร่ท่อน้ำยางจะเริ่มปิดตัวทันที', duration: 24 },
      ],
      delivery: {
        tags: '#Shorts #สาระน่ารู้',
        coverTime: 3.2,
        coverDesign: {
          enabled: true,
          kicker: 'ความลับ!',
          headline: 'ทำไมต้อง *กรีดตีสอง*',
          subline: 'เหตุผลที่คนเมืองไม่เคยรู้',
        },
      },
    };

    const brief = extractBriefFromSyncCutEpisode(ep, {
      id: 'exp-1',
      episodeId: 'ep-1',
      technicalQA: { actual: { duration: 59 } },
    });

    assert.equal(brief.coverKicker, 'ความลับ!');
    assert.equal(brief.coverHeadline, 'ทำไมต้อง กรีดตีสอง');
    assert.equal(brief.coverSubline, 'เหตุผลที่คนเมืองไม่เคยรู้');
    assert.equal(brief.topic, 'ทำไมต้อง กรีดตีสอง — เหตุผลที่คนเมืองไม่เคยรู้');
    assert.ok(brief.transcriptText?.includes('ตีสองในขณะที่คนฝันหวาน'));
    assert.ok(brief.timestampsText?.includes('00:00 '));
    assert.ok(brief.timestampsText?.includes('00:15 '));
    assert.equal(brief.coverTimestampMs, 3200);
    assert.equal(brief.isSyntheticMedia, true);
    assert.equal(brief.sources?.length, 1);
    assert.equal(brief.language, 'th');

    const generated = generateMetadataDeterministic({
      brief,
      formats: [...CONTENT_FORMATS],
      templates: [],
    });

    assert.equal(generated.TIKTOK?.isAigc, true);
    assert.equal(generated.TIKTOK?.coverTimestampMs, 3200);
    assert.equal(generated.INSTAGRAM_REELS?.thumbOffsetMs, 3200);
    assert.ok(
      generated.YOUTUBE_LONG?.description.includes('https://www.raot.co.th')
    );
    assert.ok(utf8ByteLength(generated.YOUTUBE_LONG?.description ?? '') <= 5000);

    for (const fmt of CONTENT_FORMATS) {
      const issues = validateFormatMetadata(
        fmt,
        generated[fmt] as Record<string, unknown>
      );
      const errs = issues.filter((i) => i.severity === 'error');
      assert.equal(errs.length, 0, `${fmt}: ${JSON.stringify(errs)}`);
    }
  });

  it('normalizes cover PNG into JPEG <= 1.8 MB via FFmpeg', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncflow-cov-'));
    try {
      const pngPath = path.join(tmpDir, 'cover.png');
      const jpgPath = path.join(tmpDir, 'custom_cover.jpg');
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=#1e293b:s=720x1280',
          '-frames:v',
          '1',
          pngPath,
        ],
        { stdio: 'pipe' }
      );
      const res = await normalizeCoverImage(pngPath, jpgPath);
      assert.ok(fs.existsSync(res.outputPath));
      assert.ok(res.sizeBytes > 0 && res.sizeBytes <= 1_800_000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exempts stylized stickman3d animation from AI disclosure and sets YouTube Education category', () => {
    const ep = {
      id: 'ep-stickman',
      title: 'ทำไมขอบเหรียญมีรอยหยัก? — คำตอบเกี่ยวกับ ไอแซก นิวตัน',
      production: { visualStyle: 'stickman3d' },
      shots: [{ id: 's1', narration: 'เหรียญถูกเล็ม ดูออกยังไง?', duration: 7 }],
      delivery: { tags: '#ความรู้ #ประวัติศาสตร์' },
    };
    const brief = extractBriefFromSyncCutEpisode(ep, {
      id: 'exp-2',
      episodeId: 'ep-stickman',
      technicalQA: { actual: { duration: 45 } },
    });
    assert.equal(brief.isSyntheticMedia, false);
    assert.equal(brief.cta, '');

    const generated = generateMetadataDeterministic({
      brief,
      formats: [...CONTENT_FORMATS],
      templates: [],
    });
    assert.equal(generated.YOUTUBE_SHORTS?.categoryId, '27');
    assert.equal(generated.YOUTUBE_SHORTS?.containsSyntheticMedia, false);
    assert.equal(generated.TIKTOK?.isAigc, false);
    assert.equal(generated.INSTAGRAM_REELS?.isAiGenerated, false);
    assert.equal(generated.FACEBOOK_REELS?.isAiGenerated, false);
    for (const fmt of CONTENT_FORMATS) {
      const issues = validateFormatMetadata(
        fmt,
        generated[fmt] as Record<string, unknown>
      );
      assert.equal(
        issues.length,
        0,
        `${fmt}: ${JSON.stringify(issues)}`
      );
    }
  });

  it('marks photoreal episodes as requiring AI disclosure across all 4 platforms', () => {
    const ep = {
      id: 'ep-photoreal',
      title: 'จำลองเหตุการณ์ภูเขาไฟปะทุ',
      production: { visualStyle: 'photoreal' },
      shots: [{ id: 's1', narration: 'แรงสั่นสะเทือนใต้พิภพ', duration: 8 }],
      delivery: { tags: '#สารคดี #วิทยาศาสตร์' },
    };
    const brief = extractBriefFromSyncCutEpisode(ep);
    assert.equal(brief.isSyntheticMedia, true);

    const generated = generateMetadataDeterministic({
      brief,
      formats: [...CONTENT_FORMATS],
      templates: [],
    });
    assert.equal(generated.YOUTUBE_SHORTS?.containsSyntheticMedia, true);
    assert.equal(generated.TIKTOK?.isAigc, true);
    assert.equal(generated.INSTAGRAM_REELS?.isAiGenerated, true);
    assert.equal(generated.FACEBOOK_REELS?.isAiGenerated, true);
  });

  it('flags hashtag stuffing, cross-platform tag leaks, and spam tags with warnings', () => {
    const ttIssues = validateFormatMetadata('TIKTOK', {
      caption: 'ทดสอบ #Shorts #fyp #one #two #three #four',
      privacyLevel: 'PUBLIC_TO_EVERYONE',
    });
    const codes = new Set(ttIssues.map((i) => i.code));
    assert.ok(codes.has('HASHTAG_STUFFING_RISK'));
    assert.ok(codes.has('CROSS_PLATFORM_TAG_LEAK'));
    assert.ok(codes.has('SPAM_HASHTAG_RISK'));
  });
});
