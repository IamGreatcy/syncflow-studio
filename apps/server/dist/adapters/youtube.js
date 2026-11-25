import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
export class YouTubeAdapter {
    platform = 'YOUTUBE';
    getAuthUrl(params) {
        const clientId = params.credentials?.googleClientId || process.env.GOOGLE_CLIENT_ID || '';
        if (!clientId) {
            throw new Error('ยังไม่ได้ตั้งค่า Google Client ID (กรอกในหน้านี้ได้เลย)');
        }
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', params.redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/youtube.readonly');
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
        url.searchParams.set('state', params.state);
        return url.toString();
    }
    async exchangeCode(params) {
        const clientId = params.credentials?.googleClientId || process.env.GOOGLE_CLIENT_ID || '';
        const clientSecret = params.credentials?.googleClientSecret ||
            process.env.GOOGLE_CLIENT_SECRET ||
            '';
        if (!clientId || !clientSecret) {
            throw new Error('Google Client ID หรือ Client Secret ไม่ครบ');
        }
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code: params.code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: params.redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        if (!res.ok) {
            throw new Error(`YouTube OAuth error: ${await res.text()}`);
        }
        const data = (await res.json());
        const expiresAt = data.expires_in
            ? new Date(Date.now() + data.expires_in * 1000).toISOString()
            : null;
        let externalAccountId = '';
        let accountName = '';
        try {
            const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${data.access_token}` } });
            if (chRes.ok) {
                const chData = (await chRes.json());
                const first = chData.items?.[0];
                if (first) {
                    externalAccountId = first.id ?? '';
                    accountName = first.snippet?.title ?? '';
                }
            }
        }
        catch {
            // Optional enrichment
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token ?? null,
            expiresAt,
            externalAccountId,
            accountName,
        };
    }
    async refreshAccessToken(refreshToken, credentials) {
        const clientId = credentials?.googleClientId || process.env.GOOGLE_CLIENT_ID || '';
        const clientSecret = credentials?.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
        if (!clientId || !clientSecret) {
            throw new Error('Google Client ID หรือ Client Secret ไม่ครบ');
        }
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                refresh_token: refreshToken,
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
            }),
        });
        if (!res.ok) {
            throw new Error(`YouTube refresh token failed: ${await res.text()}`);
        }
        const data = (await res.json());
        return {
            accessToken: data.access_token,
            expiresAt: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null,
        };
    }
    async preUploadSchedule(ctx) {
        const meta = ctx.job.metadataSnapshot;
        const isFuture = new Date(ctx.job.scheduledAt).getTime() > Date.now() + 60_000;
        if (ctx.account.connectionMode === 'SIMULATION') {
            ctx.log('INFO', 'YT_RESUMABLE_INIT', `[Simulation] เริ่ม YouTube Resumable Upload (${ctx.job.format})`, {
                title: meta.title,
                publishAt: isFuture ? ctx.job.scheduledAt : 'immediate',
                fileSizeBytes: ctx.asset.fileSizeBytes,
                coverSource: ctx.asset.customCoverKey ? 'CUSTOM_COVER' : 'VIDEO_FRAME',
                hasThumbnail: Boolean(ctx.thumbnailPath),
            });
            const simId = `yt_${randomBytes(5).toString('hex')}`;
            const url = ctx.job.format === 'YOUTUBE_SHORTS'
                ? `https://youtube.com/shorts/${simId}`
                : `https://youtu.be/${simId}`;
            ctx.log('INFO', 'YT_PREUPLOAD_DONE', isFuture
                ? `[Simulation] อัปโหลดล่วงหน้าและตั้งเวลา publishAt = ${ctx.job.scheduledAt} สำเร็จ`
                : `[Simulation] อัปโหลดและเผยแพร่บน YouTube สำเร็จ`, { externalPostId: simId, externalUrl: url });
            return {
                externalPostId: simId,
                externalUrl: url,
                status: isFuture ? 'NATIVE_SCHEDULED' : 'PUBLISHED',
            };
        }
        if (!ctx.accessToken) {
            throw new Error('ไม่มี YouTube Access Token กรุณาเชื่อมต่อ OAuth ก่อน');
        }
        let uploadFilePath = ctx.localFilePath;
        let usedCoverFrame = false;
        if (ctx.job.format === 'YOUTUBE_SHORTS' &&
            ctx.hasCustomCover &&
            ctx.getCoverVideoPath) {
            uploadFilePath = await ctx.getCoverVideoPath();
            usedCoverFrame = uploadFilePath !== ctx.localFilePath;
            if (usedCoverFrame) {
                ctx.log('INFO', 'YT_SHORTS_COVER_FRAME_INJECTED', 'ฝังเฟรมหน้าปก (0.15 วินาที) ลงต้นคลิป YouTube Shorts ก่อนอัปโหลด');
            }
        }
        const stat = await fs.promises.stat(uploadFilePath);
        const bodyPayload = {
            snippet: {
                title: meta.title,
                description: meta.description,
                tags: meta.tags ?? [],
                categoryId: meta.categoryId || '22',
            },
            status: isFuture
                ? {
                    privacyStatus: 'private',
                    publishAt: new Date(ctx.job.scheduledAt).toISOString(),
                    selfDeclaredMadeForKids: Boolean(meta.madeForKids),
                    containsSyntheticMedia: Boolean(meta.containsSyntheticMedia),
                }
                : {
                    privacyStatus: meta.privacyStatus || 'public',
                    selfDeclaredMadeForKids: Boolean(meta.madeForKids),
                    containsSyntheticMedia: Boolean(meta.containsSyntheticMedia),
                },
        };
        const notify = meta.notifySubscribers !== false ? 'true' : 'false';
        const initRes = await fetch(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${notify}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${ctx.accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Length': String(stat.size),
                'X-Upload-Content-Type': ctx.asset.mimeType || 'video/mp4',
            },
            body: JSON.stringify(bodyPayload),
        });
        if (!initRes.ok) {
            throw new Error(`YouTube Resumable Init error: ${await initRes.text()}`);
        }
        const uploadUrl = initRes.headers.get('location');
        if (!uploadUrl) {
            throw new Error('YouTube did not return resumable upload Location header');
        }
        ctx.log('INFO', 'YT_UPLOADING_CHUNKS', 'กำลังส่งไฟล์วิดีโอแบบ Resumable Chunks', {
            fileSizeBytes: stat.size,
            usedCoverFrame,
        });
        const videoId = await this.uploadFileInChunks(uploadUrl, uploadFilePath, stat.size, ctx.asset.mimeType || 'video/mp4');
        if (ctx.thumbnailPath && fs.existsSync(ctx.thumbnailPath)) {
            try {
                const thumbBuf = await fs.promises.readFile(ctx.thumbnailPath);
                const thumbRes = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${ctx.accessToken}`,
                        'Content-Type': 'image/jpeg',
                    },
                    body: thumbBuf,
                });
                if (!thumbRes.ok) {
                    throw new Error(`HTTP ${thumbRes.status}: ${await thumbRes.text()}`);
                }
                ctx.log('INFO', 'YT_THUMBNAIL_SET', 'อัปโหลดภาพปกคลิปสำเร็จ');
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const isUnverified = /403|forbidden|permissions/i.test(msg);
                ctx.log('WARN', 'YT_THUMBNAIL_WARN', isUnverified
                    ? usedCoverFrame
                        ? 'YouTube ปฏิเสธ thumbnails/set (HTTP 403 — ช่องยังไม่ได้ยืนยันเบอร์ที่ https://www.youtube.com/verify) แต่ระบบฝังเฟรมหน้าปก 0.15s ในต้นคลิป Shorts ไว้ให้แล้ว'
                        : 'ไม่สามารถอัปโหลดภาพปกได้ — ช่องยังไม่ได้เปิดยืนยันสิทธิ์ที่ https://www.youtube.com/verify (HTTP 403)'
                    : 'ไม่สามารถอัปโหลดภาพปกได้', { error: msg });
            }
        }
        const externalUrl = ctx.job.format === 'YOUTUBE_SHORTS'
            ? `https://youtube.com/shorts/${videoId}`
            : `https://youtu.be/${videoId}`;
        return {
            externalPostId: videoId,
            externalUrl,
            status: isFuture ? 'NATIVE_SCHEDULED' : 'PUBLISHED',
        };
    }
    async uploadFileInChunks(uploadUrl, filePath, totalSize, mimeType) {
        const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB (multiple of 256 KiB required by Google)
        const handle = await fs.promises.open(filePath, 'r');
        try {
            let offset = 0;
            while (offset < totalSize) {
                const length = Math.min(CHUNK_SIZE, totalSize - offset);
                const buf = Buffer.alloc(length);
                await handle.read(buf, 0, length, offset);
                const end = offset + length - 1;
                const res = await fetch(uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': mimeType,
                        'Content-Length': String(length),
                        'Content-Range': `bytes ${offset}-${end}/${totalSize}`,
                    },
                    body: buf,
                });
                if (res.status === 308) {
                    offset += length;
                    continue;
                }
                if (res.ok) {
                    const data = (await res.json());
                    if (!data.id)
                        throw new Error('YouTube upload finished without video ID');
                    return data.id;
                }
                throw new Error(`YouTube chunk upload HTTP ${res.status}: ${await res.text()}`);
            }
            throw new Error('YouTube resumable upload ended unexpectedly');
        }
        finally {
            await handle.close();
        }
    }
    async publishNow(ctx) {
        if (ctx.job.status === 'NATIVE_SCHEDULED' && ctx.job.externalPostId) {
            ctx.log('INFO', 'YT_NATIVE_VERIFY', 'คลิปถูก Pre-upload พร้อม publishAt บน YouTube แล้ว — ยืนยันสถานะเผยแพร่', { externalPostId: ctx.job.externalPostId });
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
        if (!ctx.job.externalPostId)
            return;
        if (ctx.account.connectionMode === 'SIMULATION') {
            ctx.log('INFO', 'YT_RESCHEDULE', `[Simulation] อัปเดตเวลา publishAt บน YouTube เป็น ${newScheduledAtIso}`, { externalPostId: ctx.job.externalPostId });
            return;
        }
        if (!ctx.accessToken)
            throw new Error('Missing YouTube access token');
        const meta = ctx.job.metadataSnapshot;
        const res = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${ctx.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                id: ctx.job.externalPostId,
                status: {
                    privacyStatus: 'private',
                    publishAt: new Date(newScheduledAtIso).toISOString(),
                    selfDeclaredMadeForKids: Boolean(meta.madeForKids),
                    containsSyntheticMedia: Boolean(meta.containsSyntheticMedia),
                },
            }),
        });
        if (!res.ok) {
            throw new Error(`YouTube videos.update failed: ${await res.text()}`);
        }
    }
    async cancelSchedule(ctx) {
        if (!ctx.job.externalPostId)
            return;
        if (ctx.account.connectionMode === 'SIMULATION') {
            ctx.log('INFO', 'YT_CANCEL', `[Simulation] ยกเลิกคลิปที่ตั้งเวลาล่วงหน้า ${ctx.job.externalPostId}`);
            return;
        }
        if (!ctx.accessToken)
            return;
        await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(ctx.job.externalPostId)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${ctx.accessToken}` },
        });
    }
}
//# sourceMappingURL=youtube.js.map