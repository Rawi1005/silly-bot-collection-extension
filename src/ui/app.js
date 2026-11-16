/**
 * Panel controller: owns the root element and switches between onboarding,
 * the browser and the detail view. Also owns the import flow.
 */

import { el, button, icon, clear, lazyImage } from '../dom.js';
import { t } from '../i18n.js';
import { ApiClient, ApiError, ERROR_CODES } from '../api.js';
import { IMPORT_STATUS } from '../state.js';
import { renderOnboarding, describeError } from './onboarding.js';
import { renderBrowser } from './browser.js';
import { renderDetail } from './detail.js';
import { confirmImport } from './dialogs.js';
import { checkSupport, importBot, openCharacter, ImportError, IMPORT_ERROR } from '../importer.js';
import { toast, MIN_ST_VERSION, LOG_PREFIX } from '../st.js';

const IMPORT_ERROR_KEYS = Object.freeze({
    [IMPORT_ERROR.UNSUPPORTED]: 'import.error.unsupported',
    [IMPORT_ERROR.BAD_CARD]: 'import.error.badCard',
    [IMPORT_ERROR.UPLOAD_FAILED]: 'import.error.upload',
    [IMPORT_ERROR.SERVER_REJECTED]: 'import.error.rejected',
    [IMPORT_ERROR.NOT_FOUND_AFTER_IMPORT]: 'import.error.missing',
    [IMPORT_ERROR.LOREBOOK_FAILED]: 'import.error.lorebook',
});

/**
 * @param {object} options
 * @param {import('../state.js').Settings} options.settings
 * @param {() => void} [options.onClose] Closes the surrounding popup.
 * @param {() => void} [options.onSettingsChanged] Lets the settings drawer repaint.
 * @returns {{ element: HTMLElement, destroy: () => void }}
 */
