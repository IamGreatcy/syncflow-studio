import fs from 'node:fs';
import path from 'node:path';
import type {
  PublishJob,
  PublishStrategy,
  YouTubeMetadata,
} from '@clipflow/shared';
import type { ClipFlowDb } from '../db/database.js';
import type { StorageService } from '../services/storage.js';
import { getAdapter } from '../adapters/registry.js';
import { publishViaUnifiedApi } from '../adapters/unified.js';
import type { AdapterContext } from '../adapters/types.js';

export class SchedulerEngine {
  private timer: NodeJS.Timeout | null = null;
  private tokenTimer: NodeJS.Timeout | null = null;
  private isTickRunning = false;
  lastTickAt: string | null = null;

  constructor(
    private readonly db: ClipFlowDb,
    private readonly storage: StorageService
  ) {}

  start(intervalMs = 15_000): void {
    if (this.timer) return;
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

    // Kick off an initial tick shortly after boot
    setTimeout(() => {
      void this.tick().catch(() => {});
    }, 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tokenTimer) {
      clearInterval(this.tokenTimer);
      this.tokenTimer = null;
    }
  }

  nudge(): void {
    setTimeout(() => {
      void this.tick().catch(() => {});
    }, 50);
  }

  async tick(now: Date = new Date()): Promise<{
    processed: number;
    results: Array<{ jobId: string; status: string }>;
  }> {
    if (this.isTickRunning) {
      return { processed: 0, results: [] };
    }
    this.isTickRunning = true;
    this.lastTickAt = now.toISOString();

    try {
      const dueJobs = this.db.claimDueJobs(now.toISOString(), 10);
      const results: Array<{ jobId: string; status: string }> = [];

      for (const job of dueJobs) {
        const updated = await this.executeClaimedJob(job, now, false);
        results.push({ jobId: job.id, status: updated.status });
      }

      return { processed: results.length, results };
    } finally {
      this.isTickRunning = false;
    }
  }

  async runJobNow(
    jobId: string,
    now: Date = new Date()
  ): Promise<PublishJob> {
    const claimed = this.db.claimSpecificJob(jobId, now.toISOString());
    if (!claimed) {
      const existing = this.db.getJob(jobId);
      if (!existing) throw new Error('ไม่พบงานที่ระบุ');
      throw new Error(
        `ไม่สามารถรันงานสถานะ ${existing.status} หรือมี worker กำลังทำงานอยู่`
      );
    }
    return this.executeClaimedJob(claimed, now, true);
  }

  async rescheduleJobExternal(
    jobId: string,
    newScheduledAtIso: string,
    newPrewarmAtIso: string | null,
    newStrategy: PublishStrategy
  ): Promise<PublishJob> {
    const job = this.db.getJob(jobId);
    if (!job) throw new Error('Job not found');

    if (job.status === 'PUBLISHED' || job.status === 'CANCELLED') {
      return job;
    }

    if (job.status === 'NATIVE_SCHEDULED' && job.externalPostId) {
      const ctx = await this.buildContext(job);
      const adapter = getAdapter(job.platform);
      if (adapter.updateSchedule) {
        await adapter.updateSchedule({ ctx, newScheduledAtIso });
        this.db.addJobLog(
          job.id,
          'INFO',
          'RESCHEDULED_NATIVE',
          `อัปเดตเวลาโพสต์ล่วงหน้าบน ${job.platform} เป็น ${newScheduledAtIso}`
        );
      }
      return this.db.updateJob(job.id, {
        scheduledAt: newScheduledAtIso,
        prewarmAt: newPrewarmAtIso,
      })!;
    }

    this.db.addJobLog(
      job.id,
      'INFO',
      'RESCHEDULED_QUEUE',
      `ปรับเวลาในคิวเป็น ${newScheduledAtIso} (${newStrategy})`
    );
    return this.db.updateJob(job.id, {
      scheduledAt: newScheduledAtIso,
      prewarmAt: newPrewarmAtIso,
      strategy: newStrategy,
      status: 'QUEUED',
      externalContainerId: null,
      nextRetryAt: null,
      lastError: null,
    })!;
  }

