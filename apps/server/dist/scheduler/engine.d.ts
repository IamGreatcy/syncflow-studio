import type { PublishJob, PublishStrategy } from '@clipflow/shared';
import type { ClipFlowDb } from '../db/database.js';
import type { StorageService } from '../services/storage.js';
export declare class SchedulerEngine {
    private readonly db;
    private readonly storage;
    private timer;
    private tokenTimer;
    private isTickRunning;
    lastTickAt: string | null;
    constructor(db: ClipFlowDb, storage: StorageService);
    start(intervalMs?: number): void;
    stop(): void;
    nudge(): void;
    tick(now?: Date): Promise<{
        processed: number;
        results: Array<{
            jobId: string;
            status: string;
        }>;
    }>;
    runJobNow(jobId: string, now?: Date): Promise<PublishJob>;
    rescheduleJobExternal(jobId: string, newScheduledAtIso: string, newPrewarmAtIso: string | null, newStrategy: PublishStrategy): Promise<PublishJob>;
    cancelJob(jobId: string): Promise<PublishJob>;
    refreshExpiringTokens(now?: Date): Promise<number>;
    private buildContext;
    private executeClaimedJob;
    private sendFailureWebhook;
}
//# sourceMappingURL=engine.d.ts.map