export function createApp({ settings, onClose = () => {}, onSettingsChanged = () => {} }) {
    const root = el('div', { className: 'stb-root', attrs: { id: 'stb-root' } });
    const header = el('div', { className: 'stb-header' });
    const view = el('div', { className: 'stb-view' });
    root.append(header, view);

    /** @type {ApiClient|null} */
    let api = null;
    /** @type {any} */
    let me = null;
    /** @type {any} */
    let current = null;
    /** @type {any} */
    let browserView = null;
    let inDetail = false;

    const support = checkSupport();

    function applyBlur() {
        root.classList.toggle('stb-blur-nsfw', settings.blurNsfw);
    }
    applyBlur();

    // Escape in the detail view goes back instead of closing the whole panel.
    // Cancelling keydown stops the <dialog> close request in the host Popup.
    root.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !inDetail) return;
        event.preventDefault();
        event.stopPropagation();
        backToBrowser();
    });

    /** @param {any} next @param {boolean} [detail] */
    function mount(next, detail = false) {
        if (current && current !== browserView) current.destroy();
        current = next;
        inDetail = detail;
        clear(view);
        view.appendChild(next.element);
        view.scrollTop = 0;
    }

    function makeClient() {
        return new ApiClient({ baseUrl: settings.baseUrl, getKey: () => settings.accessKey });
    }

    // ---- header -----------------------------------------------------------

    function paintHeader() {
        clear(header);
        header.appendChild(el('div', {
            className: 'stb-brand',
            children: [icon('fa-robot'), el('span', { text: t('app.title') })],
        }));
        if (!me) return;

        const avatar = me.user.image
            ? (() => { const a = lazyImage({ src: me.user.image, alt: '' }); a.classList.add('stb-avatar'); return a; })()
            : el('span', { className: 'stb-avatar stb-avatar-empty', children: [icon('fa-user')] });

        header.appendChild(el('div', {
            className: 'stb-who',
            children: [
                avatar,
                el('div', {
                    className: 'stb-who-text',
                    children: [
                        el('span', { className: 'stb-who-name', text: t('app.connectedAs', { name: me.user.displayName }) }),
                        el('span', {
                            className: 'stb-who-access',
                            children: [
                                el('span', { className: me.access.verified ? 'stb-pill stb-pill-ok' : 'stb-pill stb-pill-warn', text: me.access.verified ? t('app.verified') : t('app.notVerified') }),
                                el('span', { className: 'stb-pill', text: me.access.nsfw ? t('app.nsfwOn') : t('app.nsfwOff') }),
                            ],
                        }),
                    ],
                }),
            ],
        }));

        const blurButton = button({
            label: t('app.blur'),
            iconName: settings.blurNsfw ? 'fa-eye-slash' : 'fa-eye',
            className: 'stb-chip',
            pressed: settings.blurNsfw,
            onClick: () => {
                settings.setBlurNsfw(!settings.blurNsfw);
                applyBlur();
                paintHeader();
                onSettingsChanged();
                /** @type {HTMLElement|null} */ (header.querySelector('.stb-chip'))?.focus();
            },
        });

        header.appendChild(el('div', {
            className: 'stb-header-actions',
            children: [
                me.access.nsfw ? blurButton : null,
                button({
                    label: t('app.disconnect'),
                    iconName: 'fa-link-slash',
                    className: 'stb-chip stb-chip-danger',
                    onClick: () => disconnect(),
                }),
            ],
        }));
    }

    // ---- views ------------------------------------------------------------

    function openUnsupported() {
        mount({
            element: el('div', {
                className: 'stb-empty',
                attrs: { role: 'alert' },
                children: [
                    icon('fa-plug-circle-exclamation', 'stb-empty-icon'),
                    el('p', { className: 'stb-empty-title', text: t('app.unsupportedTitle') }),
                    el('p', { className: 'stb-empty-body', text: t('app.unsupportedBody', { version: MIN_ST_VERSION }) }),
                    el('p', { className: 'stb-muted stb-mono', text: t('app.unsupportedMissing', { list: support.missing.join(', ') || '-' }) }),
                ],
            }),
            destroy: () => {},
        });
    }

    /** @param {string} [message] */
    function openOnboarding(message) {
        me = null;
        api = null;
        paintHeader();
        const screen = renderOnboarding({
            settings,
            message,
            onConnected: (nextMe) => {
                me = nextMe;
                settings.setConnectedAs(nextMe.user.displayName);
                onSettingsChanged();
                api = makeClient();
                paintHeader();
                openBrowser();
            },
        });
        mount({ element: screen, destroy: () => {} });
    }

    function openBrowser() {
        if (!api || !me) { openOnboarding(); return; }
        if (browserView) browserView.destroy();
        browserView = renderBrowser({ api, settings, me, onOpenDetail: (bot) => openDetail(bot) });
        mount(browserView);
    }

    function backToBrowser() {
        if (!browserView) { openBrowser(); return; }
        browserView.refreshBadges?.();
        const lastId = current?.botId;
        mount(browserView);
        // Return focus to the card the user came from.
        if (lastId) {
            const card = view.querySelector(`[data-bot-id="${CSS.escape(lastId)}"] .stb-card-open`);
            /** @type {HTMLElement|null} */ (card)?.focus();
        }
    }

    /** @param {any} summary */
    function openDetail(summary) {
        if (!api || !me) return;
        const detail = renderDetail({
            api,
            settings,
            me,
            summary,
            lorebookSupported: support.lorebook,
            onBack: backToBrowser,
            onImport: (bot) => runImport(bot),
            onOpenCharacter: (avatar) => { void openImported(avatar); },
            onTag: (tag) => {
                if (!browserView) openBrowser();
                mount(browserView);
                browserView.browseTag(tag);
            },
        });
        mount({ ...detail, botId: summary.id }, true);
    }

    // ---- import -----------------------------------------------------------

    /** @param {string} avatar */
    async function openImported(avatar) {
        const ok = await openCharacter(avatar);
        if (ok) onClose();
        else toast('error', t('import.error.openFailed'), t('import.failedTitle'));
    }

    /**
     * @param {any} bot A BotDetail (or summary) from the API.
     * @returns {Promise<{avatar: string}|null>}
     */
    async function runImport(bot) {
        if (!api) return null;
        if (!me?.access?.verified) {
            toast('error', t('error.notVerified'), t('error.title'));
            return null;
        }

        const status = settings.statusFor(bot);
        const decision = await confirmImport({ bot, status, lorebookSupported: support.lorebook });
        if (decision === 'cancel') return null;

        const record = settings.imports[bot.id] || null;
        const pending = toast('info', t('import.started', { name: bot.name }), '', { timeOut: 0, extendedTimeOut: 0 });

        try {
            const result = await importBot({ api, bot, mode: decision, record });
            settings.rememberImport({
                botId: bot.id,
                version: result.cardVersion || bot.cardVersion || '',
                updatedAt: bot.updatedAt,
                name: bot.name,
                avatar: result.avatar,
                lorebook: result.lorebookName || '',
            });
            browserView?.refreshBadges?.();

            const message = result.lorebookName
                ? t('import.successWithLorebook', { name: bot.name, lorebook: result.lorebookName })
                : t('import.success', { name: bot.name });
            toast('success', `${message} ${t('import.clickToOpen')}`, t('import.successTitle'), {
                timeOut: 8000,
                extendedTimeOut: 12000,
                onclick: () => { void openImported(result.avatar); },
            });
            if (result.lorebookError) {
                toast('warning', t('import.lorebookMissing'), t('import.successTitle'));
            }
            return { avatar: result.avatar };
        } catch (error) {
            reportImportError(error);
            return null;
        } finally {
            clearToast(pending);
        }
    }

    /** @param {any} handle */
    function clearToast(handle) {
        const toastr = /** @type {any} */ (globalThis).toastr;
        if (handle && toastr && typeof toastr.clear === 'function') {
            try { toastr.clear(handle); } catch { /* ignore */ }
        }
    }

    /** @param {any} error */
    function reportImportError(error) {
        if (error instanceof ApiError) {
            if (error.code === ERROR_CODES.ABORTED) return;
            if (error.isAuthFailure) {
                settings.clearAccessKey();
                onSettingsChanged();
                openOnboarding(describeError(error));
                return;
            }
            toast('error', describeError(error), t('import.failedTitle'));
            return;
        }
        if (error instanceof ImportError) {
            toast('error', t(IMPORT_ERROR_KEYS[error.code] || 'import.error.unknown'), t('import.failedTitle'));
            console.error(`${LOG_PREFIX} import failed`, error);
            return;
        }
        toast('error', t('import.error.unknown'), t('import.failedTitle'));
        console.error(`${LOG_PREFIX} import failed`, error);
    }

    // ---- lifecycle --------------------------------------------------------

    function disconnect() {
        settings.clearAccessKey();
        onSettingsChanged();
        api?.abortAll();
        if (browserView) { browserView.destroy(); browserView = null; }
        openOnboarding(t('app.disconnected'));
    }

    async function start() {
        if (!support.ok) { openUnsupported(); return; }
        if (!settings.isConnected) { openOnboarding(); return; }
        api = makeClient();
        mount({
            element: el('div', {
                className: 'stb-booting',
                attrs: { role: 'status' },
                children: [icon('fa-spinner', 'fa-spin'), el('span', { text: t('app.connecting') })],
            }),
            destroy: () => {},
        });
        try {
            me = await api.me();
            if (me.user.displayName !== settings.connectedAs) {
                settings.setConnectedAs(me.user.displayName);
                onSettingsChanged();
            }
            paintHeader();
            openBrowser();
        } catch (error) {
            if (error instanceof ApiError && error.code === ERROR_CODES.ABORTED) return;
            if (error instanceof ApiError && error.isAuthFailure) {
                settings.clearAccessKey();
                onSettingsChanged();
                openOnboarding(describeError(error));
                return;
            }
            // Keep the key: a network blip should not log the user out.
            mount({
                element: el('div', {
                    className: 'stb-empty',
                    attrs: { role: 'alert' },
                    children: [
                        icon('fa-triangle-exclamation', 'stb-empty-icon'),
                        el('p', { className: 'stb-empty-title', text: t('error.title') }),
                        el('p', { className: 'stb-empty-body', text: describeError(error) }),
                        el('div', {
                            className: 'stb-actions',
                            children: [
                                button({ label: t('common.retry'), className: 'stb-btn-primary', onClick: () => { void start(); } }),
                                button({ label: t('app.disconnect'), onClick: () => disconnect() }),
                            ],
                        }),
                    ],
                }),
                destroy: () => {},
            });
        }
    }

    function destroy() {
        api?.abortAll();
        if (browserView) browserView.destroy();
        if (current && current !== browserView) current.destroy();
        browserView = null;
        current = null;
    }

    void start();

    return { element: root, destroy };
}
