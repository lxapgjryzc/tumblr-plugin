# Tumblr Tag Helper

A Chrome extension for managing Tumblr tags:

- **On tumblr.com**: tag autocomplete while you post and while you search a blog, tag templates, and upgrades to Tumblr's own mass post editor.
- **Manager page**: a full-page manager for your posts and tags, opened from the toolbar icon.

Both share one tag library, built from the tags of published posts on your main blog and all your side blogs, and the same packs and settings.

## Install

Until it is on the Chrome Web Store, install it by hand:

1. Download this repository and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension` folder.
3. Log in to Tumblr in the same browser, then click the extension's toolbar icon.

## On tumblr.com

- **Post editor**: typing in the `#tags` field suggests your own tags, ranked by how often you use them and by which tags you usually use together.
- **Tag templates**: the ▦ button at the right end of the `#tags` field opens a panel built from a template pack you install (see below). The left side lists what you can pick and never moves; the right side shows what you picked, the relations between them and the tags that will go in. The panel opens beside the tags field without covering it and keeps its size while open. After an insert, fix a wrong pick and press "Update tags": the tags the panel inserted last time are replaced by the new list, in order, and tags you typed yourself stay. "Undo insert" takes out everything the panel inserted. (This is remembered until the editor is closed.)
  - Pick characters, works and formats, search them by name, alias or tag, or pick a preset that selects a whole cast at once.
  - When everyone in a ship or group is picked, the panel offers it, one row per set of people, labelled with its type (for example romance, friendship or family). Tick any that apply, or "neither".
  - The preview lists the tags most popular first, the order they're inserted in. The total is always shown, with a warning above 20 (blog search reads only the first 20 tags) and above 30 (sitewide search reads only the first 30). There is no hard limit.
  - **Nothing is dropped for being unpopular.** Weak tags are flagged, with the reason on hover: no recent posts and no followers, the tag's search mostly shows other tags, or its popularity is in the bottom 20% of the list (adjustable). A tag that is the only one carrying some search word (often a supporting character's only tag) is never flagged as cold, so "Turn off flagged" can't take anyone off the post. Click any tag to turn it on or off. The same rules decide what the pack review and the manager's cleanup call weak.
  - **Tags mostly used by another fandom start off**, since they would bring the wrong audience. A tag counts as another fandom's when few of its recent posts carry any of the pack's base tags.
  - With 4 or more characters picked, each one keeps its 2 most popular spellings (both adjustable). The others are listed and can be turned back on.
  - Save combos you use often. "Check activity" samples the tags that have no recent popularity data.
- **Template pack upkeep** ("Suggest changes" under "Packs & settings"): samples every tag in the pack, then lists for each character and relation:
  - tags to remove: used mostly by another fandom (ticked by default), no recent posts and no followers, fuzzy search, or relatively cold (by the rules under "Packs & settings"; a spelling that alone carries a search word is never suggested for being cold);
  - tags to add: tags often used together with it, after checking that they belong to the same fandom.
  Ticked changes are written into the installed pack, which is then marked as edited. "Copy pack JSON" copies it so you can publish it. Updating an edited pack from its URL asks first.
- **Blog search**: typing in a blog's search box suggests that blog's tags, and picking one opens `/blogname/tagged/tag`.
- **Ad hiding**: blocks the ad networks and hides the ad cells in timelines, Blaze-promoted posts, the sponsored box in the right rail, the "go ad-free with Premium" box above it and the "Get Premium" button in the left menu. "Hide recommendations" (off by default) also hides Radar, recommended blogs and the "check out these" carousels. Both are in the manager's Settings.
- **Official mass editor** (`/mega-editor/published/<blog>`): also "Tag templates", which edits the selected posts with the template: the panel starts with the characters and relations the posts already carry ticked (those only some posts carry are shown dashed and left alone unless clicked); tick someone to add them to every selected post, untick to take their tags (and old spellings) off every selected post. Posts whose tags don't change keep their order; and "Tidy tags by packs", which first lists what it would change on the selected posts (old spellings your packs have retired, missing search spellings, the same as the manager's Packs page) and applies only the changes you leave ticked.
  Plus:
  - **Make public**: a new button next to "Make private".
  - **Sort tags by popularity**: reorders each selected post's tags in template order (see "Tag order" below): the most popular tag of each subject first, then the rest by popularity.
  - **Remove content labels**: added to the content label popup, which officially can only add labels.
  - **Add tags**: the box suggests tags from your library, related tags first.
  - **Edit tags**: the popup is wider and has a filter box and select all / none. Each tag shows how many of the selected posts carry it (for example `3/5`), and ⊕ adds the tag to the selected posts that lack it. URL-encoded tags such as `yuuto%20%28arc%20v%29` are also shown decoded.
  - **Tiles**:
    - drag across tiles to select or deselect them
    - Shift+click to select a range
    - Ctrl+A to select all
    - all three stop at the editor's limit of 100 posts
    - hovering a tile shows its tag names
    - private posts get a badge

### Template packs

A template pack is a JSON file. Install it from a URL, a file or pasted text under "Packs & settings" in the template panel, or on the manager's Packs page. A pack installed from a URL can be updated from there later.

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

