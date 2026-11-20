import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { computeTikTokChunkPlan, } from '@clipflow/shared';
export class TikTokAdapter {
    platform = 'TIKTOK';
    getAuthUrl(params) {
        const clientKey = params.credentials?.tiktokClientKey || process.env.TIKTOK_CLIENT_KEY || '';
        if (!clientKey) {
            throw new Error('ยังไม่ได้ตั้งค่า TikTok Client Key (กรอกในหน้านี้ได้เลย)');
        }
        const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
        url.searchParams.set('client_key', clientKey);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', 'user.info.basic,video.publish,video.upload');
        url.searchParams.set('redirect_uri', params.redirectUri);
        url.searchParams.set('state', params.state);
        return url.toString();
    }
    async exchangeCode(params) {
        const clientKey = params.credentials?.tiktokClientKey || process.env.TIKTOK_CLIENT_KEY || '';
        const clientSecret = params.credentials?.tiktokClientSecret ||
            process.env.TIKTOK_CLIENT_SECRET ||
            '';
        if (!clientKey || !clientSecret) {
            throw new Error('TikTok Client Key หรือ Client Secret ไม่ครบ');
        }
        const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_key: clientKey,
                client_secret: clientSecret,
                code: params.code,
                grant_type: 'authorization_code',
                redirect_uri: params.redirectUri,
            }),
        });
        if (!res.ok)
            throw new Error(`TikTok OAuth error: ${await res.text()}`);
        const data = (await res.json());
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token ?? null,
            expiresAt: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null,
            externalAccountId: data.open_id ?? '',
        };
    }
    async refreshAccessToken(refreshToken, credentials) {
        const clientKey = credentials?.tiktokClientKey || process.env.TIKTOK_CLIENT_KEY || '';
        const clientSecret = credentials?.tiktokClientSecret ||
            process.env.TIKTOK_CLIENT_SECRET ||
            '';
        const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_key: clientKey,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        });
        if (!res.ok)
            throw new Error(`TikTok refresh error: ${await res.text()}`);
        const data = (await res.json());
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token ?? refreshToken,
            expiresAt: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null,
        };
    }
    async fetchCreatorInfo(accessToken, simulation) {
        if (simulation || !accessToken) {
            return {
                creatorUsername: 'demo_tiktok',
                creatorNickname: 'Demo Creator',
                privacyLevelOptions: [
                    'PUBLIC_TO_EVERYONE',
                    'MUTUAL_FOLLOW_FRIENDS',
                    'SELF_ONLY',
                ],
                commentDisabled: false,
                duetDisabled: false,
                stitchDisabled: false,
                maxVideoPostDurationSec: 600,
                fetchedAt: new Date().toISOString(),
            };
        }
        const res = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
            },
            body: '{}',
        });
        if (!res.ok) {
            throw new Error(`TikTok creator_info error: ${await res.text()}`);
        }
        const json = (await res.json());
        if (json.error?.code && json.error.code !== 'ok') {
            throw new Error(`TikTok API error: ${json.error.message}`);
        }
        const d = json.data ?? {};
        return {
            creatorUsername: d.creator_username,
            creatorNickname: d.creator_nickname,
            privacyLevelOptions: d.privacy_level_options ?? ['SELF_ONLY'],
            commentDisabled: Boolean(d.comment_disabled),
            duetDisabled: Boolean(d.duet_disabled),
            stitchDisabled: Boolean(d.stitch_disabled),
            maxVideoPostDurationSec: Number(d.max_video_post_duration_sec ?? 600),
            fetchedAt: new Date().toISOString(),
        };
    }
    async preUploadSchedule(ctx) {
        // Used when TikTok account is configured in INBOX_DRAFT mode
        const chunkPlan = computeTikTokChunkPlan(ctx.asset.fileSizeBytes);
        if (ctx.account.connectionMode === 'SIMULATION') {
            const publishId = `tt_inbox_${randomBytes(5).toString('hex')}`;
            ctx.log('INFO', 'TIKTOK_INBOX_DRAFT', `[Simulation] ส่งคลิปเข้า TikTok Inbox Draft สำเร็จ (${chunkPlan.totalChunkCount} chunk(s), chunk_size=${chunkPlan.chunkSize})`, { publishId });
            return {
                externalPostId: publishId,
                externalUrl: null,
                status: 'NATIVE_SCHEDULED',
            };
        }
        if (!ctx.accessToken)
            throw new Error('Missing TikTok access token');
        const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${ctx.accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
            },
            body: JSON.stringify({
                source_info: {
                    source: 'FILE_UPLOAD',
                    video_size: ctx.asset.fileSizeBytes,
                    chunk_size: chunkPlan.chunkSize,
                    total_chunk_count: chunkPlan.totalChunkCount,
                },
            }),
        });
        if (!initRes.ok) {
            throw new Error(`TikTok inbox init failed: ${await initRes.text()}`);
        }
        const initJson = (await initRes.json());
        if (!initJson.data?.upload_url || !initJson.data.publish_id) {
            throw new Error(`TikTok inbox init invalid response: ${JSON.stringify(initJson)}`);
        }
        await this.uploadChunksSequential(initJson.data.upload_url, ctx.localFilePath, ctx.asset.fileSizeBytes, chunkPlan.chunks);
        return {
            externalPostId: initJson.data.publish_id,
            externalUrl: null,
            status: 'NATIVE_SCHEDULED',
        };
    }
    async publishNow(ctx) {
        if (ctx.job.strategy === 'INBOX_DRAFT' &&
            ctx.job.status === 'NATIVE_SCHEDULED' &&
            ctx.job.externalPostId) {
            ctx.log('INFO', 'TIKTOK_INBOX_READY', 'คลิปอยู่ใน TikTok App Inbox แล้ว (โหมด Draft) — กรุณากดโพสต์ในแอปมือถือ');
            return {
                externalPostId: ctx.job.externalPostId,
                externalUrl: ctx.job.externalUrl,
            };
        }
        const meta = ctx.job.metadataSnapshot;
        const chunkPlan = computeTikTokChunkPlan(ctx.asset.fileSizeBytes);
        if (ctx.account.connectionMode === 'SIMULATION') {
            const pubId = `tt_${randomBytes(5).toString('hex')}`;
            ctx.log('INFO', 'TIKTOK_DIRECT_POST', `[Simulation] ยิง TikTok Direct Post สำเร็จ (floor chunk_count=${chunkPlan.totalChunkCount}, privacy=${meta.privacyLevel})`, {
                publishId: pubId,
                allowComment: meta.allowComment,
                allowDuet: meta.allowDuet,
                allowStitch: meta.allowStitch,
                brandOrganicToggle: meta.brandOrganicToggle,
                brandContentToggle: meta.brandContentToggle,
                isAigc: meta.isAigc,
            });
            return {
                externalPostId: pubId,
                externalUrl: `https://www.tiktok.com/@${ctx.account.externalAccountId.replace(/^@/, '')}/video/${pubId}`,
            };
        }
        if (!ctx.accessToken)
            throw new Error('Missing TikTok access token');
        // Step 1: Verify creator_info
        const info = await this.fetchCreatorInfo(ctx.accessToken, false);
        if (!info.privacyLevelOptions.includes(meta.privacyLevel)) {
            throw new Error(`Privacy level ${meta.privacyLevel} ไม่ได้รับอนุญาตสำหรับบัญชีนี้ (อนุญาต: ${info.privacyLevelOptions.join(', ')})`);
        }
        // Step 2: Direct Post Init
        const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${ctx.accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
            },
            body: JSON.stringify({
                post_info: {
                    title: meta.caption,
                    privacy_level: meta.privacyLevel,
                    disable_comment: !meta.allowComment || info.commentDisabled,
                    disable_duet: !meta.allowDuet || info.duetDisabled,
                    disable_stitch: !meta.allowStitch || info.stitchDisabled,
                    video_cover_timestamp_ms: meta.coverTimestampMs || 0,
                    brand_content_toggle: Boolean(meta.brandContentToggle),
                    brand_organic_toggle: Boolean(meta.brandOrganicToggle),
                    is_aigc: Boolean(meta.isAigc),
                },
                source_info: {
                    source: 'FILE_UPLOAD',
                    video_size: ctx.asset.fileSizeBytes,
                    chunk_size: chunkPlan.chunkSize,
                    total_chunk_count: chunkPlan.totalChunkCount,
                },
            }),
        });
        if (!initRes.ok) {
            throw new Error(`TikTok direct post init failed: ${await initRes.text()}`);
        }
        const initJson = (await initRes.json());
        if ((initJson.error?.code && initJson.error.code !== 'ok') ||
            !initJson.data?.upload_url ||
            !initJson.data.publish_id) {
            throw new Error(`TikTok init rejected: ${initJson.error?.message || JSON.stringify(initJson)}`);
        }
        const { publish_id: publishId, upload_url: uploadUrl } = initJson.data;
        // Step 3: Sequential chunked PUT
        await this.uploadChunksSequential(uploadUrl, ctx.localFilePath, ctx.asset.fileSizeBytes, chunkPlan.chunks);
        // Step 4: Poll status
        for (let i = 0; i < 30; i++) {
            const stRes = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${ctx.accessToken}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                },
                body: JSON.stringify({ publish_id: publishId }),
            });
            if (stRes.ok) {
                const stJson = (await stRes.json());
                const st = stJson.data?.status;
                if (st === 'PUBLISH_COMPLETE') {
                    const postId = stJson.data?.publicaly_available_post_id?.[0] ?? publishId;
                    return {
                        externalPostId: postId,
                        externalUrl: `https://www.tiktok.com/@${ctx.account.externalAccountId.replace(/^@/, '')}/video/${postId}`,
                    };
                }
                if (st === 'FAILED') {
                    throw new Error(`TikTok publish failed: ${stJson.data?.fail_reason || 'unknown'}`);
                }
            }
            await new Promise((r) => setTimeout(r, 3000));
        }
        return { externalPostId: publishId, externalUrl: null };
    }
    async uploadChunksSequential(uploadUrl, filePath, totalSize, chunks) {
        const handle = await fs.promises.open(filePath, 'r');
        try {
            for (const chunk of chunks) {
                const buf = Buffer.alloc(chunk.size);
                await handle.read(buf, 0, chunk.size, chunk.start);
                const res = await fetch(uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'video/mp4',
                        'Content-Length': String(chunk.size),
                        'Content-Range': `bytes ${chunk.start}-${chunk.end}/${totalSize}`,
                    },
                    body: buf,
                });
                if (!res.ok) {
                    throw new Error(`TikTok chunk PUT HTTP ${res.status}: ${await res.text()}`);
                }
            }
        }
        finally {
            await handle.close();
        }
    }
}
//# sourceMappingURL=tiktok.js.map