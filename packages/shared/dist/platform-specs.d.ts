import type { ContentFormat, MediaProbeInfo, Orientation, Platform, ValidationIssue } from './types.js';
export interface FormatSpec {
    format: ContentFormat;
    platform: Platform;
    labelTh: string;
    labelEn: string;
    minDurationSec: number;
    maxDurationSec: number;
    maxFileSizeBytes: number;
    maxTitleChars: number | null;
    maxCaptionChars: number | null;
    maxDescriptionBytes: number | null;
    maxHashtags: number | null;
    maxMentions: number | null;
    maxTagsTotalChars: number | null;
    nativeScheduleWindowMinMin: number | null;
    nativeScheduleWindowMaxDays: number | null;
    preferredAspect: '9:16' | '16:9' | 'ANY';
}
export declare const PLATFORM_LIMITS: Record<ContentFormat, FormatSpec>;
export declare function formatToPlatform(format: ContentFormat): Platform;
export declare function utf8ByteLength(text: string): number;
export declare function truncateUtf8Bytes(text: string, maxBytes: number): string;
/**
 * YouTube API counts total tag characters including commas separating tags,
 * and quotes around any tag containing spaces.
 */
export declare function calculateYouTubeTagsLength(tags: string[]): number;
export declare function extractHashtags(text: string): string[];
export declare function extractMentions(text: string): string[];
export declare function detectOrientation(width: number, height: number, rotation?: number): Orientation;
export declare function detectRecommendedFormats(probe: MediaProbeInfo): {
    orientation: Orientation;
    clipCategory: 'SHORT' | 'LONG';
    recommendedFormats: ContentFormat[];
};
export declare function validateVideoCompatibility(format: ContentFormat, probe: MediaProbeInfo): ValidationIssue[];
export declare function validateFormatMetadata(format: ContentFormat, meta: Record<string, unknown> | undefined, probe?: MediaProbeInfo): ValidationIssue[];
export interface TikTokChunk {
    index: number;
    start: number;
    end: number;
    size: number;
}
export interface TikTokChunkPlan {
    chunkSize: number;
    totalChunkCount: number;
    chunks: TikTokChunk[];
}
/**
 * Implements TikTok Content Posting API v2 FILE_UPLOAD chunk specification:
 * - Files <= 5 MB: single chunk (chunk_size = fileSize, total_chunk_count = 1)
 * - Regular chunks: 5 MB .. 64 MB
 * - total_chunk_count MUST be Math.floor(videoSize / chunkSize)
 * - Final trailing chunk absorbs remainder bytes and may be up to 128 MB
 * - Max 1000 chunks
 */
export declare function computeTikTokChunkPlan(videoSizeBytes: number, preferredChunkBytes?: number): TikTokChunkPlan;
//# sourceMappingURL=platform-specs.d.ts.map