## Manager page

The manager page has six sections:

- **Posts**:
  - Browse published posts, drafts or the queue of any of your blogs as a grid, optionally filtered by tag.
  - Select posts by clicking, dragging, Shift+click or Ctrl+A.
  - **Edit by template**: the side panel shows the characters and relations of a pack on the selected posts (solid: on all, dashed: on some, with counts). Click to take someone off all of them (or, if dashed, to put them on all), add someone from the search box, and apply: their template tags are added to or taken off every selected post (old spellings too), and the changed posts are put in template order. It uses the template options from Settings.
  - **Tags**: one card lists the tags on the selection with counts. Click tags to mark them for removal, or ⊕ to add a tag to the selected posts that lack it. Below it, type new tags to add to every selected post.
  - The side panel also makes posts public or private, and adds or removes community labels.
  - **Sort tags by popularity**: reorders each selected post's tags in template order: the most popular tag of each subject first (the work, then characters, then relations, then the rest), then the rest by popularity. Tumblr's search is said to use only a post's first tags, so this keeps every subject within reach. Popularity compares, in order: how many people follow the tag (read from the tag page), the typical note count of its recent posts, and how many new posts it gets per day. The numbers are cached for 7 days and shared with the cleanup. Only the order changes; no tag is added, removed or rewritten.
- **Cleanup**: finds weak tags and removes only the ones you tick. Tags your installed packs know (their characters' and relations' tags, old spellings, base tags) are never listed: the Packs page looks after them, so the cleanup can't remove a tag the templates would put back. A tag is listed if it:
  - is mostly used by another fandom: it is on your posts of a pack's fandom, but few of its recent posts carry that pack's base tags;
  - has no recent posts and no followers;
  - returns mostly other tags when you search for it, because Tumblr's tag search is fuzzy, so a search for `yuri (arc v)` also returns posts tagged `yuri` or `arc v`;
  - is relatively cold: its popularity is in the bottom N% of all your tags (by followers, then typical notes, then posts per day);
  - or gets few notes on your posts.
  The cold and search thresholds are the shared rules in Settings, the same ones the template flags use.
- **Tag library**: sync, search, hide tags from suggestions, add tags manually.
- **Packs**: install template packs (URL, file or pasted JSON; URL installs can be updated), and bring old posts in line with them. A scan lists, per change, the old spellings a pack has retired on your synced posts (only posts that carry the pack's base tags), how many posts each touches and a few examples. Ticked changes replace the old spelling in place, or remove it when the post already has the current spelling, and add to a character or relation already on a post the spellings people search for that the post lacks ("yuuto arc v" next to "yuto arc v"), right after its own tags. Tags the pack doesn't know never change. The packs also tell the tag sorting whose tag is whose.
- **Reblogs** (between my blogs): reblogs of your own posts on your other blogs are marked "Synced" and can't be selected; every edit the extension makes to an original goes to its reblogs too (tags, visibility, community label). Every 10 minutes, while the browser is open and logged in, the extension also works unattended on the newest posts of each blog: a post published on a side blog (on tumblr.com or in the app) after this was turned on is reblogged to your main blog with the same tags and label, and a reblog that drifted from its original is brought back in line. What it did is listed on the same page. "Check reblogs" lists reblogs that drifted from their original (fix them in one go) and side-blog posts your main blog hasn't reblogged yet (reblog them now or into the queue). The tag library counts a post and its reblogs once.
- **Settings**: language, delay between edits, auto-sync, hiding ads on tumblr.com, and (off by default) hiding Tumblr's own recommendations: Radar, recommended blogs and the "check out these" carousels. The extension blocks the ad networks themselves (only for requests made by tumblr.com pages), so ads are never loaded, and hides the empty slots. Also here: the weak-tag rules (cold share, search match) used by the template panel, the template card and the cleanup, and the template options (base tags, spellings kept per character). The template panel's "Packs & settings" changes the same values.

## Notes

- The extension uses the Tumblr web client's internal API with your logged-in session. It is undocumented and may break when Tumblr changes it.
- Bulk edits run one post at a time and always ask for confirmation first. They only touch the tags you add or remove; every other tag stays exactly as stored. Posts made with the legacy editor are skipped so their formatting is not damaged.
- Community labels are set through undocumented fields, so every change is re-read and reported as failed if it did not take effect.
- The interface is in English and Chinese and follows your browser language. Other languages fall back to English, and translations are welcome as pull requests: add a `STRINGS` entry in `src/core.js`.

## Development

```
npm install
npm test
```

- `src/core.js` holds the shared logic.
- `extension/` holds the extension: `content.js` (tumblr.com pages), `mega-main.js` (the mass editor's jQuery autocomplete), `noads.js`, `manager.*` and `background.js`.
- `node build.js` (also run by `npm test`) copies `src/core.js` to `extension/core.js` and writes the version from `package.json` into `extension/manifest.json`.
- `test/core.test.js` unit-tests the pure helpers; `test/` also holds jsdom smoke tests against a fake Tumblr API: one for tumblr.com pages (a copy of the official mass editor and the post editor), one for the manager page.

## License

MIT
