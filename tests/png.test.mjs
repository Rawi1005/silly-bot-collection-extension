import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readChunks, decodeTextChunk, encodeTextChunk, writeChunks, readCardFromPng, writeCardToPng, getEmbeddedLorebook, crc32 } from '../src/png.js';
import { makePortraitPng, makeCardPng, buildBots, cardFor } from '../dev/fixtures.mjs';

function chunkCrcsAreValid(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset < bytes.length) {
        const length = view.getUint32(offset);
        const typeAndData = bytes.subarray(offset + 4, offset + 8 + length);
        const stored = view.getUint32(offset + 8 + length);
        if (crc32(typeAndData) !== stored) return false;
        offset += 12 + length;
    }
    return offset === bytes.length;
}

test('crc32 matches the PNG reference value for "IEND"', () => {
    assert.equal(crc32(new TextEncoder().encode('IEND')), 0xAE426082);
});

test('generated portrait is a structurally valid PNG', () => {
    const png = makePortraitPng({ width: 20, height: 30 });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = readChunks(png);
    assert.deepEqual(chunks.map((c) => c.name), ['IHDR', 'IDAT', 'IEND']);
    const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset);
    assert.equal(ihdr.getUint32(0), 20);
    assert.equal(ihdr.getUint32(4), 30);
    // Decompressed scanlines: height * (filter byte + width * RGB).
    assert.equal(inflateSync(chunks[1].data).length, 30 * (1 + 20 * 3));
    assert.ok(chunkCrcsAreValid(png));
});

test('card PNG carries a chara tEXt chunk with base64 V2 JSON, before IEND', () => {
    const bots = buildBots();
    const araya = bots.find((b) => b.id === 'araya');
    const png = makeCardPng(cardFor(araya));
    assert.ok(chunkCrcsAreValid(png));
    const chunks = readChunks(png);
    assert.equal(chunks.at(-1).name, 'IEND');
    const text = chunks.filter((c) => c.name === 'tEXt').map((c) => decodeTextChunk(c.data));
    assert.equal(text.length, 1);
    assert.equal(text[0].keyword, 'chara');
    const json = JSON.parse(Buffer.from(text[0].text, 'base64').toString('utf8'));
    assert.equal(json.spec, 'chara_card_v2');
    assert.equal(json.spec_version, '2.0');
    assert.equal(json.data.name, 'Araya');
    assert.ok(Array.isArray(json.data.character_book.entries));
    assert.equal(json.data.character_book.entries.length, 2);
    assert.deepEqual(readCardFromPng(png), json);
    assert.equal(getEmbeddedLorebook(json).name, "Araya's Archive");
});

test('fallback fixture has hasLorebook data but no embedded character_book', () => {
    const scrap = buildBots().find((b) => b.id === 'scrapbot');
    const card = readCardFromPng(makeCardPng(cardFor(scrap)));
    assert.equal(card.data.character_book, undefined);
    assert.equal(getEmbeddedLorebook(card), null);
    assert.ok(scrap.book.entries.length > 0);
});

test('UTF-8 (Thai) survives the round trip, ccv3 wins over chara, rewriting replaces both', () => {
    const base = makePortraitPng({ width: 4, height: 6 });
    const thai = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'มะลิ' } };
    const png = writeCardToPng(base, thai);
    assert.equal(readCardFromPng(png).data.name, 'มะลิ');

    // Hand-build a PNG with both chunks to check precedence.
    const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'V3' } };
    const chunks = readChunks(png);
    const withV3 = writeChunks([...chunks.slice(0, -1), encodeTextChunk('ccv3', Buffer.from(JSON.stringify(v3)).toString('base64')), chunks.at(-1)]);
    assert.equal(readCardFromPng(withV3).data.name, 'V3');
    const rewritten = writeCardToPng(withV3, { spec: 'chara_card_v2', data: { name: 'Again' } });
    assert.equal(readChunks(rewritten).filter((c) => c.name === 'tEXt').length, 1);
    assert.equal(readCardFromPng(rewritten).data.name, 'Again');
});

test('non-PNG input yields null instead of throwing', () => {
    assert.equal(readCardFromPng(new TextEncoder().encode('<html>login</html>')), null);
    assert.equal(readCardFromPng(makePortraitPng({ width: 2, height: 2 })), null);
});
