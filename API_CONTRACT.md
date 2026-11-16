# Silly Bot Collection — extension API v1

Contract between the site (<https://bots.rolezy.com>) and the SillyTavern
extension in this folder. The extension is written against exactly this
document; `dev/mock-server.mjs` implements all of it and the extension is
developed against that mock.

**Status:** not implemented on the site yet. Version `v1`.

---

## 1. Transport

- **Base URL**: configurable in the extension. Default
  `https://bots.rolezy.com/api/v1`. The extension strips trailing slashes and
  requires `https:` unless the host is `localhost` / `127.0.0.1` (for the mock
  server).
- **Auth**: `Authorization: Bearer <key>` on every endpoint, including `GET`s.
  Keys are `stb_` + 32 to 128 URL-safe characters
  (`^stb_[A-Za-z0-9_-]{32,128}$`); the extension rejects other shapes before
  calling the server. The key is never placed in a URL, query string
  or `Referer`.
- **Cookies**: never sent. The extension uses `credentials: 'omit'`. The server
  must not rely on a session cookie and must not issue `Set-Cookie` on `/api/v1`.
- **CORS**: the server allows any origin on `/api/v1`. SillyTavern runs on an
  arbitrary origin (`http://localhost:8000` by default, but anything is
  possible), so an origin allowlist is not workable.

  Required response headers on every `/api/v1` response, including errors:

  ```
  Access-Control-Allow-Origin: *
  Vary: Origin
  Access-Control-Expose-Headers: Content-Disposition, X-Card-Version, Retry-After
  ```

  `Access-Control-Allow-Credentials` must **not** be sent (it is incompatible
  with `*` and we send no cookies).

  Preflight: `OPTIONS` on any `/api/v1/*` path returns `204` with

  ```
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, PUT, DELETE, OPTIONS
  Access-Control-Allow-Headers: Authorization, Content-Type
  Access-Control-Max-Age: 86400
  ```

  `Access-Control-Expose-Headers` matters: without it the browser hides
  `X-Card-Version` and `Content-Disposition` from the extension, and the
  "Update available" badge and the card file name stop working.
- **Content type**: `application/json; charset=utf-8` everywhere except
  `/bots/{id}/card`, which is `image/png`.
- **Methods**: `GET`, `PUT`, `DELETE`, `OPTIONS` only. No request bodies are
  ever sent; `PUT` bodies are empty.
- **Caching**: list and detail endpoints should send
  `Cache-Control: private, no-store` (responses are per-user). The card endpoint
  must send `Cache-Control: no-store` because it also counts a download.
- **Rate limiting**: see §7.

---

## 2. Shared types

### `BotSummary`

```jsonc
{
  "id": "6730f1c2a4b1e8f0d3c2b1a0",   // string, opaque, stable
  "name": "Araya",                     // string, 1..80 chars
  "tagline": "A quiet archivist…",      // string, <= 220 chars, may be ""
  "tags": ["fantasy", "female"],        // string[], <= 12 items, each <= 32 chars
  "rating": "sfw",                      // "sfw" | "nsfw"
  "thumbnailUrl": "https://…/t.webp",   // string (https) or null
  "creator": {
    "name": "Rawi",                     // string, display name, required
    "username": "rawi",                 // string or null (site /{username} handle)
    "image": "https://…/a.webp"         // string (https) or null
  },
  "downloads": 128,                     // integer >= 0
  "likes": 42,                          // integer >= 0
  "bookmarked": false,                  // boolean, for the calling user
  "liked": true,                        // boolean, for the calling user
  "hasLorebook": true,                  // boolean
  "cardVersion": "3",                   // string <= 32 chars, same value /card sends as X-Card-Version
  "updatedAt": "2026-11-02T10:12:00Z",  // RFC 3339 UTC: last change to the CARD CONTENT (not likes/downloads)
  "url": "https://bots.rolezy.com/rawi/araya"  // https page on the site
}
```

Every field is **required and non-`undefined`**; nullable ones are `null`, never
missing. The extension treats all strings as untrusted and renders them with
`textContent`.

### `BotDetail`

`BotSummary` plus:

```jsonc
{
  "description": "…",            // string, may be long, may be ""
  "firstMessage": "…",           // string, may be "" (preview of the greeting)
  "alternateGreetings": 2,       // integer >= 0 (count only, not the text)
  "cardSpec": "chara_card_v2",   // "chara_card_v2" | "chara_card_v3"
  "lorebookEntryCount": 14,      // integer >= 0, 0 when hasLorebook is false
  "imageUrl": "https://…/f.webp" // string (https) or null — full-size image
}
```

`description` and `firstMessage` may be truncated by the server; if so set
`"descriptionTruncated": true` / `"firstMessageTruncated": true` (optional
booleans, default `false`). The extension only previews them; the authoritative
text comes from the card PNG.

### List envelope

```jsonc
{ "items": [ /* BotSummary */ ], "nextCursor": "eyJ…" }
```

`nextCursor` is an opaque string, or `null` when there is no further page. The
extension passes it back verbatim as `?cursor=`. A cursor is valid only for the
same endpoint and the same other query parameters; if it is not, respond `400`
with code `BAD_CURSOR` and the extension restarts the list.

### Image URLs

`thumbnailUrl`, `imageUrl` and `creator.image` must be loadable **directly in an
`<img>` tag, from any origin, with no `Authorization` header and no cookies**.
For gated (NSFW) images the server issues short-lived signed URLs. They must
stay valid for at least 15 minutes from the response that contained them. They
must be `https:` absolute URLs. The extension refuses to load anything that is
not `https:` or on the configured base host.

### Pagination parameters

| Param | Type | Default | Max | Notes |
| --- | --- | --- | --- | --- |
| `cursor` | string | — | — | opaque, from `nextCursor` |
| `limit` | integer | `24` | `48` | values above the max are clamped, not rejected |

---

## 3. Endpoints

### `GET /me`

Validates the key and describes the caller. The extension calls this before
saving a key and again on every panel open.

`200`:

```jsonc
{
  "user": {
    "id": "u_123",
    "username": "rawi",            // string or null
    "displayName": "Rawi",         // string
    "image": "https://…/a.webp"    // string (https) or null
  },
  "access": {
    "verified": true,              // Discord "verified" role — required to download
    "nsfw": false                  // Discord NSFW role — required to see NSFW cards
  },
  "key": {
    "name": "SillyTavern laptop",  // string, user-chosen label, may be ""
    "scopes": ["read", "download"],// string[]
    "createdAt": "2026-11-01T08:00:00Z"
  }
}
```

Errors: `401 INVALID_KEY`, `429 RATE_LIMITED`.
**`/me` must answer `200` even when `access.verified` is `false`** — the
extension needs to show "you are connected but not verified on Discord" rather
than "bad key". Only a bad/revoked/expired key gives `401`.

### `GET /feed?cursor=&limit=`

Personalised recommendations for the caller. List envelope. Never includes
`rating: "nsfw"` items when `access.nsfw` is `false`.

`200` list envelope. Errors: `401`, `429`.

### Who may do what

| Caller | Browse, search, feed, bookmarks, likes, detail, toggle | `/card`, `/lorebook` |
| --- | --- | --- |
| valid key, not verified | yes (SFW only) | `403 NOT_VERIFIED` |
| verified, no NSFW role | yes (SFW only; NSFW detail and toggles: `403 NSFW_REQUIRED`) | SFW only, NSFW: `403 NSFW_REQUIRED` |
| verified + NSFW role | yes | yes |

Only downloads require the verified role. Unverified members can look around,
which is what makes the "get verified on Discord" message in the extension
useful.

### `GET /bots?sort=&tag=&rating=&cursor=&limit=`

| Param | Values | Default |
| --- | --- | --- |
| `sort` | `latest` \| `popular` \| `trending` | `latest` |
| `tag` | a single tag string | — (no filter) |
| `rating` | `sfw` \| `nsfw` \| `all` | `sfw` |

`rating=nsfw` or `rating=all` with `access.nsfw === false` → `403 NSFW_REQUIRED`.
The extension never sends them in that case, but the server must still enforce it.
An unknown `sort` or `rating` value → `400 BAD_REQUEST`.

`200` list envelope.

### `GET /search?q=&cursor=&limit=`

`q`: 1..64 characters after trimming. Empty or missing `q` → `400 BAD_REQUEST`.
Results are restricted to `sfw` unless the caller has `access.nsfw`; there is no
`rating` parameter here — the server decides, so a non-NSFW user cannot probe.

`200` list envelope.

### `GET /bookmarks?cursor=&limit=`, `GET /likes?cursor=&limit=`

The caller's own bookmarked / liked bots, most recently added first. All items
have `bookmarked: true` / `liked: true` respectively. These may contain `nsfw`
items the user bookmarked before losing the role; in that case the server
returns the item with `thumbnailUrl: null` and `tagline: ""`, and the card
endpoint still rejects it with `403 NSFW_REQUIRED`.

`200` list envelope.

### `GET /bots/{id}`

`200`: a `BotDetail`. Errors: `401`, `403 NSFW_REQUIRED`, `404 NOT_FOUND`, `429`.

### `PUT /bots/{id}/bookmark` · `DELETE /bots/{id}/bookmark`

### `PUT /bots/{id}/like` · `DELETE /bots/{id}/like`

Idempotent: `PUT` twice is still "on", `DELETE` on something not set is still
`200`. No request body.

`200`:

```jsonc
{ "bookmarked": true, "bookmarks": 9, "liked": false, "likes": 42 }
```

All four fields are present on all four endpoints so the UI can update both
counters from one response. `bookmarks` is the bot's total bookmark count.
Errors: `401`, `403 NSFW_REQUIRED`, `404 NOT_FOUND`, `429`.

### `GET /bots/{id}/card`

The whole point of the extension. Requires `access.verified`.

`200`, body is **one PNG** with the character card embedded, headers:

```
Content-Type: image/png
Content-Disposition: attachment; filename="araya.png"; filename*=UTF-8''araya.png
X-Card-Version: 3
Cache-Control: no-store
```

- The PNG carries a `tEXt` chunk with keyword `chara` whose value is
  base64 of the UTF-8 JSON card. Writing a second `ccv3` chunk is allowed but
  not required; SillyTavern prefers `ccv3` when both exist
  (`src/character-card-parser.js` L57-L74).
- The card JSON is V2 (`"spec": "chara_card_v2", "spec_version": "2.0"`) or V3
  (`"spec": "chara_card_v3", "spec_version": "3.0"`), with the real fields
  under `data`: `name`, `description`, `personality`, `scenario`,
  `first_mes`, `mes_example`, `creator_notes`, `system_prompt`,
  `post_history_instructions`, `alternate_greetings`, `tags`, `creator`,
  `character_version`, `extensions`.
- **When the bot has a lorebook, `data.character_book` must be present** in the
  same card, in spec shape: `{ name, description?, scan_depth?, token_budget?,
  recursive_scanning?, extensions?, entries: [ { keys, secondary_keys?,
  comment?, content, constant?, selective?, insertion_order, enabled,
  position?, extensions?, id? } ] }`. `entries` is an **array**. This is what
  SillyTavern's `convertCharacterBook` consumes (`public/scripts/world-info.js`
  L5617).
