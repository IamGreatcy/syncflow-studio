import fs from 'node:fs';
import path from 'node:path';
import { getAdapter, tiktokAdapter } from '../adapters/registry.js';
import { formatTikTokAccountDisplayName } from '../adapters/tiktok.js';
import { publishViaUnifiedApi } from '../adapters/unified.js';
import { prepareFacebookReelMedia, runFacebookReel } from '../adapters/facebook-reel.js';
import { formatErrorWithCause, isTransientNetworkError, } from '../services/net-resilience.js';
const MAX_NETWORK_OUTAGE_RETRIES = 72; // ~6 hours at capped 5-minute interval
export function isOfficialFacebookReel(job) {
    return job.format === 'FACEBOOK_REELS' && Boolean(job.facebookReel || job.connectionMode === 'LIVE_OFFICIAL');
}
export function hasFacebookReelIntent(job) {
    return isOfficialFacebookReel(job) && Boolean(job.facebookReel?.startRequestedAt || job.facebookReel?.videoId || job.facebookReel?.legacy ||
        job.externalPostId || ['PREUPLOADING', 'PUBLISHING', 'UNKNOWN'].includes(job.status));
}
export function facebookReelRuntime(env) {
    const environment = env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_DEPLOYMENT_ID ? 'railway' : 'local';
    const owner = env.SYNCFLOW_FACEBOOK_REEL_OWNER?.trim() || 'disabled';
    return { environment, owner, allowed: owner === 'railway' && environment === 'railway' };
}
export class SchedulerEngine {
    db;
    storage;
    liveFacebookReelsEnabled;
    timer = null;
    tokenTimer = null;
    maintenanceTimer = null;
    isTickRunning = false;
    currentTickPromise = null;
    tokenRefreshLocks = new Map();
    lastTickAt = null;
    lastBackupAt = null;
    constructor(db, storage, liveFacebookReelsEnabled = true) {
        this.db = db;
        this.storage = storage;
        this.liveFacebookReelsEnabled = liveFacebookReelsEnabled;
    }
    start(intervalMs = 15_000) {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.tick().catch((err) => {
                console.error('[Scheduler] tick error:', err);
            });
        }, intervalMs);
        // Proactive token refresh sweep every 30 minutes
        this.tokenTimer = setInterval(() => {
            void this.refreshExpiringTokens().catch((err) => {
                console.error('[Scheduler] token sweep error:', err);
            });
        }, 30 * 60_000);
        // Daily R2 backup + stale cache & expired media garbage collection (every 24h)
        this.maintenanceTimer = setInterval(() => {
            void this.runDailyMaintenance().catch((err) => {
                console.error('[Scheduler] maintenance error:', err);
            });
        }, 24 * 60 * 60_000);
        this.maintenanceTimer.unref?.();
        // Kick off an initial tick shortly after boot
        setTimeout(() => {
            void this.tick().catch(() => { });
        }, 1000);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.tokenTimer) {
            clearInterval(this.tokenTimer);
            this.tokenTimer = null;
        }
        if (this.maintenanceTimer) {
            clearInterval(this.maintenanceTimer);
            this.maintenanceTimer = null;
        }
    }
    async stopAndDrain(timeoutMs = 15_000) {
        this.stop();
        if (!this.currentTickPromise)
            return;
        await Promise.race([
            this.currentTickPromise.catch(() => { }),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
    }
    async runDailyMaintenance(retentionDays = 30) {
        const settings = this.db.getSettingsFull();
        let backupKey = null;
        try {
            const backupRes = await this.storage.backupDatabaseToR2((dest) => this.db.backupToFile(dest), settings, 14);
            backupKey = backupRes.uploadedKey;
            if (backupKey)
                this.lastBackupAt = new Date().toISOString();
        }
        catch (err) {
            console.error('[Scheduler] R2 SQLite backup failed:', err);
        }
        const prunedCoverCache = await this.storage.pruneOldCoverCache(7).catch(() => 0);
        let reclaimedMediaAssets = 0;
        try {
            const expiredAssets = this.db.listExpiredMediaAssets(retentionDays);
            for (const asset of expiredAssets) {
                await this.storage.deleteMediaAssetFiles(asset, settings);
                reclaimedMediaAssets++;
            }
        }
        catch (err) {
            console.error('[Scheduler] Expired media GC failed:', err);
        }
        return { backupKey, prunedCoverCache, reclaimedMediaAssets };
    }
    nudge() {
        setTimeout(() => {
            void this.tick().catch(() => { });
        }, 50);
    }
    async tick(now = new Date()) {
        if (this.isTickRunning) {
            return { processed: 0, results: [] };
        }
        this.isTickRunning = true;
        this.lastTickAt = now.toISOString();
        const tickStartedAt = performance.now();
        const runPromise = (async () => {
            try {
                const dueJobs = this.db.claimDueJobs(now.toISOString(), 10, this.liveFacebookReelsEnabled);
                const results = [];
                const seenLiveOfficialAccountIds = new Set();
                for (const job of dueJobs) {
                    const acc = this.db.getAccount(job.socialAccountId);
                    if (acc?.connectionMode === 'LIVE_OFFICIAL') {
                        if (seenLiveOfficialAccountIds.has(job.socialAccountId)) {
                            const staggeredRetry = new Date(now.getTime() + 90_000).toISOString();
                            this.db.updateJob(job.id, {
                                lockedUntil: null,
                                nextRetryAt: staggeredRetry,
                            }, isOfficialFacebookReel(job) ? job.lockedUntil ?? undefined : undefined);
                            results.push({ jobId: job.id, status: job.status });
                            continue;
                        }
                        seenLiveOfficialAccountIds.add(job.socialAccountId);
                    }
                    const jobTime = isOfficialFacebookReel(job)
                        ? new Date(now.getTime() + Math.floor(performance.now() - tickStartedAt)) : now;
                    const updated = await this.executeClaimedJob(job, jobTime, false);
                    results.push({ jobId: job.id, status: updated.status });
                }
                return { processed: results.length, results };
            }
            finally {
                this.isTickRunning = false;
                this.currentTickPromise = null;
            }
        })();
        this.currentTickPromise = runPromise;
        return runPromise;
    }
    async runJobNow(jobId, now = new Date()) {
        const current = this.db.getJob(jobId);
        if (current && isOfficialFacebookReel(current))
            this.requireFacebookReelOwner();
        const claimed = this.db.claimSpecificJob(jobId, now.toISOString());
        if (!claimed) {
            const existing = this.db.getJob(jobId);
            if (!existing)
                throw new Error('ไม่พบงานที่ระบุ');
            throw new Error(`ไม่สามารถรันงานสถานะ ${existing.status} หรือมี worker กำลังทำงานอยู่`);
        }
        if (hasFacebookReelIntent(claimed)) {
            return this.executeFacebookReel(claimed, now, false, true);
        }
        return this.executeClaimedJob(claimed, now, true);
    }
    async verifyFacebookReel(jobId, now = new Date()) {
        const existing = this.db.getJob(jobId);
        if (!existing || !isOfficialFacebookReel(existing) || !existing.facebookReel?.videoId ||
            existing.status === 'CANCELLED' || existing.status === 'PUBLISHED') {
            throw new Error('This job has no Facebook Reel awaiting verification.');
        }
        const claimed = this.db.claimSpecificJob(jobId, now.toISOString());
        if (!claimed)
            throw new Error('This check is already running or waiting for Meta’s retry window.');
        return this.executeFacebookReel(claimed, now, false, true);
    }
    requireFacebookReelOwner() {
        if (!this.liveFacebookReelsEnabled) {
            throw new Error('Live Facebook Reel scheduling is disabled on this SyncFlow instance. Use the designated publisher.');
        }
    }
    async rescheduleJobExternal(jobId, newScheduledAtIso, newPrewarmAtIso, newStrategy) {
        const job = this.db.getJob(jobId);
        if (!job)
            throw new Error('Job not found');
        if (job.status === 'PUBLISHED' || job.status === 'CANCELLED') {
            return job;
        }
        if (isOfficialFacebookReel(job)) {
            this.requireFacebookReelOwner();
            if (hasFacebookReelIntent(job) || (job.lockedUntil && Date.parse(job.lockedUntil) >= Date.now())) {
                throw new Error('Verify and manage the existing Reel on Facebook before changing this job.');
            }
        }
        if (job.status === 'NATIVE_SCHEDULED' && (job.externalPostId || job.facebookReel?.videoId)) {
            const ctx = await this.buildContext(job);
            const adapter = getAdapter(job.platform);
            if (adapter.updateSchedule) {
                await adapter.updateSchedule({ ctx, newScheduledAtIso });
                this.db.addJobLog(job.id, 'INFO', 'RESCHEDULED_NATIVE', `อัปเดตเวลาโพสต์ล่วงหน้าบน ${job.platform} เป็น ${newScheduledAtIso}`);
            }
            return this.db.updateJob(job.id, {
                scheduledAt: newScheduledAtIso,
                prewarmAt: newPrewarmAtIso,
            });
        }
        this.db.addJobLog(job.id, 'INFO', 'RESCHEDULED_QUEUE', `ปรับเวลาในคิวเป็น ${newScheduledAtIso} (${newStrategy})`);
        return this.db.updateJob(job.id, {
            scheduledAt: newScheduledAtIso,
            prewarmAt: newPrewarmAtIso,
            strategy: newStrategy,
            status: 'QUEUED',
            externalContainerId: null,
            nextRetryAt: null,
            lastError: null,
        });
    }
    async cancelJob(jobId) {
        const job = this.db.getJob(jobId);
        if (!job)
            throw new Error('Job not found');
        if (job.status === 'PUBLISHED') {
            throw new Error('งานนี้เผยแพร่สำเร็จแล้ว ไม่สามารถยกเลิกคิวได้');
        }
        if (isOfficialFacebookReel(job)) {
            this.requireFacebookReelOwner();
            if (hasFacebookReelIntent(job) || (job.lockedUntil && Date.parse(job.lockedUntil) >= Date.now())) {
                throw new Error('An existing Facebook Reel must be managed on Facebook; refreshing its status is safe.');
            }
        }
        if (job.status === 'NATIVE_SCHEDULED' && (job.externalPostId || job.facebookReel?.videoId)) {
            try {
                const ctx = await this.buildContext(job);
                const adapter = getAdapter(job.platform);
                if (adapter.cancelSchedule) {
                    await adapter.cancelSchedule(ctx);
                }
            }
            catch (err) {
                if (isOfficialFacebookReel(job))
                    throw err;
                this.db.addJobLog(job.id, 'WARN', 'CANCEL_REMOTE_WARN', `ยกเลิกบนแพลตฟอร์มปลายทางไม่สำเร็จ: ${formatErrorWithCause(err)}`);
            }
        }
        this.db.addJobLog(job.id, 'INFO', 'JOB_CANCELLED', 'ยกเลิกงานเรียบร้อย');
        return this.db.updateJob(job.id, {
            status: 'CANCELLED',
            lockedUntil: null,
        });
    }
    async refreshAccountTokenLocked(accountId, maxRemainingMs = 24 * 3600_000, now = new Date()) {
        const existing = this.tokenRefreshLocks.get(accountId);
        if (existing)
            return existing;
        const promise = (async () => {
            const full = this.db.getAccountWithSecrets(accountId);
            if (!full || full.account.connectionMode !== 'LIVE_OFFICIAL')
                return false;
            if (!full.account.tokenExpiresAt || !full.refreshToken)
                return false;
            const expMs = new Date(full.account.tokenExpiresAt).getTime();
            if (expMs - now.getTime() > maxRemainingMs)
                return false;
            const adapter = getAdapter(full.account.platform);
            if (!adapter.refreshAccessToken)
                return false;
            try {
                const settings = this.db.getSettingsFull();
                const nextTokens = await adapter.refreshAccessToken(full.refreshToken, settings);
                this.db.updateAccount(accountId, {
                    accessToken: nextTokens.accessToken,
                    refreshToken: nextTokens.refreshToken ?? full.refreshToken,
                    tokenExpiresAt: nextTokens.expiresAt ?? null,
                    status: 'CONNECTED',
                });
                return true;
            }
            catch (err) {
                if (!isTransientNetworkError(err)) {
                    this.db.updateAccount(accountId, { status: 'NEEDS_REAUTH' });
                }
                return false;
            }
        })().finally(() => {
            this.tokenRefreshLocks.delete(accountId);
        });
        this.tokenRefreshLocks.set(accountId, promise);
        return promise;
    }
    async refreshExpiringTokens(now = new Date()) {
        const accounts = this.db.listAccounts();
        let refreshed = 0;
        for (const acc of accounts) {
            if (acc.connectionMode !== 'LIVE_OFFICIAL')
                continue;
            if (!acc.tokenExpiresAt)
                continue;
            const expMs = new Date(acc.tokenExpiresAt).getTime();
            if (expMs - now.getTime() > 24 * 3600_000)
                continue;
            if (await this.refreshAccountTokenLocked(acc.id, 24 * 3600_000, now)) {
                refreshed++;
            }
        }
        return refreshed;
    }
    async buildContext(job) {
        const accountData = this.db.getAccountWithSecrets(job.socialAccountId);
        if (!accountData) {
            throw new Error(`ไม่พบบัญชีโซเชียล ${job.socialAccountId}`);
        }
        const content = this.db.getContent(job.contentItemId);
        if (!content?.mediaAsset) {
            throw new Error(`ไม่พบไฟล์วิดีโอสำหรับคอนเทนต์ ${job.contentItemId}`);
        }
        const settings = this.db.getSettingsFull();
        const asset = content.mediaAsset;
        const storageKey = asset.optimizedStorageKey || asset.storageKey;
        const localFilePath = await this.storage.ensureLocalFile(storageKey, settings);
        const customCoverPath = asset.customCoverKey
            ? await this.storage.ensureCustomCover(asset.id, settings)
            : null;
        if (customCoverPath &&
            fs.existsSync(customCoverPath) &&
            !asset.customCoverPublicUrl) {
            try {
                const sync = await this.storage.syncLocalFileToStorage({
                    localPath: customCoverPath,
                    storageKey: `covers/${asset.id}_cover.jpg`,
                    mimeType: 'image/jpeg',
                    settings,
                });
                if (sync.publicUrl) {
                    this.db.updateMediaAssetCover(asset.id, asset.customCoverKey, sync.publicUrl);
                    asset.customCoverPublicUrl = sync.publicUrl;
                }
            }
            catch {
                // Best-effort R2 backfill for cover_url
            }
        }
        let thumbnailPath = customCoverPath && fs.existsSync(customCoverPath) ? customCoverPath : null;
        if (!thumbnailPath && asset.thumbnailPaths.length > 0) {
            const ytMeta = job.metadataSnapshot;
            const idx = typeof ytMeta.thumbnailIndex === 'number' &&
                asset.thumbnailPaths[ytMeta.thumbnailIndex]
                ? ytMeta.thumbnailIndex
                : 0;
            const candidate = path.join(this.storage.resolveThumbnailDir(asset.id), asset.thumbnailPaths[idx]);
            thumbnailPath = candidate;
        }
        const hasCustomCover = Boolean(customCoverPath && fs.existsSync(customCoverPath));
        // Refresh token right before execution if expiring within 60 minutes (per-account mutex prevents refresh races)
        if (accountData.account.connectionMode === 'LIVE_OFFICIAL' &&
            accountData.account.tokenExpiresAt &&
            accountData.refreshToken) {
            const expMs = new Date(accountData.account.tokenExpiresAt).getTime();
            if (expMs - Date.now() < 60 * 60_000) {
                await this.refreshAccountTokenLocked(accountData.account.id, 60 * 60_000);
            }
        }
        const latestAccountData = this.db.getAccountWithSecrets(job.socialAccountId) ?? accountData;
        const accessToken = latestAccountData.accessToken;
        const refreshToken = latestAccountData.refreshToken;
        return {
            job,
            account: accountData.account,
            accessToken,
            refreshToken,
            asset,
            localFilePath,
            thumbnailPath,
            hasCustomCover,
            getCoverVideoPath: async () => hasCustomCover && customCoverPath
                ? this.storage.ensureCoverPrependedVideo({
                    assetId: asset.id,
                    videoPath: localFilePath,
                    coverPath: customCoverPath,
                    probe: asset.probe,
                })
                : localFilePath,
            onContainerCreated: (containerId, createdAtIso) => {
                const latest = this.db.getJob(job.id);
                const snap = {
                    ...(latest?.metadataSnapshot ?? job.metadataSnapshot),
                    __containerCreatedAt: createdAtIso,
                };
                this.db.updateJob(job.id, {
                    externalContainerId: containerId,
                    metadataSnapshot: snap,
                });
                job.externalContainerId = containerId;
                job.metadataSnapshot = snap;
            },
            settings,
            log: (level, stage, message, details) => {
                this.db.addJobLog(job.id, level, stage, message, details ?? null);
            },
        };
    }
    async executeClaimedJob(job, now, forcePublishNow) {
        if (isOfficialFacebookReel(job)) {
            return this.executeFacebookReel(job, now, forcePublishNow, false);
        }
        const initialStatus = job.status;
        try {
            const ctx = await this.buildContext(job);
            const scheduledMs = new Date(job.scheduledAt).getTime();
            const isDueToPublish = forcePublishNow || now.getTime() >= scheduledMs;
            // Handle Unified API mode
            if (ctx.account.connectionMode === 'UNIFIED_API') {
                if (!isDueToPublish) {
                    return this.db.updateJob(job.id, {
                        strategy: 'JIT_PUBLISH',
                        lockedUntil: null,
                    });
                }
                this.db.updateJob(job.id, { status: 'PUBLISHING' });
                const pub = await publishViaUnifiedApi(ctx);
                this.db.addJobLog(job.id, 'INFO', 'UNIFIED_PUBLISHED', 'เผยแพร่ผ่าน Unified API สำเร็จ', { externalPostId: pub.externalPostId });
                return this.db.updateJob(job.id, {
                    status: 'PUBLISHED',
                    externalPostId: pub.externalPostId,
                    externalUrl: pub.externalUrl,
                    lockedUntil: null,
                    lastError: null,
                    nextRetryAt: null,
                });
            }
            const adapter = getAdapter(job.platform);
            const effectiveStatus = job.status === 'PREUPLOADING' || job.status === 'PREWARMING'
                ? 'QUEUED'
                : job.status === 'PUBLISHING'
                    ? job.externalPostId
                        ? 'NATIVE_SCHEDULED'
                        : 'READY_TO_PUBLISH'
                    : job.status;
            if (effectiveStatus !== job.status) {
                this.db.addJobLog(job.id, 'WARN', 'STALE_JOB_RECOVERED', `กู้คืนงาน ${job.format} ที่ค้างในสถานะ ${job.status} หลังหมดเวลาล็อก → ดำเนินการต่อในสถานะ ${effectiveStatus}`);
            }
            // Step 1: Native Pre-upload (YouTube / Facebook) or Inbox Draft (TikTok)
            if (!forcePublishNow &&
                effectiveStatus === 'QUEUED' &&
                (job.strategy === 'NATIVE_PREUPLOAD' || job.strategy === 'INBOX_DRAFT') &&
                adapter.preUploadSchedule) {
                this.db.updateJob(job.id, { status: 'PREUPLOADING' });
                const preRes = await adapter.preUploadSchedule(ctx);
                return this.db.updateJob(job.id, {
                    status: preRes.status,
                    externalPostId: preRes.externalPostId,
                    externalUrl: preRes.externalUrl,
                    lockedUntil: null,
                    lastError: null,
                    nextRetryAt: null,
                });
            }
            // Step 2: JIT Pre-warm (Instagram container creation + processing wait ahead of scheduled time)
            if (!forcePublishNow &&
                !isDueToPublish &&
                effectiveStatus === 'QUEUED' &&
                job.strategy === 'JIT_PUBLISH') {
                this.db.updateJob(job.id, { status: 'PREWARMING' });
                let containerId = job.externalContainerId;
                let nextSnapshot = { ...job.metadataSnapshot };
                if (adapter.preWarm) {
                    const warmRes = await adapter.preWarm(ctx);
                    containerId = warmRes.externalContainerId;
                    nextSnapshot = {
                        ...nextSnapshot,
                        __containerCreatedAt: warmRes.containerCreatedAt,
                    };
                }
                else {
                    if (ctx.hasCustomCover && ctx.getCoverVideoPath) {
                        await ctx.getCoverVideoPath().catch(() => { });
                    }
                    if (job.platform === 'TIKTOK' &&
                        ctx.account.connectionMode === 'LIVE_OFFICIAL' &&
                        ctx.accessToken) {
                        try {
                            const info = await tiktokAdapter.fetchCreatorInfo(ctx.accessToken, false);
                            const cleanName = formatTikTokAccountDisplayName(info, ctx.account.accountName);
                            this.db.updateAccount(ctx.account.id, {
                                creatorInfo: info,
                                accountName: cleanName,
                            });
                        }
                        catch {
                            // Best-effort creator_info warm-up; publishNow has cached fallback
                        }
                    }
                    this.db.addJobLog(job.id, 'INFO', 'JIT_PREWARM_READY', `เตรียมความพร้อมไฟล์และ Token สำหรับ ${job.format} เรียบร้อย รอเผยแพร่เวลา ${job.scheduledAt}`);
                }
                return this.db.updateJob(job.id, {
                    status: 'READY_TO_PUBLISH',
                    externalContainerId: containerId,
                    metadataSnapshot: nextSnapshot,
                    lockedUntil: null,
                    lastError: null,
                    nextRetryAt: null,
                });
            }
            // Step 3: Publish Now (due scheduled time or manual Run Now)
            if (isDueToPublish) {
                this.db.updateJob(job.id, { status: 'PUBLISHING' });
                const pubRes = await adapter.publishNow(ctx);
                if (pubRes.inboxDraft) {
                    this.db.addJobLog(job.id, 'WARN', 'TIKTOK_INBOX_DRAFT_READY', 'ส่งคลิปเข้า TikTok App Inbox (Draft) สำเร็จ — กรุณาเปิดแอป TikTok บนมือถือเพื่อกดเผยแพร่สาธารณะ', { externalPostId: pubRes.externalPostId, externalUrl: pubRes.externalUrl });
                    return this.db.updateJob(job.id, {
                        status: 'PUBLISHED',
                        externalPostId: pubRes.externalPostId,
                        externalUrl: pubRes.externalUrl,
                        metadataSnapshot: {
                            ...job.metadataSnapshot,
                            __tiktokInboxDraft: true,
                        },
                        lockedUntil: null,
                        lastError: 'ส่งเข้า TikTok App Inbox (Draft) แล้ว — กดเผยแพร่ต่อในแอป TikTok',
                        nextRetryAt: null,
                    });
                }
                this.db.addJobLog(job.id, 'INFO', 'PUBLISHED', `เผยแพร่คลิปบน ${job.format} สำเร็จ`, { externalPostId: pubRes.externalPostId, externalUrl: pubRes.externalUrl });
                return this.db.updateJob(job.id, {
                    status: 'PUBLISHED',
                    externalPostId: pubRes.externalPostId,
                    externalUrl: pubRes.externalUrl,
                    lockedUntil: null,
                    lastError: null,
                    nextRetryAt: null,
                });
            }
            // Not due yet — release lock safely
            return this.db.updateJob(job.id, { lockedUntil: null });
        }
        catch (err) {
            const errorMsg = formatErrorWithCause(err);
            const isNetTransient = isTransientNetworkError(err);
            const nextRetryCount = job.retryCount + 1;
            const effectiveMaxRetries = isNetTransient
                ? Math.max(job.maxRetries, MAX_NETWORK_OUTAGE_RETRIES)
                : job.maxRetries;
            const canRetry = !forcePublishNow && nextRetryCount <= effectiveMaxRetries;
            const safeRecoveryStatus = initialStatus === 'NATIVE_SCHEDULED'
                ? 'NATIVE_SCHEDULED'
                : initialStatus === 'READY_TO_PUBLISH'
                    ? 'READY_TO_PUBLISH'
                    : 'QUEUED';
            // Capped backoff (max 5 minutes) for network outage so job recovers quickly once Wi-Fi reconnects
            const backoffMs = isNetTransient
                ? Math.min(5 * 60_000, Math.pow(2, Math.min(nextRetryCount, 3)) * 30_000)
                : Math.pow(2, nextRetryCount) * 60_000;
            const nextRetryAt = canRetry
                ? new Date(now.getTime() + backoffMs).toISOString()
                : null;
            this.db.addJobLog(job.id, isNetTransient && canRetry ? 'WARN' : 'ERROR', canRetry
                ? isNetTransient
                    ? 'NETWORK_WAIT_RETRY'
                    : 'RETRY_SCHEDULED'
                : 'JOB_FAILED', canRetry
                ? isNetTransient
                    ? `เครือข่าย/อินเทอร์เน็ตขัดข้องชั่วคราว (${errorMsg}) — ระบบจะรอเชื่อมต่อและลองใหม่อัตโนมัติ (ครั้งที่ ${nextRetryCount})`
                    : `เกิดข้อผิดพลาด (${errorMsg}) — จะลองใหม่อัตโนมัติครั้งที่ ${nextRetryCount}/${effectiveMaxRetries}`
                : `งานล้มเหลวถาวร: ${errorMsg}`, {
                retryCount: nextRetryCount,
                maxRetries: effectiveMaxRetries,
                transientNetwork: isNetTransient,
                nextRetryAt,
            });
            const updated = this.db.updateJob(job.id, {
                status: canRetry ? safeRecoveryStatus : 'FAILED',
                retryCount: nextRetryCount,
                nextRetryAt,
                lastError: errorMsg,
                lockedUntil: null,
            });
            if (!canRetry) {
                void this.sendFailureWebhook(updated, errorMsg).catch(() => { });
            }
            return updated;
        }
    }
    async executeFacebookReel(job, now, forcePublishNow, verifyOnly) {
        const lock = job.lockedUntil;
        if (!lock || job.status === 'CANCELLED' || (!verifyOnly && !this.liveFacebookReelsEnabled)) {
            return this.db.updateJob(job.id, { lockedUntil: null }, lock ?? undefined) ?? job;
        }
        const untilScheduled = Date.parse(job.scheduledAt) - now.getTime();
        const nativeSchedule = !forcePublishNow && untilScheduled >= 10 * 60_000 &&
            untilScheduled <= 29 * 24 * 60 * 60_000 && job.strategy === 'NATIVE_PREUPLOAD';
        if (!verifyOnly && !hasFacebookReelIntent(job) && !forcePublishNow && !nativeSchedule && untilScheduled > 0) {
            return this.db.updateJob(job.id, {
                status: 'READY_TO_PUBLISH', lockedUntil: null, nextRetryAt: null,
            }, lock) ?? this.db.getJob(job.id) ?? job;
        }
        try {
            const account = this.db.getAccountWithSecrets(job.socialAccountId);
            const pageId = account?.account.externalAccountId ?? '';
            const cooldown = this.db.facebookReelRateLimitedUntil(pageId, now.toISOString());
            if (cooldown) {
                return this.db.updateJob(job.id, { lockedUntil: null, nextRetryAt: cooldown }, lock) ?? job;
            }
            await runFacebookReel({
                job, now, verifyOnly, nativeSchedule,
                pageId,
                token: account?.account.connectionMode === 'LIVE_OFFICIAL' ? account.accessToken : null,
                loadMedia: async () => prepareFacebookReelMedia(await this.buildContext(job)),
                save: (patch) => {
                    if (!this.db.updateJob(job.id, patch, lock))
                        throw new Error('Facebook Reel worker lease changed');
                },
                log: (level, stage, message, details) => {
                    this.db.addJobLog(job.id, level, stage, message, details);
                },
            });
        }
        catch {
            // A worker may fail after sending a request. Keep the durable intent
            // and allow this Video ID to be checked without posting again.
            const latest = this.db.getJob(job.id);
            if (latest?.lockedUntil === lock) {
                this.db.updateJob(job.id, {
                    status: latest.status === 'PUBLISHED' ? 'PUBLISHED' : 'UNKNOWN',
                    lastError: latest.status === 'PUBLISHED' ? null : 'The Facebook Reel worker stopped before verification completed.',
                    nextRetryAt: null,
                }, lock);
            }
        }
        const finished = this.db.updateJob(job.id, { lockedUntil: null }, lock) ?? this.db.getJob(job.id) ?? job;
        if (finished.status === 'FAILED' && job.status !== 'FAILED' && finished.lastError) {
            void this.sendFailureWebhook(finished, finished.lastError).catch(() => { });
        }
        return finished;
    }
    async sendFailureWebhook(job, errorMsg) {
        const url = this.db.getSettingsFull().notificationWebhookUrl;
        if (!url)
            return;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event: 'publish_job.failed',
                jobId: job.id,
                platform: job.platform,
                format: job.format,
                scheduledAt: job.scheduledAt,
                error: errorMsg,
                content: `[SyncFlow Studio] Job ${job.id} (${job.format}) failed: ${errorMsg}`,
            }),
        });
    }
}
//# sourceMappingURL=engine.js.map