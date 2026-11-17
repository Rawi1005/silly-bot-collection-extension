# Silly Bot Collection for SillyTavern

A SillyTavern UI extension for the [Silly Bot Collection](https://bots.rolezy.com)
community. Browse the collection inside SillyTavern (your feed, bookmarks, likes,
latest/popular/trending and search) and import a character, with its lorebook,
in one click.

- Character cards are imported through SillyTavern's own import route, so they
  behave exactly like a card you dragged in.
- An embedded lorebook is saved as World Info and linked to the character.
- Cards you have imported get an "Imported" badge, and "Update available" when
  the site has a newer version.
- English and Thai. The extension follows SillyTavern's language setting.
- It uses your SillyTavern theme colours and works in the mobile layout.

Requires SillyTavern **1.12.12 or newer** (see
[docs/sillytavern-integration.md](docs/sillytavern-integration.md), section 8).

## Install

1. In SillyTavern open **Extensions** (the stacked-blocks icon) and choose
   **Install extension**.
2. Paste the Git URL of this repository and press **Install just for me**
   (non-admin accounts see just **Install**).
3. Reload the page if SillyTavern asks you to.

You will find **Silly Bot Collection** in the Extensions panel and in the wand
menu next to the chat box.

## Getting an access key

1. Sign in on <https://bots.rolezy.com> with Discord.
2. Open **Settings** on the site and create an access key (it starts with `stb_`).
3. Open the extension in SillyTavern and paste the key.

What you can do depends on your Discord roles:

| Role | Browse | Download/import | NSFW cards |
| --- | --- | --- | --- |
| none (key only) | SFW | no | no |
| verified | SFW | yes | no |
| verified + NSFW | all | yes | yes |

NSFW thumbnails are blurred by default. Turn that off in the panel header or in
the Extensions panel.

### About the key

- SillyTavern stores extension settings, including this key, **unencrypted** in
  your SillyTavern user settings on the server, and any other installed
  extension can read them. SillyTavern's own documentation says there is no
  secure place for secrets in a client-side extension.
- The key is designed to be low value: it can only browse, bookmark, like and
  download cards. It cannot change your account. Revoke it on the site at any
  time.
- The extension sends the key only in an `Authorization` header to the server
  address you configured, never in a URL, never with cookies, and never logs it.
- **Disconnect** removes it from SillyTavern's settings.

## Licence

AGPL-3.0 (see [LICENSE](LICENSE)). Chosen because SillyTavern itself is
AGPL-3.0 and this code runs inside it and calls its internals; the owner can
pick another licence before publishing.
