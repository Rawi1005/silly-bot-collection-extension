/**
 * Self-contained i18n.
 *
 * SillyTavern's own mechanism (manifest `i18n` + `addLocaleData`) keys
 * translations by the *English source text*, refuses to override keys the app
 * already defines, and only accepts data for the exact active locale id
 * (public/scripts/i18n.js addLocaleData). SillyTavern does ship a Thai UI
 * ("th-th" in public/locales/lang.json), but `getCurrentLocale()` returns the
 * raw `localStorage.language || navigator.language` value, which may be "th",
 * "th-th" or "th-TH".
 *
 * We therefore keep our own keyed bundles (i18n/en.json, i18n/th.json) and
 * match on the language prefix. Thai terms shared with the host UI (for
 * example "ยกเลิก", "นำเข้า", "ข้อมูลโลก") were taken from SillyTavern's
 * public/locales/th-th.json so the wording is consistent.
 */

import { getHostLocale } from './st.js';

const FALLBACK_LOCALE = 'en';
const SUPPORTED = ['en', 'th'];

/** @type {Record<string, Record<string, string>>} */
const bundles = Object.create(null);
let activeLocale = FALLBACK_LOCALE;

/**
 * @param {string} locale
 * @returns {string} One of SUPPORTED.
 */
export function resolveLocale(locale) {
    const lower = String(locale || '').toLowerCase();
    const prefix = lower.split(/[-_]/)[0];
    return SUPPORTED.includes(prefix) ? prefix : FALLBACK_LOCALE;
}

/**
 * Registers a bundle. Exported so tests and the dev harness can inject one
 * without network access.
 * @param {string} locale
 * @param {Record<string, string>} data
 */
export function addBundle(locale, data) {
    const key = resolveLocale(locale);
    bundles[key] = { ...(bundles[key] || {}), ...data };
}

/** @param {string} locale */
export function setLocale(locale) {
    activeLocale = resolveLocale(locale);
}

/** @returns {string} */
export function getLocale() {
    return activeLocale;
}

/**
 * Loads `i18n/<locale>.json` relative to the extension root and activates it.
 * English is always loaded as the fallback.
 * @param {string} baseHref Directory URL of the extension (ends with '/').
 * @returns {Promise<string>} The active locale.
 */
export async function initI18n(baseHref) {
    const wanted = resolveLocale(getHostLocale());
    const locales = wanted === FALLBACK_LOCALE ? [FALLBACK_LOCALE] : [FALLBACK_LOCALE, wanted];
    for (const locale of locales) {
        if (bundles[locale]) continue;
        try {
            const response = await fetch(`${baseHref}i18n/${locale}.json`, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data && typeof data === 'object') addBundle(locale, data);
        } catch (error) {
            console.warn(`[silly-bot-collection] could not load locale ${locale}`, error);
        }
    }
    setLocale(wanted);
    return activeLocale;
}

/**
 * Looks up a key and substitutes `{name}` placeholders.
 * Falls back: active locale -> English -> the key itself.
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function t(key, params) {
    const template = bundles[activeLocale]?.[key]
        ?? bundles[FALLBACK_LOCALE]?.[key]
        ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
}

/** Test seam: forget everything loaded so far. */
export function resetI18n() {
    for (const key of Object.keys(bundles)) delete bundles[key];
    activeLocale = FALLBACK_LOCALE;
}
