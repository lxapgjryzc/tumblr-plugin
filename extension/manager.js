// Manager page of the Chrome extension. Talks to the Tumblr API directly with the browser's Tumblr session.
(() => {
  'use strict';

  const C = TTHCore;
  const TUMBLR = 'https://www.tumblr.com';
  const AUTO_SYNC_INTERVAL = 6 * 3600 * 1000;
  const $ = id => document.getElementById(id);
  const qsa = sel => [...document.querySelectorAll(sel)];

  let cache = C.emptyCache();
  const settings = {
    delay: 800, autoSync: true, hideAds: true, hideRecs: false, syncReblogs: true, lang: '', card: 180,
    // weak-tag rules (shared by the template edits and the cleanup) and the template options
    rules: { ...C.TPL_RULES }, useBase: true,
    // the cleanup's own rule: average notes on my posts
    clean: { notes: true, notesMax: 1 },
  };
  const save = () => chrome.storage.local.set({ cache });
  const saveSettings = () => chrome.storage.local.set({ settings });
  // Auto language follows the user's Tumblr interface language (from /dashboard's <html lang>), then the browser
  let tumblrLang = null;
  const { t, stateName, locale, lang } = C.makeI18n(() => settings.lang, () => [tumblrLang]);

  // ---------- API ----------
  // The web client's bearer token and CSRF token are read from /dashboard; cookies come from the browser session
  let auth = null;
  async function getAuth(force) {
    if (auth && !force) return auth;
    const res = await fetch(TUMBLR + '/dashboard', { credentials: 'include' });
    const html = await res.text();
    auth = C.parseAuth(html);
    tumblrLang = html.match(/<html[^>]*\blang="([^"]+)"/)?.[1] || tumblrLang;
    return auth;
  }
  async function request(path, { method, body }) {
    for (let retry = 0; ; retry++) {
      const { token, csrf } = await getAuth(retry > 0);
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (csrf) headers['X-CSRF'] = csrf;
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(TUMBLR + '/api' + path, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401 && retry === 0) continue; // token may have rotated
      if (!res.ok) { const e = new Error(json?.meta?.msg || res.statusText); e.status = res.status; e.body = json; throw e; }
      return json;
    }
  }
  const api = C.makeApi(request);

  let index = C.buildIndex(cache);
  const rebuildIndex = () => { index = C.buildIndex(cache); };

  // ---------- Small UI helpers ----------
  let toastTimer;
  function toast(msg) {
    const el = document.querySelector('.toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }
  function log(msg, isErr, box) {
    const line = document.createElement('div');
    if (isErr) line.className = 'err';
    line.textContent = msg;
    box.prepend(line);
  }

  // ---------- Suggestion dropdown ----------
  const dd = { el: document.querySelector('.dd'), items: [], hi: -1, input: null, onPick: null, open: false };
  function showDD(input, items, header, onPick) {
    Object.assign(dd, { items, hi: -1, input, onPick, open: true });
    dd.el.innerHTML = `<div class="h">${C.esc(header)}</div>` + items.map((it, i) =>
      `<div class="it" data-i="${i}"><span>#${C.esc(it.tag)}</span><small>${it.co ? t('ddCo') + ' ' : ''}${it.count || ''}</small></div>`).join('');
    dd.el.hidden = false;
    const r = input.getBoundingClientRect();
    const h = dd.el.offsetHeight;
    const above = r.bottom + h + 4 > innerHeight;
    dd.el.style.left = Math.max(4, Math.min(r.left, innerWidth - dd.el.offsetWidth - 4)) + 'px';
    dd.el.style.top = (above ? Math.max(4, r.top - h - 4) : r.bottom + 4) + 'px';
  }
  function hideDD() { dd.open = false; dd.el.hidden = true; dd.input = null; }
  function highlight(i) {
    dd.hi = i;
    dd.el.querySelectorAll('.it').forEach((n, j) => n.classList.toggle('on', j === i));
    dd.el.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
  }
  function pickDD(i) { const it = dd.items[i], fn = dd.onPick; hideDD(); if (it && fn) fn(it.tag); }
  dd.el.addEventListener('mousedown', e => { e.preventDefault(); const it = e.target.closest('.it'); if (it) pickDD(+it.dataset.i); });
  window.addEventListener('keydown', e => {
    if (!dd.open || e.target !== dd.input) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { stop(); highlight((dd.hi + 1) % dd.items.length); }
    else if (e.key === 'ArrowUp') { stop(); highlight((dd.hi - 1 + dd.items.length) % dd.items.length); }
    else if (e.key === 'Tab') { stop(); pickDD(dd.hi >= 0 ? dd.hi : 0); }
    else if (e.key === 'Enter' && dd.hi >= 0) { stop(); pickDD(dd.hi); }
    else if (e.key === 'Escape') { stop(); hideDD(); }
  }, true);

  function attachSuggest(input, { context = () => [], exclude = () => [], pool = null, onPick }) {
    const update = () => {
      const q = input.value.split(',').pop();
      const ctx = context();
      const items = C.suggest(index, q, ctx, exclude(), 10, pool ? pool() : null);
      if (!items.length) { if (dd.input === input) hideDD(); return; }
      showDD(input, items, t(!C.norm(q) ? (ctx.length ? 'ddRelated' : 'ddFrequent') : 'ddMine'), onPick);
    };
    input.addEventListener('input', update);
    input.addEventListener('focus', update);
    input.addEventListener('blur', () => setTimeout(() => { if (dd.input === input) hideDD(); }, 150));
    return update;
  }

  function makeTagInput(box, opts = {}) {
    const input = box.querySelector('input');
    let tags = [];
    const render = () => {
      box.querySelectorAll('.chip').forEach(n => n.remove());
      for (const tag of tags) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.title = C.heatText(t, cache.tagStats?.[C.key(tag)]);
        c.innerHTML = `#${C.esc(tag)}<b title="${C.esc(t('removeChip'))}">×</b>`;
        c.querySelector('b').onclick = () => { tags = tags.filter(x => x !== tag); render(); };
        box.insertBefore(c, input);
      }
    };
    const add = raw => {
      for (const part of String(raw).split(',')) {
        const tag = C.norm(part);
        if (tag && !tags.some(x => C.key(x) === C.key(tag))) tags.push(tag);
      }
      input.value = '';
      render();
      update();
    };
    const update = attachSuggest(input, { context: () => tags, exclude: () => tags, pool: opts.pool, onPick: add });
    input.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ',') && !(dd.open && dd.hi >= 0)) { e.preventDefault(); if (C.norm(input.value)) add(input.value); }
      else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); render(); }
    });
    input.addEventListener('paste', () => setTimeout(() => { if (input.value.includes(',')) add(input.value); }, 0));
    box.addEventListener('click', e => { if (e.target === box) input.focus(); });
    return {
      get tags() { if (C.norm(input.value)) add(input.value); return tags.slice(); },
    };
  }

  // ---------- Posts ----------
  let posts = [];        // loaded posts
  let visible = [];      // posts visible under the current filters
  const selected = new Set();
  let box = '';          // '' published, 'draft', 'queue'
  let loadCtx = { blog: null, tag: null, box: null, path: null, loading: null };
  let running = null;
  let lastIdx = null, dragging = false, dragValue = true;

  function blocksOf(p) { return [...(p.content || []), ...((p.trail || []).flatMap(tr => tr.content || []))]; }
  function thumbOf(p) {
    const blocks = blocksOf(p);
    const img = blocks.find(b => b.type === 'image' && b.media?.length);
    if (img) return img.media.reduce((a, b) => (Math.abs((b.width || 0) - 400) < Math.abs((a.width || 0) - 400) ? b : a)).url;
    const vid = blocks.find(b => (b.type === 'video' || b.type === 'link') && b.poster?.length);
    return vid?.poster?.[0]?.url || '';
  }
  // Prefer real text over Tumblr's generic summaries such as "[image]"
  function summaryOf(p) {
    const blocks = blocksOf(p);
    return blocks.find(b => b.type === 'text' && b.text?.trim())?.text
      || p.summary || `[${blocks[0]?.type || p.type || t('postFallback')}]`;
  }
  function toItem(p, blog) {
    const id = C.postId(p);
    return {
      key: blog + ':' + id, blog, id,
      state: p.state || 'published',
      tags: C.uniqTags(p.tags || []),
      label: C.readLabel(p),
      summary: summaryOf(p),
      thumb: thumbOf(p),
      images: C.postImages(p, 300, 800),
      url: C.pick(p, 'postUrl', 'post_url') || `${TUMBLR}/${C.enc(cache.blogList.find(b => b.uuid === blog)?.name || blog)}/${C.enc(id)}`,
      // a reblog of one of my own posts: kept in line with the original automatically, so not editable here
      copyOf: C.isCopyOf(p, myNames()) ? C.reblogSource(p) : null,
    };
  }
  const myNames = () => new Set(cache.blogList.map(b => b.name.toLowerCase()));
  const selectable = p => !p.copyOf;

  function renderBlogOptions() {
    const sel = $('blog'), cur = sel.value;
    sel.innerHTML = cache.blogList.map(b => `<option value="${C.esc(b.uuid)}">${C.esc(b.name)}${b.primary ? C.esc(t('primary')) : ''}</option>`).join('');
    if (cur && cache.blogList.some(b => b.uuid === cur)) sel.value = cur;
  }

  function applyFilter() {
    const q = $('search').value.trim().toLowerCase();
    const sf = $('stateFilter').value;
    visible = posts.filter(p => {
      if (sf === 'label' && !p.label.has) return false;
      if (sf === 'nolabel' && p.label.has) return false;
      if ((sf === 'published' || sf === 'private') && p.state !== sf) return false;
      if (q && !p.summary.toLowerCase().includes(q) && !p.tags.some(tg => tg.toLowerCase().includes(q))) return false;
      return true;
    });
    lastIdx = null;
    renderList();
  }

  function cardHtml(p, i) {
    const lab = p.label.has ? `<span class="st" title="${C.esc(p.label.categories.map(c => t('cat_' + c)).join(', '))}">🔞</span>` : '';
    // Multi-image posts get a mosaic of the first four images and an image count
    const thumb = p.images.length > 1
      ? `<div class="media"><div class="mosaic n${Math.min(p.images.length, 4)}">${p.images.slice(0, 4).map(i => `<img loading="lazy" src="${C.esc(i.small)}" alt="">`).join('')}</div>
         <span class="imgcount" title="${C.esc(t('imagesN', p.images.length))}">🖼 ${p.images.length}</span></div>`
      : p.thumb
        ? `<img class="thumb" loading="lazy" src="${C.esc(p.thumb)}" alt="">`
        : `<div class="text-thumb">${C.esc(p.summary)}</div>`;
    const copy = p.copyOf ? `<span class="st sync" title="${C.esc(t('copyTitle', p.copyOf))}">${C.esc(t('copyBadge'))}</span>` : '';
    return `<div class="post${selected.has(p.key) ? ' sel' : ''}${p.copyOf ? ' copy' : ''}" data-i="${i}">
      ${thumb}<span class="ck"></span>
      <div class="badges"><span class="st ${C.esc(p.state)}">${C.esc(stateName(p.state))}</span>${lab}${copy}<a href="${C.esc(p.url)}" target="_blank" rel="noopener" title="${C.esc(t('openPost'))}">↗</a></div>
      <div class="meta"><div class="sum">${C.esc(p.summary)}</div>
        <div class="tg">${p.tags.map(tg => '#' + C.esc(tg)).join(' ') || `<span class="muted">${C.esc(t('noTags'))}</span>`}</div></div>
    </div>`;
  }

  function renderList() {
    $('list').innerHTML = visible.length ? visible.map(cardHtml).join('')
      : `<div class="empty muted">${C.esc(t(posts.length ? 'noMatchPosts' : 'pickBlogHint'))}</div>`;
    renderSelInfo();
  }

  function renderCard(p) {
    const i = visible.indexOf(p);
    const old = $('list').querySelector(`.post[data-i="${i}"]`);
    if (i < 0 || !old) return;
    old.insertAdjacentHTML('afterend', cardHtml(p, i));
    old.remove();
  }

  function renderSelInfo() {
    $('list').querySelectorAll('.post').forEach(n => n.classList.toggle('sel', selected.has(visible[+n.dataset.i]?.key)));
    const hiddenSel = [...selected].filter(k => !visible.some(p => p.key === k)).length;
    $('selInfo').textContent = t('selInfo', selected.size, hiddenSel);
    $('loadInfo').textContent = posts.length ? t('loadInfo', posts.length, !loadCtx.path) : '';
    renderSelTags();
  }

  // ----- Tags on the selected posts: click marks for removal, ⊕ fills in on the rest -----
  const tagMarks = new Set();
  function selectedTagStats() {
    const m = new Map();
    let n = 0;
    for (const p of posts) {
      if (!selected.has(p.key)) continue;
      n++;
      for (const tag of p.tags) { const k = C.key(tag), s = m.get(k); if (s) s.count++; else m.set(k, { tag, count: 1 }); }
    }
    return { n, tags: [...m.entries()].sort((a, b) => b[1].count - a[1].count || a[1].tag.localeCompare(b[1].tag)) };
  }
  function renderSelTags() {
    const { n, tags } = selectedTagStats();
    for (const k of [...tagMarks]) if (!tags.some(([x]) => x === k)) tagMarks.delete(k);
    $('selTags').innerHTML = tags.length
      ? tags.map(([k, s]) => `<span class="stag${tagMarks.has(k) ? ' mark' : ''}" data-k="${C.esc(k)}" title="${C.esc(C.heatText(t, cache.tagStats?.[k]))}">#${C.esc(s.tag)}<small>${s.count}/${n}</small>${
        s.count < n ? `<span class="fill" data-fill="1" title="${C.esc(t('addToAll'))}">⊕</span>` : ''}</span>`).join('')
      : `<span class="muted">${C.esc(t('selTagsNone'))}</span>`;
    $('removeMarkedBtn').hidden = !tags.length;
    $('removeMarkedBtn').textContent = t('removeMarked', tagMarks.size);
    renderTplCard();
  }
  $('selTags').addEventListener('click', e => {
    const chip = e.target.closest('.stag');
    if (!chip || running) return;
    const k = chip.dataset.k;
    if (e.target.closest('[data-fill]')) {
      const tag = selectedTagStats().tags.find(([x]) => x === k)?.[1].tag;
      if (tag) runBatch(t('actTagsAdd', '#' + tag), C.mutations.addTags([tag]));
      return;
    }
    if (tagMarks.has(k)) tagMarks.delete(k); else tagMarks.add(k);
    renderSelTags();
  });

  // ----- Multi-select: click, drag, Shift+click, Ctrl+A -----
  function setSel(i, v) { const p = visible[i]; if (p && selectable(p)) { if (v) selected.add(p.key); else selected.delete(p.key); } }
  const list = $('list');
  list.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('a')) return;
    const card = e.target.closest('.post');
    if (!card) return;
    e.preventDefault();
    list.focus();
    const i = +card.dataset.i;
    if (e.shiftKey && lastIdx !== null) {
      const [a, b] = lastIdx < i ? [lastIdx, i] : [i, lastIdx];
      for (let j = a; j <= b; j++) setSel(j, true);
    } else {
      dragValue = !selected.has(visible[i].key);
      setSel(i, dragValue);
      dragging = true;
    }
    lastIdx = i;
    renderSelInfo();
  });
  list.addEventListener('mouseover', e => {
    if (!dragging) return;
    const card = e.target.closest('.post');
    if (card) { setSel(+card.dataset.i, dragValue); lastIdx = +card.dataset.i; renderSelInfo(); }
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  list.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); visible.filter(selectable).forEach(p => selected.add(p.key)); renderSelInfo(); }
  });

  async function loadPosts(mode) {
    if (loadCtx.loading) return;
    const blog = $('blog').value;
    const tag = C.norm($('tagFilter').value);
    if (!blog) return toast(t('needBlog'));
    if (mode === 'reset' || loadCtx.blog !== blog || loadCtx.tag !== tag || loadCtx.box !== box) {
      posts = [];
      selected.clear();
      loadCtx = { blog, tag, box, path: C.basePosts(blog, { tag }, box), loading: null };
    }
    if (!loadCtx.path) return toast(t('allLoaded'));
    const ctl = loadCtx.loading = { aborted: false };
    $('loadInfo').textContent = t('loading');
    document.querySelector('[data-act="stopLoad"]').hidden = false;
    const target = mode === 'all' ? Infinity : posts.length + 100;
    try {
      while (loadCtx.path && posts.length < target && !ctl.aborted) {
        const r = await api(loadCtx.path);
        const got = r?.posts || [];
        const known = new Set(posts.map(p => p.key));
        for (const p of got) {
          if (!C.isPost(p)) continue;
          const it = toItem(p, blog);
          if (!known.has(it.key)) posts.push(it);
        }
        loadCtx.path = got.length ? C.nextPath(r, blog, { tag }, posts.length, got.length >= 20, box) : null;
        $('loadInfo').textContent = t('loading', posts.length);
        await C.sleep(200);
      }
    } catch (e) {
      toast(t('loadFailed', C.errMsg(e)));
    } finally {
      loadCtx.loading = null;
      document.querySelector('[data-act="stopLoad"]').hidden = true;
      applyFilter();
    }
  }

  // ----- Running bulk edits -----
  // opts.targets: explicit [{key, blog, id}] instead of the selected posts
  // opts.ui: id prefix of the progress/log elements (e.g. 'clean' → cleanProg, cleanLog)
  async function runBatch(title, mutate, opts = {}) {
    if (running) return;
    // reblogs of my own posts are never edited directly: they follow their original
    const copies = C.copyKeys(cache);
    const targets = (opts.targets || posts.filter(p => selected.has(p.key))).filter(p => !p.copyOf && !copies.has(p.key));
    if (!targets.length) return toast(t(opts.targets ? 'cleanNoPosts' : 'needSelect'));
    if (!confirm(t('confirmRun', title, targets.length))) return;
    const R = name => $(opts.ui ? opts.ui + name[0].toUpperCase() + name.slice(1) : name);
    const logBox = R('log');
    const ctl = running = { aborted: false };
    R('prog').hidden = false;
    R('runRow').hidden = false;
    qsa('.actions button:not(.stop)').forEach(b => { b.disabled = true; });
    let ok = 0, skip = 0, fail = 0;
    for (let i = 0; i < targets.length && !ctl.aborted; i++) {
      const p = targets[i];
      R('runInfo').textContent = t('progress', title, i + 1, targets.length);
      try {
        const r = await C.editPost(api, t, p.blog, p.id, mutate, opts.verifyLabel);
        if (r.skipped) { skip++; if (!r.unchanged) log(t('logSkip', p.id, r.reason), false, logBox); }
        else {
          ok++;
          const fresh = { state: r.state, tags: C.uniqTags(r.tags), label: r.label };
          Object.assign(p, fresh);
          const item = posts.find(x => x.key === p.key);
          if (item && item !== p) Object.assign(item, fresh);
          const rec = cache.blogs[p.blog]?.posts?.[p.id];
          if (rec) { rec[0] = fresh.tags; rec[2] = fresh.state; rec[5] = fresh.label.has; }
          if (item) renderCard(item);
          // the same tags, visibility and label for its reblogs (or original) on my other blogs
          if (settings.syncReblogs) {
            const n = await C.syncCopies(api, t, cache, p.blog, p.id, r, (k, rr) => {
              const copy = posts.find(x => x.key === k);
              if (copy) { Object.assign(copy, { state: rr.state, tags: C.uniqTags(rr.tags), label: rr.label }); renderCard(copy); }
            });
            if (n) log(t('logSynced', p.id, n), false, logBox);
          }
        }
      } catch (e) {
        fail++;
        log(t('logFail', p.id, C.errMsg(e)), true, logBox);
      }
      R('prog').firstElementChild.style.width = ((i + 1) / targets.length * 100) + '%';
      await C.sleep(settings.delay);
    }
    await save();
    rebuildIndex();
    renderLibrary();
    log(t('logDone', title, ctl.aborted, ok, skip, fail), false, logBox);
    running = null;
    R('runRow').hidden = true;
    qsa('.actions button').forEach(b => { b.disabled = false; });
    renderSelInfo();
    opts.onDone?.();
    setTimeout(() => { R('prog').hidden = true; R('prog').firstElementChild.style.width = '0'; }, 1500);
  }

  $('cats').innerHTML = C.LABEL_CATEGORIES.map(v => `<label><input type="checkbox" value="${v}"><span data-i18n="cat_${v}"></span></label>`).join('');
  const selectedCategories = () => qsa('#cats input:checked').map(c => c.value);

  // Adding only: removal is done by marking the tags listed above it
  const batchTags = makeTagInput($('batchTags'));
  attachSuggest($('tagFilter'), { onPick: tag => { $('tagFilter').value = tag; } });

  // ---------- Cleanup ----------
  let cleanResults = [], cleanScanned = false, scanCtl = null;
  const cleanSel = new Set();

  function readCleanRules() {
    settings.clean = { notes: $('ruleNotesOn').checked, notesMax: Math.max(0, +$('ruleNotes').value || 0) };
    saveSettings();
    return settings.clean;
  }
  const renderCleanRules = () => {
    const r = settings.rules;
    $('cleanRules').textContent = t('cleanRules', r.cold && r.coldPct, r.match && r.matchMin);
  };

  // The weak-tag rules (settings.rules, as in the template flags) over all my tags, plus the notes rule.
  // Tags a template pack knows (its items' tags, old spellings and base tags) are the pack's business: the
  // Packs page and the pack review look after them, so they are never listed here, and the cleanup can't
  // take off a tag the templates would put back. For the other tags, "another fandom" is judged against the
  // packs whose base tags are on the same posts.
  const REASON_ORDER = ['offtopic', 'dead', 'fuzzy', 'cold'];
  async function scanCleanup() {
    if (scanCtl) return;
    if (!index.tags.size) return toast(t('cleanNeedSync'));
    const c = readCleanRules();
    const packs = parsedPacks();
    const owned = C.packGrouping(packs).groups;
    const stats = new Map();
    let missingNotes = 0;
    const copies = C.copyKeys(cache); // reblogs of my own posts follow their original
    for (const [uuid, b] of Object.entries(cache.blogs)) {
      for (const [id, rec] of Object.entries(b.posts || {})) {
        if (copies.has(uuid + ':' + id)) continue;
        const notes = rec[3] ?? null;
        if (notes === null) missingNotes++;
        const tags = C.uniqTags(rec[0]);
        const have = new Set(tags.map(C.key));
        const fandoms = packs.filter(pk => pk.base.some(tg => have.has(C.key(tg))));
        for (const tag of tags) {
          const k = C.key(tag);
          if (owned.has(k)) continue;
          let s = stats.get(k);
          if (!s) stats.set(k, s = { tag, uses: 0, notes: 0, noted: 0, packs: new Set() });
          s.uses++;
          fandoms.forEach(pk => s.packs.add(pk));
          if (notes !== null) { s.notes += notes; s.noted++; }
        }
      }
    }
    $('cleanWarn').hidden = !(c.notes && missingNotes);
    const ctl = scanCtl = { aborted: false };
    renderCleanState();
    const failed = await C.ensureTagStats(api, cache, [...stats.keys()], { ctl, save, onProgress: (i, n) => { $('cleanStatus').textContent = t('scanning', i, n); } });
    const weak = C.judgeTags([...stats.values()].map(s => s.tag), cache.tagStats, settings.rules, {
      fandom: tg => [...stats.get(C.key(tg)).packs].flatMap(pk => pk.base),
    });
    cleanResults = [];
    for (const [k, s] of stats) {
      const site = cache.tagStats?.[k];
      const avg = s.noted ? s.notes / s.noted : null;
      const v = weak.get(k) || (c.notes && avg !== null && avg < c.notesMax ? { reason: 'notes' } : null);
      if (v) cleanResults.push({ key: k, tag: s.tag, uses: s.uses, avg, v, followers: site?.followers, tagNotes: site?.notes });
    }
    // another fandom's first, then dead, fuzzy, coldest; the notes rule last
    const ord = r => (REASON_ORDER.indexOf(r.v.reason) + 1 || REASON_ORDER.length + 1);
    cleanResults.sort((a, b) => ord(a) - ord(b) || (b.v.rank ?? 0) - (a.v.rank ?? 0) || (a.avg ?? Infinity) - (b.avg ?? Infinity));
    for (const k of [...cleanSel]) if (!cleanResults.some(r => r.key === k)) cleanSel.delete(k);
    cleanScanned = true;
    scanCtl = null;
    $('cleanStatus').textContent = t('scanDone', cleanResults.length, failed);
    renderCleanState();
    renderClean();
  }

  function renderCleanState() {
    document.querySelector('[data-act="cleanStop"]').hidden = !scanCtl;
    document.querySelector('[data-act="cleanScan"]').disabled = !!scanCtl;
  }
  function cleanTargets() {
    const out = [];
    const copies = C.copyKeys(cache);
    for (const [uuid, b] of Object.entries(cache.blogs)) {
      for (const [id, rec] of Object.entries(b.posts || {})) {
        if (copies.has(uuid + ':' + id)) continue;
        if (rec[0].some(tag => cleanSel.has(C.key(tag)))) out.push({ key: uuid + ':' + id, blog: uuid, id });
      }
    }
    return out;
  }
  function renderCleanSel() {
    $('cleanSelInfo').textContent = cleanResults.length
      ? t('cleanSelInfo', cleanSel.size, cleanResults.length, cleanSel.size ? cleanTargets().length : 0) : '';
  }
  function renderClean() {
    $('cleanList').innerHTML = cleanResults.length
      ? cleanResults.map(r => {
        const v = r.v;
        const why = v.reason === 'offtopic' ? t('why_offtopic', Math.round(v.share * 100)) : v.reason === 'fuzzy' ? t('why_fuzzy', v.match)
          : v.reason === 'cold' ? t('why_cold', v.rank, v.of) : v.reason === 'dead' ? t('why_dead') : '';
        const info = [
          why,
          r.followers != null ? t('followersN', r.followers) : '',
          r.tagNotes != null ? t('tagNotes', r.tagNotes) : '',
          r.avg != null ? t('avgNotes', C.fmtNum(r.avg)) : '',
          t('usedTimes', r.uses),
        ].filter(Boolean).join(' · ');
        return `<label class="tr${v.reason === 'offtopic' ? ' bad' : ''}"><input type="checkbox" data-k="${C.esc(r.key)}"${cleanSel.has(r.key) ? ' checked' : ''}>
          <span class="n">#${C.esc(r.tag)}</span><span class="muted">${C.esc(info)}</span></label>`;
      }).join('')
      : `<div class="tr muted">${C.esc(t(cleanScanned ? 'cleanEmpty' : 'cleanHint'))}</div>`;
    renderCleanSel();
  }
  $('cleanList').addEventListener('change', e => {
    const k = e.target.dataset?.k;
    if (!k) return;
    if (e.target.checked) cleanSel.add(k); else cleanSel.delete(k);
    renderCleanSel();
  });

  // ---------- Tag library ----------
  let libLimit = 300;
  let syncing = null;

  async function syncAll(full) {
    if (syncing) return;
    syncing = { aborted: false };
    renderSyncState();
    try {
      await C.syncAll(api, cache, full, syncing, msg => { $('syncStatus').textContent = msg; }, t, save);
      rebuildIndex();
      $('syncStatus').textContent = syncing.aborted ? t('syncStopped') : t('syncDone', index.tags.size);
    } catch (e) {
      $('syncStatus').textContent = t('syncFailed', C.errMsg(e));
    } finally {
      syncing = null;
      renderSyncState();
      renderLibrary();
      renderBlogOptions();
    }
  }
  function renderSyncState() {
    document.querySelector('[data-act="syncStop"]').hidden = !syncing;
    document.querySelector('[data-act="syncInc"]').disabled = !!syncing;
    document.querySelector('[data-act="syncFull"]').disabled = !!syncing;
  }

  function renderLibrary() {
    const stats = Object.values(cache.blogs).map(b =>
      t('blogStat', b.name, Object.keys(b.posts || {}).length, b.syncedAt && new Date(b.syncedAt).toLocaleString(locale())));
    $('blogStats').textContent = stats.length ? stats.join(t('statSep')) : t('neverSynced');
    const q = C.key($('libSearch').value);
    const showHidden = $('showHidden').checked;
    const all = [...index.tags.entries()]
      .filter(([k]) => (showHidden || !index.hidden.has(k)) && (!q || C.matchScore(k, q)))
      .sort((a, b) => (q ? C.matchScore(b[0], q) - C.matchScore(a[0], q) : 0) || b[1].count - a[1].count);
    $('lib').innerHTML = all.slice(0, libLimit).map(([k, info]) => `
      <div class="tr${index.hidden.has(k) ? ' hid' : ''}" data-k="${C.esc(k)}">
        <span class="n" title="${C.esc([...info.blogs].join(', '))}">#${C.esc(info.tag)}</span>
        <span class="muted">${info.count}${info.custom ? C.esc(t('manual')) : ''}${info.blogs.size > 1 ? C.esc(t('nBlogs', info.blogs.size)) : ''}</span>
        <button data-lib="filter" title="${C.esc(t('filterTitle'))}">${C.esc(t('filterBtn'))}</button>
        <button data-lib="toggle">${C.esc(t(index.hidden.has(k) ? 'restore' : 'hide'))}</button>
      </div>`).join('')
      + (all.length > libLimit ? `<div class="tr"><button data-lib="more">${C.esc(t('showMore', all.length))}</button></div>` : '')
      + (!all.length ? `<div class="tr muted">${C.esc(t('noTagsLib'))}</div>` : '');
  }
  $('lib').addEventListener('click', e => {
    const btn = e.target.closest('[data-lib]');
    if (!btn) return;
    if (btn.dataset.lib === 'more') { libLimit += 300; return renderLibrary(); }
    const k = btn.closest('.tr').dataset.k;
    const info = index.tags.get(k);
    if (btn.dataset.lib === 'toggle') {
      if (index.hidden.has(k)) cache.hidden = cache.hidden.filter(x => x !== k);
      else cache.hidden.push(k);
      if (info?.custom && !index.hidden.has(k) && !info.count) cache.custom = cache.custom.filter(x => C.key(x) !== k);
      save(); rebuildIndex(); renderLibrary();
    } else if (btn.dataset.lib === 'filter') {
      $('tagFilter').value = info.tag;
      const blog = cache.blogList.find(b => info.blogs.has(b.name));
      if (blog) $('blog').value = blog.uuid;
      showView('posts');
      loadPosts('reset');
    }
  });
  $('libSearch').addEventListener('input', C.debounce(() => { libLimit = 300; renderLibrary(); }, 150));
  $('showHidden').addEventListener('change', renderLibrary);

  // ---------- Template packs and upkeep ----------
  // packs = [{ raw, source }] in chrome.storage.local, shared with the content script's template panel; source is the URL or ''
  let packs = [];
  let parsedCache = null;
  const parsedPacks = () => (parsedCache ||= packs.map(p => { try { return C.parsePack(p.raw); } catch { return null; } }).filter(Boolean));
  const savePacks = () => { parsedCache = null; return chrome.storage.local.set({ packs }); };
  // Tag sorting uses the installed packs to tell whose tag is whose
  const fairOpts = () => C.packGrouping(parsedPacks());

  // ----- Edit the selected posts by template: who is on them, tick or untick, apply to all -----
  // tplEdit.state: item id -> 'on' (on every post after applying), 'off' (taken off every post), 'keep'
  // (on some posts, left as is). Items not on any post appear once added from the search box.
  let tplEdit = { key: '', pack: '', counts: new Map(), total: 0, state: new Map() };
  const tplPack = () => parsedPacks().find(pk => pk.id === tplEdit.pack) || null;
  const selectedPosts = () => posts.filter(p => selected.has(p.key));
  function resetTplEdit() {
    const sel = selectedPosts();
    const packs = parsedPacks();
    // default pack: the one that recognises the most on the selection
    if (!packs.some(pk => pk.id === tplEdit.pack)) tplEdit.pack = '';
    if (!tplEdit.pack && packs.length) {
      const score = pk => [...C.itemsOnPosts(sel.map(p => p.tags), pk).values()].reduce((a, b) => a + b, 0);
      tplEdit.pack = packs.slice().sort((a, b) => score(b) - score(a))[0].id;
    }
    const pk = tplPack();
    const counts = pk ? C.itemsOnPosts(sel.map(p => p.tags), pk) : new Map();
    tplEdit = { ...tplEdit, key: sel.map(p => p.key).join() + '|' + tplEdit.pack, counts, total: sel.length,
      state: new Map([...counts].map(([id, n]) => [id, n === sel.length ? 'on' : 'keep'])) };
  }
  function tplEditPlan() {
    const on = [...tplEdit.state].filter(([, s]) => s === 'on').map(([id]) => id);
    return {
      add: on.filter(id => tplEdit.counts.get(id) !== tplEdit.total),
      drop: [...tplEdit.state].filter(([, s]) => s === 'off').map(([id]) => id),
    };
  }
  // the same rules and options as the template panel on tumblr.com, from Settings
  const tplOpts = (add, drop) => ({ add, drop, stats: cache.tagStats || {}, rules: settings.rules, useBase: settings.useBase, order: fairOpts() });
  function renderTplCard() {
    const packs = parsedPacks();
    $('tplCard').hidden = !packs.length;
    if (!packs.length) return;
    const sel = selectedPosts();
    if (sel.map(p => p.key).join() + '|' + tplEdit.pack !== tplEdit.key) resetTplEdit();
    $('tplPack').innerHTML = packs.map(pk => `<option value="${C.esc(pk.id)}"${pk.id === tplEdit.pack ? ' selected' : ''}>${C.esc(pk.name)}</option>`).join('');
    const pk = tplPack();
    const n = tplEdit.total;
    $('tplItems').innerHTML = !sel.length ? `<span class="muted">${C.esc(t('needSelect'))}</span>`
      : [...tplEdit.state].map(([id, s]) => {
        const it = pk.items.get(id);
        const c = tplEdit.counts.get(id) || 0;
        return `<span class="stag ${s === 'keep' ? 'part' : s}" data-item="${C.esc(id)}" title="${C.esc(c && c < n ? t('tplPart', c, n) : it.tags.join(', '))}">${C.esc(it.name)}${c ? `<small>${c}/${n}</small>` : ''}</span>`;
      }).join('') || `<span class="muted">${C.esc(t('tplNothingOn'))}</span>`;
    const q = $('tplAdd').value.trim();
    $('tplFound').innerHTML = q && pk ? C.searchItems(pk, q).filter(it => it.kind !== 'preset' && !tplEdit.state.has(it.id)).slice(0, 8)
      .map(it => `<span class="stag found" data-add="${C.esc(it.id)}">+ ${C.esc(it.name)}</span>`).join('') : '';
    const { add, drop } = tplEditPlan();
    const names = ids => ids.map(id => pk.items.get(id)?.name || id).join('、');
    const changed = add.length || drop.length ? sel.filter(p => C.retagPost(p.tags, pk, tplOpts(add, drop)).join('\u0001') !== p.tags.join('\u0001')).length : 0;
    $('tplPlan').innerHTML = (add.length ? `<div class="plan-add">+ ${C.esc(names(add))}</div>` : '') + (drop.length ? `<div class="plan-drop">− ${C.esc(names(drop))}</div>` : '')
      + (add.length || drop.length ? C.esc(t('tplWillChange', changed, n)) : sel.length ? C.esc(t('tplNoChange')) : '');
    $('tplApplyBtn').textContent = t('tplApplyTo', n);
    $('tplApplyBtn').disabled = !changed;
  }
  $('tplItems').addEventListener('click', e => {
    const id = e.target.closest('[data-item]')?.dataset.item;
    if (!id || running) return;
    const pk = tplPack();
    const s = tplEdit.state.get(id), c = tplEdit.counts.get(id) || 0;
    // on all: on <-> off; on some: keep -> on -> off -> keep; added from search: on -> gone
    const next = !c ? null : c === tplEdit.total ? (s === 'on' ? 'off' : 'on') : ({ keep: 'on', on: 'off', off: 'keep' })[s];
    if (next) tplEdit.state.set(id, next); else tplEdit.state.delete(id);
    // taking someone off also takes off the relations they are part of
    if (next === 'off') for (const [rid] of tplEdit.state) { const r = pk.items.get(rid); if (r?.rel && r.with.includes(id)) tplEdit.state.set(rid, 'off'); }
    renderTplCard();
  });
  $('tplFound').addEventListener('click', e => {
    const id = e.target.closest('[data-add]')?.dataset.add;
    if (!id) return;
    tplEdit.state.set(id, 'on');
    $('tplAdd').value = '';
    renderTplCard();
  });
  $('tplAdd').addEventListener('input', () => renderTplCard());
  $('tplPack').addEventListener('change', e => { tplEdit.pack = e.target.value; tplEdit.key = ''; renderTplCard(); });

  async function installPack(text, source) {
    try {
      const raw = typeof text === 'string' ? JSON.parse(text) : text;
      const pk = C.parsePack(raw);
      packs = [...packs.filter(p => p.raw.id !== raw.id), { raw, source: source || '' }];
      await savePacks();
      toast(t('tplInstalled', pk.name, pk.items.size));
      renderPacks();
    } catch (e) {
      toast(t('tplInstallFailed', C.errMsg(e)));
    }
  }
  async function fetchPack(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.text();
  }
  function renderPacks() {
    $('packList').innerHTML = packs.length ? packs.map(p => {
      let info = '';
      try { const pk = C.parsePack(p.raw); info = t('tplPackInfo', pk.items.size, C.packTags(pk).length, pk.version); } catch (e) { info = C.errMsg(e); }
      return `<div class="tr" data-id="${C.esc(p.raw.id)}"><span class="n">${C.esc(p.raw.name || p.raw.id)}</span><span class="muted">${C.esc(info)}</span>
        ${p.source ? `<button data-pack="update">${C.esc(t('tplUpdate'))}</button>` : ''}<button data-pack="remove">${C.esc(t('tplRemove'))}</button></div>`;
    }).join('') : `<div class="tr muted">${C.esc(t('packsNone'))}</div>`;
  }
  $('packList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-pack]');
    if (!btn) return;
    const entry = packs.find(p => p.raw.id === btn.closest('.tr').dataset.id);
    if (!entry) return;
    if (btn.dataset.pack === 'remove') {
      if (!confirm(t('tplConfirmRemove', entry.raw.name || entry.raw.id))) return;
      packs = packs.filter(p => p !== entry);
      await savePacks();
      renderPacks();
    } else {
      try { await installPack(await fetchPack(entry.source), entry.source); } catch (err) { toast(t('tplInstallFailed', C.errMsg(err))); }
    }
  });
  $('packFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) installPack(await f.text(), '');
  });

  // Upkeep: find retired spellings on synced posts and replace or remove them, rule by rule
  let upk = { posts: [], rules: [] };
  const upkSel = new Set();
  function scanUpkeep() {
    if (!parsedPacks().length) return toast(t('upkNeedPack'));
    if (!Object.keys(cache.blogs).length) return toast(t('cleanNeedSync'));
    const copies = C.copyKeys(cache); // reblogs of my own posts follow their original
    const records = Object.entries(cache.blogs).flatMap(([uuid, b]) =>
      Object.entries(b.posts || {}).map(([id, rec]) => ({ key: uuid + ':' + id, blog: uuid, id, tags: rec[0] }))).filter(r => !copies.has(r.key));
    upk = C.planUpkeep(records, parsedPacks());
    upkSel.clear();
    upk.rules.forEach(r => upkSel.add(r.rule));
    $('upkStatus').textContent = upk.rules.length ? t('upkFound', upk.rules.length, upk.posts.length) : t('upkNone');
    renderUpkeep();
  }
  const upkTargets = () => upk.posts.filter(p => p.changes.some(c => upkSel.has(c.rule)));
  function renderUpkeep() {
    const blogName = uuid => cache.blogList.find(b => b.uuid === uuid)?.name || cache.blogs[uuid]?.name || uuid;
    $('upkList').innerHTML = upk.rules.map(r => {
      const examples = upk.posts.filter(p => p.changes.some(c => c.rule === r.rule)).slice(0, 3)
        .map(p => `<a href="${TUMBLR}/${C.enc(blogName(p.blog))}/${C.enc(p.id)}" target="_blank" rel="noopener">${C.esc(blogName(p.blog))}/${C.esc(p.id)}</a>`).join('');
      const what = r.type === 'add'
        ? `<span class="to">+ #${C.esc(r.to)}</span> <span class="muted">${C.esc(t('upkAdd'))}</span>`
        : r.to
        ? `<span class="from">#${C.esc(r.from)}</span> → <span class="to">#${C.esc(r.to)}</span>`
        : `<span class="from">#${C.esc(r.from)}</span> <span class="muted">${C.esc(t(r.why === 'dropped' ? 'upkRemoveDropped' : 'upkRemoveHas'))}</span>`;
      return `<label class="tr"><input type="checkbox" data-rule="${C.esc(r.rule)}"${upkSel.has(r.rule) ? ' checked' : ''}>
        <span class="n">${what}</span><span class="muted">${C.esc(r.item)} · ${C.esc(r.pack)} · ${C.esc(t('upkPosts', r.posts))}</span>
        <span class="ex">${examples}</span></label>`;
    }).join('') || `<div class="tr muted">${C.esc(t('upkHint'))}</div>`;
    $('upkSelInfo').textContent = upk.rules.length ? t('upkSelInfo', upkSel.size, upkTargets().length) : '';
  }
  $('upkList').addEventListener('change', e => {
    const r = e.target.dataset?.rule;
    if (!r) return;
    if (e.target.checked) upkSel.add(r); else upkSel.delete(r);
    renderUpkeep();
  });

  // ---------- Reblogs between my blogs ----------
  // Reblogs of my own posts follow their original (runBatch syncs them after each edit). Here: find reblogs
  // that drifted from their original and fix them, and reblog side-blog posts my main blog hasn't reblogged.
  const mainBlog = () => cache.blogList.find(b => b.primary) || null;
  const blogName = uuid => cache.blogList.find(b => b.uuid === uuid)?.name || cache.blogs[uuid]?.name || uuid;
  // Reblog one of my posts onto my main blog, with the same tags and community label
  async function reblogToMain(blog, id, state) {
    const main = mainBlog();
    const { id: newId, post: p, label } = await C.reblogPost(api, main.uuid, blog, id, state);
    if (newId && cache.blogs[main.uuid]) {
      cache.blogs[main.uuid].posts[newId] = [C.uniqTags(p.tags || []), Math.floor(Date.now() / 1000), state, 0, `${blogName(blog)}/${id}`, label.has];
    }
    return newId;
  }
  // What the background pass did (extension/background.js writes storage key autoLog)
  async function renderAutoLog() {
    const { autoLog = [] } = await chrome.storage.local.get(['autoLog']);
    $('rbAuto').innerHTML = autoLog.length ? autoLog.slice(0, 10).map(e => `<div${e.error ? ' class="err"' : ''}>${C.esc(new Date(e.at).toLocaleString(locale()))} · ${C.esc(
      e.error ? t('autoError', e.error) : e.done.map(d => t(d.type === 'reblog' ? 'autoReblogged' : 'autoFixed', `${d.blog}/${d.id}`, d.to)).join(t('listSep')))}</div>`).join('')
      : `<div>${C.esc(t('autoNone'))}</div>`;
  }

  let rb = { diffs: [], missing: [] }, rbScanned = false;
  function scanReblogs() {
    if (!Object.keys(cache.blogs).length) return toast(t('cleanNeedSync'));
    const main = mainBlog();
    rb = { diffs: C.reblogDiffs(cache), missing: main ? C.notOnMain(cache, main.uuid) : [] };
    rbScanned = true;
    $('rbStatus').textContent = t('rbFound', rb.diffs.length, rb.missing.length);
    renderReblogs();
  }
  function renderReblogs() {
    const link = (blog, id) => `<a href="${TUMBLR}/${C.enc(blogName(blog))}/${C.enc(id)}" target="_blank" rel="noopener">${C.esc(blogName(blog))}/${C.esc(id)}</a>`;
    const main = mainBlog();
    $('rbList').innerHTML = [
      ...rb.diffs.map(d => `<div class="tr"><span class="n">${link(d.copy.blog, d.copy.id)} ← ${link(d.root.blog, d.root.id)}</span>
        <span class="muted">${C.esc(d.diffs.map(x => t('rbDiff_' + x)).join(t('listSep')))}</span></div>`),
      ...rb.missing.map(m => `<div class="tr"><span class="n">${link(m.blog, m.id)}</span><span class="muted">${C.esc(t('rbMissing', main?.name || ''))}</span></div>`),
    ].join('') || `<div class="tr muted">${C.esc(t(rbScanned ? 'rbNone' : 'rbHint'))}</div>`;
  }
  // A simple progress loop for the reblog section
  async function rbRun(title, items, fn) {
    if (running || !items.length) return;
    const ctl = running = { aborted: false };
    const bar = $('rbProg');
    bar.hidden = false;
    let ok = 0, fail = 0;
    for (let i = 0; i < items.length && !ctl.aborted; i++) {
      try { await fn(items[i]); ok++; } catch (e) { fail++; log(t('logFail', items[i].id, C.errMsg(e)), true, $('rbLog')); }
      bar.firstElementChild.style.width = ((i + 1) / items.length * 100) + '%';
      await C.sleep(settings.delay);
    }
    running = null;
    await save();
    rebuildIndex();
    log(t('logDone', title, ctl.aborted, ok, 0, fail), false, $('rbLog'));
    setTimeout(() => { bar.hidden = true; bar.firstElementChild.style.width = '0'; }, 1500);
    scanReblogs();
  }

  // ---------- Actions ----------
  const actions = {
    rbScan: scanReblogs,
    // give each drifted reblog its original's current tags, visibility and label (read live)
    rbFix: () => {
      const roots = [...new Map(rb.diffs.map(d => [d.root.key, d.root])).values()];
      if (!roots.length) return toast(t('rbNone'));
      if (!confirm(t('confirmRun', t('rbFix'), rb.diffs.length))) return;
      rbRun(t('rbFix'), roots, async root => {
        const p = await C.getPost(api, root.blog, root.id);
        await C.syncCopies(api, t, cache, root.blog, root.id, { tags: p.tags || [], state: p.state, label: C.readLabel(p) });
      });
    },
    rbReblog: () => {
      const main = mainBlog();
      if (!main || !rb.missing.length) return toast(t('rbNone'));
      const when = $('rbWhen').value;
      if (!confirm(t('rbConfirmReblog', rb.missing.length, main.name, t(when === 'queue' ? 'rbQueue' : 'rbNow')))) return;
      rbRun(t('rbReblog'), rb.missing.slice().reverse(), m => reblogToMain(m.blog, m.id, when)); // oldest first
    },
    packInstallUrl: async () => {
      const url = $('packUrl').value.trim();
      if (!url) return;
      try { await installPack(await fetchPack(url), url); $('packUrl').value = ''; } catch (e) { toast(t('tplInstallFailed', C.errMsg(e))); }
    },
    packFile: () => $('packFile').click(),
    packInstallPaste: async () => {
      if (!$('packPaste').value.trim()) return;
      await installPack($('packPaste').value, '');
      $('packPaste').value = '';
    },
    tplApply: () => {
      const pk = tplPack();
      const { add, drop } = tplEditPlan();
      if (!pk || (!add.length && !drop.length)) return toast(t('tplNoChange'));
      runBatch(t('actRetag'), C.mutations.retag(pk, tplOpts(add, drop), t), { onDone: () => { tplEdit.key = ''; renderTplCard(); } });
    },
    upkScan: scanUpkeep,
    upkAll: () => { upk.rules.forEach(r => upkSel.add(r.rule)); renderUpkeep(); },
    upkNone: () => { upkSel.clear(); renderUpkeep(); },
    upkApply: () => {
      if (!upkSel.size) return toast(t('upkPick'));
      runBatch(t('actUpkeep', upkSel.size), C.mutations.upkeep(parsedPacks(), new Set(upkSel), t), {
        targets: upkTargets().map(p => ({ key: p.key, blog: p.blog, id: p.id })),
        ui: 'upk',
        onDone: scanUpkeep,
      });
    },
    load: () => loadPosts('reset'),
    more: () => loadPosts('more'),
    all: () => loadPosts('all'),
    stopLoad: () => { if (loadCtx.loading) loadCtx.loading.aborted = true; },
    selAll: () => { visible.filter(selectable).forEach(p => selected.add(p.key)); renderSelInfo(); },
    selNone: () => { selected.clear(); renderSelInfo(); },
    selInvert: () => { visible.filter(selectable).forEach(p => (selected.has(p.key) ? selected.delete(p.key) : selected.add(p.key))); renderSelInfo(); },
    setPublic: () => runBatch(t('setPublic'), C.mutations.state(t, stateName, 'published')),
    setPrivate: () => runBatch(t('setPrivate'), C.mutations.state(t, stateName, 'private')),
    labelOn: () => {
      const cats = selectedCategories();
      if (!cats.length) return toast(t('needCat'));
      runBatch(t('actLabelOn', cats.map(c => t('cat_' + c)).join(t('listSep'))), C.mutations.labels(cats), { verifyLabel: true });
    },
    labelOff: () => runBatch(t('labelOff'), C.mutations.labels([]), { verifyLabel: true }),
    tagsAdd: () => {
      const tags = batchTags.tags;
      if (!tags.length) return toast(t('needAddTags'));
      runBatch(t('actTagsAdd', tags.map(tg => '#' + tg).join(' ')), C.mutations.addTags(tags));
    },
    removeMarked: () => {
      if (!tagMarks.size) return toast(t('needMark'));
      const marked = selectedTagStats().tags.filter(([k]) => tagMarks.has(k)).map(([, s]) => s.tag);
      runBatch(t('actTagsRemove', marked.map(tg => '#' + tg).join(' ')), C.mutations.removeTags(marked));
    },
    // Look up popularity for the selection's tags, then reorder each post's tags, most popular first
    sortHeat: async () => {
      if (running) return;
      const targets = posts.filter(p => selected.has(p.key));
      if (!targets.length) return toast(t('needSelect'));
      const ctl = running = { aborted: false };
      $('runRow').hidden = false;
      await C.ensureTagStats(api, cache, targets.flatMap(p => p.tags), { ctl, save, onProgress: (i, n) => { $('runInfo').textContent = t('heatChecking', i, n); } });
      running = null;
      $('runRow').hidden = true;
      if (!ctl.aborted) runBatch(t('sortHeat'), C.mutations.sortByHeat(cache.tagStats, fairOpts()));
    },
    stopRun: () => { if (running) running.aborted = true; },
    cleanScan: scanCleanup,
    cleanStop: () => { if (scanCtl) scanCtl.aborted = true; },
    cleanAll: () => { cleanResults.forEach(r => cleanSel.add(r.key)); renderClean(); },
    cleanNone: () => { cleanSel.clear(); renderClean(); },
    cleanRemove: () => {
      if (!cleanSel.size) return toast(t('cleanPick'));
      const tags = cleanResults.filter(r => cleanSel.has(r.key)).map(r => r.tag);
      runBatch(t('actClean', tags.length), C.mutations.removeTags(tags), {
        targets: cleanTargets(),
        ui: 'clean',
        onDone: () => {
          cleanResults = cleanResults.filter(r => index.tags.has(r.key));
          for (const k of [...cleanSel]) if (!index.tags.has(k)) cleanSel.delete(k);
          renderClean();
        },
      });
    },
    syncInc: () => syncAll(false),
    syncFull: () => syncAll(true),
    syncStop: () => { if (syncing) syncing.aborted = true; },
    addCustom: () => {
      const tag = C.norm($('customTag').value);
      if (!tag) return;
      if (!cache.custom.some(x => C.key(x) === C.key(tag))) cache.custom.push(tag);
      cache.hidden = cache.hidden.filter(x => x !== C.key(tag));
      $('customTag').value = '';
      save(); rebuildIndex(); renderLibrary();
    },
  };

  function showView(name) {
    qsa('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    qsa('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
    if (name === 'lib') renderLibrary();
    if (name === 'clean') { renderCleanRules(); renderClean(); }
    if (name === 'packs') { renderPacks(); renderUpkeep(); }
    if (name === 'reblogs') { renderReblogs(); renderAutoLog(); }
  }

  document.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (tab) return showView(tab.dataset.tab);
    const boxBtn = e.target.closest('#box [data-box]');
    if (boxBtn) {
      box = boxBtn.dataset.box;
      qsa('#box button').forEach(b => b.classList.toggle('on', b === boxBtn));
      return loadPosts('reset');
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act && actions[act]) actions[act]();
  });
  $('search').addEventListener('input', C.debounce(applyFilter, 150));
  $('stateFilter').addEventListener('change', applyFilter);
  $('customTag').addEventListener('keydown', e => { if (e.key === 'Enter') actions.addCustom(); });
  $('tagFilter').addEventListener('keydown', e => { if (e.key === 'Enter' && !(dd.open && dd.hi >= 0)) loadPosts('reset'); });
  $('blog').addEventListener('change', () => loadPosts('reset'));
  $('cardSize').addEventListener('input', e => {
    settings.card = +e.target.value;
    document.documentElement.style.setProperty('--card', settings.card + 'px');
    saveSettings();
  });

  // ---------- Language and settings ----------
  function applyStatic() {
    document.documentElement.lang = locale();
    document.title = t('appTitle');
    qsa('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
    qsa('[data-i18n-ph]').forEach(n => { n.placeholder = t(n.dataset.i18nPh); });
    const sel = $('lang');
    sel.innerHTML = `<option value="">${C.esc(t('langAuto'))}</option>`
      + Object.entries(C.LANG_NAMES).map(([code, name]) => `<option value="${code}">${C.esc(name)}</option>`).join('');
    sel.value = C.STRINGS[settings.lang] ? settings.lang : '';
  }
  function applyLang() {
    applyStatic();
    renderBlogOptions();
    renderList();
    renderLibrary();
    renderClean();
  }
  $('lang').addEventListener('change', e => { settings.lang = e.target.value; saveSettings(); applyLang(); });
  $('delay').addEventListener('change', e => { settings.delay = Math.max(200, +e.target.value || 800); e.target.value = settings.delay; saveSettings(); });
  $('autoSync').addEventListener('change', e => { settings.autoSync = e.target.checked; saveSettings(); });
  $('hideAds').addEventListener('change', e => { settings.hideAds = e.target.checked; saveSettings(); });
  $('hideRecs').addEventListener('change', e => { settings.hideRecs = e.target.checked; saveSettings(); });
  $('syncReblogs').addEventListener('change', e => { settings.syncReblogs = e.target.checked; saveSettings(); });
  // Weak-tag rules and template options; a changed rule also changes what the template card plans
  const RULE_INPUTS = { ruleColdOn: 'cold', ruleCold: 'coldPct', ruleMatchOn: 'match', ruleMatch: 'matchMin', manyAt: 'manyAt', spellings: 'spellings' };
  for (const [id, k] of Object.entries(RULE_INPUTS)) {
    $(id).addEventListener('change', e => {
      const v = e.target.type === 'checkbox' ? e.target.checked : Math.max(+e.target.min || 0, Math.min(+e.target.max || Infinity, Math.round(+e.target.value) || 0));
      settings.rules = { ...settings.rules, [k]: v };
      if (e.target.type !== 'checkbox') e.target.value = v;
      saveSettings();
      renderTplCard();
    });
  }
  $('useBase').addEventListener('change', e => { settings.useBase = e.target.checked; saveSettings(); renderTplCard(); });

  // ---------- Startup ----------
  async function start() {
    const stored = await chrome.storage.local.get(['cache', 'settings', 'packs']);
    packs = stored.packs || [];
    cache = Object.assign(C.emptyCache(), stored.cache || {});
    const old = stored.settings?.clean;
    Object.assign(settings, stored.settings || {});
    // the cold and search rules used to be the cleanup's own (settings.clean); they are shared rules now
    if (!stored.settings?.rules && old) {
      settings.rules = { ...settings.rules, ...('cold' in old ? { cold: old.cold, coldPct: old.coldPct } : {}), ...('match' in old ? { match: old.match } : {}) };
    }
    settings.rules = { ...C.TPL_RULES, ...settings.rules };
    settings.clean = { notes: old?.notes ?? true, notesMax: old?.notesMax ?? 1 };
    rebuildIndex();
    document.documentElement.style.setProperty('--card', settings.card + 'px');
    $('cardSize').value = settings.card;
    $('delay').value = settings.delay;
    $('autoSync').checked = settings.autoSync;
    $('hideAds').checked = settings.hideAds;
    $('hideRecs').checked = settings.hideRecs;
    $('syncReblogs').checked = settings.syncReblogs;
    for (const [id, k] of Object.entries(RULE_INPUTS)) $(id)[$(id).type === 'checkbox' ? 'checked' : 'value'] = settings.rules[k];
    $('useBase').checked = settings.useBase;
    $('ruleNotesOn').checked = settings.clean.notes; $('ruleNotes').value = settings.clean.notesMax;
    applyStatic();
    renderBlogOptions();
    renderList();
    renderCleanRules();
    renderClean();
    try {
      const before = lang();
      const blogs = await C.getBlogs(api);
      if (lang() !== before) applyLang(); // the Tumblr language is known once /dashboard has been read
      if (!blogs.length) throw new Error('no blogs');
      cache.blogList = blogs;
      await save();
      renderBlogOptions();
      loadPosts('reset');
      if (settings.autoSync && Date.now() - (cache.lastAuto || 0) > AUTO_SYNC_INTERVAL) syncAll(false);
    } catch (e) {
      if (e?.status === 401 || e?.status === 403 || e?.message === 'no blogs') $('login').hidden = false;
      else toast(t('blogListFailed', C.errMsg(e)));
    }
  }
  start();
})();
