import { type MasterBrief, type SyncCutEpisodeSummary, type SyncCutImportResponse } from '@clipflow/shared';
import type { ClipFlowDb } from '../db/database.js';
import type { StorageService } from './storage.js';
interface SyncCutShot {
    id?: string;
    narration?: string;
    duration?: number;
    caption?: string;
    title?: string;
}
interface SyncCutEpisode {
    id: string;
    title?: string;
    updatedAt?: string;
    createdAt?: string;
    sources?: Array<{
        title?: string;
        url?: string;
    }>;
    production?: {
        aspectRatio?: string;
        preset?: string;
        visualStyle?: string;
    };
    shots?: SyncCutShot[];
    delivery?: {
        publishTitle?: string;
        description?: string;
        tags?: string;
        coverTime?: number;
        coverDesign?: {
            enabled?: boolean;
            kicker?: string;
            headline?: string;
            subline?: string;
        };
        cues?: Array<{
            start?: number;
            end?: number;
            text?: string;
        }>;
    };
}
interface SyncCutExport {
    id: string;
    episodeId: string;
    version?: number;
    file?: string;
    coverId?: string;
    technicalQA?: {
        actual?: {
            duration?: number;
            width?: number;
            height?: number;
        };
    };
}
export declare function stripCoverMarkdown(text: string): string;
export declare function sanitizePromptTitle(raw: string): string;
export declare function listSyncCutEpisodes(dataDir: string): {
    connected: boolean;
    dataDir: string;
    episodes: SyncCutEpisodeSummary[];
};
export declare function getSyncCutCoverPath(dataDir: string, episodeId: string, exportId?: string): string | null;
export declare function extractBriefFromSyncCutEpisode(ep: SyncCutEpisode, exportRec?: SyncCutExport | null): MasterBrief;
export declare function importSyncCutEpisode(params: {
    db: ClipFlowDb;
    storage: StorageService;
    dataDir: string;
    channelId: string;
    episodeId: string;
    exportId?: string;
}): Promise<SyncCutImportResponse>;
export {};
//# sourceMappingURL=synccut-bridge.d.ts.map