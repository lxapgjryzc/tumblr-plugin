# Tumblr Studio: implementation status and acceptance gaps

## Functional workflow handoff (2026-11-07; acceptance pending)

[FUNCTIONAL_WORKFLOWS_SPEC.md](FUNCTIONAL_WORKFLOWS_SPEC.md) adds FW01–FW12 for complete original editing, integrated interactions and separate runtime/business/workflow evidence. The user delegates presentation choices; home/publishing/setup guesses were not confirmed. Official-page links and manual records are transitional, not integrated sending evidence. Validate reply transports early; private messaging remains unpromised. This documentation update ran no product acceptance and does not assess concurrent code changes. Record FW01–FW12 and FR23–FR24 as not verified until evidence exists.

### Functional workflows implementation (app 0.6.0, extension 0.13.5, 2026-11-07)

Built: editing published originals in the app's editor (`writing.js`: `decompile`, `editPublished`, `submitEdit`, `resolveEdit`, job `post.edit`), replies from an interaction (`replies.js`, job `reply.send`, browser-only relay request), the reply panel on Fans & interactions and the edit entry in Posts. Fixtures: `desktop/test/workflows.test.js` (10 tests), `test/smoke-companion.js` (relay rule for replies). Nothing was sent to the real account; no live reply or edit was made.

**Action-level capability table** (documented = public API docs; found = seen in the web client's own scripts; built = code exists; fixture = in-memory tests; live = checked on the real account)

| Action | Channel | Documented | Found | Built | Fixture | Live | Limits |
|---|---|---|---|---|---|---|---|
| Read notifications | official / browser | yes | — | yes (0.5.0) | yes | read 2026-11-07 (types: like, reblog, reblog_naked, follower, milestones) | no reply-type notification has been observed live yet; its field names are assumed (`reply_text`, `target_post_id`) |
| Read replies under a post | browser `GET /v2/blog/{b}/post/{id}/replies`; official fallback `notes?mode=conversation` | notes: yes; replies: no | yes | yes | yes | read-only on a public post 2026-11-07: `timeline.elements[]` with `reply_id`, `blog{uuid,name}`, NPF `content`, `children` (threads); notes give `reply_text`, `blog_uuid`, float `timestamp` | the fallback has no reply ids or threads |
| Send an ordinary reply to my post | browser only, `POST /v2/user/post/reply` {post_id, reblog_key, tumblelog, reply_text, reply_as} | no | yes (`postReply` in the web client) | yes | yes | **not verified**: no live send was authorised | top-level replies only; replying inside a thread (`parent_reply_id` / `target_reply_id`) is not built because those parameters are unverified; `reply_as` is sent as the blog name (unverified whether a uuid is expected) |
| Reply to a mention, reblog or ask | — | — | — | hand-off only | yes | — | answered on Tumblr; the app opens the exact post and records the hand-off |
| Read / send private messages | — | no | not looked for | no | — | — | out of scope this round; not promised |
| Report | — | no | — | official menu hand-off (unchanged) | — | — | stays "pending" until the user confirms |
| Edit a published original's body | official / browser full PUT; multipart PUT (official) when new images are added | yes | — | yes | yes | **not verified live** | layouts other than plain rows (asks, carousels, rows with text, reordered display) are refused with a reason; blocks the editor can't change are kept verbatim |

**Delivery record** (runtime / function / complete workflow kept apart)

| ID | Runtime evidence | Function evidence | Complete-workflow evidence | Status and remaining work |
|---|---|---|---|---|
| FW01 | — | existing publish tests (writing.test.js) | not run for FW01 | not verified; the new-post flow is unchanged in this round |
| FW02 | — | workflows.test: same id and state after an edit, reblog refused as a target | test env (made-up data, Profile 10): Posts → Edit post → change → Update → verified banner → Back returns to the same work with the query kept | fixture + test-env UI only; "Edit the original" from a reblog is built but was not clicked through; not live |
| FW03 | — | workflows.test: Tumblr changed meanwhile → nothing sent, both kept, take theirs / keep mine / bring my text back; lost PUT answer verified without a second PUT | — | fixture only; offline during editing is covered by autosave + `waiting` jobs, not separately tested |
| FW04 | — | workflows.test: body edit → new source revision; tags-only edit → no revision, my reblog takes the tags, its body unchanged, no new reblog | — | fixture only; not live |
| FW05 | — | workflows.test: thread with post, replies, person; send recorded with identity, target and text | test env: reply panel → send → "reply sent ✓" (demo fake) | **integrated send not live-verified**; channel found in the web client, never exercised on the real account |
| FW06 | — | workflows.test: double click / same op id, lost answer found once, not visible → unknown (never resent), "It wasn't sent", crash while sending → unknown | — | fixture only |
| FW07 | — | workflows.test: hand-off recorded separately; self-report separate | — | the official page opens in the page's own browser (the environment's profile); unsent text is kept in the app; not live |
| FW08 | — | workflows.test: no browser → `waiting` with nothing sent, woken when the browser connects | — | fixture only; no browser is opened for it |
| FW09 | — | workflows.test: a body edit keeps tags changed elsewhere; jobs run one at a time on fresh reads | — | partial: interleaving with visibility jobs not separately tested |
| FW10 | — | workflows.test: failed / unknown sends keep the interaction open; confirmed closes only that interaction | — | fixture only |
| FW11 | — | new tables live in `studio.db`, so backups carry them | — | backup/restore of edit drafts and reply operations not tested |
| FW12 | this table | — | — | this record; runtime items from LOCAL_WEB_APP_SPEC keep their own record above |
| FR23 | — | as FW05–FW08 | — | built, not live-verified |
| FR24 | — | the panel distinguishes read, hand-off, self-report and checked sends; capability `reply.send` stays `unverified` until a send is seen under the post | — | built |

