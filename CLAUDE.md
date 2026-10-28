# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Chrome extension (MV3) in `extension/`: content scripts on tumblr.com plus a manager page. It is installed unpacked (not on the Web Store).

Code comments and docs are in English. The user usually writes in Chinese.

- `npm install` once, then `npm test`. This runs `node build.js`, syntax checks, the unit tests and the smoke tests (`test/smoke-content.js`, `test/smoke-extension.js`, `test/smoke-reblogs.js`).
- **Never edit `extension/core.js` by hand.** `build.js` copies it from `src/core.js`.
- **Version**: the version in `package.json` is the single source. The build writes it into `extension/manifest.json`. Bump it for every release.

## Architecture

### `src/core.js`

Shared, DOM-free logic exposed as the `TTHCore` object. It is loaded as a content script (before `noads.js` and `content.js`, which share its world), with `<script>` in the manager and with `importScripts` in the service worker.

- **API**:
  - `makeApi(request)` wraps a page-specific `request(path, {method, body})` with retries.
  - Responses may be camelCase or snake_case, so always read fields with `pick(obj, 'camel', 'snake')`. Request bodies use snake_case.
  - Filter post lists with `isPost`, since they can contain non-post objects.
- **Edits**: `editPost(api, t, blog, id, mutate, verifyLabel)` fetches the post as NPF, applies `mutate(next, cur)` and PUTs back the content, layout, state, tags, label fields, reblog control (`next.reblog`, `readReblog`: `everyone` / `noone`) and `PASSTHROUGH` fields. `mutate` returns a string to skip the post; `mutations.*` are the common mutations. Legacy posts are skipped, and label changes are re-read to verify they took effect.
- **Tags**:
  - `norm()` URL-decodes a tag and `key()` is the lowercase identity used for comparisons.
  - When editing, keep a post's other tags exactly as stored (`withTags`, filter by `key`).
