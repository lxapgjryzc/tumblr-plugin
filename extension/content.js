// Content script on tumblr.com: tag autocomplete in the post editor and a blog's search box, the tag template
// panel, and upgrades to the official mass editor. Data is shared with the manager page through chrome.storage.local.
(async () => {
  'use strict';

  const C = TTHCore;
  const AUTO_SYNC_INTERVAL = 6 * 3600 * 1000;

  // The mass editor's autocomplete lives in the page's jQuery, which mega-main.js reaches from the page's world.
  // It asks here for suggestions; answers wait until storage has loaded.
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  document.addEventListener('tth-suggest', async e => {
    const req = JSON.parse(e.detail);
    await ready;
    document.dispatchEvent(new CustomEvent('tth-suggest-res', { detail: JSON.stringify({ id: req.id, tags: megaSuggest(req) }) }));
  });

  // ---------- Storage ----------
  // Keys shared with the manager: cache, settings (rules and useBase included) and packs. The panel's own
  // picks live under templates.
  const stored = await chrome.storage.local.get(['cache', 'settings', 'packs', 'templates']);
  const cache = Object.assign(C.emptyCache(), stored.cache || {});
  const settings = Object.assign({ autoSync: true, lang: '', syncReblogs: true, rules: { ...C.TPL_RULES }, useBase: true }, stored.settings || {});
  // Every write carries this tab's mark (storage key writer), so the change listener can skip our own writes
  const me = Math.random().toString(36).slice(2);
  const store = obj => chrome.storage.local.set({ ...obj, writer: me + ':' + Date.now() });
  const save = async () => store({ cache });
  const saveSettings = () => store({ settings });
  // Auto language follows the user's Tumblr interface language. New Tumblr pages report it in <html lang>;
  // the legacy mass editor always says "en", so there use the last value seen, or its own button text.
  const legacyPage = location.pathname.startsWith('/mega-editor');
  if (!legacyPage && document.documentElement.lang && settings.tumblrLang !== document.documentElement.lang) {
    settings.tumblrLang = document.documentElement.lang;
    saveSettings();
  }
  const legacyHint = () => (/[一-鿿]/.test(document.getElementById('make_posts_private')?.textContent || '') ? 'zh' : null);
  const { t, stateName } = C.makeI18n(() => settings.lang, () => (legacyPage ? [settings.tumblrLang, legacyHint()] : [document.documentElement.lang]));

  // ---------- API ----------
  // Content scripts can't reach the page's apiFetch, so /api is called directly with the web client's token,
  // read from this page's scripts or, failing that, from /dashboard. Retries once on 401 with a fresh token.
  let auth = null;
  async function getAuth(force) {
    if (auth && !force) return auth;
    let a = {};
    if (!force) for (const s of document.scripts) { const p = C.parseAuth(s.textContent); if (p.token) { a = p; break; } }
    if (!a.token) a = C.parseAuth(await (await fetch('/dashboard', { credentials: 'include' })).text());
    return (auth = a);
  }

  async function request(path, { method, body }) {
    for (let retry = 0; ; retry++) {
      const { token, csrf } = await getAuth(retry > 0);
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (csrf) headers['X-CSRF'] = csrf;
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch('/api' + path, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401 && retry === 0) continue;
      if (!res.ok) { const e = new Error(json?.meta?.msg || res.statusText); e.status = res.status; e.body = json; throw e; }
      return json;
    }
  }
  const api = C.makeApi(request);

  // ---------- Tag library ----------
  let index = C.buildIndex(cache);
  const rebuildIndex = () => { index = C.buildIndex(cache); };

  let syncing = null;
  async function syncAll(full, quiet) {
    if (syncing) return;
    syncing = { aborted: false };
    try {
      await C.syncAll(api, cache, full, syncing, msg => { if (!quiet) toast(msg, true); }, t, save, settings.collect?.blog ? [settings.collect.blog] : []);
      rebuildIndex();
      if (!quiet) toast(t('syncDone', index.tags.size));
    } catch (e) {
      if (!quiet) toast(t('syncFailed', C.errMsg(e)));
    } finally {
      syncing = null;
    }
  }

  // ---------- Page UI host (suggestion dropdown, toasts, status box) ----------
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.wrap { --bg:#fff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --sel:#dbeafe; --accent:#0091d5; --danger:#dc2626; }
@media (prefers-color-scheme: dark) {
  .wrap { --bg:#0f1b2e; --fg:#e8edf3; --muted:#93a3b8; --line:#26354d; --sel:#123b63; --accent:#00b8ff; --danger:#f87171; }
}
[hidden] { display:none !important; }
.dd { position:fixed; z-index:4; min-width:220px; max-width:360px; max-height:300px; overflow:auto; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.4); font-size:13px; padding:4px 0; }
.dd .h { padding:3px 10px; font-size:11px; color:var(--muted); }
.dd .it { padding:5px 10px; display:flex; gap:8px; cursor:pointer; }
.dd .it span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dd .it small { color:var(--muted); }
.dd .it.on { background:var(--sel); }
.dd.menu { min-width:140px; }
.dd.menu .it:hover { background:var(--sel); }
.toast { position:fixed; left:50%; bottom:40px; transform:translateX(-50%); background:var(--fg); color:var(--bg); padding:8px 14px; border-radius:6px; font-size:13px; z-index:5; max-width:80vw; }
.status { position:fixed; right:16px; bottom:16px; width:360px; max-height:50vh; overflow:auto; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.35); font-size:13px; padding:10px 12px; z-index:5; white-space:pre-wrap; }
.status .row { display:flex; gap:8px; align-items:center; margin-top:8px; justify-content:flex-end; }
.status button { border:1px solid var(--line); background:none; color:var(--fg); border-radius:4px; padding:3px 10px; cursor:pointer; font-size:12px; }
.status button.stop { color:var(--danger); }
.preview { position:fixed; z-index:6; max-width:min(560px, 90vw); max-height:80vh; overflow:auto; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.4); padding:8px; pointer-events:none; }
.preview .h { font-size:12px; color:var(--muted); margin:0 2px 6px; }
.preview .g { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:6px; }
.preview img { width:100%; border-radius:4px; display:block; background:var(--line); }
`;
  const host = document.createElement('div');
  host.id = 'tth-host';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="dd" hidden></div><div class="dd menu" hidden></div><div class="toast" hidden></div><div class="preview" hidden></div>
    <div class="status" hidden><div class="msg"></div><div class="row"><button class="stop" hidden></button><button class="close">×</button></div></div></div>`;

  let toastTimer;
  function toast(msg, sticky) {
    const el = root.querySelector('.toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  // A small box for bulk-edit progress and results; onStop shows a stop button while running
  const statusBox = root.querySelector('.status');
  function status(msg, onStop) {
    statusBox.hidden = false;
    statusBox.querySelector('.msg').textContent = msg;
    const stop = statusBox.querySelector('.stop');
    stop.hidden = !onStop;
    stop.textContent = '■';
    stop.onclick = onStop || null;
  }
  statusBox.querySelector('.close').onclick = () => { statusBox.hidden = true; };

  // ---------- Suggestion dropdown ----------
  const dd = { el: root.querySelector('.dd'), items: [], hi: -1, input: null, onPick: null, open: false };
  let suppressKeys = false;

  function showDD(input, items, header, onPick, placement) {
    dd.items = items; dd.hi = -1; dd.input = input; dd.onPick = onPick; dd.open = true;
    dd.el.innerHTML = `<div class="h">${C.esc(header)}</div>` + items.map((it, i) =>
      `<div class="it" data-i="${i}"><span>#${C.esc(it.tag)}</span><small>${it.co ? t('ddCo') + ' ' : ''}${it.count || ''}</small></div>`).join('');
    dd.el.hidden = false;
    const r = input.getBoundingClientRect();
    const h = dd.el.offsetHeight;
    const above = placement === 'above' ? r.top - h - 4 >= 0 : r.bottom + h + 4 > innerHeight;
    dd.el.style.left = Math.max(4, Math.min(r.left, innerWidth - dd.el.offsetWidth - 4)) + 'px';
    dd.el.style.top = (above ? Math.max(4, r.top - h - 4) : r.bottom + 4) + 'px';
  }
  function hideDD() { dd.open = false; dd.el.hidden = true; dd.input = null; }
  function highlight(i) {
    dd.hi = i;
    dd.el.querySelectorAll('.it').forEach((n, j) => n.classList.toggle('on', j === i));
    dd.el.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
  }
  function pickDD(i) {
    const it = dd.items[i], fn = dd.onPick;
    hideDD();
    if (it && fn) fn(it.tag);
  }
  dd.el.addEventListener('mousedown', e => {
    e.preventDefault(); // keep focus in the input
    const it = e.target.closest('.it');
    if (it) pickDD(+it.dataset.i);
  });
  // Intercept keys in the window capture phase, before Tumblr's React handlers see them
  window.addEventListener('keydown', e => {
    if (!dd.open || suppressKeys || !e.isTrusted || e.composedPath()[0] !== dd.input) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { stop(); highlight((dd.hi + 1) % dd.items.length); }
    else if (e.key === 'ArrowUp') { stop(); highlight((dd.hi - 1 + dd.items.length) % dd.items.length); }
    else if (e.key === 'Tab') { stop(); pickDD(dd.hi >= 0 ? dd.hi : 0); }
    else if (e.key === 'Enter' && dd.hi >= 0) { stop(); pickDD(dd.hi); }
    else if (e.key === 'Escape') { stop(); hideDD(); }
  }, true);

  function attachSuggest(input, { context = () => [], exclude = () => [], pool = null, onPick, placement = 'below', header = 'ddMine' }) {
    const update = () => {
      const q = input.value.split(',').pop();
      const ctx = context();
      const items = C.suggest(index, q, ctx, exclude(), 10, pool ? pool() : null);
      if (!items.length) { if (dd.input === input) hideDD(); return; }
      showDD(input, items, t(!C.norm(q) ? (ctx.length ? 'ddRelated' : 'ddFrequent') : header), onPick, placement);
    };
    input.addEventListener('input', update);
    input.addEventListener('focus', update);
    input.addEventListener('blur', () => setTimeout(() => { if (dd.input === input) hideDD(); }, 150));
    return update;
  }

  // ---------- Post editor: #tags input ----------
  function setNativeValue(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function commitNative(el, tag) {
    el.focus();
    setNativeValue(el, tag);
    suppressKeys = true;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    suppressKeys = false;
    // If Enter didn't commit the tag, fall back to a trailing comma
    setTimeout(() => { if (C.norm(el.value) === C.norm(tag)) setNativeValue(el, tag + ','); }, 60);
  }

  // The post editor's tag chips (checked live on 2026-10-26): a span[role=button] holding the tag text in a
  // span[role=textbox] (no "#": that is drawn by CSS) and a remove button
  function editorChips(el) {
    let box = el;
    for (let i = 0; i < 6 && box.parentElement; i++) {
      box = box.parentElement;
      if (box.querySelector('[role="button"] [role="textbox"]')) break;
    }
    return [...box.querySelectorAll('[role="button"]')]
      .map(chip => ({ text: chip.querySelector('[role="textbox"]')?.textContent, btn: chip.querySelector('button') }))
      .filter(c => c.text?.trim() && c.btn)
      .map(c => ({ tag: C.norm(c.text.replace(/^#/, '')), remove: () => c.btn.click() }));
  }

  // Read tags already added in the editor: the chips, plus any "#tag" text near the input (older layouts)
  function readEditorTags(el) {
    const out = new Set(editorChips(el).map(c => c.tag));
    let box = el;
    for (let i = 0; i < 4 && box.parentElement; i++) box = box.parentElement;
    for (const n of box.querySelectorAll('button, span, a, div')) {
      if (n.contains(el) || n.children.length > 1) continue;
      const tx = n.textContent.trim();
      if (/^#[^#\s]/.test(tx) && tx.length < 140) out.add(C.norm(tx));
    }
    return [...out];
  }

  // ---------- Blog search box ----------
  // Own blogs use the synced library; other blogs have their recent posts read in the background (memory only)
  const OTHER_BLOG_MAX_POSTS = 1000;
  const otherPools = new Map();

  function blogTagPool(name, onUpdate) {
    const lname = String(name || '').toLowerCase();
    if (!lname) return [];
    const own = index.byBlog.get(lname);
    if (own) return [...own.values()];
    let pool = otherPools.get(lname);
    if (!pool) otherPools.set(lname, pool = { tags: new Map(), posts: 0, done: false, loading: false, listeners: new Set() });
    if (onUpdate) pool.listeners.add(onUpdate);
    if (!pool.loading && !pool.done) loadOtherBlog(lname, pool);
    return [...pool.tags.values()];
  }

  async function loadOtherBlog(name, pool) {
    pool.loading = true;
    let path = C.basePosts(name);
    try {
      while (path && pool.posts < OTHER_BLOG_MAX_POSTS) {
        const r = await api(path);
        const got = r?.posts || [];
        if (!got.length) break;
        for (const p of got.filter(C.isPost)) for (const tg of C.uniqTags(p.tags || [])) {
          const k = tg.toLowerCase(), o = pool.tags.get(k);
          if (o) o.count++; else pool.tags.set(k, { tag: tg, count: 1 });
        }
        pool.posts += got.length;
        pool.listeners.forEach(fn => fn(pool));
        path = C.nextPath(r, name, {}, pool.posts, got.length >= 20);
        await C.sleep(300);
      }
    } catch { /* suggestions just stay partial */ }
    pool.done = true;
    pool.loading = false;
    pool.listeners.forEach(fn => fn(pool));
  }

  // Infer the blog being viewed from the URL, e.g. /yuuto, /yuuto/tagged/xxx or /blog/view/yuuto
  const RESERVED_PATHS = new Set(['dashboard', 'explore', 'search', 'tagged', 'likes', 'following', 'followers', 'inbox', 'settings',
    'new', 'blog', 'communities', 'messaging', 'activity', 'mega-editor', 'login', 'register', 'help', 'about', 'privacy', 'policy',
    'docs', 'apps', 'tips', 'reblog', 'edit', 'post', 'changes', 'live', 'discover', 'home', 'oauth', 'customize', 'analytics',
    'shop', 'premium', 'domains', 'safe-mode', 'mobile', 'notifications', 'tumblr-plus', 'logout', 'onboarding', 'reset_password']);
  function currentBlogName() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (seg[0] === 'blog' && seg[1] === 'view' && seg[2]) return seg[2];
    if (seg[0] && !RESERVED_PATHS.has(seg[0].toLowerCase()) && /^[a-z0-9-]+$/i.test(seg[0])) return seg[0];
    return null;
  }
  const taggedUrl = (blog, tag) => `https://www.tumblr.com/${C.enc(blog)}/tagged/${C.enc(tag)}`;

  function bindInputs() {
    for (const el of document.querySelectorAll('input[placeholder^="#"], textarea[placeholder^="#"]')) {
      if (el.dataset.tthBound) continue;
      el.dataset.tthBound = '1';
      attachSuggest(el, {
        context: () => readEditorTags(el),
        exclude: () => readEditorTags(el),
        onPick: tag => commitNative(el, tag),
        placement: 'above', // Tumblr's own suggestions appear below; avoid overlapping them
      });
      trackTagInput(el);
    }
    for (const el of document.querySelectorAll('input[type="search"], input[placeholder]')) {
      if (el.dataset.tthBound || !currentBlogName()) continue;
      const ph = el.getAttribute('placeholder') || '';
      if (ph.startsWith('#') || /tumblr/i.test(ph) || !(el.type === 'search' || /search|搜索|搜尋|検索|검색/i.test(ph))) continue;
      el.dataset.tthBound = '1';
      const update = attachSuggest(el, {
        pool: () => blogTagPool(currentBlogName(), () => { if (dd.input === el) update(); }),
        onPick: tag => { const b = currentBlogName(); if (b) location.assign(taggedUrl(b, tag)); },
        header: 'ddBlog',
      });
    }
  }

  // ---------- Tag templates ----------
  // Packs, rules and useBase are the manager's (storage keys packs and settings); the panel's own picks, saved
  // combos and per-tag overrides are under templates. Activity samples share cache.tagStats with the heat sort.
  // A ▦ button sits at the right end of the post editor's #tags input and opens the panel.
  const tpl = Object.assign({ current: '', picks: [], favs: [], overrides: {} }, stored.templates || {},
    { packs: stored.packs || [], useBase: settings.useBase, rules: { ...C.TPL_RULES, ...settings.rules } });
  const saveTpl = () => {
    const { packs, useBase, rules, ...own } = tpl;
    Object.assign(settings, { useBase, rules });
    return store({ packs, settings, templates: own });
  };
  // tpl.packs = [{ raw, source }]: raw is the pack JSON as installed, source the URL it came from (or '')
  const parsed = new Map();
  function packById(id) {
    if (!parsed.has(id)) {
      const entry = tpl.packs.find(p => p.raw.id === id);
      let pk = null;
      try { pk = entry && C.parsePack(entry.raw); } catch { /* a broken pack just doesn't show */ }
      parsed.set(id, pk);
    }
    return parsed.get(id);
  }
  const currentPack = () => packById(tpl.current) || (tpl.packs[0] && packById(tpl.packs[0].raw.id)) || null;
  // Tag sorting takes turns between subjects, using the installed packs to tell whose tag is whose
  const fairOpts = () => C.packGrouping(tpl.packs.map(p => packById(p.raw.id)));

  const TPL_CSS = `
.tp-btn { position:fixed; z-index:3; width:24px; height:22px; border:1px solid var(--line); border-radius:5px; background:var(--bg); color:var(--accent); font-size:14px; line-height:1; cursor:pointer; padding:0; }
.tp { position:fixed; z-index:4; width:760px; max-width:calc(100vw - 16px); height:min(600px, calc(100vh - 16px)); display:flex; flex-direction:column; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:10px; box-shadow:0 12px 36px rgba(0,0,0,.45); font-size:13px; }
/* Picking: the left column only lists what can be picked and never changes shape; everything that reacts to a
   pick (picked list, relations, preview) lives in the right column, so nothing moves under the pointer */
.tp-cols { flex:1; min-height:0; display:flex; }
.tp-left { flex:1; min-width:0; display:flex; flex-direction:column; border-right:1px solid var(--line); }
.tp-right { width:300px; flex:none; overflow:auto; padding:2px 10px 8px; }
.tp-right .tp-sh:first-child { margin-top:8px; }
.tp-right .empty { color:var(--muted); font-size:12px; }
@media (max-width: 640px) { .tp-cols { flex-direction:column; } .tp-left { border-right:0; border-bottom:1px solid var(--line); flex:1 1 55%; } .tp-right { width:auto; flex:1 1 45%; } }
.tp-h { display:flex; gap:6px; align-items:center; padding:8px 10px; border-bottom:1px solid var(--line); }
.tp-h .ttl { font-weight:600; flex:1; }
.tp button, .tp select, .tp input, .tp textarea { font:inherit; color:var(--fg); background:none; border:1px solid var(--line); border-radius:5px; }
.tp button { padding:3px 9px; cursor:pointer; }
/* the open list of a <select> is drawn by the browser on its own background: give options the panel's colours */
.tp select, .tp option { background:var(--bg); color:var(--fg); }
.tp button.pri { background:var(--accent); border-color:var(--accent); color:#fff; }
.tp .x { border:0; font-size:16px; padding:0 4px; }
.tp-q { margin:8px 10px 0; padding:5px 8px; }
.tp-body { flex:1; overflow:auto; padding:4px 10px 8px; min-height:80px; }
.tp-sh { font-size:11px; color:var(--muted); margin:8px 0 4px; }
.tp-chips { display:flex; flex-wrap:wrap; gap:4px; }
.tp-c { border:1px solid var(--line); border-radius:12px; padding:2px 9px; cursor:pointer; user-select:none; }
.tp-c.on { background:var(--accent); border-color:var(--accent); color:#fff; }
.tp-c.inc { border-color:var(--accent); color:var(--accent); }
.tp-c.part { border-style:dashed; border-color:var(--accent); color:var(--accent); }
.tp-c small { opacity:.75; }
.tp-edit { margin:2px 0 4px; line-height:1.5; }
.tp-edit.add { color:var(--accent); }
.tp-edit.drop { color:var(--danger); }
.tp-c .del { margin-left:4px; opacity:.6; }
.tp-combo { margin-bottom:8px; }
.tp-combo .who { display:block; color:var(--muted); font-size:12px; margin-bottom:3px; }
.tp-c b { font-weight:600; margin-right:2px; }
.tp-prev { margin-top:4px; }
.tp-prev .meta { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:4px; }
.tp-t { display:inline-block; margin:0 6px 3px 0; cursor:pointer; }
.tp-t.off { color:var(--muted); text-decoration:line-through; }
.tp-t.flag { color:#d97706; text-decoration:underline dotted; }
.tp-cut { display:inline-block; margin:0 6px 3px 0; padding:0 4px; font-size:10px; color:var(--muted); border:1px dashed var(--line); border-radius:3px; }
.tp-prev .meta .warn { color:#d97706; }
.tp-prev .meta button { font-size:11px; padding:1px 6px; }
.tp-t.forced { font-weight:600; }
.tp-f { display:flex; gap:6px; padding:8px 10px; border-top:1px solid var(--line); flex-wrap:wrap; }
.tp-f .sp { flex:1; }
.tp-m h4 { margin:12px 0 6px; font-size:12px; color:var(--muted); font-weight:600; }
.tp-pk { border:1px solid var(--line); border-radius:6px; padding:6px 8px; margin-bottom:6px; }
.tp-pk .nm { font-weight:600; }
.tp-pk .sub { font-size:11px; color:var(--muted); word-break:break-all; }
.tp-pk .row, .tp-m .row { display:flex; gap:6px; align-items:center; margin-top:6px; flex-wrap:wrap; }
.tp-m input[type=text], .tp-m textarea { flex:1; padding:4px 6px; min-width:0; }
.tp-m textarea { width:100%; height:70px; }
.tp-m input[type=number] { width:56px; padding:2px 4px; }
.tp-m .hint { font-size:11px; color:var(--muted); }
.tp-rv { display:block; margin:2px 0; }
.tp-rv small { color:var(--muted); }
.tp-rv.bad small { color:var(--danger); font-weight:600; }
`;
  const tplStyle = document.createElement('style');
  tplStyle.textContent = TPL_CSS;
  root.appendChild(tplStyle);
  const tplBtn = document.createElement('button');
  tplBtn.className = 'tp-btn';
  tplBtn.textContent = '▦';
  tplBtn.title = t('tplOpen');
  tplBtn.hidden = true;
  const tplEl = document.createElement('div');
  tplEl.className = 'tp';
  tplEl.hidden = true;
  root.querySelector('.wrap').append(tplBtn, tplEl);
  // Keep keys typed in the panel away from Tumblr's shortcuts (Escape would close the post editor)
  for (const type of ['keydown', 'keyup', 'keypress']) tplEl.addEventListener(type, e => {
    e.stopPropagation();
    if (type === 'keydown' && e.key === 'Escape') closeTpl();
  });

  const tagInputs = new Set();
  let lastTagInput = null;
  function trackTagInput(el) {
    tagInputs.add(el);
    el.addEventListener('focus', () => { lastTagInput = el; });
    placeTplBtn();
  }
  const visible = el => el?.isConnected && el.getBoundingClientRect().width > 0;
  function tagInput() {
    if (visible(lastTagInput)) return lastTagInput;
    for (const el of tagInputs) { if (!el.isConnected) tagInputs.delete(el); else if (visible(el)) return el; }
    return null;
  }
  function placeTplBtn() {
    const el = tagInput();
    tplBtn.hidden = !el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    tplBtn.style.left = Math.min(r.right - 28, innerWidth - 28) + 'px';
    tplBtn.style.top = (r.top + (r.height - 22) / 2) + 'px';
  }
  setInterval(placeTplBtn, 500);
  addEventListener('scroll', placeTplBtn, true);
  addEventListener('resize', placeTplBtn);
  tplBtn.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the tags input
  tplBtn.addEventListener('click', () => (tplEl.hidden ? openTpl() : closeTpl()));

  let tplView = 'pick', tplQuery = '';
  // Pages without a post editor (the mass editor) set an anchor to open next to and an insert handler
  let tplAnchor = null, tplInsert = null;
  function openTpl(view) {
    tplEl.hidden = false;
    tplView = view || (currentPack() ? 'pick' : 'manage');
    renderTpl();
    // Placed once per opening, on the side of the tags input with more room so the input stays visible;
    // the size is fixed while it is open, so nothing moves as picks change
    const el = tplAnchor || tagInput();
    const r = el ? el.getBoundingClientRect() : { top: innerHeight, bottom: innerHeight, left: 8, right: innerWidth - 8 };
    const w = tplEl.offsetWidth;
    const below = innerHeight - r.bottom - 16, above = r.top - 16;
    const h = Math.min(600, Math.max(below, above, 360), innerHeight - 16);
    tplEl.style.height = h + 'px';
    tplEl.style.left = Math.max(8, Math.min((r.left + r.right - w) / 2, innerWidth - w - 8)) + 'px';
    tplEl.style.top = (below >= above ? Math.min(r.bottom + 8, innerHeight - h - 8) : Math.max(8, r.top - h - 8)) + 'px';
    tplEl.querySelector('.tp-q')?.focus();
  }
  function closeTpl() {
    tplEl.hidden = true;
    if (tplEdit) { tpl.picks = tplEdit.savedPicks; tplEdit = null; saveTpl(); }
    tplUpk = null;
  }

  // Tidying the selected posts by packs (mass editor): the panel lists what would change, rule by rule, as the
  // extension's Packs page does; only the ticked changes are applied.
  // tplUpk = { plan: planUpkeep(...), sel: Set of rules, total, apply(allow, ids) }
  let tplUpk = null;
  const installedPacks = () => tpl.packs.map(p => packById(p.raw.id)).filter(Boolean);
  function openTplUpkeep(records, anchor, apply) {
    const plan = C.planUpkeep(records, installedPacks());
    tplUpk = { plan, sel: new Set(plan.rules.map(r => r.rule)), total: records.length, apply };
    tplAnchor = anchor;
    openTpl('upkeep');
  }
  const upkTargets = () => tplUpk.plan.posts.filter(p => p.changes.some(c => tplUpk.sel.has(c.rule)));
  function upkeepHtml() {
    const { plan, sel } = tplUpk;
    const rows = plan.rules.map(r => {
      const what = r.type === 'add' ? `+ #${C.esc(r.to)} <small>${C.esc(t('upkAdd'))}</small>`
        : r.to ? `#${C.esc(r.from)} → #${C.esc(r.to)}`
        : `#${C.esc(r.from)} <small>${C.esc(t(r.why === 'dropped' ? 'upkRemoveDropped' : 'upkRemoveHas'))}</small>`;
      return `<label class="tp-rv"><input type="checkbox" data-upk="${C.esc(r.rule)}"${sel.has(r.rule) ? ' checked' : ''}> ${what}`
        + ` <small>${C.esc(r.item)} · ${C.esc(t('upkPosts', r.posts))}</small></label>`;
    }).join('');
    const n = upkTargets().length;
    return `<div class="tp-body tp-m"><h4>${C.esc(plan.rules.length ? t('upkFound', plan.rules.length, plan.posts.length) : t('upkNone'))}</h4>${rows}</div>
      <div class="tp-f"><span class="sp">${plan.rules.length ? C.esc(t('upkSelInfo', sel.size, n)) : ''}</span>`
      + `<button class="pri" data-tp="applyUpkeep"${n ? '' : ' disabled'}>${C.esc(t('upkApply'))}</button></div>`;
  }

  // Editing posts with the template (mass editor): the panel starts with what the selected posts already carry
  // ticked; items only some of them carry are shown "partly" and left alone unless clicked. Applying adds the
  // newly ticked items' tags to every post and takes out the unticked ones' tags (and old spellings).
  // tplEdit = { tagLists, total, counts, all, keepSome, savedPicks, apply(pack, add, drop) }
  let tplEdit = null;
  function openTplEdit(tagLists, anchor, apply) {
    tplEdit = { tagLists, total: tagLists.length, apply, savedPicks: tpl.picks.slice() };
    resetEdit();
    tplAnchor = anchor;
    openTpl();
  }
  function resetEdit() {
    const pack = currentPack();
    const counts = pack ? C.itemsOnPosts(tplEdit.tagLists, pack) : new Map();
    const all = new Set([...counts].filter(([, n]) => n === tplEdit.total).map(([id]) => id));
    Object.assign(tplEdit, { counts, all, keepSome: new Set([...counts.keys()].filter(id => !all.has(id))) });
    tpl.picks = [...all];
  }
  // What applying would do: items to add to every post, items to take out of every post
  function editPlan(pack) {
    const on = new Set(C.expandPicks(pack, tpl.picks).filter(it => it.kind !== 'preset').map(it => it.id));
    return {
      add: [...on].filter(id => !tplEdit.all.has(id)),
      drop: [...tplEdit.counts.keys()].filter(id => !on.has(id) && !tplEdit.keepSome.has(id)),
    };
  }
  const editOpts = (add, drop) => ({ add, drop, stats: tplStats(), overrides: tpl.overrides, useBase: tpl.useBase, rules: tpl.rules, order: fairOpts() });

  const tplStats = () => cache.tagStats || {};
  function composeNow() {
    const pack = currentPack();
    if (!pack) return null;
    const el = tagInput();
    return C.composeTemplate(pack, {
      ids: tpl.picks, stats: tplStats(), overrides: tpl.overrides, useBase: tpl.useBase, rules: tpl.rules,
      exclude: el ? readEditorTags(el).filter(tg => !insertedBy.get(el)?.has(C.key(tg))) : [],
    });
  }
  const whyText = row => {
    const s = tplStats()[C.key(row.tag)];
    const code = row.why || row.flag;
    const why = code === 'fuzzy' ? t('why_fuzzy', s?.match) : code === 'cold' ? t('why_cold', row.rank, row.of)
      : code === 'offtopic' ? t('why_offtopic', Math.round(row.fit * 100)) : code ? t('why_' + code) : '';
    return [why, C.heatText(t, s)].filter(Boolean).join(' · ');
  };

  function renderTpl() {
    if (tplEl.hidden) return;
    const pack = currentPack();
    if (!pack) tplView = 'manage';
    const title = tplView === 'upkeep' && tplUpk ? t('meUpkeep') : tplEdit ? t('tplEditing', tplEdit.total) : t('tplOpen');
    const head = `<div class="tp-h"><span class="ttl">${C.esc(title)}</span>`
      + (tplView === 'pick' && tpl.packs.length > 1 ? `<select class="tp-pack">${tpl.packs.map(p =>
        `<option value="${C.esc(p.raw.id)}"${p.raw.id === pack?.id ? ' selected' : ''}>${C.esc(p.raw.name || p.raw.id)}</option>`).join('')}</select>` : '')
      + `<button data-tp="${tplView === 'manage' ? 'pick' : 'manage'}">${C.esc(t(tplView === 'pick' ? 'tplManage' : 'tplBack'))}</button>`
      + `<button class="x" data-tp="close">×</button></div>`;
    tplEl.innerHTML = head + (tplView === 'upkeep' && tplUpk ? upkeepHtml() : tplView === 'review' && tplReview ? reviewHtml()
      : tplView !== 'pick' || !pack ? manageHtml() : pickHtml(pack));
    if (tplView === 'pick' && pack) {
      const q = tplEl.querySelector('.tp-q');
      q.value = tplQuery;
      q.addEventListener('input', () => { tplQuery = q.value; renderPickBody(pack); });
      renderPickBody(pack);
    }
  }

  function pickHtml(pack) {
    return `<div class="tp-cols">
        <div class="tp-left"><input class="tp-q" type="text" placeholder="${C.esc(t('tplSearch'))}"><div class="tp-body"></div></div>
        <div class="tp-right"><div class="tp-sel"></div><div class="tp-rel"></div><div class="tp-prev"></div></div>
      </div>
      <div class="tp-f"><button data-tp="check">${C.esc(t('tplCheck'))}</button><button data-tp="fav">${C.esc(t('tplSaveFav'))}</button>
        <button data-tp="clear">${C.esc(t('tplClear'))}</button><span class="sp"></span>
        ${tplEdit ? `<button class="pri" data-tp="insert">${C.esc(t('tplApplyTo', tplEdit.total))}</button></div>`
          : `${hasInserted() ? `<button data-tp="undo">${C.esc(t('tplUndo'))}</button>` : ''}<button data-tp="copy">${C.esc(t('tplCopy'))}</button>
        <button class="pri" data-tp="insert">${C.esc(t(hasInserted() ? 'tplUpdateTags' : 'tplInsert'))}</button></div>`}`;
  }

  function renderPickBody(pack) {
    const body = tplEl.querySelector('.tp-body');
    if (!body) return;
    const picked = new Set(tpl.picks);
    const pulled = new Map(); // item id -> name of the picked item that pulled it in
    for (const id of tpl.picks) for (const it of C.expandPicks(pack, [id])) if (!picked.has(it.id) && !pulled.has(it.id)) pulled.set(it.id, pack.items.get(id).name);
    const part = id => !!tplEdit?.keepSome.has(id) && !picked.has(id) && !pulled.has(id);
    const chip = it => `<span class="tp-c${picked.has(it.id) ? ' on' : pulled.has(it.id) ? ' inc' : part(it.id) ? ' part' : ''}" data-item="${C.esc(it.id)}"`
      + ` title="${C.esc(part(it.id) ? t('tplPart', tplEdit.counts.get(it.id), tplEdit.total) : pulled.has(it.id) ? t('tplIncludedBy', pulled.get(it.id)) : it.tags.join(', '))}">${C.esc(it.name)}</span>`;
    let html = '';
    const favs = tpl.favs.filter(f => f.pack === pack.id);
    if (favs.length && !tplQuery) {
      html += `<div class="tp-sh">${C.esc(t('tplFavs'))}</div><div class="tp-chips">${favs.map(f =>
        `<span class="tp-c" data-fav="${tpl.favs.indexOf(f)}">${C.esc(f.name)}<span class="del" data-favdel="${tpl.favs.indexOf(f)}">×</span></span>`).join('')}</div>`;
    }
    // Relations are offered in the right column once their members are picked; while browsing only plain items show
    const match = new Set(C.searchItems(pack, tplQuery).filter(it => tplQuery || !it.rel).map(it => it.id));
    for (const s of pack.sections) {
      const items = s.items.filter(it => match.has(it.id));
      const name = s.name || t(s.kind === 'preset' ? 'tplPresets' : s.kind === 'ship' || s.kind === 'group' ? 'tplRelations' : 'tplOther');
      if (items.length) html += `<div class="tp-sh">${C.esc(name)}</div><div class="tp-chips">${items.map(chip).join('')}</div>`;
    }
    body.innerHTML = html;
    renderRight(pack, pulled);
  }

  // Right column: what is picked (click to drop), the relations between the picked people, the preview
  function renderRight(pack, pulled) {
    const sel = tplEl.querySelector('.tp-sel');
    if (!sel) return;
    const items = tpl.picks.map(id => pack.items.get(id)).filter(Boolean);
    sel.innerHTML = `<div class="tp-sh">${C.esc(t('tplPicked'))}</div>` + (items.length || pulled.size
      ? `<div class="tp-chips">${items.map(it => `<span class="tp-c on" data-item="${C.esc(it.id)}" title="${C.esc(it.tags.join(', '))}">${C.esc(it.name)}<span class="del">×</span></span>`).join('')}`
        + [...pulled.keys()].map(id => `<span class="tp-c inc" title="${C.esc(t('tplIncludedBy', pulled.get(id)))}">${C.esc(pack.items.get(id)?.name || id)}</span>`).join('') + '</div>'
      : `<div class="empty">${C.esc(t('tplNone'))}</div>`);
    // editing posts: what only some of them carry, left as it is unless clicked
    const some = tplEdit ? [...tplEdit.keepSome].filter(id => !tpl.picks.includes(id) && !pulled.has(id)).map(id => pack.items.get(id)).filter(Boolean) : [];
    if (some.length) {
      sel.innerHTML += `<div class="tp-sh">${C.esc(t('tplSome'))}</div><div class="tp-chips">${some.map(it =>
        `<span class="tp-c part" data-item="${C.esc(it.id)}" title="${C.esc(t('tplPart', tplEdit.counts.get(it.id), tplEdit.total))}">${C.esc(it.name)} <small>${tplEdit.counts.get(it.id)}/${tplEdit.total}</small></span>`).join('')}</div>`;
    }
    tplEl.querySelector('.tp-rel').innerHTML = combosHtml(pack);
    renderPreview();
  }

  // One row per set of picked members that has relations, e.g. 隼 + 游斗: romance / friendship / neither.
  // Any number of a row's relations can be ticked; "neither" hides the row until the picks change
  let tplDismissed = new Set();
  function combosHtml(pack) {
    const rows = C.suggestCombos(pack, tpl.picks).filter(g => !tplDismissed.has(g.key) || g.options.some(o => o.picked));
    if (!rows.length) return '';
    const relName = rel => pack.types[rel] || rel;
    // romance, friendship, family always in the same order, so each kind sits in the same place every time
    const order = ['romance', 'friendship', 'family'];
    const rank = o => (order.indexOf(o.item.rel) + 1 || order.length + 1);
    return `<div class="tp-sh">${C.esc(t('tplCombos'))}</div>` + rows.map(g => `<div class="tp-combo">
      <span class="who">${C.esc(g.members.map(m => m.name).join(' + '))}</span><span class="tp-chips">`
      + g.options.slice().sort((a, b) => rank(a) - rank(b)).map(o => `<span class="tp-c${o.picked ? ' on' : o.pulled ? ' inc' : ''}" data-combo="${C.esc(g.key)}" data-item="${C.esc(o.item.id)}"`
        + ` title="${C.esc(o.item.tags.length ? o.item.tags.join(', ') : t('tplMarkerOnly'))}"><b>${C.esc(relName(o.item.rel))}</b> ${C.esc(o.item.name)}</span>`).join('')
      + (g.options.some(o => o.picked) ? '' : `<span class="tp-c" data-dismiss="${C.esc(g.key)}">${C.esc(t('tplNotCombo'))}</span>`)
      + '</span></div>').join('');
  }

  // Preview in the order the tags will be inserted: tags that will go in, most popular first, then the rest
  function heatRows(res) {
    const byKey = new Map(res.rows.map(r => [C.key(r.tag), r]));
    return [...C.sortTagsFair(res.tags, tplStats(), fairOpts()).map(tg => byKey.get(C.key(tg))), ...res.rows.filter(r => !r.on)];
  }

  // Editing posts: who will be added to / taken out of every selected post, and how many posts change
  function renderEditSummary(prev) {
    const pack = currentPack();
    const { add, drop } = editPlan(pack);
    const names = ids => ids.map(id => pack.items.get(id)?.name || id).join('、');
    const opts = editOpts(add, drop);
    const changed = tplEdit.tagLists.filter(tags => C.retagPost(tags, pack, opts).join('\u0001') !== tags.join('\u0001')).length;
    prev.innerHTML = `<div class="tp-sh">${C.esc(t('tplEditPlan'))}</div>`
      + (add.length || drop.length
        ? (add.length ? `<div class="tp-edit add">+ ${C.esc(names(add))}</div>` : '')
          + (drop.length ? `<div class="tp-edit drop">− ${C.esc(names(drop))}</div>` : '')
          + `<div class="empty">${C.esc(t('tplWillChange', changed, tplEdit.total))}</div>`
        : `<div class="empty">${C.esc(t('tplNoChange'))}</div>`);
  }

  // Search reads only the first 20 (blog) / 30 (sitewide) tags; mark where those cuts fall
  function renderPreview() {
    const prev = tplEl.querySelector('.tp-prev');
    if (!prev) return;
    if (tplEdit) return renderEditSummary(prev);
    const res = composeNow();
    // nothing picked: the picked list above already says so
    if (!res || !res.rows.length) { prev.innerHTML = ''; return; }
    const n = res.tags.length;
    const flagged = res.rows.filter(r => r.on && r.flag).length;
    const warn = n > 30 ? t('tplOver30') : n > 20 ? t('tplOver20') : '';
    let i = 0;
    const html = heatRows(res).map(r => {
      const cut = r.on && C.TPL_SEARCH_CUTS.includes(i++) ? `<span class="tp-cut">${i - 1}</span>` : '';
      return cut + `<span class="tp-t${r.on ? '' : ' off'}${r.on && r.flag ? ' flag' : ''}${r.forced ? ' forced' : ''}"`
        + ` data-tag="${C.esc(r.tag)}" title="${C.esc(whyText(r))}">#${C.esc(r.tag)}</span>`;
    }).join('');
    prev.innerHTML = `<div class="meta"><span class="${warn ? 'warn' : ''}">${C.esc(t('tplCount', n))}${warn ? ' · ' + C.esc(warn) : ''}</span>`
      + (flagged ? `<button data-tp="dropFlagged">${C.esc(t('tplDropFlagged', flagged))}</button>` : `<span>${C.esc(t('tplToggleHint'))}</span>`)
      + `</div>` + html;
  }

  function manageHtml() {
    const packs = tpl.packs.map(p => {
      const pk = packById(p.raw.id);
      return `<div class="tp-pk"><div class="nm">${C.esc(p.raw.name || p.raw.id)}</div>
        <div class="sub">${pk ? C.esc(t('tplPackInfo', pk.items.size, C.packTags(pk).length, pk.version)) : ''}${p.edited ? ' · ' + C.esc(t('tplEdited')) : ''}${p.source ? '<br>' + C.esc(p.source) : ''}</div>
        <div class="row">${p.source ? `<button data-tp="update" data-pack="${C.esc(p.raw.id)}">${C.esc(t('tplUpdate'))}</button>` : ''}
          <button data-tp="checkpack" data-pack="${C.esc(p.raw.id)}">${C.esc(t('tplCheckPack'))}</button>
          <button data-tp="review" data-pack="${C.esc(p.raw.id)}">${C.esc(t('tplReview'))}</button>
          <button data-tp="export" data-pack="${C.esc(p.raw.id)}">${C.esc(t('tplExport'))}</button>
          <button data-tp="remove" data-pack="${C.esc(p.raw.id)}">${C.esc(t('tplRemove'))}</button></div></div>`;
    }).join('');
    const r = tpl.rules;
    return `<div class="tp-body tp-m">${packs || `<p class="hint">${C.esc(t('tplNoPack'))}</p>`}
      <h4>${C.esc(t('tplInstallUrl'))}</h4>
      <div class="row"><input type="text" class="tp-url" placeholder="${C.esc(t('tplPhUrl'))}"><button data-tp="installUrl">${C.esc(t('tplInstall'))}</button></div>
      <div class="row"><button data-tp="file">${C.esc(t('tplInstallFile'))}</button><input type="file" class="tp-file" accept=".json,application/json" hidden></div>
      <h4>${C.esc(t('tplInstallPaste'))}</h4>
      <textarea class="tp-paste"></textarea><div class="row"><button data-tp="installPaste">${C.esc(t('tplInstall'))}</button></div>
      <h4>${C.esc(t('tplOptions'))}</h4>
      <div class="row"><label><input type="checkbox" data-set="useBase"${tpl.useBase ? ' checked' : ''}> ${C.esc(t('tplUseBase'))}</label></div>
      <div class="row"><label><input type="checkbox" data-set="match"${r.match ? ' checked' : ''}> ${C.esc(t('tplRuleMatch'))}</label>
        <input type="number" min="0" max="100" data-set="matchMin" value="${r.matchMin}">${C.esc(t('tplRuleMatchB'))}</div>
      <div class="row"><label><input type="checkbox" data-set="cold"${r.cold ? ' checked' : ''}> ${C.esc(t('tplRuleCold'))}</label>
        <input type="number" min="0" max="100" data-set="coldPct" value="${r.coldPct}">${C.esc(t('tplRuleColdB'))}</div>
      <div class="row">${C.esc(t('tplManyA'))}<input type="number" min="1" max="99" data-set="manyAt" value="${r.manyAt}">${C.esc(t('tplManyB'))}
        <input type="number" min="1" max="20" data-set="spellings" value="${r.spellings}">${C.esc(t('tplManyC'))}</div>
    </div>`;
  }

  function installPack(text, source) {
    try {
      const raw = typeof text === 'string' ? JSON.parse(text) : text;
      const pk = C.parsePack(raw);
      const i = tpl.packs.findIndex(p => p.raw.id === pk.id);
      const entry = { raw, source: source || (i >= 0 ? tpl.packs[i].source : '') };
      if (i >= 0) tpl.packs[i] = entry; else tpl.packs.push(entry);
      parsed.delete(pk.id);
      tpl.current = pk.id;
      // Picks that no longer exist in the new version are dropped
      tpl.picks = tpl.picks.filter(id => pk.items.has(id));
      saveTpl();
      toast(t('tplInstalled', pk.name, pk.items.size));
      return true;
    } catch (e) {
      toast(t('tplInstallFailed', C.errMsg(e)));
      return false;
    }
  }

  // Fetched by the service worker: Tumblr's page CSP doesn't apply there
  async function fetchText(url) {
    const r = await chrome.runtime.sendMessage({ type: 'fetchText', url });
    if (r?.error) throw new Error(r.error);
    return r.text;
  }
  async function installFromUrl(url) {
    url = String(url || '').trim();
    if (!url) return;
    try { if (installPack(await fetchText(url), url)) renderTpl(); } catch (e) { toast(t('tplInstallFailed', C.errMsg(e))); }
  }

  const copyText = text => navigator.clipboard?.writeText(text);

  async function insertTags(tags) {
    if (tplInsert) { closeTpl(); return tplInsert(C.sortTagsFair(tags, tplStats(), fairOpts())); }
    const el = tagInput();
    if (!el) { copyText(tags.join(', ')); toast(t('tplNoInput')); return; }
    closeTpl();
    // Inserting again replaces what the panel inserted last time in this editor: those tags come out first and
    // the new list goes in, in order. Tags typed by hand are never touched.
    const prev = insertedBy.get(el) || new Set();
    const removed = await removeInserted(el, prev);
    const have = new Set(readEditorTags(el).map(C.key));
    const order = C.sortTagsFair(tags, tplStats(), fairOpts());
    const added = [];
    for (const tag of order) {
      if (have.has(C.key(tag))) continue;
      commitNative(el, tag);
      added.push(C.key(tag));
      await C.sleep(120);
    }
    // still tracked: what was added now, plus last time's tags that could not be removed and are still wanted
    insertedBy.set(el, new Set([...added, ...[...prev].filter(k => have.has(k) && order.some(tg => C.key(tg) === k))]));
    const left = [...prev].filter(k => have.has(k) && !order.some(tg => C.key(tg) === k)).length;
    // report the net change: tags taken out only to go back in, in order, don't count
    const wanted = new Set(order.map(C.key));
    const gone = Math.min(removed, [...prev].filter(k => !wanted.has(k)).length);
    toast(prev.size ? t('tplUpdated', gone, added.filter(k => !prev.has(k)).length) : t('tplInserted', added.length));
    if (left) setTimeout(() => toast(t('tplNotRemoved', left)), 2500);
  }

  // Tags the panel inserted, per tags input, so a wrong pick can be undone or replaced
  const insertedBy = new WeakMap();
  const hasInserted = () => { const el = tagInput(); return !tplInsert && !!(el && insertedBy.get(el)?.size); };
  async function removeInserted(el, keys) {
    let n = 0;
    for (const c of editorChips(el)) {
      if (!keys.has(C.key(c.tag))) continue;
      c.remove();
      n++;
      await C.sleep(80);
    }
    return n;
  }
  async function undoInsert() {
    const el = tagInput();
    const prev = el && insertedBy.get(el);
    if (!prev?.size) return;
    closeTpl();
    const n = await removeInserted(el, prev);
    insertedBy.delete(el);
    toast(t('tplUndone', n));
    const left = readEditorTags(el).filter(tg => prev.has(C.key(tg))).length;
    if (left) setTimeout(() => toast(t('tplNotRemoved', left)), 2500);
  }

  // Sample tags without a fresh entry in cache.tagStats
  let tplChecking = null;
  async function checkTags(tags) {
    if (tplChecking) return;
    cache.tagStats ||= {};
    const todo = tags.filter(tg => !C.statFresh(cache.tagStats[C.key(tg)]));
    if (!todo.length) return toast(t('tplAllFresh'));
    const ctl = tplChecking = { aborted: false };
    const failed = await C.ensureTagStats(api, cache, todo, {
      ctl, save, onProgress: (i, n) => status(t('tplChecking', i, n), () => { ctl.aborted = true; }),
    });
    tplChecking = null;
    await save();
    const cold = composeNow()?.rows.filter(row => row.on && row.flag).length || 0;
    status(t('tplCheckDone', todo.length, cold, failed));
    renderPreview();
  }

  // ----- Pack upkeep: suggest tag changes per character / relation from fresh samples, apply what the user ticks -----
  // Tags mostly used by another fandom (offtopic) are ticked for removal by default; nothing else is.
  // Add candidates are sampled too and dropped when they turn out to belong to another fandom.
  let tplReview = null;
  const reviewCount = () => tplReview.items.reduce((n, it) => n + [...it.remove, ...it.add].filter(x => x.on).length, 0);
  async function reviewPack(id) {
    const pk = packById(id);
    if (!pk || tplChecking) return;
    const ctl = tplChecking = { aborted: false };
    const progress = (i, n) => status(t('tplReviewing', i, n), () => { ctl.aborted = true; });
    try {
      await C.ensureTagStats(api, cache, C.packTags(pk), { ctl, save, onProgress: progress });
      const stats = cache.tagStats;
      const targets = [...pk.items.values()].filter(it => (it.kind === 'char' || it.rel) && it.tags.length);
      const items = targets.map(it => ({ it, ...C.suggestTagChanges(it.tags, stats, { exclude: pk.base, fandom: pk.base, rules: tpl.rules }) }));
      const candidates = [...new Set(items.flatMap(x => x.add.map(a => a.tag)))];
      if (!ctl.aborted) await C.ensureTagStats(api, cache, candidates, { ctl, save, onProgress: progress });
      tplReview = { packId: id, items: [] };
      for (const x of items) {
        const add = x.add.map(a => ({ ...a, fit: C.fandomShare(a.tag, stats[C.key(a.tag)], pk.base), on: false }))
          .filter(a => a.fit === null || a.fit >= C.OFFTOPIC_SHARE);
        const remove = x.remove.map(r => ({ ...r, on: r.reason === 'offtopic' }));
        if (add.length || remove.length) tplReview.items.push({ id: x.it.id, name: x.it.name, add, remove });
      }
      statusBox.hidden = true;
      tplView = 'review';
      renderTpl();
    } catch (e) {
      status(C.errMsg(e));
    } finally {
      tplChecking = null;
    }
  }

  function reviewHtml() {
    const pk = packById(tplReview.packId);
    const why = r => (r.reason === 'offtopic' ? t('why_offtopic', Math.round(r.share * 100))
      : r.reason === 'fuzzy' ? t('why_fuzzy', r.match) : r.reason === 'dead' ? t('why_dead') : t('why_cold', r.rank, r.of));
    const box = (i, side, j, x, label, title) => `<label class="tp-rv${x.reason === 'offtopic' ? ' bad' : ''}" title="${C.esc(title)}">`
      + `<input type="checkbox" data-rv="${i}:${side}:${j}"${x.on ? ' checked' : ''}> #${C.esc(x.tag)} <small>${C.esc(label)}</small></label>`;
    const body = tplReview.items.map((it, i) => `<div class="tp-pk"><div class="nm">${C.esc(it.name)}</div>`
      + (it.remove.length ? `<div class="sub">${C.esc(t('tplRmTitle'))}</div>` + it.remove.map((r, j) => box(i, 'remove', j, r, why(r), why(r))).join('') : '')
      + (it.add.length ? `<div class="sub">${C.esc(t('tplAddTitle'))}</div>` + it.add.map((a, j) =>
        box(i, 'add', j, a, t('tplShare', Math.round(a.share * 100)), a.fit === null ? t('tplFitUnknown') : '')).join('') : '')
      + '</div>').join('');
    return `<div class="tp-body tp-m"><h4>${C.esc(t('tplReviewTitle', pk?.name || ''))}</h4>${body || `<p class="hint">${C.esc(t('tplReviewNone'))}</p>`}</div>
      <div class="tp-f"><span class="sp"></span><button class="pri" data-tp="applyReview">${C.esc(t('tplApply', reviewCount()))}</button></div>`;
  }

  // Write ticked changes into the installed pack's raw JSON, whichever shape it uses
  function applyReview() {
    const entry = tpl.packs.find(p => p.raw.id === tplReview.packId);
    if (!entry) return;
    const raw = JSON.parse(JSON.stringify(entry.raw));
    const all = [...(raw.characters || []), ...(Array.isArray(raw.relations) ? raw.relations : []), ...(raw.sections || []).flatMap(s => s.items || [])];
    let n = 0;
    for (const it of tplReview.items) {
      const target = all.find(x => x.id === it.id);
      if (!target) continue;
      const drop = new Set(it.remove.filter(r => r.on).map(r => C.key(r.tag)));
      const before = target.tags || [];
      const kept = before.filter(tg => !drop.has(C.key(tg)));
      target.tags = C.withTags(kept, it.add.filter(a => a.on).map(a => a.tag));
      n += (before.length - kept.length) + (target.tags.length - kept.length);
    }
    if (!n) return;
    C.parsePack(raw);
    entry.raw = raw;
    entry.edited = true;
    parsed.delete(raw.id);
    saveTpl();
    toast(t('tplApplied', n));
    tplReview = null;
    tplView = 'manage';
    renderTpl();
  }

  tplEl.addEventListener('mousedown', e => {
    // Clicking chips must not steal focus from the search box or the editor
    if (e.target.closest('.tp-c, .tp-t')) e.preventDefault();
  });
  tplEl.addEventListener('click', e => {
    const pack = currentPack();
    const favDel = e.target.closest('[data-favdel]');
    if (favDel) {
      const f = tpl.favs[+favDel.dataset.favdel];
      if (f && confirm(t('tplRemoveFav', f.name))) { tpl.favs.splice(+favDel.dataset.favdel, 1); saveTpl(); renderPickBody(pack); }
      return;
    }
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      const f = tpl.favs[+fav.dataset.fav];
      if (f) { tpl.picks = f.ids.filter(id => pack.items.has(id)); saveTpl(); renderPickBody(pack); }
      return;
    }
    const dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) { tplDismissed.add(dismiss.dataset.dismiss); renderPickBody(pack); return; }
    const item = e.target.closest('[data-item]');
    if (item) {
      const id = item.dataset.item;
      const it = pack.items.get(id);
      // A preset just picks its members and relations, which can then be unticked one by one
      if (it?.kind === 'preset') tpl.picks = [...new Set([...tpl.picks, ...it.with])];
      // dropping someone also drops the relations they are part of, which would otherwise pull them back in
      else if (tpl.picks.includes(id)) {
        const involves = x => !!pack.items.get(x)?.rel && pack.items.get(x).with.includes(id);
        tpl.picks = tpl.picks.filter(x => x !== id && !involves(x));
      }
      else tpl.picks = [...tpl.picks, id];
      // editing posts: once clicked, a "partly" item is no longer left alone
      tplEdit?.keepSome.delete(id);
      if (!item.dataset.combo) tplDismissed = new Set();
      saveTpl();
      renderPickBody(pack);
      return;
    }
    const tagEl = e.target.closest('[data-tag]');
    if (tagEl) {
      const k = C.key(tagEl.dataset.tag);
      const row = composeNow().rows.find(r => C.key(r.tag) === k);
      // Flip what the row shows now; a flip back to the computed state clears the override
      const want = !row.on;
      delete tpl.overrides[k];
      const plain = composeNow().rows.find(r => C.key(r.tag) === k);
      if (plain.on !== want) tpl.overrides[k] = want;
      saveTpl();
      renderPreview();
      return;
    }
    const btn = e.target.closest('[data-tp]');
    if (!btn) return;
    const act = btn.dataset.tp;
    if (act === 'close') closeTpl();
    else if (act === 'manage' || act === 'pick') { tplView = act; renderTpl(); }
    else if (act === 'undo') undoInsert();
    else if (act === 'clear') { tpl.picks = []; saveTpl(); renderPickBody(pack); }
    else if (act === 'dropFlagged') {
      for (const r of composeNow().rows) if (r.on && r.flag) tpl.overrides[C.key(r.tag)] = false;
      saveTpl();
      renderPreview();
    }
    else if (act === 'check') {
      const res = composeNow();
      if (!res?.rows.length) return toast(t('tplPickFirst'));
      checkTags(res.rows.map(r => r.tag));
    } else if (act === 'fav') {
      if (!tpl.picks.length) return toast(t('tplPickFirst'));
      const name = prompt(t('tplFavName'), tpl.picks.map(id => pack.items.get(id)?.name).join(' + '));
      if (name) { tpl.favs.push({ pack: pack.id, name, ids: tpl.picks.slice() }); saveTpl(); renderPickBody(pack); }
    } else if (act === 'insert' && tplEdit) {
      const { add, drop } = editPlan(pack);
      if (!add.length && !drop.length) return toast(t('tplNoChange'));
      const { apply } = tplEdit, opts = editOpts(add, drop);
      closeTpl();
      apply(pack, opts);
    } else if (act === 'copy' || act === 'insert') {
      const res = composeNow();
      if (!res?.tags.length) return toast(t('tplPickFirst'));
      if (act === 'copy') { copyText(C.sortTagsFair(res.tags, tplStats(), fairOpts()).join(', ')); toast(t('tplCopied')); } else insertTags(res.tags);
    } else if (act === 'installUrl') installFromUrl(tplEl.querySelector('.tp-url').value);
    else if (act === 'file') tplEl.querySelector('.tp-file').click();
    else if (act === 'installPaste') { if (installPack(tplEl.querySelector('.tp-paste').value)) renderTpl(); }
    else if (act === 'update') {
      const entry = tpl.packs.find(p => p.raw.id === btn.dataset.pack);
      if (entry && (!entry.edited || confirm(t('tplUpdateEdited')))) installFromUrl(entry.source);
    } else if (act === 'review') reviewPack(btn.dataset.pack);
    else if (act === 'export') {
      const entry = tpl.packs.find(p => p.raw.id === btn.dataset.pack);
      if (entry) { copyText(JSON.stringify(entry.raw, null, 1)); toast(t('tplCopied')); }
    } else if (act === 'applyReview') applyReview();
    else if (act === 'applyUpkeep' && tplUpk) {
      const { apply, sel } = tplUpk, ids = upkTargets().map(p => p.id);
      closeTpl();
      apply(new Set(sel), ids);
    }
    else if (act === 'checkpack') { const pk = packById(btn.dataset.pack); if (pk) checkTags(C.packTags(pk)); }
    else if (act === 'remove') {
      const entry = tpl.packs.find(p => p.raw.id === btn.dataset.pack);
      if (!entry || !confirm(t('tplConfirmRemove', entry.raw.name || entry.raw.id))) return;
      tpl.packs = tpl.packs.filter(p => p !== entry);
      tpl.favs = tpl.favs.filter(f => f.pack !== entry.raw.id);
      if (tpl.current === entry.raw.id) { tpl.current = tpl.packs[0]?.raw.id || ''; tpl.picks = []; }
      parsed.delete(entry.raw.id);
      saveTpl();
      renderTpl();
    }
  });
  tplEl.addEventListener('change', e => {
    if (e.target.dataset.upk && tplUpk) {
      if (e.target.checked) tplUpk.sel.add(e.target.dataset.upk); else tplUpk.sel.delete(e.target.dataset.upk);
      renderTpl();
      return;
    }
    if (e.target.dataset.rv) {
      const [i, side, j] = e.target.dataset.rv.split(':');
      tplReview.items[+i][side][+j].on = e.target.checked;
      tplEl.querySelector('[data-tp="applyReview"]').textContent = t('tplApply', reviewCount());
      return;
    }
    if (e.target.classList.contains('tp-pack')) {
      tpl.current = e.target.value; tpl.picks = []; tplQuery = '';
      if (tplEdit) resetEdit(); // editing posts: read them again against the other pack
      saveTpl(); renderTpl();
    } else if (e.target.classList.contains('tp-file')) {
      const f = e.target.files?.[0];
      if (f) f.text().then(text => { if (installPack(text)) renderTpl(); });
    } else if (e.target.dataset.set) {
      const k = e.target.dataset.set, v = e.target.type === 'checkbox' ? e.target.checked : Math.max(0, +e.target.value || 0);
      if (k === 'useBase') tpl.useBase = v;
      else tpl.rules = { ...tpl.rules, [k]: v };
      saveTpl();
    }
  });

  // ---------- Official mass editor (/mega-editor/<box>/<blog>) ----------
  // A legacy jQuery page. Posts are <a class="brick" id="post_<id>"> tiles whose inline onclick toggles
  // .highlighted; selecting more than 100 makes the page alert(). Its tag removal reads the checked
  // labels' HTML, so those labels must never be edited: decoded names are added beside them instead.
  const ME_MAX = 100;
  const ME_CSS = `
/* The official popup is a fixed 348x229 box with a background image and absolutely placed parts;
   turn it into a larger white card and re-place the list, our bar and the official buttons */
#remove_tags_widget.tth-wide { width: 460px !important; height: min(70vh, 560px) !important; padding: 0 !important;
  background: #fff !important; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
#remove_tags_widget.tth-wide #tags { left: 16px !important; right: 16px !important; width: auto !important;
  top: 52px !important; bottom: 56px !important; height: auto !important; font-size: 12px !important; }
#remove_tags_widget.tth-wide #tags > div { padding: 2px 0; }
#remove_tags_widget.tth-wide > div[style*="bottom:38px"] { bottom: 14px !important; }
#remove_tags_widget.tth-wide .tth-rt-bar { position: absolute; left: 16px; right: 16px; top: 12px; }
.tth-rt-bar { display: flex; gap: 8px; align-items: center; }
.tth-rt-filter { flex: 1; padding: 4px 6px; border: 1px solid #bbb; border-radius: 3px; font-size: 13px; }
.tth-rt-bar a { color: #529ecc; font-size: 12px; text-decoration: none; }
.tth-rt-status { color: #888; font-size: 12px; }
#tags .tth-count { color: #888; font-size: 11px; margin-left: 6px; }
#tags .tth-fill { margin-left: 4px; border: 0; background: none; color: #529ecc; cursor: pointer; font-size: 14px; padding: 0 2px; }
#tags .tth-hide { display: none; }
#tags .tth-name { cursor: pointer; }
.tth-labels-row { margin-top: 8px; }
.brick .tth-tile-tags { font-size: 10px; line-height: 1.3; max-height: 5.2em; overflow: hidden; word-break: break-word; margin-top: 2px; }
/* Multi-image posts: the official tile only shows the first image */
.brick .tth-mosaic { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #fff; z-index: 1; pointer-events: none; }
.brick .tth-mosaic img { width: 100%; height: 100%; object-fit: cover; display: block; min-height: 0; }
.brick .tth-mosaic.n2 { grid-template-rows: 1fr; }
.brick .tth-mosaic.n3 img:first-child { grid-row: span 2; }
.brick .tth-mosaic.n4 { grid-template-rows: 1fr 1fr; }
.brick.highlighted .tth-mosaic { opacity: .55; }
.brick .overlay { z-index: 2; }
.brick .tth-imgcount { position: absolute; right: 4px; bottom: 4px; background: rgba(0,0,0,.65); color: #fff; font-size: 10px; line-height: 1.4; padding: 0 4px; border-radius: 3px; z-index: 3; pointer-events: none; }
.brick.tth-copy { opacity: .5; cursor: not-allowed; }
.brick .tth-sync { position: absolute; bottom: 4px; left: 4px; background: #555; color: #fff; font-size: 10px; line-height: 1.4; padding: 0 4px; border-radius: 3px; z-index: 3; pointer-events: none; }
.brick .tth-badge { position: absolute; top: 4px; left: 4px; background: #f5a623; color: #fff; font-size: 10px; line-height: 1.4; padding: 0 4px; border-radius: 3px; z-index: 3; pointer-events: none; }
`;

  // "Add tags" popup: mega-main.js feeds the official jQuery UI autocomplete with this list. The tokens are
  // the tags already in the box, official the page's own suggestion list.
  function megaSuggest({ term, tokens, official }) {
    const have = tokens.map(C.norm).filter(Boolean);
    const mine = C.suggest(index, term, have, have, 15).map(s => s.tag);
    const q = C.key(term);
    const extra = official.filter(tg => !mine.some(m => C.key(m) === C.key(tg)) && !have.some(h => C.key(h) === C.key(tg)) && (!q || C.key(tg).includes(q)));
    return [...mine, ...extra].slice(0, 15);
  }

  function initMassEditor() {
    const blogName = location.pathname.split('/').filter(Boolean)[2];
    const nav = document.querySelector('.editor_navigation');
    if (!blogName || !nav) return;
    const style = document.createElement('style');
    style.textContent = ME_CSS;
    document.head.appendChild(style);

    const blogUuid = () => cache.blogList.find(b => b.name.toLowerCase() === blogName.toLowerCase())?.uuid;
    const selectedIds = () => [...document.querySelectorAll('.brick.highlighted')].map(b => b.id.replace(/^post_/, ''));
    const liveTags = new Map(); // post id -> tags read from the API during this page view
    const cachedRec = id => index.postTags.get(id)?.rec;
    // reblogs of my own posts, from the synced cache (refreshed with the tiles)
    let copySet = C.copyKeys(cache), copyWarned = false;
    const isCopyId = id => !!blogUuid() && copySet.has(blogUuid() + ':' + id);

    // Current tags of the given posts, read from the API (6 at a time) and remembered for this page view
    async function fetchTags(ids) {
      const todo = ids.filter(id => !liveTags.has(id));
      let i = 0;
      const worker = async () => {
        while (i < todo.length) {
          const id = todo[i++];
          try { liveTags.set(id, ((await C.getPost(api, blogName, id)).tags || []).slice()); }
          catch { liveTags.set(id, cachedRec(id)?.[0] || []); }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      return ids.map(id => liveTags.get(id) || []);
    }

    // ----- Bulk edits through the API, for what the official editor can't do -----
    let running = null;
    function afterEdit(id, r) {
      liveTags.set(id, r.tags.slice());
      const rec = cache.blogs[blogUuid()]?.posts?.[id];
      if (rec) { rec[0] = C.uniqTags(r.tags); rec[2] = r.state; rec[6] = r.reblog; }
      const count = document.getElementById('tag_count_' + id);
      if (count) count.textContent = count.textContent.replace(/\d+/, String(r.tags.length));
      const brick = document.getElementById('post_' + id);
      if (brick) markBrick(brick, true);
    }

    async function runOnPosts(title, mutate, opts = {}) {
      if (running) return;
      // reblogs of my own posts are never edited directly: they follow their original
      const ids = (opts.ids || selectedIds()).filter(id => !isCopyId(id));
      if (!ids.length) return toast(t('needSelect'));
      if (!confirm(t('confirmRun', title, ids.length))) return;
      const ctl = running = { aborted: false };
      const notes = [];
      let ok = 0, skip = 0, fail = 0;
      for (let i = 0; i < ids.length && !ctl.aborted; i++) {
        status(t('progress', title, i + 1, ids.length), () => { ctl.aborted = true; });
        try {
          const r = await C.editPost(api, t, blogName, ids[i], mutate, opts.verifyLabel);
          if (r.skipped) { skip++; if (!r.unchanged) notes.push(t('logSkip', ids[i], r.reason)); }
          else {
            ok++;
            afterEdit(ids[i], r);
            // the same tags, visibility and label for its reblogs (or original) on my other blogs
            if (settings.syncReblogs && blogUuid()) {
              const n = await C.syncCopies(api, t, cache, blogUuid(), ids[i], r);
              if (n) notes.push(t('logSynced', ids[i], n));
            }
          }
        } catch (e) {
          fail++;
          notes.push(t('logFail', ids[i], C.errMsg(e)));
        }
        await C.sleep(400);
      }
      running = null;
      await save();
      rebuildIndex();
      status([t('logDone', title, ctl.aborted, ok, skip, fail), ...notes].join('\n'));
      opts.onDone?.();
    }

    // ----- Toolbar buttons, styled like the official ones -----
    function headerButton(id, label, after, onClick) {
      const wrap = document.createElement('div');
      wrap.className = 'header_button';
      wrap.innerHTML = `<button type="button" id="${id}" class="chrome big_dark"><div class="chrome_button">${C.esc(label)}<div class="chrome_button_left"></div><div class="chrome_button_right"></div></div></button>`;
      after.after(wrap);
      wrap.querySelector('button').addEventListener('click', onClick);
      return wrap;
    }
    const privateBtn = document.getElementById('make_posts_private')?.closest('.header_button');
    if (privateBtn) {
      // "Make public" next to the official "Make private"
      const pub = headerButton('tth_make_public', t('setPublic'), privateBtn, () =>
        runOnPosts(t('setPublic'), C.mutations.state(t, stateName, 'published')));
      // Tumblr's reblog control, which the mass editor doesn't offer: one button with a small menu, so the
      // toolbar stays on one line
      const menu = root.querySelector('.dd.menu');
      const rbWrap = headerButton('tth_reblog', t('reblogCtl') + ' ▾', pub, e => {
        e.stopPropagation();
        if (!menu.hidden) { menu.hidden = true; return; }
        const r = e.currentTarget.getBoundingClientRect();
        menu.innerHTML = [['noone', 'reblogDeny'], ['everyone', 'reblogAllow']]
          .map(([mode, k]) => `<div class="it" data-mode="${mode}"><span>${C.esc(t(k))}</span></div>`).join('');
        Object.assign(menu.style, { left: r.left + 'px', top: (r.bottom + 4) + 'px' });
        menu.hidden = false;
      });
      menu.addEventListener('click', e => {
        const it = e.target.closest('.it');
        if (!it) return;
        menu.hidden = true;
        runOnPosts(t(it.dataset.mode === 'noone' ? 'reblogDeny' : 'reblogAllow'), C.mutations.reblog(it.dataset.mode));
      });
      document.addEventListener('click', () => { menu.hidden = true; });
      // Reorder each selected post's tags, most popular sitewide first
      const sortWrap = headerButton('tth_sort_heat', t('sortHeat'), rbWrap, async () => {
        if (running) return;
        const ids = selectedIds();
        if (!ids.length) return toast(t('needSelect'));
        const ctl = running = { aborted: false };
        const stop = () => { ctl.aborted = true; };
        status(t('meReading'), stop);
        const tagLists = await fetchTags(ids);
        await C.ensureTagStats(api, cache, tagLists.flat(), { ctl, save, onProgress: (i, n) => status(t('heatChecking', i, n), stop) });
        running = null;
        if (ctl.aborted) return status(t('logDone', t('sortHeat'), true, 0, 0, 0));
        runOnPosts(t('sortHeat'), C.mutations.sortByHeat(cache.tagStats, fairOpts()), { ids });
      });
      // The tag template panel: what it inserts is added to every selected post, in the template's order
      // The tag template panel in edit mode: it starts from what the selected posts carry; applying adds and
      // takes out characters and relations on all of them
      const tplWrap = headerButton('tth_templates', t('tplOpen'), sortWrap, async () => {
        if (!tplEl.hidden) return closeTpl();
        if (running) return;
        const ids = selectedIds();
        if (!ids.length) return toast(t('needSelect'));
        status(t('meReading'));
        const tagLists = await fetchTags(ids);
        statusBox.hidden = true;
        openTplEdit(tagLists, tplWrap.querySelector('button'), (pack, opts) =>
          runOnPosts(t('actRetag'), C.mutations.retag(pack, opts, t), { ids }));
      });
      // insert from the panel outside edit mode (not reached from the mass editor's button, kept for safety)
      tplInsert = tags => runOnPosts(t('actTagsAdd', tags.map(tg => '#' + tg).join(' ')), C.mutations.addTags(tags));
      // Bring the selected posts in line with the installed packs: list the changes first, apply the ticked ones
      const upkWrap = headerButton('tth_upkeep', t('meUpkeep'), tplWrap, async () => {
        if (!tplEl.hidden) return closeTpl();
        if (running) return;
        if (!installedPacks().length) return toast(t('upkNeedPack'));
        const ids = selectedIds().filter(id => !isCopyId(id));
        if (!ids.length) return toast(t('needSelect'));
        status(t('meReading'));
        const tagLists = await fetchTags(ids);
        statusBox.hidden = true;
        openTplUpkeep(ids.map((id, i) => ({ key: id, id, tags: tagLists[i] })), upkWrap.querySelector('button'), (allow, targets) =>
          runOnPosts(t('meUpkeep'), C.mutations.upkeep(installedPacks(), allow, t), { ids: targets }));
      });
    }

    // ----- Content labels popup: the official one can only add labels -----
    const labelsWidget = document.getElementById('add_community_labels_widget');
    if (labelsWidget) {
      const row = document.createElement('div');
      row.className = 'tth-labels-row';
      row.innerHTML = `<button type="button" id="tth_remove_labels" class="chrome"><div class="chrome_button"><div class="chrome_button_left"></div><span>${C.esc(t('labelOff'))}</span><div class="chrome_button_right"></div></div></button>`;
      labelsWidget.querySelector('div')?.appendChild(row);
      row.querySelector('button').addEventListener('click', () =>
        runOnPosts(t('labelOff'), C.mutations.labels([]), { verifyLabel: true }));
    }

    // Official tag edits change posts behind our back; re-read tags next time
    for (const id of ['add_tag_button', 'remove_tag_button']) document.getElementById(id)?.addEventListener('click', () => liveTags.clear());

    // ----- "Edit tags" popup: wider, filterable, with counts and ⊕ fill -----
    const rtWidget = document.getElementById('remove_tags_widget');
    const rtList = document.getElementById('tags');
    if (rtWidget && rtList) {
      rtWidget.classList.add('tth-wide');
      const bar = document.createElement('div');
      bar.className = 'tth-rt-bar';
      bar.innerHTML = `<input type="text" class="tth-rt-filter" placeholder="${C.esc(t('meFilter'))}">
        <a href="#" data-a="all">${C.esc(t('meAll'))}</a><a href="#" data-a="none">${C.esc(t('meNone'))}</a><span class="tth-rt-status"></span>`;
      rtList.before(bar);
      const filter = bar.querySelector('.tth-rt-filter');
      const statusEl = bar.querySelector('.tth-rt-status');
      const rows = () => [...rtList.children].filter(r => r.querySelector('input[type=checkbox]'));
      const rowTag = r => r.querySelector('label')?.textContent || '';
      const applyFilter = () => {
        const q = C.key(filter.value);
        for (const r of rows()) r.style.display = !q || C.key(rowTag(r)).includes(q) ? '' : 'none';
      };
      filter.addEventListener('input', applyFilter);
      filter.addEventListener('keydown', e => e.stopPropagation()); // keep the page's shortcuts out of the filter box
      bar.addEventListener('click', e => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        e.preventDefault();
        for (const r of rows()) if (r.style.display !== 'none') r.querySelector('input[type=checkbox]').checked = a.dataset.a === 'all';
      });

      let seq = 0, reordering = false;
      async function enhanceRows() {
        if (reordering) return;
        const list = rows();
        if (!list.length) return;
        const my = ++seq;
        for (const r of list) {
          if (r.dataset.tth) continue;
          r.dataset.tth = '1';
          const label = r.querySelector('label'), box = r.querySelector('input[type=checkbox]');
          const raw = label.textContent, nice = C.norm(raw);
          if (nice !== raw.trim()) {
            label.classList.add('tth-hide');
            const span = document.createElement('span');
            span.className = 'tth-name';
            span.textContent = nice;
            span.addEventListener('click', () => { box.checked = !box.checked; });
            label.after(span);
          }
        }
        applyFilter();
        statusEl.textContent = t('meReading');
        const ids = selectedIds();
        const tagLists = await fetchTags(ids);
        if (my !== seq) return;
        const counts = new Map();
        for (const tags of tagLists) for (const tg of C.uniqTags(tags)) counts.set(C.key(tg), (counts.get(C.key(tg)) || 0) + 1);
        for (const r of rows()) {
          const k = C.key(rowTag(r)), n = counts.get(k) || 0;
          r.dataset.count = n;
          r.querySelectorAll('.tth-count, .tth-fill').forEach(x => x.remove());
          const c = document.createElement('span');
          c.className = 'tth-count';
          c.textContent = `${n}/${ids.length}`;
          c.title = [t('meCount', n, ids.length), C.heatText(t, cache.tagStats?.[k])].filter(Boolean).join(' · ');
          r.appendChild(c);
          if (n > 0 && n < ids.length) {
            const fill = document.createElement('button');
            fill.type = 'button';
            fill.className = 'tth-fill';
            fill.textContent = '⊕';
            fill.title = t('meFill');
            fill.addEventListener('click', () => {
              const tag = C.norm(rowTag(r));
              const missing = ids.filter((id, j) => !tagLists[j].some(x => C.key(x) === k));
              runOnPosts(t('actTagsAdd', '#' + tag), C.mutations.addTags([tag]), { ids: missing, onDone: enhanceRows });
            });
            r.appendChild(fill);
          }
        }
        reordering = true;
        rows().sort((a, b) => (+b.dataset.count) - (+a.dataset.count)).forEach(r => rtList.appendChild(r));
        reordering = false;
        statusEl.textContent = '';
      }
      new MutationObserver(C.debounce(enhanceRows, 50)).observe(rtList, { childList: true });
      document.getElementById('remove_tags')?.addEventListener('click', () => { filter.value = ''; });
    }

    // ----- Tiles: tag names on hover, a badge on private posts -----
    function markBrick(b, force) {
      if (b.dataset.tthMarked && !force) return;
      b.dataset.tthMarked = '1';
      const id = b.id.replace(/^post_/, '');
      const rec = cachedRec(id);
      if (isCopyId(id) && !b.classList.contains('tth-copy')) {
        b.classList.add('tth-copy');
        b.title = t('copyTitle', rec[4]);
        const sync = document.createElement('span');
        sync.className = 'tth-sync';
        sync.textContent = t('copyBadge');
        b.appendChild(sync);
      }
      b.querySelector('.tth-badge')?.remove();
      if (rec?.[2] === 'private') {
        const badge = document.createElement('span');
        badge.className = 'tth-badge';
        badge.textContent = stateName('private');
        b.appendChild(badge);
      }
      const tags = liveTags.get(id) || rec?.[0];
      const inner = b.querySelector('.overlay .inner');
      if (inner && tags) {
        let el = inner.querySelector('.tth-tile-tags');
        if (!el) { el = document.createElement('div'); el.className = 'tth-tile-tags'; inner.appendChild(el); }
        el.textContent = C.uniqTags(tags).map(tg => '#' + tg).join(' ');
      }
    }
    const markAll = () => { copySet = C.copyKeys(cache); document.querySelectorAll('.brick').forEach(b => markBrick(b)); };
    markAll();
    const content = document.querySelector('.l-content') || document.body;
    new MutationObserver(C.debounce(markAll, 200)).observe(content, { childList: true, subtree: true });

    // ----- Tiles: multi-image posts show a mosaic, an image count and a hover preview of all images -----
    const images = new Map(); // post id -> [{small, big}]
    const boxSeg = location.pathname.split('/').filter(Boolean)[1];
    const box = { draft: 'draft', drafts: 'draft', queue: 'queue', queued: 'queue' }[boxSeg] || '';
    let imgPath = C.basePosts(blogName, {}, box), imgLoading = false, imgPages = 0;
    function markImages(b) {
      const imgs = images.get(b.id.replace(/^post_/, ''));
      if (!imgs || imgs.length < 2 || b.querySelector('.tth-mosaic')) return;
      const m = document.createElement('div');
      m.className = 'tth-mosaic n' + Math.min(imgs.length, 4);
      m.innerHTML = imgs.slice(0, 4).map(i => `<img src="${C.esc(i.small)}" alt="" loading="lazy">`).join('');
      b.appendChild(m);
      const c = document.createElement('span');
      c.className = 'tth-imgcount';
      c.textContent = '🖼 ' + imgs.length;
      b.appendChild(c);
    }
    // Read posts page by page (20 per request) while some tile on the page is still unknown
    async function loadImages() {
      if (imgLoading) return;
      imgLoading = true;
      try {
        const missing = () => [...document.querySelectorAll('.brick')].some(b => !images.has(b.id.replace(/^post_/, '')));
        while (imgPath && missing() && imgPages < 200) {
          const r = await api(imgPath);
          const got = r?.posts || [];
          for (const p of got.filter(C.isPost)) images.set(C.postId(p), C.postImages(p));
          imgPages++;
          imgPath = got.length ? C.nextPath(r, blogName, {}, imgPages * 20, got.length >= 20, box) : null;
          document.querySelectorAll('.brick').forEach(markImages);
          await C.sleep(150);
        }
      } catch { /* tiles just keep the official single image */ }
      imgLoading = false;
    }
    loadImages();
    new MutationObserver(C.debounce(loadImages, 400)).observe(content, { childList: true, subtree: true });

    const preview = root.querySelector('.preview');
    let previewTimer = null, previewFor = null;
    document.addEventListener('mouseover', e => {
      const b = e.target.closest?.('.brick');
      if (b === previewFor) return;
      clearTimeout(previewTimer);
      preview.hidden = true;
      previewFor = b;
      const imgs = b && images.get(b.id.replace(/^post_/, ''));
      if (!imgs || imgs.length < 2) return;
      previewTimer = setTimeout(() => {
        if (drag || previewFor !== b) return;
        preview.innerHTML = `<div class="h">${C.esc(t('imagesN', imgs.length))}</div><div class="g">${imgs.map(i => `<img src="${C.esc(i.big)}" alt="">`).join('')}</div>`;
        preview.hidden = false;
        const r = b.getBoundingClientRect();
        const w = preview.offsetWidth, h = preview.offsetHeight;
        const left = r.right + 8 + w <= innerWidth ? r.right + 8 : Math.max(4, r.left - 8 - w);
        preview.style.left = left + 'px';
        preview.style.top = Math.max(4, Math.min(r.top, innerHeight - h - 4)) + 'px';
      }, 350);
    });
    document.addEventListener('mousedown', () => { clearTimeout(previewTimer); preview.hidden = true; }, true);

    // ----- Tiles: drag to select, Shift+click for a range, Ctrl+A (all capped at 100) -----
    const isSel = b => b.classList.contains('highlighted');
    const selCount = () => document.querySelectorAll('.brick.highlighted').length;
    let limitWarned = false;
    // Toggle through the tile's own onclick so the page's selection state stays in charge
    let ownClick = false;
    const setSel = (b, v) => {
      if (isSel(b) === v) return true;
      if (v && isCopyId(b.id.replace(/^post_/, ''))) return true; // skipped, not selectable
      if (v && selCount() >= ME_MAX) {
        if (!limitWarned) { toast(t('meLimit')); limitWarned = true; }
        return false;
      }
      ownClick = true;
      b.click();
      ownClick = false;
      return true;
    };
    let anchor = null, drag = null, suppressClick = false;
    document.addEventListener('mousedown', e => {
      const b = e.target.closest?.('.brick');
      if (!b || e.button !== 0 || e.ctrlKey || e.metaKey) return;
      e.preventDefault(); // no link dragging or text selection
      limitWarned = false;
      suppressClick = false;
      if (e.shiftKey && anchor?.isConnected && anchor !== b) {
        const all = [...document.querySelectorAll('.brick')];
        const [from, to] = [all.indexOf(anchor), all.indexOf(b)].sort((x, y) => x - y);
        for (let i = from; i <= to; i++) if (!setSel(all[i], true)) break;
        suppressClick = true;
        anchor = b;
        return;
      }
      drag = { start: b, last: b, value: !isSel(b), moved: false };
      anchor = b;
    }, true);
    document.addEventListener('mouseover', e => {
      if (!drag) return;
      const b = e.target.closest?.('.brick');
      if (!b || b === drag.last) return;
      if (!drag.moved) { drag.moved = true; setSel(drag.start, drag.value); }
      // A fast drag skips tiles, so fill every tile between the previous one and this one (in page order)
      const all = [...document.querySelectorAll('.brick')];
      const [from, to] = [all.indexOf(drag.last), all.indexOf(b)].sort((x, y) => x - y);
      for (let i = from; i <= to; i++) if (!setSel(all[i], drag.value)) break;
      drag.last = b;
    });
    window.addEventListener('mouseup', () => {
      if (drag?.moved) suppressClick = true;
      drag = null;
      setTimeout(() => { suppressClick = false; }, 0);
    });
    // After a drag or Shift+click our code already toggled the tiles; swallow the native click
    document.addEventListener('click', e => {
      const b = e.target.closest?.('.brick');
      if (suppressClick && !ownClick && b) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      // a reblog of my own post can't be selected (it follows its original); it can still be unselected
      if (b && !isSel(b) && isCopyId(b.id.replace(/^post_/, ''))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!copyWarned) { toast(t('meCopyLocked')); copyWarned = true; }
      }
    }, true);
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a' || /^(input|textarea|select)$/i.test(e.target.tagName)) return;
      e.preventDefault();
      limitWarned = false;
      for (const b of document.querySelectorAll('.brick')) if (!setSel(b, true)) break;
    });
  }

  // ---------- Startup ----------
  // The manager page and other tabs write the same keys; keep this tab's copy current
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || ch.writer?.newValue?.startsWith(me + ':')) return;
    if (ch.cache && !syncing) { Object.assign(cache, C.emptyCache(), ch.cache.newValue || {}); rebuildIndex(); }
    if (ch.settings) {
      Object.assign(settings, ch.settings.newValue || {});
      Object.assign(tpl, { useBase: settings.useBase ?? true, rules: { ...C.TPL_RULES, ...settings.rules } });
    }
    if (ch.packs) { tpl.packs = ch.packs.newValue || []; parsed.clear(); }
  });
  resolveReady();
  new MutationObserver(C.debounce(bindInputs, 300)).observe(document.body, { childList: true, subtree: true });
  bindInputs();
  if (location.pathname.startsWith('/mega-editor')) initMassEditor();
  if (settings.autoSync && Date.now() - (cache.lastAuto || 0) > AUTO_SYNC_INTERVAL) {
    setTimeout(() => syncAll(false, true), 5000);
  }
})();
