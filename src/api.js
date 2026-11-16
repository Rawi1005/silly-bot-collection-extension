/**
 * Client for the Silly Bot Collection extension API (see API_CONTRACT.md).
 *
 * Rules enforced here:
 * - the access key only ever travels in an `Authorization` header, never a URL;
 * - the key is never written to a log line;
 * - cookies are never sent (`credentials: 'omit'`);
 * - every non-2xx becomes an `ApiError` with a stable `code`;
 * - one retry, for 429 (honouring `Retry-After`) and for 5xx on GET;
 * - every request is attached to an AbortController so navigating away cancels.
 */

export const ERROR_CODES = Object.freeze({
    NETWORK: 'NETWORK',
    ABORTED: 'ABORTED',
    BAD_REQUEST: 'BAD_REQUEST',
    BAD_CURSOR: 'BAD_CURSOR',
    INVALID_KEY: 'INVALID_KEY',
    NOT_VERIFIED: 'NOT_VERIFIED',
    NSFW_REQUIRED: 'NSFW_REQUIRED',
    NOT_FOUND: 'NOT_FOUND',
    RATE_LIMITED: 'RATE_LIMITED',
    SERVER_ERROR: 'SERVER_ERROR',
    BAD_RESPONSE: 'BAD_RESPONSE',
    NO_KEY: 'NO_KEY',
});

/** Maps a bare HTTP status to a code, used when the body has none. */
export function statusToCode(status) {
    switch (status) {
        case 400: return ERROR_CODES.BAD_REQUEST;
        case 401: return ERROR_CODES.INVALID_KEY;
        case 403: return ERROR_CODES.NOT_VERIFIED;
        case 404: return ERROR_CODES.NOT_FOUND;
        case 429: return ERROR_CODES.RATE_LIMITED;
        default:
            return status >= 500 ? ERROR_CODES.SERVER_ERROR : ERROR_CODES.BAD_RESPONSE;
    }
}

export class ApiError extends Error {
    /**
     * @param {string} code
     * @param {object} [options]
     * @param {number} [options.status]
     * @param {string} [options.message]
     * @param {number|null} [options.retryAfter] seconds
     * @param {Error} [options.cause]
     */
    constructor(code, { status = 0, message = '', retryAfter = null, cause } = {}) {
        super(message || code);
        this.name = 'ApiError';
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
        if (cause) this.cause = cause;
    }

    /** @returns {boolean} The key is bad; onboarding must be shown again. */
    get isAuthFailure() {
        return this.code === ERROR_CODES.INVALID_KEY || this.code === ERROR_CODES.NO_KEY;
    }
}

/**
 * Parses `Retry-After` (we only support the integer-seconds form, per contract).
 * @param {string|null} value
 * @returns {number|null}
 */
export function parseRetryAfter(value) {
    if (value === null || value === undefined) return null;
    const seconds = Number.parseInt(String(value).trim(), 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds, 120);
}

/** Longest we will ever wait before the single retry. */
export const MAX_RETRY_DELAY_SECONDS = 30;

/**
 * Coerces a value to a trimmed string of bounded length. Everything that comes
 * off the wire goes through one of these.
 */
function str(value, max = 2000) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function int(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function bool(value) {
    return value === true;
}

/**
 * Only https URLs, or http on the base host (so the mock server's thumbnails
 * load during development). Anything else becomes null.
 * @param {any} value
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function safeImageUrl(value, baseUrl) {
    const raw = str(value, 2048);
    if (!raw) return null;
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:') {
        try {
            const base = new URL(baseUrl);
            if (base.host === url.host) return url.href;
        } catch { /* fall through */ }
    }
    return null;
}

/**
 * Same rule as images, for the "open on site" link. Kept separate so the link
 * rule can be tightened without touching image loading.
 * @param {any} value
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function safeLinkUrl(value, baseUrl) {
    return safeImageUrl(value, baseUrl);
}

/**
 * @param {any} raw
 * @param {string} baseUrl
 * @returns {object|null}
 */
