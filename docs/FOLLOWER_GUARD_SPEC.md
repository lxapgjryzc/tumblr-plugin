# New-follower protection

Design date: 2026-11-06. Companion to [DESKTOP_PRODUCT_SPEC.md](DESKTOP_PRODUCT_SPEC.md). This is an implementation design, not a deployed classifier or permission to take actions against current followers during development.

**Delivery status (2026-11-06):** `desktop/` implements baseline discovery, evidence review, allowlisting and manual block/unblock flows. Automatic blocking remains unavailable pending the quality evaluation below; real block/unblock acceptance is still unverified. Reports use Tumblr's UI and remain pending until user confirmation, which is not an automated transport receipt. Review mode is an intermediate delivery required by section 5, not removal of the automation goal or completion of every stage-4 acceptance check. See [implementation status and gaps](DESKTOP_IMPLEMENTATION_STATUS.md). No new account action is authorised by this update.

## 1. Outcome and scope

Under the confirmed application/companion split, the application alone owns follower discovery, evidence, AI configuration/classification, review, allowlists, block jobs and reporting state. The extension has no duplicate follower inbox, classifier or scheduler. It may supply page context or a validated Tumblr-only reporting step for the same app-owned operation, returning its result/uncertainty; opening the browser is not a completed report. See DESKTOP_PRODUCT_SPEC.md section 4.3. When the app is unavailable, the companion does not independently continue follower actions.

The user wants spam followers handled automatically, including blocking and reporting, with innocent followers protected. The goal is less daily cleanup. Do not classify people by presumed gender, sexuality, nationality, appearance, or interests. The subject is observable spam, deceptive solicitation, and scam behaviour.

The main blog is the initial proposed monitored scope; additional owned blogs can be selected. Never infer that every follower of a particular topic blog is suspicious. Classifier and reporting failures must not affect writing or ordinary post management.

Three distinct results must remain visible: assessment, block status per owned blog, and report status per reported target. An AI recommendation is none of these remote actions.

## 2. Capability evidence and release checks

[STAGE0_RESULTS.md](STAGE0_RESULTS.md) now records browser-exited passes for follower, following and block-list reads. Block/unblock remains unverified pending a controlled test account; API reporting is unsupported. The earlier documentation references below describe the interface, not proof that block/unblock has passed. No new live follower action is authorised by this design update.

Official sources checked on 2026-11-06:

