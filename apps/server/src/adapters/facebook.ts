import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type {
  FacebookReelsMetadata,
  FacebookVideoMetadata,
} from '@clipflow/shared';
import type {
  AdapterContext,
  OAuthAppCredentials,
  OAuthTokenResponse,
  PlatformAdapter,
  PreUploadResult,
  PublishResult,
} from './types.js';

const GRAPH_VERSION = 'v22.0';

export interface DiscoveredMetaPageFull {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  igUserId: string | null;
  igUsername: string | null;
  igName: string | null;
}

export async function discoverMetaPages(
  accessToken: string
): Promise<DiscoveredMetaPageFull[]> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Meta /me/accounts error: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: Array<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: {
        id: string;
        username?: string;
        name?: string;
      };
    }>;
  };
  return (json.data ?? []).map((p) => ({
    pageId: p.id,
    pageName: p.name,
    pageAccessToken: p.access_token,
    igUserId: p.instagram_business_account?.id ?? null,
    igUsername: p.instagram_business_account?.username ?? null,
    igName: p.instagram_business_account?.name ?? null,
  }));
}

export class FacebookAdapter implements PlatformAdapter {
  readonly platform = 'FACEBOOK' as const;

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
      'pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish'
    );
    url.searchParams.set('state', params.state);
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    credentials?: OAuthAppCredentials;
  }): Promise<OAuthTokenResponse> {
    const appId =
      params.credentials?.metaAppId || process.env.META_APP_ID || '';
    const appSecret =
      params.credentials?.metaAppSecret || process.env.META_APP_SECRET || '';
    if (!appId || !appSecret) {
      throw new Error('Meta App ID หรือ App Secret ไม่ครบ');
    }
    const tokenUrl = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
    );
    tokenUrl.searchParams.set('client_id', appId);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('redirect_uri', params.redirectUri);
    tokenUrl.searchParams.set('code', params.code);

    const res = await fetch(tokenUrl.toString());
    if (!res.ok) throw new Error(`Facebook OAuth error: ${await res.text()}`);
    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };

    const llUrl = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
    );
    llUrl.searchParams.set('grant_type', 'fb_exchange_token');
    llUrl.searchParams.set('client_id', appId);
    llUrl.searchParams.set('client_secret', appSecret);
    llUrl.searchParams.set('fb_exchange_token', data.access_token);
    const llRes = await fetch(llUrl.toString());
    const llData = llRes.ok
      ? ((await llRes.json()) as { access_token: string; expires_in?: number })
      : data;

    try {
      const pages = await discoverMetaPages(llData.access_token);
      const firstPage = pages[0];
      if (firstPage) {
        return {
          accessToken: firstPage.pageAccessToken,
          externalAccountId: firstPage.pageId,
          accountName: firstPage.pageName,
          expiresAt: null,
          pairedIgAccount: firstPage.igUserId
            ? {
                igUserId: firstPage.igUserId,
                igUsername: firstPage.igUsername,
                igName: firstPage.igName,
              }
            : null,
        };
      }
    } catch {
      // fallback to user token
    }

    return {
      accessToken: llData.access_token,
      expiresAt: llData.expires_in
        ? new Date(Date.now() + llData.expires_in * 1000).toISOString()
        : null,
    };
  }

  async preUploadSchedule(ctx: AdapterContext): Promise<PreUploadResult> {
    const targetMs = new Date(ctx.job.scheduledAt).getTime();
    const diffMin = (targetMs - Date.now()) / 60_000;
    const isReels = ctx.job.format === 'FACEBOOK_REELS';
    const maxNativeDays = isReels ? 29 : 180;
    const useNativeSchedule = diffMin >= 10 && diffMin <= maxNativeDays * 1440;

    if (ctx.account.connectionMode === 'SIMULATION') {
      const simId = `fb_${randomBytes(5).toString('hex')}`;
      const url = `https://www.facebook.com/${isReels ? 'reel' : 'watch'}/?v=${simId}`;
      ctx.log(
        'INFO',
        isReels ? 'FB_REELS_RUPLOAD' : 'FB_VIDEO_CHUNK_UPLOAD',
        `[Simulation] อัปโหลด ${ctx.job.format} ผ่าน ${isReels ? 'video_reels + rupload' : 'graph-video /videos'}`,
        {
          scheduledPublishTimeUnix: Math.floor(targetMs / 1000),
          nativeScheduled: useNativeSchedule,
          hasCustomCover: Boolean(ctx.thumbnailPath && !isReels),
        }
      );
      return {
        externalPostId: simId,
        externalUrl: url,
        status: useNativeSchedule ? 'NATIVE_SCHEDULED' : 'PUBLISHED',
      };
    }

    if (!ctx.accessToken || !ctx.account.externalAccountId) {
      throw new Error('ไม่มี Page Access Token หรือ Page ID สำหรับ Facebook');
    }

    if (isReels) {
      return this.uploadFacebookReel(ctx, useNativeSchedule);
    }
    return this.uploadFacebookPageVideo(ctx, useNativeSchedule);
  }

  private async uploadFacebookReel(
    ctx: AdapterContext,
    useNativeSchedule: boolean
  ): Promise<PreUploadResult> {
    if (ctx.asset.probe.durationSec > 90) {
      throw new Error(
        `Facebook Reels API รองรับความยาวสูงสุด 90 วินาที (คลิปนี้ยาว ${Math.round(ctx.asset.probe.durationSec)} วินาที) กรุณาสลับเป็น Facebook วิดีโอเพจ`
      );
    }

    const pageId = ctx.account.externalAccountId;
    const token = ctx.accessToken!;
    const meta = ctx.job.metadataSnapshot as unknown as FacebookReelsMetadata;
    const stat = await fs.promises.stat(ctx.localFilePath);

    // 1. Start session
    const startRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upload_phase: 'start',
          access_token: token,
        }),
      }
    );
    if (!startRes.ok) {
      throw new Error(`FB Reels start failed: ${await startRes.text()}`);
    }
    const { video_id: videoId, upload_url: uploadUrl } =
      (await startRes.json()) as { video_id: string; upload_url: string };

    // 2. Binary upload to rupload.facebook.com
    const fileBuf = await fs.promises.readFile(ctx.localFilePath);
    const ruploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`,
        offset: '0',
        file_size: String(stat.size),
        'Content-Type': 'application/octet-stream',
      },
      body: fileBuf,
    });
    if (!ruploadRes.ok) {
      throw new Error(`FB Reels rupload failed: ${await ruploadRes.text()}`);
    }

    // 3. Finish & schedule or publish
    const finishParams = new URLSearchParams({
      access_token: token,
      video_id: videoId,
      upload_phase: 'finish',
      description: meta.description || '',
    });
    if (meta.title) finishParams.set('title', meta.title);
    if (meta.isAiGenerated) finishParams.set('is_ai_generated', 'true');
    if (useNativeSchedule) {
      finishParams.set('video_state', 'SCHEDULED');
      finishParams.set(
        'scheduled_publish_time',
        String(Math.floor(new Date(ctx.job.scheduledAt).getTime() / 1000))
      );
    } else {
      finishParams.set('video_state', 'PUBLISHED');
    }

    const finishRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`,
      {
        method: 'POST',
        body: finishParams,
      }
    );
    if (!finishRes.ok) {
      throw new Error(`FB Reels finish failed: ${await finishRes.text()}`);
    }

    return {
      externalPostId: videoId,
      externalUrl: `https://www.facebook.com/reel/${videoId}`,
      status: useNativeSchedule ? 'NATIVE_SCHEDULED' : 'PUBLISHED',
    };
  }

  private async uploadFacebookPageVideo(
    ctx: AdapterContext,
    useNativeSchedule: boolean
  ): Promise<PreUploadResult> {
    const pageId = ctx.account.externalAccountId;
    const token = ctx.accessToken!;
    const meta = ctx.job.metadataSnapshot as unknown as FacebookVideoMetadata;
    const stat = await fs.promises.stat(ctx.localFilePath);

    // 1. Start resumable upload on graph-video.facebook.com
    const startParams = new URLSearchParams({
      access_token: token,
      upload_phase: 'start',
      file_size: String(stat.size),
    });
    const startRes = await fetch(
      `https://graph-video.facebook.com/${GRAPH_VERSION}/${pageId}/videos`,
      { method: 'POST', body: startParams }
    );
    if (!startRes.ok) {
      throw new Error(`FB video start failed: ${await startRes.text()}`);
    }
    const startJson = (await startRes.json()) as {
      upload_session_id: string;
      video_id: string;
      start_offset: string;
      end_offset: string;
    };

    const handle = await fs.promises.open(ctx.localFilePath, 'r');
    try {
      let startOffset = Number(startJson.start_offset);
      let endOffset = Number(startJson.end_offset);

      while (startOffset < endOffset) {
        const len = endOffset - startOffset;
        const buf = Buffer.alloc(len);
        await handle.read(buf, 0, len, startOffset);

        const form = new FormData();
        form.append('access_token', token);
        form.append('upload_phase', 'transfer');
        form.append('upload_session_id', startJson.upload_session_id);
        form.append('start_offset', String(startOffset));
        form.append(
          'video_file_chunk',
          new Blob([buf], { type: 'video/mp4' }),
          'chunk.mp4'
        );

        const trRes = await fetch(
          `https://graph-video.facebook.com/${GRAPH_VERSION}/${pageId}/videos`,
          { method: 'POST', body: form }
        );
        if (!trRes.ok) {
          throw new Error(`FB video transfer failed: ${await trRes.text()}`);
        }
        const trJson = (await trRes.json()) as {
          start_offset: string;
          end_offset: string;
        };
        startOffset = Number(trJson.start_offset);
        endOffset = Number(trJson.end_offset);
      }
    } finally {
      await handle.close();
    }

    const finishParams = new URLSearchParams({
      access_token: token,
      upload_phase: 'finish',
      upload_session_id: startJson.upload_session_id,
      title: meta.title || '',
      description: meta.description || '',
    });
    if (meta.isAiGenerated) finishParams.set('is_ai_generated', 'true');
    if (useNativeSchedule) {
      finishParams.set('published', 'false');
      finishParams.set(
        'scheduled_publish_time',
        String(Math.floor(new Date(ctx.job.scheduledAt).getTime() / 1000))
      );
    } else {
      finishParams.set('published', 'true');
    }

    const finishRes = await fetch(
      `https://graph-video.facebook.com/${GRAPH_VERSION}/${pageId}/videos`,
      { method: 'POST', body: finishParams }
    );
    if (!finishRes.ok) {
      throw new Error(`FB video finish failed: ${await finishRes.text()}`);
    }

    if (ctx.thumbnailPath && fs.existsSync(ctx.thumbnailPath)) {
      try {
        const thumbBuf = await fs.promises.readFile(ctx.thumbnailPath);
        const thumbForm = new FormData();
        thumbForm.append('access_token', token);
        thumbForm.append('is_preferred', 'true');
        thumbForm.append(
          'source',
          new Blob([thumbBuf], { type: 'image/jpeg' }),
          'cover.jpg'
        );
        await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${startJson.video_id}/thumbnails`,
          { method: 'POST', body: thumbForm }
        );
        ctx.log('INFO', 'FB_THUMBNAIL_SET', 'อัปโหลดภาพหน้าปก Facebook Video สำเร็จ');
      } catch (err) {
        ctx.log('WARN', 'FB_THUMBNAIL_WARN', 'ไม่สามารถอัปโหลดภาพปก Facebook ได้', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      externalPostId: startJson.video_id,
      externalUrl: `https://www.facebook.com/watch/?v=${startJson.video_id}`,
      status: useNativeSchedule ? 'NATIVE_SCHEDULED' : 'PUBLISHED',
    };
  }

  async publishNow(ctx: AdapterContext): Promise<PublishResult> {
    if (ctx.job.status === 'NATIVE_SCHEDULED' && ctx.job.externalPostId) {
      ctx.log(
        'INFO',
        'FB_NATIVE_VERIFY',
        'คลิป Facebook ถูกตั้งเวลาล่วงหน้าไว้แล้ว — ยืนยันสถานะเผยแพร่',
        { externalPostId: ctx.job.externalPostId }
      );
      return {
        externalPostId: ctx.job.externalPostId,
        externalUrl: ctx.job.externalUrl,
      };
    }

    const res = await this.preUploadSchedule(ctx);
    return {
      externalPostId: res.externalPostId,
      externalUrl: res.externalUrl,
    };
  }

  async updateSchedule(params: {
    ctx: AdapterContext;
    newScheduledAtIso: string;
  }): Promise<void> {
    const { ctx, newScheduledAtIso } = params;
    if (!ctx.job.externalPostId) return;
    if (ctx.account.connectionMode === 'SIMULATION') {
      ctx.log(
        'INFO',
        'FB_RESCHEDULE',
        `[Simulation] อัปเดตเวลา scheduled_publish_time บน Facebook เป็น ${newScheduledAtIso}`
      );
      return;
    }
    if (!ctx.accessToken) return;
    await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${ctx.job.externalPostId}`,
      {
        method: 'POST',
        body: new URLSearchParams({
          access_token: ctx.accessToken,
          scheduled_publish_time: String(
            Math.floor(new Date(newScheduledAtIso).getTime() / 1000)
          ),
        }),
      }
    );
  }

  async cancelSchedule(ctx: AdapterContext): Promise<void> {
    if (!ctx.job.externalPostId) return;
    if (ctx.account.connectionMode === 'SIMULATION') {
      ctx.log(
        'INFO',
        'FB_CANCEL',
        `[Simulation] ยกเลิกวิดีโอที่ตั้งเวลาไว้ ${ctx.job.externalPostId}`
      );
      return;
    }
    if (!ctx.accessToken) return;
    await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${ctx.job.externalPostId}?access_token=${encodeURIComponent(ctx.accessToken)}`,
      { method: 'DELETE' }
    );
  }
}
