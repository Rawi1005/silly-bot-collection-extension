/**
 * The import confirmation, built as DOM and shown through SillyTavern's own
 * Popup so it inherits the theme, focus trap and Escape handling.
 *
 * One dialog covers both cases:
 * - first import: [Import] [Cancel]
 * - already imported: [Update existing] [Import as a copy] [Cancel]
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';
import { openPopup, popupResults } from '../st.js';

/**
 * @param {object} options
 * @param {{name: string, hasLorebook?: boolean, lorebookEntryCount?: number}} options.bot
 * @param {'none'|'imported'|'update'} options.status
 * @param {boolean} options.lorebookSupported
 * @returns {Promise<'new'|'update'|'cancel'>}
 */
export async function confirmImport({ bot, status, lorebookSupported }) {
    const already = status !== 'none';

    const list = el('ul', { className: 'stb-confirm-list' });
    list.appendChild(el('li', { text: t('import.item.character', { name: bot.name }) }));
    if (bot.hasLorebook) {
        const count = Number(bot.lorebookEntryCount) || 0;
        list.appendChild(el('li', {
            text: count > 0 ? t('import.item.lorebookCount', { count }) : t('import.item.lorebook'),
        }));
        if (!lorebookSupported) {
            list.appendChild(el('li', { className: 'stb-warn', text: t('import.item.lorebookUnsupported') }));
        }
    } else {
        list.appendChild(el('li', { className: 'stb-muted', text: t('import.item.noLorebook') }));
    }

    const content = el('div', {
        className: 'stb-confirm',
        children: [
            el('h3', { className: 'stb-confirm-title', text: t('import.confirmTitle', { name: bot.name }) }),
            el('p', { className: 'stb-confirm-body', text: t('import.confirmBody') }),
            list,
            already
                ? el('p', {
                    className: 'stb-confirm-note',
                    text: status === 'update' ? t('duplicate.bodyUpdate') : t('duplicate.body'),
                })
                : null,
        ],
    });

    const R = popupResults();
    const options = already
        ? {
            okButton: t('duplicate.replace'),
            cancelButton: t('common.cancel'),
            customButtons: [{ text: t('duplicate.keepBoth'), result: R.CUSTOM1, classes: ['stb-popup-secondary'] }],
            leftAlign: true,
        }
        : {
            okButton: t('import.confirmButton'),
            cancelButton: t('common.cancel'),
            leftAlign: true,
        };

    const opened = openPopup(content, 'CONFIRM', options);
    // No Popup means no way to ask; never import without a yes.
    if (!opened) return 'cancel';
    const result = await opened.promise;
    if (result === R.AFFIRMATIVE) return already ? 'update' : 'new';
    if (already && result === R.CUSTOM1) return 'new';
    return 'cancel';
}
