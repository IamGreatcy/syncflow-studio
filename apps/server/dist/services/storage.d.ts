import type { Readable } from 'node:stream';
import type { AppSettingsFull } from '../db/database.js';
export interface SavedObjectResult {
    storageProvider: 'LOCAL' | 'R2';
    storageKey: string;
    localPath: string;
    publicUrl: string | null;
    sizeBytes: number;
}
export declare class StorageService {
    readonly dataDir: string;
    readonly uploadsDir: string;
    readonly thumbnailsDir: string;
    constructor(baseDataDir?: string);
    private createR2Client;
    resolveLocalPath(storageKey: string): string;
    resolveThumbnailDir(assetId: string): string;
    saveUploadStream(params: {
        assetId: string;
        originalFilename: string;
        mimeType: string;
        stream: Readable;
        settings: AppSettingsFull;
    }): Promise<SavedObjectResult>;
    syncLocalFileToStorage(params: {
        localPath: string;
        storageKey: string;
        mimeType: string;
        settings: AppSettingsFull;
    }): Promise<{
        publicUrl: string | null;
        sizeBytes: number;
    }>;
    ensureLocalFile(storageKey: string, settings: AppSettingsFull): Promise<string>;
    resolveCustomCoverPath(assetId: string): string;
    ensureCustomCover(assetId: string, settings: AppSettingsFull): Promise<string | null>;
    saveCustomCoverFromPath(params: {
        assetId: string;
        sourceFilePath: string;
        settings: AppSettingsFull;
    }): Promise<{
        customCoverKey: string;
        customCoverPublicUrl: string | null;
        localPath: string;
    }>;
    copyLocalVideoIntoStorage(params: {
        assetId: string;
        sourcePath: string;
        originalFilename: string;
        mimeType: string;
        settings: AppSettingsFull;
    }): Promise<SavedObjectResult>;
    deleteFile(storageKey: string, settings: AppSettingsFull): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map