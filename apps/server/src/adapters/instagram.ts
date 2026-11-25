import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { InstagramReelsMetadata } from '@clipflow/shared';
import type {
  AdapterContext,
  OAuthAppCredentials,
  OAuthTokenResponse,
  PlatformAdapter,
  PreWarmResult,
  PublishResult,
} from './types.js';
import { FacebookAdapter } from './facebook.js';
import {
  fetchWithRetry,
  isTransientNetworkError,
} from '../services/net-resilience.js';

const GRAPH_VERSION = 'v22.0';
const fbHelper = new FacebookAdapter();

export class InstagramAdapter implements PlatformAdapter {
  readonly platform = 'INSTAGRAM' as const;

  getAuthUrl(params: {
    accountId: string;
    redirectUri: string;
    state: string;
    credentials?: OAuthAppCredentials;
  }): string {
    const appId =
      params.credentials?.metaAppId || process.env.META_APP_ID || '';
    if (!appId) {
      throw new Error('ยังไม่ได้ตั้งค่า Meta App ID (กรอกในหน้านี้ได้เลย)');
    }
    const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set(
      'scope',
      'instagram_basic,instagram_content_publish,pages_show_list,pages_manage_posts'
    );
    url.searchParams.set('state', params.state);
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    credentials?: OAuthAppCredentials;
  }): Promise<OAuthTokenResponse> {
    const res = await fbHelper.exchangeCode(params);
    if (res.pairedIgAccount) {
      return {
        accessToken: res.accessToken,
        externalAccountId: res.pairedIgAccount.igUserId,
        accountName:
          res.pairedIgAccount.igUsername
            ? `@${res.pairedIgAccount.igUsername}`
            : res.pairedIgAccount.igName || res.accountName,
        expiresAt: res.expiresAt,
      };
    }
    return res;
  }

  async preWarm(ctx: AdapterContext): Promise<PreWarmResult> {
    const meta = ctx.job.metadataSnapshot as unknown as InstagramReelsMetadata;

    if (ctx.account.connectionMode === 'SIMULATION') {
      const containerId = `ig_cnt_${randomBytes(5).toString('hex')}`;
      const containerCreatedAt = new Date().toISOString();
      ctx.log(
        'INFO',
        'IG_PREWARM_CONTAINER',
        `[Simulation] สร้าง IG Reels Container (${containerId}) และ Poll status_code=FINISHED (ใช้ได้ภายใน 24 ชม.)`,
        {
          shareToFeed: meta.shareToFeed,
          thumbOffsetMs: meta.thumbOffsetMs,
          coverUrl: ctx.asset.customCoverPublicUrl || null,
        }
      );
      ctx.onContainerCreated?.(containerId, containerCreatedAt);
      return {
        externalContainerId: containerId,
        containerCreatedAt,
      };
    }

    if (!ctx.accessToken || !ctx.account.externalAccountId) {
      throw new Error('ไม่มี Instagram Business Access Token หรือ IG User ID');
    }

    const canUsePublicUrl = Boolean(ctx.asset.publicUrl);
    try {
      return await this.createAndWaitContainer(ctx, meta, canUsePublicUrl);
    } catch (err) {
      const hasLocalFallback =
        canUsePublicUrl &&
        !isTransientNetworkError(err) &&
        Boolean(ctx.localFilePath && fs.existsSync(ctx.localFilePath));
      if (!hasLocalFallback) {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.log(
        'WARN',
        'IG_RESUMABLE_FALLBACK',
        `สร้าง IG Container ผ่าน R2 video_url ไม่สำเร็จ (${errMsg}) — สลับไปอัปโหลดไฟล์ตรงผ่าน rupload.facebook.com อัตโนมัติ`
      );
      return await this.createAndWaitContainer(ctx, meta, false);
    }
  }

  private async createAndWaitContainer(
    ctx: AdapterContext,
    meta: InstagramReelsMetadata,
    usePublicUrl: boolean
  ): Promise<PreWarmResult> {
    const igUserId = ctx.account.externalAccountId;
    const token = ctx.accessToken!;
    const useCoverUrl = Boolean(ctx.asset.customCoverPublicUrl);

    let uploadFilePath = ctx.localFilePath;
    let usedCoverFrame = false;
    if (
      !usePublicUrl &&
      !useCoverUrl &&
      ctx.hasCustomCover &&
      ctx.getCoverVideoPath
    ) {
      uploadFilePath = await ctx.getCoverVideoPath();
      usedCoverFrame = uploadFilePath !== ctx.localFilePath;
      if (usedCoverFrame) {
        ctx.log(
          'INFO',
          'IG_COVER_FRAME_INJECTED',
          'ฝังเฟรมหน้าปก (0.15 วินาที) ลงต้นคลิป IG Reels (โหมดไม่มี R2) ก่อนอัปโหลด'
        );
      }
    }

    const buildCreateBody = (includeCoverUrl: boolean) => {
      const body = new URLSearchParams({
        access_token: token,
        media_type: 'REELS',
        caption: meta.caption || '',
        share_to_feed: meta.shareToFeed ? 'true' : 'false',
      });
      if (meta.isAiGenerated) {
        body.set('is_ai_generated', 'true');
      }
      if (includeCoverUrl && ctx.asset.customCoverPublicUrl) {
        body.set('cover_url', ctx.asset.customCoverPublicUrl);
      } else if (usedCoverFrame) {
        body.set('thumb_offset', '0');
      } else if (meta.thumbOffsetMs > 0) {
        body.set('thumb_offset', String(meta.thumbOffsetMs));
      }
      if (usePublicUrl && ctx.asset.publicUrl) {
        body.set('video_url', ctx.asset.publicUrl);
      } else {
        body.set('upload_type', 'resumable');
      }
      return body;
    };

    if (useCoverUrl) {
      ctx.log(
        'INFO',
        'IG_COVER_URL_SET',
        'แนบลิงก์หน้าปก (cover_url) ให้ IG Reels เรียบร้อย',
        { coverUrl: ctx.asset.customCoverPublicUrl }
      );
    }

    let initRes = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
      { method: 'POST', body: buildCreateBody(useCoverUrl) }
    );
    if (!initRes.ok) {
      const errText = await initRes.text();
      if (useCoverUrl && /cover_url|cover|image|download/i.test(errText)) {
        ctx.log(
          'WARN',
          'IG_COVER_URL_FALLBACK',
          'Meta ดึง cover_url ไม่สำเร็จ กำลังสร้าง Container ใหม่โดยใช้เฟรมจากวิดีโอแทน',
          { error: errText }
        );
        initRes = await fetchWithRetry(
          `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
          { method: 'POST', body: buildCreateBody(false) }
        );
        if (!initRes.ok) {
          throw new Error(`IG media container init failed: ${await initRes.text()}`);
        }
      } else {
        throw new Error(`IG media container init failed: ${errText}`);
      }
    }
    const initJson = (await initRes.json()) as { id: string; uri?: string };
    const containerId = initJson.id;

    if (!usePublicUrl) {
      const uploadUri =
        initJson.uri ||
        `https://rupload.facebook.com/ig-api-upload/${GRAPH_VERSION}/${containerId}`;
      const stat = await fs.promises.stat(uploadFilePath);
      const fileBuf = await fs.promises.readFile(uploadFilePath);

      const upRes = await fetchWithRetry(uploadUri, {
        method: 'POST',
        headers: {
          Authorization: `OAuth ${token}`,
          offset: '0',
          file_size: String(stat.size),
          'Content-Type': 'application/octet-stream',
        },
        body: fileBuf,
      });
      if (!upRes.ok) {
        throw new Error(`IG rupload failed: ${await upRes.text()}`);
      }
    }

    // Poll until FINISHED (up to ~3 minutes)
    for (let attempt = 0; attempt < 36; attempt++) {
      const stRes = await fetchWithRetry(
        `https://graph.facebook.com/${GRAPH_VERSION}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
      );
      if (stRes.ok) {
        const stData = (await stRes.json()) as {
          status_code?: string;
          status?: string;
        };
        if (stData.status_code === 'FINISHED') {
          const containerCreatedAt = new Date().toISOString();
          ctx.log(
            'INFO',
            'IG_CONTAINER_FINISHED',
            'IG Container ประมวลผลเสร็จพร้อมเผยแพร่',
            { containerId }
          );
          ctx.onContainerCreated?.(containerId, containerCreatedAt);
          return {
            externalContainerId: containerId,
            containerCreatedAt,
          };
        }
        if (stData.status_code === 'ERROR' || stData.status_code === 'EXPIRED') {
          throw new Error(
            `IG Container status ${stData.status_code}: ${stData.status ?? ''}`
          );
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    throw new Error('IG Container processing timeout');
  }

  async publishNow(ctx: AdapterContext): Promise<PublishResult> {
    let containerId = ctx.job.externalContainerId;
    const containerSnapshotTime = (
      ctx.job.metadataSnapshot as { __containerCreatedAt?: string }
    ).__containerCreatedAt;

    const isNearOrPast24h =
      containerSnapshotTime &&
      Date.now() - new Date(containerSnapshotTime).getTime() > 23.5 * 3600_000;

    if (!containerId || isNearOrPast24h) {
      ctx.log(
        'INFO',
        'IG_JIT_WARM',
        isNearOrPast24h
          ? 'Container เดิมใกล้หมดอายุ 24 ชม. — สร้าง Container ใหม่อัตโนมัติ'
          : 'ยังไม่มี Pre-warm Container — กำลังสร้างและรอประมวลผล'
      );
      const warm = await this.preWarm(ctx);
      containerId = warm.externalContainerId;
    }

    if (ctx.account.connectionMode === 'SIMULATION') {
      const postId = `ig_${randomBytes(5).toString('hex')}`;
      const url = `https://www.instagram.com/reel/${postId}/`;
      ctx.log(
        'INFO',
        'IG_MEDIA_PUBLISH',
        `[Simulation] เผยแพร่ IG Reel จาก Container ${containerId} สำเร็จ`,
        { externalPostId: postId, externalUrl: url }
      );
      return { externalPostId: postId, externalUrl: url };
    }

    if (!ctx.accessToken || !ctx.account.externalAccountId) {
      throw new Error('Missing Instagram credentials');
    }

    let pubRes = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${ctx.account.externalAccountId}/media_publish`,
      {
        method: 'POST',
        body: new URLSearchParams({
          access_token: ctx.accessToken,
          creation_id: containerId,
        }),
      }
    );
    if (!pubRes.ok) {
      const errText = await pubRes.text();
      if (/expired|invalid.*creation_id|2207027|9007/i.test(errText)) {
        ctx.log(
          'WARN',
          'IG_CONTAINER_RECREATE',
          'Container เดิมหมดอายุหรือใช้งานไม่ได้ — กำลังสร้าง Container ใหม่และเผยแพร่อัตโนมัติ',
          { previousContainerId: containerId, error: errText }
        );
        const warm = await this.preWarm(ctx);
        containerId = warm.externalContainerId;
        pubRes = await fetchWithRetry(
          `https://graph.facebook.com/${GRAPH_VERSION}/${ctx.account.externalAccountId}/media_publish`,
          {
            method: 'POST',
            body: new URLSearchParams({
              access_token: ctx.accessToken,
              creation_id: containerId,
            }),
          }
        );
        if (!pubRes.ok) {
          throw new Error(`IG media_publish failed: ${await pubRes.text()}`);
        }
      } else {
        throw new Error(`IG media_publish failed: ${errText}`);
      }
    }
    const pubJson = (await pubRes.json()) as { id: string };
    return {
      externalPostId: pubJson.id,
      externalUrl: `https://www.instagram.com/reels/${pubJson.id}/`,
    };
  }
}
