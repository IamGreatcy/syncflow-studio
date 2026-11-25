import type { FacebookReelPublication, JobStatus, PublishJob } from '@clipflow/shared';
import type { AdapterContext, AdapterLogFn } from './types.js';
export declare const FACEBOOK_REELS_GRAPH_VERSION = "v27.0";
type Json = Record<string, unknown>;
type ApiError = NonNullable<FacebookReelPublication['lastApiError']>;
type Media = {
    path: string;
    thumbnailPath: string | null;
};
type Patch = {
    facebookReel: FacebookReelPublication;
    status?: JobStatus;
    externalPostId?: string | null;
    externalUrl?: string | null;
    nextRetryAt?: string | null;
    lastError?: string | null;
};
type Context = {
    job: PublishJob;
    pageId: string;
    token: string | null;
    now: Date;
    nativeSchedule: boolean;
    verifyOnly: boolean;
    loadMedia: () => Promise<Media>;
    save: (patch: Patch) => void;
    log: AdapterLogFn;
};
export declare function safeReelUrl(value: unknown, videoId: string): string | undefined;
export declare function endpoint(version: string, node: string, fields?: string): URL;
type Reply = {
    body: Json;
    httpStatus?: number;
    fbtraceId?: string;
    error?: ApiError;
    retryAfterMs?: number;
    version?: string;
    rejected?: boolean;
    throttled?: boolean;
};
export declare function request(url: URL | string, stage: string, token: string, now: Date, init?: RequestInit, timeout?: number): Promise<Reply>;
export declare function inspect(body: Json): {
    phases: {
        video: string | undefined;
        uploading: string | undefined;
        processing: string | undefined;
        publishing: string | undefined;
        publishStatus: string | undefined;
        bytesTransferred: number | undefined;
    };
    failure: readonly ["publishing", Json, string | undefined] | readonly ["processing", Json, string | undefined] | readonly ["uploading", Json, string | undefined] | undefined;
    failed: boolean;
    published: boolean;
    contradictory: boolean;
    scheduled: boolean;
    uploaded: boolean;
    publishTime: string | undefined;
    sourceSize: number | undefined;
};
export declare function prepareFacebookReelMedia(ctx: AdapterContext): Promise<Media>;
export declare function runFacebookReel(ctx: Context): Promise<void>;
export {};
//# sourceMappingURL=facebook-reel.d.ts.map