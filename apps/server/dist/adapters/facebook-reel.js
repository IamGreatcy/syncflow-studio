import fs from 'node:fs/promises';
import { createReadStream, openAsBlob } from 'node:fs';
import { createHash } from 'node:crypto';
export const FACEBOOK_REELS_GRAPH_VERSION = 'v27.0';
const GRAPH = 'https://graph.facebook.com';
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001]);
const BUDGET_MS = 30 * 60_000;
const MAX_CHECKS = 16;
function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function id(value) {
    return typeof value === 'string' && /^\d{1,32}(?:_\d{1,32})?$/.test(value) ? value : undefined;
}
function number(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function trace(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}
function enumValue(value) {
    return typeof value === 'string' && /^(?:completed?|not_started|in_progress|error|failed|uploading|processing|ready|expired|upload_failed|upload_complete|draft|scheduled|published)$/.test(value) ? value : undefined;
}
function timestamp(value) {
    const ms = typeof value === 'number' ? value * 1000
        : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}
export function safeReelUrl(value, videoId) {
    if (typeof value !== 'string')
        return undefined;
    try {
        const url = new URL(value, 'https://www.facebook.com');
        if (url.origin === 'https://www.facebook.com' && ['/reel/' + videoId, '/reel/' + videoId + '/'].includes(url.pathname)) {
            return url.origin + url.pathname;
        }
    }
    catch { }
    return undefined;
}
function safeUploadUrl(value, videoId) {
    if (typeof value !== 'string')
        return undefined;
    try {
        const url = new URL(value);
        if (url.origin === 'https://rupload.facebook.com' && !url.username && !url.password && !url.search && !url.hash &&
            new RegExp('^/video-upload/(?:v\\d+\\.\\d+/)?' + videoId + '$').test(url.pathname)) {
            return url.href;
        }
    }
    catch { }
    return undefined;
}
export function endpoint(version, node, fields) {
    const url = new URL(GRAPH + '/' + version + '/' + node);
    if (fields)
        url.searchParams.set('fields', fields);
    return url;
}
export async function request(url, stage, token, now, init = {}, timeout = 15_000) {
    const at = now.toISOString();
    try {
        const response = await fetch(url, {
            ...init, redirect: 'error', signal: AbortSignal.timeout(timeout),
            headers: { Authorization: 'Bearer ' + token, ...init.headers },
        });
        const raw = object(await response.json().catch(() => null));
        const graphError = object(raw.error);
        const malformed = !Object.keys(raw).length;
        const code = number(graphError.code) ?? number(raw.error_code);
        const throttled = response.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code));
        const transient = throttled || graphError.is_transient === true || response.status >= 500 ||
            [408, 425].includes(response.status) || code === 1 || code === 2;
        const retry = response.headers.get('retry-after');
        const headerMs = retry === null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now.getTime();
        let regainMs = 0;
        if (throttled) {
            try {
                const usage = object(JSON.parse(response.headers.get('x-business-use-case-usage') ?? '{}'));
                for (const group of Object.values(usage)) {
                    for (const entry of Array.isArray(group) ? group : []) {
                        regainMs = Math.max(regainMs, (number(object(entry).estimated_time_to_regain_access) ?? 0) * 60_000);
                    }
                }
            }
            catch { }
        }
        const version = response.headers.get('facebook-api-version') ?? '';
        const report = {
            body: raw, httpStatus: response.status,
            fbtraceId: trace(graphError.fbtrace_id) ?? trace(raw.fbtrace_id) ?? trace(response.headers.get('x-fb-trace-id')),
            retryAfterMs: Math.max(0, regainMs, Number.isFinite(headerMs) ? headerMs : 0), throttled,
            version: /^v\d+\.\d+$/.test(version) ? version : undefined,
        };
        if (response.ok && !malformed && !Object.keys(graphError).length && code === undefined && raw.success !== false) {
            return report;
        }
        return {
            ...report,
            error: {
                stage, at, httpStatus: response.status, code,
                subcode: number(graphError.error_subcode) ?? number(raw.error_subcode),
                fbtraceId: report.fbtraceId,
            },
            rejected: !transient && (Object.keys(graphError).length > 0 || code !== undefined) && code !== 506,
        };
    }
    catch {
        return { body: {}, error: { stage, at } };
    }
}
function phaseError(phase) {
    const first = Array.isArray(phase.errors) ? phase.errors[0] : undefined;
    return object(phase.error ?? first);
}
export function inspect(body) {
    const status = object(body.status);
    const uploading = object(status.uploading_phase);
    const processing = object(status.processing_phase);
    const publishing = object(status.publishing_phase);
    const phases = {
        video: enumValue(status.video_status),
        uploading: enumValue(uploading.status),
        processing: enumValue(processing.status),
        publishing: enumValue(publishing.status),
        publishStatus: enumValue(publishing.publish_status),
        bytesTransferred: number(uploading.bytes_transferred) ?? number(uploading.bytes_transfered),
    };
    const complete = ['complete', 'completed'];
    const stageErrors = [
        ['publishing', phaseError(publishing), phases.publishing],
        ['processing', phaseError(processing), phases.processing],
        ['uploading', phaseError(uploading), phases.uploading],
    ];
    const failure = stageErrors.find(([, details, state]) => state === 'error' || state === 'failed' || Object.keys(details).length > 0);
    const failed = Boolean(failure) || phases.publishStatus === 'error' ||
        ['error', 'expired', 'upload_failed'].includes(phases.video ?? '');
    const published = complete.includes(phases.publishing ?? '') && phases.publishStatus === 'published';
    const unfinished = [phases.uploading, phases.processing].some((phase) => phase !== undefined && !complete.includes(phase));
    return {
        phases, failure,
        failed,
        published: published && !failed && !unfinished,
        contradictory: published && (failed || unfinished),
        scheduled: !failed && complete.includes(phases.publishing ?? '') && phases.publishStatus === 'scheduled',
        uploaded: complete.includes(phases.uploading ?? '') || phases.video === 'upload_complete',
        publishTime: timestamp(publishing.publish_time),
        sourceSize: number(uploading.source_file_size),
    };
}
export async function prepareFacebookReelMedia(ctx) {
    if (ctx.asset.probe.durationSec > 90)
        throw new Error('Reels duration exceeds 90 seconds.');
    const skipPrepend = process.env.SYNCFLOW_FB_SKIP_COVER_PREPEND === '1' && Boolean(ctx.thumbnailPath);
    const path = !skipPrepend &&
        ctx.hasCustomCover &&
        ctx.getCoverVideoPath &&
        ctx.asset.probe.durationSec + 0.2 <= 90
        ? await ctx.getCoverVideoPath()
        : ctx.localFilePath;
    if (path !== ctx.localFilePath) {
        ctx.log('INFO', 'FB_REELS_COVER_FRAME_INJECTED', 'Cover frame prepended before the Facebook Reel upload.');
    }
    return { path, thumbnailPath: ctx.thumbnailPath };
}
async function hashAndStatFile(filePath) {
    const st = await fs.stat(filePath);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return { size: st.size, sha256: hash.digest('hex') };
}
export async function runFacebookReel(ctx) {
    const { job, token, now, save, log } = ctx;
    const started = performance.now();
    const clock = () => new Date(now.getTime() + Math.floor(performance.now() - started));
    const at = now.toISOString();
    const reel = {
        graphVersion: FACEBOOK_REELS_GRAPH_VERSION, pageId: ctx.pageId, ...job.facebookReel,
    };
    const record = (patch = {}) => save({ ...patch, facebookReel: { ...reel } });
    function observe(reply, stage, malformed = false) {
        reel.effectiveGraphVersion = reply.version ?? reel.effectiveGraphVersion;
        const error = reply.error ?? (malformed ? { stage, at } : undefined);
        if (error)
            reel.lastApiError = error;
        if (reply.throttled) {
            const cooldown = Math.max(reply.retryAfterMs ?? 0, 60_000);
            reel.rateLimitedUntil = new Date(Math.min(8.64e15, clock().getTime() + cooldown)).toISOString();
        }
        log(error ? 'WARN' : 'INFO', 'FB_REEL_' + stage, error ? 'Meta request could not be confirmed' : 'Meta response received', {
            at: clock().toISOString(), httpStatus: reply.httpStatus, fbtraceId: reply.fbtraceId,
            ...error, videoId: reel.videoId, postId: reel.postId, graphVersion: reel.graphVersion,
            effectiveGraphVersion: reel.effectiveGraphVersion,
            ...(stage === 'STATUS' ? { phases: reel.phases } : {}),
        });
    }
    function wait(status, note = null, reply) {
        reel.verificationStartedAt ??= at;
        const attempts = reel.checks ?? 0;
        const delay = Math.max(Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attempts, 6) + Math.floor(Math.random() * 1_000)), reply?.retryAfterMs ?? 0, reply?.throttled ? 60_000 : 0);
        const due = Math.min(8.64e15, clock().getTime() + delay);
        const deadline = Date.parse(reel.verificationStartedAt) + BUDGET_MS;
        if (attempts >= MAX_CHECKS || due > deadline) {
            record({
                status: 'UNKNOWN', lastError: note ?? 'Meta did not confirm Reel publication within the verification window.',
                nextRetryAt: reply?.throttled || (reply?.retryAfterMs ?? 0) > 0 ? new Date(due).toISOString() : null,
            });
            return;
        }
        record({ status, nextRetryAt: new Date(due).toISOString(), lastError: note });
    }
    if (!token || !/^\d{1,32}$/.test(ctx.pageId) || reel.pageId !== ctx.pageId) {
        record({
            status: reel.videoId || reel.startRequestedAt ? 'UNKNOWN' : 'FAILED',
            lastError: 'Reconnect the original Facebook Page to verify this Reel.',
            nextRetryAt: null,
        });
        return;
    }
    let mediaInfo;
    let thumbnailPath = null;
    async function loadMediaFile() {
        try {
            const media = await ctx.loadMedia();
            thumbnailPath = media.thumbnailPath;
            const hashed = await hashAndStatFile(media.path);
            if (hashed.size > 0)
                return { path: media.path, ...hashed };
        }
        catch { }
        record({ status: 'FAILED', nextRetryAt: null, lastError: 'The Reel source could not be read.' });
    }
    const edge = endpoint(reel.graphVersion, reel.pageId + '/video_reels');
    if (!reel.videoId) {
        if (ctx.verifyOnly || reel.startRequestedAt || reel.legacy) {
            record({ status: 'UNKNOWN', nextRetryAt: null, lastError: 'No Facebook Video ID was recovered. Check the Page before creating another job.' });
            return;
        }
        const identity = await request(endpoint(reel.graphVersion, 'me', 'id'), 'PAGE_IDENTITY', token, now);
        observe(identity, 'PAGE_IDENTITY', identity.body.id !== ctx.pageId);
        if (identity.error || identity.body.id !== ctx.pageId) {
            const retryable = identity.error && !identity.rejected;
            if (retryable) {
                reel.checks = (reel.checks ?? 0) + 1;
                wait('PROCESSING', 'Waiting to verify the original Facebook Page token.', identity);
            }
            else {
                record({ status: 'FAILED', nextRetryAt: null, lastError: 'The token does not match the configured Facebook Page.' });
            }
            return;
        }
        mediaInfo = await loadMediaFile();
        if (!mediaInfo)
            return;
        reel.startRequestedAt = clock().toISOString();
        record({ status: 'PREUPLOADING' });
        const response = await request(edge, 'START', token, clock(), {
            method: 'POST', body: new URLSearchParams({ upload_phase: 'start', access_token: token }),
        });
        reel.videoId = id(response.body.video_id);
        const uploadUrl = reel.videoId && safeUploadUrl(response.body.upload_url, reel.videoId);
        observe(response, 'START', !uploadUrl);
        if (!reel.videoId) {
            if (response.throttled && (response.error?.httpStatus === 429 || response.error?.code !== undefined)) {
                // Meta explicitly declined to initialize. No Video ID, upload or finish exists for this response.
                reel.startRequestedAt = undefined;
                reel.checks = (reel.checks ?? 0) + 1;
                wait('PROCESSING', 'Meta rate-limited the upload initialization.', response);
                return;
            }
            record({
                status: response.rejected ? 'FAILED' : 'UNKNOWN',
                nextRetryAt: null,
                lastError: 'Meta did not return a usable Facebook Video ID. No upload or publish request followed.',
            });
            return;
        }
        reel.initializedAt = clock().toISOString();
        reel.uploadUrl = !response.error && uploadUrl ? uploadUrl : undefined;
        record();
    }
    const videoId = reel.videoId;
    const video = (fields) => endpoint(reel.graphVersion, videoId, fields);
    const finishMayExist = Boolean(reel.finishRequestedAt || reel.legacy);
    const ongoingStatus = finishMayExist ? 'PUBLISH_REQUESTED' : 'PROCESSING';
    let offset = 0;
    if (ctx.verifyOnly || finishMayExist || (reel.uploadRequestedAt && !reel.uploadedAt) || !reel.uploadUrl) {
        const response = await request(video('status'), 'STATUS', token, now);
        reel.statusCheckedAt = clock().toISOString();
        reel.checks = (reel.checks ?? 0) + 1;
        const info = inspect(response.body);
        const recognizable = Object.values(info.phases).some((v) => v !== undefined);
        if (recognizable && response.body.id === videoId)
            reel.phases = info.phases;
        observe(response, 'STATUS', !recognizable || response.body.id !== videoId);
        if (response.error || response.body.id !== videoId || !recognizable) {
            if (response.rejected || ctx.verifyOnly) {
                record({
                    status: 'UNKNOWN', lastError: 'Meta did not return a verifiable status for this Video ID.',
                    nextRetryAt: reel.rateLimitedUntil && reel.rateLimitedUntil > clock().toISOString() ? reel.rateLimitedUntil : null,
                });
            }
            else {
                wait(ongoingStatus, 'Waiting for a verifiable Meta status.', response);
            }
            return;
        }
        if (info.published) {
            const metadata = await request(video('id,permalink_url,published,post_id'), 'METADATA', token, clock());
            observe(metadata, 'METADATA', metadata.body.id !== videoId);
            if (!metadata.error && metadata.body.id === videoId && metadata.body.published === false) {
                if (ctx.verifyOnly) {
                    record({ status: 'UNKNOWN', nextRetryAt: null, lastError: 'Meta returned conflicting publication and visibility states.' });
                }
                else {
                    wait('PUBLISH_REQUESTED', 'Meta returned conflicting publication and visibility states.');
                }
                return;
            }
            reel.confirmedAt = reel.statusCheckedAt;
            reel.publishTime = info.publishTime;
            if (!metadata.error && metadata.body.id === videoId) {
                reel.postId = id(metadata.body.post_id) ?? reel.postId;
            }
            record({
                status: 'PUBLISHED', nextRetryAt: null, lastError: null,
                externalPostId: reel.postId ?? null,
                externalUrl: !metadata.error && metadata.body.id === videoId
                    ? safeReelUrl(metadata.body.permalink_url, videoId) ?? null : job.externalUrl,
            });
            log('INFO', 'FB_REEL_PUBLISHED', 'Meta confirmed publication', {
                videoId, postId: reel.postId, publishTime: reel.publishTime, effectiveGraphVersion: reel.effectiveGraphVersion,
            });
            return;
        }
        if (info.contradictory) {
            record({ status: 'UNKNOWN', nextRetryAt: null, lastError: 'Meta returned conflicting Reel publication phases.' });
            return;
        }
        if (info.failed) {
            const [stage, details] = info.failure ?? ['status', {}];
            reel.lastApiError = {
                stage, at, code: number(details.code) ?? number(details.error_code), subcode: number(details.error_subcode),
                fbtraceId: trace(details.fbtrace_id),
            };
            log('ERROR', 'FB_REEL_PHASE_FAILED', 'Meta reported a Reel phase failure', { ...reel.lastApiError, videoId });
            record({ status: 'FAILED', nextRetryAt: null, lastError: 'Meta reported a Facebook Reel ' + stage + ' failure.' });
            return;
        }
        if (info.scheduled && now.getTime() < Date.parse(job.scheduledAt)) {
            reel.publishTime = info.publishTime;
            reel.verificationStartedAt = undefined;
            reel.checks = 0;
            record({ status: 'NATIVE_SCHEDULED', nextRetryAt: null, lastError: null });
            return;
        }
        if (ctx.verifyOnly) {
            record({ status: 'UNKNOWN', nextRetryAt: null, lastError: 'Meta has not confirmed publication for this Video ID.' });
            return;
        }
        if (finishMayExist) {
            wait(info.phases.processing === 'in_progress' ? 'PROCESSING' : 'PUBLISH_REQUESTED');
            return;
        }
        if (info.uploaded && reel.uploadRequestedAt && (info.phases.bytesTransferred === undefined ||
            info.phases.bytesTransferred === reel.fileSize) && (info.sourceSize === undefined || info.sourceSize === reel.fileSize)) {
            reel.uploadedAt ??= at;
        }
        else if (reel.uploadUrl && info.phases.uploading &&
            ['in_progress', 'not_started', 'uploading'].includes(info.phases.uploading) &&
            info.phases.bytesTransferred !== undefined && reel.fileSize !== undefined &&
            info.phases.bytesTransferred < reel.fileSize &&
            (info.sourceSize === undefined || info.sourceSize === reel.fileSize)) {
            offset = info.phases.bytesTransferred;
        }
        else {
            wait('PROCESSING', 'Waiting for Meta to confirm upload progress.');
            return;
        }
    }
    if (!reel.uploadedAt) {
        mediaInfo ??= await loadMediaFile();
        if (!mediaInfo)
            return;
        const digest = mediaInfo.sha256;
        const uploadUrl = safeUploadUrl(reel.uploadUrl, videoId);
        if (!uploadUrl || !mediaInfo.size || (reel.fileSha256 && reel.fileSha256 !== digest)) {
            record({ status: 'UNKNOWN', nextRetryAt: null, lastError: 'The original Reel upload session or source file could not be validated.' });
            return;
        }
        reel.fileSha256 = digest;
        reel.fileSize = mediaInfo.size;
        reel.uploadRequestedAt = clock().toISOString();
        record({ status: 'PREUPLOADING' });
        let uploadBody;
        if (mediaInfo.size > 16 * 1024 * 1024) {
            const fileBlob = await openAsBlob(mediaInfo.path, { type: 'application/octet-stream' });
            uploadBody = (offset > 0 ? fileBlob.slice(offset) : fileBlob);
        }
        else {
            const buf = await fs.readFile(mediaInfo.path);
            uploadBody = (offset > 0 ? buf.subarray(offset) : buf);
        }
        const response = await request(uploadUrl, 'UPLOAD', token, clock(), {
            method: 'POST',
            headers: { Authorization: 'OAuth ' + token, offset: String(offset), file_size: String(mediaInfo.size), 'Content-Type': 'application/octet-stream' },
            body: uploadBody,
        }, 90_000);
        observe(response, 'UPLOAD', response.body.success !== true);
        if (response.error || response.body.success !== true) {
            wait('PROCESSING', 'Waiting for Meta to confirm bytes received before resuming.', response);
            return;
        }
        reel.uploadedAt = clock().toISOString();
    }
    record({ status: 'UPLOADED', nextRetryAt: null, lastError: null });
    const scheduledMs = Date.parse(job.scheduledAt);
    const remainingMs = scheduledMs - clock().getTime();
    if (ctx.nativeSchedule && remainingMs > 0 && remainingMs < 10 * 60_000) {
        // Keep the uploaded bytes and wait for the slot instead of publishing early.
        record({ status: 'UPLOADED', nextRetryAt: job.scheduledAt, lastError: null });
        return;
    }
    const nativeSchedule = ctx.nativeSchedule && remainingMs >= 10 * 60_000;
    const meta = job.metadataSnapshot;
    const finish = new URLSearchParams({
        upload_phase: 'finish', video_id: videoId, description: meta.description || '', access_token: token,
        video_state: nativeSchedule ? 'SCHEDULED' : 'PUBLISHED',
    });
    if (meta.title)
        finish.set('title', meta.title);
    if (meta.isAiGenerated)
        finish.set('is_ai_generated', 'true');
    if (nativeSchedule)
        finish.set('scheduled_publish_time', String(Math.floor(scheduledMs / 1000)));
    // Persist intent before the only finish POST. Recovery always reads this Video ID.
    reel.finishRequestedAt = clock().toISOString();
    reel.verificationStartedAt = reel.finishRequestedAt;
    reel.checks = 0;
    record({ status: 'PUBLISH_REQUESTED' });
    const response = await request(edge, 'FINISH', token, clock(), { method: 'POST', body: finish });
    observe(response, 'FINISH', response.body.success !== true);
    if (!response.error && response.body.success === true) {
        reel.finishAcceptedAt = clock().toISOString();
        reel.postId = id(response.body.post_id) ?? reel.postId;
    }
    wait('PUBLISH_REQUESTED', reel.finishAcceptedAt ? null : 'Finish response was inconclusive. Checking the existing Facebook Video ID.', response);
    if (reel.finishAcceptedAt && !response.throttled && thumbnailPath) {
        try {
            const form = new FormData();
            form.append('is_preferred', 'true');
            form.append('source', new Blob([await fs.readFile(thumbnailPath)], { type: 'image/jpeg' }), 'cover.jpg');
            const thumb = await request(endpoint(reel.graphVersion, videoId + '/thumbnails'), 'THUMBNAIL', token, clock(), { method: 'POST', body: form }, 5_000);
            observe(thumb, 'THUMBNAIL', thumb.body.success === false);
            if (thumb.throttled)
                wait('PUBLISH_REQUESTED', null, thumb);
            else if (thumb.error)
                record();
            if (!thumb.error && thumb.body.success !== false)
                log('INFO', 'FB_THUMBNAIL_SET', 'Meta accepted the Reel cover', { videoId });
        }
        catch {
            log('WARN', 'FB_REEL_THUMBNAIL', 'The Reel cover could not be attached', { videoId });
        }
    }
}
//# sourceMappingURL=facebook-reel.js.map