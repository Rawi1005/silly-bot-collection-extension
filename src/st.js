/**
 * The single place that touches SillyTavern's global surface.
 *
 * Everything is reached through `SillyTavern.getContext()` (public/script.js,
 * `globalThis.SillyTavern = { libs, getContext }`). There are no relative
 * imports into the host app, so a file moved inside SillyTavern cannot break
 * this module at load time. See docs/sillytavern-integration.md section 2.
 */

export const LOG_PREFIX = '[silly-bot-collection]';

/** Context members this extension cannot work without. */
export const REQUIRED_CONTEXT_KEYS = Object.freeze([
    'getRequestHeaders',
    'extensionSettings',
    'saveSettingsDebounced',
    'getCharacters',
    'selectCharacterById',
    'characters',
    'Popup',
    'POPUP_TYPE',
    'POPUP_RESULT',
]);

/** Context members needed for the lorebook half of an import. */
export const LOREBOOK_CONTEXT_KEYS = Object.freeze([
    'convertCharacterBook',
    'saveWorldInfo',
    'updateWorldInfoList',
    'writeExtensionField',
]);

/** Oldest SillyTavern release whose getContext() has every required member. */
export const MIN_ST_VERSION = '1.12.12';

/**
 * @returns {any} The SillyTavern context, or null when not running inside the app.
 */
export function getContext() {
    const host = /** @type {any} */ (globalThis).SillyTavern;
    if (!host || typeof host.getContext !== 'function') {
        return null;
    }
    try {
        const context = host.getContext();
        return context && typeof context === 'object' ? context : null;
    } catch (error) {
        console.error(`${LOG_PREFIX} getContext() threw`, error);
        return null;
    }
}

/**
 * Feature-detects the context surface.
 * @param {readonly string[]} [keys]
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkContext(keys = REQUIRED_CONTEXT_KEYS) {
    const context = getContext();
    if (!context) {
        return { ok: false, missing: ['SillyTavern.getContext'] };
    }
    const missing = keys.filter((key) => context[key] === undefined || context[key] === null);
    return { ok: missing.length === 0, missing };
}

/** @returns {boolean} Whether the lorebook import path is available. */
export function hasLorebookSupport() {
    return checkContext(LOREBOOK_CONTEXT_KEYS).ok;
}

/** @returns {string} Lowercased locale, e.g. "th-th". Empty string when unknown. */
export function getHostLocale() {
    const context = getContext();
    if (context && typeof context.getCurrentLocale === 'function') {
        try {
            const locale = context.getCurrentLocale();
            if (typeof locale === 'string' && locale) return locale.toLowerCase();
        } catch { /* fall through */ }
    }
    const nav = /** @type {any} */ (globalThis).navigator;
    return String(nav?.language || '').toLowerCase();
}

/**
 * Toasts through SillyTavern's toastr. `toastr` is a classic global script
 * (public/index.html `lib/toastr.min.js`), not a context member, so it is
 * feature-detected. SillyTavern sets `escapeHtml: true` globally; we force it
 * again per call because the message can contain API strings.
 * @param {'success'|'info'|'warning'|'error'} level
 * @param {string} message
 * @param {string} [title]
 * @param {object} [options]
 * @returns {any} The toast handle, or undefined when toastr is missing.
 */
export function toast(level, message, title, options = {}) {
    const toastr = /** @type {any} */ (globalThis).toastr;
    if (toastr && typeof toastr[level] === 'function') {
        try {
            return toastr[level](message, title, { ...options, escapeHtml: true });
        } catch (error) {
            console.error(`${LOG_PREFIX} toast failed`, error);
        }
    }
    const line = title ? `${title}: ${message}` : message;
    if (level === 'error') console.error(`${LOG_PREFIX} ${line}`);
    else if (level === 'warning') console.warn(`${LOG_PREFIX} ${line}`);
    else console.info(`${LOG_PREFIX} ${line}`);
    return undefined;
}

/**
 * Opens a dialog through the app's own Popup class (public/scripts/popup.js).
 * Content is always an HTMLElement, which Popup `append`s; a string would go
 * through innerHTML, so we never pass one.
 * @param {HTMLElement} content
 * @param {'TEXT'|'CONFIRM'|'DISPLAY'} type
 * @param {object} [options] PopupOptions
 * @returns {{ promise: Promise<any>, popup: any }|null} null when Popup is unavailable.
 */
export function openPopup(content, type, options = {}) {
    const context = getContext();
    if (!context || typeof context.Popup !== 'function' || !context.POPUP_TYPE) {
        return null;
    }
    const popup = new context.Popup(content, context.POPUP_TYPE[type], '', options);
    return { promise: popup.show(), popup };
}

/** @returns {Record<string, number|null>} POPUP_RESULT, with the documented defaults as fallback. */
export function popupResults() {
    const context = getContext();
    return context?.POPUP_RESULT ?? { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001, CUSTOM2: 1002 };
}