- **Library and cleanup**:
  - `buildIndex(cache)` computes tag counts, co-occurrence, per-blog pools and an id→record map.
  - `suggest()` ranks tags for autocomplete.
  - `syncAll`/`syncBlog` fill `cache.blogs[uuid].posts[id] = [tags, ts, state, notes]`.
  - `tagActivity()` samples `/v2/tagged`.
  - `ensureTagStats()` fills `cache.tagStats` (7-day TTL, `statFresh`).
  - **Weak tags**: `judgeTags(tags, stats, rules, { fandom, keepWords })` is the only place that decides a tag is weak: `offtopic` (`fandomShare` against the fandom's base tags below `OFFTOPIC_SHARE`, e.g. "kurosaki family" is mostly Bleach), `dead`, `fuzzy` (search match below `rules.matchMin`) or `cold` (bottom `rules.coldPct`% of the given tags by `heatRanks`, needs `COLD_MIN` samples). With `keepWords`, a tag that alone carries a search word is never dead or cold. The template flags, the pack review and the extension's cleanup all call it with the same `TAG_RULES`-shaped settings; don't add another threshold elsewhere.
  - `suggestTagChanges(tags, stats, opts)` turns samples (`co` = co-occurring tags, `sample`) into add suggestions and `judgeTags` verdicts into remove suggestions for one character's or relation's tag list, for pack upkeep. It changes nothing itself.
  - `cache.tagStats` is the single shared popularity cache used by the cleanup, by `sortByHeat()` / `mutations.sortByHeat` and by the tag templates.
  - **Who owns which tag**: tags a pack knows (items' tags, `retired`, `base`; `packGrouping(packs).groups`) are looked after by pack upkeep and the pack review only. The extension's cleanup never lists them, so it can't remove what a template would put back.
- **Tag templates** (format in README):
  - `parsePack()` turns `characters` / `relations` / `presets` into sections (the older sections-only shape also loads), validates ids and adds an id→item map. Relation items have `rel` = type and `with` = members.
  - `composeTemplate()` expands picks through `with` and dedupes by `key`. Nothing is dropped for popularity.
    - `why` (row off): `off` (by hand), `offtopic` (`fandomShare` against the pack's base below `OFFTOPIC_SHARE`) or `extra` (spellings beyond `rules.spellings` once `rules.manyAt` characters are picked).
    - `flag` (row stays on): the `judgeTags` reason among the tags that go in (`dead`, `fuzzy`, `cold`), with the pack's words as `keepWords`.
  - `suggestCombos()` lists `rel` items whose members are all picked, grouped by member set. Several per set can be ticked.
  - `TPL_SEARCH_CUTS` = [20, 30]: blog and sitewide search index cutoffs, shown in the preview; there is no cap.
  - Packs are data only. Don't add anything that evaluates code from a pack.
  - **Split**: fandom facts go in packs (items and their tags, `base`, `retired` old spellings); generic logic goes in core and must not name any fandom; personal choices are settings. Core's `GENERIC_WORDS` holds plain English words only.
  - **Tag order** (`sortTagsFair`): one tag per subject first (work, then characters, then relations, then the rest; a pack's base and work items are one subject), then the rest by heat. Past the 20-tag cutoff, spellings with a new search word move up just enough to stay within it. `packGrouping(packs)` gives the subjects; `nameGroups` covers tags no pack knows.
  - Maintained packs are in `packs/` and Claude maintains them: keep supporting characters' tags, at least one tag per item, no punctuated tags, and nothing another fandom mostly uses.
- **i18n**:
  - `STRINGS` has only `en` and `zh`. `t()` falls back to `en`, and `makeI18n(getLang)` treats `''` as auto-detect, mapping any `zh-*` browser language to `zh`.
  - Add every new key to `en` and `zh` only. Other languages are left for contributors.

### `extension/content.js` (tumblr.com pages)

Runs in the content-script world, so it can't reach the page's `window.tumblr` or jQuery. `request` calls `/api` with the web client token, read from the page's scripts or from `/dashboard` (`parseAuth`), and retries once on 401.

- **Storage**: `chrome.storage.local`, the same keys as the manager (`cache`, `settings`, `packs`) plus `templates` for the panel's own state. `chrome.storage.onChanged` keeps the tab's copies current. Every write also sets `writer` to this tab's mark so the tab skips its own changes (otherwise a sync would have its `cache` swapped out mid-run); `cache` changes are ignored while syncing.
- **Every page**: `bindInputs()` hooks the post editor's `#tags` input (`placeholder^="#"`) and a blog's search box. Suggestions use a shared dropdown inside a shadow root. Its keyboard handling is a window capture-phase listener that runs before React.
- **Tag templates**: `tpl` combines `packs` (`{ raw, source, edited }`), `settings.rules` / `settings.useBase` and `templates` (current pack, picks, saved combos, per-tag on/off overrides); `saveTpl` writes them back to their keys.
  - The ▦ button is positioned over the right end of the tracked `#tags` input.
  - The panel lives in the shared shadow root and stops key events from reaching Tumblr's shortcuts.
  - Insert sorts with `sortTagsFair` and calls `commitNative` once per tag.
  - Views: `pick`, `manage` (packs and options; `tpl.rules` is `settings.rules`, the same rules the manager edits), `review` (Suggest changes) and `upkeep` (mass editor's Tidy tags by packs: `planUpkeep` on the selection, ticked rules only).
  - URL installs send `{ type: 'fetchText', url }` to the service worker, since the page's CSP blocks the fetch; `host_permissions` cover raw.githubusercontent.com and gist.githubusercontent.com.
  - "Suggest changes" (`reviewPack`): `ensureTagStats` on the pack, then `suggestTagChanges(item.tags, stats, { exclude: base, fandom: base, rules: tpl.rules })` per character and relation. Add candidates are sampled too and dropped when `fandomShare` is below `OFFTOPIC_SHARE`. `applyReview` edits `raw` in whichever shape it uses and sets `edited`.
- **Official mass editor** (`initMassEditor`), a legacy jQuery page:
  - Tiles are `a.brick#post_<id>`, and their inline onclick toggles `.highlighted`.
  - **Selection limit**: more than 100 selected makes the page call `alert()`. Selection helpers go through `brick.click()` and stop at 100.
  - **Labels**: the official tag removal reads the checked `<label>`'s HTML. Never change those labels; decoded names are added beside them.
  - **Autocomplete**: jQuery UI 1.8 is fed via `$('#tag_editor_input').autocomplete('option', 'source', fn)`. That runs in `mega-main.js` (`world: "MAIN"`), which asks `content.js` with a `tth-suggest` event (JSON in `detail`) and gets `tth-suggest-res` back; `megaSuggest` works out the list.
  - **Edits**: features the page lacks (make public, remove labels, ⊕ fill, templates, tidy by packs) call `editPost` through `runOnPosts`, which skips reblogs of my own posts and syncs them from the original.

### `extension/`

- `noads.js` (content script, `document_start`) hides ads and, if set, recommendations, following `settings` live.
- `background.js` (service worker, `importScripts(core.js)`): opens `manager.html` from the toolbar icon, answers `fetchText` for pack URLs, turns the ad-network ruleset on and off with the Hide ads setting, and every 10 minutes runs `TTHCore.autoMaintain` (reblog new side-blog posts to the main blog, fix drifted reblogs) while `settings.syncReblogs` is on; it logs to storage key `autoLog` and only reblogs posts newer than `autoSince`.
- Reblogs of my own posts ("copies", `copyKeys` / `isCopyOf`) are never edited directly: `runBatch` skips them and syncs them from the edited original (`syncCopies`). The cache record keeps the reblog source in `rec[4]` and the reblog control in `rec[6]`. Reblog control off means other accounts can't reblog; my own blogs still do: `reblogPost` reblogs it as is (Tumblr allows the owner's blogs; if refused it opens the original just for that reblog) and gives the reblog the same setting, and `copyFrom` / `reblogDiffs` carry it like the label.
- **Collection blog** (`settings.collect = { blog, auto, tags, imagesOnly, daily }`): liked posts reblogged onto one of my blogs with my tags. `likedPosts` pages `/v2/user/likes`, `collectSkip` decides (matched by `rootKey`, the original post), `collectPost` reblogs; `autoCollect` is the background pass (storage `collectSince` = newest liked timestamp handled, log `collectLog`). Its posts live in storage `collection` (`syncCollection`), and `dailyPick` picks the day's study images (seed in storage `dailySeed`). `REF_GROUPS` are the reference categories (English tags; Chinese names in `STRINGS.zh.refNames`); `paletteTags` works out the palette group from pixels (`imagePixels` / `postPalette`, needing the `*.media.tumblr.com` host permission), on reblog (`autoPalette`) and on request. The other groups are tagged by hand on the collection page, or suggested by an optional AI vision model: `settings.ai = { base, model }` (OpenAI-compatible), the key in storage `aiKey` (never in `settings`), `aiTagImage` sends `imageDataUrl` with `aiPrompt` and keeps only listed tags (`parseAiTags`); the endpoint's origin is an `optional_host_permissions` grant requested on click. Suggestions are written per post as soon as the AI is done with it (`settings.ai.autoApply`, default on) or reviewed first; every edit on the collection page goes through one queue (`orgRun` → `drainQueue`, one post at a time) so the AI (its own `aiCtl`) and hand edits run side by side without overwriting each other; an AI run also adds the pixel palette to posts without one; posts the AI has looked at carry the tag `AI_MARK` ("ai sorted", written with the suggestions; filter and badge read it), nothing is kept locally. Opening the collection page reads new posts (`freshenCollection`, at most every 5 minutes). Nothing about a provider or key goes in the code.
- **AI-made images**: `aiArtSignal` reads one tag or reply ('yes' / 'no' for "not ai" / null; links and a bare "ai" are no clue) and `aiArtVerdict` is the only rule: the poster's own tags decide ('ai'), else two or more blogs with none against, or a sure vision model ('suspect'). Collecting skips and unlikes 'ai' likes (`ownerTagsOf`); `aiArtCheck` adds notes and replies for the collection page, which tags `AI_ART_TAG` and deletes on request (`deletePost`, `unlikePost`). `noads.js` hides posts by the same rule while browsing when `settings.hideAiArt` is on. The collection blog is skipped by `syncAll` and `autoMaintain` (`skip`), so its other people's tags never reach the library and it never joins the main/side reblog sync.
- `manager.js` fetches `https://www.tumblr.com/api/...` directly with `credentials: 'include'`. The bearer token and CSRF token are parsed from `/dashboard`, and it retries once on 401.
- Storage is `chrome.storage.local` (`cache`, `settings` and `packs`). `settings.rules` holds the weak-tag rules and template options (`TPL_RULES` shape) used by the template panel, the template card and the cleanup; `settings.clean` holds only the cleanup's own notes rule.
- **UI**, one job per page:
  - posts: grid with multi-select; the side panel has one Tags card (tags on the selection: mark to remove, ⊕ to fill; add box; sort), the template card, visibility and labels
  - cleanup (tags no pack knows)
  - library
  - packs (install, upkeep)
  - reblogs (the sync switch, check, background log)
  - collection (collection blog settings, today's quick study, likes not collected yet, background log)
  - settings (general, weak-tag rules, template options)
  - Buttons dispatch through `data-act` → `actions`, and static text uses `data-i18n` / `data-i18n-ph`.
- `runBatch(title, mutate, {targets, ui, verifyLabel, onDone})` runs edits with progress. `ui` picks the element-id prefix, for example `clean` → `cleanProg` / `cleanLog`.
