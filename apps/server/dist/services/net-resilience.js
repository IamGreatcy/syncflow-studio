import dns from 'node:dns';
try {
    dns.setDefaultResultOrder('ipv4first');
}
catch {
    // Ignore if unsupported in current runtime
}
const TRANSIENT_ERROR_CODES = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_ABORTED',
    'ERR_SOCKET_CONNECTION_TIMEOUT',
]);
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export function extractErrorCauseInfo(err) {
    const topMessage = err instanceof Error ? err.message : String(err);
    let cursor = err instanceof Error ? err.cause : null;
    let code = err && typeof err === 'object' && typeof err.code === 'string'
        ? err.code
        : null;
    let hostname = null;
    let syscall = null;
    let causeMessage = null;
    let depth = 0;
    while (cursor && typeof cursor === 'object' && depth < 5) {
        const c = cursor;
        if (!code && typeof c.code === 'string')
            code = c.code;
        if (!hostname && typeof c.hostname === 'string')
            hostname = c.hostname;
        if (!syscall && typeof c.syscall === 'string')
            syscall = c.syscall;
        if (!causeMessage && typeof c.message === 'string' && c.message !== topMessage) {
            causeMessage = c.message;
        }
        cursor = c.cause;
        depth++;
    }
    return { topMessage, code, hostname, syscall, causeMessage };
}
export function isTransientNetworkError(err) {
    const { topMessage, code, causeMessage } = extractErrorCauseInfo(err);
    if (code && TRANSIENT_ERROR_CODES.has(code.toUpperCase())) {
        return true;
    }
    const combined = `${topMessage} ${causeMessage ?? ''}`;
    if (/fetch failed|network error|socket hang up|getaddrinfo|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i.test(combined)) {
        return true;
    }
    return false;
}
export function formatErrorWithCause(err) {
    const { topMessage, code, hostname, syscall, causeMessage } = extractErrorCauseInfo(err);
    const detailParts = [];
    if (code)
        detailParts.push(code);
    if (syscall)
        detailParts.push(syscall);
    if (hostname)
        detailParts.push(hostname);
    if (causeMessage && !detailParts.includes(causeMessage)) {
        detailParts.push(causeMessage);
    }
    const isFetchFailed = /^fetch failed$/i.test(topMessage.trim());
    if (isFetchFailed || isTransientNetworkError(err)) {
        const techDetail = detailParts.length > 0 ? ` [${detailParts.join(' ')}]` : '';
        return `${topMessage}${techDetail} (การเชื่อมต่ออินเทอร์เน็ตหรือ DNS ขัดข้องขณะติดต่อเซิร์ฟเวอร์ปลายทาง)`;
    }
    if (detailParts.length > 0 && !topMessage.includes(detailParts[0])) {
        return `${topMessage} (${detailParts.join(' ')})`;
    }
    return topMessage;
}
export async function fetchWithRetry(input, init, options) {
    const retries = options?.retries ?? 2;
    const baseDelayMs = options?.baseDelayMs ?? 350;
    const maxDelayMs = options?.maxDelayMs ?? 2000;
    const retryOnStatus = options?.retryOnHttpStatuses ?? true;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(input, init);
            if (retryOnStatus &&
                attempt < retries &&
                TRANSIENT_HTTP_STATUS.has(res.status)) {
                const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            return res;
        }
        catch (err) {
            lastError = err;
            if (attempt < retries && isTransientNetworkError(err)) {
                const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? 'fetch failed'));
}
//# sourceMappingURL=net-resilience.js.map