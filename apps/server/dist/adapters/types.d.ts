import type { MediaAsset, Platform, PublishJob, SocialAccount } from '@clipflow/shared';
import type { AppSettingsFull } from '../db/database.js';
export interface AdapterLogFn {
    (level: 'INFO' | 'WARN' | 'ERROR', stage: string, message: string, details?: Record<string, unknown>): void;
}
export interface AdapterContext {
    job: PublishJob;
    account: SocialAccount;
    accessToken: string | null;
    refreshToken: string | null;
    asset: MediaAsset;
    localFilePath: string;
    thumbnailPath: string | null;
    hasCustomCover?: boolean;
    getCoverVideoPath?: () => Promise<string>;
    onContainerCreated?: (containerId: string, createdAtIso: string) => void;
    settings: AppSettingsFull;
    log: AdapterLogFn;
}
export interface PreUploadResult {
    externalPostId: string;
    externalUrl: string | null;
    status: 'NATIVE_SCHEDULED' | 'PUBLISHED';
}
export interface PreWarmResult {
    externalContainerId: string;
    containerCreatedAt: string;
}
export interface PublishResult {
    externalPostId: string;
    externalUrl: string | null;
    inboxDraft?: boolean;
}
export interface OAuthAppCredentials {
    googleClientId?: string;
    googleClientSecret?: string;
    metaAppId?: string;
    metaAppSecret?: string;
    tiktokClientKey?: string;
    tiktokClientSecret?: string;
}
export interface OAuthTokenResponse {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    externalAccountId?: string;
    accountName?: string;
    creatorInfo?: import('@clipflow/shared').TikTokCreatorInfo | null;
    pairedIgAccount?: {
        igUserId: string;
        igUsername: string | null;
        igName: string | null;
    } | null;
}
export interface PlatformAdapter {
    readonly platform: Platform;
    getAuthUrl?(params: {
        accountId: string;
        redirectUri: string;
        state: string;
        credentials?: OAuthAppCredentials;
    }): string;
    exchangeCode?(params: {
        code: string;
        redirectUri: string;
        codeVerifier?: string;
        credentials?: OAuthAppCredentials;
    }): Promise<OAuthTokenResponse>;
    refreshAccessToken?(refreshToken: string, credentials?: OAuthAppCredentials): Promise<OAuthTokenResponse>;
    preUploadSchedule?(ctx: AdapterContext): Promise<PreUploadResult>;
    preWarm?(ctx: AdapterContext): Promise<PreWarmResult>;
    publishNow(ctx: AdapterContext): Promise<PublishResult>;
    updateSchedule?(params: {
        ctx: AdapterContext;
        newScheduledAtIso: string;
    }): Promise<void>;
    cancelSchedule?(ctx: AdapterContext): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map