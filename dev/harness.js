/**
 * A stand-in for SillyTavern so the extension UI can be exercised in a normal
 * browser. It implements only the getContext() members the extension uses,
 * with the same names and call shapes as SillyTavern (see
 * docs/sillytavern-integration.md). Served by dev/mock-server.mjs at
 * /ext/dev/harness.html; the fake /api/characters/import route lives there too.
 *
 * This is NOT SillyTavern: passing here proves the UI and the request shapes,
 * not the real import. See docs/manual-test.md for that.
 */

const STORAGE_KEY = 'stb-harness-extension-settings';
const params = new URLSearchParams(location.search);
const logBox = document.getElementById('harness-log');
document.getElementById('harness-base').textContent = `${location.origin}/api/v1`;
document.getElementById('harness-light').addEventListener('change', (e) => document.body.classList.toggle('light', e.target.checked));
document.getElementById('harness-reset').addEventListener('click', () => { localStorage.removeItem(STORAGE_KEY); location.reload(); });

function log(...parts) {
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    logBox.textContent = `${new Date().toLocaleTimeString()} ${line}\n${logBox.textContent}`;
}

// ---- toastr ----------------------------------------------------------------
const toastBox = document.getElementById('toasts');
function makeToast(level) {
    return (message, title, options = {}) => {
        const node = document.createElement('div');
        node.className = `toast toast-${level}`;
        // Same escaping contract as SillyTavern's toastr (escapeHtml: true): text only.
        node.textContent = title ? `${title}: ${message}` : message;
        node.addEventListener('click', () => { options.onclick?.(); node.remove(); });
        toastBox.appendChild(node);
        const timeout = options.timeOut ?? 4000;
        if (timeout > 0) setTimeout(() => node.remove(), timeout);
        log(`toast.${level}`, node.textContent);
        return node;
    };
}
globalThis.toastr = {
    success: makeToast('success'), info: makeToast('info'), warning: makeToast('warning'), error: makeToast('error'),
    clear: (node) => node?.remove?.(),
};

// ---- Popup (same constructor and results as public/scripts/popup.js) ---------
const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001, CUSTOM2: 1002, CUSTOM3: 1003 };

class Popup {
    constructor(content, type, inputValue = '', options = {}) {
        this.type = type;
        this.options = options;
        this.dlg = document.createElement('dialog');
        this.dlg.className = `popup${type === POPUP_TYPE.DISPLAY ? '' : ' small'}`;
        const body = document.createElement('div');
        body.className = 'popup-content';
        if (content instanceof HTMLElement) body.append(content);
        else body.textContent = String(content);
        this.dlg.append(body);
        if (type === POPUP_TYPE.DISPLAY) {
            const close = document.createElement('button');
            close.className = 'menu_button popup-close';
            close.textContent = 'X';
            close.setAttribute('aria-label', 'Close');
            close.addEventListener('click', () => this.completeCancelled());
            this.dlg.append(close);
        } else {
            const controls = document.createElement('div');
            controls.className = 'popup-controls';
            const add = (text, result) => {
                const b = document.createElement('button');
                b.className = 'menu_button';
                b.textContent = text;
                b.addEventListener('click', () => this.complete(result));
                controls.append(b);
                return b;
            };
            for (const custom of options.customButtons || []) add(custom.text, custom.result);
            if (options.okButton !== false) add(typeof options.okButton === 'string' ? options.okButton : 'OK', POPUP_RESULT.AFFIRMATIVE);
            if (options.cancelButton !== false) add(typeof options.cancelButton === 'string' ? options.cancelButton : 'Cancel', POPUP_RESULT.NEGATIVE);
            this.dlg.append(controls);
        }
        this.dlg.addEventListener('cancel', (event) => { event.preventDefault(); this.complete(POPUP_RESULT.CANCELLED); });
    }
    show() {
        document.body.append(this.dlg);
        this.dlg.showModal();
        return new Promise((resolve) => { this.resolve = resolve; });
    }
    async complete(result) {
        if (!this.resolve) return;
        await this.options.onClose?.(this);
        this.dlg.close();
        this.dlg.remove();
        const resolve = this.resolve;
        this.resolve = null;
        resolve(result);
    }
    completeCancelled() { return this.complete(POPUP_RESULT.CANCELLED); }
}

// ---- fake app state ----------------------------------------------------------
const characters = [];
const worlds = new Map();
let extensionSettings = {};
try { extensionSettings = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { extensionSettings = {}; }
// Point the extension at this mock server, never at the production default.
extensionSettings.sillyBotCollection = {
    ...(extensionSettings.sillyBotCollection || {}),
    baseUrl: `${location.origin}/api/v1`,
};
let saveTimer = null;

function paintState() {
    log('characters:', characters.map((c) => `${c.avatar}${c.data?.extensions?.world ? ` -> world "${c.data.extensions.world}"` : ''}`));
    log('world info:', [...worlds.keys()]);
}

const context = {
    get characters() { return characters; },
    name1: 'HarnessUser',
    extensionSettings,
    saveSettingsDebounced() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(extensionSettings));
            log('settings saved (key value hidden):', { ...extensionSettings.sillyBotCollection, accessKey: extensionSettings.sillyBotCollection?.accessKey ? '<set>' : '' });
        }, 300);
    },
    getRequestHeaders() {
        return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'harness-token' };
    },
    async getCharacters() {
        const response = await fetch('/api/characters/all', { method: 'POST', headers: this.getRequestHeaders(), body: '{}' });
        const list = await response.json();
        const worldLinks = new Map(characters.map((c) => [c.avatar, c.data?.extensions?.world]));
        characters.splice(0, characters.length, ...list.map((c) => {
            const world = worldLinks.get(c.avatar);
            if (world) c.data = { ...c.data, extensions: { ...(c.data?.extensions || {}), world } };
            return c;
        }));
        paintState();
    },
    async selectCharacterById(id) {
        if (characters[id] === undefined) return;
        log(`selectCharacterById(${id}) ->`, characters[id].name);
    },
    getThumbnailUrl: (type, file) => `/ext/dev/harness.html?thumb=${encodeURIComponent(file)}`,
    Popup,
    POPUP_TYPE,
    POPUP_RESULT,
    getCurrentLocale: () => (params.get('lang') || navigator.language || 'en').toLowerCase(),
    convertCharacterBook(book) {
        const entries = {};
        book.entries.forEach((entry, index) => {
            if (entry.id === undefined) entry.id = index;
            entries[entry.id] = { uid: entry.id, key: entry.keys, content: entry.content, disable: !entry.enabled };
        });
        return { entries, originalData: book };
    },
    async saveWorldInfo(name, data) { worlds.set(name, data); },
    async updateWorldInfoList() { /* the list is the map */ },
    getWorldInfoNames: () => [...worlds.keys()],
    async writeExtensionField(chid, key, value) {
        const c = characters[chid];
        if (!c) return;
        c.data = { ...(c.data || {}), extensions: { ...(c.data?.extensions || {}), [key]: value } };
        log(`writeExtensionField(${chid}, ${key}, ${value})`);
        paintState();
    },
    async importTags(character) { log('importTags', character.name, character.tags); },
    eventSource: { on() {} },
    eventTypes: { APP_READY: 'app_ready' },
};

globalThis.SillyTavern = { getContext: () => context, libs: {} };

// Drawer toggle, as delegated in public/script.js.
document.addEventListener('click', (event) => {
    const toggle = event.target.closest?.('.inline-drawer-toggle');
    if (toggle) toggle.closest('.inline-drawer').classList.toggle('open');
});

await import('../index.js');
await context.getCharacters();
log('harness ready');