- `filename` must be a safe ASCII name: `[A-Za-z0-9._-]{1,64}` ending in `.png`,
  no path separators. The extension sanitises it again regardless.
- `X-Card-Version` is an opaque short string (`<= 32` chars). It changes
  whenever the card bytes change, and equals `cardVersion` in `BotSummary`
  for the same bot at the same moment. The extension stores it per bot and
  shows "Update available" when the value in a list or detail response
  differs from the stored one (it falls back to comparing `updatedAt` only
  when either side has no version).
- **Counts one download per user per bot** (not per request — re-downloading the
  same card must not inflate the counter).

Errors: `401 INVALID_KEY`, `403 NOT_VERIFIED`, `403 NSFW_REQUIRED`,
`404 NOT_FOUND`, `429 RATE_LIMITED`. Error bodies here are JSON
(`application/json`), not PNG.

### `GET /bots/{id}/lorebook`

Fallback for the (unexpected) case where the card has no embedded
`character_book` but `hasLorebook` is `true`.

`200`: the lorebook **in V2/V3 `character_book` spec shape** — the same object
that would sit at `data.character_book`:

```jsonc
{
  "name": "Araya's Lorebook",
  "description": "",
  "scan_depth": 2,
  "token_budget": 500,
  "recursive_scanning": false,
  "extensions": {},
  "entries": [
    {
      "id": 0,
      "keys": ["archive"],
      "secondary_keys": [],
      "comment": "The archive",
      "content": "…",
      "constant": false,
      "selective": false,
      "insertion_order": 100,
      "enabled": true,
      "position": "before_char",
      "extensions": {}
    }
  ]
}
```

