import type { AdapterContext, OAuthAppCredentials, OAuthTokenResponse, PlatformAdapter, PreUploadResult, PublishResult } from './types.js';
export declare class YouTubeAdapter implements PlatformAdapter {
    readonly platform: "YOUTUBE";
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
    preUploadSchedule(ctx: AdapterContext): Promise<PreUploadResult>;
    private uploadFileInChunks;
    private uploadChunkWithResume;
    publishNow(ctx: AdapterContext): Promise<PublishResult>;
    updateSchedule(params: {
        ctx: AdapterContext;
        newScheduledAtIso: string;
    }): Promise<void>;
    cancelSchedule(ctx: AdapterContext): Promise<void>;
}
//# sourceMappingURL=youtube.d.ts.map