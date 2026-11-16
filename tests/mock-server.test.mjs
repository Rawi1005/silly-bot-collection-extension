import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../dev/mock-server.mjs';
import { KEYS } from '../dev/fixtures.mjs';
import { readCardFromPng } from '../src/png.js';
import { ApiClient } from '../src/api.js';

let server;
let base;

before(async () => {
    server = createMockServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const get = (path, key = KEYS.valid, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(init.headers || {}) } });

test('the real ApiClient works against the mock: me, lists, pagination, detail, card', async () => {
    const api = new ApiClient({ baseUrl: base, getKey: () => KEYS.valid });
    const me = await api.me();
    assert.deepEqual(me.access, { verified: true, nsfw: true });
    const first = await api.bots({ sort: 'latest', rating: 'all' });
    assert.equal(first.items.length, 24);
    assert.ok(first.nextCursor);
    const second = await api.bots({ sort: 'latest', rating: 'all', cursor: first.nextCursor });
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map((b) => b.id)).size, first.items.length + second.items.length);
    const detail = await api.bot('araya');
    assert.equal(detail.lorebookEntryCount, 2);
    const card = await api.card('araya');
    assert.equal(card.cardVersion, '3');
    assert.equal(card.fileName, 'araya.png');
    const parsed = readCardFromPng(new Uint8Array(await card.blob.arrayBuffer()));
    assert.equal(parsed.data.character_book.entries.length, 2);
});

test('CORS: every response and the preflight carry the contract headers', async () => {
    const pre = await fetch(`${base}/bots/araya/card`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8000', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
    const err = await get('/me', null);
    assert.equal(err.status, 401);
    assert.equal(err.headers.get('access-control-allow-origin'), '*');
    assert.match(err.headers.get('access-control-expose-headers'), /X-Card-Version/);
    assert.equal(err.headers.get('access-control-allow-credentials'), null);
});

test('keys: invalid -> 401, unverified cannot download, SFW-only cannot see NSFW', async () => {
    assert.deepEqual(await (await get('/me', KEYS.invalid)).json(), { error: { code: 'INVALID_KEY', message: 'Missing, unknown or revoked access key.' } });
    const unverified = await (await get('/me', KEYS.unverified)).json();
    assert.equal(unverified.access.verified, false);
    const blocked = await get('/bots/kaito/card', KEYS.unverified);
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'NOT_VERIFIED');
    assert.equal((await (await get('/bots?rating=all', KEYS.sfwOnly)).json()).error.code, 'NSFW_REQUIRED');
    assert.equal((await get('/bots/velvet', KEYS.sfwOnly)).status, 403);
    const feed = await (await get('/feed?limit=48', KEYS.sfwOnly)).json();
    assert.ok(feed.items.every((b) => b.rating === 'sfw'));
    const search = await (await get('/search?q=velvet', KEYS.sfwOnly)).json();
    assert.equal(search.items.length, 0);
});

test('toggles are idempotent and return all four fields', async () => {
    const put = async (m) => (await get('/bots/nyx/bookmark', KEYS.valid, { method: m })).json();
    const a = await put('PUT');
    const b = await put('PUT');
    assert.deepEqual(a, b);
    assert.deepEqual(Object.keys(a).sort(), ['bookmarked', 'bookmarks', 'liked', 'likes']);
    assert.equal(a.bookmarked, true);
    assert.equal((await put('DELETE')).bookmarked, false);
    assert.equal((await put('DELETE')).bookmarked, false);
});

test('errors: bad cursor, bad sort, missing q, lorebook 404, rate limit with Retry-After', async () => {
    assert.equal((await (await get('/feed?cursor=garbage')).json()).error.code, 'BAD_CURSOR');
    assert.equal((await (await get('/bots?sort=nope')).json()).error.code, 'BAD_REQUEST');
    assert.equal((await get('/search?q=')).status, 400);
    assert.equal((await get('/bots/kaito/lorebook')).status, 404);
    assert.equal((await (await get('/bots/scrapbot/lorebook')).json()).entries.length, 2);
    const limited = await get('/search?q=ratelimit', KEYS.sfwOnly);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
});

test('downloads count once per user per bot', async () => {
    const before = (await (await get('/bots/mali')).json()).downloads;
    await get('/bots/mali/card');
    await get('/bots/mali/card');
    const afterOne = (await (await get('/bots/mali')).json()).downloads;
    assert.equal(afterOne, before + 1);
});

test('NSFW thumbnails need a valid signature; SFW ones do not', async () => {
    const list = await (await get('/bots?rating=nsfw')).json();
    const signed = list.items[0].thumbnailUrl;
    assert.match(signed, /sig=/);
    assert.equal((await fetch(signed)).status, 200);
    assert.equal((await fetch(signed.replace(/sig=[^&]+/, 'sig=forged'))).status, 403);
    const sfw = (await (await get('/bots/kaito')).json()).thumbnailUrl;
    const img = await fetch(sfw);
    assert.equal(img.headers.get('content-type'), 'image/png');
});

test('static file serving refuses path traversal', async () => {
    const origin = base.replace('/api/v1', '');
    assert.equal((await fetch(`${origin}/ext/manifest.json`)).status, 200);
    assert.notEqual((await fetch(`${origin}/ext/..%2F..%2Fpackage.json`)).status, 200);
    assert.notEqual((await fetch(`${origin}/ext/.gitignore`)).status, 200);
});
