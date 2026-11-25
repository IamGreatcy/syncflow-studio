type DiagnosticState = 'unsupported' | 'unavailable' | 'unknown' | 'failed';
type Diagnostic<T> = {
    state: 'available';
    value: T;
} | {
    state: DiagnosticState;
    reason: string;
    error?: object;
};
export declare function diagnoseFacebookReel(input: {
    pageId: string;
    videoId: string;
    token: string | null;
}): Promise<{
    observedAt: string;
    pageId: string;
    videoId: string;
    postId: string | null;
    requestedGraphVersion: string;
    effectiveGraphVersions: string[];
    publication: Diagnostic<{
        phases: {
            video: string | undefined;
            uploading: string | undefined;
            processing: string | undefined;
            publishing: string | undefined;
            publishStatus: string | undefined;
            bytesTransferred: number | undefined;
        };
        publishTime: string | undefined;
        outcome: string;
    }>;
    metadata: Diagnostic<{
        postId: string | null;
        permalink: string | null;
    }>;
    visibility: {
        error?: object | undefined;
        state: DiagnosticState;
        reason: string;
    } | Diagnostic<{
        published: boolean;
        hidden: boolean;
        publicAudience: boolean;
        permalink: string | null;
    }>;
    pagePromotion: Diagnostic<{
        eligible: boolean;
        reasonReturned: boolean;
    }>;
    postPromotion: {
        error?: object | undefined;
        state: DiagnosticState;
        reason: string;
    } | Diagnostic<{
        eligible: boolean;
    }>;
    copyright: Diagnostic<{
        checkStatus: string;
        matchesFound: boolean | null;
    }>;
    promotionReason: {
        error?: object | undefined;
        state: DiagnosticState;
        reason: string;
    };
    recommendationEligibility: {
        error?: object | undefined;
        state: DiagnosticState;
        reason: string;
    };
    metrics: {
        plays: Diagnostic<{
            total: number;
        } | {
            excluded: number;
            included: number;
        }>;
        initialPlays: Diagnostic<{
            total: number;
        } | {
            excluded: number;
            included: number;
        }>;
        replays: Diagnostic<{
            total: number;
        } | {
            excluded: number;
            included: number;
        }>;
        mediaViewsFromAds: {
            error?: object | undefined;
            state: DiagnosticState;
            reason: string;
        } | Diagnostic<{
            total: number;
        } | {
            excluded: number;
            included: number;
        }>;
        mediaViewsFromFollowers: {
            error?: object | undefined;
            state: DiagnosticState;
            reason: string;
        } | Diagnostic<{
            total: number;
        } | {
            excluded: number;
            included: number;
        }>;
        uniqueMediaViewers: {
            error?: object | undefined;
            state: DiagnosticState;
            reason: string;
        } | Diagnostic<{
            total: number;
        } | {
            excluded: number;
            included: number;
        }>;
        organicUniqueReach: {
            error?: object | undefined;
            state: DiagnosticState;
            reason: string;
        };
    };
}>;
export {};
//# sourceMappingURL=facebook-diagnostics.d.ts.map