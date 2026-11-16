/**
 * Extension settings and the record of imported cards.
 *
 * Persisted through SillyTavern's `extensionSettings` + `saveSettingsDebounced`
 * (docs/sillytavern-integration.md section 2). Everything that needs testing is
 * a pure function; the only stateful piece is `Settings`, which wraps a plain
 * object store so the dev harness and the tests can pass their own.
 */

export const MODULE_NAME = 'sillyBotCollection';
export const DEFAULT_BASE_URL = 'https://bots.rolezy.com/api/v1';
export const SETTINGS_PAGE_URL = 'https://bots.rolezy.com/settings';
export const KEY_PATTERN = /^stb_[A-Za-z0-9_-]{32,128}$/;

/** Maximum import records kept, oldest dropped first. */
export const MAX_IMPORT_RECORDS = 500;

export const IMPORT_STATUS = Object.freeze({
    NONE: 'none',
    IMPORTED: 'imported',
    UPDATE: 'update',
});

/** @returns {{baseUrl: string, accessKey: string, blurNsfw: boolean, connectedAs: string, imports: Record<string, any>}} */
export function defaultSettings() {
    return {
        baseUrl: DEFAULT_BASE_URL,
        accessKey: '',
        blurNsfw: true,
        // Display name from the last successful /me, shown in the settings drawer. Not a secret.
        connectedAs: '',
        imports: {},
    };
}

/**
 * Trims and validates a base URL. Only https is accepted, except on loopback
 * hosts so the dev mock server works.
 * @param {string} input
 * @returns {string} Normalised URL with no trailing slash.
 * @throws {Error} code 'BAD_BASE_URL'
 */
export function normaliseBaseUrl(input) {
    const raw = String(input ?? '').trim();
    if (!raw) {
        const error = new Error('Base URL is empty');
        error.name = 'BAD_BASE_URL';
        throw error;
    }
    let url;
    try {
        url = new URL(raw);
    } catch {
        const error = new Error(`Not a URL: ${raw}`);
        error.name = 'BAD_BASE_URL';
        throw error;
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        const error = new Error(`Base URL must be https: ${raw}`);
        error.name = 'BAD_BASE_URL';
        throw error;
    }
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
}

/**
 * @param {string} key
 * @returns {boolean} Whether the key is shaped like an access key.
 */
export function isValidKeyFormat(key) {
    return KEY_PATTERN.test(String(key ?? '').trim());
}

/**
 * Fills in missing fields and drops anything unexpected, so a corrupted or
 * hand-edited settings.json cannot crash the extension.
 * @param {any} raw
 * @returns {{baseUrl: string, accessKey: string, blurNsfw: boolean, imports: Record<string, {version: string, importedAt: string, updatedAt: string, name: string}>}}
 */
export function normaliseSettings(raw) {
    const defaults = defaultSettings();
    const source = raw && typeof raw === 'object' ? raw : {};

    let baseUrl = defaults.baseUrl;
    try {
        baseUrl = normaliseBaseUrl(source.baseUrl ?? defaults.baseUrl);
    } catch {
        baseUrl = defaults.baseUrl;
    }

    const accessKey = typeof source.accessKey === 'string' && isValidKeyFormat(source.accessKey)
        ? source.accessKey.trim()
        : '';

    /** @type {Record<string, any>} */
    const imports = {};
    const rawImports = source.imports && typeof source.imports === 'object' ? source.imports : {};
    for (const [botId, record] of Object.entries(rawImports)) {
        if (typeof botId !== 'string' || !botId || !record || typeof record !== 'object') continue;
        const entry = /** @type {any} */ (record);
        imports[botId] = {
            version: typeof entry.version === 'string' ? entry.version.slice(0, 32) : '',
            importedAt: typeof entry.importedAt === 'string' ? entry.importedAt : '',
            updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
            name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : '',
            avatar: typeof entry.avatar === 'string' ? entry.avatar.slice(0, 128) : '',
            lorebook: typeof entry.lorebook === 'string' ? entry.lorebook.slice(0, 128) : '',
        };
    }

    return {
        baseUrl,
        accessKey,
        blurNsfw: typeof source.blurNsfw === 'boolean' ? source.blurNsfw : defaults.blurNsfw,
        connectedAs: accessKey && typeof source.connectedAs === 'string' ? source.connectedAs.slice(0, 80) : '',
        imports,
    };
}

/**
 * Adds or replaces an import record, keeping the map bounded.
 * Pure: returns a new imports map.
 * @param {Record<string, any>} imports
 * @param {{botId: string, version?: string, updatedAt?: string, name?: string, importedAt?: string, avatar?: string, lorebook?: string}} record
 * @returns {Record<string, any>}
 */
