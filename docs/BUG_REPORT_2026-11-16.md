# Tumblr Studio bug report — 2026-11-16

Status: **Fixed in 0.6.17.** Investigated from the live data folder on this computer (`%APPDATA%\Tumblr Studio`, app 0.6.16, schema 13); the fixes are in `desktop/` and covered by tests. No live write was made.

## BUG-20261116-01 — Replies and suspicious accounts were never screened on this computer

### Evidence

- `studio.db` → `meta.notifTypes` contains a real notification of `type: "generic"`, `subtype: "reply"` (its sample is reproduced in `test/audience.test.js`). It has no `reply_text`; the sender is in `title.text_content.formatting[].blog` (`slyeantex`, `t:_ZhQz…`), the post in `actions.long_tap.meta.post_id`, and the text in `body.content` (`"Hello are  you going to receive COMM? If yes ..."`). The old `normalize` only knew the flat reply shape, so this row was stored as `kind = other` with no sender, post or text (interaction `833218340121149440`, 2026-11-14 01:15:30 UTC).
- `interactions` therefore had no `reply`/`ask` rows at all: 772 likes, 207 reblogs, 10 follows, one text-less mention. Follower protection's screen only looks at `reply`/`mention`/`ask` with text, so there was nothing to screen.
- The missed text is exactly the `commission_bait` pattern added in 0.6.9 ("are you going to receive COMM… reach out to me").
- Suspicious account: `allowlist` holds `emptystrideramulet` (`t:7F36…`, added 2026-11-15 02:07, i.e. the fake "Maya / maya, 25. scottsdale, az" persona). Its case is `dismissed`. `removeAllow` only deleted the allowlist row and left the case, and `follower.inspect` treats a dismissed case as final, so the fake could not be flagged again. The 0.6.16 fix for `removeAllow` resets only `allowed`, not `dismissed`.
- 0.6.16 changed unchecked baseline followers from the `inspected` flag (schema 12 set it for every row that already had a uuid) to "no case for this uuid", and made "Normal account" the quiet, confirmed last button; 0.6.17 builds on that base (rebased onto 0.6.15/0.6.16).

### Cause

1. The notifications feed now delivers some replies/asks as the structured `generic` shape. `audience.js` `normalize` mapped the whole type to `other`, losing sender, post and text, so protection never saw the comment. The 0.6.14 fix handled a cut `reply_text`, not a missing one.
2. A mistyped "Normal account" click (the button was first in the row, one click) permanently excluded the fake profile; removing the entry did not reopen its case. "Later" (dismissed) is treated as final even though the spec calls mere dismissal soft.

### Fix

- `audience.js` `structured()` reads the generic shape (title mention, avatar fallback, `actions`, `body.content`, `subtype` and body label → reply/ask/mention). `noteTypes` samples `type:subtype` (e.g. `generic:reply`) so the mapping is visible next time.
- `store()` upgrades an existing row when a re-read carries more (only blanks; state and tags stay) and screens it again, so protection can still act.
- One-time `audience.remap` (meta `notifRemap`): each row stored as `generic`/`other` without text is read once more around its own second (`before = timestamp + 1`, up to three pages), then upgraded and screened. The bounded reread avoids a 30-day backfill.
- `followers.js`: `removeAllow` resets an `allowed` **or** `dismissed` case to `clear` and queues a fresh inspection. (`uncheckedExisting` counting "no case", the quiet confirmed "Normal account" button and the scoped inspections came with 0.6.16.)
- `pages/followers.js`: the Normal accounts tab removes the entry and says it will be checked again.

### Tests

- `test/audience.test.js`: the exact generic sample normalizes to a reply with sender/post/text; a cut generic reply is read in full and opens a `commission_bait` review case; an old `other` row is repaired and screened.
- `test/followers.test.js`: removing a normal account re-checks it even after "Later" and finds `persona_profile` again; the 0.6.16 test (inspected flag + undo) and the existing baseline tests still pass.
- Full desktop suite on the rebased tree: 144/144.

### Not verified

- The live `audience.remap` was not run against Tumblr from here; the repair path is exercised with the real payload shape in tests. The feed has to still carry the 2026-11-06…09 notifications for the older rows to be recovered.
- The user still has to remove `emptystrideramulet` from Normal accounts (one click); with 0.6.17 that click re-inspects it. The account was also reported to Tumblr by the user, and that stays.
