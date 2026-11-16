/**
 * Fixture data and the PNG generator for the mock server. Node built-ins only.
 *
 * `makePortraitPng` writes a real, decodable PNG (IHDR + zlib IDAT + IEND).
 * `makeCardPng` embeds a V2 card as a `chara` tEXt chunk using the same
 * writer the extension uses to read cards (src/png.js), which is also what
 * SillyTavern reads (src/character-card-parser.js).
 */

import { deflateSync } from 'node:zlib';
import { writeChunks, writeCardToPng } from '../src/png.js';

/** Access keys accepted by the mock. Each is `stb_` + at least 32 characters. */
export const KEYS = Object.freeze({
    valid: 'stb_mock_full_access_0123456789abcdef',
    sfwOnly: 'stb_mock_sfw_only_0123456789abcdefgh',
    unverified: 'stb_mock_unverified_0123456789abcdef',
    // Well-formed but unknown to the server: answers 401 INVALID_KEY.
    invalid: 'stb_mock_revoked_key_0123456789abcde',
});

/** @type {Record<string, {id: string, username: string, displayName: string, verified: boolean, nsfw: boolean, keyName: string}>} */
export const USERS = Object.freeze({
    [KEYS.valid]: { id: 'u_full', username: 'tester', displayName: 'Tester (full access)', verified: true, nsfw: true, keyName: 'Mock laptop' },
    [KEYS.sfwOnly]: { id: 'u_sfw', username: 'sfwfan', displayName: 'SFW Fan', verified: true, nsfw: false, keyName: 'Mock phone' },
    [KEYS.unverified]: { id: 'u_new', username: null, displayName: 'New Member', verified: false, nsfw: false, keyName: '' },
});

const crcFreeChunk = (name, data) => ({ name, data });

/**
 * A real RGB PNG: diagonal gradient between two colours with a lighter
 * circle, so thumbnails look like distinct portraits.
 * @param {{width?: number, height?: number, from?: number[], to?: number[]}} [options]
 * @returns {Uint8Array}
 */
export function makePortraitPng({ width = 120, height = 180, from = [60, 40, 120], to = [220, 120, 60] } = {}) {
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour RGB
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const raw = new Uint8Array(height * (1 + width * 3));
    const cx = width / 2;
    const cy = height * 0.38;
    const r2 = (width * 0.28) ** 2;
    for (let y = 0; y < height; y += 1) {
        const row = y * (1 + width * 3);
        raw[row] = 0; // filter: none
        for (let x = 0; x < width; x += 1) {
            const k = (x / width + y / height) / 2;
            const inside = (x - cx) ** 2 + (y - cy) ** 2 < r2;
            for (let c = 0; c < 3; c += 1) {
                const v = from[c] + (to[c] - from[c]) * k;
                raw[row + 1 + x * 3 + c] = Math.min(255, Math.round(inside ? v + 60 : v));
            }
        }
    }
    return writeChunks([
        crcFreeChunk('IHDR', ihdr),
        crcFreeChunk('IDAT', new Uint8Array(deflateSync(raw))),
        crcFreeChunk('IEND', new Uint8Array(0)),
    ]);
}

/**
 * @param {object} card A V2 card object.
 * @param {object} [imageOptions]
 * @returns {Uint8Array}
 */
export function makeCardPng(card, imageOptions) {
    return writeCardToPng(makePortraitPng(imageOptions), card);
}

const COLOURS = [
    [[70, 40, 130], [230, 130, 70]],
    [[20, 90, 120], [140, 220, 200]],
    [[120, 30, 60], [250, 180, 120]],
    [[30, 30, 40], [160, 80, 200]],
    [[40, 110, 50], [220, 230, 120]],
    [[90, 60, 30], [240, 200, 150]],
];

const ARAYA_BOOK = {
    name: "Araya's Archive",
    description: 'Places and people of the Sunken Archive.',
    scan_depth: 3,
    token_budget: 600,
    recursive_scanning: false,
    extensions: {},
    entries: [
        { id: 0, keys: ['archive', 'sunken archive'], secondary_keys: [], comment: 'The archive', content: 'The Sunken Archive is a library flooded a century ago. Its lower halls are reachable only by boat.', constant: false, selective: false, insertion_order: 100, enabled: true, position: 'before_char', extensions: {} },
        { id: 1, keys: ['lantern'], secondary_keys: [], comment: 'Blue lantern', content: 'Araya carries a lantern that burns blue near forbidden books.', constant: false, selective: false, insertion_order: 90, enabled: true, position: 'after_char', extensions: {} },
    ],
};

const NYX_BOOK = {
    name: 'Nyx: Night Market',
    entries: [
        { id: 0, keys: ['market'], content: 'The night market opens only when the moon is hidden.', insertion_order: 100, enabled: true, extensions: {} },
    ],
};

const SCRAP_BOOK = {
    name: 'Scrapyard Lore',
    description: 'Served only by /bots/{id}/lorebook (fallback path).',
    entries: [
        { id: 0, keys: ['scrapyard', 'junk'], content: 'Scrapyard 9 sits under a permanent rust-coloured cloud.', insertion_order: 100, enabled: true, extensions: {} },
        { id: 1, keys: ['bolt'], content: 'Bolt is the yard foreman, a robot with one working arm.', insertion_order: 100, enabled: true, extensions: {} },
    ],
};