  async cancelJob(jobId: string): Promise<PublishJob> {
    const job = this.db.getJob(jobId);
    if (!job) throw new Error('Job not found');
    if (job.status === 'PUBLISHED') {
      throw new Error('งานนี้เผยแพร่สำเร็จแล้ว ไม่สามารถยกเลิกคิวได้');
    }

    if (job.status === 'NATIVE_SCHEDULED' && job.externalPostId) {
      try {
        const ctx = await this.buildContext(job);
        const adapter = getAdapter(job.platform);
        if (adapter.cancelSchedule) {
          await adapter.cancelSchedule(ctx);
        }
      } catch (err) {
        this.db.addJobLog(
          job.id,
          'WARN',
          'CANCEL_REMOTE_WARN',
          `ยกเลิกบนแพลตฟอร์มปลายทางไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    this.db.addJobLog(job.id, 'INFO', 'JOB_CANCELLED', 'ยกเลิกงานเรียบร้อย');
    return this.db.updateJob(job.id, {
      status: 'CANCELLED',
      lockedUntil: null,
    })!;
  }

  async refreshExpiringTokens(now: Date = new Date()): Promise<number> {
    const accounts = this.db.listAccounts();
    let refreshed = 0;

    for (const acc of accounts) {
      if (acc.connectionMode !== 'LIVE_OFFICIAL') continue;
      if (!acc.tokenExpiresAt) continue;

      const expMs = new Date(acc.tokenExpiresAt).getTime();
      if (expMs - now.getTime() > 24 * 3600_000) continue;

      const full = this.db.getAccountWithSecrets(acc.id);
      if (!full?.refreshToken) continue;

      const adapter = getAdapter(acc.platform);
      if (!adapter.refreshAccessToken) continue;

      try {
        const settings = this.db.getSettingsFull();
        const nextTokens = await adapter.refreshAccessToken(
          full.refreshToken,
          settings
        );
        this.db.updateAccount(acc.id, {
          accessToken: nextTokens.accessToken,
          refreshToken: nextTokens.refreshToken ?? full.refreshToken,
          tokenExpiresAt: nextTokens.expiresAt ?? null,
          status: 'CONNECTED',
        });
        refreshed++;
      } catch {
        this.db.updateAccount(acc.id, { status: 'NEEDS_REAUTH' });
      }
    }

    return refreshed;
  }

  private async buildContext(job: PublishJob): Promise<AdapterContext> {
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
    const localFilePath = await this.storage.ensureLocalFile(
      storageKey,
      settings
    );

    let thumbnailPath: string | null = null;
    if (asset.customCoverKey) {
      thumbnailPath = await this.storage.ensureCustomCover(asset.id, settings);
    }
    if (!thumbnailPath && asset.thumbnailPaths.length > 0) {
      const ytMeta = job.metadataSnapshot as Partial<YouTubeMetadata>;
      const idx =
        typeof ytMeta.thumbnailIndex === 'number' &&
        asset.thumbnailPaths[ytMeta.thumbnailIndex]
          ? ytMeta.thumbnailIndex
          : 0;
      const candidate = path.join(
        this.storage.resolveThumbnailDir(asset.id),
        asset.thumbnailPaths[idx]
      );
      thumbnailPath = candidate;
    }

    // Refresh token right before execution if expiring within 15 minutes
    let accessToken = accountData.accessToken;
    let refreshToken = accountData.refreshToken;
    if (
      accountData.account.connectionMode === 'LIVE_OFFICIAL' &&
      accountData.account.tokenExpiresAt &&
      refreshToken
    ) {
      const expMs = new Date(accountData.account.tokenExpiresAt).getTime();
      if (expMs - Date.now() < 15 * 60_000) {
        const adapter = getAdapter(job.platform);
        if (adapter.refreshAccessToken) {
          const next = await adapter.refreshAccessToken(refreshToken, settings);
          accessToken = next.accessToken;
          refreshToken = next.refreshToken ?? refreshToken;
          this.db.updateAccount(accountData.account.id, {
            accessToken,
            refreshToken,
            tokenExpiresAt: next.expiresAt ?? null,
          });
        }
      }
    }

    return {
      job,
      account: accountData.account,
      accessToken,
      refreshToken,
      asset,
      localFilePath,
      thumbnailPath,
      settings,
      log: (level, stage, message, details) => {
        this.db.addJobLog(job.id, level, stage, message, details ?? null);
      },
    };
  }

  private async executeClaimedJob(
    job: PublishJob,
    now: Date,
    forcePublishNow: boolean
  ): Promise<PublishJob> {
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
          })!;
        }
        this.db.updateJob(job.id, { status: 'PUBLISHING' });
        const pub = await publishViaUnifiedApi(ctx);
        this.db.addJobLog(
          job.id,
          'INFO',
          'UNIFIED_PUBLISHED',
          'เผยแพร่ผ่าน Unified API สำเร็จ',
          { externalPostId: pub.externalPostId }
        );
        return this.db.updateJob(job.id, {
          status: 'PUBLISHED',
          externalPostId: pub.externalPostId,
          externalUrl: pub.externalUrl,
          lockedUntil: null,
          lastError: null,
          nextRetryAt: null,
        })!;
      }

      const adapter = getAdapter(job.platform);

      // Step 1: Native Pre-upload (YouTube / Facebook) or Inbox Draft (TikTok)
      if (
        !forcePublishNow &&
        job.status === 'QUEUED' &&
        (job.strategy === 'NATIVE_PREUPLOAD' || job.strategy === 'INBOX_DRAFT') &&
        adapter.preUploadSchedule
      ) {
        this.db.updateJob(job.id, { status: 'PREUPLOADING' });
        const preRes = await adapter.preUploadSchedule(ctx);
        return this.db.updateJob(job.id, {
          status: preRes.status,
          externalPostId: preRes.externalPostId,
          externalUrl: preRes.externalUrl,
          lockedUntil: null,
          lastError: null,
          nextRetryAt: null,
        })!;
      }

      // Step 2: JIT Pre-warm (Instagram container creation + processing wait ahead of scheduled time)
      if (
        !forcePublishNow &&
        !isDueToPublish &&
        job.status === 'QUEUED' &&
        job.strategy === 'JIT_PUBLISH'
      ) {
        this.db.updateJob(job.id, { status: 'PREWARMING' });
        let containerId: string | null = job.externalContainerId;
        let nextSnapshot = { ...job.metadataSnapshot };

        if (adapter.preWarm) {
          const warmRes = await adapter.preWarm(ctx);
          containerId = warmRes.externalContainerId;
          nextSnapshot = {
            ...nextSnapshot,
            __containerCreatedAt: warmRes.containerCreatedAt,
          };
        } else {
          this.db.addJobLog(
            job.id,
            'INFO',
            'JIT_PREWARM_READY',
            `เตรียมความพร้อมไฟล์และ Token สำหรับ ${job.format} เรียบร้อย รอเผยแพร่เวลา ${job.scheduledAt}`
          );
        }

        return this.db.updateJob(job.id, {
          status: 'READY_TO_PUBLISH',
          externalContainerId: containerId,
          metadataSnapshot: nextSnapshot,
          lockedUntil: null,
          lastError: null,
          nextRetryAt: null,
        })!;
      }

      // Step 3: Publish Now (due scheduled time or manual Run Now)
      if (isDueToPublish) {
        this.db.updateJob(job.id, { status: 'PUBLISHING' });
        const pubRes = await adapter.publishNow(ctx);
        this.db.addJobLog(
          job.id,
          'INFO',
          'PUBLISHED',
          `เผยแพร่คลิปบน ${job.format} สำเร็จ`,
          { externalPostId: pubRes.externalPostId, externalUrl: pubRes.externalUrl }
        );
        return this.db.updateJob(job.id, {
          status: 'PUBLISHED',
          externalPostId: pubRes.externalPostId,
          externalUrl: pubRes.externalUrl,
          lockedUntil: null,
          lastError: null,
          nextRetryAt: null,
        })!;
      }

      // Not due yet — release lock safely
      return this.db.updateJob(job.id, { lockedUntil: null })!;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const nextRetryCount = job.retryCount + 1;
      const canRetry = !forcePublishNow && nextRetryCount <= job.maxRetries;

      const safeRecoveryStatus =
        initialStatus === 'NATIVE_SCHEDULED'
          ? 'NATIVE_SCHEDULED'
          : initialStatus === 'READY_TO_PUBLISH'
            ? 'READY_TO_PUBLISH'
            : 'QUEUED';

      const backoffMs = Math.pow(2, nextRetryCount) * 60_000;
      const nextRetryAt = canRetry
        ? new Date(now.getTime() + backoffMs).toISOString()
        : null;

      this.db.addJobLog(
        job.id,
        'ERROR',
        canRetry ? 'RETRY_SCHEDULED' : 'JOB_FAILED',
        canRetry
          ? `เกิดข้อผิดพลาด (${errorMsg}) — จะลองใหม่อัตโนมัติครั้งที่ ${nextRetryCount}/${job.maxRetries}`
          : `งานล้มเหลวถาวร: ${errorMsg}`,
        { retryCount: nextRetryCount, nextRetryAt }
      );

      const updated = this.db.updateJob(job.id, {
        status: canRetry ? safeRecoveryStatus : 'FAILED',
        retryCount: nextRetryCount,
        nextRetryAt,
        lastError: errorMsg,
        lockedUntil: null,
      })!;

      if (!canRetry) {
        void this.sendFailureWebhook(updated, errorMsg).catch(() => {});
      }

      return updated;
    }
  }

  private async sendFailureWebhook(
    job: PublishJob,
    errorMsg: string
  ): Promise<void> {
    const url = this.db.getSettingsFull().notificationWebhookUrl;
    if (!url) return;
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