*(Changed from the draft: the draft said "standalone lorebook JSON" without a
shape. Pinning it to the `character_book` spec shape means the extension can
feed both this and the embedded book through the same
`convertCharacterBook()` call and needs no second converter.)*

`404 NOT_FOUND` when the bot has no lorebook. Same auth rules as `/card`
(requires `verified`), because a lorebook is part of the download.

---

## 4. Request/response examples

```
GET /api/v1/bots?sort=popular&rating=sfw&limit=24 HTTP/1.1
Host: bots.rolezy.com
Authorization: Bearer stb_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Access-Control-Allow-Origin: *
Vary: Origin
Access-Control-Expose-Headers: Content-Disposition, X-Card-Version, Retry-After
Cache-Control: private, no-store

{"items":[…],"nextCursor":"MjQ"}
```

```
OPTIONS /api/v1/bots/abc/card HTTP/1.1
Origin: http://localhost:8000
Access-Control-Request-Method: GET
Access-Control-Request-Headers: authorization

HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 86400
```

---

## 5. Status codes

| Code | When |
| --- | --- |
| `200` | success |
| `204` | preflight only |
| `400` | malformed parameter — `BAD_REQUEST`, or `BAD_CURSOR` |
| `401` | missing / malformed / unknown / revoked key — `INVALID_KEY` |
| `403` | key is valid, the account may not do this — `NOT_VERIFIED`, `NSFW_REQUIRED` |
| `404` | no such bot, or no lorebook — `NOT_FOUND` |
| `429` | rate limited — `RATE_LIMITED`, with `Retry-After` |
| `500` | server fault — `SERVER_ERROR` |

