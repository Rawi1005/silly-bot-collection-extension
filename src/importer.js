/**
 * Everything that talks to SillyTavern's import machinery lives here, so a
 * SillyTavern change touches this one file.
 *
 * Chosen approach (docs/sillytavern-integration.md section 4):
 *   1. download the card PNG ourselves, with the bearer header (api.card);
 *   2. POST it as multipart to SillyTavern's own `/api/characters/import`
 *      route with the CSRF headers from `getRequestHeaders()` minus
 *      Content-Type (the browser must set the multipart boundary);
 *   3. refresh with `getCharacters()` and find the new avatar file name;
 *   4. import the lorebook with `convertCharacterBook` + `saveWorldInfo` +
 *      `updateWorldInfoList` and link it with
 *      `writeExtensionField(chid, 'world', name)`;
 *   5. let the user open it with `selectCharacterById(index)`.
 *
 * Only `getContext()` members are used, plus the HTTP route the app's own
 * importer posts to.
 */

import { getContext, checkContext, hasLorebookSupport, REQUIRED_CONTEXT_KEYS, LOG_PREFIX } from './st.js';
import { readCardFromPng, getEmbeddedLorebook, getCardName } from './png.js';

export const IMPORT_ENDPOINT = '/api/characters/import';

export const IMPORT_ERROR = Object.freeze({
    UNSUPPORTED: 'UNSUPPORTED',
    BAD_CARD: 'BAD_CARD',
    UPLOAD_FAILED: 'UPLOAD_FAILED',
    SERVER_REJECTED: 'SERVER_REJECTED',
    NOT_FOUND_AFTER_IMPORT: 'NOT_FOUND_AFTER_IMPORT',
    LOREBOOK_FAILED: 'LOREBOOK_FAILED',
});

export class ImportError extends Error {
    /**
     * @param {string} code One of IMPORT_ERROR.
     * @param {{message?: string, cause?: any, missing?: string[]}} [options]
     */
    constructor(code, { message = '', cause, missing } = {}) {
        super(message || code);
        this.name = 'ImportError';
        this.code = code;
        if (cause) this.cause = cause;
        if (missing) this.missing = missing;
    }
}

/** @returns {{ok: boolean, missing: string[], lorebook: boolean}} */
export function checkSupport() {
    const base = checkContext(REQUIRED_CONTEXT_KEYS);
    return { ok: base.ok, missing: base.missing, lorebook: base.ok && hasLorebookSupport() };
}

/**
 * Headers for a multipart upload. `getRequestHeaders()` always includes
 * `Content-Type: application/json`; newer releases accept
 * `{ omitContentType: true }` but 1.12.x/1.13.0 ignore that option, so we
 * strip the header ourselves (any casing) and keep the CSRF token.
 * @param {any} context
 * @returns {Record<string, string>}
 */
export function uploadHeaders(context) {
    const headers = { ...(context.getRequestHeaders() || {}) };
    for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'content-type') delete headers[name];
    }
    return headers;
}

/**
 * Mirrors the `sanitize-filename` package that SillyTavern's world-info
 * endpoint applies to `${name}.json` (src/endpoints/worldinfo.js). If we
 * linked a name that the server then rewrote, the character would point at a
 * lorebook that does not exist, so we pre-sanitise to the same result.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeWorldName(name) {
    let out = String(name ?? '')
        .replace(/[/?<>\\:*|"]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x80-\x9f]/g, '')
        .replace(/[. ]+$/, '')
        .trim();
    if (/^\.+$/.test(out)) out = '';
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(out)) out = '';
    return out.slice(0, 100);
}

/**
 * Picks the World Info name. Overwrites only a lorebook this extension
 * itself created for the same bot; otherwise picks a free name so a user's
 * own lorebook is never replaced.
 * @param {object} options
 * @param {string} options.wanted Desired name (unsanitised).
 * @param {string} options.fallback Used when `wanted` sanitises to empty.
 * @param {string[]} options.existing Current World Info names.
 * @param {string} [options.ownName] Name recorded for this bot by a previous import.
 * @returns {{name: string, overwrite: boolean}}
 */
