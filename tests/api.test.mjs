import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ApiClient, ApiError, ERROR_CODES, Paginator, parseRetryAfter, safeImageUrl,
    normaliseBotSummary, normaliseList, parseFileName, safeFileName, statusToCode,
} from '../src/api.js';

const KEY = 'stb_unit_test_key_0123456789abcdefghij';
const BASE = 'https://bots.example.test/api/v1';

function jsonResponse(status, body, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function recorder(responses) {
    const calls = [];
    const queue = [...responses];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next(url, init) : next;
    };
    return { calls, fetchImpl };
}

function client(fetchImpl, sleeps = []) {
    return new ApiClient({ baseUrl: `${BASE}/`, getKey: () => KEY, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
}

const bot = (id, extra = {}) => ({
    id, name: `Bot ${id}`, tagline: 't', tags: ['a'], rating: 'sfw', thumbnailUrl: 'https://cdn.example.test/x.webp',
    creator: { name: 'C', username: null, image: null }, downloads: 1, likes: 2, bookmarked: false, liked: false,
    hasLorebook: false, updatedAt: '2026-11-01T00:00:00Z', url: 'https://bots.example.test/c/x', ...extra,
});

test('sends the key only in the Authorization header, never cookies or URL', async () => {
    const { calls, fetchImpl } = recorder([jsonResponse(200, { user: { id: 'u', displayName: 'U' }, access: { verified: true, nsfw: false }, key: {} })]);
    const me = await client(fetchImpl).me();
    assert.equal(me.user.displayName, 'U');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/me`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].init.credentials, 'omit');
    assert.ok(!calls[0].url.includes(KEY));
});

test('no key -> NO_KEY without any request', async () => {
    const { calls, fetchImpl } = recorder([]);
    const api = new ApiClient({ baseUrl: BASE, getKey: () => '', fetchImpl });
    await assert.rejects(api.feed(), (e) => e instanceof ApiError && e.code === ERROR_CODES.NO_KEY && e.isAuthFailure);
    assert.equal(calls.length, 0);
});

test('error mapping uses the body code, falls back to the status', async () => {
    const cases = [
        [401, { error: { code: 'INVALID_KEY', message: 'x' } }, 'INVALID_KEY'],
        [403, { error: { code: 'NOT_VERIFIED', message: 'x' } }, 'NOT_VERIFIED'],
        [403, { error: { code: 'NSFW_REQUIRED', message: 'x' } }, 'NSFW_REQUIRED'],
        [404, { error: { code: 'NOT_FOUND', message: 'x' } }, 'NOT_FOUND'],
        [400, { error: { code: 'BAD_CURSOR', message: 'x' } }, 'BAD_CURSOR'],
        [403, { error: { code: 'SOMETHING_NEW', message: 'x' } }, 'NOT_VERIFIED'],
        [418, 'not json', 'BAD_RESPONSE'],
    ];
    for (const [status, body, code] of cases) {
        const response = typeof body === 'string' ? new Response(body, { status }) : jsonResponse(status, body);
        const { fetchImpl } = recorder([response]);
        await assert.rejects(client(fetchImpl).bot('x'), (e) => e.code === code && e.status === status, `${status} -> ${code}`);
    }
    assert.equal(statusToCode(503), 'SERVER_ERROR');
});

test('network failure (including blocked CORS) -> NETWORK', async () => {
    const { fetchImpl } = recorder([new TypeError('Failed to fetch')]);
    await assert.rejects(client(fetchImpl).me(), (e) => e.code === ERROR_CODES.NETWORK);
});

test('429 is retried once after Retry-After seconds, then succeeds', async () => {
    const sleeps = [];
    const { calls, fetchImpl } = recorder([
        jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow' } }, { 'Retry-After': '3' }),
        jsonResponse(200, { items: [bot('a')], nextCursor: null }),
    ]);
    const page = await client(fetchImpl, sleeps).search({ q: 'x' });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [3000]);
    assert.equal(page.items[0].id, 'a');
});

test('429 twice gives RATE_LIMITED with retryAfter, and the wait is capped at 30 s', async () => {
    const sleeps = [];
    const { calls, fetchImpl } = recorder([
        jsonResponse(429, { error: { code: 'RATE_LIMITED', message: '' } }, { 'Retry-After': '90' }),
        jsonResponse(429, { error: { code: 'RATE_LIMITED', message: '' } }, { 'Retry-After': '90' }),
    ]);
    await assert.rejects(client(fetchImpl, sleeps).feed(), (e) => e.code === 'RATE_LIMITED' && e.retryAfter === 90);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [30000]);
});

test('5xx is retried for GET but not for PUT', async () => {
    let r = recorder([jsonResponse(502, {}), jsonResponse(200, { items: [], nextCursor: null })]);
    await client(r.fetchImpl).likes();
    assert.equal(r.calls.length, 2);

    r = recorder([jsonResponse(500, { error: { code: 'SERVER_ERROR', message: '' } })]);
    await assert.rejects(client(r.fetchImpl).toggle('a', 'like', true), (e) => e.code === 'SERVER_ERROR');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].init.method, 'PUT');
});

test('abortAll cancels in-flight requests as ABORTED', async () => {
    const fetchImpl = (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const api = client(fetchImpl);
    const pending = api.feed();
    api.abortAll();
    await assert.rejects(pending, (e) => e.code === ERROR_CODES.ABORTED);
});

test('query parameters are encoded, empty ones dropped', async () => {
    const { calls, fetchImpl } = recorder([jsonResponse(200, { items: [], nextCursor: null })]);
    await client(fetchImpl).bots({ sort: 'popular', rating: 'sfw', tag: 'slice of life', cursor: null, limit: 24 });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/v1/bots');
    assert.equal(url.searchParams.get('tag'), 'slice of life');
    assert.equal(url.searchParams.has('cursor'), false);
});

test('Paginator walks cursors, dedupes, and stops at nextCursor null', async () => {
    const pages = {
        '': { items: [bot('a'), bot('b')], nextCursor: 'c1' },
        c1: { items: [bot('b'), bot('c')], nextCursor: 'c2' },
        c2: { items: [bot('d')], nextCursor: null },
    };
    const seen = [];
    const pager = new Paginator(async ({ cursor, limit }) => {
        seen.push([cursor, limit]);
        return normaliseList(pages[cursor || ''], BASE);
    }, { limit: 2 });
    await pager.next();
    await pager.next();
    const last = await pager.next();
    assert.deepEqual(pager.items.map((i) => i.id), ['a', 'b', 'c', 'd']);
    assert.equal(last.done, true);
    const after = await pager.next();
    assert.deepEqual(after.added, []);
    assert.deepEqual(seen, [[null, 2], ['c1', 2], ['c2', 2]]);
    assert.equal(pager.patch('c', { liked: true }).liked, true);
});

test('Paginator collapses concurrent next() calls', async () => {
    let count = 0;
    const pager = new Paginator(async () => { count += 1; await new Promise((r) => setTimeout(r, 5)); return { items: [], nextCursor: 'x' }; });
    await Promise.all([pager.next(), pager.next(), pager.next()]);
    assert.equal(count, 1);
});

test('normalisers keep untrusted strings as data and drop unsafe URLs', () => {
    const out = normaliseBotSummary(bot('x', {
        name: '<img src=x onerror=alert(1)>',
        thumbnailUrl: 'javascript:alert(1)',
        url: 'http://evil.example/',
        tagline: 'y'.repeat(500),
        tags: ['ok', 5, 'z'.repeat(80)],
        rating: 'weird',
    }), BASE);
    assert.equal(out.name, '<img src=x onerror=alert(1)>');
    assert.equal(out.thumbnailUrl, null);
    assert.equal(out.url, null);
    assert.equal(out.tagline.length, 220);
    assert.deepEqual(out.tags, ['ok', 'z'.repeat(32)]);
    assert.equal(out.rating, 'sfw');
    assert.equal(normaliseBotSummary({ id: '', name: 'x' }, BASE), null);
    assert.throws(() => normaliseList({ nope: true }, BASE), (e) => e.code === 'BAD_RESPONSE');
});

test('safeImageUrl allows https anywhere and http only on the base host', () => {
    assert.equal(safeImageUrl('https://cdn.test/a.png', BASE), 'https://cdn.test/a.png');
    assert.equal(safeImageUrl('http://cdn.test/a.png', BASE), null);
    assert.equal(safeImageUrl('http://localhost:8790/img/a.png', 'http://localhost:8790/api/v1'), 'http://localhost:8790/img/a.png');
    assert.equal(safeImageUrl('data:image/png;base64,AAAA', BASE), null);
});

test('Retry-After parsing and file names', () => {
    assert.equal(parseRetryAfter('5'), 5);
    assert.equal(parseRetryAfter('abc'), null);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter('999'), 120);
    assert.equal(parseFileName('attachment; filename="a.png"; filename*=UTF-8\'\'%E0%B8%A1.png'), 'ม.png');
    assert.equal(parseFileName('attachment; filename="araya.png"'), 'araya.png');
    assert.equal(safeFileName('../../etc/passwd.png', 'id'), 'passwd.png');
    assert.equal(safeFileName('', 'abc/def'), 'bot_abc_def.png');
    assert.equal(safeFileName('ม.png', 'id'), 'bot_id.png');
});

test('card() returns blob, safe file name and X-Card-Version', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { calls, fetchImpl } = recorder([new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="araya.png"', 'X-Card-Version': '3' } })]);
    const card = await client(fetchImpl).card('araya');
    assert.equal(card.fileName, 'araya.png');
    assert.equal(card.cardVersion, '3');
    assert.equal((await card.blob.arrayBuffer()).byteLength, 4);
    assert.equal(calls[0].url, `${BASE}/bots/araya/card`);
});
