import { calculateYouTubeTagsLength, extractHashtags, truncateUtf8Bytes, } from '@clipflow/shared';
function cleanNoAngleBrackets(str) {
    return str.replace(/[<>]/g, '').trim();
}
function normalizeHashtag(tag) {
    const cleaned = tag.trim().replace(/\s+/g, '');
    if (!cleaned)
        return '';
    return cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
}
function dedupeStrings(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const norm = item.trim();
        if (!norm)
            continue;
        const key = norm.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(norm);
    }
    return out;
}
function packYouTubeTags(candidates, maxChars = 490) {
    const result = [];
    for (const raw of dedupeStrings(candidates)) {
        const clean = cleanNoAngleBrackets(raw.replace(/^#/, ''));
        if (!clean)
            continue;
        const trial = [...result, clean];
        if (calculateYouTubeTagsLength(trial) <= maxChars) {
            result.push(clean);
        }
        else {
            break;
        }
    }
    return result;
}
function clampString(str, maxChars) {
    const s = str.trim();
    if (s.length <= maxChars)
        return s;
    const slice = s.slice(0, Math.max(0, maxChars - 1));
    // Prefer breaking at last whitespace if it doesn't shrink excessively
    const lastSpace = slice.lastIndexOf(' ');
    const cleanCut = lastSpace >= Math.floor(maxChars * 0.55) ? slice.slice(0, lastSpace) : slice;
    return `${cleanCut.trimEnd()}…`;
}
/**
 * Ensures short-form overlay captions (TikTok, IG Reels, FB Reels) stay compact (2-3 tight lines)
 * so they remain readable above the "...more" fold and never cover the lower third of vertical video.
 */
function compactShortOverlayCaption(params) {
    const cleaned = sanitizeCaptionForFormat(params.rawText, params.format, params.maxHashtags);
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
    const maxBodyChars = Math.max(40, params.maxTotalChars - tagLine.length - separator.length);
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
function filterHashtagsForFormat(candidates, format, maxCount) {
    const blocked = new Set(GENERIC_SPAM_HASHTAGS);
    if (format !== 'YOUTUBE_SHORTS') {
        blocked.add('#shorts');
    }
    const normalized = dedupeStrings(candidates.map(normalizeHashtag)).filter((tag) => tag.length > 1 && !blocked.has(tag.toLowerCase()));
    if (format === 'YOUTUBE_SHORTS' && !normalized.some((t) => t.toLowerCase() === '#shorts')) {
        normalized.unshift('#Shorts');
    }
    return normalized.slice(0, maxCount);
}
function buildHashtagLine(format, briefTags, templateTags, extraTags, maxCount) {
    return filterHashtagsForFormat([...briefTags, ...templateTags, ...extraTags], format, maxCount).join(' ');
}
function buildLongTailTags(params) {
    const keyPhrases = params.keyPoints.flatMap((p) => p
        .split(/[,/|—–-]+|\s{2,}/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 4 && s.length <= 36));
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
function sanitizeCaptionForFormat(rawText, format, maxHashtags) {
    // Remove legacy IG dot-spacer blocks ("...\n.\n.\n")
    let text = rawText.replace(/\n\s*\.\s*\n\s*\.\s*/g, '\n\n').trim();
    const blocked = new Set(GENERIC_SPAM_HASHTAGS);
    if (format !== 'YOUTUBE_SHORTS') {
        blocked.add('#shorts');
    }
    const tags = extractHashtags(text);
    const keepSet = new Set();
    const dropSet = new Set();
    for (const t of tags) {
        const lower = t.toLowerCase();
        if (blocked.has(lower)) {
            dropSet.add(lower);
        }
        else if (keepSet.size < maxHashtags) {
            keepSet.add(lower);
        }
        else {
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
export function generateMetadataDeterministic(params) {
    const { brief, formats, templates } = params;
    const tplMap = new Map();
    for (const t of templates)
        tplMap.set(t.format, t);
    const topic = brief.topic.trim() || 'คลิปใหม่ล่าสุด';
    const hook = brief.hook.trim() || topic;
    const summary = brief.summary.trim() || topic;
    const keyPoints = (brief.keyPoints ?? []).map((k) => k.trim()).filter(Boolean);
    const briefCta = brief.cta.trim();
    const briefHashtags = (brief.coreHashtags ?? []).filter(Boolean);
    const timestamps = (brief.timestampsText ?? '').trim();
    const sources = (brief.sources ?? []).filter((s) => s.title || s.url);
    const sourcesBlock = sources.length > 0
        ? `${brief.language === 'en' ? '📚 Sources:' : '📚 แหล่งข้อมูลอ้างอิง:'}\n${sources
            .slice(0, 5)
            .map((s) => (s.url ? `• ${s.title}: ${s.url}` : `• ${s.title}`))
            .join('\n')}`
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
    const result = {};
    for (const format of formats) {
        const tpl = tplMap.get(format);
        const cta = briefCta || tpl?.defaultCta || '';
        if (format === 'YOUTUBE_SHORTS') {
            // Mobile Shorts overlays Title at bottom-left (~40-55 chars visible on 1-2 lines before obstructing frame)
            const baseShortTitle = coverTitlePart.length >= 6 ? coverTitlePart : hook;
            const rawTitle = cleanNoAngleBrackets(`${tpl?.titlePrefix ?? ''}${baseShortTitle}${tpl?.titleSuffix ?? ''}`);
            const hasShortsTag = /#shorts/i.test(rawTitle);
            const titleWithTag = hasShortsTag
                ? rawTitle
                : rawTitle.length <= 44
                    ? `${rawTitle} #Shorts`
                    : rawTitle;
            const title = clampString(titleWithTag, 55);
            const parts = [];
            if (tpl?.descriptionHeader)
                parts.push(tpl.descriptionHeader);
            // Shorts Description lives inside the drawer (not overlaid), yet concise SEO line converts best
            const conciseSummary = summary && summary !== baseShortTitle
                ? clampString(summary, 150)
                : hook !== baseShortTitle
                    ? clampString(hook, 120)
                    : '';
            if (conciseSummary)
                parts.push(conciseSummary);
            const shortCta = cta
                ? clampString(cta, 55)
                : brief.language === 'en'
                    ? 'Subscribe for more!'
                    : 'กดติดตามไว้ไม่พลาดคลิปใหม่!';
            parts.push(shortCta);
            if (sourcesBlock)
                parts.push(sourcesBlock);
            const hashLine = buildHashtagLine('YOUTUBE_SHORTS', briefHashtags, tpl?.defaultHashtags ?? [], ['#Shorts'], 3);
            if (hashLine)
                parts.push(hashLine);
            const description = truncateUtf8Bytes(cleanNoAngleBrackets(parts.filter(Boolean).join('\n')), 4950);
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
                categoryId: '22',
                privacyStatus: 'public',
                madeForKids: false,
                notifySubscribers: true,
                containsSyntheticMedia: false,
                thumbnailIndex: 0,
            };
        }
        if (format === 'YOUTUBE_LONG') {
            const seoBase = hook.length >= 12
                ? hook
                : brief.language === 'en'
                    ? `${topic} — Explained`
                    : `${topic} (สรุปเข้าใจง่าย)`;
            const rawTitle = cleanNoAngleBrackets(`${tpl?.titlePrefix ?? ''}${seoBase}${tpl?.titleSuffix ?? ''}`);
            const title = clampString(rawTitle, 72);
            const parts = [];
            if (tpl?.descriptionHeader)
                parts.push(tpl.descriptionHeader);
            parts.push(hook && summary !== hook
                ? `${clampString(hook, 100)}\n${clampString(summary, 280)}`
                : clampString(summary, 300));
            if (keyPoints.length > 0) {
                const heading = brief.language === 'en' ? '📌 Takeaways:' : '📌 สรุปประเด็นสำคัญ:';
                parts.push(`${heading}\n${keyPoints
                    .slice(0, 4)
                    .map((p) => `• ${clampString(p, 80)}`)
                    .join('\n')}`);
            }
            if (timestamps) {
                const tsHead = brief.language === 'en' ? '⏱️ Chapters:' : '⏱️ Chapters:';
                parts.push(`${tsHead}\n${timestamps}`);
            }
            parts.push(`💬 ${cta || (brief.language === 'en' ? 'Comment your thoughts & subscribe!' : 'คิดเห็นยังไง คอมเมนต์คุยกันและฝากกด Subscribe ด้วยนะครับ')}`);
            if (sourcesBlock)
                parts.push(sourcesBlock);
            if (tpl?.descriptionFooter)
                parts.push(tpl.descriptionFooter);
            const hashLine = buildHashtagLine('YOUTUBE_LONG', briefHashtags, tpl?.defaultHashtags ?? [], [], 3);
            if (hashLine)
                parts.push(hashLine);
            const description = truncateUtf8Bytes(cleanNoAngleBrackets(parts.join('\n\n')), 4950);
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
                categoryId: '22',
                privacyStatus: 'public',
                madeForKids: false,
                notifySubscribers: true,
                containsSyntheticMedia: false,
                thumbnailIndex: 0,
            };
        }
        if (format === 'TIKTOK') {
            // TikTok overlays caption directly over lower video frame (cuts off at ~80-95 chars).
            // Keep to 2 concise lines (<= 165 chars) so visuals & subtitles stay completely clear!
            const tiktokLead = hook && hook !== coverTitlePart ? hook : coverHookPart || topic;
            const tiktokCta = cta ||
                (brief.language === 'en'
                    ? 'Save & comment below 👇'
                    : 'เคยสงสัยไหม? คอมเมนต์หรือ Save เลย 👇');
            const hashLine = buildHashtagLine('TIKTOK', briefHashtags, tpl?.defaultHashtags ?? [], [], 3);
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
            const igCta = cta ||
                (brief.language === 'en'
                    ? 'Save & send to a friend!'
                    : 'กด Save หรือส่งต่อให้เพื่อน!');
            const hashLine = buildHashtagLine('INSTAGRAM_REELS', briefHashtags, tpl?.defaultHashtags ?? [], [], 3);
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
                isAiGenerated: false,
            };
        }
        if (format === 'FACEBOOK_REELS') {
            // Meta Reels renders title + description compactly at the bottom-left overlay; keep both ultra-crisp
            const title = clampString(`${tpl?.titlePrefix ?? ''}${coverTitlePart}${tpl?.titleSuffix ?? ''}`, 48);
            const fbHook = summary && summary !== coverTitlePart
                ? summary
                : hook !== coverTitlePart
                    ? hook
                    : coverHookPart || topic;
            const fbCta = cta ||
                (brief.language === 'en'
                    ? 'Comment & share!'
                    : 'คิดเห็นยังไง คอมเมนต์คุยกัน!');
            const hashLine = buildHashtagLine('FACEBOOK_REELS', briefHashtags, tpl?.defaultHashtags ?? [], [], 3);
            const description = compactShortOverlayCaption({
                rawText: `${clampString(fbHook, 76)}\n${clampString(fbCta, 45)}\n${hashLine}`,
                format: 'FACEBOOK_REELS',
                maxTotalChars: 165,
                maxHashtags: 3,
            });
            result.FACEBOOK_REELS = {
                title,
                description,
                isAiGenerated: false,
            };
        }
        if (format === 'FACEBOOK_VIDEO') {
            const title = clampString(`${tpl?.titlePrefix ?? ''}${hook.length >= 12 ? hook : topic}${tpl?.titleSuffix ?? ''}`, 78);
            const parts = [];
            if (tpl?.descriptionHeader)
                parts.push(tpl.descriptionHeader);
            parts.push(hook && summary !== hook
                ? `${clampString(hook, 100)}\n${clampString(summary, 280)}`
                : clampString(summary, 300));
            if (keyPoints.length > 0) {
                parts.push(keyPoints
                    .slice(0, 4)
                    .map((p) => `• ${clampString(p, 80)}`)
                    .join('\n'));
            }
            parts.push(`💬 ${cta || (brief.language === 'en' ? 'Comment & share with friends!' : 'เห็นด้วยไหมครับ คอมเมนต์คุยกันหรือแชร์ต่อได้เลย!')}`);
            if (sourcesBlock)
                parts.push(sourcesBlock);
            if (tpl?.descriptionFooter)
                parts.push(tpl.descriptionFooter);
            const hashLine = buildHashtagLine('FACEBOOK_VIDEO', briefHashtags, tpl?.defaultHashtags ?? [], [], 3);
            if (hashLine)
                parts.push(hashLine);
            result.FACEBOOK_VIDEO = {
                title,
                description: clampString(parts.join('\n\n'), 60000),
                isAiGenerated: false,
            };
        }
    }
    return result;
}
function sanitizeAiPlatformMetadata(raw, fallback, formats) {
    const out = { ...fallback };
    for (const format of formats) {
        const candidate = raw[format];
        if (!candidate || typeof candidate !== 'object')
            continue;
        const obj = candidate;
        if (format === 'YOUTUBE_SHORTS' || format === 'YOUTUBE_LONG') {
            const base = (fallback[format] ?? {
                title: '',
                description: '',
                tags: [],
                categoryId: '22',
                privacyStatus: 'public',
                madeForKids: false,
                notifySubscribers: true,
            });
            const title = clampString(cleanNoAngleBrackets(String(obj.title || base.title)), format === 'YOUTUBE_SHORTS' ? 58 : 80);
            const description = truncateUtf8Bytes(sanitizeCaptionForFormat(cleanNoAngleBrackets(String(obj.description || base.description)), format, format === 'YOUTUBE_SHORTS' ? 3 : 4), format === 'YOUTUBE_SHORTS' ? 750 : 4950);
            const rawTags = Array.isArray(obj.tags)
                ? obj.tags.map(String)
                : base.tags;
            const tags = packYouTubeTags(rawTags);
            out[format] = { ...base, title, description, tags };
        }
        if (format === 'TIKTOK' && fallback.TIKTOK) {
            const base = fallback.TIKTOK;
            const caption = compactShortOverlayCaption({
                rawText: String(obj.caption || base.caption),
                format: 'TIKTOK',
                maxTotalChars: 180,
                maxHashtags: 4,
            });
            out.TIKTOK = { ...base, caption };
        }
        if (format === 'INSTAGRAM_REELS' && fallback.INSTAGRAM_REELS) {
            const base = fallback.INSTAGRAM_REELS;
            const caption = compactShortOverlayCaption({
                rawText: String(obj.caption || base.caption),
                format: 'INSTAGRAM_REELS',
                maxTotalChars: 180,
                maxHashtags: 4,
            });
            out.INSTAGRAM_REELS = { ...base, caption };
        }
        if (format === 'FACEBOOK_REELS' && fallback.FACEBOOK_REELS) {
            const base = fallback.FACEBOOK_REELS;
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
            const base = fallback.FACEBOOK_VIDEO;
            out.FACEBOOK_VIDEO = {
                ...base,
                title: clampString(String(obj.title || base.title), 85),
                description: clampString(sanitizeCaptionForFormat(String(obj.description || base.description), 'FACEBOOK_VIDEO', 4), 60000),
            };
        }
    }
    return out;
}
export async function generateMetadataWithAI(params) {
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
- Video Duration: ${params.probe?.durationSec ?? 0}s${params.brief.timestampsText
        ? `\n- Chapters/Timestamps:\n${params.brief.timestampsText}`
        : ''}${params.brief.coverHeadline
        ? `\n- Cover Artwork Text: ${[params.brief.coverKicker, params.brief.coverHeadline, params.brief.coverSubline].filter(Boolean).join(' | ')}`
        : ''}${params.brief.transcriptText
        ? `\n- Full Video Script / Transcript:\n${params.brief.transcriptText.slice(0, 2500)}`
        : ''}${params.brief.sources?.length
        ? `\n- Sources (cite cleanly on YouTube/Facebook long descriptions if relevant):\n${params.brief.sources.map((s) => `${s.title} (${s.url})`).join('\n')}`
        : ''}

Strict 2026 Platform Strategy & Overlay-Safe Constraints (CRITICAL: Mobile vertical feeds render Title/Caption DIRECTLY ON TOP OF the lower 20-35% of the video! Keep short-form text ultra-concise so it NEVER covers faces/visuals/subtitles and stays above "...more"):
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
            const preferredModel = settings.aiModel?.trim() || 'gemini-3.8-flash';
            const candidateModels = dedupeStrings([
                preferredModel,
                'gemini-3.8-flash',
                'gemini-3.6-flash',
                'gemini-3.5-flash',
                'gemini-3.1-flash-lite',
                'gemini-flash-lite-latest',
            ]);
            let lastErr = null;
            outer: for (const model of candidateModels) {
                for (const key of apiKeys) {
                    try {
                        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
                        const res = await fetch(url, {
                            method: 'POST',
                            signal: AbortSignal.timeout(12_000),
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{ parts: [{ text: prompt }] }],
                                generationConfig: {
                                    responseMimeType: 'application/json',
                                    temperature: 0.7,
                                },
                            }),
                        });
                        if (res.ok) {
                            const data = (await res.json());
                            rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                            if (rawText)
                                break outer;
                        }
                        else {
                            const errBody = await res.text();
                            lastErr = new Error(`Gemini HTTP ${res.status} (${model}): ${errBody}`);
                            // Model-level errors (overloaded/deprecated/timeout) won't be fixed by rotating keys -> skip straight to next model
                            if (res.status === 404 || res.status === 503) {
                                continue outer;
                            }
                        }
                    }
                    catch (fetchErr) {
                        lastErr = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
                        // Timeout / transient network error on this model -> move to next model quickly
                        continue outer;
                    }
                }
            }
            if (!rawText) {
                throw lastErr ?? new Error('Gemini API did not return generated text');
            }
        }
        else if (settings.aiProvider === 'OPENAI') {
            const base = (settings.aiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
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
                            content: 'Return strictly valid JSON object without markdown wrappers.',
                        },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.7,
                }),
            });
            if (!res.ok) {
                throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
            }
            const data = (await res.json());
            rawText = data.choices?.[0]?.message?.content ?? '';
        }
        const cleanedJson = rawText
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```$/i, '')
            .trim();
        const parsed = JSON.parse(cleanedJson);
        const sanitized = sanitizeAiPlatformMetadata(parsed, deterministic, params.formats);
        return {
            metadata: sanitized,
            engineUsed: settings.aiProvider === 'GEMINI' ? 'AI_GEMINI' : 'AI_OPENAI',
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            metadata: deterministic,
            engineUsed: 'DETERMINISTIC',
            warning: `AI Generator fallback to Smart Rule Engine (${msg})`,
        };
    }
}
//# sourceMappingURL=metadata-engine.js.map