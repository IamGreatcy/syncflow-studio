export const PLATFORM_LIMITS = {
    YOUTUBE_SHORTS: {
        format: 'YOUTUBE_SHORTS',
        platform: 'YOUTUBE',
        labelTh: 'YouTube Shorts',
        labelEn: 'YouTube Shorts',
        minDurationSec: 1,
        maxDurationSec: 180,
        maxFileSizeBytes: 256 * 1024 * 1024 * 1024,
        maxTitleChars: 100,
        maxCaptionChars: null,
        maxDescriptionBytes: 5000,
        maxHashtags: null,
        maxMentions: null,
        maxTagsTotalChars: 500,
        nativeScheduleWindowMinMin: 5,
        nativeScheduleWindowMaxDays: 3650,
        preferredAspect: '9:16',
    },
    YOUTUBE_LONG: {
        format: 'YOUTUBE_LONG',
        platform: 'YOUTUBE',
        labelTh: 'YouTube คลิปยาว',
        labelEn: 'YouTube Long Video',
        minDurationSec: 1,
        maxDurationSec: 43200,
        maxFileSizeBytes: 256 * 1024 * 1024 * 1024,
        maxTitleChars: 100,
        maxCaptionChars: null,
        maxDescriptionBytes: 5000,
        maxHashtags: null,
        maxMentions: null,
        maxTagsTotalChars: 500,
        nativeScheduleWindowMinMin: 5,
        nativeScheduleWindowMaxDays: 3650,
        preferredAspect: '16:9',
    },
    TIKTOK: {
        format: 'TIKTOK',
        platform: 'TIKTOK',
        labelTh: 'TikTok',
        labelEn: 'TikTok',
        minDurationSec: 3,
        maxDurationSec: 600, // Standard default ceiling; creator_info may refine up to 600s
        maxFileSizeBytes: 4 * 1000 * 1000 * 1000,
        maxTitleChars: null,
        maxCaptionChars: 2200,
        maxDescriptionBytes: null,
        maxHashtags: null,
        maxMentions: null,
        maxTagsTotalChars: null,
        nativeScheduleWindowMinMin: null,
        nativeScheduleWindowMaxDays: null,
        preferredAspect: '9:16',
    },
    INSTAGRAM_REELS: {
        format: 'INSTAGRAM_REELS',
        platform: 'INSTAGRAM',
        labelTh: 'Instagram Reels',
        labelEn: 'Instagram Reels',
        minDurationSec: 3,
        maxDurationSec: 900, // 15 minutes
        maxFileSizeBytes: 300 * 1024 * 1024,
        maxTitleChars: null,
        maxCaptionChars: 2200,
        maxDescriptionBytes: null,
        maxHashtags: 30,
        maxMentions: 20,
        maxTagsTotalChars: null,
        nativeScheduleWindowMinMin: null,
        nativeScheduleWindowMaxDays: null,
        preferredAspect: '9:16',
    },
    FACEBOOK_REELS: {
        format: 'FACEBOOK_REELS',
        platform: 'FACEBOOK',
        labelTh: 'Facebook Reels',
        labelEn: 'Facebook Reels',
        minDurationSec: 3,
        maxDurationSec: 90, // Strict Facebook Reels Graph API limit
        maxFileSizeBytes: 1000 * 1024 * 1024,
        maxTitleChars: 255,
        maxCaptionChars: 2200,
        maxDescriptionBytes: null,
        maxHashtags: null,
        maxMentions: null,
        maxTagsTotalChars: null,
        nativeScheduleWindowMinMin: 10,
        nativeScheduleWindowMaxDays: 29,
        preferredAspect: '9:16',
    },
    FACEBOOK_VIDEO: {
        format: 'FACEBOOK_VIDEO',
        platform: 'FACEBOOK',
        labelTh: 'Facebook วิดีโอเพจ',
        labelEn: 'Facebook Page Video',
        minDurationSec: 1,
        maxDurationSec: 14400,
        maxFileSizeBytes: 10 * 1024 * 1024 * 1024,
        maxTitleChars: 255,
        maxCaptionChars: 63206,
        maxDescriptionBytes: null,
        maxHashtags: null,
        maxMentions: null,
        maxTagsTotalChars: null,
        nativeScheduleWindowMinMin: 10,
        nativeScheduleWindowMaxDays: 180,
        preferredAspect: 'ANY',
    },
};
export const STYLIZED_ANIMATION_VISUAL_STYLES = new Set([
    'stickman3d',
    'illustration',
    'explainer3d',
    'motion',
    'handmade',
    'abstract',
    'cartoon',
    '2d',
    'anime',
]);
/**
 * Per 2025-2026 YouTube Altered/Synthetic, TikTok AIGC, and Meta AI Info rules:
 * Clearly stylized/cartoon/2D animation is exempt from realistic-AI disclosure labels,
 * whereas photorealistic or unspecified synthetic media requires disclosure.
 */
