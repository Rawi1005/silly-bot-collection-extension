#!/usr/bin/env node
/**
 * Mock implementation of API_CONTRACT.md, Node built-ins only.
 *
 *   node dev/mock-server.mjs [--port 8790] [--host 127.0.0.1] [--latency 250]
 *
 * Base URL for the extension: http://localhost:<port>/api/v1
 * Test keys are printed on start (see dev/fixtures.mjs KEYS).
 *
 * Besides the contract it serves, for development only:
 *   GET  /settings                    a stand-in for the site's settings page (lists test keys)
 *   GET  /img/<id>.png[?exp=&sig=]    thumbnails (NSFW ones need a signed URL, like production)
 *   GET  /ext/<path>                  the extension folder itself, so dev/harness.html can load it
 *   POST /api/characters/import       a fake SillyTavern import route, used by the harness only
 *   POST /api/characters/all          fake SillyTavern character list, used by the harness only
 *
 * Special behaviour for testing:
 *   GET /api/v1/search?q=ratelimit   the first call per key answers 429 Retry-After: 1
 *   GET /api/v1/search?q=servererror always answers 500
 */

import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, USERS, buildBots, cardFor, makeCardPng, makePortraitPng } from './fixtures.mjs';
import { readCardFromPng } from '../src/png.js';

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGNING_SECRET = randomBytes(16).toString('hex');
const SIGNED_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;

const CORS_HEADERS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    Vary: 'Origin',
    'Access-Control-Expose-Headers': 'Content-Disposition, X-Card-Version, Retry-After',
});

const PREFLIGHT_HEADERS = Object.freeze({
    ...CORS_HEADERS,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
});

const STATIC_TYPES = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.md': 'text/plain; charset=utf-8',
});

/**
 * Creates the server. Exported so tests can run it on an ephemeral port.
 * @param {{latencyMs?: number}} [options]
 * @returns {http.Server}
 */
