import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { importBot, uploadHeaders, sanitizeWorldName, pickWorldName, uploadCard, checkSupport, openCharacter, IMPORT_ERROR } from '../src/importer.js';
import { makeCardPng, makePortraitPng, buildBots, cardFor } from '../dev/fixtures.mjs';

const bots = buildBots();
const byId = (id) => bots.find((b) => b.id === id);

/** A fake SillyTavern context with the members the importer uses. */
function fakeContext({ worldNames = [], lorebookApi = true } = {}) {
    const ctx = {
        characters: [{ avatar: 'Existing.png', name: 'Existing' }],
        name1: 'User',
        extensionSettings: {},
        saveSettingsDebounced() {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' }),
        getCharacters: async () => { ctx.characters.splice(0, ctx.characters.length, ...ctx.serverList); },
        serverList: [{ avatar: 'Existing.png', name: 'Existing' }],
        selected: null,
        selectCharacterById: async (i) => { ctx.selected = i; },
        Popup: function Popup() {},
        POPUP_TYPE: {},
        POPUP_RESULT: {},
        worlds: new Map(worldNames.map((n) => [n, {}])),
        writes: [],
        tagCalls: 0,
        importTags: async () => { ctx.tagCalls += 1; },
    };
    if (lorebookApi) {
        Object.assign(ctx, {
            convertCharacterBook: (book) => {
                book.entries.forEach((e, i) => { e.id ??= i; });
                return { entries: Object.fromEntries(book.entries.map((e) => [e.id, { key: e.keys, content: e.content }])), originalData: book };
            },
            saveWorldInfo: async (name, data, immediately) => { assert.equal(immediately, true); ctx.worlds.set(name, data); },
            updateWorldInfoList: async () => {},
            getWorldInfoNames: () => [...ctx.worlds.keys()],
            writeExtensionField: async (chid, key, value) => { ctx.writes.push([chid, key, value]); },
        });
    }
    return ctx;
}

function fakeApi(bot, { cardBytes, lorebookError = false } = {}) {
    const calls = { card: 0, lorebook: 0 };
    return {
        calls,
        async card(id) {
            calls.card += 1;
            assert.equal(id, bot.id);
            const bytes = cardBytes ?? makeCardPng(cardFor(bot), { width: 8, height: 12 });
            return { blob: new Blob([bytes], { type: 'image/png' }), fileName: `${bot.id}.png`, cardVersion: bot.version };
        },
        async lorebook() {
            calls.lorebook += 1;
            if (lorebookError) throw new Error('404');
            return structuredClone(bot.book);
        },
    };
}

/** Fake fetch for SillyTavern's /api/characters/import. */
function fakeStFetch(ctx, { reply } = {}) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push({ url, init });
        if (url !== '/api/characters/import') return new Response('', { status: 200 });
        const form = init.body;
        assert.ok(form instanceof FormData);
        const file = form.get('avatar');
        assert.equal(form.get('file_type'), 'png');
        const preserved = form.get('preserved_name');
        if (reply) return reply(form);
        const name = preserved ? String(preserved).replace(/\.png$/, '') : `${file.name.replace(/\.png$/, '')}_imported`;
        if (!ctx.serverList.some((c) => c.avatar === `${name}.png`)) ctx.serverList.push({ avatar: `${name}.png`, name, tags: ['x'] });
        return new Response(JSON.stringify({ file_name: name }), { status: 200 });
    };
    return { requests, fetchImpl };
}

beforeEach(() => { delete globalThis.SillyTavern; });

function install(ctx) {
    globalThis.SillyTavern = { getContext: () => ctx };
}

