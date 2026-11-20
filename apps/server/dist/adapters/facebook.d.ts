import type { AdapterContext, OAuthAppCredentials, OAuthTokenResponse, PlatformAdapter, PreUploadResult, PublishResult } from './types.js';
export interface DiscoveredMetaPageFull {
    pageId: string;
    pageName: string;
    pageAccessToken: string;
    igUserId: string | null;
    igUsername: string | null;
    igName: string | null;
}
export declare function discoverMetaPages(accessToken: string): Promise<DiscoveredMetaPageFull[]>;
export declare class FacebookAdapter implements PlatformAdapter {
    readonly platform: "FACEBOOK";
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
    preUploadSchedule(ctx: AdapterContext): Promise<PreUploadResult>;
    private uploadFacebookReel;
    private uploadFacebookPageVideo;
    publishNow(ctx: AdapterContext): Promise<PublishResult>;
    updateSchedule(params: {
        ctx: AdapterContext;
        newScheduledAtIso: string;
    }): Promise<void>;
    cancelSchedule(ctx: AdapterContext): Promise<void>;
}
//# sourceMappingURL=facebook.d.ts.map