# Tumblr Studio bug report — 2026-11-08

Status: **Fixed 2026-11-12 (see Resolution at the end).** Originally recorded for a later Claude repair session. The user confirmed that all three issues below should be recorded. This handoff records evidence only; no application fix or live reproduction was performed.

## Evidence and environment

- [Screenshot 1: Content / Works](bug-reports/2026-11-08/01-content-duplicate-work.png), captured 2026-11-08 17:46:14 local time.
- [Screenshot 2: Activity / publication status](bug-reports/2026-11-08/02-activity-publish-verification.png), filename timestamp 2026-11-08 17:46:35 local time.
- [Diagnostic excerpts](bug-reports/2026-11-08/diagnostic-excerpts.jsonl): 16 relevant events copied from `%APPDATA%\Tumblr Studio\logs\diag-2026-11-07.log` and `diag-2026-11-08.log`. JSON was reserialized; field values are preserved. Both daily logs were read; neither contained a `user.note` entry. No diagnostic export was present in that log directory.
- Local time is America/Los_Angeles (UTC−08:00 on these dates). Thus `2026-11-09T01:44:28Z` in the log is November 8 at 17:44:28 in the UI.
- The November 8 startup log identifies backend version **0.6.0**, environment **work**, Node **v24.19.0**, port **47823**. The exact frontend build was not independently identified.

The two screenshot files are unmodified copies of the user's attachments. Original filenames: `Screenshot 2026-11-08 174614.png` and `Screenshot 2026-11-08 174635.png` under `C:\Users\Admin\Pictures\Screenshots`.

## BUG-20261108-01 — The same apparent work appears twice in Works

**Observed in screenshot 1**

- Page: `内容` → `作品`; management scope: `分享博客（3 个）`; quick filter: `全部内容`; no additional conditions; newest first; grid layout.
- The page reports `117 个作品 · 已加载 60`.
- The first two cards have the same visible drawing and original publication date, November 8, 2026:
  - Blog `0961685962`: `转发 公开`, `第1版`, one note.
  - Blog `0961685962arcv`: `原帖 公开`, `7 天后隐藏`, one note.
- The user identified this duplicate presentation as an issue. The screenshot shows an original and an apparent reblog as separate work cards, rather than one work with its instances.

**Related log evidence**

The contemporaneous publication/reblog pair is original `832767173331173376` on source blog UUID `t:8Bl6M-1Ix6KW9TbUzsK2nA`, followed by reblog `832767176162328576` on destination UUID `t:NoAduFiw3P7xqQREZ_7W2A`. Reblog job **5437** completed at 17:44:30; its activity record identifies route 2, revision record 2, source revision 1.

The cards do not show post IDs. Confirm their association with this pair before changing records; no database `item_id` values were inspected during this report.

**Expected / acceptance**

- Once their source relationship is known, an original and its reblog occupy one logical work in `作品`, with both actual posts available in the work details / versions view.
- `博客帖子` may list the actual posts separately. Work totals and selections count the logical work once.
- Recheck after the publish/reblog sequence, refresh, and a subsequent sync. Preserve distinct works that merely reuse the same image; image similarity is not identity.

**Starting points for Claude (not a root-cause finding)**

- `desktop/src/service/groups.js`: `rebuild()` and assignment of `posts.item_id`.
- `desktop/src/service/query.js`: `makeQuery()` / `load()` groups by `item_id`, while rows without an item remain separate units; `page()` / `detail()` and counts.
- `desktop/src/service/routes.js`, `desktop/src/renderer/pages/posts.js`: ingestion of a new reblog and refresh of the work list.
- Existing requirements: [CONTENT_BROWSER_UX_SPEC.md](CONTENT_BROWSER_UX_SPEC.md), especially work identity/selection and CU08; [REBLOG_POLICY.md](REBLOG_POLICY.md), shared work and version maintenance.

## BUG-20261108-02 — Publication shows “核对结果” while the original and reblog are already visible

**Observed in screenshot 2**

- Under `活动记录` → `进行中`, a `发布 0961685962arcv` task is labelled `核对结果`, with displayed time November 8 at 17:46.
- Under `记录`, a `转发` action is already `完成` at 17:44, referring to `0961685962arcv / 832767173331173376`.
- Screenshot 1 already shows the new original and apparent reblog. The relationship between remote creation, verification, and the displayed task status is unclear to the user.

**Timeline from the available log (local time)**

| Time, November 8 | Evidence |
|---|---|
| 17:44:24.503 | `post.publish` job **5436**, draft **7**, starts, attempt 1. |
| 17:44:27.890 | Create request returns HTTP **201**. |
| 17:44:28.660 | Read of original **832767173331173376** returns HTTP **200**. |
| 17:44:28.734 | Job 5436 becomes `verifying`, `phase: verify`, `verifyN: 0`. |
| 17:44:30.671 | Read of reblog **832767176162328576** returns HTTP **200**. |
| 17:44:30.676 | Reblog job **5437** becomes `succeeded`. |
| About 17:46:35 | Screenshot 2 still displays a publication task as `核对结果`. |

The available November 8 log ends at 17:44:30.678. It contains no subsequent outcome for job 5436. A permanently stuck worker, a frontend refresh problem, a crash, and the final publication outcome are **not established** by this evidence. The screenshot's displayed task timestamp is not a proven task start time.