export function recordImport(imports, record) {
    const next = { ...(imports || {}) };
    next[record.botId] = {
        version: String(record.version ?? '').slice(0, 32),
        importedAt: record.importedAt ?? new Date().toISOString(),
        updatedAt: String(record.updatedAt ?? ''),
        name: String(record.name ?? '').slice(0, 80),
        avatar: String(record.avatar ?? '').slice(0, 128),
        lorebook: String(record.lorebook ?? '').slice(0, 128),
    };
    const keys = Object.keys(next);
    if (keys.length > MAX_IMPORT_RECORDS) {
        keys
            .sort((a, b) => String(next[a].importedAt).localeCompare(String(next[b].importedAt)))
            .slice(0, keys.length - MAX_IMPORT_RECORDS)
            .forEach((key) => { delete next[key]; });
    }
    return next;
}

/**
 * Decides which badge a card gets.
 *
 * - When both the stored record and the server know a card version, the
 *   version decides alone: different means "Update available".
 * - Otherwise fall back to timestamps: "Update available" when the bot's
 *   `updatedAt` is strictly later than the one stored at import time.
 * Timestamps are compared as instants (Date.parse), not as strings, so
 * "2026-11-02T10:12:00Z" and "2026-11-02T10:12:00.000Z" are equal.
 *
 * @param {Record<string, any>} imports
 * @param {{id: string, updatedAt?: string, cardVersion?: string}} bot
 * @returns {'none'|'imported'|'update'}
 */
export function getImportStatus(imports, bot) {
    const record = (imports || {})[bot?.id];
    if (!record) return IMPORT_STATUS.NONE;

    const serverVersion = typeof bot.cardVersion === 'string' ? bot.cardVersion : '';
    if (serverVersion && record.version) {
        return serverVersion === record.version ? IMPORT_STATUS.IMPORTED : IMPORT_STATUS.UPDATE;
    }

    const serverUpdated = Date.parse(typeof bot.updatedAt === 'string' ? bot.updatedAt : '');
    const storedUpdated = Date.parse(typeof record.updatedAt === 'string' ? record.updatedAt : '');
    if (Number.isFinite(serverUpdated) && Number.isFinite(storedUpdated) && serverUpdated > storedUpdated) {
        return IMPORT_STATUS.UPDATE;
    }

    return IMPORT_STATUS.IMPORTED;
}

/**
 * Live settings wrapper.
 *
 * `store` is the object that owns our slice (SillyTavern's `extensionSettings`,
 * or any plain object). `save` is called after every mutation.
 */
export class Settings {
    /**
     * @param {{ store: Record<string, any>, save?: () => void }} options
     */
    constructor({ store, save }) {
        this.store = store && typeof store === 'object' ? store : {};
        this.save = typeof save === 'function' ? save : () => {};
        this.store[MODULE_NAME] = normaliseSettings(this.store[MODULE_NAME]);
    }

    /** @returns {ReturnType<typeof normaliseSettings>} */
    get values() {
        return this.store[MODULE_NAME];
    }

    get baseUrl() { return this.values.baseUrl; }
    get accessKey() { return this.values.accessKey; }
    get blurNsfw() { return this.values.blurNsfw; }
    get imports() { return this.values.imports; }
    get connectedAs() { return this.values.connectedAs; }
    get isConnected() { return Boolean(this.values.accessKey); }

    /** @param {string} url */
    setBaseUrl(url) {
        this.values.baseUrl = normaliseBaseUrl(url);
        this.save();
    }

    /**
     * @param {string} key
     * @throws {Error} name 'BAD_KEY_FORMAT'
     */
    setAccessKey(key) {
        const trimmed = String(key ?? '').trim();
        if (!isValidKeyFormat(trimmed)) {
            const error = new Error('Access key does not look like an stb_ key');
            error.name = 'BAD_KEY_FORMAT';
            throw error;
        }
        this.values.accessKey = trimmed;
        this.save();
    }

    clearAccessKey() {
        this.values.accessKey = '';
        this.values.connectedAs = '';
        this.save();
    }

    /** @param {string} name */
    setConnectedAs(name) {
        this.values.connectedAs = String(name ?? '').slice(0, 80);
        this.save();
    }

    /** @param {boolean} value */
    setBlurNsfw(value) {
        this.values.blurNsfw = Boolean(value);
        this.save();
    }

    /** @param {{botId: string, version?: string, updatedAt?: string, name?: string, avatar?: string, lorebook?: string}} record */
    rememberImport(record) {
        this.values.imports = recordImport(this.values.imports, record);
        this.save();
    }

    /** @param {string} botId */
    forgetImport(botId) {
        if (this.values.imports[botId]) {
            delete this.values.imports[botId];
            this.save();
        }
    }

    /**
     * @param {{id: string, updatedAt?: string, cardVersion?: string}} bot
     * @returns {'none'|'imported'|'update'}
     */
    statusFor(bot) {
        return getImportStatus(this.values.imports, bot);
    }
}

/**
 * Builds a Settings instance backed by SillyTavern, or by a fallback object
 * when the app is not present (dev harness).
 * @param {object|null} context
 * @returns {Settings}
 */
export function createSettings(context) {
    if (context && context.extensionSettings && typeof context.extensionSettings === 'object') {
        return new Settings({
            store: context.extensionSettings,
            save: () => {
                if (typeof context.saveSettingsDebounced === 'function') {
                    context.saveSettingsDebounced();
                }
            },
        });
    }
    return new Settings({ store: {} });
}
