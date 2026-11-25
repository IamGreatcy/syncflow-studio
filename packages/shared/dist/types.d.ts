export declare const PLATFORMS: readonly ["YOUTUBE", "TIKTOK", "INSTAGRAM", "FACEBOOK"];
export type Platform = (typeof PLATFORMS)[number];
export declare const CONTENT_FORMATS: readonly ["YOUTUBE_SHORTS", "YOUTUBE_LONG", "TIKTOK", "INSTAGRAM_REELS", "FACEBOOK_REELS", "FACEBOOK_VIDEO"];
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export declare const CONNECTION_MODES: readonly ["SIMULATION", "LIVE_OFFICIAL", "UNIFIED_API"];
export type ConnectionMode = (typeof CONNECTION_MODES)[number];
export declare const PUBLISH_STRATEGIES: readonly ["NATIVE_PREUPLOAD", "JIT_PUBLISH", "INBOX_DRAFT"];
export type PublishStrategy = (typeof PUBLISH_STRATEGIES)[number];
export declare const JOB_STATUSES: readonly ["DRAFT", "QUEUED", "PREUPLOADING", "NATIVE_SCHEDULED", "PREWARMING", "READY_TO_PUBLISH", "PUBLISHING", "UPLOADED", "PROCESSING", "PUBLISH_REQUESTED", "UNKNOWN", "PUBLISHED", "FAILED", "CANCELLED"];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type ClipCategory = 'SHORT' | 'LONG';
export type ClipTypeFilter = 'ANY' | 'SHORT' | 'LONG';
export type Orientation = 'VERTICAL' | 'SQUARE' | 'HORIZONTAL';
export type ToneStyle = 'FRIENDLY' | 'EDUCATIONAL' | 'ENTERTAINING' | 'PROFESSIONAL' | 'URGENT_HOOK';
export interface Channel {
    id: string;
    name: string;
    slug: string;
    color: string;
    timezone: string;
    description: string;
    defaultTone: ToneStyle;
    createdAt: string;
    updatedAt: string;
}
export interface SocialAccountConfig {
    tiktokMode?: 'DIRECT_POST' | 'INBOX_DRAFT';
    unifiedAccountId?: string;
    defaultCategoryId?: string;
    defaultPrivacy?: string;
    notes?: string;
}
export interface TikTokCreatorInfo {
    creatorUsername?: string;
    creatorNickname?: string;
    privacyLevelOptions: Array<'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY'>;
    commentDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
    maxVideoPostDurationSec: number;
    fetchedAt?: string;
}
export interface SocialAccount {
    id: string;
    channelId: string;
    platform: Platform;
    accountName: string;
    externalAccountId: string;
    connectionMode: ConnectionMode;
    config: SocialAccountConfig;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    tokenExpiresAt: string | null;
    creatorInfo: TikTokCreatorInfo | null;
    status: 'CONNECTED' | 'NEEDS_REAUTH' | 'DISCONNECTED';
    createdAt: string;
    updatedAt: string;
}
export interface ScheduleRule {
    id: string;
    channelId: string;
    socialAccountId: string;
    dayOfWeek: number;
    clipType: ClipTypeFilter;
    slotOrder: number;
    localTime: string;
    isActive: boolean;
    createdAt: string;
}
export interface ResolvedSlot {
    socialAccountId: string;
    accountName: string;
    platform: Platform;
    format: ContentFormat;
    dayOfWeek: number;
    localTime: string;
    timezone: string;
    scheduledAtIso: string;
    strategy: PublishStrategy;
    sourceRuleId: string | null;
    isFallbackDefault: boolean;
    /** Effective YYYY-MM-DD for this slot (auto-bumped to a future day if requested date's slot already passed). */
    targetDate?: string;
    /** True when the requested date's nominal slot had already passed `now`. */
    wasPastSlot?: boolean;
    /** Original localTime ("HH:mm") on the requested date before auto-advancing. */
    nominalLocalTime?: string;
}
export interface MediaProbeInfo {
    durationSec: number;
    width: number;
    height: number;
    rotation: number;
    fps: number;
    videoCodec: string;
    audioCodec: string | null;
    audioSampleRate: number | null;
    bitrateKbps: number;
    fileSizeBytes: number;
    hasFaststartMoov: boolean | null;
}
export interface MediaAssetSourceMeta {
    sourceApp?: string;
    episodeId?: string;
    exportId?: string;
    version?: number;
    shotCount?: number;
    coverTimeSec?: number;
    syntheticMedia?: boolean;
    visualStyle?: string;
    brief?: MasterBrief;
    subtitlesSrt?: string;
    subtitlesVtt?: string;
}
export interface MediaAsset {
    id: string;
    channelId: string;
    originalFilename: string;
    storageProvider: 'LOCAL' | 'R2';
    storageKey: string;
    optimizedStorageKey: string | null;
    publicUrl: string | null;
    thumbnailPaths: string[];
    customCoverKey: string | null;
    customCoverPublicUrl: string | null;
    sourceMeta: MediaAssetSourceMeta | null;
    mimeType: string;
    fileSizeBytes: number;
    probe: MediaProbeInfo;
    orientation: Orientation;
    clipCategory: ClipCategory;
    status: 'READY' | 'OPTIMIZING' | 'OPTIMIZED' | 'ERROR';
    createdAt: string;
}
export interface MasterBrief {
    topic: string;
    hook: string;
    summary: string;
    keyPoints: string[];
    cta: string;
    coreHashtags: string[];
    language: 'th' | 'en' | 'bilingual';
    tone: ToneStyle;
    timestampsText?: string;
    transcriptText?: string;
    coverKicker?: string;
    coverHeadline?: string;
    coverSubline?: string;
    sources?: Array<{
        title: string;
        url: string;
    }>;
    visualStyle?: string;
    isSyntheticMedia?: boolean;
    coverTimestampMs?: number;
}
export interface YouTubeMetadata {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    privacyStatus: 'public' | 'unlisted' | 'private';
    madeForKids: boolean;
    notifySubscribers: boolean;
    containsSyntheticMedia?: boolean;
    thumbnailIndex?: number;
}
export interface TikTokMetadata {
    caption: string;
    privacyLevel: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
    allowComment: boolean;
    allowDuet: boolean;
    allowStitch: boolean;
    brandOrganicToggle: boolean;
    brandContentToggle: boolean;
    isAigc: boolean;
    coverTimestampMs: number;
}
export interface InstagramReelsMetadata {
    caption: string;
    shareToFeed: boolean;
    thumbOffsetMs: number;
    isAiGenerated?: boolean;
    audioName?: string;
}
export interface FacebookReelsMetadata {
    title: string;
    description: string;
    isAiGenerated?: boolean;
}
export interface FacebookVideoMetadata {
    title: string;
    description: string;
    isAiGenerated?: boolean;
}
export interface PlatformMetadataMap {
    YOUTUBE_SHORTS?: YouTubeMetadata;
    YOUTUBE_LONG?: YouTubeMetadata;
    TIKTOK?: TikTokMetadata;
    INSTAGRAM_REELS?: InstagramReelsMetadata;
    FACEBOOK_REELS?: FacebookReelsMetadata;
    FACEBOOK_VIDEO?: FacebookVideoMetadata;
}
export interface MetadataTemplate {
    id: string;
    channelId: string;
    format: ContentFormat;
    name: string;
    titlePrefix: string;
    titleSuffix: string;
    descriptionHeader: string;
    descriptionFooter: string;
    defaultHashtags: string[];
    defaultTags: string[];
    defaultCta: string;
    platformDefaults: Record<string, unknown>;
    updatedAt: string;
}
export interface ContentItem {
    id: string;
    channelId: string;
    mediaAssetId: string;
    targetDate: string;
    masterBrief: MasterBrief;
    platformMetadata: PlatformMetadataMap;
    status: 'DRAFT' | 'SCHEDULED' | 'PARTIAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    createdAt: string;
    updatedAt: string;
    mediaAsset?: MediaAsset;
    jobs?: PublishJob[];
}
export interface FacebookReelPublication {
    graphVersion: string;
    legacy?: boolean;
    effectiveGraphVersion?: string;
    pageId: string;
    videoId?: string;
    postId?: string;
    uploadUrl?: string;
    fileSha256?: string;
    fileSize?: number;
    startRequestedAt?: string;
    initializedAt?: string;
    uploadRequestedAt?: string;
    uploadedAt?: string;
    finishRequestedAt?: string;
    finishAcceptedAt?: string;
    statusCheckedAt?: string;
    confirmedAt?: string;
    publishTime?: string;
    phases?: {
        video?: string;
        uploading?: string;
        processing?: string;
        publishing?: string;
        publishStatus?: string;
        bytesTransferred?: number;
    };
    checks?: number;
    rateLimitedUntil?: string;
    verificationStartedAt?: string;
    lastApiError?: {
        stage: string;
        at: string;
        httpStatus?: number;
        code?: number;
        subcode?: number;
        fbtraceId?: string;
    };
}
export interface PublishJob {
    id: string;
    idempotencyKey: string;
    contentItemId: string;
    channelId: string;
    socialAccountId: string;
    platform: Platform;
    format: ContentFormat;
    strategy: PublishStrategy;
    scheduledAt: string;
    prewarmAt: string | null;
    status: JobStatus;
    externalPostId: string | null;
    facebookReel?: FacebookReelPublication | null;
    externalContainerId: string | null;
    externalUrl: string | null;
    metadataSnapshot: Record<string, unknown>;
    retryCount: number;
    maxRetries: number;
    nextRetryAt: string | null;
    lastError: string | null;
    lockedUntil: string | null;
    createdAt: string;
    updatedAt: string;
    accountName?: string;
    connectionMode?: ConnectionMode;
    contentTopic?: string;
    contentTargetDate?: string;
    mediaAssetId?: string;
    hasCustomCover?: boolean;
    thumbnailFilename?: string | null;
}
export interface JobLog {
    id: string;
    jobId: string;
    level: 'INFO' | 'WARN' | 'ERROR';
    stage: string;
    message: string;
    details: Record<string, unknown> | null;
    createdAt: string;
}
export interface ValidationIssue {
    format: ContentFormat;
    field: string;
    severity: 'error' | 'warning';
    code: string;
    message: string;
}
export interface AppSettingsPublic {
    aiProvider: 'NONE' | 'GEMINI' | 'OPENAI';
    aiModel: string;
    aiBaseUrl: string;
    hasAiApiKey: boolean;
    hasR2Config: boolean;
    r2AccountId: string;
    r2BucketName: string;
    r2PublicBaseUrl: string;
    unifiedApiBaseUrl: string;
    hasUnifiedApiKey: boolean;
    notificationWebhookUrl: string;
    maxChannels: number;
    synccutDataDir: string;
    synccutConnected: boolean;
    googleClientId: string;
    hasGoogleClientSecret: boolean;
    metaAppId: string;
    hasMetaAppSecret: boolean;
    tiktokClientKey: string;
    hasTiktokClientSecret: boolean;
}
export interface MetaDiscoveredPage {
    pageId: string;
    pageName: string;
    igUserId: string | null;
    igUsername: string | null;
    igName: string | null;
}
export interface SyncCutEpisodeSummary {
    episodeId: string;
    exportId: string | null;
    version: number | null;
    rawTitle: string;
    cleanTitle: string;
    coverKicker: string;
    coverHeadline: string;
    coverSubline: string;
    narrationPreview: string;
    aspectRatio: string;
    durationSec: number | null;
    width: number | null;
    height: number | null;
    shotCount: number;
    hasVideo: boolean;
    hasCover: boolean;
    coverTimeSec: number;
    updatedAt: string;
}
export interface SyncCutImportResponse {
    asset: MediaAsset;
    brief: MasterBrief;
    metadata: PlatformMetadataMap;
    engineUsed: string;
    warning?: string;
    detection: {
        orientation: Orientation;
        clipCategory: ClipCategory;
        recommendedFormats: ContentFormat[];
    };
    warningsByFormat: Record<ContentFormat, ValidationIssue[]>;
    issues: ValidationIssue[];
    draftContentId?: string;
    openUrl?: string;
}
//# sourceMappingURL=types.d.ts.map