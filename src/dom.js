/**
 * Safe DOM construction helpers.
 *
 * Every string that came off the API reaches the document through
 * `textContent` or `setAttribute` here. There is no `innerHTML` anywhere in
 * this extension, so no sanitiser is needed. (SillyTavern does expose
 * DOMPurify as `SillyTavern.libs.DOMPurify`, see
 * docs/sillytavern-integration.md section 3, but not parsing HTML at all is
 * the stronger guarantee.)
 */

/**
 * @param {string} tag
 * @param {object} [options]
 * @param {string|string[]} [options.className]
 * @param {string} [options.text]
 * @param {Record<string, string|number|boolean|null|undefined>} [options.attrs]
 * @param {(Node|null|undefined|false)[]} [options.children]
 * @param {Record<string, (event: Event) => void>} [options.on]
 * @returns {HTMLElement}
 */
export function el(tag, { className, text, attrs, children, on } = {}) {
    const node = document.createElement(tag);
    if (className) {
        // Accept 'a b', ['a', 'b'] and ['a b', 'c']: every entry is split on whitespace,
        // because classList.add throws on a token that contains a space.
        const classes = (Array.isArray(className) ? className : [className])
            .flatMap((entry) => String(entry || '').split(/\s+/));
        for (const name of classes) if (name) node.classList.add(name);
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (attrs) {
        for (const [name, value] of Object.entries(attrs)) {
            if (value === null || value === undefined || value === false) continue;
            node.setAttribute(name, value === true ? '' : String(value));
        }
    }
    if (children) {
        for (const child of children) if (child) node.appendChild(child);
    }
    if (on) {
        for (const [event, handler] of Object.entries(on)) node.addEventListener(event, handler);
    }
    return node;
}

/**
 * A Font Awesome icon, as SillyTavern uses them.
 * @param {string} name e.g. 'fa-heart'
 * @param {string} [extra]
 * @returns {HTMLElement}
 */
export function icon(name, extra = '') {
    return el('i', { className: ['fa-solid', name, ...(extra ? extra.split(/\s+/) : [])], attrs: { 'aria-hidden': 'true' } });
}

/**
 * A button that works with mouse, Enter and Space, and shows a focus ring.
 * @param {object} options
 * @param {string} [options.label] Visible text.
 * @param {string} [options.title] Tooltip / accessible name when there is no text.
 * @param {string} [options.iconName]
 * @param {string|string[]} [options.className]
 * @param {(event: Event) => void} options.onClick
 * @param {boolean} [options.pressed] Renders as a toggle with aria-pressed.
 * @returns {HTMLButtonElement}
 */
export function button({ label, title, iconName, className, onClick, pressed }) {
    const node = /** @type {HTMLButtonElement} */ (el('button', {
        className: ['stb-btn', ...(className ? (Array.isArray(className) ? className : [className]) : [])],
        attrs: {
            type: 'button',
            title: title || label || null,
            'aria-label': !label && title ? title : null,
            'aria-pressed': pressed === undefined ? null : String(Boolean(pressed)),
        },
        on: { click: onClick },
    }));
    if (iconName) node.appendChild(icon(iconName));
    if (label) node.appendChild(el('span', { className: 'stb-btn-label', text: label }));
    return node;
}

/**
 * Lazily loaded image with a placeholder and an error fallback.
 * @param {object} options
 * @param {string|null} options.src Already validated by api.safeImageUrl.
 * @param {string} options.alt
 * @param {boolean} [options.blur]
 * @returns {HTMLElement}
 */
export function lazyImage({ src, alt, blur = false }) {
    const wrap = el('div', { className: ['stb-thumb', blur ? 'stb-blurred' : ''].filter(Boolean) });
    if (!src) {
        wrap.classList.add('stb-thumb-empty');
        wrap.appendChild(icon('fa-user-astronaut', 'stb-thumb-placeholder'));
        if (alt) {
            wrap.setAttribute('role', 'img');
            wrap.setAttribute('aria-label', alt);
        }
        return wrap;
    }
    const img = /** @type {HTMLImageElement} */ (el('img', {
        className: 'stb-thumb-img',
        attrs: {
            loading: 'lazy',
            decoding: 'async',
            referrerpolicy: 'no-referrer',
            alt,
            src,
        },
    }));
    img.addEventListener('error', () => {
        img.remove();
        wrap.classList.add('stb-thumb-empty');
        wrap.appendChild(icon('fa-image', 'stb-thumb-placeholder'));
    }, { once: true });
    wrap.appendChild(img);
    return wrap;
}

/** @param {HTMLElement} node */
export function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * @param {number} count
 * @returns {HTMLElement} A grid of skeleton cards.
 */
export function skeletonGrid(count = 8) {
    const grid = el('div', { className: 'stb-grid' });
    for (let i = 0; i < count; i += 1) {
        grid.appendChild(el('div', {
            className: 'stb-card stb-skeleton',
            attrs: { 'aria-hidden': 'true' },
            children: [
                el('div', { className: 'stb-skeleton-thumb' }),
                el('div', { className: 'stb-skeleton-line stb-skeleton-line-wide' }),
                el('div', { className: 'stb-skeleton-line' }),
            ],
        }));
    }
    return grid;
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.body]
 * @param {string} [options.iconName]
 * @param {{label: string, onClick: () => void}} [options.action]
 * @returns {HTMLElement}
 */
export function emptyState({ title, body, iconName = 'fa-wind', action }) {
    return el('div', {
        className: 'stb-empty',
        children: [
            icon(iconName, 'stb-empty-icon'),
            el('p', { className: 'stb-empty-title', text: title }),
            body ? el('p', { className: 'stb-empty-body', text: body }) : null,
            action ? button({ label: action.label, className: 'stb-btn-primary', onClick: action.onClick }) : null,
        ],
    });
}

/**
 * @param {(value: string) => void} handler
 * @param {number} wait
 * @returns {((value: string) => void) & { cancel: () => void }}
 */
export function debounce(handler, wait = 300) {
    let timer = null;
    const wrapped = (value) => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            handler(value);
        }, wait);
    };
    wrapped.cancel = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    return wrapped;
}

/**
 * Formats a count compactly without pulling in Intl plural rules.
 * @param {number} value
 * @returns {string}
 */
export function compactNumber(value) {
    const n = Number(value) || 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
    return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * @param {string} isoDate
 * @returns {string} A locale date, or '' when unparseable.
 */
export function formatDate(isoDate) {
    if (!isoDate) return '';
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return '';
    try {
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return date.toISOString().slice(0, 10);
    }
}

/**
 * Infinite scroll: calls `onReach` when the sentinel comes into view. Falls back
 * to doing nothing (the "Load more" button remains) when IntersectionObserver is
 * unavailable.
 * @param {HTMLElement} sentinel
 * @param {() => void} onReach
 * @returns {() => void} Disconnect.
 */
export function observeSentinel(sentinel, onReach) {
    if (typeof IntersectionObserver !== 'function') return () => {};
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) onReach();
        }
    }, { rootMargin: '300px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
}