- [Tumblr API](https://github.com/tumblr/docs/blob/master/api.md) documents OAuth follower retrieval and blog block retrieval/creation/removal. These operations still require end-to-end verification with the intended adapter. No public spam-report endpoint was found in this documentation.
- [Blocking users](https://help.tumblr.com/knowledge-base/blocking-users/) states that blocking is per blog; blocks on different owned blogs are separate actions.
- [Reporting spam](https://help.tumblr.com/knowledge-base/reporting-spam/) documents reporting through the Tumblr UI. A validated browser workflow is a possible adapter, not an already demonstrated capability.

| Operation | Release contract |
|---|---|
| Read followers and public evidence | Direct authorised API while the browser is exited; visibly defer unavailable evidence |
| Block/unblock | Direct API; selected owned-blog scope; verify resulting block list |
| Report | Validate actual supported transport and completion signal; keep pending if unavailable |
| Browser-assisted report | Requires connected signed-in browser and explicit enabled automation policy; otherwise expose Open report action |

Do not ship a fake success state for reporting or silently claim browser-independent reporting. A real browser-independent reporting requirement remains unfulfilled until such a transport is demonstrated. State this in the capability report and UI. Never generate a false report for a test; use fixtures and inspection for report-flow development, and verify real submission only on a genuinely justified case under user authorisation.

## 3. Discovery and baseline

1. Sync selected blogs and the user's own identities. Read existing blocks, followed blogs and explicit allowlist entries before planning any automatic action.
2. First sync builds an existing-follower baseline. Existing followers are available for an explicit historical review, but do not silently count as new or immediately enqueue a bulk block.
3. Incremental scans record first observed time, source blog, stable target identity and current name. First observed time is not a claimed exact follow time.
4. Use pagination, overlap and deduplication; do not assume a first-page read covers every follower or rely on undocumented ordering. Reconcile periodically. Interrupted scans preserve their checkpoint and incomplete-coverage status.
5. A missing record in a failed or partial scan is not an unfollow. A total follower count is not sufficient to identify who followed.
6. Target renaming must preserve history using verified stable identity. If the adapter cannot resolve identity reliably, hold automatic actions; never apply an old decision to a different owner of a reused name.
7. A previously handled target appearing again reuses its case; do not resend the same report on every scan.

Stage 0 found follower entries contain names but no UUID. Resolve a new follower through a blog-info lookup before attaching stable-ID protections, evidence or action history. Cache the verified name-to-ID mapping with observation time, budget the extra request, and revalidate identity before an action when a rename/reuse is possible. Lookup failure leaves identity unresolved and prohibits automatic blocking/reporting; never substitute a username for a stable ID. Following/block-list UUIDs help reconcile known identities but do not make unresolved follower names safe action targets.

The proposed scan interval follows the desktop's ten-minute scheduler. Catch up after sleep/offline periods without assuming events were observed while the desktop was stopped.

## 4. Evidence collection

Collect a bounded sample of public profile text and public posts, with exact source references and observation times. Proposed initial bounds: profile plus up to ten recent posts; configurable later. Preserve missing/inaccessible fields as unknown. Do not label a blog new based only on the date of its oldest sampled post.

Represent each evidence item with its source blog/post, original-versus-reblog attribution, short exact excerpt or structured observation, time and content hash. Distinguish the target's own solicitation from someone else's text it quoted, criticised or reblogged. If there is not enough context to distinguish them, abstain.

Potentially relevant signals include repeated deceptive solicitation authored by the target, directly observed impersonation/scam instructions, and corroborated reuse of a user-confirmed spam campaign. An external link, identical stock avatar or shared link service alone is insufficient. Do not treat statements by another account as proven facts about the target.

The following cannot independently justify blocking or reporting:

- Nudity, adult-art labels, fanart, ships, queer content or an adult creator's ordinary promotional link.
- Empty profile, few posts, no avatar, a number-heavy username, low engagement, or a recently observed account.
- Language unfamiliar to the model, a request for donations, or legitimate commissions/sales.
- Following the user without engaging, or not following the user's fandom.

Do not crawl private messages, other followers' private data, or external destinations as part of the default scan. External URLs can be displayed as inert evidence. No automatic login, download, redirect-following or form submission on a suspect website is needed to classify a follower.

## 5. AI contract and decision policy

The configured AI provider is optional. Use its key from the credential store. Before enabling inspection, explain that selected public profile/post evidence will be sent to that provider. Do not send browser cookies, OAuth tokens, private drafts, the complete follower graph, or unrelated account data. Apply a user-visible request/cost budget.

Evidence text is untrusted data. Any instructions embedded in profiles or posts, including requests to ignore rules or invoke a tool, are quoted evidence only. The model receives no action tools. Its output is validated against a strict schema:

| Field | Required meaning |
|---|---|
| `assessment` | `no_spam_evidence`, `insufficient_evidence`, `review`, or `spam_candidate` |
| `evidence_ids` | References to observations actually supplied to the model |
| `counterevidence_ids` | Relevant legitimate-use context and conflicting observations |
| `reason_codes` | Bounded behavioural categories; never inferred sensitive traits |
| `explanation` | Concise Chinese explanation for the user's review |
| `limitations` | Missing pages, uncertain attribution, translation or context issues |

A model's confidence number is not an estimated probability of guilt. Do not make `score > 0.9` the action rule. Reject nonexistent evidence IDs, fabricated quotations, invalid JSON, unsupported categories and action requests. An invalid response becomes a retryable assessment failure, never a spam decision.

Deterministic policy evaluates the evidence and model output:

1. Own identities and user allowlist: protected. The user's followed accounts are also protected from automatic actions while that protection is enabled; proposed default is on.
2. Missing protection-state reads, ambiguous identities, stale evidence or conflicting context: defer or review.
3. No affirmative behavioural evidence: leave alone. Do not put every empty/unknown blog in a daily review queue.
4. A suspicious but uncorroborated signal: optional review, no automatic block/report.
5. An eligible, validated evidence pattern with corroborating observations and no protection/contradiction: automatic block candidate if that policy is enabled.
6. Reporting additionally requires a supported violation category, source evidence that supports that category, and a validated reporting adapter. A block alone never supplies grounds for a report.

Repeated copies of one text are one evidence family, not independent votes. Two model calls agreeing are not independent evidence. High-confidence automation must use tested, bounded evidence patterns; do not grant unrestricted discretion to an LLM. Before those patterns have passed the quality checks below, the product operates in review mode and labels automatic processing unavailable.

## 6. Modes and daily flow

| Mode | What happens |
|---|---|
| Off | No new inspection or actions |
| Review | Evidence and recommendations only |
| Automatic protection | Eligible new cases are blocked within the selected scope; report handling follows its own enabled policy |

Automatic reporting is a separate switch and capability. The initial setup shows the chosen blogs, protected-account rules, AI data scope, action limits and whether reporting needs the browser. Once enabled, routine eligible cases need no repeated confirmation. Do not turn the requested automation into a permanent manual-only workflow; review is for uncertain cases and validation, with a documented path to automation.

The ordinary user sees a short digest such as “3 blocked · 2 reports pending browser · 1 needs review”, based on actual stored results. These are illustrative counts, never seed production data. Review rows show evidence, counterevidence, relevant source links and the actions “正常账号”, “拉黑”, “举报并拉黑”, “稍后”. Display the exact owned-blog scope before applying a manual batch.

“正常账号” creates a durable allowlist entry and cancels unsubmitted block/report jobs for that target. If an app-owned block already exists, offer “解除拉黑并加入白名单” as one operation. Mere dismissal is not a spam label. Keep uncertain cases quiet rather than repeatedly interrupting the user.

## 7. Execution, verification and correction

Store the intent and evidence revision before a write. Immediately before sending, recheck target identity, current allowlist/following protections, policy revision and relevant evidence. Model or rule changes invalidate unsubmitted stale decisions. Expired evidence is re-fetched, not blindly acted on after a long offline period.

Blocking uses one operation per target and owned blog. Verify against the resulting block list, handling pagination and bounded eventual-consistency retries. Read failure means unknown result, not success. A pre-existing block is “already blocked”; the app must not claim it created that block or automatically undo it later. Avoid bulk options that implicitly force unrelated subscription changes.

Reporting states are separate:

`not_requested` → `pending` → `waiting_for_browser/auth` or `submitting` → `submitted` / `outcome_unknown` / `failed` / `cancelled`.

`submitted` means an explicit platform completion acknowledgement was observed, not that the account was sanctioned. Record the signal and time. If no reliable acknowledgement exists, use `outcome_unknown`; do not resend merely because a receipt is missing. Opening the page, clicking a menu, or blocking is not report completion. Changes to UI/language/selector structure stop that adapter safely and preserve the case for review.

If the reporting UI also blocks, reconcile the resulting blog-specific block state and avoid duplicate actions. If blocking first prevents access to reporting, preserve evidence and queue an explicit reporting step; do not undo protection just to make the report UI accessible.

Unblocking and undoing a report are not equivalent. The app can request and verify removal of its selected blocks; it must not claim to retract a submitted report or restore all prior follower relationships. A mistaken-action correction first protects the target and cancels pending reports, then verifies requested unblocks. Show any report already submitted. No automatic follow or message is sent during correction.

Apply bounded per-pass and daily action limits, configured and shown at setup. A spike in candidates beyond those limits creates a digest/review backlog; it does not broaden eligibility. A confirmed false positive pauses the responsible automated evidence pattern pending review, retaining other unrelated workflows. API throttling, AI outage and authentication failure defer work rather than triggering a fallback mass action.

## 8. Persistence and privacy

| Entity | Key data |
|---|---|
| Follower observation | Monitored blog, target stable ID/name history, first/last seen, baseline status, coverage |
| Evidence snapshot | Target/source IDs, attribution, excerpt/hash, observed time, retrieval status |
| Assessment | Evidence IDs/revision, provider/model/prompt version, schema result, reasons, limitations |
| Decision | Policy revision, protected-state snapshot, eligibility reasons, proposed scope |
| Block operation | Target and owned-blog IDs, pre-existing/app-owned status, verification, correction |
| Report case | Target and category, evidence revision, adapter, submission state and acknowledgement |
| Allowlist | Stable target ID, user reason, creation time; no automatic expiry |

Retain short audit records for actions until the user clears them. Proposed evidence retention: ninety days for resolved cases, with active/unknown cases retained until resolved. Keep allowlists and deduplication records durable; deleting bulky evidence must not cause a repeat report. Exclude follower evidence from ordinary content exports and repository fixtures. Private backups may include the module when clearly labelled; omit credentials and restore with automation paused.

## 9. Quality and acceptance

Zero mistakes cannot be promised. Measure false positives, precision, recall, abstention and review burden separately on labelled representative cases. Include Chinese, English and Japanese material as relevant to this account. Use campaign-disjoint held-out cases so copies of one spam template do not inflate evaluation. Document dataset size, labels and uncertainty; a self-reported model score or a handful of passing examples does not establish production precision.

Automatic action patterns require zero false positives on the protected regression set, acceptable measured precision on held-out cases, and a reviewed shadow-mode trial. Set and document numeric release targets before enabling automatic actions; do not invent achieved results in the UI. Sparse evidence is a reason to keep an unvalidated pattern in review mode. A new model/prompt/pattern must pass these checks again before gaining action authority.

| ID | Required scenario |
|---|---|
| F01 | Browser fully exited: follower scan, block and unblock operate through the authorised API |
| F02 | First sync marks old followers as baseline and sends no automatic block/report |
| F03 | More than one page, partial failures, offset shifts and restarts preserve coverage and avoid duplicate cases |
| F04 | Adult artist, queer fanartist, empty lurker, numbered username and unfamiliar language alone cause no action |
| F05 | Legitimate creator link, commission announcement and donation request alone cause no action |
| F06 | A post warning about a scam is not treated as the author's own scam solicitation |
| F07 | Allowlisted/own/followed identities are protected; failed protection reads defer actions |
| F08 | A corroborated spam fixture reaches the enabled block path; weaker cases abstain or enter review |
| F09 | Forged evidence IDs, fabricated quote, malformed response and prompt injection cannot trigger a write |
| F10 | An allowlist correction between classification and execution cancels pending writes |
| F11 | Renamed blog retains protection; reused username cannot inherit another identity's decision |
| F12 | Block main only versus selected multiple blogs produces correct per-blog verification and partial-failure states |
| F13 | Existing external block is not marked app-owned; correction does not silently remove it |
| F14 | Block success plus unavailable reporting displays blocked/report pending, never reported |
| F15 | Lost report response or acknowledgement prevents blind resubmission across restarts/adapters |
| F16 | Explicit report acknowledgement records submitted, without claiming platform enforcement |
| F17 | Browser closure, login expiry or changed report UI pauses only the affected report action |
| F18 | Correcting a false positive adds protection, cancels pending reports and verifies requested unblocks |
| F19 | Rate limits, AI errors, budget exhaustion and candidate spikes do not broaden action eligibility |
| F20 | Backup/restore retains allowlist and case dedupe, starts paused and does not replay submitted reports |
| F21 | No credentials, private drafts or unrelated follower graph are included in AI requests |
| F22 | Public evidence sampling is labelled incomplete; unavailable pages do not become evidence of spam |
| F23 | Simulated reporting never submits an actual false report; live tests have explicit authorised scope |

Claude's delivery must include capability results, evaluation results, unhandled cases and a demonstrated correction flow. This specification supplies requirements, not evidence that any acceptance check has passed.
