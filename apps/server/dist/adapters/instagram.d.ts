import type { AdapterContext, OAuthAppCredentials, OAuthTokenResponse, PlatformAdapter, PreWarmResult, PublishResult } from './types.js';
export declare class InstagramAdapter implements PlatformAdapter {
    readonly platform: "INSTAGRAM";
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
    preWarm(ctx: AdapterContext): Promise<PreWarmResult>;
    publishNow(ctx: AdapterContext): Promise<PublishResult>;
}
//# sourceMappingURL=instagram.d.ts.map