`405` is never needed: unsupported methods on a known path return `404`.

---

## 6. Error body

Every non-`2xx` response has this body, with `Content-Type: application/json`:

```jsonc
{ "error": { "code": "NOT_VERIFIED", "message": "Get the verified role on Discord to download cards." } }
```

- `code`: one of the SCREAMING_SNAKE values above. The extension switches on
  `code` only, never on `message`.
- `message`: English, for logs and as a last-resort fallback in the UI. The
  extension prefers its own localised copy for every known code, so `message`
  does not need translating.
- Optional `error.detail`: free-form object, ignored by the extension.

---

## 7. Rate limiting

- `429` responses must include `Retry-After` in **seconds** (integer, `1..120`).
- The extension retries **once**, after `min(Retry-After, 30)` seconds, and only
  for `429` and for `5xx` on idempotent (`GET`) requests.
- Suggested budget (not enforced by the extension): 60 requests/minute/key for
  reads, 10/minute/key for `/bots/{id}/card`.

---

## 8. Changes made to the draft contract

Relative to the brief the owner wrote:

1. **`/bots/{id}/lorebook` shape pinned** to the V2/V3 `character_book` spec
   object (entries as an **array**). SillyTavern's `convertCharacterBook()`
   consumes exactly that, so the embedded and fallback paths share one code path.
2. **`Access-Control-Expose-Headers` made mandatory and named.** Without it
   the browser hides `X-Card-Version`, `Content-Disposition` and `Retry-After`
   from a cross-origin caller.
3. **`/me` returns `200` for an unverified user**, so the extension can say
   "connected but not verified" instead of "bad key".
4. **Only `/card` and `/lorebook` require the verified role** (table in §3).
   The brief listed `NOT_VERIFIED` without saying where it applies.
5. **`cardVersion` added to `BotSummary`** (not only the detail), so grid
   cards can show "Update available" without fetching each detail, and
   **`updatedAt` defined as the last change to the card content**, so likes
   and downloads do not trigger false update badges.
6. **Toggle endpoints return all four fields** (`bookmarked`, `bookmarks`,
   `liked`, `likes`).
7. **`BotDetail` defined** (`description`, `firstMessage`,
   `alternateGreetings`, `cardSpec`, `lorebookEntryCount`, `imageUrl`,
   optional truncation flags). The brief said "returns detail" with no shape.
8. **`/search` has no `rating` parameter**; visibility follows the key.
9. **`limit` is clamped, not rejected; bad cursors get `400 BAD_CURSOR`.**
10. **Nullable fields are `null`, never missing; `nextCursor` is `null` on the
    last page.**
11. **No cookies, no `Set-Cookie`, no `Access-Control-Allow-Credentials`.**
12. **Download counted once per user per bot**, so "update" re-downloads do
    not inflate counts.
13. **Key shape bounded** to `stb_` + 32..128 URL-safe characters.
14. **Signed image URLs valid for at least 15 minutes**, since the panel can
    stay open while the user scrolls.

`dev/mock-server.mjs` implements every point above; `tests/mock-server.test.mjs`
checks the important ones.
