/**
 * Minimal PNG tEXt chunk reader/writer for character cards.
 *
 * SillyTavern stores the card as a PNG `tEXt` chunk: keyword `chara` (or
 * `ccv3`, which wins when both are present), value = base64 of the UTF-8 JSON.
 * Confirmed in src/character-card-parser.js L22-L39 (write) and L57-L74 (read).
 *
 * Pure, dependency-free and isomorphic: used by the extension in the browser to
 * inspect a downloaded card before uploading it, and by dev/mock-server.mjs to
 * generate fixture cards in Node.
 */

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** @type {Int32Array|null} */
let crcTable = null;

function getCrcTable() {
    if (crcTable) return crcTable;
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c;
    }
    crcTable = table;
    return table;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number} CRC-32, unsigned.
 */
export function crc32(bytes) {
    const table = getCrcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
        c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function latin1Bytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) {
        out[i] = text.charCodeAt(i) & 0xFF;
    }
    return out;
}

function latin1String(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
}

/** @param {Uint8Array} bytes @returns {string} */
export function toBase64(bytes) {
    if (typeof globalThis.Buffer === 'function') {
        return globalThis.Buffer.from(bytes).toString('base64');
    }
    return globalThis.btoa(latin1String(bytes));
}

/** @param {string} base64 @returns {Uint8Array} */
export function fromBase64(base64) {
    if (typeof globalThis.Buffer === 'function') {
        return new Uint8Array(globalThis.Buffer.from(base64, 'base64'));
    }
    return latin1Bytes(globalThis.atob(base64));
}

/**
 * Splits a PNG into its chunks.
 * @param {Uint8Array} bytes
 * @returns {{name: string, data: Uint8Array}[]}
 * @throws {Error} When the data is not a PNG.
 */
export function readChunks(bytes) {
    if (bytes.length < 8) throw new Error('Not a PNG: too short');
    for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
        if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('Not a PNG: bad signature');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /** @type {{name: string, data: Uint8Array}[]} */
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset);
        const name = latin1String(bytes.subarray(offset + 4, offset + 8));
        const start = offset + 8;
        const end = start + length;
        if (end + 4 > bytes.length) throw new Error(`Truncated PNG chunk ${name}`);
        chunks.push({ name, data: bytes.subarray(start, end) });
        offset = end + 4;
        if (name === 'IEND') break;
    }
    return chunks;
}

/**
 * @param {{name: string, data: Uint8Array}[]} chunks
 * @returns {Uint8Array}
 */
export function writeChunks(chunks) {
    let total = PNG_SIGNATURE.length;
    for (const chunk of chunks) total += 12 + chunk.data.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set(PNG_SIGNATURE, 0);
    let offset = PNG_SIGNATURE.length;
    for (const chunk of chunks) {
        view.setUint32(offset, chunk.data.length);
        const nameBytes = latin1Bytes(chunk.name);
        out.set(nameBytes, offset + 4);
        out.set(chunk.data, offset + 8);
        const crcInput = new Uint8Array(4 + chunk.data.length);
        crcInput.set(nameBytes, 0);
        crcInput.set(chunk.data, 4);
        view.setUint32(offset + 8 + chunk.data.length, crc32(crcInput));
        offset += 12 + chunk.data.length;
    }
    return out;
}

/**
 * Decodes a tEXt chunk payload: `keyword \0 text`, both Latin-1.
 * @param {Uint8Array} data
 * @returns {{keyword: string, text: string}}
 */
export function decodeTextChunk(data) {
    const nul = data.indexOf(0);
    if (nul < 0) return { keyword: latin1String(data), text: '' };
    return {
        keyword: latin1String(data.subarray(0, nul)),
        text: latin1String(data.subarray(nul + 1)),
    };
}

/**
 * @param {string} keyword
 * @param {string} text Latin-1 safe (base64 here).
 * @returns {{name: string, data: Uint8Array}}
 */
export function encodeTextChunk(keyword, text) {
    const keywordBytes = latin1Bytes(keyword);
    const textBytes = latin1Bytes(text);
    const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
    data.set(keywordBytes, 0);
    data[keywordBytes.length] = 0;
    data.set(textBytes, keywordBytes.length + 1);
    return { name: 'tEXt', data };
}

/**
 * Reads the embedded card JSON out of a PNG. `ccv3` wins over `chara`, matching
 * src/character-card-parser.js L64-L74.
 * @param {Uint8Array} bytes
 * @returns {object|null} The parsed card, or null when there is none.
 */
export function readCardFromPng(bytes) {
    let chunks;
    try {
        chunks = readChunks(bytes);
    } catch {
        return null;
    }
    const texts = chunks
        .filter((chunk) => chunk.name === 'tEXt')
        .map((chunk) => decodeTextChunk(chunk.data));

    const pick = texts.find((entry) => entry.keyword.toLowerCase() === 'ccv3')
        ?? texts.find((entry) => entry.keyword.toLowerCase() === 'chara');
    if (!pick) return null;

    try {
        const json = new TextDecoder('utf-8').decode(fromBase64(pick.text));
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Writes/replaces the `chara` chunk of a PNG.
 * @param {Uint8Array} bytes A valid PNG.
 * @param {object} card The card object (V2 or V3 shape).
 * @returns {Uint8Array}
 */
export function writeCardToPng(bytes, card) {
    const chunks = readChunks(bytes).filter((chunk) => {
        if (chunk.name !== 'tEXt') return true;
        const keyword = decodeTextChunk(chunk.data).keyword.toLowerCase();
        return keyword !== 'chara' && keyword !== 'ccv3';
    });
    const json = JSON.stringify(card);
    const base64 = toBase64(new TextEncoder().encode(json));
    const iendIndex = chunks.findIndex((chunk) => chunk.name === 'IEND');
    const chunk = encodeTextChunk('chara', base64);
    if (iendIndex < 0) chunks.push(chunk);
    else chunks.splice(iendIndex, 0, chunk);
    return writeChunks(chunks);
}

/**
 * Pulls the embedded lorebook out of a parsed card, V2 or V3.
 * @param {object|null} card
 * @returns {object|null} A `character_book` object, or null.
 */
export function getEmbeddedLorebook(card) {
    if (!card || typeof card !== 'object') return null;
    const book = /** @type {any} */ (card).data?.character_book
        ?? /** @type {any} */ (card).character_book;
    if (!book || typeof book !== 'object' || !Array.isArray(book.entries) || book.entries.length === 0) {
        return null;
    }
    return book;
}

/**
 * The card's own display name, V2 or V3 or V1.
 * @param {object|null} card
 * @returns {string}
 */
export function getCardName(card) {
    if (!card || typeof card !== 'object') return '';
    const any = /** @type {any} */ (card);
    const name = any.data?.name ?? any.name;
    return typeof name === 'string' ? name : '';
}
