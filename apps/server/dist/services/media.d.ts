import type { MediaProbeInfo } from '@clipflow/shared';
export declare function checkFfmpegAvailability(): Promise<{
    ffmpeg: string | null;
    ffprobe: string | null;
}>;
/**
 * Reads top-level ISO BMFF (MP4/MOV) boxes to verify whether `moov` appears before `mdat`
 * (required for reliable faststart streaming on Instagram/Facebook).
 */
export declare function detectFaststartMoov(filePath: string): Promise<boolean | null>;
export declare function probeVideo(filePath: string): Promise<MediaProbeInfo>;
export declare function extractThumbnails(filePath: string, thumbDir: string, durationSec: number): Promise<string[]>;
export declare function optimizeVideoForPlatforms(inputPath: string, outputPath: string, probe: MediaProbeInfo): Promise<{
    action: 'REMUX_FASTSTART' | 'TRANSCODE_H264_AAC';
    outputPath: string;
    probe: MediaProbeInfo;
}>;
export declare function normalizeCoverImage(inputPath: string, outputJpegPath: string): Promise<{
    outputPath: string;
    sizeBytes: number;
}>;
export declare function prependCoverFrameToVideo(params: {
    videoPath: string;
    coverImagePath: string;
    outputPath: string;
    probe: MediaProbeInfo;
    coverDurationSec?: number;
}): Promise<{
    outputPath: string;
    sizeBytes: number;
}>;
//# sourceMappingURL=media.d.ts.map