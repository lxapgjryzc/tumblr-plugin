# Stage 0 capability results

Run on 2026-11-06 with [spike/stage0/probe.mjs](../spike/stage0/probe.mjs), as required by [DESKTOP_PRODUCT_SPEC.md §12](DESKTOP_PRODUCT_SPEC.md). The setup:

- The user's own OAuth2 app, with redirect `http://localhost:8765/callback` (Tumblr accepts this redirect).
- Only `api.tumblr.com` and a bearer token. No browser cookies, web-client token or extension storage were used.
- Every probe ran with **no browser process alive**. The probe checks this itself.
- Test posts were private, or briefly public on blogs the user named, and all of them were deleted afterwards.

Raw per-run results are kept locally in `%LOCALAPPDATA%\tumblr-studio-stage0\report.md`.

## Results

| Capability | Result |
|---|---|
| Authorise (scopes `basic write offline_access`) | Pass |
| Refresh token | Pass. **The refresh token rotates on every refresh**, and the access token lasts 2520 s |
| Read blogs (`/v2/user/info`, with uuid) | Pass |
| Read posts, drafts and queue; paginate with `_links.next` | Pass. The owner's list includes private posts |
| Create an NPF post with an uploaded image (multipart) | Pass |
| Full NPF edit (PUT with content, layout, tags, state) | Pass. The image is kept |
| Partial PUT (tags only) | **Refused (400)**. Every edit must send the full post |
| NPF formatting indexes | Code points. Bold after an emoji lands on the right word |
| Visibility public ↔ private | Pass, on originals and on reblogs |
| Reblog onto an own blog | Pass while the original is public. **A private original can't be reblogged, even onto my own blog (404)** |
| Delete a post | Pass |
| Followers list | Pass, but **entries have no uuid** (only name/following/url/updated) |
| Following list, block list | Pass, both with uuid |
| Block / unblock | **Not verified**: no controlled test account is available |
| Report | **Unsupported**: no API endpoint. Not attempted |

## Findings that change the design

Subsequent requirement revision: [REBLOG_POLICY.md](REBLOG_POLICY.md) freezes reblog content and tags and delivers changed source content as a new reblog. Tag-only changes do not create a version. The capability probes recorded here are historical evidence, not permission to keep editing reblog body/tags under the new product policy; explicit visibility changes still require preserving the snapshot payload.

Design correction after review: the old A38 experiment was unnecessary as a discovery gate. Existing reblogs retain content independently of later edits, deletion or hiding of their originals; this is a platform baseline. The historical observation below is retained as a record, not a request to repeat it. Linked-group automation is one way to operate on all owned instances; manually hiding each instance also works. This behaviour does not decide the user's desired expiry scope. Further tests should target the application's own queue, payload preservation and selection logic.

1. **Existing reblogs remain independent (historical A38 observation; discovery requirement withdrawn).** After the original was made private, it returned 404 to visitors through both the API and its page. The owned reblog on another blog kept showing the original's full content, both through the public API and on the post page, at least one minute later. This confirms an established baseline rather than discovering a new platform rule. Removing content from all owned public instances requires changing each of those instances, manually or through linked-group automation. It does not require the user to choose linked-group expiry. Other people's reblogs remain outside the tool's control; the UI states the selected action's scope.
2. **Reads right after a write can be stale.** The first run's edit verification read back the old post although the edit had landed. Verification must poll.
3. **Public visibility lags.** In one run a newly private post stayed visible to visitors (public API and page) for about 70 s; in the next it was gone within 1 s. The UI must not promise immediate hiding, and checks of the public view must wait.
4. **`total_posts` excludes private posts**: one blog reports 2 but lists 36. Sync coverage must come from paging to the end, not from the count.
5. **The refresh token rotates.** The new token pair must be stored atomically before use, or a crash loses the authorisation.
6. **Order of hiding and distribution:** a post must be reblogged before it is hidden, since a private original can't be reblogged.
7. **Follower identity:** follower entries carry only a name. Getting a stable id needs one blog-info lookup per new follower; this applies to F11.
8. **Community labels** don't appear in the OAuth NPF post objects. 2026-11-06: a full PUT with the desktop app's `editBody` (content, layout, tags, state, reblog control, parent fields; no label fields) on a private reblog labelled by the classifier (with an override) kept the label, read back through the web client for 30 s. The same unchanged PUT on a public original with an author-set label (main blog) also kept it (`lastReporter: author`, read back for 30 s). Both label sources therefore survive a full edit that leaves state alone; edits that change visibility were not tried separately (they send the same fields).
9. **Rate limit**: 1000 requests/hour and 5000/day for a new app until removal is requested. A full sync of every blog must be budgeted.

## Still open

- Block/unblock, which needs a test account the user controls.
- Label preservation on edit (finding 8).
- Legacy-format posts: they appear on one blog, but editing them wasn't tested.
- Running with the window closed to the tray and resuming after a quit (A03) belongs to stage 1.
