/**
 * The entry in SillyTavern's Extensions panel: a collapsible `inline-drawer`
 * (the app's own markup; its click handler is delegated on
 * `.inline-drawer-toggle` in public/script.js), with connection status, the
 * button that opens the browser, the NSFW blur switch and Disconnect.
 */

import { el, button, icon, clear } from '../dom.js';
import { t } from '../i18n.js';

/**
 * @param {object} options
 * @param {import('../state.js').Settings} options.settings
 * @param {{ok: boolean}} options.support
 * @param {() => void} options.onOpen
 * @returns {{ element: HTMLElement, refresh: () => void }}
 */
export function renderDrawer({ settings, support, onOpen }) {
    const status = el('p', { className: 'stb-drawer-status' });
    const blurInput = /** @type {HTMLInputElement} */ (el('input', {
        attrs: { type: 'checkbox', id: 'stb-drawer-blur' },
        on: {
            change: () => {
                settings.setBlurNsfw(blurInput.checked);
                document.getElementById('stb-root')?.classList.toggle('stb-blur-nsfw', blurInput.checked);
            },
        },
    }));
    const disconnect = button({
        label: t('app.disconnect'),
        iconName: 'fa-link-slash',
        className: 'menu_button stb-drawer-btn',
        onClick: () => { settings.clearAccessKey(); refresh(); },
    });

    const body = el('div', {
        className: 'stb-drawer-body',
        children: [
            status,
            button({
                label: t('drawer.open'),
                iconName: 'fa-compass',
                className: 'menu_button stb-drawer-btn',
                onClick: onOpen,
            }),
            el('label', {
                className: 'checkbox_label stb-drawer-check',
                attrs: { for: 'stb-drawer-blur' },
                children: [blurInput, el('span', { text: t('drawer.blur') })],
            }),
            disconnect,
            el('p', { className: 'stb-drawer-note', text: t('drawer.storageNote') }),
        ],
    });

    const element = el('div', {
        className: 'stb-drawer',
        attrs: { id: 'stb-drawer' },
        children: [
            el('div', {
                className: 'inline-drawer',
                children: [
                    el('div', {
                        className: 'inline-drawer-toggle inline-drawer-header',
                        children: [
                            el('b', { text: t('app.title') }),
                            el('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
                        ],
                    }),
                    el('div', { className: 'inline-drawer-content', children: [body] }),
                ],
            }),
        ],
    });

    function refresh() {
        clear(status);
        blurInput.checked = settings.blurNsfw;
        if (!support.ok) {
            status.append(icon('fa-plug-circle-exclamation'), el('span', { text: ` ${t('app.unsupportedTitle')}` }));
            disconnect.classList.add('stb-hidden');
            return;
        }
        const connected = settings.isConnected;
        disconnect.classList.toggle('stb-hidden', !connected);
        status.append(
            icon(connected ? 'fa-circle-check' : 'fa-key'),
            el('span', {
                text: ` ${connected
                    ? (settings.connectedAs ? t('app.connectedAs', { name: settings.connectedAs }) : t('drawer.keySaved'))
                    : t('drawer.notConnected')}`,
            }),
        );
    }

    refresh();
    return { element, refresh };
}
