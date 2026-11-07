# Tumblr Studio (desktop)

A local Windows app for writing, publishing and managing your Tumblr blogs. It works with the browser fully closed. The design brief is [docs/DESKTOP_PRODUCT_SPEC.md](../docs/DESKTOP_PRODUCT_SPEC.md); this file describes what is built and where the implementation departs from that brief.

Implementation coverage is not full product acceptance. See [implementation status and acceptance gaps](../docs/DESKTOP_IMPLEMENTATION_STATUS.md) for evidence boundaries, unfulfilled requirements and the community-label test. Implementation departures do not themselves approve a reduction in scope.

## Run

**Application/companion split:** the application is the primary product. The extension retains only browser-local helpers and contextual entry points into app-owned capabilities, with no duplicate manager, AI executor or business scheduler. Implemented 2026-11-06 as described under **Extension** below ([the ownership contract](../docs/DESKTOP_PRODUCT_SPEC.md#43-companion-responsibilities)); live browser acceptance has not been run.

**Reblog policy:** [REBLOG_POLICY.md](../docs/REBLOG_POLICY.md) freezes every reblog's creation-time content and tags. Implemented 2026-11-06 (fixture-tested, see the status document): only a new source body (text, images, layout) is a new version and gets its own reblog; tag-only changes send nothing; existing snapshots are never edited.

Packaged Windows build: open `dist/Tumblr Studio-win32-x64/Tumblr Studio.exe`. Keep the entire packaged directory together; it includes the runtime and needs no separately installed Node. This is an application directory, not a single-file installer. The commands below are for development.

```
cd desktop
npm install
npm start          # the app; closing the window keeps it in the tray, Quit is in the tray menu
npm test           # service tests against an in-memory Tumblr (node:test, Node 24+)
```

First start: **Settings → Tumblr connection**. Register an app at <https://www.tumblr.com/oauth/apps> with the OAuth2 redirect URL `http://localhost:8765/callback`, paste its key and secret, then **Connect**. If the stage 0 probe was authorised on this computer, **Use the stage-0 test authorisation** takes that over instead.

Data lives in `%APPDATA%\Tumblr Studio`:

| File | Contents |
|---|---|
| `studio.db` | SQLite store: blogs, posts, works, display policies, rules, routes, jobs, drafts, follower cases |
| `credentials.bin`, `ai.bin` | OAuth tokens and the AI key, encrypted for this Windows user (Electron safeStorage / DPAPI) |
| `assets/` | Images added to drafts, stored by content hash |
| `backups/`, `imports/` | Backups made in Settings → Data, and copies of imported extension exports |

Development aids: `STUDIO_FAKE=1` runs against a made-up demo account (no network); `STUDIO_DATA=<dir>` uses another data folder; `STUDIO_SNAP=<png>` (with optional `STUDIO_PAGE`, `STUDIO_JS`) saves a screenshot and quits.

## Layout

- `src/service/`: everything that matters, free of Electron and testable in Node.
  - `db.js`: schema and additive migrations.
  - `auth.js`: OAuth2 with rotating refresh tokens, a single refresh writer and atomic credential replacement.
  - `tumblr.js`: the official API adapter with a request budget.
  - `relay.js`: the browser relay, which sends allowed requests through the paired extension's tumblr.com session.
  - `jobs.js`: the single durable mutation queue.
  - `sync.js`: post sync with resumable coverage.
  - `groups.js`: works and management blogs.
  - `display.js`: visibility policy and expiry.
  - `ops.js`: verified full-post edits.
  - `routes.js`: automatic reblogs by source revision (`deliveries`).
  - `writing.js`: drafts, compile to NPF, grouped categories (`categories.default.json`), packs, publishing.
  - `followers.js`: follower protection.
  - `data.js`: extension import, backup and restore.
  - `api.js`: the request surface used by the window.
  - `core.js`: loads the extension's `src/core.js` so tag logic is shared.
- `src/main/`: the Electron main process (window, tray, IPC) and the preload bridge.
- `src/renderer/`: the interface (plain JS, en + zh strings in `i18n.js`).
- `test/`: `fake-tumblr.js` mimics the stage 0 behaviours (partial PUT refused, private originals can't be reblogged, stale reads). `demo.js` is the demo account.

## Built

- **Foundation**:
  - SQLite store and the durable job queue. Every remote write is persisted before it is sent, with a result per target.
  - After a crash, an edit runs again from fresh state, while a create enters reconciliation first. Reconciliation never decides on its own that a create failed: after five empty passes it keeps looking every 6 hours until found or until you choose “It wasn't created” in Activity.
  - Edits are polled for verification, because a read right after a write can be stale.
  - Rate budget and a 10-minute pass.
  - Tray with Pause and Quit, and an optional start with Windows.
- **Management**:
  - Works are built from real reblog identities.
  - A main-blog original reblogged by exactly one sharing side blog is managed there.
  - Two candidates → `ambiguous`, left alone.
  - A lost managing reblog → `needs_review`, and authority stays where it was.
  - Material blogs never manage.
  - Manual reassignment.
  - The Managed here and Displayed here views, and work details that list every owned instance separately.
- **Visibility**:
  - One preview and one Apply for bulk changes. The preview shows linked posts that are *not* included.
  - Make public → Keep visible, make private → Keep hidden.
  - Expiring soon view.
  - Per-blog and whole-work expiry rules, with an explicit mode choice, a dry-run preview, and restore that covers only this app's own hides.
  - External changes are respected, and conflicts are held.
  - Turning a rule off never publishes anything.
- **Writing**:
  - General categories in optional groups ([design 6.2–6.3](../docs/DESKTOP_PRODUCT_SPEC.md#62-tag-composition)): creative subject, intended role, course, record type and expression form (photo/writing), seeded once from `src/service/categories.default.json` (data, editable in the app). Every group may stay empty, also at publication. Display names are separate from tags (renaming never changes a tag). Selected tags are composed in group order, then category order. The old flat list migrates additively: same ids, tags, names and order, a category whose tag matches a seeded one joins that group, anything else stays in a visible “Ungrouped” area.
    - Default tags reuse tags already used on Tumblr (sampled 2026-11-06): 原创 `original art` (bare `original` is mixed), 同人 `fanart`, 习作 `art study` (bare `study` is studyblr), 过程记录 `wip`, 日记 `diary`, Photo `photography`, Writing `writing`; course names stay in full (no Tumblr use, no clash). Departure from design 6.2: the user does not use 正式作品 or 学习笔记, so they are not seeded. A one-time upgrade (`was` / `retired` in the defaults file, meta `categoryTagsUpgraded`) moves a category that still has a default name and an earlier default tag to the new tag, and removes a retired default only if it is untouched and no draft or blog default selects it. It changes local data only; old posts keep their tags (Tag upkeep's previewed retag can rename them).
  - Posts → “Categories & tags”: several conditions at once, all must hold, matched on whole tags. Managed here checks the current original; Displayed here checks each physical post's own tags (a historical reblog is never credited with its original's tags).
  - A visual block editor. Text with bold, italic, strike, links and subtypes; images; links; read-more.
  - Images are placed with buttons: insert here, ↑/↓, move to a chosen paragraph, side by side (2–3 adjacent), separate, replace with an alt-text check. Dragging is not used anywhere.
  - Undo and redo, autosave with revisions, and a compiled preview at wide and phone widths.
  - Category → template → extra tag order with the 20 and 30 search cutoffs, using the extension's packs and `sortTagsFair`.
  - The template picker works like the browser panel (0.4.4): sections, presets that pick their members, relations offered once their members are picked ("neither" hides a row), what a pick pulls in, saved combinations (`tplFavs`, the app's own), and in the final list a click turns a template tag off or back on (`overrides` in the draft options; left-out tags are listed with the reason), "Turn off flagged" and "Check heat" (`sampleTags`).
  - Per-blog remembered choices that never overwrite a draft's own choices.
  - Publish, publish privately, Tumblr draft, queue or schedule. A lost create response triggers a search on Tumblr; identity, coverage and unresolved-outcome handling still need the acceptance work recorded in the status document.
- **Routes**:
  - Sources → destination.
  - Excluded tags skip a whole post, matched on whole tags case-insensitively.
  - Versions: every distinct body an original is seen with is a revision (`source_revisions`; content + layout fingerprint, never tags, state or notes; A → B → A is three revisions). `deliveries` keys source + revision + destination with the submitted tags, so rescans, restarts and rule edits send a revision once, an older copy never blocks a newer revision, and deleting one version's reblog tombstones only that version.
  - Copies already on the destination are claimed for the revision their trail holds; the migration carries old rows over as revision 1 with “version unknown” and re-sends nothing.
  - Source blogs of enabled routes get a full read every 6 hours, so edits to older originals are seen.
  - Before sending, the source is re-read: a changed body drops that plan (the newest revision is planned next pass), a private source waits. After sending, the copy's trail body and tags are compared; a mismatch is shown as a conflict, never patched.
  - A lost response looks only for an unclaimed copy of this revision made after the attempt; while it is unresolved, later revisions of that source wait.
  - Work details list each destination's versions; “Reblog the new version” is offered when the route is off. Tag edits apply to originals only; reblogs are listed as snapshots kept as they are.
  - Previewed backfill as before.
  - A refused reblog leaves reblog control alone.
- **Followers**:
  - The first scan is a baseline. New followers are resolved to a uuid before anything is attached.
  - Public evidence is split into own words and reblogged words, then checked against deterministic spam/scam patterns, with an optional AI explanation validated against a strict schema.
  - Allowlist ("Normal account"). Block and unblock per blog, verified against the block list. External blocks are never undone.
  - Reporting goes through Tumblr's own menu and stays "pending" until you confirm it.
- **Data**:
  - Import of the extension's export: roles, packs, tag statistics, rules and AI settings. `recentOnly` becomes switched-off, image-only rules. The extension's hidden posts are remembered.
  - Backup with checksums. Restore at next start keeps the old data aside and pauses automation.
- **Materials** (moved from the extension, `src/service/material.js`): liked posts are collected onto a material blog with your tags, the palette from the pixels and, if switched on, the AI vision model's tags and note, all decided before the reblog is created (a collected reblog is never edited). Every collect is a durable job; a lost response is looked for on the material blog. Today's quick study and the collected list are on the same page.
- **Tag upkeep** (`src/service/tidy.js`, page Tag upkeep; moved from the extension's manager): weak tags on originals of sharing blogs (core `judgeTags`, pack-known tags excluded), tidying old posts by packs (core `planUpkeep`; the job recomputes from the post's tags at run time) and the pack review (core `suggestTagChanges`; every item keeps at least one tag). Popularity samples go through the OAuth `/v2/tagged` (one request per tag, budgeted) into meta `tagStats`. Changing a category's tag offers a previewed retag of old originals (`retagPreview` / `retagApply`, replaced in place).
- **AI-made images** (`src/service/aiart.js`, Materials page): collected reblogs are checked against their originals (core `aiArtCheck`); results stay in meta `aiArt` and are never written onto the posts. "Delete reblogs" is a confirmed `post.delete` job per reblog on a material blog, verified by reading back, plus an optional `like.remove`.
- **Version maintenance** (`src/service/versions.js`, dialog "Versions & reblogs" in a work's details; REBLOG_POLICY 2.1, R12–R17): source versions with observation times, reblogs per blog with their own reblog times, states, keep-public exceptions and job states; a comparison of two versions (text, images added/removed/moved, layout; tags listed apart; "not comparable" when no body is stored); preview-first actions on exact reblogs (public, private, keep public, back to display rules, delete) that never touch the original; the one-off "keep newest public, hide older public"; re-sending through `routes.manualReblog`; local version names and notes (table `version_notes`). New revisions keep their body (`source_revisions.snapshot`, schema 9). A deleted version becomes a tombstone and is not recreated.
- **Visitor checks** (`src/service/visitor.js`, design `public_check`): after a verified visibility change, a `post.publicCheck` job looks at the post as a logged-out visitor (public API with the app key only) after 90 s, and again after 5 and 20 minutes while a hidden post is still seen. Results (`pending`, `visible`, `not_visible_at_check`, `unknown` on any error) are shown per instance with the time; "Check now" runs one.
- **Browser companion** (`src/service/bridge.js`, served by `main.js` on 127.0.0.1:47823–47825):
  - Pairing is approved in the app (a dialog naming the extension id); the extension gets a bearer token bound to that id and to the account. Only loopback Host and `chrome-extension://` Origin are accepted.
  - `/snapshot`: a versioned read-only copy of the tag library (sharing blogs), packs, rules, categories and blog roles for in-page suggestions and template insertion.
  - `/request` with a fixed list of kinds (`open`, `focus`, `collect`, `import`), each carrying an operation id so a repeat never makes a second job; the app reads the post itself and runs the work as its own job, shown in Activity.
  - `GET /companion/` (`src/service/companion-page.js`): the companion page itself, served by the app from a fixed file list with a strict CSP, so it is an ordinary web page. The extension's `companion-host.js` content script answers its calls with the fixed operations in `companion-ops.js` (state, browser preferences, pair, move data, export without key or token); the toolbar icon opens this page while the app runs and the extension's own copy otherwise.
  - Import of the extension's older data (roles, packs, tag statistics, rules, AI settings without the key, collection settings arriving switched off).
- **Extension** (0.11.0): only the companion page, in-page helpers (autocomplete, template insertion from the snapshot, mass-editor reading aids, hiding ads/recommendations/AI art), context-menu Open / Collect with Tumblr Studio, and no writes of its own (`guardWrites` always on). Its old manager, alarms and background passes are gone; with the app closed, app actions say so and nothing is queued.

## Where this departs from the brief, and why

These describe the implementation's choices and limitations. Optional mechanism changes are distinct from unfulfilled product requirements; see the status document for that distinction.

1. **Electron + `node:sqlite`.** This reuses the extension's tag and pack code unchanged and needs no native modules. The end user installs nothing else once it is packaged.
2. **Images are uploaded inside the create request.**
   - The brief planned separate uploads with per-occurrence upload states.
   - Image parts and the frozen document's content/layout are sent in the same multipart request, using occurrence identifiers. This avoids separate upload-completion ordering, but correct mapping and remote layout fidelity still require verification.
   - Missing files block publishing at the exact block.
   - Link addresses are sent percent-encoded: Tumblr silently drops a link whose URL contains raw non-ASCII characters (checked live 2026-11-07). If the post that comes back still differs, the failed job names the first difference (for example "block 2: Tumblr dropped the link formatting").
3. **No remote draft first.**
   - The brief suggested creating a Tumblr draft and then switching its state.
   - The intermediate draft adds a request and does not itself make creation idempotent. A lost response triggers a search of every post since the publish started, matched on all text blocks, image count, row grouping and tags. Several matches stop for the user; no match leaves the job unknown until it is found or you resolve it, so nothing is sent twice without your say.
4. **Visitor checks use the public API, not the web page.**
   - The check asks the public API with the app key and no login, which is what a logged-out client sees. It does not load the blog's theme page, so a theme cache could still differ for a while.
   - It is an observation at a time, never a promise; an error is recorded as unknown.
5. **A loopback HTTP bridge instead of Native Messaging.**
   - Native Messaging needs a host manifest and a registry key per browser and starts a new process per connection; the app already runs, so the extension talks to it over 127.0.0.1 with pairing approved in the app, an extension-bound token and the Origin/Host checks above.
   - When the app isn't running nothing is done or queued; the page says to start the app.
   - Every former manager feature now has a place in the app; the companion page lists where.
6. **Follower protection is review-only.**
   - Automatic blocking is shown as unavailable. The brief itself requires an evaluated pattern set first, and none exists yet.
   - Reporting has no API, so the app opens the blog and records your confirmation. It never claims a report was submitted.
7. **Editing an already published post's body** isn't in the editor. A published draft becomes read-only, and tags and visibility are changed from Posts. Body edits stay on Tumblr for now, so a newer Tumblr version is never overwritten.
8. **Browser relay for reads and edits (user request, 2026-11-06).**
   - A new app's official quota (1000 requests an hour) ran out during bulk tag and visibility work, because each verified edit costs a read, a PUT and at least one verify read. While the paired extension polls the bridge, reads of the account's own posts, full-post edits (PUT), follower lists, the account's likes (material scans) and public tag search (`/v2/tagged`, tag heat), and single posts and notes on any blog (read only, for material checks) go through the browser's tumblr.com session instead, and they don't count against the budget.
   - The app still builds every request, owns the job and verifies the result. The extension checks each request against a fixed list, the pairing account and the account's blogs, sends it, and returns the raw answer.
   - Paths built with the query string attached (as `core.js` does) are split before the relay check, so those reads are relayed too.
   - The extension carries writes and post lists only for the account's own blogs. Refusing one such request (`not_own_blog`, `not_allowed`) sends just that request the official way; only `signed_out` / `other_account` set the browser aside for a while.
   - Creates and deletes stay official, because their reconciliation is written for it. Visitor checks stay official too, because they need a logged-out view.
   - If the browser is not connected, signed out, logged into another account, limited (429) or never picks the request up, that request goes the official way, and the browser is left alone for a while. Settings → Tumblr connection can turn the relay off.
9. **Layout presets:** rows of 2–3 adjacent images. Other NPF layouts found on imported posts are kept as they are (edits always send the stored layout back).

## Open gates

- **Community labels**:
  - The OAuth API doesn't return them, so the app can't know whether a full edit keeps them.
  - Every edit is held until you choose "I don't use community labels" or "Verified" in Settings.
  - 2026-11-06: an unchanged full edit kept both a classifier label (private reblog) and an author-set label (public original) ([stage-0 record](../docs/STAGE0_RESULTS.md)). The test ran outside the job queue with the app closed; this account's `edit.labels` is now `pass` on that evidence.
  - This account uses labels, so "I don't use community labels" is not applicable. Visibility-changing edits weren't tested separately (same fields sent). Check Activity for queued edits before switching automation on.
- **Block / unblock**: the first real block is checked against the block list, and the capability shows as verified after that.
- **Legacy-format posts** are listed and skipped, not edited.
- **Packaging**: the Windows application directory is built at `dist/Tumblr Studio-win32-x64/`. A single installer is not done yet; packaged runtime acceptance remains separate from build output existence.
