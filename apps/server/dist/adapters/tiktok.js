import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { computeTikTokChunkPlan, } from '@clipflow/shared';
import { fetchWithRetry } from '../services/net-resilience.js';
export function formatTikTokAccountDisplayName(info, fallback) {
    const nick = info?.creatorNickname?.trim();
    const user = info?.creatorUsername?.trim().replace(/^@/, '');
    if (nick && user && nick.toLowerCase() !== user.toLowerCase()) {
        return `${nick} (@${user})`;
    }
    if (nick)
        return nick;
    if (user)
        return `@${user}`;
    if (fallback && !/simulation/i.test(fallback))
        return fallback;
    return 'TikTok Official';
}
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
        const res = await fetchWithRetry('https://open.tiktokapis.com/v2/oauth/token/', {
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
        let creatorInfo = null;
        try {
            creatorInfo = await this.fetchCreatorInfo(data.access_token, false);
        }
        catch {
            // Allow OAuth completion even if creator_info endpoint is temporarily unavailable
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token ?? null,
            expiresAt: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000).toISOString()
                : null,
            externalAccountId: data.open_id ?? '',
            accountName: formatTikTokAccountDisplayName(creatorInfo),
            creatorInfo,
        };
    }
    async refreshAccessToken(refreshToken, credentials) {
        const clientKey = credentials?.tiktokClientKey || process.env.TIKTOK_CLIENT_KEY || '';
        const clientSecret = credentials?.tiktokClientSecret ||
            process.env.TIKTOK_CLIENT_SECRET ||
            '';
        const res = await fetchWithRetry('https://open.tiktokapis.com/v2/oauth/token/', {
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
        const res = await fetchWithRetry('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
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
        if (ctx.account.connectionMode === 'SIMULATION') {
            const videoSizeBytes = this.resolveActualVideoSize(ctx);
            const chunkPlan = computeTikTokChunkPlan(videoSizeBytes);
            const publishId = `tt_inbox_${randomBytes(5).toString('hex')}`;
            ctx.log('INFO', 'TIKTOK_INBOX_DRAFT', `[Simulation] ส่งคลิปเข้า TikTok Inbox Draft สำเร็จ (${chunkPlan.totalChunkCount} chunk(s), chunk_size=${chunkPlan.chunkSize})`, {
                publishId,
                coverSource: ctx.hasCustomCover ? 'CUSTOM_COVER_FRAME_0' : 'VIDEO_TIMESTAMP',
            });
            return {
                externalPostId: publishId,
                externalUrl: null,
                status: 'NATIVE_SCHEDULED',
            };
        }
        if (!ctx.accessToken)
            throw new Error('Missing TikTok access token');
        const { uploadFilePath, videoSizeBytes } = await this.resolveUploadMedia(ctx);
        const { chunkPlan, publishId, uploadUrl } = await this.initUploadWithChunkFallback({
            endpoint: 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
            accessToken: ctx.accessToken,
            videoSizeBytes,
            errorLabel: 'TikTok inbox init',
            buildPayload: (plan) => ({
                source_info: {
                    source: 'FILE_UPLOAD',
                    video_size: videoSizeBytes,
                    chunk_size: plan.chunkSize,
                    total_chunk_count: plan.totalChunkCount,
                },
            }),
        });
        await this.uploadChunksSequential(uploadUrl, uploadFilePath, videoSizeBytes, chunkPlan.chunks);
        return {
            externalPostId: publishId,
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
        if (ctx.account.connectionMode === 'SIMULATION') {
            const videoSizeBytes = this.resolveActualVideoSize(ctx);
            const chunkPlan = computeTikTokChunkPlan(videoSizeBytes);
            const pubId = `tt_${randomBytes(5).toString('hex')}`;
            ctx.log('INFO', 'TIKTOK_DIRECT_POST', `[Simulation] ยิง TikTok Direct Post สำเร็จ (floor chunk_count=${chunkPlan.totalChunkCount}, privacy=${meta.privacyLevel})`, {
                publishId: pubId,
                coverSource: ctx.hasCustomCover ? 'CUSTOM_COVER_FRAME_0' : 'VIDEO_TIMESTAMP',
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
        // Step 1: Verify creator_info & adjust privacy level if account switched to Private
        let info;
        try {
            info = await this.fetchCreatorInfo(ctx.accessToken, false);
        }
        catch (creatorErr) {
            if (ctx.account.creatorInfo && ctx.account.creatorInfo.privacyLevelOptions?.length) {
                ctx.log('WARN', 'TIKTOK_CREATOR_INFO_CACHED_FALLBACK', 'ดึง creator_info สดไม่สำเร็จชั่วคราว — ใช้ข้อมูลสิทธิ์บัญชีที่บันทึกไว้ล่าสุดแทน', {
                    error: creatorErr instanceof Error
                        ? creatorErr.message
                        : String(creatorErr),
                });
                info = ctx.account.creatorInfo;
            }
            else {
                throw creatorErr;
            }
        }
        let requestedPrivacy = meta.privacyLevel;
        if (!info.privacyLevelOptions.includes(requestedPrivacy)) {
            const fallbackPrivacy = ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'].find((p) => info.privacyLevelOptions.includes(p));
            if (!fallbackPrivacy) {
                throw new Error(`Privacy level ${meta.privacyLevel} ไม่ได้รับอนุญาตสำหรับบัญชีนี้ (อนุญาต: ${info.privacyLevelOptions.join(', ')})`);
            }
            ctx.log('WARN', 'TIKTOK_PRIVACY_ADJUSTED', `บัญชีปรับเป็นส่วนตัว จึงเปลี่ยนระดับการมองเห็นจาก ${meta.privacyLevel} เป็น ${fallbackPrivacy} อัตโนมัติ`);
            requestedPrivacy = fallbackPrivacy;
        }
        const { uploadFilePath, videoSizeBytes, usedCoverFrame } = await this.resolveUploadMedia(ctx);
        const coverTimestampMs = usedCoverFrame ? 0 : (meta.coverTimestampMs || 0);
        // Step 2: Direct Post Init (with chunk-size fallback + 2-tier unaudited-app fallback)
        const buildDirectPostPayload = (privacyLevel, plan) => ({
            post_info: {
                title: meta.caption,
                privacy_level: privacyLevel,
                disable_comment: !meta.allowComment || info.commentDisabled,
                disable_duet: !meta.allowDuet || info.duetDisabled,
                disable_stitch: !meta.allowStitch || info.stitchDisabled,
                video_cover_timestamp_ms: coverTimestampMs,
                brand_content_toggle: Boolean(meta.brandContentToggle),
                brand_organic_toggle: Boolean(meta.brandOrganicToggle),
                is_aigc: Boolean(meta.isAigc),
            },
            source_info: {
                source: 'FILE_UPLOAD',
                video_size: videoSizeBytes,
                chunk_size: plan.chunkSize,
                total_chunk_count: plan.totalChunkCount,
            },
        });
        const UNAUDITED_RE = /unaudited_client_can_only_post_to_private_accounts/i;
        const accessToken = ctx.accessToken;
        const initDirectPost = (privacyLevel) => this.initUploadWithChunkFallback({
            endpoint: 'https://open.tiktokapis.com/v2/post/publish/video/init/',
            accessToken,
            videoSizeBytes,
            errorLabel: 'TikTok direct post init',
            buildPayload: (plan) => buildDirectPostPayload(privacyLevel, plan),
        });
        let initResult;
        try {
            initResult = await initDirectPost(requestedPrivacy);
        }
        catch (directErr) {
            const errMsg = directErr instanceof Error ? directErr.message : String(directErr);
            if (!UNAUDITED_RE.test(errMsg))
                throw directErr;
            let recovered = null;
            let latestUnauditedErr = directErr;
            if (requestedPrivacy !== 'SELF_ONLY') {
                ctx.log('WARN', 'TIKTOK_UNAUDITED_PRIVACY_FALLBACK', 'แอป TikTok ยังไม่ผ่านการ Audit จึงสลับระดับการมองเห็นเป็นส่วนตัว (SELF_ONLY) อัตโนมัติ');
                try {
                    recovered = await initDirectPost('SELF_ONLY');
                }
                catch (selfOnlyErr) {
                    const selfOnlyMsg = selfOnlyErr instanceof Error ? selfOnlyErr.message : String(selfOnlyErr);
                    if (!UNAUDITED_RE.test(selfOnlyMsg))
                        throw selfOnlyErr;
                    latestUnauditedErr = selfOnlyErr;
                }
            }
            if (!recovered) {
                ctx.log('WARN', 'TIKTOK_INBOX_FALLBACK', 'แอป TikTok ยังไม่ผ่าน Audit สำหรับ Direct Post ไปยังบัญชีสาธารณะ — กำลังส่งคลิปเข้า TikTok App Inbox (Draft) แทน');
                try {
                    const inboxInit = await this.initUploadWithChunkFallback({
                        endpoint: 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
                        accessToken,
                        videoSizeBytes,
                        errorLabel: 'TikTok inbox init',
                        buildPayload: (plan) => ({
                            source_info: {
                                source: 'FILE_UPLOAD',
                                video_size: videoSizeBytes,
                                chunk_size: plan.chunkSize,
                                total_chunk_count: plan.totalChunkCount,
                            },
                        }),
                    });
                    await this.uploadChunksSequential(inboxInit.uploadUrl, uploadFilePath, videoSizeBytes, inboxInit.chunkPlan.chunks);
                    ctx.log('INFO', 'TIKTOK_INBOX_FALLBACK_DONE', 'ส่งคลิปเข้า TikTok App Inbox สำเร็จ — เปิดการแจ้งเตือนในแอป TikTok บนมือถือเพื่อกดโพสต์สาธารณะได้เลย', { publishId: inboxInit.publishId });
                    return {
                        externalPostId: inboxInit.publishId,
                        externalUrl: `https://www.tiktok.com/@${(info.creatorUsername || ctx.account.externalAccountId).replace(/^@/, '')}`,
                    };
                }
                catch (inboxErr) {
                    const inboxMsg = inboxErr instanceof Error ? inboxErr.message : String(inboxErr);
                    if (!UNAUDITED_RE.test(inboxMsg))
                        throw inboxErr;
                    void latestUnauditedErr;
                    throw new Error('TikTok ปฏิเสธการโพสต์ (unaudited_client_can_only_post_to_private_accounts): แอปใน TikTok Developer Portal ยังไม่ผ่านการ Audit จึงโพสต์ได้เฉพาะบัญชีที่ตั้งเป็น "บัญชีส่วนตัว (Private Account)" เท่านั้น — กรุณาเปิดแอป TikTok บนมือถือ > ตั้งค่าและความเป็นส่วนตัว > ความเป็นส่วนตัว > เปิด "บัญชีส่วนตัว" ชั่วคราวแล้วกดโพสต์ใหม่ (หลังโพสต์เสร็จหรือส่งแอปผ่าน Audit แล้วจึงเปิดสาธารณะได้)');
                }
            }
            initResult = recovered;
        }
        const { chunkPlan, publishId, uploadUrl } = initResult;
        // Step 3: Sequential chunked PUT
        await this.uploadChunksSequential(uploadUrl, uploadFilePath, videoSizeBytes, chunkPlan.chunks);
        // Step 4: Poll status
        for (let i = 0; i < 30; i++) {
            const stRes = await fetchWithRetry('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
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
                    const handle = (info.creatorUsername || ctx.account.externalAccountId).replace(/^@/, '');
                    return {
                        externalPostId: postId,
                        externalUrl: `https://www.tiktok.com/@${handle}/video/${postId}`,
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
    resolveActualVideoSize(ctx) {
        if (ctx.account.connectionMode !== 'SIMULATION' &&
            ctx.localFilePath &&
            fs.existsSync(ctx.localFilePath)) {
            const statSize = fs.statSync(ctx.localFilePath).size;
            if (statSize > 0)
                return statSize;
        }
        return ctx.asset.fileSizeBytes;
    }
    async resolveUploadMedia(ctx) {
        let uploadFilePath = ctx.localFilePath;
        let usedCoverFrame = false;
        if (ctx.hasCustomCover && ctx.getCoverVideoPath) {
            uploadFilePath = await ctx.getCoverVideoPath();
            usedCoverFrame = uploadFilePath !== ctx.localFilePath;
            if (usedCoverFrame) {
                ctx.log('INFO', 'TIKTOK_COVER_FRAME_INJECTED', 'ฝังเฟรมหน้าปก (0.15 วินาที) ลงต้นคลิป TikTok พร้อมตั้ง video_cover_timestamp_ms=0');
            }
        }
        const videoSizeBytes = uploadFilePath && fs.existsSync(uploadFilePath)
            ? Math.max(1, fs.statSync(uploadFilePath).size)
            : this.resolveActualVideoSize(ctx);
        return { uploadFilePath, videoSizeBytes, usedCoverFrame };
    }
    async initUploadWithChunkFallback(params) {
        const MIN_FALLBACK_MULTI_CHUNK_BYTES = 2 * 5_242_880;
        let chunkPlan = computeTikTokChunkPlan(params.videoSizeBytes);
        for (let attempt = 0; attempt < 2; attempt++) {
            const initRes = await fetchWithRetry(params.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${params.accessToken}`,
                    'Content-Type': 'application/json; charset=UTF-8',
                },
                body: JSON.stringify(params.buildPayload(chunkPlan)),
            });
            const rawText = await initRes.text();
            let initJson = null;
            try {
                initJson = JSON.parse(rawText);
            }
            catch {
                initJson = null;
            }
            const isInvalidChunkError = /chunk\s*size/i.test(rawText) ||
                (initJson?.error?.code === 'invalid_params' &&
                    /chunk/i.test(initJson.error.message || ''));
            if (attempt === 0 &&
                (!initRes.ok || (initJson?.error?.code && initJson.error.code !== 'ok')) &&
                isInvalidChunkError &&
                chunkPlan.totalChunkCount === 1 &&
                params.videoSizeBytes >= MIN_FALLBACK_MULTI_CHUNK_BYTES) {
                chunkPlan = computeTikTokChunkPlan(params.videoSizeBytes, 5_242_880);
                continue;
            }
            if (!initRes.ok) {
                throw new Error(`${params.errorLabel} failed: ${rawText}`);
            }
            if ((initJson?.error?.code && initJson.error.code !== 'ok') ||
                !initJson?.data?.upload_url ||
                !initJson?.data.publish_id) {
                throw new Error(`${params.errorLabel} rejected: ${initJson?.error?.message || rawText}`);
            }
            return {
                chunkPlan,
                publishId: initJson.data.publish_id,
                uploadUrl: initJson.data.upload_url,
            };
        }
        throw new Error(`${params.errorLabel} failed unexpectedly`);
    }
    async uploadChunksSequential(uploadUrl, filePath, totalSize, chunks) {
        const handle = await fs.promises.open(filePath, 'r');
        try {
            for (const chunk of chunks) {
                const buf = Buffer.alloc(chunk.size);
                await handle.read(buf, 0, chunk.size, chunk.start);
                const res = await fetchWithRetry(uploadUrl, {
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