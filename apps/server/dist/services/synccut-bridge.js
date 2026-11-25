import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_FORMATS, detectRecommendedFormats, requiresRealisticAiDisclosure, validateFormatMetadata, validateVideoCompatibility, } from '@clipflow/shared';
import { extractThumbnails, probeVideo } from './media.js';
import { generateMetadataWithAI } from './metadata-engine.js';
export function stripCoverMarkdown(text) {
    return (text || '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
}
export function sanitizePromptTitle(raw) {
    let s = (raw || '').replace(/…+$/g, '').trim();
    // Strip common English AI prompt prefixes
    s = s.replace(/^Create\s+an?\s+(?:exactly\s+\d+[-\s]*second,?\s*)?(?:photorealistic\s+|cinematic\s+)*/i, '');
    s = s.replace(/,\s*captured\s+as\s+one.*$/i, '');
    // Strip common Thai AI prompt directives
    s = s.replace(/^จงค้นหา(?:เรื่องราวของ|ตำนาน)?\s*/i, (m) => m.includes('ตำนาน') ? 'ตำนาน' : '');
    s = s.replace(/^จง(?:เล่า|อธิบาย|สรุป|สร้าง|ทำคลิป)\s*/i, '');
    s = s.replace(/\s+จงแฝง.*$/i, '');
    s = s.replace(/\s+และ(?:เล่าเรื่อง|แฝงสาระ|อธิบาย|ทำให้).*$/i, '');
    s = s.replace(/\s+ให้คนดู.*$/i, '');
    s = s.replace(/\s+เล่าเรื่อง.*$/i, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s)
        return (raw || 'SyncCut Video').slice(0, 80).trim();
    return s.length > 90 ? `${s.slice(0, 89).trim()}…` : s;
}
function formatMmSs(totalSec) {
    const sec = Math.max(0, Math.floor(totalSec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function isPathInsideDir(targetPath, baseDir) {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedBase = path.resolve(baseDir);
    return (resolvedTarget.toLowerCase() === resolvedBase.toLowerCase() ||
        resolvedTarget
            .toLowerCase()
            .startsWith(resolvedBase.toLowerCase() + path.sep));
}
function readSyncCutRecords(dataDir) {
    const dbPath = path.join(dataDir, 'studio.sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const epRows = db
            .prepare('SELECT data FROM records WHERE kind = ? ORDER BY rowid DESC')
            .all('episode');
        const expRows = db
            .prepare('SELECT data FROM records WHERE kind = ? ORDER BY rowid DESC')
            .all('export');
        const fileRows = db
            .prepare('SELECT id, data FROM records WHERE kind = ?')
            .all('file');
        const episodes = epRows.map((r) => JSON.parse(r.data));
        const exportsList = expRows.map((r) => JSON.parse(r.data));
        const filesById = new Map();
        for (const r of fileRows) {
            filesById.set(r.id, JSON.parse(r.data));
        }
        return { episodes, exports: exportsList, filesById };
    }
    finally {
        db.close();
    }
}
export function listSyncCutEpisodes(dataDir) {
    if (!dataDir || !fs.existsSync(path.join(dataDir, 'studio.sqlite'))) {
        return { connected: false, dataDir, episodes: [] };
    }
    const { episodes, exports: exportsList, filesById } = readSyncCutRecords(dataDir);
    const summaries = episodes.map((ep) => {
        const matchingExports = exportsList
            .filter((x) => x.episodeId === ep.id)
            .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
        const bestExp = matchingExports.find((x) => x.file && fs.existsSync(x.file)) ??
            matchingExports[0] ??
            null;
        const coverFile = bestExp?.coverId
            ? filesById.get(bestExp.coverId) ?? null
            : null;
        const hasVideo = Boolean(bestExp?.file && fs.existsSync(bestExp.file));
        const hasCover = Boolean(coverFile?.file && fs.existsSync(coverFile.file));
        const cd = ep.delivery?.coverDesign;
        const coverKicker = stripCoverMarkdown(cd?.kicker ?? '');
        const coverHeadline = stripCoverMarkdown(cd?.headline ?? '');
        const coverSubline = stripCoverMarkdown(cd?.subline ?? '');
        const cleanTitle = ep.delivery?.publishTitle?.trim() ||
            coverHeadline ||
            sanitizePromptTitle(ep.title ?? '');
        const narrationPreview = (ep.shots ?? [])
            .map((s) => s.narration?.trim())
            .filter(Boolean)
            .join(' ')
            .slice(0, 220);
        return {
            episodeId: ep.id,
            exportId: bestExp?.id ?? null,
            version: bestExp?.version ?? null,
            rawTitle: ep.title ?? '',
            cleanTitle,
            coverKicker,
            coverHeadline,
            coverSubline,
            narrationPreview,
            aspectRatio: ep.production?.aspectRatio || '9:16',
            durationSec: bestExp?.technicalQA?.actual?.duration ?? null,
            width: bestExp?.technicalQA?.actual?.width ?? null,
            height: bestExp?.technicalQA?.actual?.height ?? null,
            shotCount: ep.shots?.length ?? 0,
            hasVideo,
            hasCover,
            coverTimeSec: Number(ep.delivery?.coverTime ?? 0),
            updatedAt: ep.updatedAt ?? ep.createdAt ?? '',
        };
    });
    summaries.sort((a, b) => {
        if (a.hasVideo !== b.hasVideo)
            return a.hasVideo ? -1 : 1;
        return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
    return { connected: true, dataDir, episodes: summaries };
}
export function getSyncCutCoverPath(dataDir, episodeId, exportId) {
    if (!dataDir || !fs.existsSync(path.join(dataDir, 'studio.sqlite'))) {
        return null;
    }
    const { exports: exportsList, filesById } = readSyncCutRecords(dataDir);
    const matching = exportsList
        .filter((x) => x.episodeId === episodeId && (!exportId || x.id === exportId))
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    for (const exp of matching) {
        if (!exp.coverId)
            continue;
        const f = filesById.get(exp.coverId);
        if (f?.file &&
            fs.existsSync(f.file) &&
            isPathInsideDir(f.file, dataDir)) {
            return f.file;
        }
    }
    return null;
}
export function extractBriefFromSyncCutEpisode(ep, exportRec) {
    const cd = ep.delivery?.coverDesign;
    const coverKicker = stripCoverMarkdown(cd?.kicker ?? '');
    const coverHeadline = stripCoverMarkdown(cd?.headline ?? '');
    const coverSubline = stripCoverMarkdown(cd?.subline ?? '');
    const sanitizedTitle = sanitizePromptTitle(ep.title ?? '');
    const topic = ep.delivery?.publishTitle?.trim() ||
        (coverHeadline && coverSubline && coverHeadline.length < 36
            ? `${coverHeadline} — ${coverSubline}`
            : coverHeadline) ||
        sanitizedTitle;
    const narrations = (ep.shots ?? [])
        .map((s) => (s.narration || '').trim())
        .filter(Boolean);
    const cueTexts = (ep.delivery?.cues ?? [])
        .map((c) => (c.text || '').trim())
        .filter(Boolean);
    const transcriptText = narrations.length > 0 ? narrations.join('\n') : cueTexts.join('\n');
    const hook = [coverKicker, coverHeadline, coverSubline].filter(Boolean).join(' ') ||
        narrations[0] ||
        sanitizedTitle;
    const summarySource = ep.delivery?.description?.trim() ||
        narrations.slice(0, 3).join(' ') ||
        sanitizedTitle;
    const summary = summarySource.length > 320
        ? `${summarySource.slice(0, 319).trim()}…`
        : summarySource;
    const keyPoints = narrations
        .slice(0, 4)
        .map((n) => (n.length > 90 ? `${n.slice(0, 89).trim()}…` : n));
    // Build chapter timestamps if multi-shot >= 25s
    const totalDur = Number(exportRec?.technicalQA?.actual?.duration ?? 0);
    let timestampsText = '';
    const shots = ep.shots ?? [];
    if (shots.length >= 2 && totalDur >= 25) {
        let cur = 0;
        const step = totalDur / shots.length;
        const chLines = [];
        for (let i = 0; i < Math.min(shots.length, 8); i++) {
            const sh = shots[i];
            const dur = Number(sh.duration ?? 0) > 0 ? Number(sh.duration) : step;
            const labelSource = sh.title?.trim() || (sh.narration || '').trim() || `ช่วงที่ ${i + 1}`;
            const label = labelSource.length > 42
                ? `${labelSource.slice(0, 41).trim()}…`
                : labelSource;
            chLines.push(`${formatMmSs(cur)} ${label}`);
            cur += dur;
        }
        timestampsText = chLines.join('\n');
    }
    const rawTags = (ep.delivery?.tags || '')
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
    const coreHashtags = rawTags.map((t) => (t.startsWith('#') ? t : `#${t}`));
    const sources = (ep.sources ?? [])
        .filter((s) => s.title || s.url)
        .map((s) => ({
        title: (s.title || s.url || '').trim(),
        url: (s.url || '').trim(),
    }));
    const combinedSample = `${topic} ${transcriptText}`;
    const hasThai = /[\u0E00-\u0E7F]/.test(combinedSample);
    const visualStyle = ep.production?.visualStyle || undefined;
    return {
        topic,
        hook,
        summary,
        keyPoints,
        cta: '',
        coreHashtags,
        language: hasThai ? 'th' : 'en',
        tone: 'FRIENDLY',
        timestampsText: timestampsText || undefined,
        transcriptText: transcriptText || undefined,
        coverKicker: coverKicker || undefined,
        coverHeadline: coverHeadline || undefined,
        coverSubline: coverSubline || undefined,
        sources: sources.length > 0 ? sources : undefined,
        visualStyle,
        isSyntheticMedia: requiresRealisticAiDisclosure(visualStyle, true),
        coverTimestampMs: Math.max(0, Math.round(Number(ep.delivery?.coverTime ?? 0) * 1000)),
    };
}
export async function importSyncCutEpisode(params) {
    const { db, storage, dataDir, channelId, episodeId, exportId } = params;
    if (!dataDir || !fs.existsSync(path.join(dataDir, 'studio.sqlite'))) {
        throw new Error('ไม่พบฐานข้อมูล SyncCut Studio (studio.sqlite)');
    }
    const { episodes, exports: exportsList, filesById } = readSyncCutRecords(dataDir);
    const episode = episodes.find((e) => e.id === episodeId);
    if (!episode) {
        throw new Error(`ไม่พบ Episode ${episodeId} ใน SyncCut Studio`);
    }
    const matchingExports = exportsList
        .filter((x) => x.episodeId === episodeId && (!exportId || x.id === exportId))
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
    const bestExp = matchingExports.find((x) => x.file && fs.existsSync(x.file) && isPathInsideDir(x.file, dataDir));
    if (!bestExp?.file) {
        throw new Error('Episode นี้ยังไม่มีไฟล์วิดีโอ Export (final.mp4) ใน SyncCut');
    }
    const assetId = `med_${randomUUID().slice(0, 8)}`;
    const settings = db.getSettingsFull();
    const cleanName = sanitizePromptTitle(episode.title || episode.id)
        .replace(/[^a-zA-Z0-9\u0E00-\u0E7F_-]+/g, '_')
        .slice(0, 40);
    const saved = await storage.copyLocalVideoIntoStorage({
        assetId,
        sourcePath: bestExp.file,
        originalFilename: `${cleanName || 'synccut'}.mp4`,
        mimeType: 'video/mp4',
        settings,
    });
    const probe = await probeVideo(saved.localPath);
    const detection = detectRecommendedFormats(probe);
    const thumbDir = storage.resolveThumbnailDir(assetId);
    const thumbFiles = await extractThumbnails(saved.localPath, thumbDir, probe.durationSec);
    let customCoverKey = null;
    let customCoverPublicUrl = null;
    if (bestExp.coverId) {
        const coverRec = filesById.get(bestExp.coverId);
        if (coverRec?.file &&
            fs.existsSync(coverRec.file) &&
            isPathInsideDir(coverRec.file, dataDir)) {
            const savedCover = await storage.saveCustomCoverFromPath({
                assetId,
                sourceFilePath: coverRec.file,
                settings,
            });
            customCoverKey = savedCover.customCoverKey;
            customCoverPublicUrl = savedCover.customCoverPublicUrl;
        }
    }
    const asset = db.createMediaAsset({
        id: assetId,
        channelId,
        originalFilename: `${cleanName || 'synccut'}.mp4`,
        storageProvider: saved.storageProvider,
        storageKey: saved.storageKey,
        publicUrl: saved.publicUrl,
        thumbnailPaths: thumbFiles,
        customCoverKey,
        customCoverPublicUrl,
        sourceMeta: {
            sourceApp: 'SyncCut Studio',
            episodeId: episode.id,
            exportId: bestExp.id,
            coverTimeSec: Number(episode.delivery?.coverTime ?? 0),
            visualStyle: episode.production?.visualStyle || undefined,
            syntheticMedia: requiresRealisticAiDisclosure(episode.production?.visualStyle, true),
        },
        mimeType: 'video/mp4',
        fileSizeBytes: saved.sizeBytes,
        probe,
        orientation: detection.orientation,
        clipCategory: detection.clipCategory,
        status: 'READY',
    });
    const brief = extractBriefFromSyncCutEpisode(episode, bestExp);
    const templates = db.listTemplates(channelId);
    const gen = await generateMetadataWithAI({
        brief,
        formats: detection.recommendedFormats,
        templates,
        probe,
        settings,
    });
    const warningsByFormat = {};
    for (const fmt of CONTENT_FORMATS) {
        warningsByFormat[fmt] = validateVideoCompatibility(fmt, probe);
    }
    const issues = [];
    for (const fmt of detection.recommendedFormats) {
        const meta = gen.metadata[fmt];
        issues.push(...validateFormatMetadata(fmt, meta, probe));
    }
    return {
        asset,
        brief,
        metadata: gen.metadata,
        engineUsed: gen.engineUsed,
        warning: gen.warning,
        detection,
        warningsByFormat: warningsByFormat,
        issues,
    };
}
//# sourceMappingURL=synccut-bridge.js.map