export function normaliseBotSummary(raw, baseUrl) {
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id, 128);
    const name = str(raw.name, 80);
    if (!id || !name) return null;
    const creator = raw.creator && typeof raw.creator === 'object' ? raw.creator : {};
    return {
        id,
        name,
        tagline: str(raw.tagline, 220),
        tags: Array.isArray(raw.tags)
            ? raw.tags.filter((tag) => typeof tag === 'string').slice(0, 12).map((tag) => tag.slice(0, 32))
            : [],
        rating: raw.rating === 'nsfw' ? 'nsfw' : 'sfw',
        thumbnailUrl: safeImageUrl(raw.thumbnailUrl, baseUrl),
        creator: {
            name: str(creator.name, 80) || 'unknown',
            username: str(creator.username, 64) || null,
            image: safeImageUrl(creator.image, baseUrl),
        },
        downloads: int(raw.downloads),
        likes: int(raw.likes),
        bookmarks: int(raw.bookmarks),
        bookmarked: bool(raw.bookmarked),
        liked: bool(raw.liked),
        hasLorebook: bool(raw.hasLorebook),
        updatedAt: str(raw.updatedAt, 40),
        cardVersion: str(raw.cardVersion, 32),
        url: safeLinkUrl(raw.url, baseUrl),
    };
}

/**
 * @param {any} raw
 * @param {string} baseUrl
 * @returns {object|null}
 */
export function normaliseBotDetail(raw, baseUrl) {
    const summary = normaliseBotSummary(raw, baseUrl);
    if (!summary) return null;
    return {
        ...summary,
        description: str(raw.description, 20000),
        firstMessage: str(raw.firstMessage, 20000),
        alternateGreetings: int(raw.alternateGreetings),
        cardSpec: raw.cardSpec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2',
        lorebookEntryCount: int(raw.lorebookEntryCount),
        imageUrl: safeImageUrl(raw.imageUrl, baseUrl),
        descriptionTruncated: bool(raw.descriptionTruncated),
        firstMessageTruncated: bool(raw.firstMessageTruncated),
    };
}

/**
 * @param {any} raw
 * @param {string} baseUrl
 * @returns {{items: object[], nextCursor: string|null}}
 */
export function normaliseList(raw, baseUrl) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
        throw new ApiError(ERROR_CODES.BAD_RESPONSE, { message: 'List response has no items array' });
    }
    const items = raw.items
        .map((item) => normaliseBotSummary(item, baseUrl))
        .filter((item) => item !== null);
    const nextCursor = typeof raw.nextCursor === 'string' && raw.nextCursor ? raw.nextCursor : null;
    return { items, nextCursor };
}

/**
 * @param {any} raw
 * @returns {{user: object, access: {verified: boolean, nsfw: boolean}, key: object}}
 */
export function normaliseMe(raw, baseUrl) {
    if (!raw || typeof raw !== 'object' || !raw.user || typeof raw.user !== 'object') {
        throw new ApiError(ERROR_CODES.BAD_RESPONSE, { message: '/me response has no user' });
    }
    const access = raw.access && typeof raw.access === 'object' ? raw.access : {};
    const key = raw.key && typeof raw.key === 'object' ? raw.key : {};
    return {
        user: {
            id: str(raw.user.id, 128),
            username: str(raw.user.username, 64) || null,
            displayName: str(raw.user.displayName, 80) || str(raw.user.username, 64) || 'unknown',
            image: safeImageUrl(raw.user.image, baseUrl),
        },
        access: {
            verified: bool(access.verified),
            nsfw: bool(access.nsfw),
        },
        key: {
            name: str(key.name, 80),
            scopes: Array.isArray(key.scopes) ? key.scopes.filter((s) => typeof s === 'string').slice(0, 16) : [],
            createdAt: str(key.createdAt, 40),
        },
    };
}

