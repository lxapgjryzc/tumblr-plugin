# Tumblr Tag Helper: product spec

Status: **agreed** (2026-10-28), revised after three outside reviews. It lists every feature the extension has as of
0.9.3, says where each one lives after the reorganisation, and sets the rules the code must follow. §12 lists the
decisions taken. Added since: Redo AI on tumblr.com (T12) and blog roles (§3.9), 2026-10-28.

From here on, a new feature is added to this file first, then built.

Two different things are called "queue" in this file:
- the **Tumblr queue** is a blog's post queue (publish later);
- the **job queue** is the manager's list of bulk edits waiting to run (§5).

## 1. Principles

- **One job, one place.**
  - The extension starts writes to posts or likes only on the manager page and in the background passes. On
    tumblr.com it adds no edit actions of its own, with one exception the user asked for: Redo AI (T12) on a
    material blog's post, which the service worker runs for that one post.
  - Tumblr's own editing controls stay usable there and may get read-only helpers (suggestions, counts, filters).
- **One engine per kind of work.**
  - Every bulk edit goes through the job queue.
  - Every popularity number comes from one cache (`cache.tagStats`), filled by one sampler (`ensureTagStats`).
  - Every "is this tag weak" decision comes from `judgeTags`.
- **Never surprise.**
  - Anything that changes or deletes posts or likes first lists what it will do and how many posts it touches,
    then asks. This includes reblogging (the background passes run only while their switch is on).
  - The count comes from the synced library: "will change N posts; M already are so and are left alone". Legacy
    posts and other skips only show up while the job runs, in its outcomes.
  - Each step re-reads its post right before writing it and changes only the fields that step is about. Tag edits
    keep every other tag exactly as stored.
  - Legacy-editor posts are skipped (§8).
  - Community labels are re-read after the write; a label that didn't take is a failure.
  - Every post gets an outcome: written, unchanged, skipped (with the reason), failed (with the error) or not reached.
    A copy (§5.1) gets its own.
- **Fandom facts in packs, logic in core, choices in settings** (see README).
- **Compatible storage.** Keys and record shapes stay as they are (§9), so an upgrade keeps the library, packs and
  settings.

## 2. Surfaces after the reorganisation

```
tumblr.com pages              manager page (toolbar icon, one tab)           background (chrome.alarms, 10 min)
├─ tag autocomplete           ├─ sidebar: blog picker, page links,           ├─ reblog sync between sharing blogs
├─ blog search autocomplete   │   library sync state + Sync, Activity        ├─ auto-collect likes
├─ ▦ template panel           ├─ Posts                                       └─ ad-network ruleset on/off
│   (pick + insert into the   ├─ Tags   [Library | Tidy]   (sharing blogs)
│    open editor only)        │         Library: all · hidden   Tidy: weak · pack updates
├─ mass editor: read-only     ├─ Packs  pack cards · install · Review
│   helpers on Tumblr's own   ├─ Collection  today · sort · likes  (⚙ setup; material blogs)
│   controls                  ├─ Settings  general · appearance · tumblr.com · weak tags ·
├─ library sync on page load  │            templates · reblogs (setting + check) · AI ·
├─ hide ads / recs / AI art   │            my blogs (roles)
└─ 🤖 Redo AI on material     └─ job bar + Activity drawer
   blogs' posts
```

## 3. Feature inventory

Legend: **Keep** as is · **Move** to another surface · **Merge** with another feature · **Drop** (§4 says what
replaces it).

### 3.1 tumblr.com pages (`content.js`, `noads.js`, `mega-main.js`)

