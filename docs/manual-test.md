# Manual test in a real SillyTavern (about 10 minutes)

The automated tests and the dev harness never ran inside SillyTavern. This
checklist covers the parts only a real SillyTavern can prove: the import
route, World Info, the character list, popups, toasts and the theme.

Use a throwaway SillyTavern user or back up `data/<user>/` first: the test
creates characters and World Info entries.

## Setup (2 min)

1. In this folder: `npm run mock`. Leave it running. It prints the base URL
   (`http://localhost:8790/api/v1`) and four test keys.
2. Make the extension visible to SillyTavern. Either:
   - push this folder to a Git repo and use **Extensions > Install extension**, or
   - copy (or symlink) the folder to
     `SillyTavern/data/<your-user>/extensions/SillyBotCollection/`.
3. Reload SillyTavern. Open the browser dev tools console (F12) and keep it open.

Pass criteria for the whole run: no red errors from
`/scripts/extensions/third-party/...` in the console, and the access key never
appears in the console or in any request URL (Network tab, filter `8790`).

## 1. Load (1 min)

- [ ] **Extensions** panel shows a **Silly Bot Collection** drawer. Expanding it
      shows "Not connected", a **Browse characters** button and a **Blur NSFW
      images** checkbox (checked).
- [ ] The wand menu (next to the chat input) has a **Silly Bot Collection** item.
- [ ] Manage Extensions lists "Silly Bot Collection 0.1.0" with no load error.

## 2. Onboarding and key errors (2 min)

Open the panel from the wand menu. Expand **Advanced** and set the server
address to `http://localhost:8790/api/v1` before connecting.

- [ ] **Open site settings** opens `http://localhost:8790/settings` in a new tab.
- [ ] Type `hello` and press Enter: "That does not look like an access key".
- [ ] Paste the **invalid** key: "This access key is not valid or was revoked".
- [ ] Stop the mock server (Ctrl+C), paste the **valid** key: "Could not reach
      the server...". Start the mock again.
- [ ] Paste the **unverified** key: the panel opens, header says "Not verified".
      Open any character: the Import button is disabled and the text says the
      verified role is needed.
- [ ] Click **Disconnect**: back to the connect screen with "Disconnected...".
      The drawer says "Not connected".

## 3. Browse (2 min)

Connect with the **valid** (full access) key.

- [ ] Header: "Connected as Tester (full access)", "Verified", "NSFW access".
- [ ] **For you** shows a grid of portrait cards; skeletons flash first (the
      mock adds 250 ms latency).
- [ ] **Browse**: switching Latest / Popular / Trending reloads; **Include
      NSFW** adds Nyx and Velvet, blurred with an NSFW badge.
- [ ] Scroll to the bottom of Browse: more cards load by themselves, then
      "That's everything."
- [ ] **Search**: type `araya`; results appear after a short pause, without
      pressing Enter. Press Escape in the box: it clears and the panel stays open.
- [ ] Search `onerror`: the card named `<img src=x onerror=alert(1)>` shows that
      text literally. No alert, no broken image.
- [ ] Toggle the heart on a card, switch to **Liked**: it is there. Same for
      the bookmark and **Bookmarks**.
- [ ] Keyboard: Tab reaches the tabs and cards with a visible focus ring;
      Enter on a card opens it; Escape in the detail view goes back to the
      grid (the popup must stay open); Escape again closes the panel.
- [ ] Switch SillyTavern to a light theme (User Settings > UI Theme): the panel
      follows it.

## 4. Import (3 min)

- [ ] Open **Araya**. Detail shows image, creator, tags, description, first
      message, "Lorebook: Included (2 entries)".
- [ ] **Import**: dialog "Import Araya into SillyTavern?" lists the character
      and "Lorebook with 2 entries". Confirm.
- [ ] A success toast appears, and a green "Araya is now in SillyTavern" banner
      with **Open character**.
- [ ] Without reloading, the character list contains **Araya**.
- [ ] World Info (book icon) lists **Araya's Archive** with 2 entries.
- [ ] Press **Open character**: the panel closes and the chat with Araya opens.
      **No** "This character has an embedded World/Lorebook" prompt or toast
      appears. In the character panel, the globe (World) button is highlighted
      and set to "Araya's Archive".
- [ ] If your "Import Card Tags" setting is "Ask", SillyTavern's own tag dialog
      appeared during the import; with "All", the tags fantasy/female/mystery
      are on the character.
- [ ] Back in the panel, Araya's card shows **Imported**.
- [ ] Import Araya again: the dialog offers **Update existing**, **Import as a
      copy**, **Cancel**. Choose **Update existing**: no second Araya appears.
      Choose **Import as a copy** next time: a second Araya appears and a
      lorebook named "Araya's Archive (2)" is created (yours is untouched).
- [ ] Open **Scrapbot** (no embedded lorebook, fallback path) and import it:
      World Info gets **Scrapyard Lore** (2 entries), linked to Scrapbot.
- [ ] Open **Kaito** (no lorebook) and import: the dialog says "No lorebook".

## 5. Gating and rate limit (1 min)

- [ ] Disconnect, connect with the **sfwOnly** key: no NSFW cards anywhere,
      the "Include NSFW" chip is dimmed and explains why when clicked, and
      there is no blur toggle in the header.
- [ ] Search `ratelimit` (first time for that key): results still arrive after
      about a second (one automatic retry after `Retry-After: 1`).
- [ ] Search `servererror`: an error state with **Retry** appears.

## 6. Mobile layout (1 min)

- [ ] In dev tools, toggle the device toolbar (e.g. 390 px wide) and reload.
      The panel fills the screen, cards are two per row, the tabs scroll
      sideways, the detail view stacks the image above the text, and nothing
      scrolls horizontally.

## Clean up

Stop the mock server (Ctrl+C). Delete the test characters and World Info
entries, or the throwaway user.

If any step fails, note the step, the console error and the SillyTavern
version (shown at the bottom of User Settings) and open an issue.
