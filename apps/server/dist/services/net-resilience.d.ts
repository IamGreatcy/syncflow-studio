export declare function extractErrorCauseInfo(err: unknown): {
    topMessage: string;
    code: string | null;
    hostname: string | null;
    syscall: string | null;
    causeMessage: string | null;
};
export declare function isTransientNetworkError(err: unknown): boolean;
export declare function formatErrorWithCause(err: unknown): string;
export interface FetchWithRetryOptions {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    timeoutMs?: number;
    retryOnHttpStatuses?: boolean;
}
export declare function fetchWithRetry(input: string | URL, init?: RequestInit, options?: FetchWithRetryOptions): Promise<Response>;
//# sourceMappingURL=net-resilience.d.ts.map