import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { AppSettingsFull } from '../db/database.js';
import { normalizeCoverImage } from './media.js';

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
}
