import {
  calculateYouTubeTagsLength,
  extractHashtags,
  truncateUtf8Bytes,
  type ContentFormat,
  type FacebookReelsMetadata,
  type FacebookVideoMetadata,
  type InstagramReelsMetadata,
  type MasterBrief,
  type MediaProbeInfo,
  type MetadataTemplate,
  type PlatformMetadataMap,
  type TikTokMetadata,
  type YouTubeMetadata,
} from '@clipflow/shared';
import type { AppSettingsFull } from '../db/database.js';

function cleanNoAngleBrackets(str: string): string {
  return str.replace(/[<>]/g, '').trim();
}

function normalizeHashtag(tag: string): string {
  const cleaned = tag.trim().replace(/\s+/g, '');
  if (!cleaned) return '';
  return cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const norm = item.trim();
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function packYouTubeTags(candidates: string[], maxChars = 490): string[] {
  const result: string[] = [];
  for (const raw of dedupeStrings(candidates)) {
    const clean = cleanNoAngleBrackets(raw.replace(/^#/, ''));
    if (!clean) continue;
    const trial = [...result, clean];
    if (calculateYouTubeTagsLength(trial) <= maxChars) {
      result.push(clean);
    } else {
      break;
    }
  }
  return result;
}

function clampString(str: string, maxChars: number): string {
  const s = str.trim();
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, Math.max(0, maxChars - 1));
  // Prefer breaking at last whitespace if it doesn't shrink excessively
  const lastSpace = slice.lastIndexOf(' ');
  const cleanCut =
    lastSpace >= Math.floor(maxChars * 0.55) ? slice.slice(0, lastSpace) : slice;
  return `${cleanCut.trimEnd()}…`;
}

/**
 * Ensures short-form overlay captions (TikTok, IG Reels, FB Reels) stay compact (2-3 tight lines)
 * so they remain readable above the "...more" fold and never cover the lower third of vertical video.
 */
function compactShortOverlayCaption(params: {
  rawText: string;
  format: ContentFormat;
  maxTotalChars: number;
  maxHashtags: number;
}): string {
  const cleaned = sanitizeCaptionForFormat(
    params.rawText,
    params.format,
    params.maxHashtags
  );
  const rawTags = extractHashtags(cleaned).slice(0, params.maxHashtags);
  const tagLine = rawTags.join(' ');
  const bodyWithoutTags = cleaned
    .replace(/(^|\s)#[^\s#]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n');

  if (!tagLine) {
    return clampString(bodyWithoutTags, params.maxTotalChars);
  }

  const separator = '\n';
  const maxBodyChars = Math.max(
    40,
    params.maxTotalChars - tagLine.length - separator.length
  );
  const compactBody = clampString(bodyWithoutTags, maxBodyChars);
  return compactBody ? `${compactBody}${separator}${tagLine}` : tagLine;
}

const GENERIC_SPAM_HASHTAGS = new Set([
  '#fyp',
  '#foryou',
  '#foryoupage',
  '#viral',
  '#trending',
  '#explore',
  '#explorepage',
  '#reels',
  '#reelsinstagram',
  '#instagramreels',
  '#reelsthailand',
  '#tiktok',
  '#tiktokthailand',
  '#fb',
  '#facebookreels',
  '#video',
  '#คลิปสั้น',
]);

function filterHashtagsForFormat(
  candidates: string[],
  format: ContentFormat,
  maxCount: number
): string[] {
  const blocked = new Set(GENERIC_SPAM_HASHTAGS);
  if (format !== 'YOUTUBE_SHORTS') {
    blocked.add('#shorts');
  }
  const normalized = dedupeStrings(candidates.map(normalizeHashtag)).filter(
    (tag) => tag.length > 1 && !blocked.has(tag.toLowerCase())
  );
  if (format === 'YOUTUBE_SHORTS' && !normalized.some((t) => t.toLowerCase() === '#shorts')) {
    normalized.unshift('#Shorts');
  }
  return normalized.slice(0, maxCount);
}

function buildHashtagLine(
  format: ContentFormat,
  briefTags: string[],
  templateTags: string[],
  extraTags: string[],
  maxCount: number
): string {
  return filterHashtagsForFormat(
    [...briefTags, ...templateTags, ...extraTags],
    format,
    maxCount
  ).join(' ');
}

function buildLongTailTags(params: {
  topic: string;
  coverTitlePart: string;
  keyPoints: string[];
  briefHashtags: string[];
  templateTags: string[];
  isShort: boolean;
}): string[] {
  const keyPhrases = params.keyPoints.flatMap((p) =>
    p
      .split(/[,/|—–-]+|\s{2,}/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4 && s.length <= 36)
  );
  const raw = [
    params.topic.length <= 45 ? params.topic : params.topic.split(/[—–|]/)[0]?.trim() || '',
    params.coverTitlePart,
    ...keyPhrases,
    ...params.briefHashtags.map((t) => t.replace(/^#/, '')),
    ...params.templateTags,
    params.isShort ? 'youtube shorts' : '',
  ].filter(Boolean);
  return packYouTubeTags(raw);
}

function sanitizeCaptionForFormat(
  rawText: string,
  format: ContentFormat,
  maxHashtags: number
): string {
  // Remove legacy IG dot-spacer blocks ("...\n.\n.\n")
  let text = rawText.replace(/\n\s*\.\s*\n\s*\.\s*/g, '\n\n').trim();
  const blocked = new Set(GENERIC_SPAM_HASHTAGS);
  if (format !== 'YOUTUBE_SHORTS') {
    blocked.add('#shorts');
  }
  const tags = extractHashtags(text);
  const keepSet = new Set<string>();
  const dropSet = new Set<string>();
  for (const t of tags) {
    const lower = t.toLowerCase();
    if (blocked.has(lower)) {
      dropSet.add(lower);
    } else if (keepSet.size < maxHashtags) {
      keepSet.add(lower);
    } else {
      dropSet.add(lower);
    }
  }
  if (dropSet.size > 0) {
    text = text
      .split(/(\s+)/)
      .filter((tok) => !tok.startsWith('#') || !dropSet.has(tok.toLowerCase()))
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return text;
}

export function inferYouTubeCategoryId(
  brief: MasterBrief,
  tpl?: MetadataTemplate
): string {
  const tplCat = tpl?.platformDefaults?.categoryId;
  if (typeof tplCat === 'string' && /^\d{1,2}$/.test(tplCat.trim())) {
    return tplCat.trim();
  }
  const sample = `${brief.topic} ${brief.hook} ${brief.summary}`;
  if (
    brief.tone === 'EDUCATIONAL' ||
    /ทำไม|ความลับ|ประวัติ|ตำนาน|รู้หรือไม่|รู้ไหม|ที่มา|วิทยาศาสตร์|จิตวิทยา|ความจริง|อธิบาย|เจาะลึก|สาระ|ความรู้|\b(?:why|history|science|explained|origin|fact|psychology|how\s+it\s+works)\b/iu.test(
      sample
    )
  ) {
    return '27';
  }
  if (
    brief.tone === 'ENTERTAINING' ||
    /ถ้าคุณ|สมมติ|มนุษย์คนสุดท้าย|นิยาย|เรื่องสั้น|ผจญภัย/iu.test(sample)
  ) {
    return '24';
  }
  return '22';
}

function pickContextualEngagementCta(
  topic: string,
  format: ContentFormat,
  language: MasterBrief['language']
): string {
  const seed = `${topic}:${format}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const thPool: Record<ContentFormat, string[]> = {
    YOUTUBE_SHORTS: [
      'คิดยังไงกับเรื่องนี้ คอมเมนต์แลกเปลี่ยนกันครับ',
      'เพิ่งรู้เหมือนกันไหม? กดติดตามไว้มีอีกหลายตอน!',
      'เรื่องนี้จริงหรือหลอกในมุมคุณ มาคุยกันในคอมเมนต์',
      'อยากให้เจาะเรื่องไหนต่อ พิมพ์ไว้ใต้คลิปได้เลยครับ',
      'ชอบเล่าเรื่องแบบนี้ กดติดตามช่องไว้เลย!',
    ],
    YOUTUBE_LONG: [
      'คิดเห็นยังไงกับประเด็นนี้ คอมเมนต์คุยกันและฝากกด Subscribe ด้วยนะครับ',
      'มีข้อมูลเสริมหรือเรื่องคล้ายกัน แชร์ไว้ในคอมเมนต์ได้เลยครับ',
      'อยากให้เจาะลึกเรื่องไหนเป็นตอนต่อไป คอมเมนต์บอกได้เลยครับ',
      'หากชอบคลิปแนวไขข้อสงสัยแบบนี้ ฝากกดติดตามไว้ด้วยนะครับ',
      'คุณเคยได้ยินตำนานเรื่องนี้ในเวอร์ชันไหนบ้าง มาคุยกันครับ',
    ],
    TIKTOK: [
      'เพิ่งรู้เหมือนกันไหม? คอมเมนต์คุยกัน 👇',
      'เรื่องนี้คุณว่าจริงหรือมั่ว? เมนต์บอกหน่อย 👇',
      'เซฟไว้กันลืม หรือแท็กเพื่อนมาดูด้วยกัน 👇',
      'เคยสงสัยเรื่องนี้เหมือนกันไหมครับ?',
      'อยากให้ไขความลับเรื่องไหนต่อ พิมพ์ไว้เลย 👇',
    ],
    INSTAGRAM_REELS: [
      'เซฟเก็บไว้หรือส่งต่อให้เพื่อนที่ชอบเรื่องนี้!',
      'เคยรู้มาก่อนไหม? แชร์มุมมองในคอมเมนต์ได้เลย',
      'ส่งให้เพื่อนสายเกร็ดความรู้ดูด้วยกันเลย',
      'เรื่องนี้เกินคาดเหมือนกันไหม คอมเมนต์บอกหน่อย!',
      'กด Save เก็บไว้ดูซ้ำได้เลยครับ',
    ],
    FACEBOOK_REELS: [
      'คิดเห็นยังไง คอมเมนต์คุยกันครับ!',
      'เคยได้ยินเรื่องนี้มาก่อนไหม แชร์ให้เพื่อนรู้ด้วยเลย',
      'จริงหรือไม่ในมุมคุณ มาคุยกันในคอมเมนต์ครับ',
      'รู้แล้วอึ้งเหมือนกันไหมครับ คอมเมนต์บอกกันหน่อย',
      'อยากให้เล่าเรื่องไหนต่อ พิมพ์ไว้ใต้คลิปได้เลยครับ',
    ],
    FACEBOOK_VIDEO: [
      'เห็นด้วยไหมครับ คอมเมนต์คุยกันหรือแชร์ต่อได้เลย!',
      'คุณคิดยังไงกับเรื่องราวนี้ มาร่วมแลกเปลี่ยนกันในคอมเมนต์ครับ',
      'หากมีข้อมูลเพิ่มเติมหรืออยากให้ทำตอนไหนต่อ คอมเมนต์บอกได้เลยครับ',
      'แชร์คลิปนี้เก็บไว้ดูหรือส่งต่อให้เพื่อนที่สนใจได้เลยครับ',
      'เคยเจอเรื่องราวคล้ายกันไหมครับ เล่าสู่กันฟังได้นะครับ',
    ],
  };
  const enPool: Record<ContentFormat, string[]> = {
    YOUTUBE_SHORTS: [
      'Did you know this before? Comment below!',
      'What do you think? Let’s discuss in the comments!',
      'Subscribe for more hidden stories & origins!',
      'Which mystery should we cover next?',
      'Surprising right? Drop your thoughts below!',
    ],
    YOUTUBE_LONG: [
      'What are your thoughts on this story? Comment & subscribe!',
      'Did anything surprise you here? Share in the comments!',
      'Suggest the next topic in the comments below!',
      'Subscribe for deeper breakdowns every week!',
      'Have you heard a different version of this? Let us know!',
    ],
    TIKTOK: [
      'Did you know this? Comment below 👇',
      'Fact or myth in your view? Tell us 👇',
      'Save this for later or send to a friend 👇',
      'Ever wondered why? Drop a comment 👇',
      'What should we explain next? 👇',
    ],
    INSTAGRAM_REELS: [
      'Save & share with someone who loves trivia!',
      'Did you already know this? Tell us below!',
      'Send this to a friend who would be surprised!',
      'Save this Reel so you don’t forget it!',
      'Drop your take in the comments!',
    ],
    FACEBOOK_REELS: [
      'What do you think? Comment below!',
      'Did you know this story? Share with a friend!',
      'Surprising twist or expected? Tell us below!',
      'Comment what topic you want next!',
      'Share this fun fact with friends!',
    ],
    FACEBOOK_VIDEO: [
      'Share your thoughts in the comments or pass this along!',
      'Did this surprise you? Join the discussion below!',
      'Let us know which story we should explore next!',
      'Save or share with friends interested in history & facts!',
      'What’s your perspective? Comment below!',
    ],
  };
  const pool = language === 'en' ? enPool[format] : thPool[format];
  return pool[hash % pool.length]!;
}

export function generateMetadataDeterministic(params: {
  brief: MasterBrief;
  formats: ContentFormat[];
  templates: MetadataTemplate[];
  probe?: MediaProbeInfo;
}): PlatformMetadataMap {
  const { brief, formats, templates } = params;
  const tplMap = new Map<ContentFormat, MetadataTemplate>();
  for (const t of templates) tplMap.set(t.format, t);

  const topic = brief.topic.trim() || 'คลิปใหม่ล่าสุด';
  const hook = brief.hook.trim() || topic;
  const summary = brief.summary.trim() || topic;
  const keyPoints = (brief.keyPoints ?? []).map((k) => k.trim()).filter(Boolean);
  const briefCta = brief.cta.trim();
  const briefHashtags = (brief.coreHashtags ?? []).filter(Boolean);
  const timestamps = (brief.timestampsText ?? '').trim();
  const sources = (brief.sources ?? []).filter((s) => s.title || s.url);
  const sourcesBlock =
    sources.length > 0
      ? `${brief.language === 'en' ? '📚 Sources:' : '📚 แหล่งข้อมูลอ้างอิง:'}\n${sources
          .slice(0, 5)
          .map((s) => (s.url ? `• ${s.title}: ${s.url}` : `• ${s.title}`))
          .join('\n')}`
      : '';
  const shortSourcesLine =
    sources.length > 0
      ? `${brief.language === 'en' ? '📚 Ref:' : '📚 อ้างอิง:'} ${sources
          .slice(0, 2)
          .map((s) => s.title || s.url)
          .filter(Boolean)
          .join(', ')}`
      : '';
  const coverTitlePart = brief.coverHeadline?.trim() || topic;
  const coverHookPart = [
    brief.coverKicker?.trim(),
    brief.coverHeadline?.trim(),
    brief.coverSubline?.trim(),
  ]
    .filter(Boolean)
    .join(' ');
  const coverMs = Math.max(0, Number(brief.coverTimestampMs ?? 0));
  const isSynthetic = Boolean(brief.isSyntheticMedia);

  const result: PlatformMetadataMap = {};

  const GENERIC_SEEDED_CTAS = new Set([
    'กดติดตามไว้ไม่พลาดคลิปใหม่!',
    'คิดเห็นยังไง คอมเมนต์คุยกันและฝากกด Subscribe ด้วยนะครับ',
    'เคยสงสัยไหม? คอมเมนต์หรือ Save เก็บไว้เลย 👇',
    'กด Save หรือส่งต่อให้เพื่อนได้เลย!',
    'คิดเห็นยังไง คอมเมนต์คุยกันได้เลยครับ!',
    'เห็นด้วยไหมครับ? คอมเมนต์แลกเปลี่ยนมุมมองกันได้เลย หรือแชร์ต่อให้คนใกล้ตัว!',
  ]);

  for (const format of formats) {
    const tpl = tplMap.get(format);
    const customTemplateCta =
      tpl?.defaultCta && !GENERIC_SEEDED_CTAS.has(tpl.defaultCta.trim())
        ? tpl.defaultCta.trim()
        : '';
    const cta =
      briefCta ||
      customTemplateCta ||
      pickContextualEngagementCta(topic, format, brief.language);
    const ytCategoryId = inferYouTubeCategoryId(brief, tpl);

    if (format === 'YOUTUBE_SHORTS') {
      // Mobile Shorts overlays Title at bottom-left (~40-55 chars visible on 1-2 lines before obstructing frame)
      const baseShortTitle = coverTitlePart.length >= 6 ? coverTitlePart : hook;
      const rawTitle = cleanNoAngleBrackets(
        `${tpl?.titlePrefix ?? ''}${baseShortTitle}${tpl?.titleSuffix ?? ''}`
      );
      const hasShortsTag = /#shorts/i.test(rawTitle);
      const titleWithTag = hasShortsTag
        ? rawTitle
        : rawTitle.length <= 44
          ? `${rawTitle} #Shorts`
          : rawTitle;
      const title = clampString(titleWithTag, 55);

      const parts: string[] = [];
      if (tpl?.descriptionHeader) parts.push(tpl.descriptionHeader);
      // Shorts Description lives inside the drawer (not overlaid), yet concise SEO line converts best
      const conciseSummary =
        summary && summary !== baseShortTitle
          ? clampString(summary, 150)
          : hook !== baseShortTitle
            ? clampString(hook, 120)
            : '';
      if (conciseSummary) parts.push(conciseSummary);
      const shortCta = clampString(cta, 65);
      parts.push(shortCta);
      if (shortSourcesLine) parts.push(clampString(shortSourcesLine, 120));
      const hashLine = buildHashtagLine(
        'YOUTUBE_SHORTS',
        briefHashtags,
        tpl?.defaultHashtags ?? [],
        ['#Shorts'],
        3
      );
      if (hashLine) parts.push(hashLine);

      const description = truncateUtf8Bytes(
        cleanNoAngleBrackets(parts.filter(Boolean).join('\n')),
        4950
      );

      const tags = buildLongTailTags({
        topic,
        coverTitlePart,
        keyPoints,
        briefHashtags,
        templateTags: tpl?.defaultTags ?? [],
        isShort: true,
      });

      result.YOUTUBE_SHORTS = {
        title,
        description,
        tags,
        categoryId: ytCategoryId,
        privacyStatus: 'public',
        madeForKids: false,
        notifySubscribers: true,
        containsSyntheticMedia: isSynthetic,
        thumbnailIndex: 0,
      };
    }

    if (format === 'YOUTUBE_LONG') {
      const seoBase =
        hook.length >= 12
          ? hook
          : brief.language === 'en'
            ? `${topic} — Explained`
            : `${topic} (สรุปเข้าใจง่าย)`;
      const rawTitle = cleanNoAngleBrackets(
        `${tpl?.titlePrefix ?? ''}${seoBase}${tpl?.titleSuffix ?? ''}`
      );
      const title = clampString(rawTitle, 72);

      const parts: string[] = [];
      if (tpl?.descriptionHeader) parts.push(tpl.descriptionHeader);
      parts.push(
        hook && summary !== hook
          ? `${clampString(hook, 100)}\n${clampString(summary, 280)}`
          : clampString(summary, 300)
      );
      if (keyPoints.length > 0) {
        const heading =
          brief.language === 'en' ? '📌 Takeaways:' : '📌 สรุปประเด็นสำคัญ:';
        parts.push(
          `${heading}\n${keyPoints
            .slice(0, 4)
            .map((p) => `• ${clampString(p, 80)}`)
            .join('\n')}`
        );
      }
      if (timestamps) {
        const tsHead = brief.language === 'en' ? '⏱️ Chapters:' : '⏱️ Chapters:';
        parts.push(`${tsHead}\n${timestamps}`);
      }
      parts.push(`💬 ${cta}`);
      if (sourcesBlock) parts.push(sourcesBlock);
      if (tpl?.descriptionFooter) parts.push(tpl.descriptionFooter);

      const hashLine = buildHashtagLine(
        'YOUTUBE_LONG',
        briefHashtags,
        tpl?.defaultHashtags ?? [],
        [],
        3
      );
      if (hashLine) parts.push(hashLine);

      const description = truncateUtf8Bytes(
        cleanNoAngleBrackets(parts.join('\n\n')),
        4950
      );

      const tags = buildLongTailTags({
        topic,
        coverTitlePart,
        keyPoints,
        briefHashtags,
        templateTags: tpl?.defaultTags ?? [],
        isShort: false,
      });

      result.YOUTUBE_LONG = {
        title,
        description,
        tags,
        categoryId: ytCategoryId,
        privacyStatus: 'public',
        madeForKids: false,
        notifySubscribers: true,
        containsSyntheticMedia: isSynthetic,
        thumbnailIndex: 0,
      };
    }

    if (format === 'TIKTOK') {
      // TikTok overlays caption directly over lower video frame (cuts off at ~80-95 chars).
      // Keep to 2 concise lines (<= 165 chars) so visuals & subtitles stay completely clear!
      const tiktokLead = hook && hook !== coverTitlePart ? hook : coverHookPart || topic;
      const tiktokCta = cta;
      const hashLine = buildHashtagLine(
        'TIKTOK',
        briefHashtags,
        tpl?.defaultHashtags ?? [],
        [],
        3
      );
      const caption = compactShortOverlayCaption({
        rawText: `${clampString(tiktokLead, 72)}\n${clampString(tiktokCta, 55)}\n${hashLine}`,
        format: 'TIKTOK',
        maxTotalChars: 170,
        maxHashtags: 4,
      });
      result.TIKTOK = {
        caption,
        privacyLevel: 'PUBLIC_TO_EVERYONE',
        allowComment: true,
        allowDuet: true,
        allowStitch: true,
        brandOrganicToggle: false,
        brandContentToggle: false,
        isAigc: isSynthetic,
        coverTimestampMs: coverMs,
      };
    }

    if (format === 'INSTAGRAM_REELS') {
      // IG Reels cuts before "...more" around ~65-85 chars and dims lower video when expanded.
      const igLead = hook && hook !== coverTitlePart ? hook : coverHookPart || topic;
      const igCta = cta;
      const hashLine = buildHashtagLine(
        'INSTAGRAM_REELS',
        briefHashtags,
        tpl?.defaultHashtags ?? [],
        [],
        3
      );
      const caption = compactShortOverlayCaption({
        rawText: `${clampString(igLead, 68)}\n${clampString(igCta, 50)}\n${hashLine}`,
        format: 'INSTAGRAM_REELS',
        maxTotalChars: 170,
        maxHashtags: 4,
      });
      result.INSTAGRAM_REELS = {
        caption,
        shareToFeed: true,
        thumbOffsetMs: coverMs,
        isAiGenerated: isSynthetic,
      };
    }

    if (format === 'FACEBOOK_REELS') {
      // Meta Reels renders title + description compactly at the bottom-left overlay; keep both ultra-crisp
      const title = clampString(
        `${tpl?.titlePrefix ?? ''}${coverTitlePart}${tpl?.titleSuffix ?? ''}`,
        48
      );
      const fbHook =
        summary && summary !== coverTitlePart
          ? summary
          : hook !== coverTitlePart
            ? hook
            : coverHookPart || topic;
      const fbCta = cta;
      const hashLine = buildHashtagLine(
        'FACEBOOK_REELS',
        briefHashtags,
        tpl?.defaultHashtags ?? [],
        [],
        3
      );
      const description = compactShortOverlayCaption({
        rawText: `${clampString(fbHook, 76)}\n${clampString(fbCta, 45)}\n${hashLine}`,
        format: 'FACEBOOK_REELS',
        maxTotalChars: 165,
        maxHashtags: 3,
      });

      result.FACEBOOK_REELS = {
        title,
        description,
        isAiGenerated: isSynthetic,
      };
    }

    if (format === 'FACEBOOK_VIDEO') {
      const title = clampString(
        `${tpl?.titlePrefix ?? ''}${hook.length >= 12 ? hook : topic}${tpl?.titleSuffix ?? ''}`,
        78
      );
      const parts: string[] = [];
      if (tpl?.descriptionHeader) parts.push(tpl.descriptionHeader);
      parts.push(
        hook && summary !== hook
          ? `${clampString(hook, 100)}\n${clampString(summary, 280)}`
          : clampString(summary, 300)
      );
      if (keyPoints.length > 0) {
        parts.push(
          keyPoints
            .slice(0, 4)
            .map((p) => `• ${clampString(p, 80)}`)
            .join('\n')
        );
      }
      parts.push(`💬 ${cta}`);
      if (sourcesBlock) parts.push(sourcesBlock);
      if (tpl?.descriptionFooter) parts.push(tpl.descriptionFooter);
      const hashLine = buildHashtagLine(
        'FACEBOOK_VIDEO',
        briefHashtags,
        tpl?.defaultHashtags ?? [],
        [],
        3
      );
      if (hashLine) parts.push(hashLine);

      result.FACEBOOK_VIDEO = {
        title,
        description: clampString(parts.join('\n\n'), 60000),
        isAiGenerated: isSynthetic,
      };
    }
  }

  return result;
}

function sanitizeAiPlatformMetadata(
  raw: Record<string, unknown>,
  fallback: PlatformMetadataMap,
  formats: ContentFormat[]
): PlatformMetadataMap {
  const out: PlatformMetadataMap = { ...fallback };

  for (const format of formats) {
    const candidate = raw[format];
    if (!candidate || typeof candidate !== 'object') continue;
    const obj = candidate as Record<string, unknown>;

    if (format === 'YOUTUBE_SHORTS' || format === 'YOUTUBE_LONG') {
      const base = (fallback[format] ?? {
        title: '',
        description: '',
        tags: [],
        categoryId: '22',
        privacyStatus: 'public',
        madeForKids: false,
        notifySubscribers: true,
      }) as YouTubeMetadata;

      const title = clampString(
        cleanNoAngleBrackets(String(obj.title || base.title)),
        format === 'YOUTUBE_SHORTS' ? 58 : 80
      );
      const description = truncateUtf8Bytes(
        sanitizeCaptionForFormat(
          cleanNoAngleBrackets(String(obj.description || base.description)),
          format,
          format === 'YOUTUBE_SHORTS' ? 3 : 4
        ),
        format === 'YOUTUBE_SHORTS' ? 750 : 4950
      );
      const rawTags = Array.isArray(obj.tags)
        ? obj.tags.map(String)
        : base.tags;
      const tags = packYouTubeTags(rawTags);
      const categoryId =
        typeof obj.categoryId === 'string' && /^\d{1,2}$/.test(obj.categoryId.trim())
          ? obj.categoryId.trim()
          : base.categoryId;
      out[format] = { ...base, title, description, tags, categoryId };
    }

    if (format === 'TIKTOK' && fallback.TIKTOK) {
      const base: TikTokMetadata = fallback.TIKTOK;
      const caption = compactShortOverlayCaption({
        rawText: String(obj.caption || base.caption),
        format: 'TIKTOK',
        maxTotalChars: 180,
        maxHashtags: 4,
      });
      out.TIKTOK = { ...base, caption };
    }

    if (format === 'INSTAGRAM_REELS' && fallback.INSTAGRAM_REELS) {
      const base: InstagramReelsMetadata = fallback.INSTAGRAM_REELS;
      const caption = compactShortOverlayCaption({
        rawText: String(obj.caption || base.caption),
        format: 'INSTAGRAM_REELS',
        maxTotalChars: 180,
        maxHashtags: 4,
      });
      out.INSTAGRAM_REELS = { ...base, caption };
    }

    if (format === 'FACEBOOK_REELS' && fallback.FACEBOOK_REELS) {
      const base: FacebookReelsMetadata = fallback.FACEBOOK_REELS;
      out.FACEBOOK_REELS = {
        ...base,
        title: clampString(String(obj.title || base.title), 52),
        description: compactShortOverlayCaption({
          rawText: String(obj.description || base.description),
          format: 'FACEBOOK_REELS',
          maxTotalChars: 175,
          maxHashtags: 3,
        }),
      };
    }

    if (format === 'FACEBOOK_VIDEO' && fallback.FACEBOOK_VIDEO) {
      const base: FacebookVideoMetadata = fallback.FACEBOOK_VIDEO;
      out.FACEBOOK_VIDEO = {
        ...base,
        title: clampString(String(obj.title || base.title), 85),
        description: clampString(
          sanitizeCaptionForFormat(
            String(obj.description || base.description),
            'FACEBOOK_VIDEO',
            4
          ),
          60000
        ),
      };
    }
  }

  return out;
}

export async function generateMetadataWithAI(params: {
  brief: MasterBrief;
  formats: ContentFormat[];
  templates: MetadataTemplate[];
  probe?: MediaProbeInfo;
  settings: AppSettingsFull;
}): Promise<{
  metadata: PlatformMetadataMap;
  engineUsed: 'AI_GEMINI' | 'AI_OPENAI' | 'DETERMINISTIC';
  warning?: string;
}> {
  const deterministic = generateMetadataDeterministic({
    brief: params.brief,
    formats: params.formats,
    templates: params.templates,
    probe: params.probe,
  });

  const { settings } = params;
  if (settings.aiProvider === 'NONE' || !settings.aiApiKey) {
    return { metadata: deterministic, engineUsed: 'DETERMINISTIC' };
  }

  const prompt = `You are a top Thai & global social video strategist (2026 Social SEO + Algorithm Optimization).
Write distinct, high-CTR, algorithm-native metadata tailored separately for each requested platform key: ${params.formats.join(', ')}.
Never copy-paste the exact same caption across platforms. Respect each platform's ranking signals:

Input Master Brief:
- Topic: ${params.brief.topic}
- Hook: ${params.brief.hook}
- Summary: ${params.brief.summary}
- Key points: ${params.brief.keyPoints.join(' | ')}
- CTA: ${params.brief.cta}
- Seed Hashtags: ${params.brief.coreHashtags.join(' ')}
- Language: ${params.brief.language}
- Tone: ${params.brief.tone}
- Video Duration: ${params.probe?.durationSec ?? 0}s${
    params.brief.timestampsText
      ? `\n- Chapters/Timestamps:\n${params.brief.timestampsText}`
      : ''
  }${
    params.brief.coverHeadline
      ? `\n- Cover Artwork Text: ${[params.brief.coverKicker, params.brief.coverHeadline, params.brief.coverSubline].filter(Boolean).join(' | ')}`
      : ''
  }${
    params.brief.transcriptText
      ? `\n- Full Video Script / Transcript:\n${params.brief.transcriptText.slice(0, 2500)}`
      : ''
  }${
    params.brief.sources?.length
      ? `\n- Sources (cite cleanly on YouTube/Facebook long descriptions if relevant):\n${params.brief.sources.map((s) => `${s.title} (${s.url})`).join('\n')}`
      : ''
  }

Strict 2026 Platform Strategy & Overlay-Safe Constraints (CRITICAL: Mobile vertical feeds render Title/Caption DIRECTLY ON TOP OF the lower 20-35% of the video! Keep short-form text ultra-concise so it NEVER covers faces/visuals/subtitles and stays above "...more"):
- Anti-Slop Originality Rule: NEVER reuse generic boilerplate CTA lines (like "กดติดตามไว้ไม่พลาดคลิปใหม่!") across videos. Craft a distinct, topic-specific curiosity or opinion question tailored directly to this episode so every post looks human-authored rather than template-generated.
- Universal Hashtag Rule: Use ONLY 2 to 4 specific niche/topic hashtags (put keywords naturally in text, avoid hashtag stuffing). NEVER use generic spam tags (#fyp, #foryou, #viral, #trending, #reels, #คลิปสั้น, #TikTokThailand). NEVER leak platform names/tags across platforms (e.g., never put #Shorts on TikTok/IG/FB).
- YOUTUBE_SHORTS: { "title": "ULTRA-CONCISE <=50 chars (fits 1-2 lines at bottom-left without covering video or truncating), high-curiosity keyword hook, NO < or >", "description": "2 concise lines only (<=220 chars total): 1 crisp searchable Thai takeaway sentence + short Subscribe nudge + #Shorts + 2 niche tags (cite brief sources only if present)", "tags": ["8-12 long-tail Thai/English search queries people actually type, <=500 chars total"] }
- YOUTUBE_LONG: { "title": "<=70 chars high-CTR + search SEO phrase, NO < or >", "description": "crisp hook + concise summary + short bullet takeaways + Chapters (if timestamps provided) + Sources (if provided) + Subscribe CTA + 3 niche hashtags", "tags": ["10-15 real search phrases, <=500 chars total"] }
- TIKTOK: { "caption": "MAX 160 chars TOTAL (strictly 2 short lines, NO multi-paragraph essays or bullet lists so caption never covers the video!). Line 1 (<=70 chars): direct TikTok Search SEO hook visible before '...more'. Line 2: ultra-short question/Save CTA + 3 niche hashtags (NO #fyp)" }
- INSTAGRAM_REELS: { "caption": "MAX 160 chars TOTAL (2 short lines only, keeps bottom Reel player clean!). Line 1 (<=65 chars): hook with core keyword before '...more'. Line 2: short Save/DM-share CTA + 3 niche hashtags (NO '.\n.\n' dot padding)" }
- FACEBOOK_REELS: { "title": "ULTRA-CRISP <=45 chars (1 line)", "description": "MAX 150 chars TOTAL (1-2 short lines, do NOT repeat title verbatim!). Line 1: punchy relatable insight + Comment/Share prompt. Line 2: 3 niche hashtags" }
- FACEBOOK_VIDEO: { "title": "<=75 chars compelling headline", "description": "Engaging opening hook + concise takeaways + Sources (if any) + Comment/Share CTA + 3 niche hashtags" }

Return ONLY a valid raw JSON object containing the exact requested keys from [${params.formats.join(', ')}].`;

  try {
    let rawText = '';
    if (settings.aiProvider === 'GEMINI') {
      const apiKeys = settings.aiApiKey
        .split(/[\r\n,]+/)
        .map((k) => k.trim())
        .filter(Boolean);
      const preferredRaw = settings.aiModel?.trim() || '';
      const retiredOrPhantom = /^(?:gemini-2\.5-|gemini-3\.[67]-|gemini-3\.1-flash-lite$)/i;
      const preferredModel =
        preferredRaw && !retiredOrPhantom.test(preferredRaw) ? preferredRaw : '';
      const candidateModels = dedupeStrings([
        preferredModel,
        'gemini-3.5-flash-lite',
        'gemini-3.8-flash',
        'gemini-3.5-flash',
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite-preview',
      ]);

      const thinkingForModel = (modelName: string): Record<string, unknown> => {
        if (/^gemini-3(?:\.\d+)?-flash-lite/i.test(modelName)) {
          return { thinkingConfig: { thinkingLevel: 'MINIMAL' } };
        }
        if (/^gemini-3(?:\.\d+)?-/i.test(modelName)) {
          return { thinkingConfig: { thinkingLevel: 'LOW' } };
        }
        if (/^gemini-2\.5-flash/i.test(modelName)) {
          return { thinkingConfig: { thinkingBudget: 0 } };
        }
        return {};
      };

      let lastErr: Error | null = null;
      outer: for (const model of candidateModels) {
        for (const key of apiKeys) {
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
            const res = await fetch(url, {
              method: 'POST',
              signal: AbortSignal.timeout(20_000),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  temperature: 0.45,
                  ...thinkingForModel(model),
                },
              }),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                candidates?: Array<{
                  content?: { parts?: Array<{ text?: string; thought?: boolean }> };
                }>;
              };
              rawText =
                data.candidates?.[0]?.content?.parts
                  ?.filter((p) => p && !p.thought && typeof p.text === 'string')
                  .map((p) => p.text)
                  .join('') ?? '';
              if (rawText) break outer;
            } else {
              const errBody = await res.text();
              lastErr = new Error(`Gemini HTTP ${res.status} (${model}): ${errBody}`);
              if (res.status === 400 && /API key/i.test(errBody)) {
                continue;
              }
              // Model-level errors (overloaded/deprecated/unsupported) won't be fixed by rotating keys -> skip straight to next model
              if (res.status === 400 || res.status === 404 || res.status === 503 || res.status >= 500) {
                continue outer;
              }
            }
          } catch (fetchErr) {
            lastErr = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
            // Timeout / transient network error on this model -> move to next model quickly
            continue outer;
          }
        }
      }
      if (!rawText) {
        throw lastErr ?? new Error('Gemini API did not return generated text');
      }
    } else if (settings.aiProvider === 'OPENAI') {
      const base = (
        settings.aiBaseUrl || 'https://api.openai.com/v1'
      ).replace(/\/+$/, '');
      const model = settings.aiModel || 'gpt-4o-mini';
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Return strictly valid JSON object without markdown wrappers.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      rawText = data.choices?.[0]?.message?.content ?? '';
    }

    const cleanedJson = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(cleanedJson) as Record<string, unknown>;
    const sanitized = sanitizeAiPlatformMetadata(
      parsed,
      deterministic,
      params.formats
    );
    return {
      metadata: sanitized,
      engineUsed:
        settings.aiProvider === 'GEMINI' ? 'AI_GEMINI' : 'AI_OPENAI',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      metadata: deterministic,
      engineUsed: 'DETERMINISTIC',
      warning: `AI Generator fallback to Smart Rule Engine (${msg})`,
    };
  }
}
