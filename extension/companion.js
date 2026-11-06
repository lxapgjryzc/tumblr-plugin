// The browser companion's page (design 4.3, A52–A55): connection to Tumblr Studio, the one-time move of this
// extension's older data into the app, browser-only preferences, and where every former feature lives now.
// It has no post management, administration, AI or scheduling of its own.
(async () => {
  'use strict';
  const C = TTHCore;
  const $ = id => document.getElementById(id);
  // Inside the extension the operations run here; on the page the app serves, companion-host.js runs them
  const inExtension = typeof chrome !== 'undefined' && !!chrome.storage?.local;
  const host = inExtension ? makeCompanionOps(chrome) : await relay();
  let state = host ? await host.state() : { prefs: { lang: '' } };
  const { t } = C.makeI18n(() => state.prefs.lang, () => [state.tumblrLang, navigator.language]);
  const applyI18n = () => document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });

  // The page ↔ content-script channel: window.postMessage on this origin only. null if the extension isn't there.
  async function relay() {
    const listeners = [], waiting = new Map();
    let ready = false, seq = 0;
    window.addEventListener('message', e => {
      const m = e.data;
      if (e.source !== window || e.origin !== location.origin || !m?.tthCompanion || m.from !== 'host') return;
      if (m.type === 'ready') ready = true;
      else if (m.type === 'reply') { waiting.get(m.id)?.(m.result); waiting.delete(m.id); }
      else if (m.type === 'changed') listeners.forEach(fn => fn());
    });
    const ping = () => window.postMessage({ tthCompanion: true, from: 'page', type: 'ping' }, location.origin);
    for (let i = 0; i < 20 && !ready; i++) { ping(); await new Promise(r => setTimeout(r, 100)); }
    if (!ready) return null;
    const call = fn => (...args) => new Promise(res => {
      const id = ++seq;
      waiting.set(id, res);
      window.postMessage({ tthCompanion: true, from: 'page', type: 'call', id, fn, args }, location.origin);
    });
    const api = { onChange: fn => listeners.push(fn) };
    for (const fn of ['state', 'savePrefs', 'hello', 'pair', 'unpair', 'focus', 'refresh', 'move', 'exportData']) api[fn] = call(fn);
    return api;
  }

  // Where each feature of the old manager page lives now (A55: none silently dropped)
  const WHERE = [
    ['wPosts', 'wStudio', 'Posts'], ['wTags', 'wStudio', 'Posts'], ['wVisibility', 'wStudio', 'Posts / Rules'],
    ['wRecent', 'wStudio', 'Rules'], ['wReblogs', 'wStudio', 'Rules'], ['wPacks', 'wStudio', 'Categories & templates'],
    ['wCollect', 'wStudio', 'Materials'], ['wStudy', 'wStudio', 'Materials'], ['wAi', 'wStudio', 'Settings / Materials'],
    ['wCleanup', 'wStudio', 'Tag upkeep'], ['wUpkeep', 'wStudio', 'Tag upkeep'], ['wAiArtCheck', 'wStudio', 'Materials'],
    ['wAiResort', 'wRetired', ''],
    ['wSuggest', 'wBrowser', ''], ['wTemplates', 'wBrowser', ''], ['wMega', 'wBrowser', ''], ['wHide', 'wBrowser', ''],
  ];

  async function render() {
    applyI18n();
    $('where').innerHTML = WHERE.map(([what, where, page]) => `<tr><td>${C.esc(t(what))}</td><td><span class="badge ${where}">${C.esc(t(where))}</span></td><td class="muted">${C.esc(page)}</td></tr>`).join('');
    const conn = $('conn');
    if (!host) {
      conn.className = 'conn off'; conn.textContent = t('cpNoExtension');
      document.querySelectorAll('section.needs-ext').forEach(el => { el.hidden = true; });
      $('pairBtn').hidden = $('unpairBtn').hidden = $('focusBtn').hidden = true;
      return;
    }
    state = await host.state();
    for (const k of ['hideAds', 'hideRecs', 'hideAiArt']) $(k).checked = !!state.prefs[k];
    $('lang').value = state.prefs.lang || '';
    const hello = await host.hello();
    if (!hello?.running) { conn.className = 'conn off'; conn.textContent = t('cpNotRunning'); }
    else if (!state.paired || !hello.paired) { conn.className = 'conn warn'; conn.textContent = t('cpNotPaired', hello.account?.name || hello.primary || '?'); }
    else { conn.className = 'conn ok'; conn.textContent = t('cpPaired', state.primary || hello.primary || '?'); }
    $('pairBtn').hidden = !hello?.running || (state.paired && hello.paired);
    $('unpairBtn').hidden = !state.paired;
    const sn = state.snapshot;
    $('snapInfo').textContent = sn ? t('cpSnapshot', new Date(sn.at).toLocaleString(), sn.blogs, sn.packs) : t('cpNoSnapshot');
    $('moveBtn').disabled = !(hello?.running && state.paired && hello.paired);
    $('moveInfo').textContent = state.legacyMoved ? t('cpMoved', new Date(state.legacyMoved.at).toLocaleString()) : '';
  }

  const actions = {
    async pair() {
      $('conn').textContent = t('cpPairing');
      const r = await host.pair();
      if (r?.error === 'other_account') alertBox(t('cpOtherAccount', r.primary || '?'));
      else if (r?.error) alertBox(t('studioRefused', r.error));
      render();
    },
    async unpair() { await host.unpair(); render(); },
    async focus() {
      const r = await host.focus();
      if (r?.error === 'not_running') alertBox(t('studioNotRunning'));
    },
    async move() {
      $('moveInfo').textContent = t('cpMoving');
      const r = await host.move();
      if (r?.error) { $('moveInfo').textContent = t('studioRefused', r.error); return; }
      render();
    },
    async export() {
      const blob = new Blob([JSON.stringify(await host.exportData())], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tumblr-tag-helper-export.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
  };
  // a message in the page, never a native dialog
  function alertBox(text) {
    const p = document.createElement('p');
    p.className = 'banner';
    p.textContent = text;
    document.querySelector('main').prepend(p);
    setTimeout(() => p.remove(), 8000);
  }

  document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && host && actions[b.dataset.act]) actions[b.dataset.act](); });
  for (const k of ['hideAds', 'hideRecs', 'hideAiArt']) $(k).addEventListener('change', e => host?.savePrefs({ [k]: e.target.checked }));
  $('lang').addEventListener('change', async e => { await host?.savePrefs({ lang: e.target.value }); render(); });
  host?.onChange(() => render());
  await render();
  host?.refresh();
})();
