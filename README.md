# Tumblr Tag Helper

The browser companion of **Tumblr Studio**, the desktop app in [`desktop/`](desktop/). The app is the product: posts, publishing, categories and template packs, the tag library, materials (collecting likes), AI and every background job live there ([ownership](docs/DESKTOP_PRODUCT_SPEC.md#43-companion-responsibilities)). This extension keeps only what works best inside tumblr.com pages, using the app's data, and never writes to your posts itself.

[REBLOG_POLICY.md](docs/REBLOG_POLICY.md) applies everywhere: a reblog keeps the content and tags it was created with; a changed source is delivered as a new reblog by the app.

Until 0.10 the extension had its own manager page and background passes (reblog sync, show-only-recent, collecting). 0.11.0 removed them; their data moves into the app once (see below).

## Install

1. Download this repository and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension` folder.
3. Start Tumblr Studio, log in to Tumblr in the same browser, and click the extension's toolbar icon. On the companion page, connect to the app and allow the connection in the app's dialog.
4. If you used an older version, click "Send to Tumblr Studio" there once (or "Download as a file" and import it in the app): blog roles, packs, tag statistics, rules, "show only recent", collecting settings and material records go over; the AI key is not sent, and collecting arrives switched off so you can check it in the app first.

The companion page also lists where each former manager feature lives now. Not in the app yet: tag cleanup, pack upkeep of old posts and the AI-image check of the collection.

## On tumblr.com

- **Post editor**: typing in the `#tags` field suggests your own tags, ranked by how often you use them and which tags you usually use together (from the app's tag library).
- **Tag templates**: the ▦ button at the right end of the `#tags` field opens a panel built from the app's template packs. Pick characters, works and formats (or a preset), tick the relations it offers, and insert. The preview lists the tags in the order they go in, with warnings above 20 (blog search) and 30 (sitewide search); weak tags are flagged, never dropped, and tags mostly used by another fandom start off. After an insert, "Update tags" replaces what the panel inserted last time and "Undo insert" takes it out. Saved combos are kept in the browser. "Manage ↗" opens the packs in the app.
- **Blog search**: typing in a blog's search box suggests that blog's tags, and picking one opens `/blogname/tagged/tag`.
- **Open / Collect with Tumblr Studio**: right-click a post link, or anywhere on a post's page, to open its work in the app, or to have the app collect it onto your material blog. The app reads the post itself and shows the job in Activity. With the app closed, nothing is done or queued; you're told to start it.
- **Hiding**: blocks the ad networks and hides ad cells, Blaze posts and Premium prompts; optionally hides recommendations (Radar, recommended blogs, "check out these") and posts their posters tagged as AI-made. These are browser preferences on the companion page.
- **Official mass editor** (`/mega-editor/published/<blog>`), reading aids only (the page's own buttons do the edits):
  - the "Add tags" box suggests tags from your library;
  - the "Edit tags" popup is wider, with a filter box, select all / none, per-tag counts on the selection (`3/5`) and decoded names for URL-encoded tags;
  - drag across tiles, Shift+click a range, Ctrl+A (all stop at the editor's limit of 100);
  - hovering a tile shows its tags; private posts get a badge; multi-image posts show a mosaic; reblogs of your own posts are greyed out.

### Template packs

A template pack is a JSON file. Packs are installed, reviewed and kept up to date in Tumblr Studio (Categories & templates); the template panel here uses the app's copies.

Maintained packs live in [`packs/`](packs/). Install one from its raw URL, for example `https://raw.githubusercontent.com/lxapgjryzc/tumblr-plugin/main/packs/ygo-arcv.json`.

**What a pack holds and what the tool does.** A pack holds the facts about one fandom, as data only. Everything else is generic code, and your own choices are settings:

| | Holds |
|---|---|
| **Pack** (fandom facts) | Which characters, relations, works and formats exist, and the tags for each, best first. The base tags that say "this is the fandom": they decide whether a tag belongs to another fandom, and they count as the work when ordering tags. `retired`: old spellings that identify an item on old posts but are never inserted again. |
| **Tool** (any fandom) | Sampling tag popularity, ordering tags, grouping tags by subject when no pack covers them, the cleanup and cold-tag rules, the 20/30 search cutoffs, and the upkeep that brings old posts in line with a pack. |
| **Settings** (yours) | How many spellings each character keeps, the cold thresholds, tags you switched on or off by hand. |

**Tag order.** The first tags cover everything in the post: the most popular tag of each subject, the work first (one tag: all its names, such as yugioh, ygo and arc v, are one subject), then characters, then relations, then the rest (formats and other tags). Then everything else by popularity. So a popular character's many spellings can't push a less-followed one out of the first 20. Only when a post has more than 20 tags, spellings that add a search word no earlier tag has are moved up just enough to stay within the first 20: Tumblr search matches words and isn't fuzzy, so someone searching "yuuri" never finds a post tagged only "yuri arc v". Packs keep such spellings even when few people follow them, but always with the work's name ("yuuri arc v", never a bare "yuuri"), so the post doesn't land on another fandom's tag page.

```json
{
  "format": "tth-template-pack", "id": "my-fandom", "name": "My fandom", "version": "1",
  "base": ["my fandom", "mf"],
  "types": { "romance": "Romance", "friendship": "Friends", "family": "Family" },
  "characters": [
    { "id": "alice", "name": "Alice", "group": "Main cast", "kw": ["ali"], "tags": ["alice smith", "smith alice"] },
    { "id": "bob", "name": "Bob", "group": "Main cast", "tags": ["bob jones"] }
  ],
  "relations": [
    { "id": "alicebob", "members": ["alice", "bob"], "type": "romance", "kw": ["alicebobshipping"], "tags": ["alicebobshipping"] },
    { "id": "alicebob-f", "name": "Alice & Bob", "members": ["alice", "bob"], "type": "friendship", "tags": [] }
  ],
  "presets": [
    { "id": "cast", "name": "Main cast", "members": ["alice", "bob"], "relations": ["alicebob"] }
  ],
  "sections": [
    { "id": "formats", "name": "Formats", "kind": "format", "items": [
      { "id": "art", "name": "My art", "tags": ["fanart", "my art"], "base": false }
    ] }
  ]
}
```

- **Fields**:
  - `characters`: `tags` lists the spellings of one name, best first. `group` sets the heading they are listed under, and `kw` holds extra search words such as names in other languages.
  - `relations`: any number per set of members, each with a `type` from `types`. A relation without `name` is named after its members. A relation with no `tags` only marks the type.
  - `retired` (characters, relations and section items): old spellings. They identify the item on old posts, so upkeep can replace them, and are never inserted.
  - `presets`: picking one picks its members and relations, which can then be unticked one by one.
  - `sections`: anything else, such as versions of the work or formats. `kind` is `work` or `format` (or `char` / `ship` / `group`). `with` pulls in other items, and `"base": false` keeps the base tags out.
  - `base` tags are added whenever a picked item doesn't set `"base": false`. They also define the fandom for the another-fandom check.
- Older packs that use only `sections` (with `rel` on relation items and a `relations` object for the type labels) still load.
- **Packs are data only.** They can't run code.

## Notes

- The extension uses the Tumblr web client's internal API with your logged-in session. It is undocumented and may break when Tumblr changes it.
- The extension makes no changes to your posts itself. Every write (bulk edits, reblogs, collecting, visibility) is a job in Tumblr Studio.
- The interface is in English and Chinese and follows your browser language. Other languages fall back to English, and translations are welcome as pull requests: add a `STRINGS` entry in `src/core.js`.

## Development

```
npm install
npm test
```

- `src/core.js` holds the shared logic.
- `extension/` holds the extension: `content.js` (tumblr.com pages), `mega-main.js` (the mass editor's jQuery autocomplete), `noads.js`, `companion.*` (the companion page) and `background.js` (pairing, snapshot, requests to the app).
- `node build.js` (also run by `npm test`) copies `src/core.js` to `extension/core.js` and writes the version from `package.json` into `extension/manifest.json`.
- `test/core.test.js` unit-tests the pure helpers; `test/` also holds jsdom smoke tests against a fake Tumblr API: one for tumblr.com pages (a copy of the official mass editor and the post editor), one for the companion page and its connection to a fake app.

## License

MIT