| # | Feature | After |
|---|---|---|
| T1 | Post editor `#tags` autocomplete (own tags, ranked by use and co-occurrence). With an empty library it offers nothing; the ▦ panel says "Sync the library in the manager" | **Keep**; suggestions come from the library of the role of the blog being posted to (§3.9) |
| T2 | Blog search box autocomplete (that blog's tags; picking opens `/blog/tagged/tag`) | **Keep** |
| T3 | ▦ template panel: pick characters, relations, works, formats and presets; search; relations offered once all members are picked; preview with the 20/30 cutoffs, weak-tag flags and on/off per tag; saved combos (save, apply, × to delete); "Check popularity"; Insert / Copy / Update tags / Undo insert | **Keep** |
| T4 | Panel "Packs & settings": install / update / remove packs, rules, template options | **Move** to manager Packs and Settings. The panel header gets "Manage ↗", which opens the manager on Packs; the Packs page links to the rules in Settings |
| T5 | Panel "Suggest changes": per-item add/remove suggestions, written into the installed pack | **Move** to Packs → Review |
| T6 | Panel edit mode and upkeep view (opened only from the mass editor's M4/M5 buttons) | **Drop** with M4/M5 |
| T11 | `fetchText` in the service worker (pack URL fetch for the panel, past the page's CSP) | **Drop**: the panel no longer installs packs, and the manager fetches directly |
| T7 | Hide ads: network ruleset, plus CSS for ad cells, Blaze, the sponsored box and the Premium upsell | **Keep** |
| T8 | Hide recommendations (Radar, recommended blogs, carousels) | **Keep** |
| T9 | Hide posts tagged as AI-made while browsing (`aiArtVerdict` on the visible tags) | **Keep** |
| T10 | Library sync in the background on page load (`autoSync`, at most every 6 hours) | **Keep** |
| T12 | "🤖 Redo AI" button on my material blogs' posts (§3.9), beside Tumblr's own Edit link | **New**, rules below |

- The panel's Insert, Update tags and Undo insert only change the tag chips in the open post editor, before the
  post is published.
  - Update tags swaps the panel's last insert for the new list.
  - Undo insert takes the last insert back out.
  - Tags typed by hand are never touched. None of these is a post edit.
- The panel's "Check popularity" is the same sampler as on the Tags page, with the same cache. It samples only the
  tags in the preview.
- Copy puts the panel's tag list, in insert order, on the clipboard as `tag one, tag two` (no `#`), the form
  Tumblr's tag box accepts when pasted.
- The panel follows the system's light or dark mode, on purpose: it sits on Tumblr's page, whose theme can't be read
  reliably. Settings → Appearance is for the manager only.

**Redo AI (T12)**:
- It shows on every post of a material blog that carries Tumblr's Edit link (`a[href^="/edit/<blog>/<id>"]`, which
  Tumblr shows only on my own posts): blog pages, the dashboard, search, a single post. The blog is matched by name
  through `cache.blogList`.
- A click sends `{ type: 'aiRedo', blog, id }` to the service worker, which runs `aiSortPost` on that post: the
  same images, prompt, palette and note rules as Collection → AI sort, written at once whatever `ai.autoApply`
  says (the click is the confirmation). A post the AI looked at before (`AI_MARK`) has its tags in the AI's lists
  and its AI note replaced; other tags stay.
- While it runs the button says "Thinking…" and can't be clicked again; Tumblr re-rendering the post keeps that
  state. Afterwards a box lists the tags written and the note, and says to reload to see them. Errors show in the
  same box: AI not set up, no permission for the endpoint yet (press Test in Settings → AI once; the service
  worker can't ask), no images, the endpoint's or Tumblr's message.
- It is one post, so it doesn't go through the manager's job queue, but it respects the leases (§5.3): while the
  manager runs jobs, the button says so and does nothing; while it writes, it holds `bgLease`.
- The manager's collection view picks the change up on its next re-read (§3.6).

### 3.2 Official mass editor (`/mega-editor`)

| # | Feature | After |
|---|---|---|
| M1 | Tiles: drag select, Shift+click range, Ctrl+A, all capped at 100 | **Keep** |
| M2 | Tiles: tag names on hover, private badge, multi-image mosaic and preview; own reblogs can't be selected | **Keep** |
| M3 | Tumblr's own "Add tags" box (the page's jQuery UI autocomplete) is fed library suggestions by `mega-main.js` | **Keep** (the box and its writes are Tumblr's) |
| M4 | Extension button "Tag templates" (edit selected posts by template) | **Drop** |
| M5 | Extension button "Tidy tags by packs" | **Drop** |
| M6 | Extension buttons "Make public", reblog control menu, "Sort tags by popularity" | **Drop** |
| M7 | Extension button in the label popup: "Remove community labels" | **Drop** |
| M8 | Tumblr's own "Edit tags" popup made wider, with a filter box, select all / none, `n/total` counts and decoded names beside the labels | **Keep** (its removals are Tumblr's) |
| M9 | Extension ⊕ in that popup, adding a tag to the selected posts that lack it | **Drop** |

### 3.3 Manager → Posts

The blog picker sits at the top of the sidebar. It picks the blog for Posts and is the default elsewhere.

| # | Feature | After |
|---|---|---|
| P1 | Box: published / drafts / Tumblr queue; tag filter; Load, More, All, "Stop loading" | **Keep** |
| P2 | Text search; state filter (public, private, labelled, unlabelled, reblogs off); card size | **Keep** |
| P3 | Grid multi-select: click, drag, Shift+click, Ctrl+A, invert, none. Own reblogs are marked "Synced" and can't be selected | **Keep**, one shared grid component (also used by Collection) |
| P4 | Tags card: tags on the selection with `n/total`; click to mark for removal, then "Remove N marked"; ⊕ adds a tag to the selected posts that lack it; add box with suggestions; "Reorder tags" | **Keep** |
| P5 | Characters card (was "Edit by template") | **Keep**, rules below |
| P6 | Visibility, reblog control, community labels (three cards) | **Merge** into one "Post settings" card, rules below |
| P7 | Progress bar and log under the side panel | **Merge** into the job bar (§5.4) |

The page has two rows:
- a sticky toolbar with P1 and P2;
- the grid, with the side panel on its right (below the grid under 900 px).

The shared grid takes `selectable(record)` from its page. Posts passes "not a copy"; Collection passes "any post"
(material blogs are outside the reblog sync, so they have no copies).

**Reorder tags** (was "Sort tags by popularity"; the button's tooltip says "template order, then by heat") first
samples the selection's tags that lack fresh stats. Then it rewrites each post's tag order with `sortTagsFair`: the
work's best tag first, then each character's, then each relation's (several of one kind in heat order, ties by
name), then everything else by heat; past the 20-tag cutoff a spelling with a new search word moves up just enough
to stay within it. No tag is added or removed.

Removing a tag a pack knows here is allowed: it is an explicit edit of the selected posts and confirms like any
other (§11).

**Characters card (P5)**:
- It shows the installed pack's items found on the selection: characters, relations, works and formats. Presets
  aren't shown, because they only pick members.
  - Solid: on every selected post. Dashed: on some, with `n/total`.
  - Clicking cycles solid → off; dashed → on → off → as is.
  - Taking a character off also takes off the relations they are in.
  - Adding a relation puts its own tags on every post. Its members are added only if picked too.
  - A search box adds items not on the selection yet. The pack's saved combos show as chips; clicking one turns
    its items on.
- "Apply to N posts" (`retagPost`) adds the newly on items' template tags and removes the off items' tags and
  retired spellings. A tag that an item still on also carries stays. The posts that change are put in template
  order, and the others keep their order.
- It uses Settings → Templates (`useBase`, `manyAt`, `spellings`), like the panel. Weak-tag flags are not shown
  here.
- The pack and rules are read once when Apply is clicked; editing a pack while the job runs doesn't change it.

**Post settings card (P6)**:
- Above each row, a count of the selection, e.g. "3 public · 2 private".
- Visibility: [Make public] [Make private]. Each touches only the posts not already in that state.
- Reblogs: [Allow reblogs] [Turn reblogs off], the same way.
- Labels:
  - three checkboxes choose categories for [Add labels], which adds them to every selected post;
  - [Remove all labels] clears them.
  - Every label write is re-read (§1).
- Each button confirms with the counts of §1, then queues one job.

### 3.4 Manager → Tags (library + cleanup + pack upkeep)

**Scope: the sharing blogs** (§3.9), that is the main blog and the side blogs whose role is sharing (a blog with no
role yet counts as sharing here). A reblog of my own post counts once, through its original. The header says so,
with the library's sync time and a Sync button.

Library has a second switch, **Sharing | Material**: Material shows the material blogs' tags (all but the
collection blog, as today) with the same All / Hidden chips. Tidy (Weak, Pack updates) covers sharing blogs only:
popularity and pack spellings don't matter on a material blog.

The top is a two-way switch, **Library | Tidy**, each with its chips:
- **Library** only looks after the library. Nothing there edits posts.
- **Tidy** edits posts. It shows a line saying so, and a sticky action bar: "N tags ticked · M posts · B blogs" with
  [Tick all shown] [Untick all] and the action button. Nothing is ticked without a click.

Any change of switch, chip, search or "Show more" clears the ticks. The search box filters, then the chip's order
applies, then the first 300 rows show, with "Show more" for the next 300.

| Group | Chip | Was | Shows | Order | Action |
|---|---|---|---|---|---|
| Library | All | Library page | every tag in the library, including tags added by hand that no post has yet (marked "added by hand"); posts, blogs, heat | uses, then heat | per row: show its posts (opens Posts filtered), hide. Above: "Add a tag" puts a tag into `cache.custom` so it is suggested |
| Library | Hidden | Library "show hidden" | tags hidden from suggestions | name | per row: unhide |
| Tidy | Weak | Cleanup page | weak tags no pack knows, with reason, heat and uses | reason (offtopic, dead, fuzzy, cold, few notes), then heat, coldest first | tick, then "Remove from N posts" |
| Tidy | Pack updates | Packs page upkeep | `planUpkeep` rules: retired spelling → current, or missing search spelling to add; pack, item, post count, three example links | pack, then item | tick, then "Apply to N posts" |

The confirmation of either Tidy action splits the post count by blog and shows up to three example links per tag
or rule.

- **Hidden** only keeps a tag out of the suggestions. It stays in the library and on every post.
- **Weak**:
  - Opening it shows the last result. "Check popularity" first says how many tags it will sample (every tag in
    scope that no pack knows and lacks fresh `tagStats`, about two requests each) and asks. It then samples them,
    most used first, saving as it goes, with progress and Stop, and judges them all. A stopped run can be
    continued later; sampled tags are not asked again for 7 days.
  - Without samples, only the notes rule can list a tag. The list says how many tags are still unsampled.
  - "offtopic" is judged against the packs whose base tags are on the same posts; tags on posts of no pack's
    fandom can't be offtopic. Tags a pack knows are left to Pack updates and Packs → Review (§11).
  - "Remove" takes the tag off every post in scope that carries it.
- **Pack updates**:
  - It is worked out locally from the synced library whenever the chip opens (no requests). With no pack
    installed it says so and links to Packs.
  - A rule applies only to posts that carry its pack's base tags. When two packs claim the same tag, that tag gets
    no rule and the conflict is listed.
  - The job reads packs and rules once when it is queued.
- The rules show as one line ("bottom 20% · search match below 30% · notes below 1") with a link to Settings.

### 3.5 Manager → Packs

One card per installed pack: name, version, item and tag counts, source URL, and "edited here" when changed by a
review.

| # | Feature | After |
|---|---|---|
| K1 | Install from URL, file or pasted JSON (format checked on install); Update from URL (asks first when edited); Remove (asks first); Copy JSON | **Keep** |
| K2 | Review (was T5) | **Move** here, rules below |
| K3 | Upkeep scan | **Move** to Tags → Pack updates |

- **Review** covers characters and relations, as the panel's "Suggest changes" did; works and formats are base-like
  and were never reviewed.
  1. It samples the pack's tags, then the add candidates, through `ensureTagStats`: fresh stats are reused, with
     progress, Stop and the read errors of §5.2.
  2. It then lists, per item (`suggestTagChanges` with the pack's base as `exclude` and `fandom`, and
     `settings.rules`):
     - tags to remove: offtopic (ticked); dead, fuzzy or cold (unticked);
     - tags to add: on at least 25% of the sampled posts of the item's tags (`minShare`), at most 8, without
       punctuation, and not offtopic themselves (`fandomShare` against the base at least `OFFTOPIC_SHARE`)
       (unticked).
  3. An item keeps at least one tag: a remove that would empty it is not offered.
  4. "Apply N changes" writes the ticked ones into the installed pack's JSON and marks it edited.
  5. The result stays until the page is left or the pack changes.
- **Update from URL** replaces the installed JSON with the fetched one. When the pack is edited here, it first says
  the local changes will be lost and offers Copy JSON. There is no merge.
- **Remove** changes no post and leaves the library alone. The manager also deletes the pack's saved combos from
  `templates`, and clears `templates.current`, `picks` and `overrides` when they belong to it. Its tags then show up
  in Weak like any other tags.
- Packs from a URL are fetched by the manager page directly. The host permissions cover raw.githubusercontent.com
  and gist.githubusercontent.com; other hosts must allow CORS.

### 3.6 Manager → Collection

Three sub-tabs and a ⚙ setup button. With no collection blog chosen, the page opens on the setup.

The page works on **material blogs** (§3.9). A picker at its top chooses which one Today and Sort show (default: the
collection blog; remembered in `settings.collect.view`). Likes, auto-collect and `collect.tags` always go to the
one collection blog, `collect.blog`, which the setup picks from the material blogs. With no material blog at all,
the setup says to mark one in Settings → My blogs (or picks a blog and marks it material when saved).

| Part | Holds |
|---|---|
| ⚙ Setup | the `settings.collect` fields below |
| Today | quick-study images: count (`daily`), "draw from" (`from`), another set, re-read the collection |
| Sort | grid with a filter (category, unsorted in a category, tag, looked at by the AI or not, suspected AI); category chips (on / partial) and "add another tag"; palette from pixels; AI sort and Stop; review of AI suggestions when `ai.autoApply` is off; check for AI images; delete reblogs and unlike |
| Likes | "Check my likes": likes not collected yet. Tick them, then reblog now or into the Tumblr queue |

- **AI-made likes** are those whose own poster tagged them as AI.
  - In "Check my likes" they are listed in their own group, with "Unlike N" when the switch is on. Nothing is
    unliked before that click.
  - In the background pass (auto-collect on) they are unliked at once when the switch is on, and the Activity entry
    names them. When the switch is off they are only skipped.
- **Delete reblogs and unlike** asks first, names the count and says it can't be undone.
- **AI sort**:
  - It reads each selected post's images (two posts at a time) and shows each card's state: thinking, waiting to be
    written, written or failed.
  - Its writes go into one "AI tags" job, which grows as results come in.
- Tags in the collection are plain English; the page shows them in the UI language through `STRINGS.*.refNames`
  (English tag → shown name). Unknown tags show as they are.
- Category, palette and "looked at by the AI" are worked out from each post's tags (`REF_GROUPS`, `AI_MARK`); AI
  notes live in the post itself. None of them is stored locally.
- Each material blog's posts are kept in `materials[uuid]` (§9), read the first time the blog is picked and
  refreshed like the collection is today (at most every 5 minutes when shown).

`settings.collect` (edited in ⚙ Setup, except `daily` and `from`, which Today remembers as they are changed):

| Field | Meaning | Default |
|---|---|---|
| `blog` | the collection blog's name | empty (setup opens) |
| `tags` | tags every collected reblog gets | none |
| `auto` | background auto-collect | off |
| `imagesOnly` | collect only posts with images | on |
| `autoPalette` | add palette tags on reblog | on |
| `unlikeAi` | unlike AI-made likes | on |
| `daily` | images in today's set | 4, 1–12 |
| `from` | today's set is drawn from this category or tag; empty = the whole collection | empty |
| `view` | the material blog Today and Sort show | `blog` |

### 3.7 Manager → Settings

One card per section:

| Card | Field (`settings.*`) | Default, range | Used by |
|---|---|---|---|
| General | `lang` UI language: auto / en / zh | auto (Tumblr's language, then the browser's) | everything |
| | `delay` ms between writes | 800; minimum 200 | job queue |
| | `autoSync` sync the library on page load | on | manager, tumblr.com |
| Appearance | `theme` | system / light / dark; system | manager |
| On tumblr.com | `hideAds`, `hideRecs`, `hideAiArt` | on, off, off | `noads.js`, service worker (ruleset) |
| Weak tags | `rules.cold` switch | on | `judgeTags` everywhere |
| | `rules.coldPct` bottom % by heat | 20; 1–100 | |
| | `rules.match` switch | on | |
| | `rules.matchMin` % of search results that carry the tag | 30; 0–100 | |
| | `clean.notes` switch | on | Weak only |
| | `clean.notesMax` average post notes below | 1; 0–1000 | |
| Templates | `useBase` add the pack's base tags | on | panel, Characters card |
| | `rules.manyAt`, `rules.spellings`: with N or more characters picked, keep each one's best M spellings by heat | 4, 2; each 1–20 | |
| My blogs | `blogRoles` (§3.9): sharing or material per blog | none set; the manager asks | everything |
| Reblogs between my blogs | `syncReblogs` | on | queue (copies), background |
| AI | `ai.base`, `ai.model`; key in `aiKey` (§10) | empty | Collection |
| | `ai.autoApply` write suggestions at once (else review first) | on | |
| | `ai.notes` write AI notes into posts; `ai.notesLang` their language (`AI_NOTE_LANGS`) | on; English | |

Kept in `settings` but not on this page: `collect` (Collection ⚙, §3.6), `card` (Posts card size, remembered as
changed), `tumblrLang` (Tumblr's UI language, written by tumblr.com tabs, used by `lang` auto).

The My blogs card lists every blog of the account (main first) with [Sharing] [Material] for each. The main blog is
always sharing and shows no choice. The collection blog is marked and can't be made sharing while it is the
collection blog. A change saves at once and says what follows from it (§3.9).

`TAG_RULES` / `TPL_RULES` in core are only the defaults that `settings.rules` overrides.

The Reblogs card is titled "Reblogs between my blogs: setting and check" and has three parts:
1. **Setting**: the sync switch.
2. **Check**: "Check reblogs" compares my synced posts locally (no requests). Beside it: the library's sync time and
   Sync, because the check is only as fresh as the library.
3. **Results**, below the card's fields with their own loading, empty ("all in step") and error states: drifted
   reblogs (fix all) and side-blog posts my main blog lacks (reblog now or into the Tumblr queue), each listed with
   links. Both actions confirm and go through the job queue. The background's past work is in Activity.

The AI card says what is sent: each sorted post's images (at most `AI_MAX_IMAGES` = 10, main ones first, each
downscaled more the more there are: `aiImageSize`) go to the endpoint in one request, and nothing else. The model
is told to ignore dividers, banners, text and logos and to judge the main pictures together. A post with several
images costs that many images.
"Test" sends one made-up image and is billed like any image. Chrome's permission for the endpoint's origin is asked
for on the first Test or AI sort (it needs a click). A refusal says what to do. "Forget key" empties `aiKey`.
The card also says that Redo AI on tumblr.com (T12) uses the same endpoint and key, through the service worker.

### 3.8 Background (`background.js`)

The work is the same as today, without `fetchText` (T11):
- the toolbar icon opens or focuses the manager;
- the ad ruleset follows `settings.hideAds`;
- a `chrome.alarms` alarm every 10 minutes runs `autoMaintain` (reblog sync, only posts newer than `autoSince`),
  then `autoCollect` (only likes newer than `collectSince`).
- Only the sharing blogs (§3.9) take part in `autoMaintain`: material blogs and blogs with no role yet are left out,
  and a side blog's posts are reblogged only when newer than both `autoSince` and the time it became sharing.
- It answers `aiRedo` from tumblr.com (T12).

The alarm survives the service worker going to sleep. A pass that is still running makes the next alarm a no-op.
A missed alarm just runs at the next one.

Changes:
- It answers `openManager` from the template panel.
- It respects the leases of §5.3.
- `autoMaintain` and `autoCollect` are independent: an error in one doesn't keep the other from running.
- Errors (offline, logged out, throttled) end that pass. They are logged once to `autoLog` / `collectLog`, and the
  next alarm tries again.
- The daily post limit (`isPostLimit`) ends that pass's reblogging the same way, logged once with Tumblr's message.
  Fixing drifted copies (edits, not new posts) still runs.
- `autoSince` is set once, when the switch first goes on, and never moves: a side-blog post already reblogged is
  found on main and left out, so a pass cut short just goes on next time.
- `collectSince` moves only past likes that were handled (collected, or skipped for good, such as an AI-made like
  or a 4xx refusal), so whatever an error or the limit cut off is tried again next time.

### 3.9 Blog roles

Each of my blogs has a role, set by hand in Settings → My blogs (`settings.blogRoles`):
- **Sharing**: fan works, original work and other posts meant for others. The main blog is always sharing.
- **Material**: reference images for my own study. The collection blog is always material.

| | Sharing blogs | Material blogs |
|---|---|---|
| Reblog sync (§3.8, Check reblogs, copies in jobs) | new side-blog posts go to main; copies follow their originals | left out entirely: their posts are neither reblogged to main nor treated as copies or originals |
| Tag library, autocomplete (T1, T2, M3) | the sharing library | a separate material library; the collection blog stays out of it (its tags are reblogged ones) |
| Tags → Tidy (Weak, Pack updates), popularity sampling | yes | no |
| Collection page (Today, Sort, AI sort, palette), Redo AI (T12) | no | yes; likes are collected only into `collect.blog` |
| Posts page | yes | yes |

- **Asking**: the role is never guessed. When the manager sees a blog with no role (on load, after a library sync
  or a blog list read), it shows a dialog listing those blogs with [Sharing] [Material] each, plus "Later". Until a
  blog has a role:
  - the background's reblog sync leaves it out (a line in Activity says so once);
  - the library and Tags count it as sharing, as before roles existed;
  - Collection and Redo AI don't offer it.
  After an upgrade every side blog has no role, so the dialog shows once with all of them.
- **Autocomplete** picks the library by the blog being posted to: the post editor's chosen blog (`currentBlogName`),
  a blog's search box by that blog, the mass editor by its blog. A blog with no role uses the sharing library. When
  the blog can't be told, the sharing library is used.
- **Changing a role** (in My blogs) changes no post. The card says what follows:
  - sharing → material: its posts leave the reblog sync; copies of them already on main stay as they are and are
    no longer kept in step; its tags move to the material library;
  - material → sharing: only posts newer than the change are reblogged to main by the background (Check reblogs
    lists older ones, to reblog by hand); its tags move to the sharing library.
- Reblogs of my own posts across roles (a sharing post reblogged onto a material blog, or the other way) are plain
  reblogs, not copies: nothing syncs them.

## 4. What replaces each dropped or moved feature

| Old | New place, control | Check |
|---|---|---|
| T4 install / update / remove | Packs → install card, pack card buttons | a pack installed there shows in the ▦ panel without a reload |
| T4 rules, template options | Settings → Weak tags, Templates | a changed rule changes the panel's flags at once |
| T5 suggest changes | Packs → Review → Apply | the pack is marked edited; Copy JSON gives the new JSON |
| T6 panel edit / upkeep views | Posts → Characters card; Tags → Pack updates | the two checks below |
| T11 `fetchText` | the manager fetches pack URLs itself | install from a raw.githubusercontent.com URL works |
| M4 tag templates | Posts → Characters card | tick and untick a character on selected posts, apply |
| M5 tidy by packs | Tags → Pack updates | rules listed, ticked ones applied in place |
| M6 make public | Posts → Post settings → Make public | only non-public posts are written |
| M6 reblog control | Posts → Post settings → Reblogs | only posts not already in that state are written |
| M6 sort by popularity | Posts → Tags card → Reorder tags | only the order changes |
| M7 remove labels | Posts → Post settings → Remove all labels | the re-read shows no label |
| M9 ⊕ fill | Posts → Tags card ⊕ | only posts lacking the tag change |
| Reblogs page (sync switch, check, fix, reblog to main, background log) | Settings → Reblogs card; log in Activity | |
| Cleanup page | Tags → Weak | |
| Library page (sync, search, hide, add by hand) | Tags → All / Hidden; Sync in the sidebar and in the Tags header | |
| Packs page upkeep | Tags → Pack updates | |

## 5. Job queue and friends

### 5.1 The job queue

There is one job queue per manager tab, shared by all its pages. Only one tab at a time may run jobs (§5.3). Jobs
run one after another, and each job runs one post at a time, with `settings.delay` between writes.

- **A job** is `{ title, group, items, step(item, ctl) }`, plus an optional `onEach(item, outcome)` that updates a
  card as each post finishes.
  - `step` reads the post, changes it and writes it. It returns `written`, `unchanged` or `skipped` (with a
    reason), or throws. The queue turns a throw into `failed`, or into a wait or a stop (§5.2).
  - Items left when a job ends are `not reached`.
  - A job of the same `group` that is still waiting can take more items (the AI's "AI tags" job grows this way).
- **Confirmation** happens before a job is queued (§1). Items added to a growing job were confirmed with the run
  that produces them.
- **Copies.** Reblogs of my own posts are never edited directly. While the reblog sync switch is on, writing an
  original also gives its copies the same tags, visibility, label and reblog control (`syncCopies`), in the same
  step.
  - Each copy gets its own outcome and its own line ("copy of …"), counted apart from the originals in the job's
    counts ("12 written · copies: 3 written, 1 failed").
  - A copy that fails doesn't change its original's outcome. Running the job again leaves the original unchanged
    and writes the copy again, because the step syncs copies even when the original needs no change.
  - With the switch off, copies are not touched at all; Check reblogs lists them as drifted later.
- **Stop** lets the current post finish, then ends the current job. "Stop all" also drops every waiting job, whose
  items become not reached.
- **Run next**: the job bar lists waiting jobs; "Run next" moves one to the front, so a small edit needn't wait for
  a long one. It starts after the current post's job ends or is stopped; a running job is never interrupted
  mid-post.
- **Kept as it runs**: a job's `jobLog` entry is written when it starts and updated every 10 posts and at the end,
  with the post ids still to do. A job cut short by closing the tab shows in Activity as "interrupted" with those
  posts as not reached, and "Select these" opens them selected in Posts.
- **Running a job again**:
  - Tag edits, visibility, labels, reblog control and sorting: safe, because a post already as wanted is `unchanged`.
  - Reblog to main: the missing list is worked out again from the synced library, so done posts drop out.
  - Collect: likes are matched by their original post (`rootKey`) against the collection, so collected ones drop out.
  - Delete and unlike: deleted posts leave the collection at once. Unliking a post that isn't liked is harmless.
    A run cut short lists what was done.

### 5.2 Errors

Writes in a job:

| Error | What happens |
|---|---|
| 401 | The request gets a fresh token once. If that fails too, the queue stops, the login notice shows and the rest is not reached |
| 429, 5xx, network, timeout | Wait (`Retry-After` when given, else 60 s, shown in the job bar) and retry the same post, up to 5 times; then the job pauses with "Resume" and "Stop" in the job bar, and waiting jobs stay queued |
| Daily post limit (`isPostLimit`) | The reblog job stops and its rest is not reached, with Tumblr's message. Other jobs (edits) go on |
| Other 4xx on one post | That post fails with the message; the job goes on |
| Legacy post | Skipped |
| Label not applied (re-read) | Failed, with "the community label did not take effect" |

Every Tumblr request has a 30 s timeout (`AbortController`); a timeout counts as a network error.

Reads outside jobs: loading posts, library sync, popularity sampling (Tags, panel, Review), likes scan, AI-image
check, reading the collection, pack URL fetch.

| Error | What happens |
|---|---|
| 401 | Fresh token once, then the read stops and the login notice shows |
| 429, 5xx | Wait and retry as above, up to 5 times, then stop with a message where the read runs |
| other | Stop with the message; data read so far is kept (sampling saves as it goes) |

AI endpoint, per image:

| Error | What happens |
|---|---|
| 401, 402, 403, 429 | The AI run stops; posts already looked at keep their results |
| 5xx, network, timeout (60 s) | Retry once, then that post fails and the run goes on |
| unreadable reply | That post fails; the run goes on |

### 5.3 One manager tab, and the background

- The toolbar icon and "Manage ↗" focus an open manager tab instead of opening another one.
- **Manager lease** (`jobLease` = `{ tab, at }`): written when a job starts and every 30 s while jobs run, cleared
  when the queue empties.
- **Background lease** (`bgLease` = `{ at }`): written when a pass starts and every 30 s while it runs, cleared at
  its end.
- A lease older than 2 minutes counts as gone (a crashed tab or worker).
- The background skips its pass while the manager lease is held.
- The manager doesn't start a job while the background lease is held. The job bar shows "Waiting for the
  background pass" and starts when the lease clears.
- Redo AI (T12) is treated like a background pass: it doesn't start while the manager lease is held, and it holds
  `bgLease` while it writes.
- A second manager tab opened by hand can browse. While another tab holds the manager lease, every button that
  would queue a job (or start AI sort, which leads to one) is disabled there, with a line saying which tab is busy
  and a "Switch to it" link. Nothing is refused halfway.
- Closing or reloading the manager while a job runs asks the browser to warn (`beforeunload`); the browser may not
  always show that warning. What was cut short is in Activity (§5.1).

### 5.4 Job bar and Activity

- **Job bar** at the bottom of the manager, shown while a job runs or waits:
  - the job's title, `i / n`, how many jobs wait;
  - the wait countdown;
  - Stop, Stop all.
- When the last job ends, the bar shows its summary until dismissed or the next job starts, with a link to its
  Activity entry.
- The bar is an `aria-live="polite"` region; it announces each job's start and end, not every post.
- **Activity** has a permanent link in the sidebar, with a dot when something failed since it was last opened.
  Opening the drawer clears the dot. It lists, newest first:
  - each finished job: title, time, counts of written / unchanged / skipped / failed / not reached, and the lines
    for skipped, failed and not-reached posts (storage key `jobLog`: the last 30 jobs, at most 100 lines each);
  - the background's `autoLog` and `collectLog` entries (the last 30 each).
- Filter chips: All / Jobs / Reblog sync / Collection.
  - Jobs: every `jobLog` entry.
  - Reblog sync: `autoLog`, plus jobs of group `reblogs` (fix, reblog to main).
  - Collection: `collectLog`, plus jobs of group `collection` (collect, AI tags, palette, delete, unlike).
- "Clear" empties all three logs and the dot.

### 5.5 Keeping surfaces in step

All surfaces read the same `chrome.storage.local` keys and listen to `chrome.storage.onChanged`.
- A pack installed or a rule changed on the manager reaches an open ▦ panel at once.
- A sync on a tumblr.com tab reaches the manager.
- `writer` marks which tab wrote, so a tab skips its own changes. While a sync runs, incoming `cache` changes are
  ignored, so the sync isn't swapped out mid-run.
- A library sync saves blog by blog: it reads the stored `cache`, replaces only the blog it just synced (and
  `tagStats` entries it sampled), and writes that back. Two syncs at once (a tumblr.com tab and the manager) then
  only repeat work; neither drops the other's blogs.
- Jobs read packs and rules once when queued (§3.3, §3.4).

### 5.6 Code layout

- `src/core.js` stays one DOM-free file. It gains `makeSession(fetchFn, base)`: token and CSRF from `/dashboard`,
  one retry on 401. The manager and the service worker share it; the content script reads the token from the page
  first.
- `extension/manager/*.js`, loaded in this order by `manager.html`:
  - `app.js`: state, API, dropdown, grid, job queue, activity, routing;
  - one file per page;
  - `main.js`, which starts the page.

  They are plain scripts sharing one `M` object.
- The extension has two dropdowns of its own: the content script's, in a shadow root, which catches keys before
  Tumblr's React does, and the manager's. The mass editor's autocomplete is Tumblr's own jQuery UI widget, fed by
  `mega-main.js`. Ranking is shared (`C.suggest`). The extension ships no library.
- `build.js` only copies `src/core.js` and writes the version, as now.

## 6. Visual design

- Tumblr-like palette: deep navy (`#001935` family) with a bright blue accent, plus a light theme. It follows the
  system unless Settings → Appearance says otherwise.
- Left sidebar: brand, blog picker, page links with icons, library sync state with a Sync button, Activity.
- Cards with rounded corners. Image-first grids. Sticky toolbars and a sticky action bar over long lists.
- Every list has an empty state that says what to do, a loading state and an error line.
- Accessibility:
  - visible focus rings;
  - buttons and inputs carry labels;
  - grids take Ctrl+A, and Escape closes the drawer and dialogs;
  - dialogs and the drawer keep focus inside while open and give it back to the button that opened them;
  - the job bar is a live region (§5.4);
  - text contrast meets WCAG AA in both themes;
  - motion is limited to short transitions, and none under `prefers-reduced-motion`.
- Below 900 px the sidebar collapses to icons and side panels move under the grid. There is no horizontal scrolling.
- Confirmations use an in-page dialog, not `confirm()`.

## 7. Glossary

| Term | Meaning |
|---|---|
| base tags | a pack's tags that say "this is the fandom"; they define the fandom for offtopic and count as the work when ordering |
| preset | a pack entry that picks several characters and relations at once |
| heat / popularity | a tag's followers, then the typical notes of its recent posts, then posts per day (`tagStats`, cached 7 days) |
| post notes | likes + reblogs + replies on a post |
| AI notes | the short text the AI writes into a collection post ("🤖 …") |
| weak | `judgeTags` says offtopic, dead, fuzzy or cold |
| offtopic | few of the tag's recent posts carry the pack's base tags (below `OFFTOPIC_SHARE`): another fandom's tag |
| dead | no recent posts and no followers |
| fuzzy | searching the tag mostly returns posts without it (below the search-match setting) |
| cold | in the bottom N% by heat of the tags compared; a tag that alone carries a search word is never cold |
| few notes | my posts with this tag average fewer post notes than the notes rule |
| retired spelling | an old tag a pack lists under `retired`: it identifies an item on old posts and is never inserted |
| pack updates (upkeep) | replacing retired spellings and adding missing search spellings on old posts |
| copy, synced reblog | my reblog of my own post on another of my sharing blogs; it follows its original |
| sharing blog | one of my blogs for posts meant for others; the main blog is one (§3.9) |
| material blog | one of my blogs for reference material; the collection blog is one (§3.9) |
| Redo AI | the 🤖 button on a material blog's post on tumblr.com that runs the AI sort again on it (T12) |
| drifted | a copy whose tags, visibility, label or reblog control differ from its original |
| 20/30 cutoffs | blog search reads a post's first 20 tags, sitewide search its first 30 |
| category | one of the collection's reference groups (`REF_GROUPS`: light, material, composition, subject, technique, palette); each has its own English tags |
| palette | the category of colour tags, worked out from an image's pixels |
| quick study | Today's small set of random collection images, the same all day for the same seed |

## 8. Legacy posts

A post made with Tumblr's legacy editor comes back with `should_open_in_legacy` set (`editPost` checks it when it
reads the post). Writing NPF to it would damage its formatting, so every edit skips it, with the reason
"legacy-format post".

## 9. Storage (`chrome.storage.local`, with `unlimitedStorage`)

| Key | Shape | Written by |
|---|---|---|
| `cache` | `{ blogList, blogs: { uuid: { name, syncedAt, posts: { id: [tags, ts, state, notes, source, labelled, reblog] } } }, custom, hidden, tagStats, lastAuto }`; `lastAuto` = last automatic library sync | manager, tumblr.com tabs (sync) |
| `settings` | §3.7 fields, plus `collect` (§3.6), `ai`, `card`, `tumblrLang`, `blogRoles` = `{ uuid: { role: 'share' / 'material', at } }` (`at` = when it was set, ms) | manager; tumblr.com tabs write only `tumblrLang` |
| `packs` | `[{ raw, source, edited }]` | manager |
| `templates` | `{ current, picks, favs: [{ pack, name, ids }], overrides }`; `current` = the panel's pack, `picks` = its picked item ids, `overrides` = the panel's per-tag on/off (`tagKey → bool`) | panel; the manager cleans up after a removed pack (§3.5) |
| `aiKey` | string | manager |
| `materials` (new) | `{ uuid: { blog, syncedAt, posts: { id: [rootKey, ts, images, tags] } } }`, one entry per material blog read so far, `images` = `[[small, big]…]`; category, palette and AI state come from `tags` (§3.6); the collection blog itself is `settings.collect.blog` | manager |
| `collection` (old) | one entry of the `materials` shape, for the collection blog; moved into `materials` by the schema 2 migration and then removed | — |
| `dailySeed` | `{ date, k }` | manager |
| `autoSince`, `collectSince` | first post / newest like time the background handles (seconds) | background, manager (when switched on) |
| `autoLog`, `collectLog` | `[{ at, done, skipped, error }]`, 30 kept | background |
| `jobLog` (new) | `[{ id, at, title, group, state: running / done / stopped / interrupted, counts, lines, todo: [{ blog, id }] }]`, 30 kept; a `running` entry whose tab holds no lease is shown as interrupted | manager |
| `jobLease`, `bgLease` (new) | §5.3 | manager, background |
| `writer` | `tab:time` of the last write | every writer |

- Missing fields get defaults on load, and unknown fields are kept. Defaults are filled by core (`withDefaults`)
  wherever a key is read: manager, panel, `noads.js` and the service worker. So it doesn't matter which starts first
  after an upgrade.
- Positional records (`cache` posts, `collection` posts) only grow at the end; a reader treats a missing slot as
  empty. Fields are never reordered or reused.
- A change that needs more than defaults sets `settings.schema` (now absent = 1) and ships with a migration in core,
  run by whichever surface reads the key first, and a test that loads 0.9.3 data.
- Schema 2 (blog roles): `collection` moves to `materials[collection.blog]`, and the collection blog gets
  `blogRoles[uuid] = { role: 'material' }`. Nothing else is set: other blogs wait for the dialog (§3.9).

## 10. Privacy and the public repo

- The AI key is stored only in `aiKey`. It never goes in `settings`, logs, error messages, the Activity drawer or
  any copied or exported JSON.
- Only the manager and, for Redo AI (T12) only, the service worker read `aiKey`. The content scripts never ask for
  it and never receive it: the button's message carries the blog and post id, and the reply carries tags, note or
  an error. A test checks that `content.js`, `noads.js` and `mega-main.js` don't name it, and that `background.js`
  reads it only in its `aiRedo` handler.
- Logs and errors never include the token, the CSRF token or cookies. A pack URL in a log or error keeps only its
  host and path (no query or fragment).
- What leaves the browser: Tumblr API calls to tumblr.com; pack URLs the user enters; and, only for AI sort, Redo
  AI and Test, downscaled images to the AI endpoint the user set (§3.7).
- Whatever takes "a post's image" (thumbnails, palette, today's set) takes the first of `postImages`, which puts
  decorative strips (one side at least 4 times the other) and tiny images last.
- The repo is public. Code, tests, fixtures, packs, docs, screenshots and commit messages use made-up blog names,
  ids and tags. Personal choices (collection tags, AI provider) are settings the user fills in.
- Nothing about an AI provider is in the code.

## 11. Who looks after which tag

This is about the automated tidying, which picks tags by itself:
- Tags a pack knows (its items' tags, `retired`, `base`) are tidied by Tags → Pack updates and Packs → Review only.
  The Weak list never shows them, so it can't suggest removing a tag a template would put back.
- All other tags are Weak's.

Explicit edits on Posts (the Tags card and the Characters card) work on whatever tags the user picks, pack tags
included; the user chose those posts and those tags. They confirm like any other job, with no extra warning.

## 12. Decisions

- Mass editor ⊕ fill (M9) is dropped with the other extension edit buttons there; the Posts Tags card has ⊕.
- "Check reblogs" lives in Settings → Reblogs between my blogs, as setting / check / results.
- Collection setup is a ⚙ on the Collection page; the AI endpoint stays in Settings.
- The cleanup's "few notes on my posts" rule stays, inside Weak.
- The queue lives in the manager tab. Closing it asks first, and there is one manager tab. There is no persistent
  queue (§5.3).
- Unliking AI-made likes has a switch in the collection setup, on by default. A manual check lists them and unlikes
  on a click. The background unlikes at once and logs them.
- The background stays outside the queue. Manager and background each hold a lease, and each yields to the other.
- Third review: no priority lanes in the queue; "Run next" covers the small-edit-behind-a-long-job case (§5.1).
  Check reblogs stays in Settings, with the library's sync time and Sync beside it.
- Removing pack tags from Posts needs no extra warning (§11).
- Redo AI is the one write started on tumblr.com, asked for by the user; it runs in the service worker, which may
  read `aiKey` for it alone (§1, §10).
- Blog roles: material blogs are left out of the reblog sync, have their own tag library and get the Collection
  page's tools; the role is set by hand and never guessed, and the manager asks about each new blog (§3.9).

## 13. Acceptance checks

Automated (jsdom smoke tests against a fake API) unless marked *manual*.

- **Posts**:
  - select by drag, Shift and Ctrl+A;
  - mark and remove a tag; ⊕ fill;
  - Make public writes only private posts;
  - labels are added, removed and verified;
  - Reorder tags changes only the order;
  - a reblog of my own post can't be selected and follows its original;
  - a copy that fails is its own failed line, and its original stays written;
  - removing a pack's tag from the selection works.
- **Characters card**: untick a character on two posts and apply; add them back from search; a pack edited while
  the job runs doesn't change it.
- **Tags**:
  - sync; two syncs at once keep both blogs;
  - Weak lists only the cold or fuzzy tag and removes it from posts on two blogs; the confirmation splits by blog;
  - "Check popularity" says how many tags it will sample before it starts;
  - ticks clear on search, chip change and Show more; Show more adds the next 300 rows;
  - a tag added by hand shows in All;
  - Hidden hides from suggestions and keeps the tag on posts;
  - Pack updates replaces a retired spelling in place.
- **Packs**: install by paste; a bad pack is rejected with a message; Review ticks another fandom's tag and writes
  the pack; Remove deletes its saved combos.
- **Settings**:
  - switching the UI language to Chinese changes the page's strings;
  - Check reblogs finds a missing side-blog post and reblogs it into main's Tumblr queue.
- **Job queue**:
  - a 429 waits and retries the same post;
  - five 429s pause the job, and Resume goes on with the same post;
  - a request that hangs times out after 30 s and is retried;
  - "Run next" moves a waiting job to the front;
  - a job's `jobLog` entry exists while it runs, and an entry left `running` shows as interrupted with its posts;
  - a second 401 stops the queue with the login notice;
  - another 4xx fails one post and the job goes on;
  - a legacy post is skipped;
  - Stop reports the rest as not reached;
  - a second job waits its turn;
  - a daily post limit stops only the reblog job;
  - a running job sets `jobLease`;
  - a held `bgLease` makes a job wait; a held `jobLease` of another tab disables the job buttons.
- **Background**:
  - the daily post limit ends the reblogging with one log line, fixes still run, and the next pass reblogs the
    rest;
  - an error in `autoMaintain` doesn't stop `autoCollect`;
  - with `unlikeAi` off, an AI-made like is skipped and not unliked.
- **AI**: a refused permission, a 402 and a timeout each give their message; a 402 stops the run and keeps results.
- **Redo AI**: the button shows on a material blog's own post and not on a sharing blog's; a click writes the AI's
  tags and note (replacing an older note and the AI lists' tags, keeping others); a missing permission and a held
  manager lease each give their message and write nothing.
- **Blog roles**:
  - an upgrade from 0.9.3 moves `collection` into `materials` and marks the collection blog material;
  - a blog with no role makes the manager ask; "Later" leaves it out of the background reblog sync;
  - a material blog's new post is not reblogged to main, and its reblog of a main post is not synced as a copy;
  - autocomplete in the editor for a material blog offers the material library's tags, for a sharing blog the
    sharing library's;
  - Weak and Pack updates list nothing from material blogs;
  - material → sharing reblogs only posts newer than the change.
- **Activity**: a finished job's summary and failures appear; a manual Collection job shows under the Collection
  filter; opening the drawer clears the dot; Clear empties it.
- **Panel**: pick, insert, update, undo; "Manage ↗" sends `openManager`; a pack installed in storage shows without a
  reload.
- **Mass editor**: selection helpers, counts, decoded names; no extension edit buttons.
- **Privacy**: the AI key appears in no log, no `settings` and no Activity line; `content.js`, `noads.js`,
  `mega-main.js` and `background.js` don't contain `aiKey`; a logged pack URL has no query string.
- **Upgrade**: 0.9.3 storage loads unchanged.
- *Manual*, in Chrome:
  - every page at 1400 px, 900 px and 800 px wide, light and dark;
  - close the page during a job;
  - a second manager tab;
  - the background skipping its pass during a job, and a job waiting for a background pass.
