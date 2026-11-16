/**
 * Onboarding: one screen that asks for an access key, validates it with /me,
 * and explains in one sentence where to get it.
 */

import { el, button, icon } from '../dom.js';
import { t } from '../i18n.js';
import { ApiClient, ApiError, ERROR_CODES } from '../api.js';
import { SETTINGS_PAGE_URL, isValidKeyFormat, normaliseBaseUrl } from '../state.js';

/**
 * Maps an API failure to a localised, actionable message.
 * @param {any} error
 * @returns {string}
 */
export function describeError(error) {
    const code = error instanceof ApiError ? error.code : '';
    switch (code) {
        case ERROR_CODES.INVALID_KEY: return t('error.invalidKey');
        case ERROR_CODES.NOT_VERIFIED: return t('error.notVerified');
        case ERROR_CODES.NSFW_REQUIRED: return t('error.nsfwRequired');
        case ERROR_CODES.NOT_FOUND: return t('error.notFound');
        case ERROR_CODES.RATE_LIMITED: return error.retryAfter
            ? t('error.rateLimitedIn', { seconds: error.retryAfter })
            : t('error.rateLimited');
        case ERROR_CODES.NETWORK: return t('error.network');
        case ERROR_CODES.SERVER_ERROR: return t('error.server');
        case ERROR_CODES.ABORTED: return t('error.aborted');
        case ERROR_CODES.BAD_REQUEST:
        case ERROR_CODES.BAD_CURSOR: return t('error.badRequest');
        case ERROR_CODES.BAD_RESPONSE: return t('error.badResponse');
        case ERROR_CODES.NO_KEY: return t('error.noKey');
        default: return t('error.unknown');
    }
}

/**
 * @param {object} options
 * @param {import('../state.js').Settings} options.settings
 * @param {(me: any) => void} options.onConnected
 * @param {string} [options.message] Shown in the status line (e.g. "Your key was rejected").
 * @returns {HTMLElement}
 */
export function renderOnboarding({ settings, onConnected, message = '' }) {
    const root = el('div', { className: 'stb-onboarding' });

    const status = el('p', {
        className: ['stb-onboarding-status', message ? 'stb-error' : ''],
        attrs: { role: 'status', 'aria-live': 'polite' },
        text: message,
    });

    const input = /** @type {HTMLInputElement} */ (el('input', {
        className: ['text_pole', 'stb-key-input'],
        attrs: {
            type: 'password',
            id: 'stb-key-input',
            autocomplete: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
            placeholder: 'stb_...',
            'aria-describedby': 'stb-key-hint',
        },
    }));

    const baseInput = /** @type {HTMLInputElement} */ (el('input', {
        className: ['text_pole', 'stb-base-input'],
        attrs: {
            type: 'url',
            id: 'stb-base-input',
            autocomplete: 'off',
            spellcheck: 'false',
            value: settings.baseUrl,
        },
    }));

    const advanced = el('details', {
        className: 'stb-advanced',
        children: [
            el('summary', { text: t('onboarding.advanced') }),
            el('label', { className: 'stb-field', attrs: { for: 'stb-base-input' }, text: t('onboarding.baseUrl') }),
            baseInput,
        ],
    });

    let busy = false;

    const connect = button({
        label: t('onboarding.connect'),
        className: 'stb-btn-primary',
        onClick: () => { void submit(); },
    });

    async function submit() {
        if (busy) return;
        const key = input.value.trim();
        status.classList.remove('stb-error', 'stb-ok');

        if (!isValidKeyFormat(key)) {
            status.classList.add('stb-error');
            status.textContent = t('onboarding.badFormat');
            input.focus();
            return;
        }

        let baseUrl;
        try {
            baseUrl = normaliseBaseUrl(baseInput.value);
        } catch {
            status.classList.add('stb-error');
            status.textContent = t('onboarding.badBaseUrl');
            advanced.setAttribute('open', '');
            baseInput.focus();
            return;
        }

        busy = true;
        connect.disabled = true;
        root.classList.add('stb-busy');
        status.textContent = t('onboarding.checking');

        // A throwaway client: nothing is persisted until /me answers.
        const probe = new ApiClient({ baseUrl, getKey: () => key });
        try {
            const me = await probe.me();
            settings.setBaseUrl(baseUrl);
            settings.setAccessKey(key);
            input.value = '';
            status.classList.add('stb-ok');
            status.textContent = t('onboarding.connected', { name: me.user.displayName });
            onConnected(me);
        } catch (error) {
            status.classList.add('stb-error');
            status.textContent = describeError(error);
        } finally {
            busy = false;
            connect.disabled = false;
            root.classList.remove('stb-busy');
        }
    }

    input.addEventListener('keydown', (event) => {
        if (/** @type {KeyboardEvent} */ (event).key === 'Enter') {
            event.preventDefault();
            void submit();
        }
    });

    const keyRow = el('div', { className: 'stb-key-row', children: [input, connect] });

    root.append(
        el('div', {
            className: 'stb-onboarding-head',
            children: [
                icon('fa-robot', 'stb-onboarding-logo'),
                el('h2', { className: 'stb-onboarding-title', text: t('onboarding.title') }),
                el('p', { className: 'stb-onboarding-lede', text: t('onboarding.lede') }),
            ],
        }),
        el('p', { className: 'stb-onboarding-hint', attrs: { id: 'stb-key-hint' }, text: t('onboarding.where') }),
        button({
            label: t('onboarding.openSettings'),
            iconName: 'fa-up-right-from-square',
            className: 'stb-btn-secondary',
            onClick: () => openSettingsPage(baseInput.value || settings.baseUrl),
        }),
        el('label', { className: 'stb-field', attrs: { for: 'stb-key-input' }, text: t('onboarding.keyLabel') }),
        keyRow,
        status,
        advanced,
        el('p', { className: 'stb-fineprint', text: t('onboarding.fineprint') }),
    );

    // Focus the field as soon as the view is on screen.
    requestAnimationFrame(() => input.focus());

    return root;
}

/**
 * Opens the site's settings page in a new tab.
 * Derived from the configured base URL so a self-hosted site still works.
 * @param {string} baseUrl
 */
export function openSettingsPage(baseUrl) {
    let href = SETTINGS_PAGE_URL;
    try {
        href = `${new URL(normaliseBaseUrl(baseUrl)).origin}/settings`;
    } catch { /* keep the default */ }
    try {
        globalThis.open(href, '_blank', 'noopener,noreferrer');
    } catch (error) {
        console.error('[silly-bot-collection] could not open the settings page', error);
    }
}