test('upload headers keep CSRF and drop Content-Type in any casing', () => {
    assert.deepEqual(uploadHeaders({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' }) }), { 'X-CSRF-Token': 't' });
    assert.deepEqual(uploadHeaders({ getRequestHeaders: () => ({ 'content-type': 'x', 'X-CSRF-Token': 't' }) }), { 'X-CSRF-Token': 't' });
});

test('world names are sanitised like sanitize-filename and never clobber a user lorebook', () => {
    assert.equal(sanitizeWorldName('A/B:C*D?"E<F>G|H\\I'), 'ABCDEFGHI');
    assert.equal(sanitizeWorldName('Trailing dots...  '), 'Trailing dots');
    assert.equal(sanitizeWorldName('con'), '');
    assert.equal(sanitizeWorldName('..'), '');
    assert.deepEqual(pickWorldName({ wanted: 'Lore', fallback: 'x', existing: [] }), { name: 'Lore', overwrite: false });
    assert.deepEqual(pickWorldName({ wanted: 'Lore', fallback: 'x', existing: ['lore', 'Lore (2)'] }), { name: 'Lore (3)', overwrite: false });
    assert.deepEqual(pickWorldName({ wanted: '///', fallback: "Bob's Lorebook", existing: [] }), { name: "Bob's Lorebook", overwrite: false });
    assert.deepEqual(pickWorldName({ wanted: 'Lore', fallback: 'x', existing: ['Lore'], ownName: 'Lore' }), { name: 'Lore', overwrite: true });
});

test('support check reports missing members instead of throwing', () => {
    assert.deepEqual(checkSupport(), { ok: false, missing: ['SillyTavern.getContext'], lorebook: false });
    install({ getRequestHeaders() {} });
    const support = checkSupport();
    assert.equal(support.ok, false);
    assert.ok(support.missing.includes('getCharacters'));
});

test('full import: card uploaded as multipart, list refreshed, embedded lorebook saved and linked', async () => {
    const ctx = fakeContext();
    install(ctx);
    const st = fakeStFetch(ctx);
    const api = fakeApi(byId('araya'));
    const result = await importBot({ api, bot: byId('araya'), fetchImpl: st.fetchImpl });

    assert.equal(st.requests.length, 1);
    const { init } = st.requests[0];
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'X-CSRF-Token': 'tok' });
    assert.equal(init.body.get('user_name'), 'User');
    assert.equal(init.body.get('avatar').type, 'image/png');
    assert.equal(init.body.has('preserved_name'), false);

    assert.equal(result.avatar, 'araya_imported.png');
    assert.equal(result.chid, 1);
    assert.equal(result.cardVersion, '3');
    assert.equal(result.lorebookName, "Araya's Archive");
    assert.equal(result.lorebookError, false);
    assert.equal(api.calls.lorebook, 0, 'embedded book means no fallback request');
    assert.equal(Object.keys(ctx.worlds.get("Araya's Archive").entries).length, 2);
    assert.deepEqual(ctx.writes, [[1, 'world', "Araya's Archive"]]);
    assert.equal(ctx.tagCalls, 1);
    assert.equal(ctx.selected, null, 'import does not switch the chat by itself');

    assert.equal(await openCharacter(result.avatar), true);
    assert.equal(ctx.selected, 1);
});

test('fallback: hasLorebook without embedded book fetches /lorebook', async () => {
    const ctx = fakeContext();
    install(ctx);
    const st = fakeStFetch(ctx);
    const bot = byId('scrapbot');
    const api = fakeApi(bot);
    const result = await importBot({ api, bot: { ...bot, hasLorebook: true }, fetchImpl: st.fetchImpl });
    assert.equal(api.calls.lorebook, 1);
    assert.equal(result.lorebookName, 'Scrapyard Lore');
});

test('lorebook failure keeps the character and flags the error', async () => {
    const ctx = fakeContext();
    install(ctx);
    const st = fakeStFetch(ctx);
    const bot = byId('scrapbot');
    const result = await importBot({ api: fakeApi(bot, { lorebookError: true }), bot: { ...bot, hasLorebook: true }, fetchImpl: st.fetchImpl });
    assert.equal(result.lorebookName, null);
    assert.equal(result.lorebookError, true);
    assert.equal(result.chid, 1);
});

test('missing world-info API: character still imports, lorebook flagged', async () => {
    const ctx = fakeContext({ lorebookApi: false });
    install(ctx);
    const st = fakeStFetch(ctx);
    const result = await importBot({ api: fakeApi(byId('araya')), bot: byId('araya'), fetchImpl: st.fetchImpl });
    assert.equal(result.lorebookName, null);
    assert.equal(result.lorebookError, true);
});

test('name clash with a user lorebook picks a new name; update mode overwrites our own', async () => {
    const ctx = fakeContext({ worldNames: ["Araya's Archive"] });
    install(ctx);
    const st = fakeStFetch(ctx);
    const first = await importBot({ api: fakeApi(byId('araya')), bot: byId('araya'), fetchImpl: st.fetchImpl });
    assert.equal(first.lorebookName, "Araya's Archive (2)");

    const second = await importBot({
        api: fakeApi(byId('araya')),
        bot: byId('araya'),
        mode: 'update',
        record: { avatar: first.avatar, lorebook: first.lorebookName },
        fetchImpl: st.fetchImpl,
    });
    assert.equal(second.replaced, true);
    assert.equal(second.avatar, first.avatar);
    assert.equal(second.lorebookName, "Araya's Archive (2)");
    const uploads = st.requests.filter((r) => r.url === '/api/characters/import');
    assert.equal(uploads[1].init.body.get('preserved_name'), first.avatar);
});

test('update whose old character was deleted becomes a fresh import', async () => {
    const ctx = fakeContext();
    install(ctx);
    const st = fakeStFetch(ctx);
    const result = await importBot({ api: fakeApi(byId('kaito')), bot: byId('kaito'), mode: 'update', record: { avatar: 'Gone.png' }, fetchImpl: st.fetchImpl });
    assert.equal(result.replaced, false);
    assert.equal(st.requests[0].init.body.has('preserved_name'), false);
});

test('a download that is not a card is rejected before anything is uploaded', async () => {
    const ctx = fakeContext();
    install(ctx);
    const st = fakeStFetch(ctx);
    await assert.rejects(
        importBot({ api: fakeApi(byId('kaito'), { cardBytes: makePortraitPng({ width: 2, height: 2 }) }), bot: byId('kaito'), fetchImpl: st.fetchImpl }),
        (e) => e.code === IMPORT_ERROR.BAD_CARD,
    );
    assert.equal(st.requests.length, 0);
});

test('SillyTavern error replies map to SERVER_REJECTED; missing character to NOT_FOUND_AFTER_IMPORT', async () => {
    const ctx = fakeContext();
    install(ctx);
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    for (const reply of [() => new Response(JSON.stringify({ error: true })), () => new Response('', { status: 400 }), () => new Response('nope')]) {
        const { fetchImpl } = fakeStFetch(ctx, { reply });
        await assert.rejects(uploadCard(ctx, file, { fetchImpl }), (e) => e.code === IMPORT_ERROR.SERVER_REJECTED);
    }
    await assert.rejects(uploadCard(ctx, file, { fetchImpl: async () => { throw new TypeError('down'); } }), (e) => e.code === IMPORT_ERROR.UPLOAD_FAILED);

    const ghost = fakeStFetch(ctx, { reply: () => new Response(JSON.stringify({ file_name: 'Ghost' })) });
    await assert.rejects(importBot({ api: fakeApi(byId('kaito')), bot: byId('kaito'), fetchImpl: ghost.fetchImpl }), (e) => e.code === IMPORT_ERROR.NOT_FOUND_AFTER_IMPORT);
});