export function createMockServer({ latencyMs = 0 } = {}) {
    const bots = buildBots();
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    /** Per-key state: bookmarks/likes (ordered, newest last), downloads already counted. */
    const state = new Map();
    const rateLimitedOnce = new Set();
    /** Fake SillyTavern character list for the harness. */
    const stCharacters = [];

    const imageCache = new Map();
    const cardCache = new Map();

    function userState(key) {
        if (!state.has(key)) {
            state.set(key, { bookmarks: ['kaito', 'mali'], likes: ['araya'], downloaded: new Set() });
        }
        return state.get(key);
    }

    function origin(req) {
        return `http://${req.headers.host || 'localhost'}`;
    }

    function sign(id, exp) {
        return createHmac('sha256', SIGNING_SECRET).update(`${id}:${exp}`).digest('base64url').slice(0, 22);
    }

    function thumbnailUrl(req, bot) {
        const base = `${origin(req)}/img/${encodeURIComponent(bot.id)}.png`;
        if (bot.rating !== 'nsfw') return base;
        const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
        return `${base}?exp=${exp}&sig=${sign(bot.id, exp)}`;
    }

    function likesCount(bot) {
        let extra = 0;
        for (const s of state.values()) if (s.likes.includes(bot.id)) extra += 1;
        return bot.likes + extra;
    }

    function bookmarksCount(bot) {
        let n = 0;
        for (const s of state.values()) if (s.bookmarks.includes(bot.id)) n += 1;
        return n;
    }

    function summary(req, bot, user, key) {
        const s = userState(key);
        const hidden = bot.rating === 'nsfw' && !user.nsfw;
        return {
            id: bot.id,
            name: bot.name,
            tagline: hidden ? '' : bot.tagline,
            tags: bot.tags,
            rating: bot.rating,
            thumbnailUrl: hidden ? null : thumbnailUrl(req, bot),
            creator: { name: bot.creator.name, username: bot.creator.username ?? null, image: null },
            downloads: bot.downloads,
            likes: likesCount(bot),
            bookmarked: s.bookmarks.includes(bot.id),
            liked: s.likes.includes(bot.id),
            hasLorebook: Boolean(bot.book),
            cardVersion: bot.version,
            updatedAt: bot.updatedAt,
            url: `${origin(req)}/bots/${encodeURIComponent(bot.id)}`,
        };
    }

    function detail(req, bot, user, key) {
        return {
            ...summary(req, bot, user, key),
            description: bot.description,
            firstMessage: bot.firstMessage,
            alternateGreetings: bot.alternateGreetings,
            cardSpec: 'chara_card_v2',
            lorebookEntryCount: bot.book ? bot.book.entries.length : 0,
            imageUrl: thumbnailUrl(req, bot),
        };
    }

    // ---- response helpers -------------------------------------------------

    function send(res, status, headers, body) {
        res.writeHead(status, headers);
        res.end(body);
    }

    function json(res, status, body, extra = {}) {
        send(res, status, {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'private, no-store',
            ...extra,
        }, JSON.stringify(body));
    }

    function apiError(res, status, code, message, extra = {}) {
        json(res, status, { error: { code, message } }, extra);
    }

    // ---- pagination -------------------------------------------------------

    function encodeCursor(scope, offset) {
        return Buffer.from(JSON.stringify({ s: scope, o: offset })).toString('base64url');
    }

    function decodeCursor(cursor, scope) {
        if (!cursor) return 0;
        try {
            const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
            if (value.s === scope && Number.isInteger(value.o) && value.o >= 0) return value.o;
        } catch { /* fall through */ }
        return -1;
    }

    function page(req, res, url, list, scope, user, key) {
        const raw = Number.parseInt(url.searchParams.get('limit') || '', 10);
        const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT;
        const offset = decodeCursor(url.searchParams.get('cursor'), scope);
        if (offset < 0) return apiError(res, 400, 'BAD_CURSOR', 'Cursor is not valid for this list.');
        const slice = list.slice(offset, offset + limit);
        const next = offset + limit < list.length ? encodeCursor(scope, offset + limit) : null;
        return json(res, 200, { items: slice.map((bot) => summary(req, bot, user, key)), nextCursor: next });
    }

    // ---- /api/v1 ----------------------------------------------------------

    function authenticate(req) {
        const header = String(req.headers.authorization || '');
        const match = /^Bearer\s+(\S+)$/i.exec(header);
        if (!match) return null;
        const key = match[1];
        const user = USERS[key];
        return user ? { key, user } : null;
    }

    function visible(user) {
        return bots.filter((bot) => user.nsfw || bot.rating === 'sfw');
    }

    async function handleApi(req, res, url) {
        if (req.method === 'OPTIONS') return send(res, 204, PREFLIGHT_HEADERS, '');
        if (req.headers.cookie) console.warn('[mock] a request arrived with a Cookie header; the extension must not send cookies');

        const auth = authenticate(req);
        if (!auth) return apiError(res, 401, 'INVALID_KEY', 'Missing, unknown or revoked access key.');
        const { key, user } = auth;
        const route = url.pathname.slice('/api/v1'.length) || '/';
        const s = userState(key);

        if (req.method === 'GET' && route === '/me') {
            return json(res, 200, {
                user: { id: user.id, username: user.username, displayName: user.displayName, image: null },
                access: { verified: user.verified, nsfw: user.nsfw },
                key: { name: user.keyName, scopes: ['read', 'download'], createdAt: '2026-11-01T08:00:00Z' },
            });
        }

        if (req.method === 'GET' && route === '/feed') {
            const list = visible(user).filter((bot) => !s.likes.includes(bot.id))
                .sort((a, b) => b.likes - a.likes);
            return page(req, res, url, list, 'feed', user, key);
        }

        if (req.method === 'GET' && route === '/bots') {
            const sort = url.searchParams.get('sort') || 'latest';
            const rating = url.searchParams.get('rating') || 'sfw';
            const tag = (url.searchParams.get('tag') || '').toLowerCase();
            if (!['latest', 'popular', 'trending'].includes(sort)) return apiError(res, 400, 'BAD_REQUEST', 'Unknown sort.');
            if (!['sfw', 'nsfw', 'all'].includes(rating)) return apiError(res, 400, 'BAD_REQUEST', 'Unknown rating.');
            if (rating !== 'sfw' && !user.nsfw) return apiError(res, 403, 'NSFW_REQUIRED', 'NSFW role required.');
            let list = bots.filter((bot) => rating === 'all' || bot.rating === rating);
            if (tag) list = list.filter((bot) => bot.tags.some((t) => t.toLowerCase() === tag));
            const score = {
                latest: (bot) => Date.parse(bot.updatedAt),
                popular: (bot) => bot.downloads,
                trending: (bot) => likesCount(bot) * 3 + bot.downloads / 10,
            }[sort];
            list = [...list].sort((a, b) => score(b) - score(a));
            return page(req, res, url, list, `bots:${sort}:${rating}:${tag}`, user, key);
        }

        if (req.method === 'GET' && route === '/search') {
            const q = (url.searchParams.get('q') || '').trim();
            if (!q || q.length > 64) return apiError(res, 400, 'BAD_REQUEST', 'q must be 1..64 characters.');
            if (q === 'servererror') return apiError(res, 500, 'SERVER_ERROR', 'Simulated failure.');
            if (q === 'ratelimit' && !rateLimitedOnce.has(key)) {
                rateLimitedOnce.add(key);
                return apiError(res, 429, 'RATE_LIMITED', 'Slow down.', { 'Retry-After': '1' });
            }
            const needle = q.toLowerCase();
            const list = visible(user).filter((bot) => [bot.name, bot.tagline, bot.creator.name, ...bot.tags]
                .some((field) => String(field).toLowerCase().includes(needle)));
            return page(req, res, url, list, `search:${needle}`, user, key);
        }

        if (req.method === 'GET' && (route === '/bookmarks' || route === '/likes')) {
            const ids = route === '/bookmarks' ? s.bookmarks : s.likes;
            const list = [...ids].reverse().map((id) => byId.get(id)).filter(Boolean);
            return page(req, res, url, list, route.slice(1), user, key);
        }

        const match = /^\/bots\/([^/]+)(?:\/(bookmark|like|card|lorebook))?$/.exec(route);
        if (!match) return apiError(res, 404, 'NOT_FOUND', 'No such endpoint.');
        const bot = byId.get(decodeURIComponent(match[1]));
        const sub = match[2] || '';
        if (!bot) return apiError(res, 404, 'NOT_FOUND', 'No such bot.');
        const nsfwBlocked = bot.rating === 'nsfw' && !user.nsfw;

        if (!sub && req.method === 'GET') {
            if (nsfwBlocked) return apiError(res, 403, 'NSFW_REQUIRED', 'NSFW role required.');
            return json(res, 200, detail(req, bot, user, key));
        }

        if ((sub === 'bookmark' || sub === 'like') && (req.method === 'PUT' || req.method === 'DELETE')) {
            if (nsfwBlocked) return apiError(res, 403, 'NSFW_REQUIRED', 'NSFW role required.');
            const list = sub === 'bookmark' ? s.bookmarks : s.likes;
            const index = list.indexOf(bot.id);
            if (req.method === 'PUT' && index < 0) list.push(bot.id);
            if (req.method === 'DELETE' && index >= 0) list.splice(index, 1);
            return json(res, 200, {
                bookmarked: s.bookmarks.includes(bot.id),
                bookmarks: bookmarksCount(bot),
                liked: s.likes.includes(bot.id),
                likes: likesCount(bot),
            });
        }

        if ((sub === 'card' || sub === 'lorebook') && req.method === 'GET') {
            if (!user.verified) return apiError(res, 403, 'NOT_VERIFIED', 'Get the verified role on Discord to download cards.');
            if (nsfwBlocked) return apiError(res, 403, 'NSFW_REQUIRED', 'NSFW role required.');
            if (sub === 'lorebook') {
                if (!bot.book) return apiError(res, 404, 'NOT_FOUND', 'This bot has no lorebook.');
                return json(res, 200, bot.book);
            }
            if (!cardCache.has(bot.id)) {
                cardCache.set(bot.id, Buffer.from(makeCardPng(cardFor(bot), { from: bot.colour[0], to: bot.colour[1], width: 240, height: 360 })));
            }
            if (!s.downloaded.has(bot.id)) {
                s.downloaded.add(bot.id);
                bot.downloads += 1;
            }
            const safe = (bot.id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'card') + '.png';
            return send(res, 200, {
                ...CORS_HEADERS,
                'Content-Type': 'image/png',
                'Content-Disposition': `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
                'X-Card-Version': bot.version,
                'Cache-Control': 'no-store',
            }, cardCache.get(bot.id));
        }

        return apiError(res, 404, 'NOT_FOUND', 'No such endpoint.');
    }

    // ---- images -----------------------------------------------------------

    function handleImage(req, res, url) {
        const id = decodeURIComponent(url.pathname.slice('/img/'.length).replace(/\.png$/, ''));
        const bot = byId.get(id);
        if (!bot) return send(res, 404, CORS_HEADERS, 'not found');
        if (bot.rating === 'nsfw') {
            const exp = Number(url.searchParams.get('exp'));
            const sig = url.searchParams.get('sig') || '';
            if (!Number.isFinite(exp) || exp < Date.now() / 1000 || sig !== sign(bot.id, exp)) {
                return send(res, 403, CORS_HEADERS, 'bad or expired signature');
            }
        }
        if (!imageCache.has(id)) {
            imageCache.set(id, Buffer.from(makePortraitPng({ from: bot.colour[0], to: bot.colour[1] })));
        }
        return send(res, 200, { ...CORS_HEADERS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' }, imageCache.get(id));
    }

    // ---- dev-only extras ---------------------------------------------------

    async function handleStatic(req, res, url) {
        const relative = decodeURIComponent(url.pathname.slice('/ext/'.length)) || 'dev/harness.html';
        const resolved = path.resolve(EXTENSION_ROOT, relative);
        if (!resolved.startsWith(EXTENSION_ROOT + path.sep) || relative.split(/[\\/]/).some((p) => p.startsWith('.'))) {
            return send(res, 403, {}, 'forbidden');
        }
        try {
            const info = await stat(resolved);
            if (!info.isFile()) throw new Error('not a file');
            const body = await readFile(resolved);
            return send(res, 200, { 'Content-Type': STATIC_TYPES[path.extname(resolved)] || 'application/octet-stream', 'Cache-Control': 'no-store' }, body);
        } catch {
            return send(res, 404, {}, 'not found');
        }
    }

    function settingsPage(res) {
        const rows = Object.entries(KEYS).map(([name, value]) => `<tr><td>${name}</td><td><code>${value}</code></td></tr>`).join('');
        send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, `<!doctype html><meta charset="utf-8"><title>Mock settings</title>
<body style="font-family:sans-serif;max-width:720px;margin:40px auto">
<h1>Mock site settings</h1><p>This stands in for https://bots.rolezy.com/settings. Copy a test key:</p>
<table border="1" cellpadding="6">${rows}</table></body>`);
    }

    function readBody(req, max = 20 * 1024 * 1024) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > max) { reject(new Error('too large')); req.destroy(); return; }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        });
    }

    /** Minimal multipart/form-data parser: returns { fields, files }. */
    function parseMultipart(body, contentType) {
        const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
        if (!boundaryMatch) return null;
        const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
        const fields = {};
        const files = {};
        let start = body.indexOf(boundary);
        while (start >= 0) {
            const next = body.indexOf(boundary, start + boundary.length);
            if (next < 0) break;
            const part = body.subarray(start + boundary.length + 2, next - 2);
            const split = part.indexOf('\r\n\r\n');
            if (split >= 0) {
                const head = part.subarray(0, split).toString('utf8');
                const content = part.subarray(split + 4);
                const name = /name="([^"]*)"/i.exec(head)?.[1];
                const filename = /filename="([^"]*)"/i.exec(head)?.[1];
                if (name && filename !== undefined) files[name] = { filename, content };
                else if (name) fields[name] = content.toString('utf8');
            }
            start = next;
        }
        return { fields, files };
    }

    async function handleFakeStImport(req, res) {
        // The real route checks a CSRF token; the harness sends one and we require it to catch header bugs.
        if (!req.headers['x-csrf-token']) return send(res, 403, {}, 'missing X-CSRF-Token');
        if (/application\/json/i.test(String(req.headers['content-type']))) {
            return send(res, 400, {}, 'Content-Type was application/json; multipart boundary missing');
        }
        const body = await readBody(req);
        const form = parseMultipart(body, req.headers['content-type']);
        const file = form?.files.avatar;
        if (!form || !file || form.fields.file_type !== 'png') return send(res, 400, {}, 'bad form');
        const card = readCardFromPng(new Uint8Array(file.content));
        if (!card) return json(res, 200, { error: true });
        const name = String(card.data?.name || card.name || 'Unnamed').replace(/[/?<>\\:*|"\x00-\x1f]/g, '').trim() || 'Unnamed';
        let fileName = form.fields.preserved_name ? form.fields.preserved_name.replace(/\.png$/i, '') : name;
        if (!form.fields.preserved_name) {
            let i = 0;
            while (stCharacters.some((c) => c.avatar === `${fileName}.png`)) { i += 1; fileName = `${name}${i}`; }
        }
        const avatar = `${fileName}.png`;
        const entry = { name, avatar, tags: card.data?.tags || [], data: card.data || {} };
        const existing = stCharacters.findIndex((c) => c.avatar === avatar);
        if (existing >= 0) stCharacters[existing] = entry; else stCharacters.push(entry);
        return json(res, 200, { file_name: fileName });
    }

    return http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        try {
            if (latencyMs && url.pathname.startsWith('/api/v1')) await new Promise((r) => setTimeout(r, latencyMs));
            if (url.pathname.startsWith('/api/v1/') || url.pathname === '/api/v1') return await handleApi(req, res, url);
            if (req.method === 'GET' && url.pathname.startsWith('/img/')) return handleImage(req, res, url);
            if (req.method === 'GET' && (url.pathname === '/settings' || url.pathname === '/')) return settingsPage(res);
            if (req.method === 'GET' && url.pathname.startsWith('/ext/')) return await handleStatic(req, res, url);
            if (req.method === 'POST' && url.pathname === '/api/characters/import') return await handleFakeStImport(req, res);
            if (req.method === 'POST' && url.pathname === '/api/characters/all') return json(res, 200, stCharacters);
            return send(res, 404, {}, 'not found');
        } catch (error) {
            console.error('[mock] handler failed', error);
            if (!res.headersSent) apiError(res, 500, 'SERVER_ERROR', 'Mock server error.');
            else res.end();
        }
    });
}

function argValue(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(argValue('port', process.env.PORT || 8790));
    const host = argValue('host', process.env.HOST || '127.0.0.1');
    const latencyMs = Number(argValue('latency', process.env.MOCK_LATENCY_MS || 250));
    if (port === 3000) {
        console.error('Refusing port 3000 (reserved for the site dev server). Pick another with --port.');
        process.exit(1);
    }
    const server = createMockServer({ latencyMs });
    server.listen(port, host, () => {
        const shown = host === '127.0.0.1' ? 'localhost' : host;
        console.log(`Mock Silly Bot Collection API on http://${shown}:${port}`);
        console.log(`  Base URL for the extension: http://${shown}:${port}/api/v1`);
        console.log(`  Dev harness:                http://${shown}:${port}/ext/dev/harness.html`);
        console.log('  Test keys:');
        for (const [name, value] of Object.entries(KEYS)) console.log(`    ${name.padEnd(10)} ${value}`);
    });
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
