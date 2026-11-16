/**
 * Silly Bot Collection: SillyTavern UI extension entry point.
 *
 * SillyTavern loads this file as `<script type="module">` from
 * `/scripts/extensions/third-party/<folder>/index.js`
 * (public/scripts/extensions.js addExtensionScript). Everything it needs from
 * the host comes from `SillyTavern.getContext()`; see src/st.js.
 *
 * It adds two entry points that both open the same browsing panel:
 *  - a drawer in Extensions settings (`#extensions_settings2`);
 *  - an item in the wand menu (`#extensionsMenu`).
 */

import { getContext, openPopup, toast, LOG_PREFIX } from './src/st.js';
import { initI18n, t } from './src/i18n.js';
import { createSettings } from './src/state.js';
import { checkSupport } from './src/importer.js';
import { createApp } from './src/ui/app.js';
import { renderDrawer } from './src/ui/drawer.js';
import { el, icon } from './src/dom.js';

const EXTENSION_ROOT = new URL('./', import.meta.url).href;

/** @type {{ popup: any, app: any }|null} */
let openPanel = null;
/** @type {{ refresh: () => void }|null} */
let drawer = null;

function openBrowserPanel(settings) {
    if (openPanel) return;
    const support = checkSupport();
    let closer = () => {};
    const app = createApp({
        settings,
        onClose: () => closer(),
        onSettingsChanged: () => drawer?.refresh(),
    });
    const opened = openPopup(app.element, 'DISPLAY', {
        large: true,
        wide: true,
        animation: 'fast',
        onClose: () => {
            app.destroy();
            openPanel = null;
            drawer?.refresh();
        },
    });
    if (!opened) {
        app.destroy();
        toast('error', t('app.unsupportedTitle'));
        return;
    }
    closer = () => { void opened.popup.completeCancelled?.(); };
    openPanel = { popup: opened.popup, app };
    if (!support.ok) console.warn(`${LOG_PREFIX} unsupported SillyTavern build, missing: ${checkSupport().missing.join(', ')}`);
}

function addWandItem(settings) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('stb-wand-item')) return Boolean(menu);
    // Same markup as the bundled Gallery extension's wand item.
    const item = el('div', {
        className: 'list-group-item flex-container flexGap5 interactable',
        attrs: { id: 'stb-wand-item', tabindex: '0', role: 'button', title: t('drawer.open') },
        children: [
            icon('fa-compass', 'extensionsMenuExtensionButton'),
            el('span', { text: t('app.title') }),
        ],
        on: {
            click: () => openBrowserPanel(settings),
            keydown: (event) => {
                const key = /** @type {KeyboardEvent} */ (event).key;
                if (key === 'Enter' || key === ' ') { event.preventDefault(); openBrowserPanel(settings); }
            },
        },
    });
    menu.appendChild(item);
    return true;
}

function addDrawer(settings) {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container || document.getElementById('stb-drawer')) return Boolean(container);
    drawer = renderDrawer({ settings, support: checkSupport(), onOpen: () => openBrowserPanel(settings) });
    container.appendChild(drawer.element);
    return true;
}

async function init() {
    try {
        await initI18n(EXTENSION_ROOT);
    } catch (error) {
        console.warn(`${LOG_PREFIX} i18n failed, falling back to keys`, error);
    }
    const context = getContext();
    const settings = createSettings(context);

    const mountAll = () => addDrawer(settings) && addWandItem(settings);
    if (mountAll()) return;
    // The containers normally exist before extensions load; if not, wait for APP_READY.
    const events = context?.eventSource;
    const types = context?.eventTypes || context?.event_types;
    if (events && types?.APP_READY) {
        events.on(types.APP_READY, () => { mountAll(); });
    } else {
        setTimeout(mountAll, 2000);
    }
}

void init();
