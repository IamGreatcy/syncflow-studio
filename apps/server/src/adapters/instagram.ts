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
      return {
        externalContainerId: containerId,
        containerCreatedAt: new Date().toISOString(),
      };
    }

    if (!ctx.accessToken || !ctx.account.externalAccountId) {
      throw new Error('ไม่มี Instagram Business Access Token หรือ IG User ID');
    }

    const igUserId = ctx.account.externalAccountId;
    const token = ctx.accessToken;
    const usePublicUrl = Boolean(ctx.asset.publicUrl);

    const createBody = new URLSearchParams({
      access_token: token,
      media_type: 'REELS',
      caption: meta.caption || '',
      share_to_feed: meta.shareToFeed ? 'true' : 'false',
    });
    if (meta.isAiGenerated) {
      createBody.set('is_ai_generated', 'true');
    }
    if (ctx.asset.customCoverPublicUrl) {
      createBody.set('cover_url', ctx.asset.customCoverPublicUrl);
    } else if (meta.thumbOffsetMs > 0) {
      createBody.set('thumb_offset', String(meta.thumbOffsetMs));
    }

    if (usePublicUrl && ctx.asset.publicUrl) {
      createBody.set('video_url', ctx.asset.publicUrl);
    } else {
      createBody.set('upload_type', 'resumable');
    }

    const initRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
      { method: 'POST', body: createBody }
    );
    if (!initRes.ok) {
      throw new Error(`IG media container init failed: ${await initRes.text()}`);
    }
    const initJson = (await initRes.json()) as { id: string; uri?: string };
    const containerId = initJson.id;

    if (!usePublicUrl) {
      const uploadUri =
        initJson.uri ||
        `https://rupload.facebook.com/ig-api-upload/${GRAPH_VERSION}/${containerId}`;
      const stat = await fs.promises.stat(ctx.localFilePath);
      const fileBuf = await fs.promises.readFile(ctx.localFilePath);

      const upRes = await fetch(uploadUri, {
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
      const stRes = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
      );
      if (stRes.ok) {
        const stData = (await stRes.json()) as {
          status_code?: string;
          status?: string;
        };
        if (stData.status_code === 'FINISHED') {
          ctx.log('INFO', 'IG_CONTAINER_FINISHED', 'IG Container ประมวลผลเสร็จพร้อมเผยแพร่', {
            containerId,
          });
          return {
            externalContainerId: containerId,
            containerCreatedAt: new Date().toISOString(),
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

    const pubRes = await fetch(
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
    const pubJson = (await pubRes.json()) as { id: string };
    return {
      externalPostId: pubJson.id,
      externalUrl: `https://www.instagram.com/reels/${pubJson.id}/`,
    };
  }
}
