import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
const GRAPH_VERSION = 'v22.0';
export async function discoverMetaPages(accessToken) {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Meta /me/accounts error: ${await res.text()}`);
    }
    const json = (await res.json());
    return (json.data ?? []).map((p) => ({
        pageId: p.id,
        pageName: p.name,
        pageAccessToken: p.access_token,
        igUserId: p.instagram_business_account?.id ?? null,
        igUsername: p.instagram_business_account?.username ?? null,
        igName: p.instagram_business_account?.name ?? null,
    }));
}
export class FacebookAdapter {
    platform = 'FACEBOOK';
    getAuthUrl(params) {
        const appId = params.credentials?.metaAppId || process.env.META_APP_ID || '';
        if (!appId) {
            throw new Error('ยังไม่ได้ตั้งค่า Meta App ID (กรอกในหน้านี้ได้เลย)');
        }
        const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
        url.searchParams.set('client_id', appId);
        url.searchParams.set('redirect_uri', params.redirectUri);
        url.searchParams.set('scope', 'pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish');
        url.searchParams.set('state', params.state);
        return url.toString();
    }
    async exchangeCode(params) {
        const appId = params.credentials?.metaAppId || process.env.META_APP_ID || '';
        const appSecret = params.credentials?.metaAppSecret || process.env.META_APP_SECRET || '';
        if (!appId || !appSecret) {
            throw new Error('Meta App ID หรือ App Secret ไม่ครบ');
        }
        const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
        tokenUrl.searchParams.set('client_id', appId);
        tokenUrl.searchParams.set('client_secret', appSecret);
        tokenUrl.searchParams.set('redirect_uri', params.redirectUri);
        tokenUrl.searchParams.set('code', params.code);
        const res = await fetch(tokenUrl.toString());
        if (!res.ok)
            throw new Error(`Facebook OAuth error: ${await res.text()}`);
        const data = (await res.json());
        const llUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
        llUrl.searchParams.set('grant_type', 'fb_exchange_token');
        llUrl.searchParams.set('client_id', appId);
        llUrl.searchParams.set('client_secret', appSecret);
        llUrl.searchParams.set('fb_exchange_token', data.access_token);
        const llRes = await fetch(llUrl.toString());
        const llData = llRes.ok
            ? (await llRes.json())
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
        }
        catch {
            // fallback to user token
        }
        return {
            accessToken: llData.access_token,
            expiresAt: llData.expires_in
                ? new Date(Date.now() + llData.expires_in * 1000).toISOString()
                : null,
        };
    }
    async preUploadSchedule(ctx) {
        const targetMs = new Date(ctx.job.scheduledAt).getTime();
        const diffMin = (targetMs - Date.now()) / 60_000;
        const isReels = ctx.job.format === 'FACEBOOK_REELS';
        const maxNativeDays = isReels ? 29 : 180;
        const useNativeSchedule = diffMin >= 10 && diffMin <= maxNativeDays * 1440;
        if (ctx.account.connectionMode === 'SIMULATION') {
            const simId = `fb_${randomBytes(5).toString('hex')}`;
            const url = `https://www.facebook.com/${isReels ? 'reel' : 'watch'}/?v=${simId}`;
            ctx.log('INFO', isReels ? 'FB_REELS_RUPLOAD' : 'FB_VIDEO_CHUNK_UPLOAD', `[Simulation] อัปโหลด ${ctx.job.format} ผ่าน ${isReels ? 'video_reels + rupload' : 'graph-video /videos'}`, {
                scheduledPublishTimeUnix: Math.floor(targetMs / 1000),
                nativeScheduled: useNativeSchedule,
                hasCustomCover: Boolean(ctx.thumbnailPath),
            });
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
            throw new Error('Live Facebook Reels must run through the durable publishing scheduler');
        }
        return this.uploadFacebookPageVideo(ctx, useNativeSchedule);
    }
    async uploadFacebookPageVideo(ctx, useNativeSchedule) {
        const pageId = ctx.account.externalAccountId;
        const token = ctx.accessToken;
        const meta = ctx.job.metadataSnapshot;
        const stat = await fs.promises.stat(ctx.localFilePath);
        // 1. Start resumable upload on graph-video.facebook.com
        const startParams = new URLSearchParams({
            access_token: token,
            upload_phase: 'start',
            file_size: String(stat.size),
        });
        const startRes = await fetch(`https://graph-video.facebook.com/${GRAPH_VERSION}/${pageId}/videos`, { method: 'POST', body: startParams });
        if (!startRes.ok) {
            throw new Error(`FB video start failed: ${await startRes.text()}`);
        }
        const startJson = (await startRes.json());
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
                form.append('video_file_chunk', new Blob([buf], { type: 'video/mp4' }), 'chunk.mp4');
                const trRes = await fetch(`https://graph-video.facebook.com/${GRAPH_VERSION}/${pageId}/videos`, { method: 'POST', body: form });
                if (!trRes.ok) {
                    throw new Error(`FB video transfer failed: ${await trRes.text()}`);
                }
                const trJson = (await trRes.json());
                startOffset = Number(trJson.start_offset);
                endOffset = Number(trJson.end_offset);
            }
        }
        finally {
            await handle.close();
        }
        const finishParams = new URLSearchParams({
            access_token: token,
            upload_phase: 'finish',
            upload_session_id: startJson.upload_session_id,
            title: meta.title || '',
            description: meta.description || '',
        });
        if (meta.isAiGenerated)
            finishParams.set('is_ai_generated', 'true');
        if (useNativeSchedule) {
            finishParams.set('published', 'false');
            finishParams.set('scheduled_publish_time', String(Math.floor(new Date(ctx.job.scheduledAt).getTime() / 1000)));
        }
        else {
            finishParams.set('published', 'true');
        }
        const finishRes = await fetch(`https://graph-video.facebook.com/${GRAPH_VERSION}/${pageId}/videos`, { method: 'POST', body: finishParams });
        if (!finishRes.ok) {
            throw new Error(`FB video finish failed: ${await finishRes.text()}`);
        }
        if (ctx.thumbnailPath && fs.existsSync(ctx.thumbnailPath)) {
            await this.uploadFacebookThumbnail(startJson.video_id, token, ctx.thumbnailPath, ctx, 'Facebook Video');
        }
        return {
            externalPostId: startJson.video_id,
            externalUrl: `https://www.facebook.com/watch/?v=${startJson.video_id}`,
            status: useNativeSchedule ? 'NATIVE_SCHEDULED' : 'PUBLISHED',
        };
    }
    async uploadFacebookThumbnail(videoId, token, thumbnailPath, ctx, label) {
        const thumbBuf = await fs.promises.readFile(thumbnailPath);
        let lastError = 'Unknown error';
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const thumbForm = new FormData();
                thumbForm.append('access_token', token);
                thumbForm.append('is_preferred', 'true');
                thumbForm.append('source', new Blob([thumbBuf], { type: 'image/jpeg' }), 'cover.jpg');
                const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${videoId}/thumbnails`, { method: 'POST', body: thumbForm });
                if (res.ok) {
                    ctx.log('INFO', 'FB_THUMBNAIL_SET', `อัปโหลดภาพหน้าปก ${label} สำเร็จ`, {
                        videoId,
                        attempt,
                    });
                    return;
                }
                lastError = `HTTP ${res.status}: ${await res.text()}`;
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
            }
            if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 3000));
            }
        }
        ctx.log('WARN', 'FB_THUMBNAIL_WARN', `ไม่สามารถอัปโหลดภาพปก ${label} ได้`, {
            videoId,
            error: lastError,
        });
    }
    async publishNow(ctx) {
        if (ctx.job.format === 'FACEBOOK_REELS' && ctx.account.connectionMode === 'LIVE_OFFICIAL') {
            throw new Error('Live Facebook Reels must run through the durable publishing scheduler');
        }
        if (ctx.job.status === 'NATIVE_SCHEDULED' && ctx.job.externalPostId) {
            ctx.log('INFO', 'FB_NATIVE_VERIFY', 'คลิป Facebook ถูกตั้งเวลาล่วงหน้าไว้แล้ว — ยืนยันสถานะเผยแพร่', { externalPostId: ctx.job.externalPostId });
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
    async updateSchedule(params) {
        const { ctx, newScheduledAtIso } = params;
        const videoId = ctx.job.facebookReel?.videoId ?? ctx.job.externalPostId;
        if (!videoId)
            return;
        if (ctx.account.connectionMode === 'SIMULATION') {
            ctx.log('INFO', 'FB_RESCHEDULE', `[Simulation] อัปเดตเวลา scheduled_publish_time บน Facebook เป็น ${newScheduledAtIso}`);
            return;
        }
        if (!ctx.accessToken) {
            if (ctx.job.facebookReel)
                throw new Error('Reconnect the original Facebook Page first.');
            return;
        }
        const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${videoId}`, {
            method: 'POST',
            signal: AbortSignal.timeout(15_000),
            body: new URLSearchParams({
                access_token: ctx.accessToken,
                scheduled_publish_time: String(Math.floor(new Date(newScheduledAtIso).getTime() / 1000)),
            }),
        });
        if (ctx.job.facebookReel && (!response.ok || (await response.json().catch(() => null))?.success !== true)) {
            throw new Error('Meta did not confirm the scheduled Reel change (HTTP ' + response.status + ').');
        }
    }
    async cancelSchedule(ctx) {
        const videoId = ctx.job.facebookReel?.videoId ?? ctx.job.externalPostId;
        if (!videoId)
            return;
        if (ctx.account.connectionMode === 'SIMULATION') {
            ctx.log('INFO', 'FB_CANCEL', `[Simulation] ยกเลิกวิดีโอที่ตั้งเวลาไว้ ${videoId}`);
            return;
        }
        if (!ctx.accessToken) {
            if (ctx.job.facebookReel)
                throw new Error('Reconnect the original Facebook Page first.');
            return;
        }
        const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${videoId}?access_token=${encodeURIComponent(ctx.accessToken)}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
        if (ctx.job.facebookReel && (!response.ok || (await response.json().catch(() => null))?.success !== true)) {
            throw new Error('Meta did not confirm the scheduled Reel change (HTTP ' + response.status + ').');
        }
    }
}
//# sourceMappingURL=facebook.js.map