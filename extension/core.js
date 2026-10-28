// Shared logic for the extension's content script, manager page and service worker.
// Plain script (no modules): loaded as a content script, with <script> and with importScripts().
// Everything is exposed on the TTHCore object.
const TTHCore = (() => {
  'use strict';

  // ---------- Utilities ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const enc = encodeURIComponent;
  // The official mass editor shows tags URL-encoded (yuuto%20%28arc%20v%29); decode them to readable text
  const decodeTag = s => {
    if (!/%[0-9a-f]{2}/i.test(s)) return s;
    try { return decodeURIComponent(s); } catch {
      return s.replace(/(%[0-9a-f]{2})+/gi, m => { try { return decodeURIComponent(m); } catch { return m; } });
    }
  };
  const norm = t => decodeTag(String(t ?? '')).trim().replace(/^#+/, '').replace(/\s+/g, ' ');
  const key = t => norm(t).toLowerCase();
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The web client's apiFetch camelCases response keys while a raw fetch returns snake_case; accept both
  const pick = (o, ...names) => { for (const n of names) if (o && o[n] !== undefined) return o[n]; };
  const debounce = (fn, ms) => { let tm; return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); }; };
  const qs = params => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') s.append(k, v);
    const str = s.toString();
    return str ? '?' + str : '';
  };
  const uniqTags = tags => {
    const seen = new Set(), out = [];
    for (const t of tags) { const n = norm(t), k = n.toLowerCase(); if (n && !seen.has(k)) { seen.add(k); out.push(n); } }
    return out;
  };
  // Append tags a post doesn't have yet, leaving its existing tags exactly as stored
  const withTags = (current, extra) => {
    const out = current.slice();
    for (const tag of extra) if (!out.some(x => key(x) === key(tag))) out.push(norm(tag));
    return out;
  };
  const fmtNum = x => (x < 10 ? String(Math.round(x * 10) / 10) : String(Math.round(x)));

  // ---------- i18n ----------
  // Only en and zh are maintained. To add a language, add STRINGS[code] and LANG_NAMES[code];
  // any key a language lacks falls back to English.
  const LABEL_CATEGORIES = ['sexual_themes', 'violence', 'drug_use'];
  const STRINGS = {
    en: {
      // shared
      langTitle: 'Language', langAuto: 'Auto (browser language)',
      st_published: 'Public', st_private: 'Private', st_draft: 'Draft', st_queue: 'Queued', st_queued: 'Queued',
      cat_sexual_themes: 'Sexual themes', cat_violence: 'Violence', cat_drug_use: 'Drugs & alcohol',
      ddRelated: 'Related tags', ddFrequent: 'Frequent tags', ddMine: 'My tags', ddBlog: "This blog's tags", ddCo: 'related',
      setPublic: 'Make public', setPrivate: 'Make private', labelOff: 'Remove community labels',
      needSelect: 'Select some posts first',
      confirmRun: (title, n) => `${title}\n\nThis will edit ${n} post(s). Continue?`,
      progress: (title, i, n) => `${title}: ${i} / ${n}`,
      logSkip: (id, r) => `Skipped ${id}: ${r}`, logFail: (id, r) => `Failed ${id}: ${r}`,
      logDone: (title, stopped, ok, skip, fail) => `${title}${stopped ? ' (stopped)' : ''}: ${ok} succeeded, ${skip} skipped, ${fail} failed`,
      skipState: st => `state is "${st}", skipped`,
      skipLegacy: 'legacy-format post; skipped so an NPF edit does not break its formatting',
      labelNotApplied: 'the community label did not take effect (the API may not accept this field)',
      actTagsAdd: tags => `Add tags: ${tags}`, actTagsRemove: tags => `Remove tags: ${tags}`,
      syncing: (b, n, total) => `Syncing ${b}: ${n}${total ? ' / ' + total : ''}`,
      syncStopped: 'Sync stopped', syncDone: n => `Sync finished, ${n} tags`, syncFailed: e => `Sync failed: ${e}`,
      // content script: official mass editor
      meFilter: 'Filter tags', meAll: 'All', meNone: 'None', meReading: 'Reading tags of the selected posts…',
      meCount: (n, total) => `On ${n} of ${total} selected posts`, meFill: 'Add to the selected posts that lack it',
      meLimit: 'The official editor can select at most 100 posts', meUpkeep: 'Tidy tags by packs',
      meCopyLocked: 'This is a reblog of your own post: it follows the original automatically, so it can\'t be selected here',
      tplEditing: n => `Edit ${n} post(s) by template`, tplSome: 'On some of the posts (left as is unless clicked)',
      tplCard: 'Edit by template', tplAddPh: 'Add a character or relation…', tplNothingOn: 'No character of this pack on the selected posts yet',
      tplPart: (n, total) => `On ${n} of ${total} posts. Click to put it on all, click again to take it off all`,
      tplEditPlan: 'Changes', tplNoChange: 'No change yet: tick or untick someone', tplWillChange: (n, total) => `${n} of ${total} posts will change`,
      tplApplyTo: n => `Apply to ${n} post(s)`, actRetag: 'Edit tags by template',
      imagesN: n => `${n} images`,
      sortHeat: 'Sort tags by popularity', heatChecking: (i, n) => `Checking tag popularity: ${i} / ${n}`,
      // content script: tag templates
      tplOpen: 'Tag templates', tplSearch: 'Search names or tags', tplFavs: 'Saved', tplPicked: 'Picked', tplNone: 'Nothing picked yet',
      tplIncludedBy: name => `Included by ${name}`, tplToggleHint: 'Click a tag to turn it on or off',
      tplCount: n => `${n} tags`, tplCombos: 'Together in this post', tplNotCombo: 'Neither',
      why_dead: 'No recent post carries this tag and nobody follows it', why_fuzzy: m => `Searching it mostly shows other tags (${m}% really have it)`,
      why_cold: (i, n) => `Among the least popular tags here (rank ${i} / ${n})`, why_off: 'Turned off by hand',
      why_extra: 'A lower spelling; with many characters picked each keeps its best ones',
      why_offtopic: p => `Mostly used by another fandom: only ${p}% of its recent posts carry this pack's base tags`,
      tplReview: 'Suggest changes', tplReviewing: (i, n) => `Reading tag samples: ${i} / ${n}`,
      tplReviewTitle: name => `Suggested changes to "${name}"`, tplReviewNone: 'No changes to suggest',
      tplRmTitle: 'Remove', tplAddTitle: 'Add (often used together)', tplApply: n => `Apply ${n} change(s)`,
      tplApplied: n => `Applied ${n} change(s) to the pack`, tplShare: p => `on ${p}% of the posts`,
      tplExport: 'Copy pack JSON', tplEdited: 'edited here',
      tplUpdateEdited: 'This pack has changes made here. Updating from the URL replaces them. Continue?',
      tplFitUnknown: 'fandom not checked', tplMarkerOnly: 'No tag; only marks the relation',
      tplPresets: 'Combos', tplRelations: 'Relations', tplOther: 'Other',
      tplOver20: 'blog search reads only the first 20', tplOver30: 'sitewide search reads only the first 30',
      tplDropFlagged: n => `Turn off ${n} flagged`,
      tplManyA: 'With', tplManyB: 'or more characters, keep the best', tplManyC: 'spellings of each',
      tplInsert: 'Insert', tplCopy: 'Copy', tplClear: 'Clear', tplSaveFav: 'Save combo', tplFavName: 'Name for this combo',
      tplRemoveFav: name => `Remove saved combo "${name}"?`,
      tplCheck: 'Check activity', tplChecking: (i, n) => `Checking tag activity: ${i} / ${n}`,
      tplCheckDone: (n, cold, failed) => `Checked ${n} tags, ${cold} look cold` + (failed ? ` (${failed} failed)` : ''),
      tplAllFresh: 'These tags were checked recently', tplCopied: 'Copied', tplInserted: n => `Inserted ${n} tags`,
      tplUpdateTags: 'Update tags', tplUndo: 'Undo insert', tplUpdated: (removed, added) => `Removed ${removed}, added ${added}`,
      tplUndone: n => `Removed the ${n} inserted tag(s)`, tplNotRemoved: n => `${n} tag(s) could not be removed; remove them by hand`,
      tplNoInput: 'Open the post editor first; the tags were copied instead', tplPickFirst: 'Pick something first',
      tplManage: 'Packs & settings', tplBack: 'Back', tplNoPack: 'No template pack installed. Install one in "Packs & settings".',
      tplInstallUrl: 'Install from URL', tplPhUrl: 'https://raw.githubusercontent.com/…/pack.json', tplInstallFile: 'Import file',
      tplInstallPaste: 'Paste JSON', tplInstall: 'Install', tplInstalled: (name, n) => `Installed "${name}" (${n} items)`,
      tplInstallFailed: e => `Couldn't install the pack: ${e}`, tplUpdate: 'Update', tplRemove: 'Remove',
      tplConfirmRemove: name => `Remove the pack "${name}"?`, tplCheckPack: 'Check every tag',
      tplPackInfo: (n, tags, v) => `${n} items · ${tags} tags${v ? ' · v' + v : ''}`,
      tplOptions: 'Options', tplUseBase: 'Add the pack\'s base tags',
      tplRuleMatch: 'Flag a tag when fewer than', tplRuleMatchB: '% of its search results really carry it',
      tplRuleCold: 'Flag as cold the bottom', tplRuleColdB: '% of the tags compared, by popularity',
      tplOptionsTitle: 'Tag templates',
      rulesTitle: 'Weak tags',
      rulesIntro: 'One set of rules for the template flags, the pack review and the cleanup. Tags mostly used by another fandom are always caught; a tag that is the only one carrying a search word is never called cold. The template panel on tumblr.com uses the same settings.',
      navReblogs: 'Reblogs',
      // extension: manager page
      navPacks: 'Packs', packsNone: 'No pack installed yet.',
      packsIntro: 'A template pack describes one fandom: its characters, relations and their tags. Packs decide whose tag is whose when tags are sorted, and keep old posts in line below.',
      upkTitle: 'Bring old posts in line with the packs',
      upkIntro: 'Looks at your synced posts that carry a pack\'s base tags. Old spellings the pack has retired are replaced in place by the current spelling, or removed if the post already has it. A character or relation already on a post also gets the spellings people search for that the post lacks ("yuuto arc v" next to "yuto arc v"). Tags the pack doesn\'t know never change. Sync the tag library first.',
      upkScan: 'Scan my posts', upkNeedPack: 'Install a pack first', upkNone: 'All your posts are already in line with the packs',
      upkHint: 'Scan to see what would change', upkFound: (rules, posts) => `${rules} kind(s) of change on ${posts} post(s)`,
      upkRemoveHas: 'removed (the post already has the current spelling)', upkRemoveDropped: 'removed (the pack no longer uses this tag)', upkAdd: 'added (a spelling people search for that the post lacks)', upkPosts: n => `${n} post(s)`,
      upkSelInfo: (r, p) => `${r} ticked · ${p} post(s) to edit`, upkApply: 'Apply ticked changes', upkPick: 'Tick at least one change',
      actUpkeep: n => `Bring tags in line with the packs (${n} kind(s) of change)`, upkNothing: 'nothing to change',
      appTitle: 'Tumblr Tag Helper', navPosts: 'Posts', navClean: 'Cleanup', navLib: 'Tag library', navSettings: 'Settings',
      notLoggedIn: 'Log in to Tumblr in this browser, then reload this page.', openTumblr: 'Open Tumblr',
      boxPublished: 'Published', boxDraft: 'Drafts', boxQueue: 'Queue',
      phTagFilter: 'Filter by tag (optional)', load: 'Load', more: 'Load 100 more', all: 'Load all', stop: 'Stop',
      phSearch: 'Search text or tags in loaded posts', allStates: 'All states',
      hasLabel: 'With community label', noLabel: 'Without community label', reblogsOff: 'Reblogs turned off',
      reblogCtl: 'Reblogs', reblogAllow: 'Allow reblogs', reblogDeny: 'Don\'t allow reblogs', reblogOffBadge: '⛔🔁',
      reblogCtlHint: 'Tumblr\'s reblog control: who can reblog the post. Turned off, other accounts can\'t reblog it. My own blogs still reblog it to each other, and my reblogs get the same setting.',
      selAll: 'Select all', selInvert: 'Invert', selNone: 'Clear',
      selHint: 'Click or drag to select · Shift+click for a range · Ctrl+A for all',
      cardSize: 'Card size', visibility: 'Visibility', communityLabel: 'Community label', labelOn: 'Add', remove: 'Remove',
      tags: 'Tags', phBatchTags: 'Type a tag, then Enter or comma',
      tagsAdd: 'Add to selected posts',
      selTagsHint: 'On the selected posts. Click a tag to mark it for removal; ⊕ adds it to the ones that lack it.', selTagsNone: 'Select posts to see their tags',
      removeMarked: n => `Remove ${n} marked tag(s)`, addToAll: 'Add to all selected posts',
      needMark: 'Click tags above to mark them for removal first', removeChip: 'Remove',
      postFallback: 'post', primary: ' (main)', noTags: 'No tags', openPost: 'Open post',
      noMatchPosts: 'No posts match the filters', pickBlogHint: 'Choose a blog and click "Load"',
      selInfo: (n, h) => `${n} selected` + (h ? ` (${h} outside the current filter)` : ''),
      loadInfo: (n, done) => `${n} loaded${done ? ' (all)' : ''}`, loading: n => `Loading…${n ? ' ' + n : ''}`,
      needBlog: 'Choose a blog first', allLoaded: 'Everything is already loaded', loadFailed: e => `Loading failed: ${e}`,
      needCat: 'Tick at least one community label category', listSep: ', ',
      actLabelOn: cats => `Add community label: ${cats}`,
      needAddTags: 'Enter the tags to add first',
      syncInc: 'Sync new posts', syncFull: 'Full resync', phLibSearch: 'Search tags', showHidden: 'Show hidden',
      phCustom: 'Add a tag to the library manually', addCustom: 'Add',
      autoSync: 'Auto-sync every 6 hours', hideAds: 'Hide ads on Tumblr', hideRecs: 'Hide Tumblr\'s recommendations (Radar, recommended blogs, "check out these" carousels)', delay: 'Delay between edits (ms)',
      syncReblogs: 'Reblogs between my blogs follow their original (tags, visibility, community label), and posts I publish on a side blog are reblogged to my main blog',
      copyBadge: '🔁 Synced', copyTitle: src => `A reblog of ${src}: it follows the original automatically and can't be edited here`,
      logSynced: (id, n) => `${id}: the same change went to ${n} post(s) on my other blogs`,
      rbTitle: 'Reblogs between my blogs', rbScan: 'Check reblogs',
      rbIntro: 'Reblogs of my own posts follow the original. This finds reblogs whose tags, visibility or community label differ from their original, and published posts on my side blogs that my main blog hasn\'t reblogged yet (for example ones posted on tumblr.com or queued). Sync the tag library first.',
      rbFound: (d, m) => `${d} reblog(s) differ from their original · ${m} post(s) not on the main blog yet`,
      rbNone: 'Everything is in line', rbHint: 'Check to see what is out of line',
      rbDiff_tags: 'tags', rbDiff_state: 'visibility', rbDiff_label: 'community label', rbDiff_reblog: 'reblog control', rbMissing: name => `${name} hasn't reblogged it yet`,
      rbFix: 'Make reblogs match their original', rbReblog: 'Reblog these to my main blog', rbQueue: 'into the main blog\'s queue', rbNow: 'publish now',
      rbConfirmReblog: (n, name, when) => `Reblog ${n} post(s) to ${name} (${when})?`,
      autoTitle: 'Done in the background (every 10 minutes, posts published after this was turned on)',
      autoNone: 'Nothing yet', autoError: e => `Couldn't check: ${e}`,
      autoReblogged: (post, to) => `reblogged ${post} to ${to}`, autoFixed: (post, src) => `${post} brought in line with ${src}`,
      navCollect: 'Collection',
      colIntro: 'Pick one of your blogs as a collection: posts you like are reblogged onto it with your tags, and it hands you a few random images from it each day for a quick study. Your own posts and posts that don\'t allow reblogs are left out. The collection blog is left out of the tag library and of the reblogs between your blogs.',
      colBlog: 'Collection blog', colBlogNone: '— off —', colTags: 'Tags on its reblogs', colTagsPh: 'Tags, separated by commas',
      colAuto: 'Reblog posts I like onto it automatically (every 10 minutes, likes after this was turned on)',
      colImagesOnly: 'Only posts with images', colQueue: 'into its queue',
      colScan: 'Check my likes', colScanning: (n, total) => `Reading likes… ${n}${total ? ' / ' + total : ''}`,
      colReading: n => `Reading the collection… ${n}`,
      colFound: (n, have, skip) => `${n} liked post(s) not in the collection yet · ${have} already in it · ${skip} left out`,
      colHint: 'Check your likes to see which aren\'t in the collection yet', colNone: 'Every liked post is in the collection',
      colReblog: name => `Reblog the ticked posts to ${name}`, colConfirm: (n, name, when) => `Reblog ${n} liked post(s) to ${name} (${when})?`,
      colSkip_mine: 'my own post', colSkip_closed: 'reblogs turned off', colSkip_noImages: 'no images',
      colNeedBlog: 'Choose a collection blog first', colRateLimit: 'Tumblr\'s daily post limit was reached; the rest can go tomorrow',
      colLogTitle: 'Done in the background', colAutoDone: (n, name) => `reblogged ${n} liked post(s) to ${name}`,
      colAutoSkipped: list => `left out: ${list}`,
      colAutoPalette: 'Work out the palette when reblogging and add its tags',
      orgTitle: 'Sort the collection',
      orgIntro: 'Tag the collection by what each image helps you study. Select posts (click, drag, Shift+click), then click a tag to add it to all of them, or click it again to take it off. Palette tags can be worked out from the image.',
      orgShow: 'Show', orgAll: 'All posts', orgUnsorted: g => `Not sorted by ${g} yet`, orgWith: tag => `Tagged ${tag}`,
      orgPalette: 'Detect palette', orgPaletteHint: 'For the selected posts, or every post without palette tags when none is selected',
      orgOther: 'Other tags', orgOtherPh: 'Your own tags, separated by commas', orgAdd: 'Add',
      orgNeedRead: 'Read the collection first', orgNone: 'No posts here', orgCount: (n, sel) => `${n} post(s) · ${sel} selected`,
      orgAdded: (tag, n) => `#${tag} added to ${n} post(s)`, orgRemoved: (tag, n) => `#${tag} taken off ${n} post(s)`,
      orgDetected: (n, m) => `palette tags added to ${n} post(s)${m ? ` · ${m} unchanged` : ''}`, orgDetecting: (i, n) => `Detecting palette… ${i} / ${n}`,
      dailyFrom: 'Draw from', dailyFromAll: 'the whole collection',
      refGroup_palette: 'Palette', refGroup_light: 'Light and shadow', refGroup_material: 'Material', refGroup_composition: 'Composition',
      refGroup_subject: 'Subject', refGroup_technique: 'Technique', refGroup_other: 'Other',
      refNames: {},
      aiTitle: 'AI image sorting',
      aiIntro: 'Optional. With an AI model that can see images (any OpenAI-compatible service), "AI sort" on the collection page suggests light, material, composition, subject and technique tags for the selected posts. Each image is sent to that service and it charges for every image. The key is kept only in this browser.',
      aiBase: 'API address', aiBasePh: 'https://api.example.com/v1', aiModel: 'Model', aiModelPh: 'a model that accepts images', aiKey: 'API key', aiKeyPh: 'Paste your key here',
      aiTest: 'Test', aiTesting: 'Sending a test image…', aiOk: tags => `It works${tags ? ' · it said: ' + tags : ''}`, aiFail: e => `Didn't work: ${e}`,
      aiNeedSetup: 'Set up AI image sorting in Settings first', aiNoAccess: 'Chrome wasn\'t allowed to reach this address',
      colSkip_aiArt: 'tagged as AI-made by its poster (like taken back)',
      orgAiArt: 'Check for AI images', orgAiArtHint: 'Reads the original\'s tags, tags others added and replies; all posts when none is selected',
      orgAiArtOnly: 'Suspected AI images', aiArtChecking: (i, n) => `Checking for AI images… ${i} / ${n}`,
      aiArtWhy_owner: 'its poster tagged it as AI', aiArtWhy_others: n => `${n} blogs tagged it as AI`, aiArtWhy_vision: 'the AI model is sure it is AI-made',
      aiArtHit: (id, why) => `${id}: suspected AI image (${why})`,
      orgDelete: 'Delete reblogs and unlike', orgDeleteConfirm: n => `Delete ${n} reblog(s) from the collection and take back their likes? Deleted reblogs can't be restored (the originals stay).`,
      orgDeleted: (n, u) => `deleted ${n} reblog(s) · ${u} like(s) taken back`, orgDeleting: (i, n) => `Deleting… ${i} / ${n}`,
      colUnliked: n => `${n} like(s) of AI-tagged posts taken back`,
      hideAiArt: 'Hide posts tagged as AI-made while browsing Tumblr (tags like "ai art", "midjourney"; "not ai" tags are left alone)',
      orgAiGroup: 'AI sorting', orgAiNo: 'Not looked at by the AI yet', orgAiYes: 'Looked at by the AI',
      orgAi: 'AI sort', orgAiHint: 'Selected posts only; each image goes to your AI service. The palette is worked out too, here and for free',
      aiRunning: (i, n) => `AI is looking… ${i} / ${n}`, aiBusy: 'Looking…', aiCardDone: n => (n ? `${n} suggestion(s)` : 'nothing to add'), aiFinished: n => `AI is done: ${n} post(s) with suggestions below`, aiWriting: n => `AI is done: writing its tags to ${n} post(s)`,
      aiAuto: 'Write the AI\'s tags right away, without review', aiReviewTitle: 'AI suggestions: click a tag to leave it out, then write them',
      aiApply: 'Write the suggested tags', aiDiscard: 'Discard', aiNothing: 'The AI had nothing to add', aiDone: (n, f) => `AI looked at ${n} post(s)${f ? ` · ${f} failed` : ''}`,
      aiMarkHint: 'Writing also tags every post the AI looked at with #ai sorted; Discard writes nothing',
      dailyTitle: 'Today\'s quick study', dailyCount: 'Images', dailyAnother: 'Another set', dailyRefresh: 'Read the collection again',
      dailyEmpty: 'The collection has no images yet', dailyInfo: (n, date) => `${n} post(s) with images in the collection${date ? ' · read ' + date : ''}`,
      blogStat: (name, n, date) => `${name}: ${n} posts${date ? ', ' + date : ''}`, statSep: '; ',
      neverSynced: 'Not synced yet. Click "Sync new posts" to read the tags of published posts on your main blog and all side blogs.',
      manual: ' · manual', nBlogs: n => ` · ${n} blogs`,
      filterBtn: 'Filter', filterTitle: 'Load the posts with this tag',
      hide: 'Hide', restore: 'Restore', showMore: n => `Show more (${n} total)`, noTagsLib: 'No tags',
      blogListFailed: e => `Couldn't load your blog list: ${e}`,
      cleanIntro: 'Find weak tags on your posts. Tags your template packs know are not listed: the Packs page looks after them.',
      cleanRules: (cold, match) => `Rules (in Settings, shared with the templates): mostly another fandom's${cold ? `, the bottom ${cold}% of all my tags by popularity` : ''}${match ? `, search shows other tags (under ${match}% really carry it)` : ''}, no recent posts or followers.`,
      ruleNotes: 'On my posts, average notes below',
      followersN: n => `${n} followers`, tagNotes: n => `recent posts get ~${n} notes`, trending: 'trending',
      scan: 'Scan', scanning: (i, n) => `Checking sitewide activity: ${i} / ${n}`,
      scanDone: (n, failed) => `${n} low-traffic tags found` + (failed ? ` (${failed} could not be checked)` : ''),
      noNotesData: 'Some posts have no note count yet. Run "Full resync" in the tag library to include them and refresh old counts.',
      siteRate: r => `≈${r} posts/day sitewide`,
      avgNotes: a => `avg ${a} notes`, usedTimes: n => `used ${n}×`,
      cleanRemove: 'Remove ticked tags from my posts', cleanPick: 'Tick the tags to remove first',
      cleanNoPosts: 'None of your synced posts use these tags', cleanNeedSync: 'Sync the tag library first',
      cleanEmpty: 'No low-traffic tags found', cleanHint: 'Click "Scan" to find low-traffic tags',
      cleanSelInfo: (n, total, posts) => `${n} of ${total} ticked · affects ${posts} posts`,
      actClean: n => `Remove ${n} low-traffic tag(s)`,
    },
    zh: {
      langTitle: '语言', langAuto: '自动（跟随浏览器）',
      st_published: '公开', st_private: '私密', st_draft: '草稿', st_queue: '队列', st_queued: '队列',
      cat_sexual_themes: '成人/性内容', cat_violence: '暴力', cat_drug_use: '药物/酒精',
      ddRelated: '相关标签', ddFrequent: '常用标签', ddMine: '我的标签', ddBlog: '此博客的标签', ddCo: '相关',
      setPublic: '设为公开', setPrivate: '设为私密', labelOff: '移除内容标签',
      needSelect: '请先选择帖子',
      confirmRun: (title, n) => `${title}\n\n将修改 ${n} 篇帖子，确定继续？`,
      progress: (title, i, n) => `${title}：${i} / ${n}`,
      logSkip: (id, r) => `跳过 ${id}：${r}`, logFail: (id, r) => `失败 ${id}：${r}`,
      logDone: (title, stopped, ok, skip, fail) => `${title}${stopped ? '（已停止）' : ''}：成功 ${ok}，跳过 ${skip}，失败 ${fail}`,
      skipState: st => `状态为“${st}”，已跳过`,
      skipLegacy: '旧版格式帖子，用 NPF 编辑可能破坏排版，已跳过',
      labelNotApplied: '内容标签没有生效（接口可能不接受该字段）',
      actTagsAdd: tags => `添加标签：${tags}`, actTagsRemove: tags => `删除标签：${tags}`,
      syncing: (b, n, total) => `正在同步 ${b}：${n}${total ? ' / ' + total : ''}`,
      syncStopped: '同步已停止', syncDone: n => `同步完成，共 ${n} 个标签`, syncFailed: e => `同步失败：${e}`,
      meFilter: '筛选标签', meAll: '全选', meNone: '全不选', meReading: '正在读取所选帖子的标签…',
      meCount: (n, total) => `所选 ${total} 篇中有 ${n} 篇带此标签`, meFill: '补到所选帖子中缺少它的帖子上',
      meLimit: '官方编辑器最多只能选 100 篇', meUpkeep: '按模板包整理标签',
      meCopyLocked: '这是转自你自己博客的帖子，会自动跟原帖保持一致，所以这里不能选',
      tplEditing: n => `按模板修改 ${n} 条帖子`, tplSome: '部分帖子有（不点就保持原样）',
      tplCard: '按模板修改', tplAddPh: '添加角色或关系……', tplNothingOn: '选中的帖子上还没有这个模板包里的角色',
      tplPart: (n, total) => `${total} 条里有 ${n} 条有。点一下加到全部，再点一下从全部去掉`,
      tplEditPlan: '改动', tplNoChange: '还没有改动：勾上或取消角色', tplWillChange: (n, total) => `${total} 条里会改 ${n} 条`,
      tplApplyTo: n => `应用到 ${n} 条帖子`, actRetag: '按模板修改标签',
      imagesN: n => `共 ${n} 张图`,
      sortHeat: '按热度排序标签', heatChecking: (i, n) => `正在查询标签热度：${i} / ${n}`,
      tplOpen: '标签模板', tplSearch: '搜索名字或标签', tplFavs: '收藏', tplPicked: '已选', tplNone: '还没有选择',
      tplIncludedBy: name => `由「${name}」带入`, tplToggleHint: '点击标签可以打开或关闭',
      tplCount: n => `共 ${n} 个标签`, tplCombos: '这几个人一起出现', tplNotCombo: '都不是',
      why_dead: '最近没有帖子用这个标签，也没人关注', why_fuzzy: m => `搜这个标签出来的大多是别的标签（只有 ${m}% 真正带它）`,
      why_cold: (i, n) => `在这些标签里热度靠后（第 ${i} / ${n}）`, why_off: '已手动关闭',
      why_extra: '次要写法：选的角色多时，每人只保留最好的几种写法',
      why_offtopic: p => `大多是别的圈子在用：近期帖子只有 ${p}% 带这个模板包的基础标签`,
      tplReview: '整理建议', tplReviewing: (i, n) => `正在读取标签样本：${i} / ${n}`,
      tplReviewTitle: name => `「${name}」的整理建议`, tplReviewNone: '没有需要整理的',
      tplRmTitle: '建议删除', tplAddTitle: '建议补充（经常一起出现）', tplApply: n => `应用 ${n} 处修改`,
      tplApplied: n => `已把 ${n} 处修改写入模板包`, tplShare: p => `${p}% 的帖子带它`,
      tplExport: '复制模板包 JSON', tplEdited: '有本地修改',
      tplUpdateEdited: '这个模板包有在这里做的修改，从网址更新会覆盖它们。继续吗？',
      tplFitUnknown: '未能判断圈子', tplMarkerOnly: '不加标签，只标明关系',
      tplPresets: '一键组合', tplRelations: '关系', tplOther: '其他',
      tplOver20: '博客内搜索只读前 20 个', tplOver30: '全站搜索只读前 30 个',
      tplDropFlagged: n => `关闭标记的 ${n} 个`,
      tplManyA: '选了', tplManyB: '个及以上角色时，每人保留最好的', tplManyC: '种写法',
      tplInsert: '插入', tplCopy: '复制', tplClear: '清空', tplSaveFav: '收藏组合', tplFavName: '给这个组合起个名字',
      tplRemoveFav: name => `删除收藏「${name}」？`,
      tplCheck: '检查热度', tplChecking: (i, n) => `正在检查标签热度：${i} / ${n}`,
      tplCheckDone: (n, cold, failed) => `检查了 ${n} 个标签，${cold} 个看起来冷门` + (failed ? `（${failed} 个检查失败）` : ''),
      tplAllFresh: '这些标签最近已经检查过', tplCopied: '已复制', tplInserted: n => `已插入 ${n} 个标签`,
      tplUpdateTags: '更新标签', tplUndo: '撤销插入', tplUpdated: (removed, added) => `删掉 ${removed} 个，新加 ${added} 个`,
      tplUndone: n => `已删掉插入的 ${n} 个标签`, tplNotRemoved: n => `有 ${n} 个标签没删掉，请手动删除`,
      tplNoInput: '请先打开发帖编辑器；标签已复制到剪贴板', tplPickFirst: '请先选择',
      tplManage: '模板包与设置', tplBack: '返回', tplNoPack: '还没有安装模板包。到「模板包与设置」里安装。',
      tplInstallUrl: '从网址安装', tplInstallFile: '导入文件', tplInstallPaste: '粘贴 JSON', tplInstall: '安装',
      tplInstalled: (name, n) => `已安装「${name}」（${n} 项）`, tplInstallFailed: e => `安装失败：${e}`,
      tplUpdate: '更新', tplRemove: '删除', tplConfirmRemove: name => `删除模板包「${name}」？`, tplCheckPack: '检查全部标签',
      tplPackInfo: (n, tags, v) => `${n} 项 · ${tags} 个标签${v ? ' · v' + v : ''}`,
      tplOptions: '选项', tplUseBase: '加上模板包的基础标签', tplRuleMatch: '搜索结果里真正带这个标签的少于', tplRuleMatchB: '% 时标出来',
      tplRuleCold: '热度排在参与比较的标签后', tplRuleColdB: '% 的标为冷门',
      tplOptionsTitle: '标签模板',
      rulesTitle: '弱标签',
      rulesIntro: '模板标记、模板包检查和清理共用这一套规则。大多是别的圈子在用的标签总会被找出来；唯一带某个搜索词的标签不会被算作冷门。tumblr.com 上的模板面板也用这套设置。',
      navReblogs: '转发',
      navPacks: '模板包', packsNone: '还没有安装模板包。',
      packsIntro: '模板包记录一个圈子的角色、关系和各自的标签。排序标签时用它判断标签属于谁，下面的维护功能用它整理旧帖子。',
      upkTitle: '按模板包维护旧帖子',
      upkIntro: '只看已同步、并且带着该模板包基础标签的帖子。模板包已停用的旧拼法会在原位置换成现在的拼法，帖子已有现在的拼法时直接删掉。帖子上已有的角色或关系，还会补上它缺少的、有人会搜的拼法（比如有 yuto arc v 就补 yuuto arc v）。模板包里没有的标签一律不动。请先同步标签库。',
      upkScan: '扫描我的帖子', upkNeedPack: '请先安装模板包', upkNone: '所有帖子都已符合模板包',
      upkHint: '点“扫描我的帖子”查看要改什么', upkFound: (rules, posts) => `${posts} 条帖子，${rules} 种改动`,
      upkRemoveHas: '删掉（帖子已有现在的拼法）', upkRemoveDropped: '删掉（模板包已不用这个标签）', upkAdd: '补上（帖子缺少的、有人会搜的拼法）', upkPosts: n => `${n} 条帖子`,
      upkSelInfo: (r, p) => `已勾 ${r} 种 · 要改 ${p} 条帖子`, upkApply: '应用勾选的改动', upkPick: '请至少勾选一种改动',
      actUpkeep: n => `按模板包维护标签（${n} 种改动）`, upkNothing: '没有需要改的',
      appTitle: 'Tumblr Tag 助手', navPosts: '帖子', navClean: '清理', navLib: '标签库', navSettings: '设置',
      notLoggedIn: '请先在这个浏览器里登录 Tumblr，然后刷新本页。', openTumblr: '打开 Tumblr',
      boxPublished: '已发布', boxDraft: '草稿', boxQueue: '队列',
      phTagFilter: '按标签筛选（可留空）', load: '加载', more: '再加载 100 篇', all: '加载全部', stop: '停止',
      phSearch: '在已加载的帖子里搜索文字/标签', allStates: '全部状态',
      hasLabel: '有内容标签', noLabel: '无内容标签', reblogsOff: '已禁止转发',
      reblogCtl: '转发', reblogAllow: '允许转发', reblogDeny: '禁止转发', reblogOffBadge: '⛔🔁',
      reblogCtlHint: '官方的转发控制（谁可以转发这条帖子）。关闭后其他账号不能转发；我自己的主博客和子博客之间照常互转，我的转发也会设成一样。',
      selAll: '全选', selInvert: '反选', selNone: '清空',
      selHint: '点击 / 拖动多选 · Shift 点选范围 · Ctrl+A 全选',
      cardSize: '卡片大小', visibility: '可见性', communityLabel: '内容标签', labelOn: '添加', remove: '移除',
      tags: '标签', phBatchTags: '输入标签，回车或逗号确认',
      tagsAdd: '添加到所选帖子',
      selTagsHint: '所选帖子上的标签。点击标记要删除的；⊕ 补到缺少它的帖子上。', selTagsNone: '选中帖子后会在这里显示它们的标签',
      removeMarked: n => `删除标记的 ${n} 个标签`, addToAll: '补到所有选中的帖子上',
      needMark: '请先点击上面的标签，标记要删除的', removeChip: '删除',
      postFallback: '帖子', primary: '（主博客）', noTags: '无标签', openPost: '打开帖子',
      noMatchPosts: '没有符合筛选条件的帖子', pickBlogHint: '选择博客后点击“加载”',
      selInfo: (n, h) => `已选 ${n} 篇` + (h ? `（其中 ${h} 篇不在当前筛选结果中）` : ''),
      loadInfo: (n, done) => `已加载 ${n} 篇${done ? '（已全部加载）' : ''}`, loading: n => `加载中…${n ? ' ' + n : ''}`,
      needBlog: '请先选择博客', allLoaded: '已经全部加载', loadFailed: e => `加载失败：${e}`,
      needCat: '请至少勾选一个内容标签类别', listSep: '、',
      actLabelOn: cats => `添加内容标签：${cats}`,
      needAddTags: '请先输入要添加的标签',
      syncInc: '同步新帖子', syncFull: '完整重新同步', phLibSearch: '搜索标签', showHidden: '显示已隐藏',
      phCustom: '手动把标签加入标签库', addCustom: '加入',
      autoSync: '每 6 小时自动同步', hideAds: '隐藏 Tumblr 上的广告', hideRecs: '隐藏 Tumblr 的推荐（雷达、推荐博客、“查看这些……”推荐条）', delay: '批量操作间隔（毫秒）',
      syncReblogs: '主博客和子博客之间的转发自动跟原帖保持一致（tag、可见性、内容标签），子博客发布的新帖自动转发到主博客',
      copyBadge: '🔁 自动同步', copyTitle: src => `转自 ${src}：自动跟原帖保持一致，这里不能改`,
      logSynced: (id, n) => `${id}：同样的改动已同步到其他博客上的 ${n} 条`,
      rbTitle: '博客间的转发', rbScan: '检查转发',
      rbIntro: '转自自己博客的帖子会自动跟原帖保持一致。这里检查两件事：tag、可见性或内容标签和原帖不一致的转发；子博客上已发布、但主博客还没转发的帖子（比如在 Tumblr 网页上直接发的，或排队后才发出的）。请先同步标签库。',
      rbFound: (d, m) => `${d} 条转发和原帖不一致 · ${m} 条帖子还没转到主博客`,
      rbNone: '全部一致', rbHint: '点“检查转发”查看哪里不一致',
      rbDiff_tags: 'tag', rbDiff_state: '可见性', rbDiff_label: '内容标签', rbDiff_reblog: '转发控制', rbMissing: name => `${name} 还没转发`,
      rbFix: '按原帖修正转发', rbReblog: '转发到主博客', rbQueue: '加入主博客的队列', rbNow: '立即发布',
      rbConfirmReblog: (n, name, when) => `把 ${n} 条帖子转发到 ${name}（${when}）？`,
      autoTitle: '后台自动处理记录（每 10 分钟一次，只管开启之后发布的帖子）',
      autoNone: '还没有记录', autoError: e => `检查失败：${e}`,
      autoReblogged: (post, to) => `已把 ${post} 转发到 ${to}`, autoFixed: (post, src) => `已按 ${src} 修正 ${post}`,
      navCollect: '素材',
      colIntro: '选一个自己的博客当素材库：喜欢的帖子会带上你设的 tag 转发过去，每天还会从里面随机抽几张图给你做速涂。自己的帖子和禁止转发的帖子不会转。素材博客不计入标签库，也不参与主博客和子博客之间的互转。',
      colBlog: '素材博客', colBlogNone: '— 不使用 —', colTags: '转发时加的 tag', colTagsPh: 'tag，用逗号分隔',
      colAuto: '自动把我喜欢的帖子转发过去（每 10 分钟一次，只管开启之后点的喜欢）',
      colImagesOnly: '只转有图片的帖子', colQueue: '加入它的队列',
      colScan: '检查我的喜欢', colScanning: (n, total) => `正在读取喜欢… ${n}${total ? ' / ' + total : ''}`,
      colReading: n => `正在读取素材博客… ${n}`,
      colFound: (n, have, skip) => `${n} 条喜欢还没转进素材库 · ${have} 条已经有了 · ${skip} 条不转`,
      colHint: '点“检查我的喜欢”看哪些还没转进素材库', colNone: '喜欢的帖子都已经在素材库里了',
      colReblog: name => `把勾选的帖子转发到 ${name}`, colConfirm: (n, name, when) => `把 ${n} 条喜欢的帖子转发到 ${name}（${when}）？`,
      colSkip_mine: '自己的帖子', colSkip_closed: '禁止转发', colSkip_noImages: '没有图片',
      colNeedBlog: '请先选择素材博客', colRateLimit: '已达到 Tumblr 每天的发帖上限，剩下的明天再转',
      colLogTitle: '后台自动处理记录', colAutoDone: (n, name) => `已把 ${n} 条喜欢的帖子转发到 ${name}`,
      colAutoSkipped: list => `未转：${list}`,
      colAutoPalette: '转发时自动识别色调并加上对应 tag',
      orgTitle: '整理素材',
      orgIntro: '按每张图能拿来练什么给素材分类。先选中帖子（点击、拖动、Shift 点选），再点下面的分类：给选中的帖子都加上这个 tag，再点一次就去掉。色调可以从图片自动识别。tag 本身是英文，这里只是显示成中文。',
      orgShow: '显示', orgAll: '全部帖子', orgUnsorted: g => `还没按“${g}”分类的`, orgWith: tag => `带“${tag}”的`,
      orgPalette: '自动识别色调', orgPaletteHint: '识别选中的帖子；什么都没选时，识别所有还没有色调 tag 的帖子',
      orgOther: '其他 tag', orgOtherPh: '自己的 tag，用逗号分隔', orgAdd: '加上',
      orgNeedRead: '请先读取素材博客', orgNone: '这里没有帖子', orgCount: (n, sel) => `${n} 条帖子 · 已选 ${sel} 条`,
      orgAdded: (tag, n) => `已给 ${n} 条帖子加上 #${tag}`, orgRemoved: (tag, n) => `已从 ${n} 条帖子去掉 #${tag}`,
      orgDetected: (n, m) => `已给 ${n} 条帖子加上色调 tag${m ? ` · ${m} 条不用改` : ''}`, orgDetecting: (i, n) => `正在识别色调… ${i} / ${n}`,
      dailyFrom: '从这里抽', dailyFromAll: '整个素材库',
      refGroup_palette: '色调', refGroup_light: '光影', refGroup_material: '材质', refGroup_composition: '构图',
      refGroup_subject: '题材', refGroup_technique: '画法', refGroup_other: '其他',
      refNames: {
        'warm palette': '暖色调', 'cool palette': '冷色调', 'warm cool contrast': '冷暖对比', 'high saturation': '高饱和', 'muted colors': '低饱和（灰调）',
        'pastel colors': '粉彩色', 'high key': '亮调', 'low key': '暗调', 'high contrast': '明暗对比强', 'low contrast': '明暗对比弱',
        'monochrome': '单色系', 'grayscale': '黑白灰', 'complementary colors': '互补色', 'analogous colors': '邻近色',
        'backlight': '逆光', 'rim light': '轮廓光', 'side light': '侧光', 'top light': '顶光', 'under light': '底光', 'hard light': '硬光',
        'soft light': '柔光', 'golden hour': '黄昏/晨光', 'night scene': '夜景', 'neon light': '霓虹光', 'colored lights': '多色光源',
        'volumetric light': '体积光（光束）', 'dappled light': '斑驳光影', 'cast shadow': '投影', 'reflected light': '反光（环境光）',
        'subsurface scattering': '透光（次表面散射）', 'silhouette': '剪影', 'atmospheric perspective': '空气透视', 'fog': '雾气',
        'skin': '皮肤', 'hair': '头发', 'eyes': '眼睛', 'fabric folds': '布料褶皱', 'sheer fabric': '薄纱', 'leather': '皮革', 'fur': '皮毛',
        'metal': '金属', 'glass': '玻璃', 'transparent': '透明', 'gemstone': '宝石', 'water': '水', 'ice': '冰', 'fire': '火焰', 'smoke': '烟雾',
        'foliage': '植物', 'flowers': '花', 'wood': '木头', 'rock': '岩石', 'sky and clouds': '天空和云',
        'close up': '特写', 'bust shot': '半身', 'full body': '全身', 'wide shot': '远景', 'low angle': '仰视', 'high angle': '俯视',
        'foreshortening': '透视缩短', 'dynamic pose': '动态姿势', 'centered composition': '中心构图', 'rule of thirds': '三分法',
        'diagonal composition': '对角线构图', 'symmetry': '对称', 'negative space': '留白', 'framing': '框景', 'leading lines': '引导线',
        'depth layers': '前中后景',
        'character': '人物', 'multiple characters': '多人', 'animal': '动物', 'landscape': '风景', 'cityscape': '街景', 'architecture': '建筑',
        'interior': '室内', 'still life': '静物', 'food': '食物', 'mecha': '机械',
        'painterly': '厚涂', 'cel shading': '赛璐璐', 'soft shading': '柔和渐变', 'flat colors': '平涂', 'lineless': '无线稿', 'line art': '线稿',
        'ai sorted': 'AI 已识别', 'suspected ai': '疑似 AI 图', 'watercolor': '水彩', 'sketch': '速写/草稿', 'pixel art': '像素画', '3d render': '3D 渲染', 'photo': '照片',
      },
      aiTitle: 'AI 识图',
      aiIntro: '可选。填一个能看图的 AI 模型（任何 OpenAI 兼容的服务）后，素材页的“AI 识别”会给选中的帖子建议光影、材质、构图、题材和画法 tag。每张图都会发给这个服务，并按张计费。key 只保存在这个浏览器里。',
      aiBase: '接口地址', aiBasePh: 'https://api.example.com/v1', aiModel: '模型', aiModelPh: '能看图的模型名', aiKey: 'API key', aiKeyPh: '在这里粘贴你的 key',
      aiTest: '测试', aiTesting: '正在发送测试图片…', aiOk: tags => `可以用${tags ? ' · 它的回答：' + tags : ''}`, aiFail: e => `不能用：${e}`,
      aiNeedSetup: '请先在设置里配置 AI 识图', aiNoAccess: 'Chrome 没有允许访问这个地址',
      colSkip_aiArt: '原作者标了 AI 图（已取消喜欢）',
      orgAiArt: '检查 AI 图', orgAiArtHint: '读原帖的 tag、别人转发时加的 tag 和评论；什么都没选时检查全部',
      orgAiArtOnly: '疑似 AI 图', aiArtChecking: (i, n) => `正在检查 AI 图… ${i} / ${n}`,
      aiArtWhy_owner: '原作者标了 AI', aiArtWhy_others: n => `${n} 个博客标了 AI`, aiArtWhy_vision: 'AI 看图很确定是 AI 图',
      aiArtHit: (id, why) => `${id}：疑似 AI 图（${why}）`,
      orgDelete: '删除转发并取消喜欢', orgDeleteConfirm: n => `从素材库删除 ${n} 条转发，并取消对应的喜欢？删掉的转发无法恢复（原帖还在）。`,
      orgDeleted: (n, u) => `已删除 ${n} 条转发 · 取消了 ${u} 个喜欢`, orgDeleting: (i, n) => `正在删除… ${i} / ${n}`,
      colUnliked: n => `已取消 ${n} 条标了 AI 的帖子的喜欢`,
      hideAiArt: '浏览 Tumblr 时隐藏标了 AI 图的帖子（如 “ai art”“midjourney” 等 tag；“not ai” 这类不受影响）',
      orgAiGroup: 'AI 识别', orgAiNo: 'AI 还没识别过的', orgAiYes: 'AI 识别过的',
      orgAi: 'AI 识别', orgAiHint: '只识别选中的帖子；每张图都会发给你的 AI 服务。色调会顺带本地算好，不另外花钱',
      aiRunning: (i, n) => `AI 正在看图… ${i} / ${n}`, aiBusy: '识别中…', aiCardDone: n => (n ? `建议 ${n} 个` : '没有可加的'), aiFinished: n => `AI 看完了：${n} 条帖子有建议，在下面确认`, aiWriting: n => `AI 看完了，正在给 ${n} 条帖子写入 tag`,
      aiAuto: 'AI 识别后直接写入，不用确认', aiReviewTitle: 'AI 的建议：点一下 tag 可以不要它，然后写入',
      aiApply: '写入建议的 tag', aiDiscard: '放弃', aiNothing: 'AI 没有可以加的 tag', aiDone: (n, f) => `AI 看完了 ${n} 条帖子${f ? ` · ${f} 条失败` : ''}`,
      aiMarkHint: '写入时，AI 看过的每条帖子都会加上 #ai sorted；点“放弃”什么都不写',
      dailyTitle: '今日速涂', dailyCount: '张数', dailyAnother: '换一组', dailyRefresh: '重新读取素材博客',
      dailyEmpty: '素材库里还没有图片', dailyInfo: (n, date) => `素材库里有 ${n} 条带图的帖子${date ? ' · 读取于 ' + date : ''}`,
      blogStat: (name, n, date) => `${name}：${n} 篇${date ? '，' + date : ''}`, statSep: '；',
      neverSynced: '还没有同步过。点击“同步新帖子”从主博客和所有子博客读取已发布帖子的标签。',
      manual: ' · 手动', nBlogs: n => ` · ${n} 个博客`,
      filterBtn: '筛选', filterTitle: '加载带此标签的帖子',
      hide: '隐藏', restore: '恢复', showMore: n => `显示更多（共 ${n} 个）`, noTagsLib: '没有标签',
      blogListFailed: e => `读取博客列表失败：${e}`,
      cleanIntro: '找出你帖子里的弱标签。模板包认识的标签不会列在这里，由“模板包”页负责。',
      cleanRules: (cold, match) => `规则（在“设置”里，和模板共用）：大多是别的圈子在用的${cold ? `、热度排在我所有标签后 ${cold}% 的` : ''}${match ? `、搜出来大多是别的标签的（真正带它的少于 ${match}%）` : ''}、最近没帖子也没人关注的。`,
      ruleNotes: '我的帖子平均 note 低于',
      followersN: n => `${n} 人关注`, tagNotes: n => `近期帖子一般有 ${n} 个 notes`, trending: '正在流行',
      scan: '扫描', scanning: (i, n) => `正在检查全站热度：${i} / ${n}`,
      scanDone: (n, failed) => `找到 ${n} 个流量少的标签` + (failed ? `（${failed} 个检查失败）` : ''),
      noNotesData: '部分帖子还没有 note 数。到“标签库”点“完整重新同步”即可补上，并刷新旧帖子的 note 数。',
      siteRate: r => `全站约 ${r} 篇/天`,
      avgNotes: a => `平均 ${a} notes`, usedTimes: n => `用了 ${n} 次`,
      cleanRemove: '从我的帖子中删除勾选的标签', cleanPick: '请先勾选要删除的标签',
      cleanNoPosts: '已同步的帖子里没有用到这些标签', cleanNeedSync: '请先同步标签库',
      cleanEmpty: '没有找到流量少的标签', cleanHint: '点击“扫描”找出流量少的标签',
      cleanSelInfo: (n, total, posts) => `已勾选 ${n} / ${total} 个 · 涉及 ${posts} 篇帖子`,
      actClean: n => `删除 ${n} 个流量少的标签`,
    },
  };
  const LANG_NAMES = { en: 'English', zh: '中文' };

  // getLang() returns the user's choice ('' = auto). Auto tries getHints() first (e.g. the user's Tumblr
  // interface language, which can differ from the browser's), then the browser languages.
  function makeI18n(getLang, getHints = () => []) {
    const detect = () => {
      const browser = typeof navigator !== 'undefined' && navigator.languages?.length ? navigator.languages : [navigator?.language];
      for (const l of [...getHints(), ...browser]) {
        if (!l) continue;
        const s = String(l || '').toLowerCase();
        if (s.startsWith('zh')) return 'zh';
        const base = s.split('-')[0];
        if (STRINGS[base]) return base;
      }
      return 'en';
    };
    const lang = () => (STRINGS[getLang()] ? getLang() : detect());
    const t = (k, ...args) => {
      const v = STRINGS[lang()]?.[k] ?? STRINGS.en[k];
      return v === undefined ? k : typeof v === 'function' ? v(...args) : v;
    };
    const stateName = st => (STRINGS.en['st_' + st] ? t('st_' + st) : st);
    const locale = () => (lang() === 'zh' ? 'zh-CN' : lang());
    return { t, lang, detect, stateName, locale };
  }

  // ---------- Ads ----------
  // CSS that hides Tumblr's ads: Google native ad cells in timelines and the right-rail "Sponsored" box.
  // Tumblr's class names are hashed and change, so this keys on ad ids and timeline cell ids only.
  const AD_CSS = [
    '[data-cell-id*="client_side_ad"]',
    '[data-cell-id]:has(iframe[id^="google_ads_iframe"])',
    'aside > div:has(#aditude_rightrail_main)',
    // the "Sponsored" box in right rails outside <aside> too (a blog opened in the side panel):
    // box > card > wrapper > wrapper > ad slot
    '[id^="aditude_"]', 'div:has(> div > div > div > div[id^="aditude_"])',
    // Blaze (paid promotion of a post) is served by Tumblr itself through "wordpress-blaze-<n>" blogs,
    // so blocking ad networks doesn't stop it: hide the post, in timelines and in search grids
    '[data-cell-id]:has(a[href*="/wordpress-blaze-"])', 'div:has(> article a[href*="/wordpress-blaze-"])',
    'aside > div:has(iframe[id^="google_ads_iframe"])',
    '#adBanner', 'ins.adsbygoogle',
    // "Get Premium" buttons (left nav) carry the premium diamond icon
    'button:has(use[href^="#managed-icon__ds-premium-diamond"])', 'a:has(use[href^="#managed-icon__ds-premium-diamond"])',
  ].join(',\n') + ' { display: none !important; }';
  // The right rail's "go ad-free with Premium" box has no stable id, so it is found by its text.
  // Only short right-rail boxes are checked, so a recommended post that mentions ads is never hidden.
  const UPSELL_SELECTOR = 'aside > div';
  // Tumblr's own recommendations (not ads), hidden only when asked: the right rail's recommended blogs
  // (the box with the /explore link) and Radar (the box holding a post), and the "check out these
  // communities / blogs / tags" carousels in timelines
  const REC_CSS = [
    'aside > div:has(a[href="/explore"])', 'aside > div:has(article)',
    '[data-cell-id*="timelineObject:title"]', '[data-cell-id*="timelineObject:carousel"]',
  ].join(',\n') + ' { display: none !important; }';
  const isUpsell = text => text.length < 150 && /ad[- ]?free|without ads|无广告|無廣告/i.test(text);

  // ---------- API ----------
  const errMsg = e => e?.body?.errors?.[0]?.detail || e?.body?.meta?.msg || e?.message || String(e);

  // request(path, {method, body}) performs one call and resolves to the parsed JSON (or throws with .status)
  // A POST creates something (a post, a reblog): retrying it after a server error could create it twice, so
  // only reads and edits are retried
  function makeApi(request) {
    return async function api(path, opts = {}) {
      const method = opts.method || 'GET';
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await request(path, { method, body: opts.body });
          return res?.response ?? res;
        } catch (e) {
          const status = e?.status ?? e?.body?.meta?.status;
          if (method !== 'POST' && (status === 429 || status >= 500) && attempt < 4) { await sleep(2000 * 2 ** attempt); continue; }
          throw e;
        }
      }
    };
  }

  async function getBlogs(api) {
    const r = await api('/v2/user/info');
    const blogs = (r?.user?.blogs || []).map(b => ({ uuid: b.uuid || b.name, name: b.name, title: b.title, primary: !!b.primary }));
    blogs.sort((a, b) => b.primary - a.primary);
    return blogs;
  }

  const postId = p => String(pick(p, 'idString', 'id_string', 'id'));
  // Post lists can contain non-post timeline objects (placeholders, ads); keep only real posts
  const isPost = p => !!p && (pick(p, 'objectType', 'object_type') ?? 'post') === 'post' && pick(p, 'idString', 'id_string', 'id') != null;
  // box: '' for published posts, 'draft' or 'queue'
  const basePosts = (blog, extra, box = '') => `/v2/blog/${enc(blog)}/posts${box ? '/' + box : ''}${qs({ npf: true, limit: 20, ...extra })}`;

  function nextPath(r, blog, extra, offset, pageWasFull, box = '') {
    const next = (r.links || r._links)?.next;
    if (next?.href) { const u = new URL(next.href, 'https://www.tumblr.com'); return u.pathname.replace(/^\/api(?=\/v2)/, '') + u.search; }
    const q = next?.queryParams || next?.query_params;
    if (q) return `/v2/blog/${enc(blog)}/posts${box ? '/' + box : ''}${qs(q)}`;
    return pageWasFull ? basePosts(blog, { ...extra, offset }, box) : null;
  }

  function readLabel(p) {
    const cl = pick(p, 'communityLabels', 'community_labels') || {};
    const has = pick(p, 'hasCommunityLabel', 'has_community_label') ?? pick(cl, 'hasCommunityLabel', 'has_community_label') ?? false;
    const cats = pick(p, 'communityLabelCategories', 'community_label_categories') ?? cl.categories ?? [];
    return { has: !!has, categories: [...cats] };
  }
  // Reblog control (Tumblr's "who can reblog this"): 'everyone' or 'noone'. My own blogs still reblog each
  // other's posts (reblogPost), and reblogs between my blogs carry the same setting.
  const readReblog = p => (pick(p, 'interactabilityReblog', 'interactability_reblog') === 'noone' ? 'noone' : 'everyone');

  // Fields sent back unchanged when editing: [camelCase name, API parameter name]
  const PASSTHROUGH = [
    ['date', 'date'], ['slug', 'slug'],
    ['interactabilityReblog', 'interactability_reblog'], ['interactabilityBlaze', 'interactability_blaze'],
    ['canBeTipped', 'can_be_tipped'], ['hideTrail', 'hide_trail'],
    ['parentTumblelogUuid', 'parent_tumblelog_uuid'], ['parentPostId', 'parent_post_id'], ['reblogKey', 'reblog_key'],
  ];

  const sameEdit = (a, b) => a.state === b.state && a.reblog === b.reblog
    && a.tags.join('\u0001') === b.tags.join('\u0001')
    && a.label.has === b.label.has
    && [...a.label.categories].sort().join() === [...b.label.categories].sort().join();

  // All images of an NPF post (its own content, then reblog trail), each as { small, big } URLs
  // picked from the media sizes closest to the given widths
  function postImages(p, smallW = 250, bigW = 640) {
    const near = (media, w) => media.reduce((a, b) => (Math.abs((b.width || 0) - w) < Math.abs((a.width || 0) - w) ? b : a)).url;
    return [...(p.content || []), ...(p.trail || []).flatMap(tr => tr.content || [])]
      .filter(b => b.type === 'image' && b.media?.length)
      .map(b => ({ small: near(b.media, smallW), big: near(b.media, bigW) }));
  }

  const getPost = (api, blog, id) => api(`/v2/blog/${enc(blog)}/posts/${enc(id)}${qs({ post_format: 'npf' })}`);

  // mutate(next, cur) returns the modified next; returning a string skips the post with that reason
  async function editPost(api, t, blog, id, mutate, verifyLabel) {
    const path = `/v2/blog/${enc(blog)}/posts/${enc(id)}`;
    const p = await getPost(api, blog, id);
    if (pick(p, 'shouldOpenInLegacy', 'should_open_in_legacy')) return { skipped: true, reason: t('skipLegacy') };
    const cur = { state: p.state, tags: (p.tags || []).slice(), label: readLabel(p), reblog: readReblog(p) };
    const next = mutate({ state: cur.state, tags: cur.tags.slice(), label: { has: cur.label.has, categories: cur.label.categories.slice() }, reblog: cur.reblog }, cur);
    if (typeof next === 'string') return { skipped: true, reason: next };
    if (sameEdit(cur, next)) return { skipped: true, unchanged: true };

    const body = {
      content: p.content || [],
      layout: p.layout || [],
      state: next.state,
      tags: next.tags.join(','),
      has_community_label: next.label.has,
      community_label_categories: next.label.categories,
    };
    for (const [camel, snake] of PASSTHROUGH) { const v = pick(p, camel, snake); if (v !== undefined && v !== null) body[snake] = v; }
    if (next.reblog !== cur.reblog) body.interactability_reblog = next.reblog;
    if (next.state === 'queue') { const v = pick(p, 'publishOn', 'publish_on'); if (v) body.publish_on = v; }
    await api(path, { method: 'PUT', body });

    if (verifyLabel) {
      await sleep(500);
      const chk = readLabel(await getPost(api, blog, id));
      if (chk.has !== next.label.has) throw new Error(t('labelNotApplied'));
    }
    return next;
  }

  // Common mutations; each returns a function for editPost
  const mutations = {
    // Only public <-> private; drafts and queued posts are left alone
    state: (t, stateName, target) => (n, c) => (['published', 'private'].includes(c.state)
      ? Object.assign(n, { state: target }) : t('skipState', stateName(c.state))),
    labels: categories => n => Object.assign(n, { label: { has: categories.length > 0, categories } }),
    addTags: tags => n => Object.assign(n, { tags: withTags(n.tags, tags) }),
    removeTags: tags => { const ks = new Set(tags.map(key)); return n => Object.assign(n, { tags: n.tags.filter(tag => !ks.has(key(tag))) }); },
    // Reblog control: 'everyone' (allow) or 'noone' (don't allow)
    reblog: mode => n => Object.assign(n, { reblog: mode }),
  };

  // ---------- Tag library ----------
  // cache.blogs[uuid] = { name, syncedAt, posts: { [postId]: [tags[], timestamp, state, noteCount|null, reblogSource|null, hasLabel, reblog] } }
  //   reblogSource is "blogName/postId" of the original when the post is a reblog (reblogSource())
  //   reblog is the reblog control, 'everyone' or 'noone' (readReblog())
  // cache.tagStats[tagKey] = { rate, match, at }: sitewide activity samples used by the cleanup
  const emptyCache = () => ({ blogs: {}, blogList: [], hidden: [], custom: [], tagStats: {}, lastAuto: 0 });

  function buildIndex(cache) {
    const tags = new Map(), co = new Map(), byBlog = new Map(), postTags = new Map();
    // reblogs of my own posts carry the original's tags; counting them again would double every count
    const copies = copyKeys(cache);
    for (const [uuid, b] of Object.entries(cache.blogs)) {
      const own = new Map();
      byBlog.set(b.name.toLowerCase(), own);
      for (const [id, rec] of Object.entries(b.posts || {})) {
        postTags.set(id, { blog: uuid, rec });
        // a copy still counts for its own blog's pool, since that is what the blog posts
        if (copies.has(uuid + ':' + id)) {
          for (const t of uniqTags(rec[0])) { const k = t.toLowerCase(), o = own.get(k); if (o) o.count++; else own.set(k, { tag: t, count: 1 }); }
          continue;
        }
        const ks = [];
        for (const t of uniqTags(rec[0])) {
          const k = t.toLowerCase();
          let info = tags.get(k);
          if (!info) tags.set(k, info = { tag: t, count: 0, blogs: new Set() });
          info.count++;
          info.blogs.add(b.name);
          ks.push(k);
          const o = own.get(k);
          if (o) o.count++; else own.set(k, { tag: t, count: 1 });
        }
        for (const a of ks) {
          let m = co.get(a);
          if (!m) co.set(a, m = new Map());
          for (const c of ks) if (c !== a) m.set(c, (m.get(c) || 0) + 1);
        }
      }
    }
    for (const t of cache.custom) {
      const k = key(t);
      if (!tags.has(k)) tags.set(k, { tag: norm(t), count: 0, blogs: new Set(), custom: true });
      else tags.get(k).custom = true;
    }
    return { tags, co, byBlog, postTags, hidden: new Set(cache.hidden) };
  }

  function matchScore(k, q) {
    if (k === q) return 10;
    if (k.startsWith(q)) return 8;
    if (new RegExp('[\\s_\\-/.·]' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(k)) return 6;
    if (k.includes(q)) return 4;
    let i = 0;
    for (const ch of k) if (ch === q[i]) i++;
    return i === q.length ? 1 : 0;
  }

  // pool: optional candidate list [{tag, count}]; defaults to the whole tag library
  function suggest(index, q, ctx = [], exclude = [], limit = 10, pool = null) {
    const qk = key(q);
    const ex = new Set([...exclude, ...ctx].map(key));
    const ctxKeys = ctx.map(key);
    const out = [];
    const entries = pool ? pool.map(p => [key(p.tag), p]) : index.tags;
    for (const [k, info] of entries) {
      if (ex.has(k) || (!pool && index.hidden.has(k))) continue;
      let m = 0;
      if (qk) { m = matchScore(k, qk); if (!m) continue; }
      let co = 0;
      for (const c of ctxKeys) co += index.co.get(c)?.get(k) || 0;
      out.push({ tag: info.tag, count: info.count, co, score: m * 10 + Math.log2(1 + info.count) + co * 3 });
    }
    out.sort((a, b) => b.score - a.score || b.count - a.count);
    return out.slice(0, limit);
  }

  // Read published posts of one blog into cache.blogs[blog.uuid]
  async function syncBlog(api, cache, blog, full, onProgress, ctl, save) {
    const entry = cache.blogs[blog.uuid] ||= { name: blog.name, posts: {} };
    entry.name = blog.name;
    const fresh = full ? {} : null;
    let path = basePosts(blog.uuid), n = 0, unchangedPages = 0;
    while (path && !ctl.aborted) {
      const r = await api(path);
      const page = r?.posts || [];
      if (!page.length) break;
      let changed = false;
      for (const p of page.filter(isPost)) {
        const id = postId(p);
        const rec = [uniqTags(p.tags || []), p.timestamp || 0, p.state || 'published', pick(p, 'noteCount', 'note_count') ?? null,
          reblogSource(p), readLabel(p).has, readReblog(p)];
        const old = entry.posts[id];
        // records from before the reblog source / reblog control were kept count as changed, so they get them
        if (!old || old.length < 7 || old[0].join('\u0001') !== rec[0].join('\u0001') || old[2] !== rec[2] || old[5] !== rec[5] || old[6] !== rec[6]) changed = true;
        entry.posts[id] = rec;
        if (fresh) fresh[id] = rec;
      }
      n += page.length;
      onProgress?.(n, pick(r, 'totalPosts', 'total_posts'));
      // Incremental sync: two unchanged pages in a row means the rest is already synced
      if (!full) { unchangedPages = changed ? 0 : unchangedPages + 1; if (unchangedPages >= 2) break; }
      path = nextPath(r, blog.uuid, {}, n, page.length >= 20);
      if (n % 200 === 0) await save();
      await sleep(250);
    }
    if (fresh && !ctl.aborted) entry.posts = fresh;
    entry.syncedAt = Date.now();
    await save();
  }

  // ---------- Reblogs between my own blogs ----------
  // The post a reblog comes from: "blogName/postId" of the first post in its trail (the original), or null
  function reblogSource(p) {
    const tr = (p.trail || [])[0];
    const name = tr?.blog?.name, id = tr?.post?.id ?? pick(tr?.post || {}, 'idString', 'id_string');
    return name && id ? `${name}/${id}` : null;
  }
  // Posts that are copies of each other across my blogs: an original and its reblogs on my other blogs.
  // Returns Map postKey ("uuid:id") -> { root: postKey, members: [postKey...] }, for families of 2 or more.
  function reblogFamilies(cache) {
    const uuidOf = new Map(Object.entries(cache.blogs).map(([uuid, b]) => [String(b.name).toLowerCase(), uuid]));
    const fams = new Map();
    for (const [uuid, b] of Object.entries(cache.blogs)) {
      for (const [id, rec] of Object.entries(b.posts || {})) {
        if (!rec[4]) continue;
        const [name, rid] = rec[4].split('/');
        const ru = uuidOf.get(name.toLowerCase());
        if (!ru || !cache.blogs[ru].posts?.[rid]) continue; // the original is not on one of my blogs
        const root = ru + ':' + rid;
        if (!fams.has(root)) fams.set(root, [root]);
        fams.get(root).push(uuid + ':' + id);
      }
    }
    const out = new Map();
    for (const [root, members] of fams) for (const k of members) out.set(k, { root, members });
    return out;
  }
  // A post key is "<blog uuid>:<post id>"; uuids contain a colon ("t:abc"), post ids don't
  const splitKey = k => { const i = k.lastIndexOf(':'); return { blog: k.slice(0, i), id: k.slice(i + 1) }; };
  // Reblogs whose tags, visibility, community label or reblog control differ from their original (from the
  // synced cache). Returns [{ root, copy, diffs: ['tags' | 'state' | 'label' | 'reblog'] }] with root/copy as
  // { key, blog, id }.
  function reblogDiffs(cache) {
    const rec = k => { const { blog, id } = splitKey(k); return cache.blogs[blog]?.posts?.[id]; };
    const out = [];
    const seen = new Set();
    for (const { root, members } of reblogFamilies(cache).values()) {
      if (seen.has(root)) continue;
      seen.add(root);
      const r = rec(root);
      for (const k of members.slice(1)) {
        const c = rec(k);
        const diffs = [];
        if (c[0].join('\u0001') !== r[0].join('\u0001')) diffs.push('tags');
        if (SYNC_STATES.includes(c[2]) && SYNC_STATES.includes(r[2]) && c[2] !== r[2]) diffs.push('state');
        if (c[5] !== undefined && r[5] !== undefined && c[5] !== r[5]) diffs.push('label');
        if (c[6] !== undefined && r[6] !== undefined && c[6] !== r[6]) diffs.push('reblog');
        if (diffs.length) out.push({ root: { key: root, ...splitKey(root) }, copy: { key: k, ...splitKey(k) }, diffs });
      }
    }
    return out;
  }
  // Reblog one of my posts onto another of my blogs with the same tags, community label and reblog control.
  // My own blogs may reblog a post with reblogs turned off (seen live). Should Tumblr refuse, the original is
  // opened just for this reblog and closed again right after.
  // Returns { id: new post id, post: the original as read, label }.
  async function reblogPost(api, toBlog, fromBlog, id, state, t = k => k) {
    const p = await getPost(api, fromBlog, id);
    const label = readLabel(p);
    const closed = readReblog(p) === 'noone';
    const body = {
      parent_tumblelog_uuid: fromBlog, parent_post_id: String(id), reblog_key: pick(p, 'reblogKey', 'reblog_key'),
      content: [], layout: [], state, tags: (p.tags || []).join(','),
      ...(label.has ? { has_community_label: true, community_label_categories: label.categories } : {}),
      ...(closed ? { interactability_reblog: 'noone' } : {}),
    };
    const post = () => api(`/v2/blog/${enc(toBlog)}/posts`, { method: 'POST', body });
    let r;
    try {
      r = await post();
    } catch (e) {
      if (!closed || !(e.status >= 400 && e.status < 500)) throw e;
      await editPost(api, t, fromBlog, id, mutations.reblog('everyone'));
      try { r = await post(); } finally { await editPost(api, t, fromBlog, id, mutations.reblog('noone')); }
    }
    return { id: String(pick(r, 'idString', 'id_string') ?? r?.id ?? ''), post: p, label };
  }

  // The newest posts of a blog (pages of 20)
  async function newestPosts(api, blog, pages = 1) {
    const out = [];
    let path = basePosts(blog);
    for (let i = 0; i < pages && path; i++) {
      const r = await api(path);
      const page = (r?.posts || []).filter(isPost);
      out.push(...page);
      path = page.length ? nextPath(r, blog, {}, out.length, page.length >= 20) : null;
    }
    return out;
  }

  // One unattended pass over the newest posts of each of my blogs (the extension runs it every 10 minutes):
  // - a published original on a side blog, newer than `since` (seconds), that my main blog hasn't reblogged is
  //   reblogged to the main blog, published;
  // - a reblog of my own post whose tags, visibility, community label or reblog control drifted from its
  //   original is fixed.
  // opts.skip: uuids of blogs that take no part (the collection blog)
  // Returns what it did: [{ type: 'reblog' | 'fix', blog, id, to }]
  async function autoMaintain(api, t, since, opts = {}) {
    const { pages = 1, skip = [] } = opts;
    const blogs = (await getBlogs(api)).filter(b => !skip.includes(b.uuid));
    const main = blogs.find(b => b.primary);
    if (!main || blogs.length < 2) return [];
    const names = new Set(blogs.map(b => b.name.toLowerCase()));
    const lists = new Map();
    for (const b of blogs) lists.set(b.uuid, await newestPosts(api, b.uuid, pages));
    const onMain = new Set(lists.get(main.uuid).map(reblogSource).filter(Boolean).map(s => s.toLowerCase()));
    const done = [];
    for (const b of blogs) {
      if (b.uuid === main.uuid) continue;
      for (const p of lists.get(b.uuid)) {
        const id = postId(p);
        if ((p.timestamp || 0) <= since || (p.state || 'published') !== 'published' || isCopyOf(p, names)) continue;
        if (onMain.has(`${b.name}/${id}`.toLowerCase())) continue;
        await reblogPost(api, main.uuid, b.uuid, id, 'published', t);
        done.push({ type: 'reblog', blog: b.name, id, to: main.name });
        await sleep(1000);
      }
    }
    const byKey = new Map();
    for (const b of blogs) for (const p of lists.get(b.uuid)) byKey.set(`${b.name}/${postId(p)}`.toLowerCase(), p);
    for (const b of blogs) {
      for (const p of lists.get(b.uuid)) {
        if (!isCopyOf(p, names)) continue;
        const src = reblogSource(p);
        let orig = byKey.get(src.toLowerCase());
        if (!orig) { const [n, rid] = src.split('/'); try { orig = await getPost(api, n, rid); } catch { continue; } }
        const r = await editPost(api, t, b.uuid, postId(p), mutations.copyFrom({ tags: orig.tags || [], state: orig.state, label: readLabel(orig), reblog: readReblog(orig) }));
        if (!r.skipped) { done.push({ type: 'fix', blog: b.name, id: postId(p), to: src }); await sleep(1000); }
      }
    }
    return done;
  }

  // Published originals on my other blogs that my main blog hasn't reblogged yet (newest first):
  // [{ key, blog, id, tags }]
  function notOnMain(cache, mainUuid) {
    const fams = reblogFamilies(cache);
    const out = [];
    for (const [uuid, b] of Object.entries(cache.blogs)) {
      if (uuid === mainUuid) continue;
      for (const [id, rec] of Object.entries(b.posts || {})) {
        if (rec[4] || rec[2] !== 'published') continue; // reblogs and unpublished posts
        const fam = fams.get(uuid + ':' + id);
        if (fam?.members.some(k => splitKey(k).blog === mainUuid)) continue;
        out.push({ key: uuid + ':' + id, blog: uuid, id, tags: rec[0], ts: rec[1] });
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  }
  // Keys of posts that are copies (reblogs of a post on one of my blogs). They are kept in line with their
  // original automatically, so editing features leave them out.
  const copyKeys = cache => new Set([...reblogFamilies(cache)].filter(([k, f]) => k !== f.root).map(([k]) => k));
  // The same check for a post read from the API, given my blog names
  const isCopyOf = (p, myNames) => { const s = reblogSource(p); return !!s && myNames.has(s.split('/')[0].toLowerCase()); };
  // Only these states are copied; a draft or queued copy keeps its own
  const SYNC_STATES = ['published', 'private'];
  // Mutation: make a post carry another post's tags, visibility, community label and reblog control
  mutations.copyFrom = src => (n, cur) => Object.assign(n, {
    tags: src.tags.slice(),
    state: SYNC_STATES.includes(cur.state) && SYNC_STATES.includes(src.state) ? src.state : n.state,
    label: { has: src.label.has, categories: src.label.categories.slice() },
    reblog: src.reblog || n.reblog,
  });
  // After editing one post, give the same tags / visibility / label / reblog control to its copies on my other
  // blogs.
  // result is what editPost returned for the edited post. Calls onEach(key, r) after each copy is edited.
  async function syncCopies(api, t, cache, blog, id, result, onEach) {
    const fam = reblogFamilies(cache).get(blog + ':' + id);
    if (!fam) return 0;
    let n = 0;
    for (const k of fam.members) {
      if (k === blog + ':' + id) continue;
      const m = splitKey(k);
      const r = await editPost(api, t, m.blog, m.id, mutations.copyFrom(result));
      if (!r.skipped) {
        n++;
        const rec = cache.blogs[m.blog]?.posts?.[m.id];
        if (rec) { rec[0] = uniqTags(r.tags); rec[2] = r.state; rec[5] = r.label.has; rec[6] = r.reblog; }
        onEach?.(k, r);
      }
      await sleep(400);
    }
    return n;
  }

  // ---------- Collection blog: posts I like, reblogged onto one of my blogs ----------
  // settings.collect = { blog: uuid of the collection blog ('' = off), auto, tags[], imagesOnly, autoPalette, daily, from }
  // The post a liked post stands for: its original (first in the trail), or the post itself. Used to tell
  // whether the collection already has it, whoever it was reblogged from.
  const rootKey = p => (reblogSource(p) || `${pick(p, 'blogName', 'blog_name') ?? p.blog?.name}/${postId(p)}`).toLowerCase();
  const likedAt = p => pick(p, 'likedTimestamp', 'liked_timestamp') || 0;
  const ownerOf = p => pick(p, 'blogName', 'blog_name') ?? p.blog?.name ?? '';

  // My likes, newest first, while they were liked after `after` (seconds)
  async function likedPosts(api, { after = 0, ctl, onProgress } = {}) {
    const out = [];
    let path = '/v2/user/likes' + qs({ npf: true, limit: 20 });
    while (path && !ctl?.aborted) {
      const r = await api(path);
      const page = (pick(r, 'likedPosts', 'liked_posts') || []).filter(isPost);
      for (const p of page) { if (likedAt(p) <= after) return out; out.push(p); }
      onProgress?.(out.length, pick(r, 'likedCount', 'liked_count'));
      const next = (r.links || r._links)?.next;
      const q = next?.queryParams || next?.query_params;
      const href = next?.href && new URL(next.href, 'https://www.tumblr.com');
      path = !page.length ? null
        : href ? href.pathname.replace(/^\/api(?=\/v2)/, '') + href.search
          : '/v2/user/likes' + qs(q || { npf: true, limit: 20, before: likedAt(page[page.length - 1]) });
      await sleep(250);
    }
    return out;
  }

  // The collection blog's posts as kept in storage key `collection`:
  // { blog, syncedAt, posts: { [id]: [rootKey, timestamp, images: [[small, big]...], tags] } }
  const emptyCollection = blog => ({ blog, syncedAt: 0, posts: {} });
  const collectRecord = p => [rootKey(p), p.timestamp || 0, postImages(p, 250, 1280).map(i => [i.small, i.big]), uniqTags(p.tags || [])];
  // Newest first; stops after two pages with nothing new unless full
  async function syncCollection(api, store, full, ctl, onProgress) {
    const fresh = full ? {} : null;
    let path = basePosts(store.blog), n = 0, unchanged = 0;
    while (path && !ctl?.aborted) {
      const r = await api(path);
      const page = (r?.posts || []).filter(isPost);
      let changed = false;
      for (const p of page) {
        const id = postId(p);
        if (!store.posts[id]) changed = true;
        store.posts[id] = collectRecord(p);
        if (fresh) fresh[id] = store.posts[id];
      }
      n += page.length;
      onProgress?.(n, r.totalPosts ?? r.total_posts ?? r.blog?.totalPosts);
      if (!full) { unchanged = changed ? 0 : unchanged + 1; if (unchanged >= 2) break; }
      path = page.length ? nextPath(r, store.blog, {}, n, page.length >= 20) : null;
      await sleep(250);
    }
    if (fresh && !ctl?.aborted) store.posts = fresh;
    store.syncedAt = Date.now();
    return store;
  }

  // Why a liked post is not reblogged into the collection, or '' if it should be.
  // have: Set of root keys the collection holds; myNames: Set of my other blogs' names (my own posts are left
  // out: reblogs between my blogs are kept in line with their original, tags and all)
  function collectSkip(p, have, myNames, opts = {}) {
    if (have.has(rootKey(p))) return 'have';
    if (myNames.has(ownerOf(p).toLowerCase()) || isCopyOf(p, myNames)) return 'mine';
    if (pick(p, 'canReblog', 'can_reblog') === false || readReblog(p) === 'noone') return 'closed';
    if (opts.imagesOnly !== false && !postImages(p).length) return 'noImages';
    return '';
  }

  // Tumblr's daily post limit (also counts reblogs). It may come as a 4xx other than 429, so the message counts
  // too: "You've exceeded your daily post or media limit"
  const isPostLimit = e => e?.status === 429 || /daily (post|media)|post (or media )?limit/i.test(errMsg(e));

  // Reblog someone's post onto the collection blog with my own tags
  async function collectPost(api, toBlog, p, { tags = [], state = 'published' } = {}) {
    const body = {
      parent_tumblelog_uuid: p.blog?.uuid || ownerOf(p), parent_post_id: postId(p),
      reblog_key: pick(p, 'reblogKey', 'reblog_key'), content: [], layout: [], state, tags: tags.join(','),
    };
    const r = await api(`/v2/blog/${enc(toBlog)}/posts`, { method: 'POST', body });
    return String(pick(r, 'idString', 'id_string') ?? r?.id ?? '');
  }

  // One unattended pass: posts liked after `since` (seconds) are reblogged onto the collection blog, oldest
  // first. Returns { done: [{ id, blog, post }], skipped: [{ blog, id, reason }], last, error }: `last` is the
  // newest like handled, the `since` for the next pass. A like Tumblr refuses to reblog (4xx) is skipped for
  // good; a login, rate-limit or server error stops the pass there and it is tried again next time.
  async function autoCollect(api, collect, since) {
    const blogs = await getBlogs(api);
    const target = blogs.find(b => b.uuid === collect.blog);
    if (!target) throw new Error('collection blog not found');
    const myNames = new Set(blogs.filter(b => b.uuid !== target.uuid).map(b => b.name.toLowerCase()));
    const likes = (await likedPosts(api, { after: since })).reverse();
    const out = { done: [], skipped: [], last: since };
    if (!likes.length) return out;
    const have = new Set((await newestPosts(api, target.uuid, 2)).map(rootKey));
    for (const p of likes) {
      const who = ownerOf(p), id = postId(p);
      let why = collectSkip(p, have, myNames, collect);
      if (!why && aiArtVerdict({ owner: await ownerTagsOf(api, p) }).verdict) {
        why = 'aiArt';
        try { await unlikePost(api, p); } catch { /* still left out */ }
      }
      if (why) { if (why !== 'have') out.skipped.push({ blog: who, id, reason: why }); }
      else {
        try {
          let tags = collect.tags || [];
          if (collect.autoPalette !== false) { try { tags = withTags(tags, await postPalette(postImages(p))); } catch { /* reblogged without them */ } }
          out.done.push({ id: await collectPost(api, target.uuid, p, { ...collect, tags }), blog: who, post: id });
          have.add(rootKey(p));
          await sleep(1000);
        } catch (e) {
          if (!(e.status >= 400 && e.status < 500) || e.status === 401 || isPostLimit(e)) { out.error = errMsg(e); break; }
          out.skipped.push({ blog: who, id, reason: errMsg(e) });
        }
      }
      out.last = Math.max(out.last, likedAt(p));
    }
    return out;
  }

  // A few images for a quick study: `n` different posts of the collection, one image of each, always the same
  // for the same `seed` (the date plus how often "another set" was pressed). Returns [{ id, small, big }]
  function dailyPick(store, n, seed) {
    let h = 2166136261;
    for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const rand = () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
    const pool = Object.entries(store?.posts || {}).filter(([, r]) => r[2]?.length).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out = [];
    while (out.length < n && pool.length) {
      const [id, rec] = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      const [small, big] = rec[2][Math.floor(rand() * rec[2].length)];
      out.push({ id, small, big });
    }
    return out;
  }

  // ---------- Sorting the collection: reference categories ----------
  // Plain English tags for drawing references, by what they help to study. The interface shows them translated
  // (STRINGS refNames); the tags on the posts stay English. The palette group is worked out from the image
  // (paletteTags); the others are picked by hand.
  const REF_GROUPS = [
    { id: 'palette', auto: true, tags: ['warm palette', 'cool palette', 'warm cool contrast', 'high saturation', 'muted colors', 'pastel colors',
      'high key', 'low key', 'high contrast', 'low contrast', 'monochrome', 'grayscale', 'complementary colors', 'analogous colors'] },
    { id: 'light', tags: ['backlight', 'rim light', 'side light', 'top light', 'under light', 'hard light', 'soft light', 'golden hour', 'night scene',
      'neon light', 'colored lights', 'volumetric light', 'dappled light', 'cast shadow', 'reflected light', 'subsurface scattering', 'silhouette',
      'atmospheric perspective', 'fog'] },
    { id: 'material', tags: ['skin', 'hair', 'eyes', 'fabric folds', 'sheer fabric', 'leather', 'fur', 'metal', 'glass', 'transparent', 'gemstone',
      'water', 'ice', 'fire', 'smoke', 'foliage', 'flowers', 'wood', 'rock', 'sky and clouds'] },
    { id: 'composition', tags: ['close up', 'bust shot', 'full body', 'wide shot', 'low angle', 'high angle', 'foreshortening', 'dynamic pose',
      'centered composition', 'rule of thirds', 'diagonal composition', 'symmetry', 'negative space', 'framing', 'leading lines', 'depth layers'] },
    { id: 'subject', tags: ['character', 'multiple characters', 'animal', 'landscape', 'cityscape', 'architecture', 'interior', 'still life', 'food', 'mecha'] },
    { id: 'technique', tags: ['painterly', 'cel shading', 'soft shading', 'flat colors', 'lineless', 'line art', 'watercolor', 'sketch', 'pixel art',
      '3d render', 'photo'] },
  ];
  const refGroupOf = tag => REF_GROUPS.find(g => g.tags.includes(key(tag)))?.id || null;

  // Palette tags from an image's pixels (RGBA bytes, best downscaled to about 64×64 first). Light and
  // contrast come from luminance, saturation from chroma, warm and cool and the colour scheme from the hues
  // of the clearly coloured pixels, weighted by how colourful they are.
  function paletteTags(px) {
    const lum = [];
    let chromaSum = 0, colored = 0, warm = 0, cool = 0, wsum = 0, hx = 0, hy = 0;
    const bins = new Array(12).fill(0);
    for (let i = 0; i + 3 < px.length; i += 4) {
      if (px[i + 3] < 128) continue; // transparent
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
      lum.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      chromaSum += c;
      if (c < 0.15 || max < 0.12) continue;
      colored++;
      let h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
      h = (h * 60 + 360) % 360;
      if (h < 75 || h >= 330) warm += c; else if (h >= 150 && h < 290) cool += c;
      wsum += c;
      hx += c * Math.cos(h * Math.PI / 180); hy += c * Math.sin(h * Math.PI / 180);
      bins[Math.floor(h / 30) % 12] += c;
    }
    const n = lum.length;
    if (!n) return [];
    lum.sort((a, b) => a - b);
    const meanL = lum.reduce((a, b) => a + b, 0) / n;
    const spread = lum[Math.floor(n * 0.95)] - lum[Math.floor(n * 0.05)];
    const meanC = chromaSum / n, colorShare = colored / n;
    const tags = [];
    if (meanC < 0.04) tags.push('grayscale');
    else if (colorShare >= 0.15) {
      const ws = warm / (warm + cool || 1);
      if (ws >= 0.75) tags.push('warm palette');
      else if (ws <= 0.25) tags.push('cool palette');
      else if (warm >= 0.2 * wsum && cool >= 0.2 * wsum) tags.push('warm cool contrast');
      // how concentrated the hues are (1 = all one hue), and the two strongest hue ranges
      const R = Math.hypot(hx, hy) / wsum;
      const top = bins.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
      const apart = Math.min(Math.abs(top[0][1] - top[1][1]), 12 - Math.abs(top[0][1] - top[1][1]));
      if (R >= 0.99) tags.push('monochrome');
      else if (top[1][0] >= 0.15 * wsum && apart >= 5) tags.push('complementary colors');
      else if (R >= 0.7) tags.push('analogous colors');
    } else tags.push('monochrome');
    if (meanC >= 0.38) tags.push('high saturation');
    else if (meanC < 0.13 && meanC >= 0.04) tags.push('muted colors');
    if (meanL >= 0.68 && meanC >= 0.06 && meanC < 0.3) tags.push('pastel colors');
    if (meanL >= 0.62) tags.push('high key');
    else if (meanL <= 0.32) tags.push('low key');
    if (spread >= 0.75) tags.push('high contrast');
    else if (spread <= 0.35) tags.push('low contrast');
    return tags;
  }

  // An image's pixels, downscaled to fit `size`. Works in pages and in the service worker (no DOM); the
  // extension's host permission for Tumblr's media hosts lets it read the image.
  async function imagePixels(url, size = 64, fetchFn = fetch) {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const bmp = await createImageBitmap(await res.blob());
    const k = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return ctx.getImageData(0, 0, w, h).data;
  }
  // Palette tags for a post: from its first image
  async function postPalette(images, fetchFn) {
    const first = images?.[0];
    const url = Array.isArray(first) ? first[0] : first?.small;
    return url ? paletteTags(await imagePixels(url, 64, fetchFn)) : [];
  }

  // ---------- AI-made images in the collection ----------
  // Clues, strongest first: the original poster's own tags; tags other people add when they reblog it and
  // replies (only when two or more different blogs say so and nobody says it isn't); the vision model, when
  // it is sure. "Not AI" ("#not ai art", "#no ai", "#human art") always counts against, never for.
  const AI_ART_TAG = 'suspected ai';
  const AI_ART_YES = /\b(ai[\s_-]*(art|arts|artwork|generated|gen|image|images|illustration|illust|picture|pic|pics|slop|assisted|made)|aiart|aigenerated|midjourney|nijijourney|stable[\s_-]*diffusion|novel[\s_-]*ai|dall[\s_-]*e|generative[\s_-]*ai|(made|done|created)[\s_-]*(with|by|using)[\s_-]*ai)\b/i;
  const AI_ART_NO = /\b(not|no|non|anti|never|zero|without)[\s_-]*ai\b|\bnoai\b|\bai[\s_-]*free\b|\bhuman[\s_-]*(made|art|artist)\b|\bnot[\s_-]*(ai[\s_-]*)?generated\b/i;
  // In a reply, also "this is AI", "it looks like ai"
  const AI_ART_SAID = /\b(this|that|it)('?s|\s+is|\s+was|\s+looks)\s+(like\s+)?(an?\s+)?ai\b/i;
  // 'yes', 'no' or null for one tag or reply; links are left out (a site on .ai is not a clue)
  function aiArtSignal(text, reply = false) {
    const s = String(text || '').replace(/https?:\/\/\S+|\b[\w-]+(\.[\w-]+)*\.ai\b\S*/gi, ' ');
    if (AI_ART_NO.test(s)) return 'no';
    return AI_ART_YES.test(s) || (reply && AI_ART_SAID.test(s)) ? 'yes' : null;
  }
  // owner: the original poster's tags; others: [{ blog, text, reply }]; vision: 'yes' when the model is sure.
  // Returns { verdict: 'ai' | 'suspect' | null, why: 'owner' | 'others' | 'vision', n }
  function aiArtVerdict({ owner = [], others = [], vision = null }) {
    const own = owner.map(tag => aiArtSignal(tag));
    if (own.includes('no')) return { verdict: null };
    if (own.includes('yes')) return { verdict: 'ai', why: 'owner' };
    const yes = new Set(), no = new Set();
    for (const o of others) {
      const v = aiArtSignal(o.text, o.reply);
      if (v === 'yes') yes.add(String(o.blog).toLowerCase()); else if (v === 'no') no.add(String(o.blog).toLowerCase());
    }
    if (yes.size >= 2 && !no.size) return { verdict: 'suspect', why: 'others', n: yes.size };
    if (vision === 'yes') return { verdict: 'suspect', why: 'vision' };
    return { verdict: null };
  }
  // The original poster's tags for a post: its own, or its original's for a reblog ([] if that is gone)
  async function ownerTagsOf(api, p) {
    const tr = (p.trail || [])[0];
    if (!tr?.blog?.name || !tr?.post?.id) return p.tags || [];
    try { return (await getPost(api, tr.blog.name, tr.post.id)).tags || []; } catch { return []; }
  }
  // All clues for one original ("blog/id"): its tags, the newest reblogs with tags, the replies
  async function aiArtCheck(api, root) {
    const [blog, id] = root.split('/');
    let p;
    try { p = await getPost(api, blog, id); } catch (e) { if (e.status === 404) return { verdict: null, gone: true }; throw e; }
    const others = [];
    const notes = async mode => (await api(`/v2/blog/${enc(blog)}/notes${qs({ id, mode })}`))?.notes || [];
    try {
      for (const n of await notes('reblogs_with_tags')) for (const tag of n.tags || []) others.push({ blog: pick(n, 'blogName', 'blog_name'), text: tag });
    } catch { /* notes hidden or unavailable */ }
    try {
      for (const n of await notes('conversation')) if (n.type === 'reply') others.push({ blog: pick(n, 'blogName', 'blog_name'), text: pick(n, 'replyText', 'reply_text'), reply: true });
    } catch { /* replies off */ }
    return aiArtVerdict({ owner: p.tags || [], others });
  }
  // Take back a like (the liked post itself, which may be someone's reblog)
  const unlikePost = (api, p) => api('/v2/user/unlike', { method: 'POST', body: { id: postId(p), reblog_key: pick(p, 'reblogKey', 'reblog_key') } });
  // Delete one of my posts (the web client's DELETE first, then the documented endpoint)
  async function deletePost(api, blog, id) {
    try { return await api(`/v2/blog/${enc(blog)}/posts/${enc(id)}`, { method: 'DELETE' }); } catch (e) {
      if (![404, 405].includes(e.status)) throw e;
      return api(`/v2/blog/${enc(blog)}/post/delete`, { method: 'POST', body: { id: String(id) } });
    }
  }

  // ---------- Sorting by an AI vision model (optional, the user's own OpenAI-compatible endpoint) ----------
  // settings.ai = { base: 'https://…/v1', model }; the key is kept apart, in storage key `aiKey`.
  // The model may only pick tags from the hand-picked groups (the palette is worked out from pixels).
  const AI_GROUPS = () => REF_GROUPS.filter(g => !g.auto);
  // The tag that says the AI has looked at a post (kept on the post, so every browser sees it)
  const AI_MARK = 'ai sorted';
  function aiPrompt() {
    return 'You sort reference images for a painter who does quick studies. For the image, choose the tags that clearly '
      + 'apply, only from these lists (use the exact words):\n'
      + AI_GROUPS().map(g => `${g.id}: ${g.tags.join(', ')}`).join('\n')
      + '\nAlso say whether the image itself looks AI-generated: "ai_generated": "yes" only when you are sure, otherwise "no" or "unsure".'
      + '\nReply with JSON only, like {"light": ["backlight"], "material": [], ..., "ai_generated": "no"}. Leave a list empty when nothing clearly fits.';
  }
  // The tags of a reply that are in the lists, in list order; anything else the model says is dropped
  function parseAiTags(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return [];
    let obj;
    try { obj = JSON.parse(m[0]); } catch { return []; }
    const said = new Set(Object.values(obj || {}).flat().filter(x => typeof x === 'string').map(key));
    return AI_GROUPS().flatMap(g => g.tags.filter(tag => said.has(tag)));
  }
  // 'yes' when the model said it is sure the image is AI-generated
  const parseAiArt = text => (/"ai_generated"\s*:\s*"yes"/i.test(String(text || '')) ? 'yes' : null);
  // One image (a data: URL) to the model; returns { tags, aiArt }. Reasoning models spend tokens thinking first, so the budget is
  // generous. Providers that don't take response_format get the request again without it.
  async function aiTagImage(ai, apiKey, dataUrl, fetchFn = fetch) {
    const url = ai.base.replace(/\/+$/, '') + '/chat/completions';
    const send = async withFormat => {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ai.model, max_tokens: 4000, ...(withFormat ? { response_format: { type: 'json_object' } } : {}),
          messages: [{ role: 'user', content: [{ type: 'text', text: aiPrompt() }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(json?.error?.message || res.status + ' ' + res.statusText), { status: res.status });
      return json;
    };
    let json;
    try { json = await send(true); } catch (e) { if (e.status !== 400 || !/response_format|json/i.test(e.message)) throw e; json = await send(false); }
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new Error(json?.choices?.[0]?.finish_reason === 'length' ? 'the reply ran out of tokens' : 'empty reply');
    return { tags: parseAiTags(text), aiArt: parseAiArt(text) };
  }
  // An image as a JPEG data: URL, downscaled to fit `size` (works in pages and the service worker)
  async function imageDataUrl(url, size = 768, fetchFn = fetch) {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const bmp = await createImageBitmap(await res.blob());
    const k = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const cv = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close?.();
    const bytes = new Uint8Array(await (await cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return 'data:image/jpeg;base64,' + btoa(bin);
  }

  // skip: uuids of blogs left out of the tag library (the collection blog holds other people's tags)
  async function syncAll(api, cache, full, ctl, onStatus, t, save, skip = []) {
    const blogs = await getBlogs(api);
    if (blogs.length) cache.blogList = blogs;
    for (const uuid of skip) delete cache.blogs[uuid];
    for (const b of blogs) {
      if (ctl.aborted) break;
      if (skip.includes(b.uuid)) continue;
      await syncBlog(api, cache, b, full, (n, total) => onStatus(t('syncing', b.name, n, total)), ctl, save);
    }
    cache.lastAuto = Date.now();
    await save();
  }

  // Sample the newest sitewide posts for a tag. Tumblr's tag search is fuzzy, so only posts that really
  // carry the tag count towards the rate, and `match` is the share of results that do
  // Also `notes`: the median note count (likes + reblogs + replies) of those real posts; `sample`: how many
  // real posts there were; `co`: the tags most often used together with it on them, as [[tag, count], …]
  async function tagActivity(api, tag) {
    const r = await api('/v2/tagged' + qs({ tag, limit: 20 }));
    const list = (Array.isArray(r) ? r : r?.posts || []).filter(isPost);
    if (!list.length) return { rate: 0, match: null, notes: null, sample: 0, co: [] };
    const k = key(tag);
    const real = list.filter(p => (p.tags || []).some(x => key(x) === k));
    const oldest = Math.min(...list.map(p => p.timestamp || Date.now() / 1000));
    const days = Math.max((Date.now() / 1000 - oldest) / 86400, 1 / 24);
    const nc = real.map(p => pick(p, 'noteCount', 'note_count')).filter(n => typeof n === 'number').sort((a, b) => a - b);
    const co = new Map();
    for (const p of real) for (const x of uniqTags(p.tags || [])) {
      const xk = x.toLowerCase();
      if (xk === k) continue;
      const e = co.get(xk);
      if (e) e[1]++; else co.set(xk, [x, 1]);
    }
    return {
      rate: real.length / days, match: Math.round(real.length / list.length * 100),
      notes: nc.length ? nc[Math.floor(nc.length / 2)] : null,
      sample: real.length, co: [...co.values()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    };
  }

  // Numbers from the tag page's header: how many people follow the tag, its total posts and whether it is
  // trending. They are not in the API, only embedded near the start of tumblr.com/tagged/<tag>, so read
  // the page as a stream and stop as soon as they appear (~100 KB instead of ~700 KB).
  async function tagHeader(tag, fetchFn = fetch) {
    const res = await fetchFn('https://www.tumblr.com/tagged/' + enc(tag), { credentials: 'include' });
    if (!res.ok) throw Object.assign(new Error('tag page ' + res.status), { status: res.status });
    const parse = txt => {
      const m = txt.match(/"followersCountInt":(\d+)[\s\S]{0,600}?"postCountInt":(\d+)/);
      return m && { followers: +m[1], posts: +m[2], trending: /"isTrending":true/.test(txt.slice(Math.max(0, m.index - 300), m.index)) };
    };
    const reader = res.body?.getReader?.();
    if (!reader) return parse(await res.text());
    const dec = new TextDecoder();
    let txt = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      txt += dec.decode(value, { stream: true });
      const found = parse(txt);
      if (found) { reader.cancel().catch(() => {}); return found; }
      if (txt.length > 3e6) break;
    }
    return parse(txt);
  }

  // cache.tagStats entries are reused for 7 days; entries without follower numbers are from older versions
  const TAG_STATS_TTL = 7 * 86400 * 1000;
  const statFresh = s => !!s && 'match' in s && 'followers' in s && 'co' in s && Date.now() - s.at < TAG_STATS_TTL;

  // Make sure cache.tagStats holds a fresh sample for every given tag:
  // { rate, match, notes, followers, posts, trending, at } (followers etc. are null if the tag page failed).
  // Resolves to the number of tags that could not be checked. opts: { ctl: {aborted}, onProgress(i, n), save(), fetch }
  async function ensureTagStats(api, cache, tags, opts = {}) {
    const { ctl = {}, onProgress, save, fetch: fetchFn } = opts;
    cache.tagStats ||= {};
    const todo = [...new Set(tags.map(key))].filter(k => k && !statFresh(cache.tagStats[k]));
    let failed = 0;
    for (let i = 0; i < todo.length && !ctl.aborted; i++) {
      onProgress?.(i + 1, todo.length);
      try {
        const activity = await tagActivity(api, todo[i]);
        const header = await tagHeader(todo[i], fetchFn).catch(() => null);
        cache.tagStats[todo[i]] = { ...activity, followers: header?.followers ?? null, posts: header?.posts ?? null, trending: !!header?.trending, at: Date.now() };
      } catch { failed++; }
      if (save && i % 20 === 19) await save();
      await sleep(400);
    }
    if (save) await save();
    return failed;
  }

  // Order tags by how many people they reach, from cache.tagStats: followers of the tag first, then the
  // typical notes of its recent posts, then posts per day. Tags without a sample keep their relative order
  // at the end. Tags are not rewritten.
  function sortByHeat(tags, stats) {
    const heat = tg => { const s = stats?.[key(tg)]; return [s?.followers ?? -1, s?.notes ?? -1, s?.rate ?? -1]; };
    const cmp = (a, b) => { for (let j = 0; j < 3; j++) if (a.h[j] !== b.h[j]) return b.h[j] - a.h[j]; return a.i - b.i; };
    return tags.map((tg, i) => ({ tg, i, h: heat(tg) })).sort(cmp).map(x => x.tg);
  }

  // Words that never tie two tags to the same subject (besides the fandom's own words, passed as stop words)
  const GENERIC_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'x', 'my', 'au', 'art', 'fanart', 'fic', 'fanfic', 'ship', 'shipping']);
  const words = tg => key(tg).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Group tags that name the same subject by shared words: "zarc", "zarc arc v" and "supreme king zarc" share
  // "zarc". Stop words (e.g. the pack's base tags' words: yugioh, arc, v) and GENERIC_WORDS link nothing. Tags
  // made only of stop words ("yugioh", "arc v") name the work: together they are one group, WORK_GROUP. Tags made
  // only of generic words ("fanart") name no subject: each is a group of its own (id starting with \u0000).
  // Tags with fewer name words are placed first, so a tag naming two known subjects ("zarc x shinji") joins one
  // of them instead of merging the two.
  // Returns tagKey -> group id.
  const WORK_GROUP = '\u0001work';
  function nameGroups(tags, stop = []) {
    const stopSet = new Set(stop.flatMap(words));
    const skip = new Set([...GENERIC_WORDS, ...stopSet]);
    const names = tg => [...new Set(words(tg).filter(w => !skip.has(w)))];
    const groupOfWord = new Map();
    const out = new Map();
    const order = tags.map(tg => ({ k: key(tg), ws: names(tg) })).sort((a, b) => a.ws.length - b.ws.length);
    for (const { k, ws } of order) {
      if (out.has(k)) continue;
      if (!ws.length) { out.set(k, words(k).some(w => stopSet.has(w)) ? WORK_GROUP : '\u0000' + k); continue; }
      const known = [...new Set(ws.map(w => groupOfWord.get(w)).filter(Boolean))];
      const g = known[0] || k;
      out.set(k, g);
      if (known.length <= 1) for (const w of ws) groupOfWord.set(w, g);
    }
    return out;
  }

  // Order a post's tags so the first ones cover everything in the post: the hottest tag of every subject
  // comes first, the work first, then characters, then relations, then the rest (formats, other tags), the
  // hottest first within each; after that all the other tags by heat. So a popular character's many
  // spellings can't push a little-followed character out of the first 20. Tags are not rewritten.
  // opts.groups: tagKey -> { id, rank } from packGrouping (rank: SUBJECT_RANK); tags not in it are grouped
  // by nameGroups with opts.stop (fandom-only tags such as "yugioh" are the work, "fanart" ranks as other).
  // Only when there are more tags than the blog search reads (TPL_SEARCH_CUTS[0]) are tags that bring a search
  // word no earlier tag has (Tumblr's search matches words, and "yuri" / "yuuri" are different words) moved
  // up, just far enough that they stay within the cutoff; same-word spellings give way to them.
  const SUBJECT_RANK = { work: 0, char: 1, rel: 2, other: 3 };
  function sortTagsFair(tags, stats, opts = {}) {
    const byName = nameGroups(tags.filter(tg => !opts.groups?.has(key(tg))), opts.stop);
    const rankOfName = id => (id === WORK_GROUP ? SUBJECT_RANK.work : id.startsWith('\u0000') ? SUBJECT_RANK.other : SUBJECT_RANK.char);
    const groupOf = tg => opts.groups?.get(key(tg)) ?? { id: byName.get(key(tg)), rank: rankOfName(byName.get(key(tg))) };
    const seen = new Set(), heads = [], rest = [];
    for (const tg of sortByHeat(tags, stats)) {
      const g = groupOf(tg);
      if (seen.has(g.id)) rest.push(tg); else { seen.add(g.id); heads.push({ tg, rank: g.rank }); }
    }
    // stable sort: heads keep their heat order within a rank
    const front = heads.sort((a, b) => a.rank - b.rank).map(h => h.tg);
    const stop = stopWords(opts.stop);
    const covered = new Set(front.flatMap(tg => nameWords(tg, stop)));
    const isAdd = rest.map(tg => {
      const ws = nameWords(tg, stop);
      const add = ws.some(w => !covered.has(w));
      ws.forEach(w => covered.add(w));
      return add;
    });
    // fill the slots up to the cutoff by heat, but leave room for every new-word tag still to come
    let slots = TPL_SEARCH_CUTS[0] - front.length;
    let addsLeft = isAdd.filter(Boolean).length;
    const mid = [], late = [];
    rest.forEach((tg, i) => {
      if (isAdd[i]) { addsLeft--; (slots > 0 ? mid : late).push(tg); slots--; }
      else if (slots > addsLeft) { mid.push(tg); slots--; }
      else late.push(tg);
    });
    return [...front, ...mid, ...late];
  }
  // Search words of a tag that can name a subject: its words minus generic and fandom words
  const stopWords = (stop = []) => new Set([...GENERIC_WORDS, ...stop.flatMap(words)]);
  const nameWords = (tg, stop) => words(tg).filter(w => !stop.has(w));
  // Which of an item's spellings to use: the n hottest, plus every spelling that brings a search word none of
  // the chosen ones has. Same-word spellings beyond n ("sakaki yuya" after "yuya sakaki") are left out.
  function coverSpellings(tags, stats, n, stop) {
    const chosen = [], covered = new Set();
    for (const tg of sortByHeat(tags, stats)) {
      const ws = nameWords(tg, stop);
      if (chosen.length < n || ws.some(w => !covered.has(w))) { chosen.push(tg); ws.forEach(w => covered.add(w)); }
    }
    return chosen;
  }
  // sortTagsFair options from installed (parsed) template packs: each item's tags (old spellings included)
  // are one subject, ranked by its kind; a pack's base tags and its work items' tags together are its work.
  // These are also stop words for the name grouping of everything else.
  function packGrouping(packs) {
    const groups = new Map();
    const rankOf = { work: SUBJECT_RANK.work, char: SUBJECT_RANK.char, ship: SUBJECT_RANK.rel, group: SUBJECT_RANK.rel };
    const add = (tg, id, rank) => { if (!groups.has(key(tg))) groups.set(key(tg), { id, rank }); };
    for (const pk of packs) {
      if (!pk) continue;
      for (const tg of pk.base) add(tg, pk.id + ':base', SUBJECT_RANK.work);
      for (const it of pk.items.values()) {
        const id = it.kind === 'work' ? pk.id + ':base' : pk.id + ':' + it.id;
        for (const tg of [...it.tags, ...it.retired]) add(tg, id, rankOf[it.kind] ?? SUBJECT_RANK.other);
      }
    }
    return { groups, stop: packs.flatMap(packStop) };
  }
  // A pack's fandom words: its base tags and the tags of its work items ("arcv", "yu gi oh", "manga"...)
  const packStop = pk => (pk ? [...pk.base, ...[...pk.items.values()].filter(it => it.kind === 'work').flatMap(it => it.tags)] : []);
  // opts as for sortTagsFair
  mutations.sortByHeat = (stats, opts) => n => Object.assign(n, { tags: sortTagsFair(n.tags, stats, opts) });

  // Share of a tag's sampled posts that also carry one of the fandom tags (a lower bound, from the top
  // co-occurring tags). null when it can't be judged: no fandom given, no sample, or the tag is a fandom tag.
  const OFFTOPIC_SHARE = 0.2;

  // Tumblr's search splits a tag at punctuation, so for tags such as "yuto (arc v)" or "arc-v" the share of
  // search results that really carry the tag says nothing about the tag itself: the search-match rule skips them
  const hasPunct = tag => /[^\p{L}\p{N}\s]/u.test(tag);
  const searchMatch = (tag, s) => (s?.match == null || hasPunct(tag) ? null : s.match);
  function fandomShare(tag, s, fandom) {
    if (!fandom.length || !s?.sample) return null;
    const fk = new Set(fandom.map(key));
    if (fk.has(key(tag))) return null;
    const best = Math.max(0, ...(s.co || []).filter(([ct]) => fk.has(key(ct))).map(([, n]) => n));
    return Math.round(best / s.sample * 100) / 100;
  }

  // ---------- Weak tags ----------
  // One set of rules says which tags are weak wherever it is asked: the template preview's flags, the pack
  // review's removal suggestions and the extension's cleanup. The thresholds are personal settings (TAG_RULES).
  //   offtopic: the tag's sampled posts rarely carry the fandom's base tags (another fandom uses the name,
  //     "kurosaki family" is mostly Bleach)
  //   dead: no recent post carries it and nobody follows it
  //   fuzzy: its search mostly shows posts without it (match below rules.matchMin %)
  //   cold: popularity in the bottom rules.coldPct % of the tags it is compared with (needs COLD_MIN samples)
  const TAG_RULES = { offtopic: true, cold: true, coldPct: 20, match: true, matchMin: 30 };
  const COLD_MIN = 3;
  // judgeTags(tags, stats, rules, opts) -> Map tagKey -> { reason, share?, match?, rank?, of? } for the weak tags.
  //   opts.fandom: base tags, or tag -> base tags, for the offtopic rule (no fandom: not judged)
  //   opts.keepWords: stop words; when given, a tag that is the only one here carrying some search word is never
  //     called dead or cold, since people searching that word would no longer find the post ("yuuri" spellings,
  //     a supporting character's only tag)
  function judgeTags(tags, stats, rules = TAG_RULES, opts = {}) {
    rules = { ...TAG_RULES, ...rules };
    const fandomOf = typeof opts.fandom === 'function' ? opts.fandom : () => opts.fandom || [];
    const stop = opts.keepWords ? stopWords(opts.keepWords) : null;
    const wordUse = new Map();
    if (stop) for (const tg of tags) for (const w of new Set(nameWords(tg, stop))) wordUse.set(w, (wordUse.get(w) || 0) + 1);
    const kept = tg => !!stop && nameWords(tg, stop).some(w => wordUse.get(w) === 1);
    const ranks = heatRanks(tags, stats);
    const coldFrom = rules.cold && ranks.size >= COLD_MIN ? ranks.size - Math.ceil(ranks.size * rules.coldPct / 100) + 1 : Infinity;
    const out = new Map();
    for (const tg of tags) {
      const k = key(tg), s = stats?.[k];
      if (!s || out.has(k)) continue;
      const share = rules.offtopic ? fandomShare(tg, s, fandomOf(tg)) : null;
      const match = rules.match ? searchMatch(tg, s) : null;
      if (share !== null && share < OFFTOPIC_SHARE) out.set(k, { reason: 'offtopic', share });
      else if (!s.rate && !s.followers && !kept(tg)) out.set(k, { reason: 'dead' });
      else if (match !== null && match < rules.matchMin) out.set(k, { reason: 'fuzzy', match });
      else if (ranks.get(k) >= coldFrom && !kept(tg)) out.set(k, { reason: 'cold', rank: ranks.get(k), of: ranks.size });
    }
    return out;
  }

  // Upkeep suggestions for one tag list (a character's or a relation's tags), from cache.tagStats samples:
  // - add: tags that people put on at least `minShare` of the sampled posts of these tags, and that are
  //   not already in the list or in `exclude` (e.g. the pack's base tags)
  // - remove: the weak ones by judgeTags with opts.rules, judged against `fandom` (e.g. the pack's base tags);
  //   a spelling that alone carries some search word is never suggested for being dead or cold
  // Nothing is changed; the caller shows these for the user to accept.
  function suggestTagChanges(tags, stats, opts = {}) {
    const { exclude = [], fandom = [], minShare = 0.25, limit = 8 } = opts;
    const own = new Set(tags.map(key));
    const ex = new Set(exclude.map(key));
    const tally = new Map();
    let total = 0;
    for (const tg of tags) {
      const s = stats?.[key(tg)];
      if (!s?.sample) continue;
      total += s.sample;
      for (const [ct, n] of s.co || []) {
        const ck = key(ct);
        if (own.has(ck) || ex.has(ck)) continue;
        const e = tally.get(ck);
        if (e) e.n += n; else tally.set(ck, { tag: ct, n });
      }
    }
    const add = [...tally.values()]
      .map(e => ({ tag: e.tag, share: Math.round(e.n / total * 100) / 100 }))
      .filter(e => e.share >= minShare && !hasPunct(e.tag)) // punctuated tags are not suggested; see searchMatch
      .sort((a, b) => b.share - a.share)
      .slice(0, limit);
    const weak = judgeTags(tags, stats, opts.rules, { fandom, keepWords: [...exclude, ...fandom] });
    const remove = tags.filter(tg => weak.has(key(tg))).map(tg => ({ tag: tg, ...weak.get(key(tg)) }));
    return { add, remove };
  }

  // One-line description of a tagStats entry, for tooltips
  const heatText = (t, s) => (s ? [
    s.followers != null ? t('followersN', s.followers) : '',
    s.notes != null ? t('tagNotes', s.notes) : '',
    s.trending ? t('trending') : '',
  ].filter(Boolean).join(' · ') : '');

  // Popularity rank of each tag among the given ones (1 = most popular, same order as sortByHeat),
  // counting only tags that have a sample. "Cold" is relative: the bottom of this ranking.
  function heatRanks(tags, stats) {
    const known = [...new Set(tags.map(key))].filter(k => stats?.[k]);
    return new Map(sortByHeat(known, stats).map((k, i) => [k, i + 1]));
  }

  // ---------- Tag templates ----------
  // A template pack is JSON (full description in README):
  //   { format: 'tth-template-pack', id, name, version, base: [tags], types: { [type]: label },
  //     characters: [{ id, name, group, kw, tags, retired, with }],
  //     relations: [{ id, name, members: [ids], type, kw, tags, retired }],   empty tags: the relation is only a marker
  //     presets: [{ id, name, kw, members: [ids], relations: [ids] }],
  //     sections: [{ id, name, kind, items: [{ id, name, kw, tags, retired, with, rel, base }] }] }
  // `retired` lists an item's old spellings: they identify the item on old posts (so upkeep can replace them)
  // but are never inserted.
  // parsePack turns characters / relations / presets into sections, so the rest only deals with sections and items.
  // Picking an item also picks the items in its `with`. `base` tags join in when any picked item has base !== false.
  // kind sets the output order; the tags of one item are spellings of one name, best first.
  // An item with `rel` is a relation between its `with` members. It's left out of browsing and offered by
  // suggestCombos() once all its members are picked. A preset is a shortcut that picks its members and relations.
  const TPL_FORMAT = 'tth-template-pack';
  const TPL_KINDS = ['preset', 'ship', 'group', 'char', 'base', 'work', 'format'];
  // the weak-tag rules, plus how many spellings each character keeps once manyAt or more are picked
  const TPL_RULES = { ...TAG_RULES, manyAt: 4, spellings: 2 };
  // Search indexes only the first tags of a post: blog search 20, sitewide search 30
  const TPL_SEARCH_CUTS = [20, 30];

  // characters / relations / presets -> sections
  function packSections(p) {
    const sections = [];
    const groups = new Map();
    for (const c of p.characters || []) {
      const g = String(c.group || '');
      if (!groups.has(g)) { groups.set(g, { id: 'chars:' + g, name: g, kind: 'char', items: [] }); sections.push(groups.get(g)); }
      groups.get(g).items.push({ id: c.id, name: c.name, kw: c.kw, tags: c.tags, retired: c.retired, with: c.with, base: c.base });
    }
    if (Array.isArray(p.relations)) {
      // Romance sorts with ships, other relation types with groups
      const ship = { id: 'relations:ship', name: '', kind: 'ship', items: [] }, group = { id: 'relations:group', name: '', kind: 'group', items: [] };
      for (const r of p.relations) {
        (r.type === 'romance' ? ship : group).items.push({ id: r.id, name: r.name, kw: r.kw, tags: r.tags, retired: r.retired, with: r.members, rel: r.type || 'relation', base: r.base });
      }
      sections.push(ship, group);
    }
    if (p.presets?.length) {
      sections.unshift({ id: 'presets', name: String(p.presetsName || ''), kind: 'preset',
        items: p.presets.map(s => ({ id: s.id, name: s.name, kw: s.kw, tags: [], with: [...(s.members || []), ...(s.relations || [])] })) });
    }
    return [...sections, ...(p.sections || [])];
  }

  // Validate a pack (object or JSON text) and return it with an id -> item map; throws with a readable message
  function parsePack(raw) {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!p || p.format !== TPL_FORMAT) throw new Error(`not a template pack (format must be "${TPL_FORMAT}")`);
    if (!p.id) throw new Error('a pack needs an id');
    const tagList = a => uniqTags(Array.isArray(a) ? a : []);
    const items = new Map();
    const sections = packSections(p).map(s => {
      const kind = TPL_KINDS.includes(s.kind) && s.kind !== 'base' ? s.kind : 'char';
      return {
        id: String(s.id || ''), name: String(s.name || ''), kind,
        items: (s.items || []).map(it => {
          const id = String(it.id || '');
          if (!id) throw new Error(`an item in section "${s.name || s.id}" has no id`);
          if (items.has(id)) throw new Error(`duplicate id "${id}"`);
          const item = {
            id, name: String(it.name || ''), kind,
            kw: (it.kw || []).map(String), tags: tagList(it.tags),
            retired: tagList(it.retired).filter(tg => !tagList(it.tags).some(x => key(x) === key(tg))), with: (it.with || []).map(String), base: it.base !== false,
            rel: it.rel ? String(it.rel) : null,
          };
          items.set(id, item);
          return item;
        }),
      };
    }).filter(s => s.items.length);
    for (const it of items.values()) {
      for (const w of it.with) if (!items.has(w)) throw new Error(`"${it.id}" refers to unknown id "${w}"`);
    }
    // Unnamed relations are named after their members: "Alice × Bob"
    for (const it of items.values()) if (!it.name) it.name = it.rel ? it.with.map(w => items.get(w).name || w).join(' × ') : it.id;
    // Older packs called the type labels `relations` (an object)
    const types = p.types || (Array.isArray(p.relations) ? {} : p.relations) || {};
    return {
      id: String(p.id), name: String(p.name || p.id), version: String(p.version || ''), base: tagList(p.base),
      types: Object.fromEntries(Object.entries(types).map(([k, v]) => [k, String(v)])), sections, items,
    };
  }

  const searchItems = (pack, q) => {
    const k = key(q);
    const all = [...pack.items.values()];
    return k ? all.filter(it => [it.name, it.id, ...it.kw, ...it.tags].some(s => key(s).includes(k))) : all;
  };

  // Picked ids plus everything their `with` pulls in, sorted by kind and then pack order
  function expandPicks(pack, ids) {
    const seen = new Set();
    const visit = id => {
      const it = pack.items.get(id);
      if (!it || seen.has(id)) return;
      seen.add(id);
      it.with.forEach(visit);
    };
    ids.forEach(visit);
    const order = [...pack.items.keys()];
    return [...seen].map(id => pack.items.get(id))
      .sort((a, b) => TPL_KINDS.indexOf(a.kind) - TPL_KINDS.indexOf(b.kind) || order.indexOf(a.id) - order.indexOf(b.id));
  }

  // The plain items a relation joins, e.g. the two characters of a ship; nested relations count by their members
  function comboMembers(pack, it, seen = new Set()) {
    const out = [];
    for (const id of it.with) {
      if (seen.has(id)) continue;
      seen.add(id);
      const m = pack.items.get(id);
      if (m.rel) out.push(...comboMembers(pack, m, seen)); else out.push(m);
    }
    return out;
  }

  // Relations whose members are all picked, grouped by member set (largest first). Several relations of one
  // set can apply at once: [{ key, members: [items], options: [{ item, picked, pulled }] }].
  // picked: chosen directly; pulled: included through another pick
  function suggestCombos(pack, ids) {
    const got = new Set(expandPicks(pack, ids).map(it => it.id));
    const groups = new Map();
    for (const it of pack.items.values()) {
      if (!it.rel) continue;
      const members = comboMembers(pack, it);
      if (members.length < 2 || !members.every(m => got.has(m.id))) continue;
      const k = members.map(m => m.id).sort().join('+');
      let g = groups.get(k);
      if (!g) groups.set(k, g = { key: k, members, options: [] });
      g.options.push({ item: it, picked: ids.includes(it.id), pulled: !ids.includes(it.id) && got.has(it.id) });
    }
    return [...groups.values()].sort((a, b) => b.members.length - a.members.length);
  }

  // Build the tag list for the picked items. Nothing is dropped for being unpopular; weak tags are only flagged.
  // The one exception is a tag mostly used by another fandom: it would bring the wrong audience, so it starts off.
  //   opts: { ids, stats: cache.tagStats, overrides: { tagKey: true | false }, useBase, rules, exclude: [tags already entered] }
  // rows come in output order as { tag, item, kind, on, why, flag, forced, rank, of }.
  //   why (the row is off): 'off' turned off by hand; 'offtopic' its sampled posts rarely carry any of the pack's
  //     base tags (fandomShare below OFFTOPIC_SHARE); 'extra' a lower spelling while rules.manyAt or more characters
  //     are picked (each keeps its best rules.spellings, by heat when sampled)
  //   flag (shown, the row stays on): judgeTags' reason among the tags that go in, so 'cold' (with rank / of) is
  //     relative to this list; 'offtopic' when turned on by hand. A tag that alone carries a search word is never
  //     flagged dead or cold, so "turn off flagged" can't take a character's only tag off the post.
  // tags is the list to insert.
  function composeTemplate(pack, opts = {}) {
    const { ids = [], stats = {}, overrides = {}, useBase = true, exclude = [] } = opts;
    const rules = { ...TPL_RULES, ...opts.rules };
    const items = expandPicks(pack, ids).filter(it => it.kind !== 'preset');
    const groups = items.map(it => ({ kind: it.kind, item: it, tags: it.tags }));
    if (useBase && items.some(it => it.base)) groups.push({ kind: 'base', item: null, tags: pack.base });
    groups.sort((a, b) => TPL_KINDS.indexOf(a.kind) - TPL_KINDS.indexOf(b.kind));
    const many = items.filter(it => it.kind === 'char').length >= rules.manyAt;
    const stop = packStop(pack);

    const seen = new Set(exclude.map(key));
    const rows = [];
    for (const g of groups) {
      const tags = g.tags.filter(tg => !seen.has(key(tg)) && seen.add(key(tg)));
      const best = new Set((many && g.kind === 'char' ? coverSpellings(tags, stats, rules.spellings, stopWords(stop)) : tags).map(key));
      for (const tag of tags) {
        const k = key(tag), ov = overrides[k];
        const fit = rules.offtopic ? fandomShare(tag, stats[k], pack.base) : null;
        const why = ov === false ? 'off' : ov === true ? null : fit !== null && fit < OFFTOPIC_SHARE ? 'offtopic' : !best.has(k) ? 'extra' : null;
        rows.push({ tag, item: g.item?.id ?? null, kind: g.kind, on: !why, why, flag: null, fit, forced: ov === true, rank: null, of: null });
      }
    }
    const weak = judgeTags(rows.filter(r => r.on).map(r => r.tag), stats, rules, { fandom: pack.base, keepWords: stop });
    for (const r of rows) {
      const v = r.on && weak.get(key(r.tag));
      if (!v) continue;
      r.flag = v.reason;
      if (v.reason === 'cold') Object.assign(r, { rank: v.rank, of: v.of });
    }
    return { rows, tags: rows.filter(r => r.on).map(r => r.tag) };
  }

  // Every distinct tag in a pack, for checking the whole pack at once
  const packTags = pack => uniqTags([...pack.base, ...[...pack.items.values()].flatMap(it => it.tags)]);

  // ---------- Editing posts with a template ----------
  // Items of a pack that a post already carries, by their current tags or old spellings (presets aside)
  function itemsOnPost(tags, pack) {
    const have = new Set(tags.map(key));
    const out = new Set();
    for (const it of pack.items.values()) {
      if (it.kind !== 'preset' && [...it.tags, ...it.retired].some(tg => have.has(key(tg)))) out.add(it.id);
    }
    return out;
  }
  // For several posts: how many of them carry each item. Returns Map id -> count.
  function itemsOnPosts(tagLists, pack) {
    const counts = new Map();
    for (const tags of tagLists) for (const id of itemsOnPost(tags, pack)) counts.set(id, (counts.get(id) || 0) + 1);
    return counts;
  }
  // Re-tag a post after a template edit: every tag and old spelling of the items in `drop` goes, the tags the
  // template gives for the items in `add` come in (composeTemplate, so weak and off-fandom tags follow the same
  // rules as when inserting), then the list is put in template order (sortTagsFair with opts.order).
  // Tags the pack doesn't know stay. opts: { add, drop, stats, overrides, useBase, rules, order }
  function retagPost(tags, pack, opts = {}) {
    const { add = [], drop = [], stats = {}, order } = opts;
    // dropped items lose all their tags; added items lose their old spellings, which their current tags replace
    const dropKeys = new Set([
      ...drop.flatMap(id => { const it = pack.items.get(id); return it ? [...it.tags, ...it.retired] : []; }),
      ...add.flatMap(id => pack.items.get(id)?.retired || []),
    ].map(key));
    const kept = tags.filter(tg => !dropKeys.has(key(tg)));
    const added = add.length ? composeTemplate(pack, { ...opts, ids: add, exclude: kept }).tags : [];
    // a post the edit doesn't touch keeps its order
    if (kept.length === tags.length && !added.length) return tags.slice();
    return sortTagsFair([...kept, ...added], stats, order);
  }
  // Mutation for editPost; returns a skip reason when nothing changes
  mutations.retag = (pack, opts, t) => n => {
    const next = retagPost(n.tags, pack, opts);
    return next.join('\u0001') === n.tags.join('\u0001') ? t('upkNothing') : Object.assign(n, { tags: next });
  };

  // ---------- Pack upkeep ----------
  // Bring a post's tags in line with the installed (parsed) packs. A pack only touches posts that carry one of
  // its base tags (that is what says the post is from that fandom), and only the pack's own tags:
  // - the first retired spelling of an item is replaced in place by the item's first tag, unless the post
  //   already has one of the item's tags (or the item has none): then it is removed;
  // - any further retired spellings of that item are removed;
  // - a character or relation already on the post gets its spellings that add a search word the post lacks
  //   (type 'add'), inserted right after its own tags.
  // Every other tag stays exactly where it is. allow(change) can veto a change; change.rule names it, the same
  // for every post. Returns { tags, changes: [{ type: 'replace' | 'remove' | 'add', from, to, why, item, pack, rule }] }:
  // a removal's why is 'has' (the post already has the item's current tag) or 'dropped' (the item has no tag).
  function upkeepTags(tags, packs, allow = () => true) {
    const out = tags.slice();
    const changes = [];
    const ruleOf = ch => [ch.type, ch.from ? key(ch.from) : '', ch.to ? key(ch.to) : ''].join('\u0001');
    for (const pk of packs) {
      if (!pk) continue;
      const base = new Set(pk.base.map(key));
      if (!out.some(tg => tg !== null && base.has(key(tg)))) continue;
      for (const it of pk.items.values()) {
        const retired = new Set(it.retired.map(key));
        if (!retired.size) continue;
        let has = it.tags.some(tg => out.some(x => x !== null && key(x) === key(tg)));
        out.forEach((tg, i) => {
          if (tg === null || !retired.has(key(tg))) return;
          const ch = !has && it.tags.length
            ? { type: 'replace', from: tg, to: it.tags[0], item: it.name, pack: pk.name }
            : { type: 'remove', from: tg, to: null, why: it.tags.length ? 'has' : 'dropped', item: it.name, pack: pk.name };
          ch.rule = ruleOf(ch);
          if (!allow(ch)) return;
          out[i] = ch.to;
          if (ch.to) has = true;
          changes.push(ch);
        });
      }
      // - a character or relation already on the post gets the spellings that bring a search word the post
      //   lacks ("yuuto arc v" next to "yuto arc v"), right after its own tags, so search finds the post by them
      const stop = stopWords(packStop(pk));
      for (const it of pk.items.values()) {
        if (!['char', 'ship', 'group'].includes(it.kind)) continue;
        const own = new Set(it.tags.map(key));
        const at = out.reduce((last, tg, i) => (tg !== null && own.has(key(tg)) ? i : last), -1);
        if (at < 0) continue;
        const covered = new Set(out.filter(tg => tg !== null).flatMap(tg => nameWords(tg, stop)));
        let pos = at + 1;
        for (const tg of it.tags) {
          const ws = nameWords(tg, stop);
          if (!ws.some(w => !covered.has(w))) continue;
          const ch = { type: 'add', from: null, to: tg, item: it.name, pack: pk.name };
          ch.rule = ruleOf(ch);
          if (!allow(ch)) continue;
          out.splice(pos++, 0, tg);
          ws.forEach(w => covered.add(w));
          changes.push(ch);
        }
      }
    }
    // drop duplicates a replacement may create, keeping every tag's stored spelling
    const seen = new Set();
    return { tags: out.filter(tg => tg !== null && !seen.has(key(tg)) && seen.add(key(tg))), changes };
  }

  // upkeepTags over many posts: records are [{ key, blog, id, tags }]. Returns the posts that would change and
  // a summary per rule: [{ rule, type, from, to, item, pack, posts }], most posts first.
  function planUpkeep(records, packs) {
    const posts = [], rules = new Map();
    for (const r of records) {
      const res = upkeepTags(r.tags, packs);
      if (!res.changes.length) continue;
      posts.push({ ...r, after: res.tags, changes: res.changes });
      for (const ch of res.changes) {
        const s = rules.get(ch.rule);
        if (s) s.posts++; else rules.set(ch.rule, { ...ch, posts: 1 });
      }
    }
    return { posts, rules: [...rules.values()].sort((a, b) => b.posts - a.posts || (a.from || a.to).localeCompare(b.from || b.to)) };
  }
  // Mutation for editPost: applies the allowed upkeep rules to the post's current tags
  mutations.upkeep = (packs, allowRules, t) => n => {
    const res = upkeepTags(n.tags, packs, ch => allowRules.has(ch.rule));
    return res.changes.length ? Object.assign(n, { tags: res.tags }) : t('upkNothing');
  };

  // Read the web client's bearer token and CSRF token out of a Tumblr page's HTML
  const parseAuth = html => ({
    token: html.match(/"API_TOKEN":"([^"]+)"/)?.[1],
    csrf: html.match(/"csrfToken":"([^"]+)"/)?.[1],
  });

  return {
    sleep, enc, decodeTag, norm, key, esc, pick, debounce, qs, uniqTags, withTags, fmtNum,
    LABEL_CATEGORIES, AD_CSS, REC_CSS, UPSELL_SELECTOR, isUpsell, STRINGS, LANG_NAMES, makeI18n,
    errMsg, makeApi, getBlogs, postId, isPost, basePosts, nextPath, readLabel, readReblog, getPost, postImages, editPost, mutations,
    emptyCache, buildIndex, matchScore, suggest, syncBlog, syncAll, reblogSource, reblogFamilies, reblogDiffs, syncCopies, copyKeys, isCopyOf, notOnMain, reblogPost, newestPosts, autoMaintain, tagActivity, parseAuth,
    rootKey, likedPosts, emptyCollection, syncCollection, collectSkip, collectPost, isPostLimit,
    REF_GROUPS, refGroupOf, paletteTags, imagePixels, postPalette, AI_MARK, aiPrompt, parseAiTags, parseAiArt, aiTagImage, imageDataUrl,
    AI_ART_TAG, aiArtSignal, aiArtVerdict, ownerTagsOf, aiArtCheck, unlikePost, deletePost, autoCollect, dailyPick,
    TAG_STATS_TTL, statFresh, ensureTagStats, sortByHeat, sortTagsFair, nameGroups, packGrouping, heatRanks, heatText, tagHeader, TAG_RULES, judgeTags, suggestTagChanges, fandomShare, OFFTOPIC_SHARE, searchMatch,
    TPL_FORMAT, TPL_RULES, TPL_SEARCH_CUTS, parsePack, searchItems, expandPicks, suggestCombos, composeTemplate, packTags, upkeepTags, planUpkeep, itemsOnPost, itemsOnPosts, retagPost,
  };
})();
