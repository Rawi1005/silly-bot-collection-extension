/**
 * The character detail view: image, creator, tags, description, first-message
 * preview, lorebook flag, bookmark/like toggles and the Import button.
 */

import { el, button, icon, clear, lazyImage, compactNumber, formatDate } from '../dom.js';
import { t } from '../i18n.js';
import { ApiError, ERROR_CODES } from '../api.js';
import { IMPORT_STATUS } from '../state.js';
import { describeError } from './onboarding.js';
import { toast } from '../st.js';

/**
 * @param {object} options
 * @param {import('../api.js').ApiClient} options.api
 * @param {import('../state.js').Settings} options.settings
 * @param {{access: {verified: boolean, nsfw: boolean}}} options.me
 * @param {object} options.summary The BotSummary that was clicked.
 * @param {() => void} options.onBack
 * @param {(bot: object) => Promise<{avatar: string}|null>} options.onImport Resolves with the imported avatar, or null.
 * @param {(avatar: string) => void} options.onOpenCharacter
 * @param {(tag: string) => void} options.onTag
 * @param {boolean} options.lorebookSupported
 * @returns {{ element: HTMLElement, destroy: () => void }}
 */
export function renderDetail({ api, settings, me, summary, onBack, onImport, onOpenCharacter, onTag, lorebookSupported }) {
    const root = el('div', { className: 'stb-detail' });
    const controller = new AbortController();

    const back = button({
        label: t('common.back'),
        iconName: 'fa-arrow-left',
        className: 'stb-btn-link stb-back',
        onClick: onBack,
    });

    const body = el('div', { className: 'stb-detail-body' });
    root.append(back, body);

    /** @type {any} */
    let bot = summary;
    /** @type {string} Avatar of a character imported from this view, for the "Open character" banner. */
    let importedAvatar = '';
    let revealed = false;

    function paintLoading() {
        clear(body);
        body.appendChild(el('div', {
            className: 'stb-detail-skeleton',
            children: [
                el('div', { className: 'stb-skeleton-hero' }),
                el('div', { className: 'stb-skeleton-line stb-skeleton-line-wide' }),
                el('div', { className: 'stb-skeleton-line' }),
                el('div', { className: 'stb-skeleton-line' }),
            ],
        }));
    }

    function paintError(error) {
        clear(body);
        body.append(
            el('p', { className: 'stb-error-line', text: describeError(error) }),
            button({
                label: t('common.retry'),
                className: 'stb-btn-primary',
                onClick: () => { void load(); },
            }),
        );
    }

    function paint() {
        clear(body);

        const status = settings.statusFor(bot);
        const nsfw = bot.rating === 'nsfw';

        const hero = lazyImage({
            src: bot.imageUrl || bot.thumbnailUrl,
            alt: t('card.portraitAlt', { name: bot.name }),
        });
        hero.classList.add('stb-hero');
        if (nsfw) {
            hero.classList.add('stb-nsfw');
            if (revealed) hero.classList.add('stb-revealed');
            const reveal = button({
                label: t('detail.reveal'),
                iconName: 'fa-eye',
                className: 'stb-reveal',
                onClick: () => { revealed = true; hero.classList.add('stb-revealed'); },
            });
            hero.appendChild(reveal);
        }

        const tags = el('div', { className: 'stb-detail-tags' });
        for (const tag of bot.tags) {
            tags.appendChild(button({
                label: tag,
                title: t('detail.browseTag', { tag }),
                className: 'stb-tag stb-tag-btn',
                onClick: () => onTag(tag),
            }));
        }

        const meta = el('dl', {
            className: 'stb-meta',
            children: [
                el('dt', { text: t('detail.creator') }),
                el('dd', {
                    className: 'stb-creator',
                    children: [
                        bot.creator.image
                            ? (() => { const a = lazyImage({ src: bot.creator.image, alt: '' }); a.classList.add('stb-avatar'); return a; })()
                            : null,
                        el('span', { text: bot.creator.username ? `${bot.creator.name} (@${bot.creator.username})` : bot.creator.name }),
                    ],
                }),
                el('dt', { text: t('detail.rating') }),
                el('dd', { text: nsfw ? t('card.nsfw') : t('detail.sfw') }),
                el('dt', { text: t('detail.lorebook') }),
                el('dd', {
                    text: bot.hasLorebook
                        ? (bot.lorebookEntryCount
                            ? t('detail.lorebookYesCount', { count: bot.lorebookEntryCount })
                            : t('detail.lorebookYes'))
                        : t('detail.lorebookNo'),
                }),
                el('dt', { text: t('detail.updated') }),
                el('dd', { text: formatDate(bot.updatedAt) || '—' }),
                el('dt', { text: t('card.downloads') }),
                el('dd', { text: compactNumber(bot.downloads) }),
            ],
        });

        const toggles = el('div', {
            className: 'stb-detail-toggles',
            children: [
                button({
                    label: `${t(bot.liked ? 'card.unlike' : 'card.like')} · ${compactNumber(bot.likes)}`,
                    iconName: 'fa-heart',
                    className: ['stb-chip', bot.liked ? 'stb-on' : ''],
                    pressed: bot.liked,
                    onClick: () => { void toggle('like', !bot.liked); },
                }),
                button({
                    label: t(bot.bookmarked ? 'card.unbookmark' : 'card.bookmark'),
                    iconName: 'fa-bookmark',
                    className: ['stb-chip', bot.bookmarked ? 'stb-on' : ''],
                    pressed: bot.bookmarked,
                    onClick: () => { void toggle('bookmark', !bot.bookmarked); },
                }),
                bot.url
                    ? button({
                        label: t('detail.openOnSite'),
                        iconName: 'fa-up-right-from-square',
                        className: 'stb-chip',
                        onClick: () => { globalThis.open(bot.url, '_blank', 'noopener,noreferrer'); },
                    })
                    : null,
            ].filter(Boolean),
        });

        const importLabel = status === IMPORT_STATUS.UPDATE
            ? t('detail.importUpdate')
            : status === IMPORT_STATUS.IMPORTED
                ? t('detail.importAgain')
                : t('detail.import');

        const importButton = button({
            label: importLabel,
            iconName: 'fa-download',
            className: 'stb-btn-primary stb-import',
            onClick: async () => {
                importButton.disabled = true;
                importButton.classList.add('stb-busy');
                importButton.setAttribute('aria-busy', 'true');
                let result = null;
                try {
                    result = await onImport(bot);
                } finally {
                    if (result?.avatar) importedAvatar = result.avatar;
                    if (root.isConnected) paint();
                }
            },
        });

        if (!me.access.verified) {
            importButton.disabled = true;
            importButton.setAttribute('title', t('error.notVerified'));
        }

        const badges = el('div', { className: 'stb-detail-badges' });
        if (status === IMPORT_STATUS.IMPORTED) {
            badges.appendChild(el('span', { className: 'stb-badge stb-badge-imported', text: t('card.imported') }));
        }
        if (status === IMPORT_STATUS.UPDATE) {
            badges.appendChild(el('span', { className: 'stb-badge stb-badge-update', text: t('card.updateAvailable') }));
        }
        if (bot.hasLorebook && !lorebookSupported) {
            badges.appendChild(el('span', { className: 'stb-badge stb-warn', text: t('import.item.lorebookUnsupported') }));
        }

        const banner = importedAvatar
            ? el('div', {
                className: 'stb-banner',
                attrs: { role: 'status' },
                children: [
                    icon('fa-check'),
                    el('span', { text: t('import.success', { name: bot.name }) }),
                    button({
                        label: t('import.openCharacter'),
                        className: 'stb-btn-primary',
                        onClick: () => onOpenCharacter(importedAvatar),
                    }),
                ],
            })
            : null;

        body.append(
            el('div', {
                className: 'stb-detail-top',
                children: [
                    hero,
                    el('div', {
                        className: 'stb-detail-head',
                        children: [
                            el('h2', { className: 'stb-detail-name', text: bot.name }),
                            bot.tagline ? el('p', { className: 'stb-detail-tagline', text: bot.tagline }) : null,
                            badges,
                            tags,
                            toggles,
                            importButton,
                            !me.access.verified ? el('p', { className: 'stb-muted', text: t('error.notVerified') }) : null,
                            banner,
                        ].filter(Boolean),
                    }),
                ],
            }),
            meta,
            section(t('detail.description'), bot.description, bot.descriptionTruncated),
            section(t('detail.firstMessage'), bot.firstMessage, bot.firstMessageTruncated),
            bot.alternateGreetings > 0
                ? el('p', { className: 'stb-muted', text: t('detail.alternateGreetings', { count: bot.alternateGreetings }) })
                : null,
        );
    }

    /**
     * @param {string} title
     * @param {string} text
     * @param {boolean} [truncated]
     * @returns {HTMLElement|null}
     */
    function section(title, text, truncated) {
        if (!text) return null;
        return el('section', {
            className: 'stb-section',
            children: [
                el('h3', { className: 'stb-section-title', children: [icon('fa-align-left'), el('span', { text: title })] }),
                el('p', { className: 'stb-section-text', text }),
                truncated ? el('p', { className: 'stb-muted', text: t('detail.truncated') }) : null,
            ].filter(Boolean),
        });
    }

    /**
     * @param {'bookmark'|'like'} kind
     * @param {boolean} on
     */
    async function toggle(kind, on) {
        const before = { liked: bot.liked, likes: bot.likes, bookmarked: bot.bookmarked, bookmarks: bot.bookmarks };
        bot = {
            ...bot,
            ...(kind === 'like'
                ? { liked: on, likes: Math.max(0, bot.likes + (on ? 1 : -1)) }
                : { bookmarked: on, bookmarks: Math.max(0, (bot.bookmarks || 0) + (on ? 1 : -1)) }),
        };
        paint();
        try {
            const state = await api.toggle(bot.id, kind, on, controller.signal);
            bot = { ...bot, ...state };
            paint();
        } catch (error) {
            bot = { ...bot, ...before };
            paint();
            if (!(error instanceof ApiError && error.code === ERROR_CODES.ABORTED)) {
                toast('error', describeError(error), t('error.title'));
            }
        }
    }

    async function load() {
        paintLoading();
        try {
            bot = await api.bot(summary.id, controller.signal);
            paint();
        } catch (error) {
            if (error instanceof ApiError && error.code === ERROR_CODES.ABORTED) return;
            // Fall back to what the grid already knew, so the view is never blank.
            if (summary && summary.name) {
                bot = { ...summary, description: '', firstMessage: '', alternateGreetings: 0, lorebookEntryCount: 0, imageUrl: null, cardVersion: summary.cardVersion || '' };
                paint();
                toast('warning', describeError(error), t('error.title'));
            } else {
                paintError(error);
            }
        }
    }

    function destroy() {
        try { controller.abort(); } catch { /* ignore */ }
    }

    void load();
    requestAnimationFrame(() => back.focus({ preventScroll: true }));

    return { element: root, destroy };
}
