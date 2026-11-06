# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

### Application and companion ownership (user revision, 2026-11-06)

Tumblr Studio is the primary product; the extension is a thin browser companion. `docs/DESKTOP_PRODUCT_SPEC.md` section 4.3 and A52–A55 define ownership. The app owns the composer, management, category/pack administration, AI, authoritative data/settings, durable jobs and automation. Keep only browser-local or substantially more convenient in-page functions in the extension: hiding/filtering, input suggestions, template insertion using app-owned data, contextual Open/Send to Studio and validated browser-only adapters for app-owned operations. No second manager, AI executor, business queue or scheduler; disconnecting never restores standalone execution. Migrate retained collection capabilities and data explicitly without expanding material scope or rewriting frozen reblogs. `docs/SPEC.md` and architecture details below describe legacy code for migration, not a mandate to retain its standalone product. Current write guards/export controls do not fulfil the final split.

### Global reblog contract (user revision, 2026-11-06)

Read `docs/REBLOG_POLICY.md`; it overrides legacy copy-sync and collection-write descriptions below. Every created reblog freezes its own content, layout and ordered tags. Never edit those fields afterward, including through `syncCopies`, `copyFrom`, template upkeep, tag sorting or collection AI. A source content/image/layout change creates a new observed content revision and is delivered as a new reblog under an enabled route or explicit action; tag-only changes do not create a version or trigger another reblog. Store creation-time tags separately from content-version identity. Keep old snapshots, dedupe per source/content revision/destination, and retain deletion tombstones per version. Visibility remains an explicit separate operation that must preserve the snapshot payload. Apply this to desktop, extension and materials. Implemented 2026-11-06: the desktop tracks `source_revisions` and `deliveries` (`desktop/src/service/routes.js`, tests `desktop/test/reblog-policy.test.js`); in the extension `editPost` refuses any body/tag change on a reblog (`isReblogPost`), `syncCopies`/`copyFrom`/drift repair are gone, and `autoMaintain` only creates new reblogs. The architecture notes below describe existing code, not permission to retain conflicting behaviour.

A Chrome extension (MV3) in `extension/`: the browser companion of Tumblr Studio (content scripts on tumblr.com plus a companion page; the manager page was removed in 0.11.0). It is installed unpacked (not on the Web Store).

Code comments and docs are in English. The user usually writes in Chinese.

- `npm install` once, then `npm test`. This runs `node build.js`, syntax checks, the unit tests and the smoke tests (`test/smoke-content.js`, `test/smoke-companion.js`).
- **Never edit `extension/core.js` by hand.** `build.js` copies it from `src/core.js`.
- **Version**: the version in `package.json` is the single source. The build writes it into `extension/manifest.json`. Bump it for every release.

## Architecture

### `src/core.js`

Shared, DOM-free logic exposed as the `TTHCore` object. It is loaded as a content script (before `noads.js` and `content.js`, which share its world), with `<script>` in the companion page and with `importScripts` in the service worker.

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

### `desktop/` (Tumblr Studio, Electron)

Version maintenance must meet `docs/REBLOG_POLICY.md` section 2.1 and R12–R17 / A56: one app-owned version history, comparisons, exact-instance batch visibility/deletion, local notes and safe delivery recovery. Listing revisions alone does not finish this workflow. The one-off old-public-version hiding shortcut is not a new automatic cleanup rule. CC Switch reuse (design 4.4 / A57) was dropped by the user on 2026-11-06: AI stays a manually entered address, model and key in Settings; don't read CC Switch or start local AI clients.

Confirmed category design (2026-11-06): follow `docs/DESKTOP_PRODUCT_SPEC.md` sections 6.2–6.3 and A48–A51. General categories are configurable groups for creative subject, intended role, course and record type; every group may be empty, including at publication. Preserve photo/writing as extensible expression-form choices. Keep display names separate from actual tag mappings, category-prefix deduplication and saved draft selections. Implement full-tag combined filtering against the appropriate current work or exact historical instance, never a union of versions. Migrate flat categories additively without remote edits; course names belong in configuration. Current flat-category code and its mandatory-category gate are pending migration, not the new contract. Category/tag-only changes do not create a reblog content revision.

The desktop app from docs/DESKTOP_PRODUCT_SPEC.md (a Codex draft: keep its confirmed requirements, make your own implementation choices and record departures in `desktop/README.md`). `cd desktop && npm install && npm test` (node:test, Node 24+ for `node:sqlite`); `npm start` runs it, `npm run pack` builds `dist/Tumblr Studio-win32-x64/`.

