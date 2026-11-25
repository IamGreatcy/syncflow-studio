import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { MediaProbeInfo } from '@clipflow/shared';
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { AppSettingsFull } from '../db/database.js';
import { normalizeCoverImage, prependCoverFrameToVideo } from './media.js';

export interface SavedObjectResult {
  storageProvider: 'LOCAL' | 'R2';
  storageKey: string;
  localPath: string;
  publicUrl: string | null;
  sizeBytes: number;
}

export class StorageService {
  readonly dataDir: string;
  readonly uploadsDir: string;
  readonly thumbnailsDir: string;
  private readonly coverVideoBuilds = new Map<string, Promise<string>>();

  constructor(baseDataDir?: string) {
    this.dataDir = baseDataDir || path.resolve(process.cwd(), 'data');
    this.uploadsDir = path.join(this.dataDir, 'uploads');
    this.thumbnailsDir = path.join(this.dataDir, 'thumbnails');
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    fs.mkdirSync(this.thumbnailsDir, { recursive: true });
  }

  private createR2Client(settings: AppSettingsFull): S3Client | null {
    if (
      !settings.r2AccountId ||
      !settings.r2AccessKeyId ||
      !settings.r2SecretAccessKey ||
      !settings.r2BucketName
    ) {
      return null;
    }
    return new S3Client({
      region: 'auto',
      endpoint: `https://${settings.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: settings.r2AccessKeyId,
        secretAccessKey: settings.r2SecretAccessKey,
      },
      // Node 24 OpenSSL can hit TLS 1.3 alert 40 against Cloudflare R2 S3 endpoints
      requestHandler: new NodeHttpHandler({
        httpsAgent: new https.Agent({ maxVersion: 'TLSv1.2' }),
      }),
    });
  }

  resolveLocalPath(storageKey: string): string {
    const safeKey = storageKey.replace(/^\/+/, '').replace(/\.\./g, '');
    return path.join(this.uploadsDir, safeKey);
  }

  resolveThumbnailDir(assetId: string): string {
    const dir = path.join(this.thumbnailsDir, assetId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async saveUploadStream(params: {
    assetId: string;
    originalFilename: string;
    mimeType: string;
    stream: Readable;
    settings: AppSettingsFull;
  }): Promise<SavedObjectResult> {
    const ext = path.extname(params.originalFilename || '.mp4') || '.mp4';
    const safeBase = path
      .basename(params.originalFilename || 'video', ext)
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 48);
    const storageKey = `${params.assetId}_${safeBase}${ext.toLowerCase()}`;
    const localPath = this.resolveLocalPath(storageKey);

    await pipeline(params.stream, fs.createWriteStream(localPath));
    const stat = await fs.promises.stat(localPath);

    const r2 = this.createR2Client(params.settings);
    if (r2 && params.settings.r2BucketName) {
      const upload = new Upload({
        client: r2,
        params: {
          Bucket: params.settings.r2BucketName,
          Key: storageKey,
          Body: fs.createReadStream(localPath),
          ContentType: params.mimeType || 'video/mp4',
        },
      });
      await upload.done();
      const base = params.settings.r2PublicBaseUrl.replace(/\/+$/, '');
      return {
        storageProvider: 'R2',
        storageKey,
        localPath,
        publicUrl: base ? `${base}/${storageKey}` : null,
        sizeBytes: stat.size,
      };
    }

    return {
      storageProvider: 'LOCAL',
      storageKey,
      localPath,
      publicUrl: null,
      sizeBytes: stat.size,
    };
  }

  async syncLocalFileToStorage(params: {
    localPath: string;
    storageKey: string;
    mimeType: string;
    settings: AppSettingsFull;
  }): Promise<{ publicUrl: string | null; sizeBytes: number }> {
    const stat = await fs.promises.stat(params.localPath);
    const r2 = this.createR2Client(params.settings);
    if (r2 && params.settings.r2BucketName) {
      const upload = new Upload({
        client: r2,
        params: {
          Bucket: params.settings.r2BucketName,
          Key: params.storageKey,
          Body: fs.createReadStream(params.localPath),
          ContentType: params.mimeType || 'video/mp4',
        },
      });
      await upload.done();
      const base = params.settings.r2PublicBaseUrl.replace(/\/+$/, '');
      return {
        publicUrl: base ? `${base}/${params.storageKey}` : null,
        sizeBytes: stat.size,
      };
    }
    return { publicUrl: null, sizeBytes: stat.size };
  }

  async ensureLocalFile(
    storageKey: string,
    settings: AppSettingsFull
  ): Promise<string> {
    const localPath = this.resolveLocalPath(storageKey);
    if (fs.existsSync(localPath)) {
      return localPath;
    }

    const r2 = this.createR2Client(settings);
    if (!r2 || !settings.r2BucketName) {
      throw new Error(`Media file not found locally: ${localPath}`);
    }

    const res = await r2.send(
      new GetObjectCommand({
        Bucket: settings.r2BucketName,
        Key: storageKey,
      })
    );
    if (!res.Body) {
      throw new Error(`Media file missing from R2: ${storageKey}`);
    }
    await pipeline(
      res.Body as Readable,
      fs.createWriteStream(localPath)
    );
    return localPath;
  }

  resolveCustomCoverPath(assetId: string): string {
    return path.join(this.resolveThumbnailDir(assetId), 'custom_cover.jpg');
  }

  async ensureCustomCover(
    assetId: string,
    settings: AppSettingsFull
  ): Promise<string | null> {
    const localPath = this.resolveCustomCoverPath(assetId);
    if (fs.existsSync(localPath)) {
      return localPath;
    }

    const r2 = this.createR2Client(settings);
    if (!r2 || !settings.r2BucketName) {
      return null;
    }

    try {
      const res = await r2.send(
        new GetObjectCommand({
          Bucket: settings.r2BucketName,
          Key: `covers/${assetId}_cover.jpg`,
        })
      );
      if (!res.Body) return null;
      await pipeline(res.Body as Readable, fs.createWriteStream(localPath));
      return localPath;
    } catch {
      return null;
    }
  }

  async ensureCoverPrependedVideo(params: {
    assetId: string;
    videoPath: string;
    coverPath: string;
    probe: MediaProbeInfo;
    coverDurationSec?: number;
  }): Promise<string> {
    const coverDurationSec = params.coverDurationSec ?? 0.15;
    const [videoStat, coverStat] = await Promise.all([
      fs.promises.stat(params.videoPath),
      fs.promises.stat(params.coverPath),
    ]);
    const hash = createHash('sha256')
      .update(
        `${videoStat.size}:${videoStat.mtimeMs}:${coverStat.size}:${coverStat.mtimeMs}:${coverDurationSec}`
      )
      .digest('hex')
      .slice(0, 16);
    const cacheDir = path.join(this.uploadsDir, '_cover_cache');
    const cachedPath = path.join(cacheDir, `${params.assetId}_${hash}.mp4`);
    if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 0) {
      return cachedPath;
    }

    const key = `${params.assetId}_${hash}`;
    const existing = this.coverVideoBuilds.get(key);
    if (existing) {
      return existing;
    }

    const buildPromise = (async () => {
      await prependCoverFrameToVideo({
        videoPath: params.videoPath,
        coverImagePath: params.coverPath,
        outputPath: cachedPath,
        probe: params.probe,
        coverDurationSec,
      });
      return cachedPath;
    })().finally(() => {
      this.coverVideoBuilds.delete(key);
    });

    this.coverVideoBuilds.set(key, buildPromise);
    return buildPromise;
  }

  async saveCustomCoverFromPath(params: {
    assetId: string;
    sourceFilePath: string;
    settings: AppSettingsFull;
  }): Promise<{
    customCoverKey: string;
    customCoverPublicUrl: string | null;
    localPath: string;
  }> {
    const outPath = this.resolveCustomCoverPath(params.assetId);
    await normalizeCoverImage(params.sourceFilePath, outPath);
    const r2Key = `covers/${params.assetId}_cover.jpg`;
    const sync = await this.syncLocalFileToStorage({
      localPath: outPath,
      storageKey: r2Key,
      mimeType: 'image/jpeg',
      settings: params.settings,
    });
    return {
      customCoverKey: 'custom_cover.jpg',
      customCoverPublicUrl: sync.publicUrl,
      localPath: outPath,
    };
  }

  async copyLocalVideoIntoStorage(params: {
    assetId: string;
    sourcePath: string;
    originalFilename: string;
    mimeType: string;
    settings: AppSettingsFull;
  }): Promise<SavedObjectResult> {
    return this.saveUploadStream({
      assetId: params.assetId,
      originalFilename: params.originalFilename,
      mimeType: params.mimeType,
      stream: fs.createReadStream(params.sourcePath),
      settings: params.settings,
    });
  }

  async deleteFile(storageKey: string, settings: AppSettingsFull): Promise<void> {
    const localPath = this.resolveLocalPath(storageKey);
    if (fs.existsSync(localPath)) {
      await fs.promises.unlink(localPath).catch(() => {});
    }
    const r2 = this.createR2Client(settings);
    if (r2 && settings.r2BucketName) {
      await r2
        .send(
          new DeleteObjectCommand({
            Bucket: settings.r2BucketName,
            Key: storageKey,
          })
        )
        .catch(() => {});
    }
  }

  async deleteMediaAssetFiles(
    asset: { id: string; storageKey: string; optimizedStorageKey?: string | null },
    settings: AppSettingsFull
  ): Promise<void> {
    if (asset.storageKey) {
      await this.deleteFile(asset.storageKey, settings);
    }
    if (asset.optimizedStorageKey && asset.optimizedStorageKey !== asset.storageKey) {
      await this.deleteFile(asset.optimizedStorageKey, settings);
    }
    await this.deleteFile(`covers/${asset.id}_cover.jpg`, settings);
    const thumbDir = path.join(this.thumbnailsDir, asset.id);
    if (fs.existsSync(thumbDir)) {
      await fs.promises.rm(thumbDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async pruneOldCoverCache(maxAgeDays = 7): Promise<number> {
    const cacheDir = path.join(this.uploadsDir, '_cover_cache');
    if (!fs.existsSync(cacheDir)) return 0;
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * 24 * 60 * 60_000;
    let removed = 0;
    for (const entry of await fs.promises.readdir(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(cacheDir, entry.name);
      try {
        const st = await fs.promises.stat(full);
        if (st.mtimeMs < cutoff) {
          await fs.promises.unlink(full);
          removed++;
        }
      } catch {
        // ignore
      }
    }
    return removed;
  }

  async backupDatabaseToR2(
    writeBackup: (destPath: string) => void,
    settings: AppSettingsFull,
    keepDays = 14
  ): Promise<{ uploadedKey: string | null; prunedBackups: number }> {
    const r2 = this.createR2Client(settings);
    if (!r2 || !settings.r2BucketName) {
      return { uploadedKey: null, prunedBackups: 0 };
    }
    const dayStr = new Date().toISOString().slice(0, 10);
    const key = `backups/syncflow-${dayStr}.sqlite`;
    const tmpPath = path.join(this.dataDir, `.backup-${dayStr}-${Date.now()}.sqlite`);
    try {
      writeBackup(tmpPath);
      const upload = new Upload({
        client: r2,
        params: {
          Bucket: settings.r2BucketName,
          Key: key,
          Body: fs.createReadStream(tmpPath),
          ContentType: 'application/x-sqlite3',
        },
      });
      await upload.done();

      let prunedBackups = 0;
      try {
        const listed = await r2.send(
          new ListObjectsV2Command({
            Bucket: settings.r2BucketName,
            Prefix: 'backups/syncflow-',
          })
        );
        const cutoffMs = Date.now() - Math.max(1, keepDays) * 24 * 60 * 60_000;
        for (const obj of listed.Contents ?? []) {
          if (obj.Key && obj.Key !== key && obj.LastModified && obj.LastModified.getTime() < cutoffMs) {
            await r2
              .send(
                new DeleteObjectCommand({
                  Bucket: settings.r2BucketName,
                  Key: obj.Key,
                })
              )
              .catch(() => {});
            prunedBackups++;
          }
        }
      } catch {
        // Best-effort pruning
      }

      return { uploadedKey: key, prunedBackups };
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
}
