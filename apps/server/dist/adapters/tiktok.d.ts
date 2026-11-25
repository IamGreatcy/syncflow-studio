import { type TikTokCreatorInfo } from '@clipflow/shared';
import type { AdapterContext, OAuthAppCredentials, OAuthTokenResponse, PlatformAdapter, PreUploadResult, PublishResult } from './types.js';
export declare function formatTikTokAccountDisplayName(info?: TikTokCreatorInfo | null, fallback?: string): string;
export declare class TikTokAdapter implements PlatformAdapter {
    readonly platform: "TIKTOK";
    getAuthUrl(params: {
        accountId: string;
        redirectUri: string;
        state: string;
        credentials?: OAuthAppCredentials;
    }): string;
    exchangeCode(params: {
        code: string;
        redirectUri: string;
        credentials?: OAuthAppCredentials;
    }): Promise<OAuthTokenResponse>;
    refreshAccessToken(refreshToken: string, credentials?: OAuthAppCredentials): Promise<OAuthTokenResponse>;
    fetchCreatorInfo(accessToken: string | null, simulation: boolean): Promise<TikTokCreatorInfo>;
    preUploadSchedule(ctx: AdapterContext): Promise<PreUploadResult>;
    publishNow(ctx: AdapterContext): Promise<PublishResult>;
    private resolveActualVideoSize;
    private resolveUploadMedia;
    private initUploadWithChunkFallback;
    private uploadChunksSequential;
}
//# sourceMappingURL=tiktok.d.ts.map