To verify live (needs the user's go-ahead): one reply from the app to a real reply on the user's own post (the extension 0.13.5 must be reloaded in Profile 1 first), and one body edit of a chosen original.

Current reblog requirements include the later owned-source tag-sync revision; older immutable-tag test descriptions below are historical evidence only. A57/CC Switch is withdrawn, reconfirmed 2026-11-07; manual API address/model/key remains. Do not restore withdrawn work during refactoring.

Updated: 2026-11-07 (local-web runtime decision and content-page usability handoff; earlier implementation evidence retains its recorded dates). This records the implementation handoff and a targeted local source review. It does not replace the requirements in [DESKTOP_PRODUCT_SPEC.md](DESKTOP_PRODUCT_SPEC.md), approve deferred scope, or authorise account mutations.

## Local-web runtime handoff (2026-11-07; pending implementation)

The user selected an independent local background service with a web interface opened in an ordinary browser only when needed. [LOCAL_WEB_APP_SPEC.md](LOCAL_WEB_APP_SPEC.md) defines LW01–LW18; the main specification revises A01–A03 and adds A66–A75. The priority is browser-exited operation with lower resident overhead, retaining existing features and local data. No hidden Electron/WebView/browser process may be used as the background runtime.

The user also specified Chrome profile1 for daily work and profile10 for AI-agent testing. Profile mapping, explicit launch/OAuth/link routing, isolated work/test backend data and credentials, callback correlation and per-profile companion pairing are new requirements, not verified implementation. LW15–LW18 cover these boundaries. AI tests may not operate or close work-profile windows, clear work site data or terminate Chrome globally; if only profile10 is closed, do not report the all-browser-exited scenario as passed.

Source inspection shows that `desktop/src/main/main.js` currently boots the service inside Electron, creates its `BrowserWindow`, and intercepts close with `win.hide()`. Credentials and media processing also use Electron adapters, and the renderer is connected through the preload/IPC boundary. Existing service separation is reusable, but does not prove standalone backend launch or ordinary-browser UI compatibility. This is source evidence, not a process-memory measurement.

Pending work: independent backend lifecycle and single-instance protection; browser UI/API and local access control; file/media/credential/launcher adapters; preserved data and guarded old/new cutover; everyday packaging; and same-machine old/new resource evidence. Browser close must leave accepted tasks running; explicit backend stop must stop execution. OAuth and authoritative data remain in the backend, and multiple tabs must share one queue and credential refresh writer. Existing reporting/capability limitations remain in force.

This handoff changes documentation only. No application code, account state or runtime acceptance result changed, and no memory benchmark or actual profile-directory inspection was run. Record LW01–LW18 as **not run / implementation pending** until demonstrated; historical Electron test counts, packaged builds and adapter probes do not establish the new runtime's acceptance.

## Content-page usability handoff (2026-11-07; pending implementation)

[CONTENT_BROWSER_UX_SPEC.md](CONTENT_BROWSER_UX_SPEC.md) adds the Posts/filter redesign proposal and CU01–CU20 (main-spec A58–A65). Evidence for this review is read-only inspection of the running Posts page/filter dialog plus source inspection; no post mutation, batch submission or new product acceptance run was performed.

Current gaps include all-of-only tag filtering, no tag suggestions/result preview in the modal, blog-scope wording that conceals the sharing-role restriction, no selection reset on filter changes, ambiguous loaded-versus-total selection, and no protection against obsolete query responses. The new document distinguishes observed UI facts from source-derived risks. The proposal is not delivered by this documentation change; track the first and second delivery batches separately and do not count existing grouped-category tests as acceptance of the redesigned filter.

## Evidence and completion language

- `desktop/` contains the desktop implementation. The packaged executable exists at `desktop/dist/Tumblr Studio-win32-x64/Tumblr Studio.exe`. Distribute the complete application directory; the executable is not a standalone installer. Its presence is not evidence that the packaged app passed runtime acceptance.
- The implementation handoff reports 23 passing desktop tests and passing extension tests, plus a read-only account sync of 6 blogs and 598 posts using 47 requests. These are reported results, not independently rerun results from this documentation review. Account-specific role settings stay in local data, not this specification.
- The handoff reports automation off and existing-post edits held for community-label verification. Stage-0 adapter evidence is recorded separately in [STAGE0_RESULTS.md](STAGE0_RESULTS.md).
- Stages 1–4 have implementation coverage; they are **not all accepted as complete**. Fixture tests, adapter probes, read-only account sync, packaged runtime tests and full product acceptance are different kinds of evidence. Track A01–A75, LW01–LW18, CU01–CU20, R01–R17 and the follower scenarios individually; a test count alone does not establish coverage. Revised A01–A03 require new runtime evidence. Existing R01–R11 fixture evidence does not cover the newly specified R12–R17 maintenance workflow.

## Requirements versus current delivery

**Current reblog requirement:** bodies and versions stay frozen; owned-source tags synchronise under existing policy, other-author/material tags stay fixed. See [REBLOG_POLICY.md](REBLOG_POLICY.md). Earlier R02/tag-immutability results below document the prior contract and cannot establish later-revision acceptance.

| Area | Current implementation / handoff | Requirement or next acceptance step |
|---|---|---|
| Local-web runtime (confirmed 2026-11-07) | Implemented 2026-11-07 (app 0.5.0, `desktop/src/server`): independent Node backend, page in Chrome with session/Origin/CSRF/Host checks, launcher (.vbs) with Profile 1 / Profile 10 binding, separate work/test data, ports, sessions and pairing grants, data-folder lock shared with Electron, DPAPI vault reading the Electron files, pure-JS images. The user's work data now runs on it (credentials carried over, real sync confirmed, no page opened by the agent in Profile 1). Evidence: `web.test.js` (LW09 lock, LW11, LW12 images, LW16/LW17 by fixture), Profile 10 run of the test backend (all pages, image upload, draft conflict refused), memory: Electron in tray 5 processes ≈200 MB private working set / ≈465 MB private bytes; new backend idle 1 process ≈35 MB / ≈76 MB (same machine and data, 4–6 one-minute samples each, `desktop/tools/measure.ps1`); 10 page open/close cycles left no extra clients or memory. Not run: LW02 publish across browser exit, LW04 sleep/resume and autostart, LW05 OAuth in the test profile, real all-browsers-exited observation, real Profile 1 pairing by grant (the existing pairing still works) | Deliver LOCAL_WEB_APP_SPEC.md: independent backend, ordinary-browser interface, preserved data/auth, optional companion, work-profile1/test-profile10 isolation, guarded migration and LW01–LW18. Measure same-machine resource use; no numeric saving is yet demonstrated |
| Reblog version maintenance | Implemented 2026-11-06 (“Versions & reblogs”, see below): history, comparison, preview-first exact-instance actions, one-off old-version hiding, deletion with tombstones, local notes, re-send through the normal checks | Fixture evidence only (`versions.test.js`); live acceptance not run. Not done: version and pending counts on the Posts grid cards (shown in the work details and the dialog) |
| CC Switch AI setup | Dropped by the user on 2026-11-06 | The AI connection stays manual (address, model, key in Settings, key encrypted locally). Design 4.4 / A57 no longer apply; no CC Switch reader and no local AI clients |
| Primary application and thin companion (confirmed 2026-11-06) | Implemented 2026-11-06 with fixture/smoke evidence (see A52–A55 below): manager page, alarms and background passes removed from the extension; materials, pairing, snapshot and typed requests in the app | Implement design section 4.3 and A52–A55: app-owned functionality/data/jobs, browser-local helpers and contextual entry points only, explicit migration of retained collection capabilities/data, no duplicate manager/admin/AI/scheduler. A write guard or manual export is not completion; no runtime changes are made by this documentation update |
| Grouped general categories (confirmed 2026-11-06) | Implemented 2026-11-06: optional groups from a data file, display names separate from tags, configured composition order, no mandatory gate, additive migration, all-of whole-tag filtering per view | A48–A51 fixture-tested. “Arrange category first” in the browser panel and the previewed retag of old originals after a tag mapping change were added 2026-11-06 (smoke test `smoke-content.js`, `tidy.test.js`) |
| Foundation, management and visibility | Local database/jobs, ownership views, previews, expiry modes and persistent exceptions are implemented | Verify restart/recovery, selected-instance boundaries and browser-exited workflows. Existing-post writes remain gated by labels |
| Image upload | Image parts are sent in one create request, identified by image occurrence; editor provides button operations and rows of 2–3 adjacent images | Separate uploads were a proposal, not a requirement. Verify compiled and remote image order, grouping, text positions, captions and alt text. One request alone does not prove layout correctness |
| Publication | Direct creation in the chosen remote state; no intermediate Tumblr draft unless that is the selected destination state | The intermediate draft was optional. Preserve a frozen revision and reconcile uncertain creation before allowing another create; see the concrete gap below |
| Existing-post body editing | Published drafts are read-only; tags and visibility have management actions, subject to the label gate | Body editing remains an unfulfilled design capability. Use Tumblr for now; do not silently remove the requirement or describe it as an API limitation |
| Native content/layout coverage | The README describes implemented editor blocks and 2–3-image rows | Complete the read/preserve/create/edit capability inventory. Unimplemented layouts/features are not automatically unsupported by Tumblr |
| Visitor visibility | Implemented 2026-11-06: a delayed visitor check through the public API (app key, no login) after each verified visibility change, retried while the view settles; `unknown` on errors; shown per instance with its time | Fixture evidence only (`visitor.test.js`). It is not the blog's theme page; never shown as a promise |
| Browser companion | Loopback bridge with in-app pairing, read-only snapshot, Open / Collect with Tumblr Studio, data import; the extension sends no writes | Adapt pairing and contextual links to the independent backend/local web UI, preserving one owner; run pairing, snapshot refresh, Open and Collect against the new delivery, and verify core operation without the extension |
| Fans & interactions | Implemented 2026-11-07 (app 0.5.0, FAN_RELATIONSHIP_SPEC stages A+B): Today / Interactions / People / Changes & stats / Account protection; notifications collection with gaps, followed_by checks, local notes, stars, labels, reminders, workflow states | Fixture evidence (`audience.test.js`, FR02–FR08, FR10–FR14 in part) plus a live read-only look at the notifications and followed_by answers (web client). The official-API read of notifications and the browser relay route need a live run after the extension is reloaded. Stages C/D not built |
| Follower protection | Baseline, public evidence, review, allowlist and manual block/unblock flow; automatic blocking unavailable | Review mode is the specified pre-evaluation stage, not completion of the low-burden automation requirement. Evaluate bounded patterns under the follower specification before enabling automation; real block/unblock validation remains open |
| Reporting | Opens Tumblr; keeps reports pending until user confirmation | Record user-confirmed reporting separately from machine-verified submission. Automatic reporting has no validated transport and remains unavailable |
| Delivery | Packaged Electron Windows application directory exists; new local-web packaging is pending | Deliver an everyday launcher and independent backend without requiring a developer runtime installation; validate open/pause/stop, optional backend-only sign-in startup, updates and data preservation under LW01/LW04/LW14 |

## Reblog policy and grouped categories (2026-11-06)

Evidence is fixture and unit tests only (desktop `npm test` 33 passing, extension `npm test` all passing); nothing was run against the live account.

| ID | Coverage | Where |
|---|---|---|
| R01, R02, R10 | New body → new reblog with that moment's tags; tag-only and order-only changes send nothing and edit nothing; A → B → A delivers three times, rescans add none | desktop `reblog-policy.test.js`; extension `core.test.js` (editPost refuses tag/order/note/body changes on a reblog, no copy repair) |
| R03, R04 | Lost response reconciles to this revision's unclaimed copy, not an older copy with the same body; unresolved earlier revision holds later ones | desktop |
| R05, R06 | Deleted copy tombstones its revision only; notes/state/rescan are not revisions; hiding a snapshot sends its own body and tags | desktop |
| R07, R11 | Excluded new revision skipped and recorded; removing the tag doesn't backfill; disabled route only offers “Reblog the new version”; a change before sending is redone; a private source waits and is not opened | desktop |
| R08 | Tag edits skip reblogs and list them as snapshots; work details list every version per destination. “One manager however many reblogs to the same side blog” relies on the unchanged grouping code (it counts blogs) and has no dedicated test yet | desktop `foundation.test.js`, `reblog-policy.test.js` |
| R09 | Collection/AI/palette/hand-tag writes onto collected reblogs are refused by `editPost` (the page says nothing was written) | extension `core.test.js` |
| A48–A51 | Optional independent groups, composition order and dedupe, no gate, display name vs tag, all-of filtering per view, flat-list migration keeping ids/tags/order/draft and default choices with no remote calls | desktop `writing.test.js` |

Choices and limits:

- A revision is identified by a fingerprint of the content blocks and layout with image media reduced to the picture's path key and presentation-only fields dropped. If Tumblr were to re-serialise an unchanged body differently after a tags-only edit, that would look like a new revision; this has not been observed live and needs one live check before routes are switched on.
- Copy identity uses the reblog's trail entry for the source. Revision 1 counts from the post's publication; older history is not invented. Migrated route rows become revision 1 with “version unknown”.
- Edits to older originals are found by a full read of route source blogs every 6 hours (incremental reads only see recent posts).
- Collection analysis now runs in the app and is applied only before a reblog is created; the extension's collection page is gone (A52–A55 below).

## Application and companion ownership (A52–A55)

Implemented 2026-11-06. Evidence: desktop `companion.test.js` (bridge protocol: Host/Origin/token/account checks, pairing approval, operation-id dedupe, collect as an app job, import) and extension `test/smoke-companion.js` (pairing, snapshot stored for content scripts, two clicks make one collect job, app quit → nothing queued, old alarms removed, companion page lists every former feature, AI key not sent, only GETs to tumblr.com). Not run live in the browser.

| ID | Coverage |
|---|---|
| A52 | The app owns materials (collect, palette, AI tags/note decided before creation, quick study), packs, rules, categories, AI and all jobs. The extension has no manager page, AI executor, queue or alarms |
| A53 | In-page helpers read the app's versioned snapshot (storage key `studio`); older local keys are a read-only fallback. `content.js` wraps its request in `guardWrites(…, () => true)` |
| A54 | Open / Collect with Tumblr Studio from the context menu and page buttons go through `/request`; the app reads the post itself and records the job in Activity. With the app closed nothing is done or queued |
| A55 | Older data moves with an explicit import (collection settings arrive switched off with a note, the AI key stays behind). The companion page lists where each former feature lives; tag cleanup, pack upkeep and the collection's AI-art check are marked “not in the app yet” |

The companion page is served by the app (`GET /companion/`, fixed file list, strict CSP) and reaches the extension's storage only through the fixed operations of `companion-host.js`; checked in real Chrome against the demo app (page loads, no console errors, says when the extension isn't connected). The connected case is covered by the smoke test only until the extension is reloaded.

