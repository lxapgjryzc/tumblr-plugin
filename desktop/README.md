# Tumblr Studio (desktop)

A local Windows app for writing, publishing and managing your Tumblr blogs. It works with the browser fully closed. The design brief is [docs/DESKTOP_PRODUCT_SPEC.md](../docs/DESKTOP_PRODUCT_SPEC.md); this file describes what is built and where the implementation departs from that brief.

Implementation coverage is not full product acceptance. See [implementation status and acceptance gaps](../docs/DESKTOP_IMPLEMENTATION_STATUS.md) for evidence boundaries, unfulfilled requirements and the community-label test. Implementation departures do not themselves approve a reduction in scope.

## Run

**Application/companion split:** the application is the primary product. The extension retains only browser-local helpers and contextual entry points into app-owned capabilities, with no duplicate manager, AI executor or business scheduler. Implemented 2026-11-06 as described under **Extension** below ([the ownership contract](../docs/DESKTOP_PRODUCT_SPEC.md#43-companion-responsibilities)); live browser acceptance has not been run.

**Reblog policy:** [REBLOG_POLICY.md](../docs/REBLOG_POLICY.md) freezes every reblog's creation-time content and tags. Implemented 2026-11-06 (fixture-tested, see the status document): only a new source body (text, images, layout) is a new version and gets its own reblog; tag-only changes send nothing; existing snapshots are never edited.

**Runtime (since 0.5.0, [LOCAL_WEB_APP_SPEC.md](../docs/LOCAL_WEB_APP_SPEC.md)):** an independent local background service (plain Node, no browser engine) plus the interface as a local web page opened in Chrome only when needed. Closing the page or Chrome doesn't stop the service.

Work Chrome profile (0.6.2): not fixed in code. The first `Tumblr Studio.vbs` on a computer lists Chrome's profiles and asks for a number (`launcher.js` exit code 3, then `launcher.js bind <n>`); the choice is `browser.json` in the work data folder, read at each open. The test environment stays on Profile 10.

Packaged build: `npm run pack` makes `dist/Tumblr Studio/` (with `--shortcuts`: a desktop and Start-menu shortcut). Keep the folder together; it carries its own Node runtime (`runtime/node.exe`).

| Entry | What it does |
|---|---|
| `Tumblr Studio.vbs` (the shortcut) | Work: start or reuse the backend on 127.0.0.1:47823 (data `%APPDATA%\Tumblr Studio`), open the page in Chrome **Profile 1** with a one-time sign-in code |
| `Stop Tumblr Studio.vbs` | Stop the work backend (also Settings → Background service). Queued jobs wait, nothing is cancelled |
| `Tumblr Studio Test.vbs` | AI testing: a separate backend on :47825, data `%APPDATA%\Tumblr Studio Test`, the made-up account, Chrome **Profile 10** |

- `src/server/`: `main.js` (backend entry), `web.js` (HTTP: interface, `/api/call`, `/api/events` SSE, `/asset/<id>`, companion page, extension bridge, `/control/*` for the launcher), `launcher.js`, `env.js` (work/test), `chrome.js` (profile binding: checked against Chrome's `Local State`, stored in the data folder as `browser.json`; no fallback), `vault.js` (DPAPI through PowerShell; reads and rewrites the Electron-era files, keeping `*.electron-backup`), `media.js` (jpeg-js/pngjs instead of nativeImage), `lock.js` (`studio.lock`: one executor per data folder, also taken by the Electron shell), `autostart.js` (HKCU Run, backend only, off by default). `nativehost.js` + `nativereg.js`: Chrome native messaging host that only runs `Tumblr Studio.vbs open`, so the paired extension's toolbar icon can start the app; the installed work backend writes `native-host.json`/`.bat` to the data folder and the HKCU NativeMessagingHosts key, for the paired extension id only.
- Access: loopback only; Host must be this server; data needs the session cookie (`studio_<env>`, HttpOnly, SameSite=Strict, from a one-time code only the launcher can get with the data folder's `control.token`); changes also need the page's own Origin and the `X-Studio` header. The renderer is unchanged apart from `web.js` (window.studio over HTTP) and the Settings → Background service card.
- Toolbar icon (0.6.1 / extension 0.13.6): it opens the app, not the companion page. An open app tab in that browser is switched to; otherwise the extension sends `focus` with `fresh: true` and the backend opens a page itself with its own one-time sign-in code, so the icon works after the 30-day session lapses without the extension ever holding a code or cookie (a paired extension could already make the app open a page through `focus`). Unpaired → the companion page; backend down → the extension's own `companion.html`. The companion page is in the icon's right-click menu and in Settings → local service.
- Extension pairing needs a one-time grant that the app's own companion page (signed in, same Chrome profile) fetches, so a pairing belongs to the backend of that profile; a paired extension only talks to its own port.
- The Electron shell (`npm run start`, `npm run pack:electron`) is kept for development screenshots (`STUDIO_SNAP`) and takes the same data-folder lock.

```
cd desktop
npm install
npm test           # service and backend tests against an in-memory Tumblr (node:test, Node 24+)
npm run serve      # the test backend from source (made-up data); open it with: node src/server/launcher.js open --env test
```

First start: **Settings → Tumblr connection**. Register an app at <https://www.tumblr.com/oauth/apps> with the OAuth2 redirect URL `http://localhost:8765/callback`, paste its key and secret, then **Connect**. If the stage 0 probe was authorised on this computer, **Use the stage-0 test authorisation** takes that over instead.

Data lives in `%APPDATA%\Tumblr Studio`:

| File | Contents |
|---|---|
| `studio.db` | SQLite store: blogs, posts, works, display policies, rules, routes, jobs, drafts, follower cases |
| `credentials.bin`, `ai.bin` | OAuth tokens and the AI key, encrypted for this Windows user (DPAPI; Electron-era files are rewritten on first start) |
| `studio.lock`, `control.token`, `sessions.json`, `browser.json`, `backend.log` | The running backend's lock, the launcher's key, hashed page sessions, the Chrome profile binding, a short log |
| `assets/` | Images added to drafts, stored by content hash |
| `logs/` | Diagnostic log `diag-YYYY-MM-DD.log` (JSON lines, 14 days, 25 MB a day; `src/service/diag.js`): page actions with outcome and duration, Tumblr requests (official ones and every write or failure through the browser), job state changes, Activity entries, page errors, backend start/stop/crashes, notes from Settings → Problem report. Never tokens, keys, cookies, codes or image bytes. `diagnostics-*.txt` are exports from that card |
| `backups/`, `imports/` | Backups made in Settings → Data, and copies of imported extension exports and settings files |

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
  - `data.js`: extension import, backup and restore, and settings transfer to another computer (`tumblr-studio-settings`: same account only, no keys or histories; categories matched by tag and ids remapped; display rules, routes and automatic collecting arrive switched off).
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
  - Posts filter (docs/CONTENT_BROWSER_UX_SPEC.md, first batch): one service query (`src/service/query.js`) feeds the list, its total, the per-option “results after adding” counts, tag suggestions and “select every match”, so they can't disagree. Works (one unit per work, judged by its current original; a work whose original can't be read is one card with unknown data that never matches tag conditions and is never edited through a reblog) or Blog posts (each post by its own tags). Inside a category group: any (default) or all; groups, tag include (all/any), tag exclude, “not set in this group”, “no tags” and other conditions combine with AND. Whole-tag `core.key` identity on both sides; text search is a literal substring. Older `tags: [...]` conditions still mean “all of them”. A collapsible filter pane beside the results, a condition bar, quick filters that only fill in ordinary conditions (“Expiring soon” is now one, combinable with tags), newest-query-wins loading, selection dropped when the query changes, card click opens / checkbox selects, “select the N loaded” vs “select all N matches” (frozen), linked posts only added by ticking them, one per-post preview before tag edits, and a right-hand detail pane that highlights the exact instance.
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
- **Fans & interactions** (`src/service/audience.js`, page `fans.js`, docs/FAN_RELATIONSHIP_SPEC.md; replaces the New followers page, whose protection is now the Account protection tab):
  - Reads each chosen blog's notifications (`/v2/blog/{blog}/notifications`, rollups off, paged by `before`; checked live 2026-11-07 through the web client). Same-second page edges are read again and deduped by notification id; a page that doesn't move back ends the walk and records a gap. The first read backfills 30 days as history, so nothing from before switching on is a to-do.
  - Today: replies, mentions, asks and reblogs with words or tags (tags kept in order), starred people first; likes, plain reblogs and new followers are a summary. Done / No reply needed / Tomorrow / I replied are local states with undo; nothing is marked or sent on Tumblr.
  - People: one record per blog uuid across my blogs (name-only followers are looked up once when you first save a note or star). Nickname, labels, note, star, mute, reminders, name history, interaction history, relationship per blog and mutual (main blog + account following). A star is never the protection allowlist.
  - Changes: follower lists are collected once for protection and this module (scans every 6 h when only this module needs them). Someone missing from a complete walk is checked with `/followed_by`; only a "no" makes it an unfollow, recorded as an interval; errors stay "being checked". Follower counts are stored as observations and compared only with an earlier observation.
  - Switches are independent: collection never inspects or blocks; protection keeps its own blogs and adding a fans blog never widens blocking.
  - Not built yet (spec stages C/D): saved views, weekly summary, opt-in "no contact lately" reminders, AI summaries/drafts, grouping several events of one person and post, the browser companion's "Open this person in Studio".
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
7. **Editing a published original** (since 0.6.0, `writing.js` `decompile` / `post.edit`): the post is read fresh from Tumblr and opened in the same editor; an unfinished edit of the same post is resumed. Blocks the editor can't change (video, audio, polls, text with colours or mentions) are kept verbatim and shown locked; existing images keep their Tumblr media; new images go up in a multipart PUT. Layouts other than plain rows (asks, carousels, rows with text, reordered display) are refused with a reason rather than flattened. Before sending, Tumblr's current version is compared with the edit's base: a changed body (or tags changed on both sides) sends nothing and keeps both versions for the user to choose. State never changes in an edit; tags change only if edited (general categories first); a body change is a new source revision for enabled routes, a tag change makes my reblogs follow (copytags). A published draft of a *new* post still becomes read-only; its later edits go through Posts → Edit post.
8. **Browser relay for reads and edits (user request, 2026-11-06).**
   - A new app's official quota (1000 requests an hour) ran out during bulk tag and visibility work, because each verified edit costs a read, a PUT and at least one verify read. While the paired extension polls the bridge, reads of the account's own posts, full-post edits (PUT), follower lists, the account's likes (material scans) and public tag search (`/v2/tagged`, tag heat), and single posts and notes on any blog (read only, for material checks) go through the browser's tumblr.com session instead, and they don't count against the budget.
   - The app still builds every request, owns the job and verifies the result. The extension checks each request against a fixed list, the pairing account and the account's blogs, sends it, and returns the raw answer.
   - Paths built with the query string attached (as `core.js` does) are split before the relay check, so those reads are relayed too.
   - The extension carries writes and post lists only for the account's own blogs. Refusing one such request (`not_own_blog`, `not_allowed`) sends just that request the official way; only `signed_out` / `other_account` set the browser aside for a while.
   - Since 2026-11-13, creates, uploads and deletes go through the browser too (bullets below); they keep the same reconciliation, and the official API is the backstop. Visitor checks stay official, because they need a logged-out view.
   - If the browser is not connected, signed out, logged into another account, limited (429) or never picks the request up, that request goes the official way, and the browser is left alone for a while. Settings → Tumblr connection can turn the relay off.
   - **Deletes through the browser (opt-in, 2026-11-12, setting `relayDelete`, default off, extension 0.13.10; live-checked 2026-11-13: the web session accepts `POST /v2/blog/{blog}/post/delete` with JSON `{id}`).** Step 1 of the browser execution direction (CLAUDE.md). `deletePost` offers the browser `{ id }` as JSON (official: a form). Refused before sending (older extension: `not_allowed`) → official; browser `status 0` or taken without an answer → uncertain `NetError`, never resent on the spot. The `post.delete` job always reads first (`gone.js`): a lost answer leaves it `waiting`, a restart puts it back to `pending`, and the next run sends nothing once the post is gone. A 404 counts as gone only if the same identity can still read that blog. The same `status 0` rule now applies to browser edits: the job re-reads instead of resending the old body.
   - **Creates through the browser (2026-11-13, setting `relayCreate`, on by default, extension 0.13.11; live-checked: a collect reblog and an original saved as a draft, `POST /v2/blog/{blog}/posts` JSON → 201 via browser).** `reblog` and `createPost` without files offer the browser the JSON body (official: unchanged, multipart for `createPost`); posts with new files stay official until uploads move. Browser `status 0`, 5xx or no answer → uncertain → the job's reconcile, never a resend. The extension carries creates only on own blogs, with known fields, a complete or absent parent and no upload identifiers. `WaitError` (quota-saving mode) never marks a draft, delivery or collect failed.
   - **Uploads through the browser (2026-11-13, setting `relayUpload`, on by default, extension 0.13.12; live-checked: an image draft, 201 via browser, verified with 1 image).** `createPost` (with `relayCreate`) and `putPostFiles` with new files send the JSON plus `files: [{ identifier, filename, mime, b64 }]` (`relayFiles`, 50 MB per request; larger → official). The extension rebuilds the same multipart form as the official API and refuses files on anything but a create or full edit, other types than images/mp4, or identifiers that don't exactly match the post's. The relay waits 90 s + 1 s per 50 KB for the answer before calling it uncertain.
   - **Sponsored posts in post lists (fixed 2026-11-14).** The web API mixes Blaze ads into a blog's *own* post list as `object_type: 'post'` of another blog (`show_sponsored_label`, `sponsored_badge_url`, `adm`). They were stored as the synced blog's originals: shown as works, given revisions, expiry and route jobs (none was ever reblogged or edited; those writes were skipped or refused). Now core `isSponsored` makes `isPost` false, `postsPage` drops posts naming another blog, `upsertPost` refuses ads, and `ads.js` `removeAds` deletes stored ones with their revisions, pending deliveries and open jobs at every start (local only). 69 were removed on this computer.
   - **Quota-saving mode (optional, user request 2026-11-12, setting `relaySave`, default off).** The user asked whether the app should refuse to run without the browser; we kept the default fallback and added this switch instead. While the relay is on and paired, a relayable request the browser can't take right now (not connected, signed out, other account, limited, not picked up) throws `WaitError` instead of going official, so its job waits (`browser:`) and wakes when the browser connects. A refusal of one request (`not_own_blog`, `not_allowed`) still goes official, since the browser would never carry it. Creates, deletes and visitor checks are unaffected. Unpaired or relay off: everything goes official as before.
9. **Layout presets:** rows of 2–3 adjacent images. Other NPF layouts found on imported posts are kept as they are (edits always send the stored layout back).
10. **Replies from the app** (since 0.6.0, `replies.js`): Tumblr has no public API for sending a reply; the web client's own `POST /v2/user/post/reply` (found in its scripts 2026-11-07) is sent only through the paired browser (`browserOnly`, extension 0.13.5 checks: own blog as `reply_as`, fixed fields, plain text). Without the browser the send waits; it never goes another way. Every send is an operation with the page's id (a repeat is the same send), a create job: confirmed only when the reply is seen under the post, otherwise unknown until found or until the user says it wasn't sent. Only top-level replies under my own posts; mentions, reblogs and asks hand off to the exact page. Not live-verified yet.

## Open gates

- **Community labels** (gate removed 2026-11-12 at the user's request): the OAuth API doesn't return them, but an unchanged full edit kept both a classifier label and an author-set label on 2026-11-06 ([stage-0 record](../docs/STAGE0_RESULTS.md)), so edits no longer wait for a confirmation in Settings. The old `edit.labels` capability row is ignored.
- **Block / unblock**: the first real block is checked against the block list, and the capability shows as verified after that.
- **Legacy-format posts** are listed and skipped, not edited.
- **Packaging**: the Windows application directory is built at `dist/Tumblr Studio-win32-x64/`. A single installer is not done yet; packaged runtime acceptance remains separate from build output existence.
