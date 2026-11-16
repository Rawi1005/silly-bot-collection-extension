import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Settings, MODULE_NAME, DEFAULT_BASE_URL, MAX_IMPORT_RECORDS, normaliseSettings, normaliseBaseUrl,
    isValidKeyFormat, recordImport, getImportStatus, createSettings,
} from '../src/state.js';

const KEY = 'stb_unit_test_key_0123456789abcdefghij';

test('defaults are filled in and junk is dropped', () => {
    const s = normaliseSettings({ baseUrl: 'ftp://x', accessKey: 'nope', blurNsfw: 'yes', imports: { a: 5, b: { version: 1, name: 'B' } }, extra: 1 });
    assert.equal(s.baseUrl, DEFAULT_BASE_URL);
    assert.equal(s.accessKey, '');
    assert.equal(s.blurNsfw, true);
    assert.deepEqual(Object.keys(s.imports), ['b']);
    assert.equal(s.imports.b.version, '');
    assert.equal('extra' in s, false);
});

test('base URL rules: https, or http on loopback only', () => {
    assert.equal(normaliseBaseUrl(' https://bots.rolezy.com/api/v1/// '), 'https://bots.rolezy.com/api/v1');
    assert.equal(normaliseBaseUrl('http://localhost:8790/api/v1'), 'http://localhost:8790/api/v1');
    assert.equal(normaliseBaseUrl('http://127.0.0.1:8790/api/v1'), 'http://127.0.0.1:8790/api/v1');
    assert.throws(() => normaliseBaseUrl('http://bots.rolezy.com/api/v1'));
    assert.throws(() => normaliseBaseUrl('not a url'));
    assert.throws(() => normaliseBaseUrl(''));
});

test('key format', () => {
    assert.equal(isValidKeyFormat(KEY), true);
    assert.equal(isValidKeyFormat(` ${KEY} `), true);
    assert.equal(isValidKeyFormat('stb_short'), false);
    assert.equal(isValidKeyFormat('sk_0123456789abcdefghij0123456789abcdef'), false);
    assert.equal(isValidKeyFormat(`stb_${'a'.repeat(129)}`), false);
});

test('Settings persists through the store and calls save on every mutation', () => {
    const store = {};
    let saves = 0;
    const settings = new Settings({ store, save: () => { saves += 1; } });
    assert.equal(settings.isConnected, false);
    settings.setAccessKey(KEY);
    settings.setConnectedAs('Rawi');
    settings.setBlurNsfw(false);
    assert.equal(store[MODULE_NAME].accessKey, KEY);
    assert.equal(store[MODULE_NAME].blurNsfw, false);
    assert.equal(saves, 3);
    assert.throws(() => settings.setAccessKey('bad'), (e) => e.name === 'BAD_KEY_FORMAT');
    settings.clearAccessKey();
    assert.equal(store[MODULE_NAME].accessKey, '');
    assert.equal(store[MODULE_NAME].connectedAs, '', 'disconnect also forgets who was connected');
    // A reload sees the same values.
    const reloaded = new Settings({ store });
    assert.equal(reloaded.blurNsfw, false);
});

test('createSettings uses SillyTavern extensionSettings and saveSettingsDebounced', () => {
    let saved = 0;
    const context = { extensionSettings: {}, saveSettingsDebounced: () => { saved += 1; } };
    const settings = createSettings(context);
    settings.setBlurNsfw(false);
    assert.equal(context.extensionSettings[MODULE_NAME].blurNsfw, false);
    assert.equal(saved, 1);
    assert.equal(createSettings(null).baseUrl, DEFAULT_BASE_URL);
});

test('import records: stored, replaced, and bounded oldest-first', () => {
    let imports = recordImport({}, { botId: 'a', version: '1', updatedAt: '2026-01-01T00:00:00Z', name: 'A', avatar: 'A.png', lorebook: 'A lore', importedAt: '2026-01-01T00:00:00Z' });
    assert.deepEqual(imports.a, { version: '1', importedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', name: 'A', avatar: 'A.png', lorebook: 'A lore' });
    imports = recordImport(imports, { botId: 'a', version: '2' });
    assert.equal(imports.a.version, '2');
    assert.ok(imports.a.importedAt > '2026-01-02');

    let many = {};
    for (let i = 0; i < MAX_IMPORT_RECORDS + 5; i += 1) {
        many = recordImport(many, { botId: `b${i}`, importedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    }
    assert.equal(Object.keys(many).length, MAX_IMPORT_RECORDS);
    assert.equal('b0' in many, false);
    assert.equal(`b${MAX_IMPORT_RECORDS + 4}` in many, true);
});

test('import status: none, imported, update by version, update by timestamp', () => {
    const imports = {
        v: { version: '3', updatedAt: '2026-11-01T00:00:00Z' },
        t: { version: '', updatedAt: '2026-11-01T00:00:00Z' },
    };
    assert.equal(getImportStatus(imports, { id: 'x' }), 'none');
    assert.equal(getImportStatus(imports, { id: 'v', cardVersion: '3', updatedAt: '2027-01-01T00:00:00Z' }), 'imported', 'version wins when both sides know it');
    assert.equal(getImportStatus(imports, { id: 'v', cardVersion: '4' }), 'update');
    assert.equal(getImportStatus(imports, { id: 't', updatedAt: '2026-11-01T00:00:00.000Z' }), 'imported', 'same instant, different format');
    assert.equal(getImportStatus(imports, { id: 't', updatedAt: '2026-11-02T00:00:00Z' }), 'update');
    assert.equal(getImportStatus(imports, { id: 't', updatedAt: 'garbage' }), 'imported');
});
