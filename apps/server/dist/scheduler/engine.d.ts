import type { PublishJob, PublishStrategy } from '@clipflow/shared';
import type { ClipFlowDb } from '../db/database.js';
import type { StorageService } from '../services/storage.js';
export declare function isOfficialFacebookReel(job: PublishJob): boolean;
export declare function hasFacebookReelIntent(job: PublishJob): boolean;
export declare function facebookReelRuntime(env: NodeJS.ProcessEnv): {
    environment: string;
    owner: string;
    allowed: boolean;
};
export declare class SchedulerEngine {
    private readonly db;
    private readonly storage;
    readonly liveFacebookReelsEnabled: boolean;
    private timer;
    private tokenTimer;
    private isTickRunning;
    lastTickAt: string | null;
    constructor(db: ClipFlowDb, storage: StorageService, liveFacebookReelsEnabled?: boolean);
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
    verifyFacebookReel(jobId: string, now?: Date): Promise<PublishJob>;
    private requireFacebookReelOwner;
    rescheduleJobExternal(jobId: string, newScheduledAtIso: string, newPrewarmAtIso: string | null, newStrategy: PublishStrategy): Promise<PublishJob>;
    cancelJob(jobId: string): Promise<PublishJob>;
    refreshExpiringTokens(now?: Date): Promise<number>;
    private buildContext;
    private executeClaimedJob;
    private executeFacebookReel;
    private sendFailureWebhook;
}
//# sourceMappingURL=engine.d.ts.map