/**
 * Default sleep, overridable for tests. Resolves early when the signal aborts,
 * so closing the panel never leaves a 30 s retry timer pending.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
const realSleep = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
});

export class ApiClient {
    /**
     * @param {object} options
     * @param {string} options.baseUrl
     * @param {() => string} options.getKey Returns the current access key.
     * @param {typeof fetch} [options.fetchImpl]
     * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
     */
    constructor({ baseUrl, getKey, fetchImpl, sleep }) {
        this.baseUrl = String(baseUrl).replace(/\/+$/, '');
        this.getKey = getKey;
        this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
        this.sleep = sleep || realSleep;
        /** @type {Set<AbortController>} */
        this.controllers = new Set();
    }

    /** Cancels every in-flight request. Called when the panel closes or the view changes. */
    abortAll() {
        for (const controller of this.controllers) {
            try { controller.abort(); } catch { /* ignore */ }
        }
        this.controllers.clear();
    }

    /**
     * @param {string} path Path under the base URL, must start with '/'.
     * @param {object} [options]
     * @param {string} [options.method]
     * @param {Record<string, string|number|undefined|null>} [options.query]
     * @param {'json'|'blob'} [options.as]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{data: any, headers: Headers, status: number}>}
     */
    async request(path, { method = 'GET', query, as = 'json', signal } = {}) {
        const key = String(this.getKey() || '');
        if (!key) {
            throw new ApiError(ERROR_CODES.NO_KEY, { message: 'No access key configured' });
        }

        const url = new URL(this.baseUrl + path);
        if (query) {
            for (const [name, value] of Object.entries(query)) {
                if (value === undefined || value === null || value === '') continue;
                url.searchParams.set(name, String(value));
            }
        }

        const controller = new AbortController();
        this.controllers.add(controller);
        const forwardAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', forwardAbort, { once: true });
        }

        try {
            let attempt = 0;
            // One retry maximum: `attempt` goes 0 -> 1 and the second failure throws.
            for (;;) {
                let response;
                try {
                    response = await this.fetchImpl(url.href, {
                        method,
                        headers: {
                            Authorization: `Bearer ${key}`,
                            Accept: as === 'blob' ? 'image/png, application/json' : 'application/json',
                        },
                        credentials: 'omit',
                        cache: 'no-store',
                        redirect: 'follow',
                        referrerPolicy: 'no-referrer',
                        signal: controller.signal,
                    });
                } catch (cause) {
                    if (controller.signal.aborted) {
                        throw new ApiError(ERROR_CODES.ABORTED, { message: 'Request aborted' });
                    }
                    // A blocked CORS preflight and a dead host are
                    // indistinguishable from here; both are TypeError.
                    throw new ApiError(ERROR_CODES.NETWORK, {
                        message: 'Could not reach the server (network or CORS)',
                        cause: /** @type {Error} */ (cause),
                    });
                }

                if (response.ok) {
                    const data = as === 'blob' ? await response.blob() : await this.#readJson(response);
                    return { data, headers: response.headers, status: response.status };
                }

                const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
                const retryable = response.status === 429 || (response.status >= 500 && method === 'GET');
                if (retryable && attempt === 0) {
                    attempt += 1;
                    const delay = Math.min(retryAfter ?? 1, MAX_RETRY_DELAY_SECONDS) * 1000;
                    await this.sleep(delay, controller.signal);
                    if (controller.signal.aborted) {
                        throw new ApiError(ERROR_CODES.ABORTED, { message: 'Request aborted' });
                    }
                    continue;
                }

                throw await this.#toError(response, retryAfter);
            }
        } finally {
            this.controllers.delete(controller);
            signal?.removeEventListener('abort', forwardAbort);
        }
    }

    async #readJson(response) {
        try {
            return await response.json();
        } catch (cause) {
            throw new ApiError(ERROR_CODES.BAD_RESPONSE, {
                status: response.status,
                message: 'Response was not valid JSON',
                cause: /** @type {Error} */ (cause),
            });
        }
    }

    /**
     * @param {Response} response
     * @param {number|null} retryAfter
     * @returns {Promise<ApiError>}
     */
    async #toError(response, retryAfter) {
        let code = statusToCode(response.status);
        let message = '';
        try {
            const body = await response.json();
            const error = body && typeof body === 'object' ? body.error : null;
            if (error && typeof error === 'object') {
                if (typeof error.code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, error.code)) {
                    code = error.code;
                }
                message = str(error.message, 400);
            }
        } catch { /* body was not JSON; keep the status-derived code */ }
        return new ApiError(code, { status: response.status, message, retryAfter });
    }

    // ---- endpoints -------------------------------------------------------

    /** @param {AbortSignal} [signal] */
    async me(signal) {
        const { data } = await this.request('/me', { signal });
        return normaliseMe(data, this.baseUrl);
    }

    /** @param {{cursor?: string|null, limit?: number, signal?: AbortSignal}} [options] */
    async feed({ cursor, limit, signal } = {}) {
        const { data } = await this.request('/feed', { query: { cursor, limit }, signal });
        return normaliseList(data, this.baseUrl);
    }

    /** @param {{sort?: string, tag?: string, rating?: string, cursor?: string|null, limit?: number, signal?: AbortSignal}} [options] */
    async bots({ sort = 'latest', tag, rating = 'sfw', cursor, limit, signal } = {}) {
        const { data } = await this.request('/bots', { query: { sort, tag, rating, cursor, limit }, signal });
        return normaliseList(data, this.baseUrl);
    }

    /** @param {{q: string, cursor?: string|null, limit?: number, signal?: AbortSignal}} options */
    async search({ q, cursor, limit, signal }) {
        const { data } = await this.request('/search', { query: { q, cursor, limit }, signal });
        return normaliseList(data, this.baseUrl);
    }

    /** @param {{cursor?: string|null, limit?: number, signal?: AbortSignal}} [options] */
    async bookmarks({ cursor, limit, signal } = {}) {
        const { data } = await this.request('/bookmarks', { query: { cursor, limit }, signal });
        return normaliseList(data, this.baseUrl);
    }

    /** @param {{cursor?: string|null, limit?: number, signal?: AbortSignal}} [options] */
    async likes({ cursor, limit, signal } = {}) {
        const { data } = await this.request('/likes', { query: { cursor, limit }, signal });
        return normaliseList(data, this.baseUrl);
    }

    /**
     * @param {string} id
     * @param {AbortSignal} [signal]
     */
    async bot(id, signal) {
        const { data } = await this.request(`/bots/${encodeURIComponent(id)}`, { signal });
        const detail = normaliseBotDetail(data, this.baseUrl);
        if (!detail) throw new ApiError(ERROR_CODES.BAD_RESPONSE, { message: 'Detail response is not a bot' });
        return detail;
    }

    /**
     * @param {string} id
     * @param {'bookmark'|'like'} what
     * @param {boolean} on
     * @param {AbortSignal} [signal]
     * @returns {Promise<{bookmarked: boolean, bookmarks: number, liked: boolean, likes: number}>}
     */
    async toggle(id, what, on, signal) {
        const { data } = await this.request(`/bots/${encodeURIComponent(id)}/${what}`, {
            method: on ? 'PUT' : 'DELETE',
            signal,
        });
        const raw = data && typeof data === 'object' ? data : {};
        return {
            bookmarked: bool(raw.bookmarked),
            bookmarks: int(raw.bookmarks),
            liked: bool(raw.liked),
            likes: int(raw.likes),
        };
    }

    /**
     * Downloads the character card PNG.
     * @param {string} id
     * @param {AbortSignal} [signal]
     * @returns {Promise<{blob: Blob, fileName: string, cardVersion: string}>}
     */
    async card(id, signal) {
        const { data, headers } = await this.request(`/bots/${encodeURIComponent(id)}/card`, {
            as: 'blob',
            signal,
        });
        return {
            blob: data,
            fileName: safeFileName(parseFileName(headers.get('Content-Disposition')), id),
            cardVersion: str(headers.get('X-Card-Version'), 32),
        };
    }

    /**
     * @param {string} id
     * @param {AbortSignal} [signal]
     * @returns {Promise<object>} A V2/V3 `character_book` object.
     */
    async lorebook(id, signal) {
        const { data } = await this.request(`/bots/${encodeURIComponent(id)}/lorebook`, { signal });
        if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
            throw new ApiError(ERROR_CODES.BAD_RESPONSE, { message: 'Lorebook has no entries array' });
        }
        return data;
    }
}

