/**
 * The portrait card used in every grid.
 *
 * Structure: one real <button> opens the detail view (so Enter/Space and
 * focus rings come for free), and the like/bookmark toggles sit beside it,
 * never nested inside another interactive element.
 *
 * NSFW blur is applied by CSS (`.stb-root.stb-blur-nsfw .stb-nsfw img`), so
 * flipping the setting does not re-render or refetch anything.
 */

import { el, button, icon, lazyImage, compactNumber } from '../dom.js';
import { t } from '../i18n.js';
import { IMPORT_STATUS } from '../state.js';

/**
 * @param {object} options
 * @param {any} options.bot A normalised BotSummary.
 * @param {'none'|'imported'|'update'} options.status
 * @param {(bot: any) => void} options.onOpen
 * @param {(bot: any, kind: 'bookmark'|'like', on: boolean) => void} options.onToggle
 * @returns {HTMLElement}
 */
export function botCard({ bot, status, onOpen, onToggle }) {
    const nsfw = bot.rating === 'nsfw';

    const thumb = lazyImage({ src: bot.thumbnailUrl, alt: '' });
    if (nsfw) thumb.classList.add('stb-nsfw');

    const badges = el('div', { className: 'stb-badges' });
    if (nsfw) badges.appendChild(el('span', { className: 'stb-badge stb-badge-nsfw', text: t('card.nsfw') }));
    if (status === IMPORT_STATUS.UPDATE) {
        badges.appendChild(el('span', { className: 'stb-badge stb-badge-update', text: t('card.updateAvailable') }));
    } else if (status === IMPORT_STATUS.IMPORTED) {
        badges.appendChild(el('span', { className: 'stb-badge stb-badge-imported', children: [icon('fa-check'), el('span', { text: t('card.imported') })] }));
    }
    if (bot.hasLorebook) {
        badges.appendChild(el('span', {
            className: 'stb-badge stb-badge-lore',
            attrs: { title: t('card.hasLorebook') },
            children: [icon('fa-book-atlas'), el('span', { className: 'stb-sr-only', text: t('card.hasLorebook') })],
        }));
    }
    thumb.appendChild(badges);

    const tags = el('div', { className: 'stb-card-tags' });
    for (const tag of bot.tags.slice(0, 3)) tags.appendChild(el('span', { className: 'stb-tag', text: tag }));

    const open = el('button', {
        className: 'stb-card-open',
        attrs: { type: 'button', 'aria-label': t('card.openAria', { name: bot.name }) },
        children: [
            thumb,
            el('span', {
                className: 'stb-card-text',
                children: [
                    el('span', { className: 'stb-card-name', text: bot.name }),
                    el('span', { className: 'stb-card-creator', text: t('card.by', { creator: bot.creator.name }) }),
                    bot.tagline ? el('span', { className: 'stb-card-tagline', text: bot.tagline }) : null,
                    tags,
                ],
            }),
        ],
        on: { click: () => onOpen(bot) },
    });

    const footer = el('div', {
        className: 'stb-card-footer',
        children: [
            el('span', {
                className: 'stb-stat',
                attrs: { title: t('card.downloads') },
                children: [icon('fa-download'), el('span', { text: compactNumber(bot.downloads) })],
            }),
            el('span', { className: 'stb-spacer' }),
            button({
                title: bot.liked ? t('card.unlike') : t('card.like'),
                iconName: 'fa-heart',
                label: compactNumber(bot.likes),
                className: ['stb-icon-btn', bot.liked ? 'stb-on' : ''],
                pressed: bot.liked,
                onClick: () => onToggle(bot, 'like', !bot.liked),
            }),
            button({
                title: bot.bookmarked ? t('card.unbookmark') : t('card.bookmark'),
                iconName: 'fa-bookmark',
                className: ['stb-icon-btn', bot.bookmarked ? 'stb-on' : ''],
                pressed: bot.bookmarked,
                onClick: () => onToggle(bot, 'bookmark', !bot.bookmarked),
            }),
        ],
    });

    return el('article', {
        className: ['stb-card', nsfw ? 'stb-card-nsfw' : ''],
        attrs: { 'data-bot-id': bot.id },
        children: [open, footer],
    });
}

/**
 * Re-renders one card in place, keeping keyboard focus on the same control.
 * @param {HTMLElement} container
 * @param {string} botId
 * @param {HTMLElement} replacement
 * @returns {boolean}
 */
export function replaceCard(container, botId, replacement) {
    const existing = container.querySelector(`[data-bot-id="${CSS.escape(botId)}"]`);
    if (!existing || !existing.parentNode) return false;
    const focused = /** @type {HTMLElement|null} */ (existing.contains(document.activeElement) ? document.activeElement : null);
    const focusIndex = focused ? [...existing.querySelectorAll('button')].indexOf(/** @type {any} */ (focused)) : -1;
    existing.parentNode.replaceChild(replacement, existing);
    if (focusIndex >= 0) /** @type {HTMLElement|undefined} */ (replacement.querySelectorAll('button')[focusIndex])?.focus();
    return true;
}
