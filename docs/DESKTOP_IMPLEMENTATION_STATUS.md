# Tumblr Studio: implementation status and acceptance gaps

Updated: 2026-11-06. This records the implementation handoff and a targeted local source review. It does not replace the requirements in [DESKTOP_PRODUCT_SPEC.md](DESKTOP_PRODUCT_SPEC.md), approve deferred scope, or authorise account mutations.

## Evidence and completion language

- `desktop/` contains the desktop implementation. The packaged executable exists at `desktop/dist/Tumblr Studio-win32-x64/Tumblr Studio.exe`. Distribute the complete application directory; the executable is not a standalone installer. Its presence is not evidence that the packaged app passed runtime acceptance.
- The implementation handoff reports 23 passing desktop tests and passing extension tests, plus a read-only account sync of 6 blogs and 598 posts using 47 requests. These are reported results, not independently rerun results from this documentation review. Account-specific role settings stay in local data, not this specification.
- The handoff reports automation off and existing-post edits held for community-label verification. Stage-0 adapter evidence is recorded separately in [STAGE0_RESULTS.md](STAGE0_RESULTS.md).
- Stages 1–4 have implementation coverage; they are **not all accepted as complete**. Fixture tests, adapter probes, read-only account sync, packaged runtime tests and full product acceptance are different kinds of evidence. Track A01–A57, R01–R17 and the follower scenarios individually; a test count alone does not establish coverage. Existing R01–R11 fixture evidence does not cover the newly specified R12–R17 maintenance workflow.

## Requirements versus current delivery

**New global requirement (2026-11-06):** [REBLOG_POLICY.md](REBLOG_POLICY.md) supersedes copy synchronisation. Existing reblog content and tags are immutable; source content/image/layout changes require a new version reblog, while tag-only changes do not create a version or another reblog. Implemented 2026-11-06 with fixture/unit evidence (details in “Reblog policy and grouped categories” below); live acceptance not run. Record A47 and R01–R11 separately from earlier test results.

| Area | Current implementation / handoff | Requirement or next acceptance step |
|---|---|---|
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
| Browser companion | Loopback bridge with in-app pairing, read-only snapshot, Open / Collect with Tumblr Studio, data import; the extension sends no writes | Run pairing, snapshot refresh, Open and Collect in the real browser against the packaged app |
| Follower protection | Baseline, public evidence, review, allowlist and manual block/unblock flow; automatic blocking unavailable | Review mode is the specified pre-evaluation stage, not completion of the low-burden automation requirement. Evaluate bounded patterns under the follower specification before enabling automation; real block/unblock validation remains open |
| Reporting | Opens Tumblr; keeps reports pending until user confirmation | Record user-confirmed reporting separately from machine-verified submission. Automatic reporting has no validated transport and remains unavailable |
| Delivery | Packaged Windows application directory exists | A single installer is not implemented. Validate launch and required runtime files on a machine without separately installed Node |

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