- `src/service/` has no Electron and is tested against `test/fake-tumblr.js`. Every remote write is a job in `jobs.js` (persisted first, verified by polling, creates reconciled and never resent). Edits always send the full post (`posts.editBody`) and wait for the `edit.labels` capability.
- It reuses the extension's `src/core.js` through `src/service/core.js` (vm). Packaging copies it in as `tthcore.js`.
- Strings: en + zh in `src/renderer/i18n.js`, parity checked.
- Dev aids: `STUDIO_FAKE=1` (demo account), `STUDIO_DATA`, `STUDIO_SNAP`/`STUDIO_PAGE`/`STUDIO_JS` (screenshot and quit). Use these to check the UI visually.
- Browser companion bridge (`src/service/bridge.js`, loopback HTTP on 127.0.0.1:47823–47825 started by `main.js`, not Native Messaging): pairing approved in an app dialog, token bound to the extension id and account, Host/Origin checks; `/snapshot` is the read-only data for in-page help; `/request` takes a fixed list of kinds (`open`, `focus`, `collect`, `import`) with an operation id, and the app runs them as its own jobs. Materials (collecting likes, palette/AI decided before the reblog is created, quick study) are `src/service/material.js`.
- Moved from the extension's manager: `tidy.js` (weak tags, tidy by packs, pack review, category retag; page Tag upkeep), `aiart.js` (AI-image check of material, results local only; delete + unlike as confirmed jobs). The `post.tags` job takes `add`/`remove`, `set`, `upkeep` (rule ids, recomputed at run time from `ctx.packs()`) or `replace` (`{from, to}` in place).
- Version maintenance: `versions.js` ("Versions & reblogs" dialog). `post.delete` is shared: `reason: 'version'` (any owned reblog, never an original; tombstones the delivery) or the material default (reblogs on material blogs only). New revisions store `source_revisions.snapshot`; notes in `version_notes` are local only.
- Automatic hiding (display rules) exists to keep the user's own originals from filling tag search (they post a lot in small fandoms). Reblogs never appear in tag search, so rules hide originals only: imported "show only recent" becomes an originals-only rule; never default a rule to include reblogs. A rule or automation change starts a pass within 5 s (`svc.passSoon`).
- Visitor checks: `visitor.js` hooks `ctx.afterVisibility` (called by `ops.visibility` on success) and runs `post.publicCheck` through the public API with `bearer: false`; an error is `unknown`, never "hidden".
- A development run with `STUDIO_DATA` gets its own Electron profile (`userData`), so it can run next to the installed app.
- A create whose response was lost stays `unknown` until reconciliation finds it or the user picks "It wasn't created" (`jobs.resolve` → handler `abandon`); never let it turn into `failed` or be cancelled on its own.

### `extension/content.js` (tumblr.com pages)

Runs in the content-script world, so it can't reach the page's `window.tumblr` or jQuery. `request` calls `/api` with the web client token, read from the page's scripts or from `/dashboard` (`parseAuth`), and retries once on 401.

- **Data**: the app's read-only snapshot in storage key `studio` (tag library, packs, rules, roles; the service worker refreshes it every 15 minutes while paired); the older keys `cache`, `settings`, `packs` are only a fallback, and `templates` holds the panel's own state. Every API write is refused by `guardWrites(request, () => true)`. `chrome.storage.onChanged` keeps the tab's copies current. Every write also sets `writer` to this tab's mark so the tab skips its own changes (otherwise a sync would have its `cache` swapped out mid-run); `cache` changes are ignored while syncing.
- **Every page**: `bindInputs()` hooks the post editor's `#tags` input (`placeholder^="#"`) and a blog's search box. Suggestions use a shared dropdown inside a shadow root. Its keyboard handling is a window capture-phase listener that runs before React.
- **Tag templates**: `tpl` combines the snapshot's packs and rules (read only), `settings.useBase` and `templates` (current pack, picks, saved combos, per-tag on/off overrides); `saveTpl` writes them back to their keys.
  - The ▦ button is positioned over the right end of the tracked `#tags` input.
  - The panel lives in the shared shadow root and stops key events from reaching Tumblr's shortcuts.
  - Insert sorts with `sortTagsFair` and calls `commitNative` once per tag.
  - Only the pick view remains (picks, saved combos, insert). Pack install, review and upkeep are app work; "Manage ↗" sends `openStudio`.
- **Official mass editor** (`initMassEditor`), a legacy jQuery page:
  - Tiles are `a.brick#post_<id>`, and their inline onclick toggles `.highlighted`.
  - **Selection limit**: more than 100 selected makes the page call `alert()`. Selection helpers go through `brick.click()` and stop at 100.
  - **Labels**: the official tag removal reads the checked `<label>`'s HTML. Never change those labels; decoded names are added beside them.
  - **Autocomplete**: jQuery UI 1.8 is fed via `$('#tag_editor_input').autocomplete('option', 'source', fn)`. That runs in `mega-main.js` (`world: "MAIN"`), which asks `content.js` with a `tth-suggest` event (JSON in `detail`) and gets `tth-suggest-res` back; `megaSuggest` works out the list.
  - **Edits**: none from the extension; the page's own buttons edit, and bulk edits it lacks are in Tumblr Studio.

### `extension/`

- `noads.js` (content script, `document_start`) hides ads, recommendations and (by `aiArtVerdict`) AI-made images, following `settings` live.
- `background.js` (service worker, `importScripts(core.js)`): no business work (no sync, reblog, expiry, collection passes or AI). It opens `companion.html` from the toolbar icon, toggles the ad-network ruleset, pairs with the app and refreshes the `studio` snapshot (alarm `tth-studio-snapshot`), sends typed requests (context menu and page buttons: Open / Collect with Tumblr Studio) and on update removes older versions' alarms. With the app closed, actions say so; nothing is queued.
- `companion.html/js`: served by the app at `http://127.0.0.1:<port>/companion/` while it runs (the toolbar icon opens that; `chrome-extension://…/companion.html` is the fallback). On the app's page it has no `chrome.*`: `companion-host.js` (content script on those URLs, needs the `tumblr-studio-companion` meta) answers `postMessage` calls with the fixed `makeCompanionOps` list from `companion-ops.js`, never raw storage. It shows connection status and pairing, the one-time import of older data into the app (collection settings arrive switched off, the AI key is never sent), browser-only preferences, and a list of where every former manager feature lives now (cleanup, pack upkeep and the AI-art check are marked "not in the app yet").
- Legacy core code (`autoMaintain`, `autoRecent`, `collectPost`, `aiTagImage`, `syncAll`, …) stays in `src/core.js` because the desktop reuses it through `src/service/core.js`; nothing in the extension calls the writing parts. Under REBLOG_POLICY `editPost` still refuses tag/body changes on any reblog.