export function requiresRealisticAiDisclosure(visualStyle, fallback = true) {
    const norm = (visualStyle || '').trim().toLowerCase();
    if (!norm)
        return fallback;
    if (STYLIZED_ANIMATION_VISUAL_STYLES.has(norm))
        return false;
    return true;
}
export function formatToPlatform(format) {
    return PLATFORM_LIMITS[format].platform;
}
const utf8Encoder = new TextEncoder();
export function utf8ByteLength(text) {
    return utf8Encoder.encode(text || '').length;
}
export function truncateUtf8Bytes(text, maxBytes) {
    if (utf8ByteLength(text) <= maxBytes)
        return text;
    let result = '';
    let bytes = 0;
    for (const ch of text) {
        const chBytes = utf8Encoder.encode(ch).length;
        if (bytes + chBytes > maxBytes)
            break;
        result += ch;
        bytes += chBytes;
    }
    return result;
}
/**
 * YouTube API counts total tag characters including commas separating tags,
 * and quotes around any tag containing spaces.
 */
export function calculateYouTubeTagsLength(tags) {
    const cleaned = tags.map((t) => t.trim()).filter(Boolean);
    if (cleaned.length === 0)
        return 0;
    let total = 0;
    for (let i = 0; i < cleaned.length; i++) {
        const tag = cleaned[i];
        const hasSpace = /\s/.test(tag);
        total += tag.length + (hasSpace ? 2 : 0);
        if (i > 0)
            total += 1; // comma separator
    }
    return total;
}
export function extractHashtags(text) {
    const matches = text.match(/#[\p{L}\p{M}\p{N}_]+/gu);
    return matches ?? [];
}
export function extractMentions(text) {
    const matches = text.match(/@[a-zA-Z0-9._]+/g);
    return matches ?? [];
}
export function detectOrientation(width, height, rotation = 0) {
    const normalizedRot = ((rotation % 360) + 360) % 360;
    const effectiveW = normalizedRot === 90 || normalizedRot === 270 ? height : width;
    const effectiveH = normalizedRot === 90 || normalizedRot === 270 ? width : height;
    if (effectiveW === effectiveH)
        return 'SQUARE';
    return effectiveW < effectiveH ? 'VERTICAL' : 'HORIZONTAL';
}
export function detectRecommendedFormats(probe) {
    const orientation = detectOrientation(probe.width, probe.height, probe.rotation);
    const isVerticalOrSquare = orientation === 'VERTICAL' || orientation === 'SQUARE';
    // YouTube Shorts supports up to 180s vertical/square
    const isShortClip = isVerticalOrSquare && probe.durationSec <= 180;
    const clipCategory = isShortClip || probe.durationSec <= 90 ? 'SHORT' : 'LONG';
    const recommendedFormats = [];
    if (isVerticalOrSquare && probe.durationSec <= 180) {
        recommendedFormats.push('YOUTUBE_SHORTS');
    }
    else {
        recommendedFormats.push('YOUTUBE_LONG');
    }
    if (probe.durationSec <= 600) {
        recommendedFormats.push('TIKTOK');
    }
    if (probe.durationSec <= 900) {
        recommendedFormats.push('INSTAGRAM_REELS');
    }
    if (isVerticalOrSquare && probe.durationSec <= 90 && probe.durationSec >= 3) {
        recommendedFormats.push('FACEBOOK_REELS');
    }
    else {
        recommendedFormats.push('FACEBOOK_VIDEO');
    }
    return { orientation, clipCategory, recommendedFormats };
}
export function validateVideoCompatibility(format, probe) {
    const issues = [];
    const spec = PLATFORM_LIMITS[format];
    const orientation = detectOrientation(probe.width, probe.height, probe.rotation);
    if (probe.durationSec < spec.minDurationSec) {
        issues.push({
            format,
            field: 'duration',
            severity: 'error',
            code: 'DURATION_TOO_SHORT',
            message: `${spec.labelTh} ต้องมีความยาวอย่างน้อย ${spec.minDurationSec} วินาที (คลิปนี้ยาว ${probe.durationSec.toFixed(1)} วินาที)`,
        });
    }
    if (probe.durationSec > spec.maxDurationSec) {
        const extraHint = format === 'FACEBOOK_REELS'
            ? ' — แนะนำสลับเป็น "Facebook วิดีโอเพจ" เพื่อรองรับคลิปยาวเกิน 90 วินาที'
            : format === 'YOUTUBE_SHORTS'
                ? ' — คลิปเกิน 3 นาทีจะถูกอัปโหลดเป็น YouTube วิดีโอปกติแทน'
                : '';
        issues.push({
            format,
            field: 'duration',
            severity: 'error',
            code: 'DURATION_TOO_LONG',
            message: `${spec.labelTh} รองรับสูงสุด ${spec.maxDurationSec} วินาที (คลิปนี้ยาว ${Math.round(probe.durationSec)} วินาที)${extraHint}`,
        });
    }
    if (probe.fileSizeBytes > spec.maxFileSizeBytes) {
        const maxMb = Math.round(spec.maxFileSizeBytes / (1024 * 1024));
        const curMb = Math.round(probe.fileSizeBytes / (1024 * 1024));
        issues.push({
            format,
            field: 'fileSize',
            severity: 'error',
            code: 'FILE_TOO_LARGE',
            message: `${spec.labelTh} จำกัดขนาดไฟล์ไม่เกิน ${maxMb} MB (ไฟล์นี้ขนาด ${curMb} MB) — กด Optimize Video เพื่อลดขนาด`,
        });
    }
    if (format === 'YOUTUBE_SHORTS' && orientation === 'HORIZONTAL') {
        issues.push({
            format,
            field: 'orientation',
            severity: 'warning',
            code: 'SHORTS_HORIZONTAL_WARNING',
            message: 'คลิปนี้เป็นแนวนอน (16:9) YouTube จะไม่จัดเข้าฟีด Shorts ควรเลือกเป็น YouTube คลิปยาว',
        });
    }
    if (format === 'INSTAGRAM_REELS') {
        if (probe.hasFaststartMoov === false) {
            issues.push({
                format,
                field: 'codec',
                severity: 'warning',
                code: 'MISSING_FASTSTART',
                message: 'ไฟล์ MP4 ยังไม่ได้วาง moov atom ไว้ต้นไฟล์ (faststart) แนะนำกด Optimize Video ก่อนโพสต์ IG Reels',
            });
        }
        const codecLower = (probe.videoCodec || '').toLowerCase();
        if (codecLower && codecLower !== 'h264' && codecLower !== 'hevc' && codecLower !== 'h265') {
            issues.push({
                format,
                field: 'codec',
                severity: 'error',
                code: 'UNSUPPORTED_CODEC',
                message: `Instagram Reels รองรับเฉพาะ H.264 หรือ HEVC (ตรวจพบ ${probe.videoCodec}) กรุณากด Optimize Video`,
            });
        }
        if (probe.width > 1920) {
            issues.push({
                format,
                field: 'resolution',
                severity: 'warning',
                code: 'IG_WIDTH_EXCEEDS_1920',
                message: `Instagram จำกัดความกว้างไม่เกิน 1920px (คลิปนี้กว้าง ${probe.width}px) แนะนำกด Optimize Video`,
            });
        }
    }
    if (format === 'FACEBOOK_REELS' && orientation === 'HORIZONTAL') {
        issues.push({
            format,
            field: 'orientation',
            severity: 'warning',
            code: 'FB_REELS_HORIZONTAL',
            message: 'Facebook Reels แนะนำสัดส่วนแนวตั้ง 9:16 หากเป็นคลิปแนวนอนแนะนำใช้ Facebook วิดีโอเพจ',
        });
    }
    return issues;
}
export function validateFormatMetadata(format, meta, probe) {
    const issues = [];
    if (probe) {
        issues.push(...validateVideoCompatibility(format, probe));
    }
    if (!meta) {
        issues.push({
            format,
            field: 'metadata',
            severity: 'error',
            code: 'MISSING_METADATA',
            message: `ยังไม่ได้ตั้งค่าชื่อ/คำอธิบายสำหรับ ${PLATFORM_LIMITS[format].labelTh}`,
        });
        return issues;
    }
    const spec = PLATFORM_LIMITS[format];
    if (format === 'YOUTUBE_SHORTS' || format === 'YOUTUBE_LONG') {
        const title = String(meta.title ?? '');
        const description = String(meta.description ?? '');
        const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
        if (!title.trim()) {
            issues.push({
                format,
                field: 'title',
                severity: 'error',
                code: 'TITLE_REQUIRED',
                message: 'YouTube จำเป็นต้องมีชื่อคลิป (Title)',
            });
        }
        else if (title.length > (spec.maxTitleChars ?? 100)) {
            issues.push({
                format,
                field: 'title',
                severity: 'error',
                code: 'TITLE_TOO_LONG',
                message: `ชื่อคลิป YouTube ยาวเกิน 100 ตัวอักษร (ปัจจุบัน ${title.length}/100)`,
            });
        }
        else if (format === 'YOUTUBE_SHORTS' && title.length > 58) {
            issues.push({
                format,
                field: 'title',
                severity: 'warning',
                code: 'SHORTS_TITLE_OVERLAY_LONG',
                message: `ชื่อคลิป Shorts ยาว ${title.length} ตัวอักษร (แนะนำ ≤55) บนมือถืออาจถูกตัด (...) หรือซ้อนหลายบรรทัดบังคลิป`,
            });
        }
        if (/[<>]/.test(title)) {
            issues.push({
                format,
                field: 'title',
                severity: 'error',
                code: 'TITLE_INVALID_CHARS',
                message: 'ชื่อคลิป YouTube ห้ามมีเครื่องหมาย < หรือ >',
            });
        }
        if (/[<>]/.test(description)) {
            issues.push({
                format,
                field: 'description',
                severity: 'error',
                code: 'DESCRIPTION_INVALID_CHARS',
                message: 'คำอธิบาย YouTube ห้ามมีเครื่องหมาย < หรือ >',
            });
        }
        const descBytes = utf8ByteLength(description);
        if (descBytes > (spec.maxDescriptionBytes ?? 5000)) {
            issues.push({
                format,
                field: 'description',
                severity: 'error',
                code: 'DESCRIPTION_TOO_LONG_BYTES',
                message: `คำอธิบาย YouTube เกิน 5,000 UTF-8 bytes (ปัจจุบัน ${descBytes}/5000 bytes)`,
            });
        }
        const tagsLen = calculateYouTubeTagsLength(tags);
        if (tagsLen > (spec.maxTagsTotalChars ?? 500)) {
            issues.push({
                format,
                field: 'tags',
                severity: 'error',
                code: 'TAGS_TOO_LONG',
                message: `ความยาวรวม Tags ของ YouTube เกิน 500 ตัวอักษร (ปัจจุบัน ${tagsLen}/500)`,
            });
        }
    }
    if (format === 'TIKTOK') {
        const caption = String(meta.caption ?? '');
        if (caption.length > (spec.maxCaptionChars ?? 2200)) {
            issues.push({
                format,
                field: 'caption',
                severity: 'error',
                code: 'CAPTION_TOO_LONG',
                message: `แคปชั่น TikTok เกิน 2,200 ตัวอักษร (${caption.length}/2200)`,
            });
        }
        else if (caption.length > 200) {
            issues.push({
                format,
                field: 'caption',
                severity: 'warning',
                code: 'TIKTOK_CAPTION_OVERLAY_LONG',
                message: `แคปชั่น TikTok ยาว ${caption.length} ตัวอักษร (แนะนำ ≤180) อาจถูกตัด "...เพิ่มเติม" หรือบังส่วนล่างของคลิป`,
            });
        }
        if (!meta.privacyLevel) {
            issues.push({
                format,
                field: 'privacyLevel',
                severity: 'error',
                code: 'TIKTOK_PRIVACY_REQUIRED',
                message: 'TikTok Audit บังคับต้องระบุ Privacy Level ก่อนโพสต์',
            });
        }
    }
    if (format === 'INSTAGRAM_REELS') {
        const caption = String(meta.caption ?? '');
        if (caption.length > (spec.maxCaptionChars ?? 2200)) {
            issues.push({
                format,
                field: 'caption',
                severity: 'error',
                code: 'CAPTION_TOO_LONG',
                message: `แคปชั่น IG Reels เกิน 2,200 ตัวอักษร (${caption.length}/2200)`,
            });
        }
        else if (caption.length > 200) {
            issues.push({
                format,
                field: 'caption',
                severity: 'warning',
                code: 'IG_CAPTION_OVERLAY_LONG',
                message: `แคปชั่น IG Reels ยาว ${caption.length} ตัวอักษร (แนะนำ ≤180) อาจถูกตัด "...เพิ่มเติม" และบังพื้นหลังด้านล่างคลิป`,
            });
        }
        const hashtags = extractHashtags(caption);
        if (hashtags.length > 30) {
            issues.push({
                format,
                field: 'caption',
                severity: 'error',
                code: 'IG_TOO_MANY_HASHTAGS',
                message: `IG Reels จำกัดไม่เกิน 30 hashtags (พบ ${hashtags.length})`,
            });
        }
        const mentions = extractMentions(caption);
        if (mentions.length > 20) {
            issues.push({
                format,
                field: 'caption',
                severity: 'error',
                code: 'IG_TOO_MANY_MENTIONS',
                message: `IG Reels จำกัดไม่เกิน 20 mentions (พบ ${mentions.length})`,
            });
        }
    }
    if (format === 'FACEBOOK_REELS' || format === 'FACEBOOK_VIDEO') {
        const title = String(meta.title ?? '');
        const description = String(meta.description ?? '');
        if (title.length > 255) {
            issues.push({
                format,
                field: 'title',
                severity: 'error',
                code: 'TITLE_TOO_LONG',
                message: `ชื่อคลิป Facebook เกิน 255 ตัวอักษร (${title.length}/255)`,
            });
        }
        else if (format === 'FACEBOOK_REELS' && title.length > 58) {
            issues.push({
                format,
                field: 'title',
                severity: 'warning',
                code: 'FB_REELS_TITLE_OVERLAY_LONG',
                message: `หัวข้อ FB Reels ยาว ${title.length} ตัวอักษร (แนะนำ ≤50) อาจซ้อนหลายบรรทัดบังคลิป`,
            });
        }
        const maxCap = spec.maxCaptionChars ?? 2200;
        if (description.length > maxCap) {
            issues.push({
                format,
                field: 'description',
                severity: 'error',
                code: 'DESCRIPTION_TOO_LONG',
                message: `คำอธิบายเกิน ${maxCap} ตัวอักษร (${description.length}/${maxCap})`,
            });
        }
        else if (format === 'FACEBOOK_REELS' && description.length > 200) {
            issues.push({
                format,
                field: 'description',
                severity: 'warning',
                code: 'FB_REELS_DESC_OVERLAY_LONG',
                message: `คำอธิบาย FB Reels ยาว ${description.length} ตัวอักษร (แนะนำ ≤180) อาจบังส่วนล่างของคลิปแนวตั้ง`,
            });
        }
    }
    // Non-blocking anti-suppression & anti-spam checks (2026 platform trust signals)
    const checkAntiSuppressionTags = (field, tagSourceText, fullSearchText) => {
        const tagCount = extractHashtags(tagSourceText).length;
        if (tagCount > 5) {
            issues.push({
                format,
                field,
                severity: 'warning',
                code: 'HASHTAG_STUFFING_RISK',
                message: `ใส่ Hashtags มากเกินไป (${tagCount} แท็ก · แนะนำ 2–4 แท็กเฉพาะทาง) อาจถูกลดการมองเห็นเป็นสแปม`,
            });
        }
        const crossLeak = format === 'YOUTUBE_SHORTS' || format === 'YOUTUBE_LONG'
            ? /#(?:tiktok|tiktokthailand|reels|reelsinstagram|facebookreels)\b/i.test(fullSearchText)
            : /#shorts\b/i.test(fullSearchText);
        if (crossLeak) {
            issues.push({
                format,
                field,
                severity: 'warning',
                code: 'CROSS_PLATFORM_TAG_LEAK',
                message: `พบ Hashtag ข้ามแพลตฟอร์มใน ${spec.labelTh} (เช่น #Shorts บน TikTok/Reels หรือ #tiktok บน YouTube)`,
            });
        }
        if (/#(?:fyp|foryou|foryoupage|viral)\b/i.test(fullSearchText)) {
            issues.push({
                format,
                field,
                severity: 'warning',
                code: 'SPAM_HASHTAG_RISK',
                message: 'หลีกเลี่ยงแท็กกว้างอย่าง #fyp / #foryou / #viral ควรใช้คีย์เวิร์ดเฉพาะหัวข้อแทน',
            });
        }
    };
    if (format === 'YOUTUBE_SHORTS' || format === 'YOUTUBE_LONG') {
        checkAntiSuppressionTags('description', String(meta.description ?? ''), `${String(meta.title ?? '')}\n${String(meta.description ?? '')}`);
    }
    else if (format === 'TIKTOK' || format === 'INSTAGRAM_REELS') {
        const cap = String(meta.caption ?? '');
        checkAntiSuppressionTags('caption', cap, cap);
    }
    else if (format === 'FACEBOOK_REELS' || format === 'FACEBOOK_VIDEO') {
        const desc = String(meta.description ?? '');
        checkAntiSuppressionTags('description', desc, `${String(meta.title ?? '')}\n${desc}`);
    }
    return issues;
}
/**
 * Implements TikTok Content Posting API v2 FILE_UPLOAD chunk specification:
 * - Files <= 5 MB: single chunk (chunk_size = fileSize, total_chunk_count = 1)
 * - Regular chunks: 5 MB .. 64 MB
 * - total_chunk_count MUST be Math.floor(videoSize / chunkSize)
 * - Final trailing chunk absorbs remainder bytes and may be up to 128 MB
 * - Max 1000 chunks
 */
export function computeTikTokChunkPlan(videoSizeBytes, preferredChunkBytes = 10_000_000) {
    const MIN_CHUNK = 5_000_000;
    const MAX_CHUNK = 64_000_000;
    const MAX_FINAL_CHUNK = 128_000_000;
    const MAX_CHUNKS = 1000;
    if (videoSizeBytes <= 0) {
        throw new Error('videoSizeBytes must be > 0');
    }
    if (videoSizeBytes <= MIN_CHUNK) {
        return {
            chunkSize: videoSizeBytes,
            totalChunkCount: 1,
            chunks: [{ index: 0, start: 0, end: videoSizeBytes - 1, size: videoSizeBytes }],
        };
    }
    let chunkSize = Math.min(Math.max(preferredChunkBytes, MIN_CHUNK), MAX_CHUNK);
    if (videoSizeBytes > MAX_CHUNK && Math.floor(videoSizeBytes / chunkSize) < 2) {
        chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.floor(videoSizeBytes / 2)));
    }
    // Ensure chunk count <= 1000
    if (Math.floor(videoSizeBytes / chunkSize) > MAX_CHUNKS) {
        chunkSize = Math.min(MAX_CHUNK, Math.ceil(videoSizeBytes / MAX_CHUNKS));
    }
    let totalChunkCount = Math.floor(videoSizeBytes / chunkSize);
    if (totalChunkCount < 1)
        totalChunkCount = 1;
    // Ensure final chunk never exceeds 128 MB
    let finalStart = (totalChunkCount - 1) * chunkSize;
    let finalSize = videoSizeBytes - finalStart;
    while (finalSize > MAX_FINAL_CHUNK && chunkSize < MAX_CHUNK) {
        chunkSize = Math.min(MAX_CHUNK, chunkSize + 5_000_000);
        totalChunkCount = Math.floor(videoSizeBytes / chunkSize);
        finalStart = (totalChunkCount - 1) * chunkSize;
        finalSize = videoSizeBytes - finalStart;
    }
    // TikTok requires single-chunk uploads (<= 64 MB) to declare chunk_size === video_size
    if (totalChunkCount === 1) {
        chunkSize = videoSizeBytes;
    }
    const chunks = [];
    for (let i = 0; i < totalChunkCount; i++) {
        const start = i * chunkSize;
        const isLast = i === totalChunkCount - 1;
        const end = isLast ? videoSizeBytes - 1 : start + chunkSize - 1;
        chunks.push({
            index: i,
            start,
            end,
            size: end - start + 1,
        });
    }
    return { chunkSize, totalChunkCount, chunks };
}
//# sourceMappingURL=platform-specs.js.map