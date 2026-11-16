# SillyTavern integration notes

Re-verified on **2026-11-15** against the raw sources of
[SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern). Both
`release` and `staging` reported `"version": "1.19.0"`.
`public/scripts/st-context.js`, `extensions.js`, `popup.js`, `i18n.js`,
`utils.js`, `src/character-card-parser.js` and `src/endpoints/content-manager.js`
were byte-identical on the two branches. `public/script.js`, `world-info.js`
and `src/endpoints/characters.js` differ, but not in any code this extension
relies on (the `characters.js` diff only changes which avatar JSON/YAML imports
use; the PNG import path is unchanged, staging `/import` route at L1599).

Line links below point at `release` unless they say otherwise. Line numbers
drift; the function names are the stable part. Anything not confirmed from
source is marked **UNCONFIRMED**. Nothing here was verified against a running
SillyTavern (none was installed or run); see `docs/manual-test.md`.

Shorthand: `R` = `https://github.com/SillyTavern/SillyTavern/blob/release`.

---

## 1. Manifest and install location

Fields read by the client in `public/scripts/extensions.js`:

| Field | Behaviour | Source |
| --- | --- | --- |
| `display_name` | Shown in Manage Extensions | [R/public/scripts/extensions.js#L581](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js#L581) |
| `js` | Loaded as `<script type="module">` from `/scripts/extensions/<name>/<js>` | [L813-L846](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js#L813-L846) |
| `css` | Injected as `<link rel=stylesheet>` | [L781-L805](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js#L781-L805) |
| `i18n` | `{ "<locale>": "<file>" }`, only the active locale is fetched | [L848-L878](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js#L848-L878) |
| `minimum_client_version` | Compared with `versionCompare` (numeric `localeCompare`). Older clients **do not load the extension and show a load error** (not silent) | [L580-L590](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js#L580-L590), [L658-L660](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js#L658-L660), [utils.js#L2898](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/utils.js#L2898) |
| `author`, `version` | Returned by the installer | [R/src/endpoints/extensions.js#L146](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/extensions.js#L146) |
| `loading_order`, `requires`, `dependencies`, `optional`, `hooks`, `auto_update`, `generate_interceptor`, `homePage` | Documented in the official guide | [docs: Writing extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/) |

`minimum_client_version` is only enforced from **1.13.3** on (checked: no
reference in `extensions.js` at tags 1.12.12 through 1.13.2; present at 1.13.3,
1.13.4, 1.13.5, 1.14.0 ... 1.17.0). Older clients ignore it, which is why the
extension also feature-detects at runtime (section 8).

Install locations: per user `data/<user-handle>/extensions/<folder>/`
(`extensions: 'extensions'` in the user directory template,
[R/src/constants.js#L37](https://github.com/SillyTavern/SillyTavern/blob/release/src/constants.js#L37)),
or for all users `public/scripts/extensions/third-party/<folder>/`
(`globalExtensions` in
[R/src/constants.js#L6](https://github.com/SillyTavern/SillyTavern/blob/release/src/constants.js#L6)).
Both are listed as `third-party/<folder>`
([src/endpoints/extensions.js#L518-L526](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/extensions.js#L518-L526))
and served under `/scripts/extensions/third-party/<folder>/`. The installer
(`POST /api/extensions/install`,
[L92-L121](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/extensions.js#L92-L121))
clones a Git URL; only admins may install for all users.

Consequence: `index.js` finds its own folder with `new URL('./', import.meta.url)`
and loads `i18n/*.json` from there.

## 2. App context and settings

- `globalThis.SillyTavern = { libs, getContext }`:
  [R/public/script.js#L293](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js#L293).
- The docs recommend `SillyTavern.getContext()` and describe relative imports
  (`../../../../script.js`) only for bundled extensions
  ([docs](https://docs.sillytavern.app/for-contributors/writing-extensions/), "Using getContext").
- Members used here, all in
  [R/public/scripts/st-context.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js):
  `characters` (L119), `name1` (L121), `getRequestHeaders` (L129),
  `saveSettingsDebounced` (L132), `eventSource`/`eventTypes` (L138-L139),
  `extensionSettings` (L201), `writeExtensionField` (L207),
  `getThumbnailUrl`, `selectCharacterById` (L210), `getCurrentLocale` (L216),
  `Popup`/`POPUP_TYPE`/`POPUP_RESULT` (L224-L226), `getCharacters` (L230),
  `importTags` (L235), `saveWorldInfo` (L279), `updateWorldInfoList` (L281),
  `convertCharacterBook` (L282), `getWorldInfoNames` (L284).
- `characters` is one array that `getCharacters()` empties and refills in
  place (`characters.splice(0, characters.length)`,
  [script.js#L1302](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js#L1302)),
  so a reference stays valid. We still call `getContext()` again after a refresh.
- `processDroppedFiles` is exported from `script.js`
  ([L10461](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js#L10461))
  but **is not on the context**, so it can only be reached by a relative import.

Settings pattern (docs, "Persistent settings"):
`extensionSettings[MODULE] ??= defaults; ... saveSettingsDebounced();`. The
docs also say, under "Security": never store API keys in `extensionSettings`,
because other extensions can read them and they are stored in plain text, and
"There is no secure way to store secrets in client-side extensions". We store
the access key there anyway (no alternative without a server plugin). The key
is scoped to read and download on the site side, and the README says so.

## 3. UI surface

- Extensions panel containers `#extensions_settings` / `#extensions_settings2`:
  [R/public/index.html#L5773](https://github.com/SillyTavern/SillyTavern/blob/release/public/index.html#L5773),
  [#L5791](https://github.com/SillyTavern/SillyTavern/blob/release/public/index.html#L5791).
  The docs append to `#extensions_settings2`.
- `inline-drawer` collapse is a delegated handler on `.inline-drawer-toggle`:
  [R/public/script.js#L12193](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js#L12193).
- Wand menu `#extensionsMenu` comes from
  [templates/wandMenu.html](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/templates/wandMenu.html);
  third-party items append to it. The bundled Gallery uses
  `list-group-item flex-container flexGap5` and `extensionsMenuExtensionButton`:
  [gallery/index.js#L801-L809](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/gallery/index.js#L801-L809).
- `Popup` ([popup.js#L196](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/popup.js#L196)):
  `new Popup(content, type, inputValue, options)`; types `TEXT 1, CONFIRM 2,
  INPUT 3, DISPLAY 4, CROP 5`; results `AFFIRMATIVE 1, NEGATIVE 0, CANCELLED
  null, CUSTOM1 1001 ...` (L9-L37). Options used: `okButton`, `cancelButton`,
  `customButtons` (`{text, result, classes}`), `large`, `wide`, `leftAlign`,
  `animation`, `onClose` (typedef L39-L63). `DISPLAY` hides the button row and
  shows a close X (L483-L488). An `HTMLElement` content is appended; a string
  goes to `innerHTML` (L528-L537), so we only pass elements. Enter completes
  the popup only when focus is inside a `.result-control` (L628-L670), so our
  search box and buttons are safe. Escape fires the dialog `cancel` event
  (L613). `completeCancelled()` exists (L810).
- `toastr` is a classic global script
  ([index.html#L8208](https://github.com/SillyTavern/SillyTavern/blob/release/public/index.html#L8208)),
  configured with `escapeHtml: true`
  ([script.js#L348-L363](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js#L348-L363)).
  We also pass `escapeHtml: true` per call.
- DOMPurify: `SillyTavern.libs.DOMPurify` (docs, "Shared libraries") and
  `window.DOMPurify` ([lib.js#L42-L45](https://github.com/SillyTavern/SillyTavern/blob/release/public/lib.js#L42-L45)).
  Not used: the extension never parses HTML.
- The server disables Helmet's CSP (`contentSecurityPolicy: false`,
  [src/server-main.js#L104-L106](https://github.com/SillyTavern/SillyTavern/blob/release/src/server-main.js#L104-L106)),
  so the page may `fetch` the site and load its images.

## 4. Importing a card

### Options checked

**(a) `POST /api/characters/import` (chosen).** Server:
[src/endpoints/characters.js#L1560-L1598](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/characters.js#L1560-L1598).
Multipart fields: `avatar` (file), `file_type` (`png`), optional `user_name`,
optional `preserved_name` (overwrite that avatar; parsed by `getPreservedName`,
L1554). Reply: `{ file_name }` without `.png`, `{ error: true }`, or HTTP 400.
`importFromPng` (L968) sanitises the card name and picks a unique file name
(`getPngName`, L1543), so the avatar must be read from the reply. The app's own
client wrapper `importCharacter`
([script.js#L10530-L10588](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js#L10530-L10588))
posts exactly this form with `getRequestHeaders({ omitContentType: true })`.

**Correction to the earlier notes:** `omitContentType` does not exist in
1.12.12 or 1.13.0 (`grep` of `script.js` at those tags returns nothing), where
`getRequestHeaders()` always adds `Content-Type: application/json`, which
breaks a multipart body. The importer therefore copies `getRequestHeaders()`
and deletes `Content-Type` itself (`uploadHeaders` in `src/importer.js`).
This keeps the `X-CSRF-Token` the server requires.

**(b) `processDroppedFiles`.** Import, tag import and selection in one call,
but only reachable by a relative import into `script.js`, which breaks the
module at load time if the file moves. Rejected.

**(c) Import from external URL.** `importFromExternalUrl`
([utils.js#L2998](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/utils.js#L2998))
posts to `/api/content/importURL`
([content-manager.js#L978](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/content-manager.js#L978)).
The **server** downloads the file from a fixed list of hosts (Chub, JanitorAI,
Pygmalion, AICharacterCards, RisuRealm, Perchance) or from the config
allowlist `whitelistImportDomains` (L22). The site is not on the list, and
the server-side fetch cannot carry the user's bearer key. Rejected.

**Community precedent:** `city-unit/SillyTavern-Chub-Search`
([index.js](https://github.com/city-unit/SillyTavern-Chub-Search/blob/master/index.js))
imports `getRequestHeaders`, `processDroppedFiles` and the deprecated
`callPopup` from `../../../../script.js` (L3-L7), POSTs to
`/api/content/importURL`, wraps the reply in `new File(...)` and calls
`processDroppedFiles([file])`. That is (c) plus (b). It works for Chub because
Chub is hard-coded server-side; it does not transfer to a gated site.

### Flow used

1. `fetch(<base>/bots/{id}/card, { Authorization: Bearer ... })` in the browser.
2. Parse the PNG `tEXt` chunk locally (keyword `ccv3` wins over `chara`,
   base64 UTF-8 JSON, same rule as
   [character-card-parser.js#L54-L79](https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js#L54-L79)).
   A download without card data is rejected before upload.
3. POST the form above. For "Update existing", send `preserved_name` = the
   previous avatar, but only if that avatar still exists.
4. `await getCharacters()`, then find the index by `avatar`.
5. Lorebook (section 5).
6. `importTags(character)` if present (1.16.0+). It honours the user's "Import
   Card Tags" setting (`handleTagImport`, [tags.js#L999-L1032](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/tags.js#L999-L1032):
   `NONE` returns no tags, `ASK` shows the app's own dialog). This resolves the
   earlier UNCONFIRMED item: calling it outside `processDroppedFiles` is the
   same call that function makes.
7. "Open character": look the index up again by avatar and call
   `selectCharacterById(index)` ([script.js#L875](https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js#L875)),
   which takes the numeric index and returns early (no throw) if a chat is
   saving or a group is generating.

Small correction: the earlier notes said the PNG writer "removes ccv3". The
writer ([L15-L46](https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js#L15-L46))
removes old `chara`/`ccv3` chunks and then writes **both** a `chara` and a
`ccv3` chunk. Irrelevant to us, but the note was wrong.

## 5. Lorebooks

- An embedded `data.character_book` is **not** turned into World Info on
  import. On character selection `checkEmbeddedWorld`
  ([world-info.js#L5691-L5729](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js#L5691-L5729))
  shows a one-time prompt or toast, **unless** `data.extensions.world` already
  names an existing World Info. `importEmbeddedWorldInfo` (L5731) reads the
  character id from a DOM element, so it is not callable from outside.
- We replicate it with context members:
  `convertCharacterBook(book)` (L5617; takes the V2/V3 spec shape with an
  `entries` **array**, mutates entries by assigning `id`, so we pass a clone)
  → `saveWorldInfo(name, data, true)` (L4177) → `updateWorldInfoList()`
  (L2061) → `writeExtensionField(chid, 'world', name)`
  ([extensions.js#L2070](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions.js#L2070),
  sets `data.extensions.world` locally and on the server). Linking before the
  user opens the character also suppresses the "embedded lorebook" prompt.
- `saveWorldInfo` ignores the HTTP result (`_save`, L4151-L4161). When
  `getWorldInfoNames` exists (present on 1.19.0, absent at tag 1.16.0; the
  release in between that added it was not pinned down) we confirm the new
  name is listed; otherwise we cannot detect a failed save.
- The server writes `sanitize(`${name}.json`)` with the `sanitize-filename`
  package ([src/endpoints/worldinfo.js#L5, #L134-L157](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/worldinfo.js#L134-L157)).
  A name containing `/ ? < > \ : * | "` would be saved under a different file
  name than the one we link. The earlier code did not handle this; the importer
  now pre-sanitises with the same rules (**UNCONFIRMED** that our regex matches
  every edge of `sanitize-filename`, e.g. its 255-byte truncation; we cap at
  100 characters to stay well under it).
- Name clashes: the earlier code would silently overwrite a user's lorebook
  with the same name. Now a new import picks `Name (2)`, `Name (3)` ...;
  "Update existing" overwrites only the lorebook name recorded for that bot.
- Fallback when the card has no `character_book` but `hasLorebook` is true:
  `GET /bots/{id}/lorebook` returns the same spec shape and goes through the
  same path. `importWorldInfo` (file-based, L5850) is not on the context.

## 6. Locale

`getCurrentLocale()` returns `localStorage.language || navigator.language`,
lowercased ([i18n.js#L6, #L15](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/i18n.js#L6)).
`addLocaleData` keys by English source text, refuses to override app keys and
ignores other locales (L22-L39).

**Correction:** the earlier notes said SillyTavern has no Thai locale. It does:
`th-th` is in [public/locales/lang.json](https://github.com/SillyTavern/SillyTavern/blob/release/public/locales/lang.json)
and `public/locales/th-th.json` exists. We keep our own keyed bundles
(`i18n/en.json`, `i18n/th.json`) and match on the language prefix; shared
terms (ยกเลิก, ค้นหา, ข้อความเริ่มต้น, ข้อมูลโลก, นำเข้า) follow
`th-th.json`.

## 7. Theme variables

From `:root` in [R/public/style.css](https://github.com/SillyTavern/SillyTavern/blob/release/public/style.css):
`--SmartThemeBodyColor` (L71), `--SmartThemeEmColor` (L72),
`--SmartThemeUnderlineColor` (L73), `--SmartThemeQuoteColor` (L74),
`--SmartThemeBlurTintColor` (L76), `--SmartThemeChatTintColor` (L77),
`--SmartThemeShadowColor` (L81), `--SmartThemeBorderColor` (L82),
`--mainFontSize` (L96), `--mainFontFamily` (L97), `--black30a` (L25),
`--white20a` (L32), `--golden` (L57), `--warning` (L58), `--active` (L59),
`--interactable-outline-color` (L62), `--animation-duration` (L129).

**Corrections:** `--SmartThemeBodyFont` (cited by the earlier notes) does not
exist; the font is `--mainFontFamily`. `--animation-duration` does exist (the
notes had it as unconfirmed). Every variable is used with a fallback.

Popup sizing: `.large_dialogue_popup` is `90dvh` tall
([style.css#L3711-L3716](https://github.com/SillyTavern/SillyTavern/blob/release/public/style.css#L3711-L3716));
`.popup-content` hides overflow
([css/popup.css#L62-L67](https://github.com/SillyTavern/SillyTavern/blob/release/public/css/popup.css#L62-L67)),
so the panel sets its own height and scrolls inside `.stb-view`.

Font Awesome Free **6.5.2** is bundled (`public/css/fontawesome.min.css`
header); every icon name used was checked against it (`fa-image-slash`, used
by the earlier code, is not in it and was replaced).

## 8. Minimum version

Checked `st-context.js` at tags for every member the extension needs:

| Tag | Missing required members |
| --- | --- |
| 1.12.11 | `getCharacters`, `convertCharacterBook`, `saveWorldInfo`, `updateWorldInfoList` |
| **1.12.12** | none (`getCurrentLocale` missing until 1.12.13; we fall back to `navigator.language`) |
| 1.13.0, 1.13.5, 1.14.0 | none |
| 1.16.0 | none; adds `importTags` (optional) |
| 1.19.0 | none; adds `getWorldInfoNames` (optional) |

At 1.12.12 the `/api/characters/import` route, `preserved_name` and the
`{ file_name }` reply exist, and `Popup` has `DISPLAY`, `customButtons`,
`onClose` and `completeCancelled`. So the believed minimum is **1.12.12**,
which `manifest.json` declares. Caveats: enforced by SillyTavern only from
1.13.3; nothing older than the current 1.19.0 source was read beyond the
greps listed; nothing was run. At runtime `checkSupport()` looks for every
required member and shows one "not supported" screen instead of throwing.

## 9. Still unconfirmed

- The real end-to-end import inside SillyTavern (never executed here).
- Whether pressing Escape inside the panel's detail view goes back without
  closing the SillyTavern popup in every browser. We cancel the `keydown`,
  which per the HTML spec cancels the dialog close request; verified only in
  the dev harness's own `<dialog>` in Chromium.
- Behaviour with `performance.lazyLoadCharacters` enabled (shallow character
  objects); `writeExtensionField` should still work, untested.
- `importTags` "Ask" dialog stacking on top of our panel popup (popups stack
  as separate `<dialog>` elements; untested).
- Importing while a reply is generating. The app's own importer refuses
  (`importCharacter` checks `is_send_press`), but those flags are not on the
  context, so we cannot check them; `getCharacters()` during generation is
  untested.
