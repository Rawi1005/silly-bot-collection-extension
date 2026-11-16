/**
 * The browsing panel: tabs (For you / Bookmarks / Liked / Browse / Search),
 * a responsive grid, skeletons, infinite scroll with a "Load more" fallback,
 * empty and error states, and a debounced search box.
 */

import { el, button, icon, clear, skeletonGrid, emptyState, debounce, observeSentinel } from '../dom.js';
import { t } from '../i18n.js';
import { Paginator, ApiError, ERROR_CODES } from '../api.js';
import { botCard, replaceCard } from './cards.js';
import { describeError } from './onboarding.js';
import { toast } from '../st.js';

export const TABS = Object.freeze(['feed', 'bookmarks', 'liked', 'browse', 'search']);

const SORTS = Object.freeze(['latest', 'popular', 'trending']);

/**
 * @param {object} options
 * @param {import('../api.js').ApiClient} options.api
 * @param {import('../state.js').Settings} options.settings
 * @param {{access: {verified: boolean, nsfw: boolean}}} options.me
 * @param {(bot: object) => void} options.onOpenDetail
 * @returns {{ element: HTMLElement, destroy: () => void, refreshBadges: () => void, selectTab: (tab: string) => void, browseTag: (tag: string) => void }}
 */
export function renderBrowser({ api, settings, me, onOpenDetail }) {
    const root = el('div', { className: 'stb-browser' });

    /** @type {string} */
    let activeTab = 'feed';
    /** @type {string} */
    let sort = 'latest';
    /** @type {string} */
    let rating = 'sfw';
    /** @type {string} */
    let query = '';
    /** @type {string} */
    let tag = '';
    /** @type {Paginator|null} */
    let pager = null;
    /** @type {(() => void)|null} */
    let disconnectSentinel = null;

    // ---- chrome -----------------------------------------------------------

    const tabBar = el('div', { className: 'stb-tabs', attrs: { role: 'tablist' } });
    /** @type {Record<string, HTMLButtonElement>} */
    const tabButtons = {};

    for (const tab of TABS) {
        const node = /** @type {HTMLButtonElement} */ (el('button', {
            className: 'stb-tab',
            text: t(`tab.${tab}`),
            attrs: {
                type: 'button',
                role: 'tab',
                id: `stb-tab-${tab}`,
                'aria-selected': 'false',
                'aria-controls': 'stb-results',
            },
            on: { click: () => selectTab(tab) },
        }));
        tabButtons[tab] = node;
        tabBar.appendChild(node);
    }

    tabBar.addEventListener('keydown', (event) => {
        const key = /** @type {KeyboardEvent} */ (event).key;
        if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
        event.preventDefault();
        const index = TABS.indexOf(activeTab);
        const next = key === 'ArrowRight'
            ? (index + 1) % TABS.length
            : (index - 1 + TABS.length) % TABS.length;
        selectTab(TABS[next]);
        tabButtons[TABS[next]].focus();
    });

    const searchInput = /** @type {HTMLInputElement} */ (el('input', {
        className: ['text_pole', 'stb-search-input'],
        attrs: {
            type: 'search',
            id: 'stb-search-input',
            placeholder: t('search.placeholder'),
            autocomplete: 'off',
            spellcheck: 'false',
            'aria-label': t('search.placeholder'),
        },
    }));

    const runSearch = debounce((value) => {
        query = value.trim();
        if (activeTab !== 'search') return;
        void load({ fresh: true });
    }, 350);

    searchInput.addEventListener('input', () => runSearch(searchInput.value));
    searchInput.addEventListener('keydown', (event) => {
        const key = /** @type {KeyboardEvent} */ (event).key;
        if (key === 'Enter') {
            event.preventDefault();
            runSearch.cancel();
            query = searchInput.value.trim();
            void load({ fresh: true });
        }
        if (key === 'Escape' && searchInput.value) {
            event.stopPropagation();
            searchInput.value = '';
            runSearch.cancel();
            query = '';
            void load({ fresh: true });
        }
    });

    const searchBar = el('div', {
        className: 'stb-searchbar',
        children: [icon('fa-magnifying-glass', 'stb-search-icon'), searchInput],
    });

    const sortBar = el('div', { className: 'stb-filters', attrs: { role: 'group', 'aria-label': t('browse.sortAria') } });
    /** @type {Record<string, HTMLButtonElement>} */
    const sortButtons = {};
    for (const value of SORTS) {
        const node = /** @type {HTMLButtonElement} */ (button({
            label: t(`browse.sort.${value}`),
            className: 'stb-chip',
            pressed: value === sort,
            onClick: () => {
                sort = value;
                paintFilters();
                void load({ fresh: true });
            },
        }));
        sortButtons[value] = node;
        sortBar.appendChild(node);
    }

    const nsfwToggle = /** @type {HTMLButtonElement} */ (button({
        label: t('browse.includeNsfw'),
        className: 'stb-chip stb-chip-nsfw',
        pressed: false,
        onClick: () => {
            // Hard rule: never ask for NSFW lists when /me says nsfw: false.
            if (!me.access.nsfw) {
                toast('info', t('browse.nsfwLocked'));
                return;
            }
            rating = rating === 'sfw' ? 'all' : 'sfw';
            paintFilters();
            void load({ fresh: true });
        },
    }));
    if (!me.access.nsfw) {
        nsfwToggle.classList.add('stb-disabled');
        nsfwToggle.setAttribute('title', t('browse.nsfwLocked'));
    }
    sortBar.appendChild(nsfwToggle);

    const tagChip = el('span', { className: 'stb-tag-filter stb-hidden' });
    sortBar.appendChild(tagChip);

    function paintFilters() {
        clear(tagChip);
        tagChip.classList.toggle('stb-hidden', !tag);
        if (tag) {
            tagChip.append(
                el('span', { text: t('browse.tagFilter', { tag }) }),
                button({
                    title: t('browse.clearTag'),
                    iconName: 'fa-xmark',
                    className: 'stb-icon-btn',
                    onClick: () => { tag = ''; paintFilters(); void load({ fresh: true }); },
                }),
            );
        }
        for (const [value, node] of Object.entries(sortButtons)) {
            node.setAttribute('aria-pressed', String(value === sort));
            node.classList.toggle('stb-on', value === sort);
        }
        nsfwToggle.setAttribute('aria-pressed', String(rating !== 'sfw'));
        nsfwToggle.classList.toggle('stb-on', rating !== 'sfw');
    }
    paintFilters();

    const results = el('div', {
        className: 'stb-results',
        attrs: { id: 'stb-results', role: 'tabpanel', 'aria-labelledby': 'stb-tab-feed' },
    });

    const grid = el('div', { className: 'stb-grid' });
    const footer = el('div', { className: 'stb-results-footer' });
    const sentinel = el('div', { className: 'stb-sentinel', attrs: { 'aria-hidden': 'true' } });

    root.append(tabBar, searchBar, sortBar, results);

    // ---- data -------------------------------------------------------------

    function makePager() {
        switch (activeTab) {
            case 'bookmarks':
                return new Paginator((options) => api.bookmarks(options));
            case 'liked':
                return new Paginator((options) => api.likes(options));
            case 'browse':
                return new Paginator((options) => api.bots({ ...options, sort, rating, tag: tag || undefined }));
            case 'search':
                return new Paginator((options) => api.search({ ...options, q: query }));
            case 'feed':
            default:
                return new Paginator((options) => api.feed(options));
        }
    }

    /** @param {{fresh?: boolean}} [options] */
    async function load({ fresh = false } = {}) {
        if (fresh) {
            if (pager) pager.cancel();
            pager = makePager();
            clear(results);
            if (activeTab === 'search' && !query) {
                results.appendChild(emptyState({
                    title: t('search.idleTitle'),
                    body: t('search.idleBody'),
                    iconName: 'fa-magnifying-glass',
                }));
                return;
            }
            results.appendChild(skeletonGrid(8));
        }

        const current = pager;
        if (!current || current.loading || current.done) return;

        try {
            const { added, done } = await current.next();
            if (current !== pager) return; // a newer load superseded this one
            paint(current, added, fresh);
            if (done) stopSentinel();
        } catch (error) {
            if (current !== pager) return;
            if (error instanceof ApiError && error.code === ERROR_CODES.ABORTED) return;
            paintError(error, fresh);
        }
    }

    /**
     * @param {Paginator} current
     * @param {object[]} added
     * @param {boolean} fresh
     */
    function paint(current, added, fresh) {
        if (fresh) {
            clear(results);
            clear(grid);
            results.append(grid, footer);
        }

        for (const bot of added) grid.appendChild(makeCard(bot));

        clear(footer);

        if (current.items.length === 0) {
            clear(results);
            results.appendChild(emptyStateForTab());
            return;
        }

        if (!current.done) {
            footer.append(
                button({
                    label: t('common.loadMore'),
                    className: 'stb-btn-primary stb-loadmore',
                    onClick: () => { void load(); },
                }),
                sentinel,
            );
            startSentinel();
        } else {
            footer.appendChild(el('p', { className: 'stb-end', text: t('common.endOfList') }));
        }
    }

    /**
     * @param {any} error
     * @param {boolean} fresh
     */
    function paintError(error, fresh) {
        const message = describeError(error);
        if (fresh) {
            clear(results);
            results.appendChild(emptyState({
                title: t('error.title'),
                body: message,
                iconName: 'fa-triangle-exclamation',
                action: { label: t('common.retry'), onClick: () => { void load({ fresh: true }); } },
            }));
            return;
        }
        clear(footer);
        footer.append(
            el('p', { className: 'stb-error-line', text: message }),
            button({ label: t('common.retry'), className: 'stb-btn-primary', onClick: () => { void load(); } }),
        );
    }

    function emptyStateForTab() {
        switch (activeTab) {
            case 'bookmarks':
                return emptyState({ title: t('empty.bookmarksTitle'), body: t('empty.bookmarksBody'), iconName: 'fa-bookmark' });
            case 'liked':
                return emptyState({ title: t('empty.likedTitle'), body: t('empty.likedBody'), iconName: 'fa-heart' });
            case 'search':
                return emptyState({ title: t('empty.searchTitle', { q: query }), body: t('empty.searchBody'), iconName: 'fa-magnifying-glass' });
            case 'browse':
                return emptyState({ title: t('empty.browseTitle'), body: t('empty.browseBody'), iconName: 'fa-list' });
            case 'feed':
            default:
                return emptyState({
                    title: t('empty.feedTitle'),
                    body: t('empty.feedBody'),
                    iconName: 'fa-wand-magic-sparkles',
                    action: { label: t('tab.browse'), onClick: () => selectTab('browse') },
                });
        }
    }

    /** @param {object} bot */
    function makeCard(bot) {
        return botCard({
            bot,
            status: settings.statusFor(bot),
            onOpen: onOpenDetail,
            onToggle: (target, kind, on) => { void toggle(target, kind, on); },
        });
    }

    /**
     * @param {object} bot
     * @param {'bookmark'|'like'} kind
     * @param {boolean} on
     */
    async function toggle(bot, kind, on) {
        // Optimistic, reverted on failure.
        const optimistic = kind === 'like'
            ? { liked: on, likes: Math.max(0, bot.likes + (on ? 1 : -1)) }
            : { bookmarked: on, bookmarks: Math.max(0, (bot.bookmarks || 0) + (on ? 1 : -1)) };
        applyPatch(bot.id, optimistic);

        try {
            const state = await api.toggle(bot.id, kind, on);
            applyPatch(bot.id, state);
        } catch (error) {
            applyPatch(bot.id, kind === 'like'
                ? { liked: bot.liked, likes: bot.likes }
                : { bookmarked: bot.bookmarked, bookmarks: bot.bookmarks });
            if (!(error instanceof ApiError && error.code === ERROR_CODES.ABORTED)) {
                toast('error', describeError(error), t('error.title'));
            }
        }
    }

    /**
     * @param {string} botId
     * @param {object} patch
     */
    function applyPatch(botId, patch) {
        if (!pager) return;
        const updated = pager.patch(botId, patch);
        if (updated) replaceCard(grid, botId, makeCard(updated));
    }

    function startSentinel() {
        stopSentinel();
        disconnectSentinel = observeSentinel(sentinel, () => { void load(); });
    }

    function stopSentinel() {
        if (disconnectSentinel) {
            disconnectSentinel();
            disconnectSentinel = null;
        }
    }

    /** @param {string} tab */
    function selectTab(tab) {
        if (!TABS.includes(tab)) return;
        activeTab = tab;
        for (const [name, node] of Object.entries(tabButtons)) {
            const on = name === tab;
            node.setAttribute('aria-selected', String(on));
            node.classList.toggle('stb-on', on);
        }
        results.setAttribute('aria-labelledby', `stb-tab-${tab}`);
        searchBar.classList.toggle('stb-hidden', tab !== 'search');
        sortBar.classList.toggle('stb-hidden', tab !== 'browse');
        void load({ fresh: true });
        if (tab === 'search') requestAnimationFrame(() => searchInput.focus());
    }

    /** Re-paints import badges after an import, without refetching. */
    function refreshBadges() {
        if (!pager) return;
        for (const bot of pager.items) {
            replaceCard(grid, bot.id, makeCard(bot));
        }
    }

    /**
     * Shows Browse filtered by one tag (from a tag chip in the detail view).
     * @param {string} value
     */
    function browseTag(value) {
        tag = String(value || '').slice(0, 32);
        paintFilters();
        selectTab('browse');
    }

    function destroy() {
        stopSentinel();
        runSearch.cancel();
        if (pager) pager.cancel();
        pager = null;
    }

    selectTab('feed');

    return { element: root, destroy, refreshBadges, selectTab, browseTag };
}