**Expected / acceptance**

- A created post proceeds to a verified result or an actionable explanation of the unresolved checks; a retryable mismatch or waiting condition should be understandable from the activity UI.
- Check whether verification continues, whether its status reaches the UI, and how a completed reblog is presented while publication verification is still pending.
- Recovery retains the known remote post ID and checks that post; an unresolved verification must not cause another publication to be created.

**Starting points for Claude**

- `desktop/src/service/writing.js`: `post.publish`, the `phase === 'verify'` branch, `done()`, and `verifyStep()` calls. The current source plans route work in `done()` before returning the publication's `verifying` state; inspect this ordering without assuming it is the cause of a stall.
- `desktop/src/service/jobs.js`: scheduling, verification backoff, restart recovery, and status updates.
- Activity-page rendering and refresh; `desktop/src/renderer/i18n.js` maps `verifying` to `核对结果`.

## BUG-20261108-03 — Created posts end as failed because body/tag verification differs

**Observed in screenshot 2, confirmed by November 7 job logs**

Both rows are `发布 0961685962arcv`, labelled `失败`, and have a `重试` action. The messages explicitly include an already-created remote post ID:

| UI time, November 7 | Job / draft | Remote post ID | Error verbatim |
|---|---|---|---|
| 14:04 | **2053** / **6** | `832661328194879488` | `published as 832661328194879488, but it doesn't match what was sent: block 1: the text differs` |
| 13:30 | **1959** / **4** | `832659217805705216` | `published as 832659217805705216, but it doesn't match what was sent: block 1: the text differs; the tags differ` |

The log records both failures in `phase: verify`, at `verifyN: 7`, with `attempts: 9`. These are job-attempt counters, not evidence of nine create requests. Exact failure times are 14:04:07.686 and 13:30:33.792 respectively.

**Impact and unknowns**

- A generic failure and retry action are shown even though the message says the post was created. The UI does not show the compared text or tag differences in this screenshot.
- It is unconfirmed whether content was actually changed/lost, whether Tumblr normalized the submitted representation, whether a subsequent edit changed it, or whether the comparator produced a false mismatch. Expected and observed payloads were not compared in this recording session.
- The `重试` action was not clicked. Its behavior, and any duplicate-create risk, remain to be checked.

**Expected / acceptance**

- Compare the frozen submitted revision with the fetched NPF content and ordered tags, preserving evidence of any real difference. Identify whether the failure lies in submission, normalization/comparison, a later edit, or status handling before changing the verifier.
- Equivalent content should verify successfully; a real mismatch should remain visible with useful differences and the existing post identity.
- Recovery uses the known post and does not blindly create another one. Confirm this with fixtures for both body-only and body-plus-tag mismatches.

**Starting points for Claude**

- `desktop/src/service/writing.js`: `compile()`, `sameBody()`, `bodyDiff()` (the `block 1: the text differs` message), `post.publish` verification, and reconciliation/retry handling.
- `desktop/src/service/jobs.js`: failed-job retry behavior and create recovery.
- Relevant existing tests: `desktop/test/writing.test.js` and `desktop/test/workflows.test.js`.

## Repair handoff

Keep the three issues separately tracked even if one root cause later connects them. Inspect the saved evidence first, then use the test environment for reproduction according to `CLAUDE.md`. This report does not establish a fix, a controlled reproduction, or product acceptance; record those results when the user requests the repair.

## Resolution (2026-11-12, Claude)

Checked against the full work logs (`diag-2026-11-08.log` runs to 23:54, not 17:44:30) and a read-only copy of the work database.

- **BUG-02 and BUG-03 share one cause.** Verification of job 5436 did continue on its backoff and failed at 18:06:29 with `block 1 is image, expected text`; the screenshot was taken during the ~22-minute verify window, nothing was stuck. Drafts 4, 6 and 7 each started with an **empty text block** (the composer's unused "在这里写…" line). `compile()` dropped only trailing empty text blocks, so the empty first block was sent; Tumblr drops it, so block 1 never matched. Remote content equals the draft minus that block: nothing was lost. Fix: `compile()` skips empty text blocks anywhere (row and read-more indexes follow the blocks actually sent). The fake Tumblr now drops them on create too. Tests: `compile: empty text blocks anywhere…`, `publish: empty lines above the text…` (`desktop/test/writing.test.js`).
  - Job 1959's extra `the tags differ` was a real change during its verify window (the original's tags were edited; `copy.tags` 2006 at 21:19, `post.tags` 2054 at 21:42), not a comparator fault.
  - `重试` on these failed jobs keeps the payload (`phase: verify`, known `remoteId`): it re-checks the existing post and never creates another. With the fix, retrying jobs 1959 and 2053 should now verify successfully.
- **BUG-01.** The route reblog was stored with `item_id = NULL` and only joined its original's work at the next pass's `groups.rebuild` (the database now shows both posts under item 757). Fix: `upsertPost` attaches a new reblog to its root's work immediately, and the reblog job regroups after creating a copy (manager rules). Test: `a route reblog joins its original's work as soon as it is made` (`desktop/test/reblog-policy.test.js`; fails without the fix).
