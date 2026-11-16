import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBundle, setLocale, t, resolveLocale, resetI18n } from '../src/i18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (name) => JSON.parse(await readFile(path.join(root, 'i18n', name), 'utf8'));

async function sourceFiles(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...await sourceFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

test('en and th have exactly the same keys and the same placeholders', async () => {
    const en = await load('en.json');
    const th = await load('th.json');
    assert.deepEqual(Object.keys(th).sort(), Object.keys(en).sort());
    for (const key of Object.keys(en)) {
        const ph = (s) => (s.match(/\{\w+\}/g) || []).sort();
        assert.deepEqual(ph(th[key]), ph(en[key]), `placeholders differ for ${key}`);
        assert.ok(th[key].trim(), `empty Thai string for ${key}`);
    }
});

test('every key used in the code exists in en.json', async () => {
    const en = await load('en.json');
    const files = [path.join(root, 'index.js'), ...await sourceFiles(path.join(root, 'src'))];
    const used = new Set();
    for (const file of files) {
        const code = await readFile(file, 'utf8');
        for (const m of code.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
        for (const m of code.matchAll(/'((?:import\.error|tab|browse\.sort)\.[a-zA-Z]+)'/g)) used.add(m[1]);
    }
    for (const tab of ['feed', 'bookmarks', 'liked', 'browse', 'search']) used.add(`tab.${tab}`);
    for (const sort of ['latest', 'popular', 'trending']) used.add(`browse.sort.${sort}`);
    const missing = [...used].filter((key) => !(key in en));
    assert.deepEqual(missing, []);
});

test('locale resolution and interpolation', () => {
    resetI18n();
    assert.equal(resolveLocale('th-th'), 'th');
    assert.equal(resolveLocale('TH_TH'), 'th');
    assert.equal(resolveLocale('fr-fr'), 'en');
    addBundle('en', { hi: 'Hello {name}', only: 'English only' });
    addBundle('th', { hi: 'สวัสดี {name}' });
    setLocale('th-th');
    assert.equal(t('hi', { name: '<b>x</b>' }), 'สวัสดี <b>x</b>');
    assert.equal(t('only'), 'English only');
    assert.equal(t('missing.key'), 'missing.key');
    assert.equal(t('hi', {}), 'สวัสดี {name}');
});
