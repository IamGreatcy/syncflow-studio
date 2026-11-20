import { DatabaseSync } from 'node:sqlite';
import type { AppSettingsPublic, Channel, ClipCategory, ClipTypeFilter, ConnectionMode, ContentFormat, ContentItem, JobLog, JobStatus, MasterBrief, MediaAsset, MediaAssetSourceMeta, MediaProbeInfo, MetadataTemplate, Orientation, Platform, PlatformMetadataMap, PublishJob, PublishStrategy, ScheduleRule, SocialAccount, SocialAccountConfig, TikTokCreatorInfo, ToneStyle } from '@clipflow/shared';
import { SecretCipher } from './crypto.js';
export interface InternalAccountSecrets {
    account: SocialAccount;
    accessToken: string | null;
    refreshToken: string | null;
}
export interface AppSettingsFull {
    aiProvider: 'NONE' | 'GEMINI' | 'OPENAI';
    aiModel: string;
    aiBaseUrl: string;
    aiApiKey: string;
    r2AccountId: string;
    r2AccessKeyId: string;
    r2SecretAccessKey: string;
    r2BucketName: string;
    r2PublicBaseUrl: string;
    unifiedApiBaseUrl: string;
    unifiedApiKey: string;
    notificationWebhookUrl: string;
    maxChannels: number;
    synccutDataDir: string;
    googleClientId: string;
    googleClientSecret: string;
    metaAppId: string;
    metaAppSecret: string;
    tiktokClientKey: string;
    tiktokClientSecret: string;
}
export declare class ClipFlowDb {
    readonly sqlite: DatabaseSync;
    readonly cipher: SecretCipher;
    constructor(dbPath: string, keyPathOrHex?: string);
    checkpoint(): void;
    close(): void;
    importDatabaseFile(sourceDbPath: string): {
        channels: number;
        accounts: number;
        rules: number;
        templates: number;
        assets: number;
        contents: number;
        jobs: number;
    };
    private migrate;
    listChannels(): Channel[];
    getChannel(id: string): Channel | null;
    createChannel(input: {
        id?: string;
        name: string;
        slug?: string;
        color?: string;
        timezone?: string;
        description?: string;
        defaultTone?: ToneStyle;
    }): Channel;
    updateChannel(id: string, patch: Partial<{
        name: string;
        color: string;
        timezone: string;
        description: string;
        defaultTone: ToneStyle;
    }>): Channel | null;
    deleteChannel(id: string): boolean;
    private mapChannel;
    listAccounts(channelId?: string): SocialAccount[];
    getAccount(id: string): SocialAccount | null;
    getAccountWithSecrets(id: string): InternalAccountSecrets | null;
    createAccount(input: {
        id?: string;
        channelId: string;
        platform: Platform;
        accountName: string;
        externalAccountId?: string;
        connectionMode?: ConnectionMode;
        config?: SocialAccountConfig;
        accessToken?: string | null;
        refreshToken?: string | null;
        tokenExpiresAt?: string | null;
        creatorInfo?: TikTokCreatorInfo | null;
        status?: 'CONNECTED' | 'NEEDS_REAUTH' | 'DISCONNECTED';
    }): SocialAccount;
    updateAccount(id: string, patch: Partial<{
        accountName: string;
        externalAccountId: string;
        connectionMode: ConnectionMode;
        config: SocialAccountConfig;
        accessToken: string | null;
        refreshToken: string | null;
        tokenExpiresAt: string | null;
        creatorInfo: TikTokCreatorInfo | null;
        status: 'CONNECTED' | 'NEEDS_REAUTH' | 'DISCONNECTED';
    }>): SocialAccount | null;
    deleteAccount(id: string): boolean;
    private mapAccount;
    listScheduleRules(channelId: string): ScheduleRule[];
    replaceScheduleRules(channelId: string, rules: Array<{
        id?: string;
        socialAccountId: string;
        dayOfWeek: number;
        clipType?: ClipTypeFilter;
        slotOrder?: number;
        localTime: string;
        isActive?: boolean;
    }>): ScheduleRule[];
    listTemplates(channelId?: string): MetadataTemplate[];
    upsertTemplate(input: {
        id?: string;
        channelId: string;
        format: ContentFormat;
        name: string;
        titlePrefix?: string;
        titleSuffix?: string;
        descriptionHeader?: string;
        descriptionFooter?: string;
        defaultHashtags?: string[];
        defaultTags?: string[];
        defaultCta?: string;
        platformDefaults?: Record<string, unknown>;
    }): MetadataTemplate;
    private mapTemplate;
    createMediaAsset(input: {
        id: string;
        channelId: string;
        originalFilename: string;
        storageProvider: 'LOCAL' | 'R2';
        storageKey: string;
        publicUrl?: string | null;
        thumbnailPaths: string[];
        customCoverKey?: string | null;
        customCoverPublicUrl?: string | null;
        sourceMeta?: MediaAssetSourceMeta | null;
        mimeType: string;
        fileSizeBytes: number;
        probe: MediaProbeInfo;
        orientation: Orientation;
        clipCategory: ClipCategory;
        status?: 'READY' | 'OPTIMIZING' | 'OPTIMIZED' | 'ERROR';
    }): MediaAsset;
    updateMediaAssetCover(id: string, customCoverKey: string | null, customCoverPublicUrl?: string | null): MediaAsset | null;
    getMediaAsset(id: string): MediaAsset | null;
    listMediaAssets(channelId?: string): MediaAsset[];
    updateMediaAssetOptimized(id: string, optimizedStorageKey: string, probe: MediaProbeInfo, fileSizeBytes: number, publicUrl?: string | null): MediaAsset | null;
    private mapMediaAsset;
    listContents(params: {
        channelId?: string;
        fromDate?: string;
        toDate?: string;
    }): ContentItem[];
    getContent(id: string): ContentItem | null;
    createContentWithJobs(input: {
        id?: string;
        channelId: string;
        mediaAssetId: string;
        targetDate: string;
        masterBrief: MasterBrief;
        platformMetadata: PlatformMetadataMap;
        jobs: Array<{
            socialAccountId: string;
            platform: Platform;
            format: ContentFormat;
            strategy: PublishStrategy;
            scheduledAt: string;
            prewarmAt: string | null;
            metadataSnapshot: Record<string, unknown>;
        }>;
    }): ContentItem;
    updateContentFields(id: string, patch: Partial<{
        targetDate: string;
        masterBrief: MasterBrief;
        platformMetadata: PlatformMetadataMap;
        status: ContentItem['status'];
    }>): ContentItem | null;
    recomputeContentStatus(contentItemId: string): void;
    deleteContent(id: string): boolean;
    private mapContent;
    private hydrateContent;
    listJobs(filter?: {
        channelId?: string;
        contentItemId?: string;
        status?: JobStatus;
    }): PublishJob[];
    getJob(id: string): PublishJob | null;
    /**
     * Atomically claims due jobs using BEGIN IMMEDIATE so concurrent ticks never duplicate work.
     */
    claimDueJobs(nowIso: string, limit?: number): PublishJob[];
    claimSpecificJob(jobId: string, nowIso: string): PublishJob | null;
    updateJob(id: string, patch: Partial<{
        status: JobStatus;
        strategy: PublishStrategy;
        scheduledAt: string;
        prewarmAt: string | null;
        externalPostId: string | null;
        externalContainerId: string | null;
        externalUrl: string | null;
        metadataSnapshot: Record<string, unknown>;
        retryCount: number;
        nextRetryAt: string | null;
        lastError: string | null;
        lockedUntil: string | null;
    }>): PublishJob | null;
    addJobLog(jobId: string, level: 'INFO' | 'WARN' | 'ERROR', stage: string, message: string, details?: Record<string, unknown> | null): JobLog;
    listJobLogs(jobId: string): JobLog[];
    private mapJob;
    private getSettingRaw;
    private setSettingRaw;
    getSettingsFull(): AppSettingsFull;
    getSettingsPublic(): AppSettingsPublic;
    updateSettings(patch: Partial<AppSettingsFull>): AppSettingsPublic;
}
//# sourceMappingURL=database.d.ts.map