/**
 * Pulls the filename out of a Content-Disposition header.
 * @param {string|null} header
 * @returns {string}
 */
export function parseFileName(header) {
    if (!header) return '';
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (star) {
        try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
    return plain ? plain[1].trim() : '';
}

/**
 * Forces a filename that cannot escape a directory or confuse the import route.
 * @param {string} name
 * @param {string} fallbackId
 * @returns {string} Always ends in `.png`.
 */
export function safeFileName(name, fallbackId) {
    const base = String(name || '')
        .split(/[\\/]/).pop()
        .replace(/\.png$/i, '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^[._-]+/, '')
        .slice(0, 60);
    const safe = base || `bot_${String(fallbackId || 'card').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)}`;
    return `${safe || 'card'}.png`;
}

/**
 * Cursor-paged list. Owns its own abort controller so switching tabs cancels
 * whatever the previous tab was loading.
 */
export class Paginator {
    /**
     * @param {(options: {cursor: string|null, limit: number, signal: AbortSignal}) => Promise<{items: object[], nextCursor: string|null}>} load
     * @param {{limit?: number}} [options]
     */
    constructor(load, { limit = 24 } = {}) {
        this.load = load;
        this.limit = limit;
        /** @type {object[]} */
        this.items = [];
        this.nextCursor = null;
        this.started = false;
        this.loading = false;
        this.done = false;
        /** @type {AbortController|null} */
        this.controller = null;
    }

    get isEmpty() {
        return this.started && !this.loading && this.items.length === 0;
    }

    cancel() {
        if (this.controller) {
            try { this.controller.abort(); } catch { /* ignore */ }
            this.controller = null;
        }
        this.loading = false;
    }

    reset() {
        this.cancel();
        this.items = [];
        this.nextCursor = null;
        this.started = false;
        this.done = false;
    }

    /**
     * Loads the next page. Concurrent calls are collapsed; a call after the last
     * page is a no-op.
     * @returns {Promise<{items: object[], added: object[], done: boolean}>}
     */
    async next() {
        if (this.loading || this.done) {
            return { items: this.items, added: [], done: this.done };
        }
        this.loading = true;
        this.started = true;
        this.controller = new AbortController();
        try {
            const page = await this.load({
                cursor: this.nextCursor,
                limit: this.limit,
                signal: this.controller.signal,
            });
            const seen = new Set(this.items.map((item) => item.id));
            const added = page.items.filter((item) => !seen.has(item.id));
            this.items = this.items.concat(added);
            this.nextCursor = page.nextCursor;
            this.done = page.nextCursor === null;
            return { items: this.items, added, done: this.done };
        } finally {
            this.loading = false;
            this.controller = null;
        }
    }

    /**
     * Replaces one item in place (after a bookmark/like toggle).
     * @param {string} id
     * @param {Partial<object>} patch
     */
    patch(id, patch) {
        const index = this.items.findIndex((item) => item.id === id);
        if (index >= 0) {
            this.items[index] = { ...this.items[index], ...patch };
        }
        return index >= 0 ? this.items[index] : null;
    }
}