const BASE = [
    { id: 'araya', name: 'Araya', tagline: 'A quiet archivist who reads the books nobody else is allowed to open.', tags: ['fantasy', 'female', 'mystery'], rating: 'sfw', creator: { name: 'Rawi', username: 'rawi' }, book: ARAYA_BOOK, embedBook: true, downloads: 1280, likes: 342, version: '3', updatedAt: '2026-11-02T10:12:00Z',
        description: 'Araya keeps the Sunken Archive.\nShe is patient, curious and very bad at small talk.', firstMessage: '*The lantern flickers blue as you step inside.* "You found the door. Most people never do."', alternateGreetings: 2 },
    { id: 'kaito', name: 'Kaito', tagline: 'Street racer with a heart of gold and a car held together by tape.', tags: ['modern', 'male', 'action'], rating: 'sfw', creator: { name: 'Mika', username: 'mika' }, downloads: 860, likes: 210, version: '1', updatedAt: '2026-10-21T08:00:00Z',
        description: 'Kaito races at night to pay for his sister\'s school.', firstMessage: '"Need a ride? Hop in, but hold on to something."', alternateGreetings: 0 },
    { id: 'mali', name: 'มะลิ (Mali)', tagline: 'แม่ค้าดอกไม้ที่ตลาดเช้า รู้ทุกเรื่องในซอย', tags: ['thai', 'slice of life', 'female'], rating: 'sfw', creator: { name: 'ปลาทู', username: 'platoo' }, downloads: 540, likes: 188, version: '2', updatedAt: '2026-11-10T03:30:00Z',
        description: 'มะลิขายพวงมาลัยที่ปากซอยมาสิบปี เธอใจดีแต่ปากไว', firstMessage: '"วันนี้รับมะลิสักพวงไหมคะ หอมมากเลยนะ"', alternateGreetings: 1 },
    { id: 'velvet', name: 'Velvet', tagline: 'A cabaret singer with secrets. (NSFW fixture)', tags: ['romance', 'female', 'noir'], rating: 'nsfw', creator: { name: 'Noir', username: null }, downloads: 2210, likes: 901, version: '5', updatedAt: '2026-11-12T22:00:00Z',
        description: 'NSFW fixture used to test gating and blur.', firstMessage: '"You came back. I knew you would."', alternateGreetings: 3 },
    { id: 'scrapbot', name: 'Scrapbot', tagline: 'Lorebook fallback fixture: hasLorebook is true but the card has no character_book.', tags: ['sci-fi', 'robot'], rating: 'sfw', creator: { name: 'Gear', username: 'gear' }, book: SCRAP_BOOK, embedBook: false, downloads: 75, likes: 12, version: '1', updatedAt: '2026-09-01T00:00:00Z',
        description: 'A small robot that collects shiny things.', firstMessage: '*Beep.* "Do you have any bolts?"', alternateGreetings: 0 },
    { id: 'xss', name: '<img src=x onerror=alert(1)>', tagline: '<b>bold?</b> <script>alert("xss")</script> Untrusted-string fixture; must render as plain text.', tags: ['<i>tag</i>', 'test'], rating: 'sfw', creator: { name: '"><svg onload=alert(1)>', username: 'x"y' }, downloads: 1, likes: 0, version: '1', updatedAt: '2026-08-08T08:08:08Z',
        description: '<iframe src="https://example.com"></iframe> should appear as text.', firstMessage: '<img src=x onerror=alert(2)>', alternateGreetings: 0 },
    { id: 'nyx', name: 'Nyx', tagline: 'Keeper of the night market. (NSFW fixture with lorebook)', tags: ['fantasy', 'nsfw', 'market'], rating: 'nsfw', creator: { name: 'Noir', username: null }, book: NYX_BOOK, embedBook: true, downloads: 990, likes: 400, version: '2', updatedAt: '2026-11-14T12:00:00Z',
        description: 'NSFW fixture with an embedded lorebook.', firstMessage: '"Looking for something you cannot buy in daylight?"', alternateGreetings: 0 },
];

/**
 * Full fixture list: the hand-written bots plus generated filler so lists
 * paginate (default page size 24).
 * @returns {any[]}
 */
export function buildBots() {
    const bots = BASE.map((bot) => ({ ...bot }));
    for (let i = 1; i <= 36; i += 1) {
        bots.push({
            id: `sample-${i}`,
            name: `Sample Character ${i}`,
            tagline: `Generated fixture number ${i} for pagination and infinite scroll.`,
            tags: [i % 2 ? 'fantasy' : 'modern', i % 3 ? 'female' : 'male', 'sample'],
            rating: i % 7 === 0 ? 'nsfw' : 'sfw',
            creator: { name: `Creator ${(i % 4) + 1}`, username: `creator${(i % 4) + 1}` },
            downloads: (i * 37) % 500,
            likes: (i * 13) % 200,
            version: '1',
            updatedAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 12)).toISOString(),
            description: `Sample character ${i}.`,
            firstMessage: `Hello from sample ${i}.`,
            alternateGreetings: 0,
        });
    }
    bots.forEach((bot, index) => { bot.colour = COLOURS[index % COLOURS.length]; });
    return bots;
}

/**
 * The V2 card for a fixture bot. Lorebook embedded as `data.character_book`
 * only when `embedBook` is set.
 * @param {any} bot
 * @returns {object}
 */
export function cardFor(bot) {
    const data = {
        name: bot.name,
        description: bot.description,
        personality: '',
        scenario: '',
        first_mes: bot.firstMessage,
        mes_example: '',
        creator_notes: bot.tagline,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: Array.from({ length: bot.alternateGreetings || 0 }, (_, i) => `Alternate greeting ${i + 1}`),
        tags: bot.tags,
        creator: bot.creator.name,
        character_version: bot.version,
        extensions: {},
    };
    if (bot.book && bot.embedBook) data.character_book = bot.book;
    return { spec: 'chara_card_v2', spec_version: '2.0', data };
}