Departure: a loopback HTTP endpoint instead of Native Messaging (reasons in `desktop/README.md`, departure 5). The three features that were pending (tag cleanup, pack upkeep with review, the collection's AI-image check) moved into the app on 2026-11-06 (`tidy.test.js`, `aiart.test.js`); the companion page now lists none as pending. AI-image results are kept in the app instead of tagging the reblogs, which the reblog policy forbids.

## Version maintenance (R12–R17, A56), added 2026-11-06

Evidence: desktop `versions.test.js` (fixture). Not run live.

| ID | Coverage |
|---|---|
| R12 | Entering from the original or any of its reblogs opens the same work; source versions show when each was first observed (or published), reblogs show their own reblog time; the newest known source version and each blog's newest verified reblog are shown apart |
| R13 | Two versions are compared on text blocks, images (added, removed, order) and layout; the tags each version was reblogged with are listed apart and never make a version. A version with no stored body and no known copy says “not comparable” (bodies are stored from schema 9 on; older ones use their copies' trails) |
| R14 | Filters by blog and state; actions on exactly the chosen reblogs after a preview that lists what is affected and what is left out with the reason (gone, job running, kept public, already in that state). The original is never a target. Coverage is stated as “everything this app has read” |
| R15 | “Keep newest public, hide older public” per blog: only when that blog's newest verified public reblog holds the latest source version; kept-public, unknown-version and busy reblogs are left alone; nothing happens when a new version arrives later |
| R16 | Deleting chosen reblogs is confirmed, verified by reading back, and leaves the version's delivery as a tombstone, so syncs and routes never recreate it; notes stay |
| R17 | Re-sending uses `routes.manualReblog` (version dedupe, unknown outcomes, exclusions). Local names and notes live in `version_notes` (in the database, so in backups) and are never sent to Tumblr |

## Concrete acceptance gaps from source inspection

**Mutation ownership (A28; design sections 4.3, 10.1 and 11).** Found: `settings.desktopManaged` guarded only `maintain()` and `recent()`. Fixed 2026-11-06: `TTHCore.guardWrites` wraps the request function of the manager, the content script and the background worker, so with the switch on every non-GET call is refused before it is sent (unit test `guardWrites refuses writes only while Studio is in charge`); `collect()` also skips, and manager batches stop with a message. The switch lives in `chrome.storage.local`, so it survives restarts. Still open: it is not a runtime lock shared with the desktop (an old extension copy without this code would keep writing), and A28 has not been run end to end in a browser.

**Uncertain creation (A19, A26).** Found: the search was two pages on first text, image count and tags, and five empty passes became `failed`, after which the draft could be reopened and the reblog offered Retry. Fixed 2026-11-06:

- The publish search reads every page back to shortly before the publish started (the queue in full; 40 pages as a safety net, said in the message), and matches on every text block with its subtype, the image count, the row grouping and the ordered tags.
- Nothing found never becomes `failed`. After five passes the job stays `unknown`, keeps looking every 6 hours, and the activity page offers “Look again” and, with a second confirming click, “It wasn't created”. Only that explicit resolution marks the job failed, releases the draft (or the route map entry) and allows another create. An unknown create can no longer be cancelled.
- A post found by reconciliation goes through the same verification as a fresh create. Verification now also compares the text blocks and row grouping, not only tags, state and image count.
- Reblog reconciliation searches ten destination pages and follows the same unknown → explicit resolution rule.

Fixture test: `publish: a lost response with nothing found stays unknown until you resolve it; lookalikes do not count`. Not covered: a live lost response, and image identity (Tumblr returns its own copies, so only the count is compared).

These were targeted findings, not a complete code audit. The fixes above have fixture and unit coverage; the live acceptance scenarios remain to be run.

## Community-label preservation gate

2026-11-06, run with the user's go-ahead: an unchanged full edit with the desktop's own `editBody` and credentials kept the label on two existing posts, read back through the web client (`communityLabels`) every 10 s for 30 s: a private reblog with a classifier label and override (arcv `831240157206380544`), and a public original with an author-set label (main `831029444560945152`). Nothing else on either post changed. The app's `edit.labels` capability was set to `pass` on that evidence.

The account uses community labels (those two posts). The adapter can't read the fields, so absence in a response is not absence on the post. Not separately tested: an edit that changes visibility (it sends the same fields, so the same behaviour is expected) and legacy posts (still skipped). Do not select “I don't use community labels” for this account. New-post creation, reblogging, deletion and follower actions are distinct capabilities; the edit gate must not be described as a blanket prohibition on every remote write.

The test ran outside the app's job queue (a one-off script with the app closed), so no held jobs were released by it. Setting the capability to `pass` lets queued edits run once automation or a batch is started; review pending jobs in Activity before switching automation on.

## Remaining handoff evidence

Provide an acceptance matrix with scenario ID, result (passed / blocked / deferred / not run), build/version, fixture or controlled live method, and evidence location. Prioritise label preservation, mutation ownership, uncertain-create recovery, image/layout fidelity, packaged browser-exited operation and follower evaluation. Keep already passed stage-0 results; do not repeat live experiments for established platform semantics.