export function pickWorldName({ wanted, fallback, existing, ownName = '' }) {
    if (ownName) return { name: ownName, overwrite: existing.includes(ownName) };
    const base = sanitizeWorldName(wanted) || sanitizeWorldName(fallback) || 'Lorebook';
    const taken = new Set(existing.map((n) => n.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return { name: base, overwrite: false };
    for (let i = 2; i < 1000; i += 1) {
        const candidate = `${base} (${i})`;
        if (!taken.has(candidate.toLowerCase())) return { name: candidate, overwrite: false };
    }
    return { name: `${base} (${Date.now()})`, overwrite: false };
}

/**
 * Inspects a downloaded card before uploading it.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{card: object|null, lorebook: object|null, name: string}}
 */
export function inspectCard(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const card = readCardFromPng(bytes);
    return { card, lorebook: getEmbeddedLorebook(card), name: getCardName(card) };
}

/**
 * Uploads the PNG to SillyTavern.
 * @param {any} context
 * @param {File} file
 * @param {{preserveFileName?: string, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<string>} The avatar file name, e.g. "Araya.png".
 */
export async function uploadCard(context, file, { preserveFileName = '', fetchImpl = globalThis.fetch } = {}) {
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', 'png');
    if (typeof context.name1 === 'string' && context.name1) formData.append('user_name', context.name1);
    if (preserveFileName) formData.append('preserved_name', preserveFileName);

    let response;
    try {
        response = await fetchImpl(IMPORT_ENDPOINT, {
            method: 'POST',
            body: formData,
            headers: uploadHeaders(context),
            cache: 'no-cache',
        });
    } catch (cause) {
        throw new ImportError(IMPORT_ERROR.UPLOAD_FAILED, { message: 'Could not reach SillyTavern', cause });
    }
    if (!response.ok) {
        throw new ImportError(IMPORT_ERROR.SERVER_REJECTED, { message: `SillyTavern returned HTTP ${response.status}` });
    }
    /** @type {any} */
    let body;
    try {
        body = await response.json();
    } catch (cause) {
        throw new ImportError(IMPORT_ERROR.SERVER_REJECTED, { message: 'Non-JSON import response', cause });
    }
    // Success is `{ file_name }` without extension; failure is `{ error: true }` (src/endpoints/characters.js).
    if (!body || body.error || typeof body.file_name !== 'string' || !body.file_name) {
        throw new ImportError(IMPORT_ERROR.SERVER_REJECTED, { message: 'SillyTavern rejected the card' });
    }
    return `${body.file_name}.png`;
}

/**
 * @param {any} context
 * @param {string} avatar
 * @returns {number} Index into `context.characters`, or -1.
 */
export function findCharacterIndex(context, avatar) {
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    return characters.findIndex((character) => character && character.avatar === avatar);
}

/** @param {any} context @returns {string[]|null} null when the app does not expose the list. */
function worldNames(context) {
    if (typeof context.getWorldInfoNames !== 'function') return null;
    try {
        const names = context.getWorldInfoNames();
        return Array.isArray(names) ? names.filter((n) => typeof n === 'string') : null;
    } catch {
        return null;
    }
}

/**
 * Saves a V2/V3 `character_book` as World Info and links it to the character.
 * @param {any} context
 * @param {object} book
 * @param {{characterName: string, chid: number, ownName?: string}} target
 * @returns {Promise<string>} The World Info name written.
 */
export async function importLorebook(context, book, { characterName, chid, ownName = '' }) {
    const before = worldNames(context);
    const { name } = pickWorldName({
        wanted: typeof /** @type {any} */ (book).name === 'string' ? /** @type {any} */ (book).name : '',
        fallback: `${characterName}'s Lorebook`,
        existing: before ?? [],
        ownName: ownName && before?.includes(ownName) ? ownName : '',
    });
    try {
        // convertCharacterBook mutates entries (assigns ids); give it a copy.
        const converted = context.convertCharacterBook(structuredClone(book));
        await context.saveWorldInfo(name, converted, true);
        await context.updateWorldInfoList();
    } catch (cause) {
        throw new ImportError(IMPORT_ERROR.LOREBOOK_FAILED, { message: 'Could not save the lorebook', cause });
    }
    // saveWorldInfo does not report HTTP failures, so check the list when we can.
    const after = worldNames(context);
    if (after && !after.includes(name)) {
        throw new ImportError(IMPORT_ERROR.LOREBOOK_FAILED, { message: `World Info "${name}" did not appear after saving` });
    }
    try {
        // Sets data.extensions.world, which is also what stops SillyTavern's
        // "this character has an embedded lorebook" prompt (world-info.js checkEmbeddedWorld).
        await context.writeExtensionField(chid, 'world', name);
    } catch (error) {
        console.warn(`${LOG_PREFIX} could not link the lorebook to the character`, error);
    }
    return name;
}

/**
 * The whole import, start to finish. Does not select the character.
 *
 * @param {object} options
 * @param {{ card: Function, lorebook: Function }} options.api ApiClient (or a stub).
 * @param {{id: string, name: string, hasLorebook?: boolean}} options.bot
 * @param {'new'|'update'} [options.mode] 'update' overwrites the previously imported character.
 * @param {{avatar?: string, lorebook?: string}|null} [options.record] Previous import record.
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{avatar: string, chid: number, cardVersion: string, lorebookName: string|null, lorebookError: boolean, replaced: boolean}>}
 */
export async function importBot({ api, bot, mode = 'new', record = null, signal, fetchImpl = globalThis.fetch }) {
    const support = checkSupport();
    if (!support.ok) {
        throw new ImportError(IMPORT_ERROR.UNSUPPORTED, { message: 'Missing SillyTavern context members', missing: support.missing });
    }
    let context = getContext();

    const { blob, fileName, cardVersion } = await api.card(bot.id, signal);
    const buffer = await blob.arrayBuffer();
    const inspected = inspectCard(buffer);
    if (!inspected.card) {
        throw new ImportError(IMPORT_ERROR.BAD_CARD, { message: 'The download is not a character card PNG' });
    }

    // Only overwrite when the old avatar still exists; otherwise this is a fresh import.
    const preserve = mode === 'update' && record?.avatar && findCharacterIndex(context, record.avatar) >= 0
        ? record.avatar
        : '';

    const file = new File([buffer], fileName, { type: 'image/png' });
    const avatar = await uploadCard(context, file, { preserveFileName: preserve, fetchImpl });

    if (preserve && typeof context.getThumbnailUrl === 'function') {
        // Same as the app's own importer: bust the cached thumbnail of a replaced card.
        try { await fetchImpl(context.getThumbnailUrl('avatar', avatar), { cache: 'reload' }); } catch { /* cosmetic */ }
    }

    await context.getCharacters();
    context = getContext();
    const chid = findCharacterIndex(context, avatar);
    if (chid < 0) {
        throw new ImportError(IMPORT_ERROR.NOT_FOUND_AFTER_IMPORT, { message: `Imported ${avatar} but it is not in the character list` });
    }

    const characterName = inspected.name || bot.name;
    let lorebookName = null;
    let lorebookError = false;

    let book = inspected.lorebook;
    if (!book && bot.hasLorebook) {
        try {
            book = await api.lorebook(bot.id, signal);
        } catch (error) {
            console.warn(`${LOG_PREFIX} lorebook fallback failed`, error);
            lorebookError = true;
        }
    }
    if (book) {
        if (!hasLorebookSupport()) {
            lorebookError = true;
        } else {
            try {
                lorebookName = await importLorebook(context, book, {
                    characterName,
                    chid,
                    ownName: mode === 'update' ? (record?.lorebook || '') : '',
                });
            } catch (error) {
                // A failed lorebook must not undo a successful character import.
                console.error(`${LOG_PREFIX} lorebook import failed`, error);
                lorebookError = true;
            }
        }
    }

    // Tags: `importTags` honours the user's "Import Card Tags" setting
    // (public/scripts/tags.js handleTagImport), exactly like a drag-and-drop import.
    if (typeof context.importTags === 'function' && context.characters[chid]) {
        try {
            await context.importTags(context.characters[chid]);
        } catch (error) {
            console.warn(`${LOG_PREFIX} tag import skipped`, error);
        }
    }

    return { avatar, chid, cardVersion, lorebookName, lorebookError, replaced: Boolean(preserve) };
}

/**
 * Opens an imported character. Looks the index up again by avatar because
 * indices shift whenever the character list is reloaded.
 * @param {string} avatar
 * @returns {Promise<boolean>}
 */
export async function openCharacter(avatar) {
    const context = getContext();
    if (!context || typeof context.selectCharacterById !== 'function') return false;
    const chid = findCharacterIndex(context, avatar);
    if (chid < 0) return false;
    try {
        await context.selectCharacterById(chid);
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX} could not select the character`, error);
        return false;
    }
}
