'use strict';
// Router and shared state. Each page is { render(root, params) } and may expose refresh() for live events.

const App = {
  status: null,
  page: null,
  pages: { home: HomePage, posts: PostsPage, rules: RulesPage, activity: ActivityPage, settings: SettingsPage, write: WritePage, fans: FansPage, tags: TagsPage, material: MaterialPage, tidy: TidyPage },
  async loadStatus() {
    App.status = await call('status');
    const open = Object.entries(App.status.jobs || {}).filter(([k]) => ['pending', 'running', 'verifying', 'waiting', 'unknown'].includes(k)).reduce((a, [, n]) => a + n, 0);
    const b = $('#jobBadge');
    b.hidden = !open; b.textContent = open;
    const foot = $('#sideFoot');
    foot.replaceChildren(...[
      h('div', { class: 'conn ' + App.status.auth }, '● ', t('connStatus_' + App.status.auth)),
      App.status.account?.name ? h('div', { class: 'muted' }, App.status.account.name) : null,
      App.status.paused ? h('div', { class: 'warn-text' }, t('paused')) : null,
    ].filter(Boolean));
    return App.status;
  },
  async go(name, params = {}) {
    try { await App.page?.flush?.(); } catch {}
    document.querySelector('.detail-pane')?.remove();
    // the old New followers page is the Account protection tab now (old bookmarks and saved start pages)
    if (name === 'followers') { name = 'fans'; params = { ...params, tab: 'protect' }; }
    const Page = App.pages[name] || HomePage;
    document.querySelectorAll('#side a').forEach(a => a.classList.toggle('on', a.dataset.go === name));
    App.page = Page;
    App.pageName = name;
    try { localStorage.setItem('page', name); } catch {}
    clientLog('info', 'nav', name, '', name);
    const root = $('#main');
    root.replaceChildren(h('div', { class: 'page-loading' }));  // pages replace it when their data is in
    root.scrollTop = 0;
    try { await Page.render(root, params); }
    catch (e) { console.error('render ' + name + ': ' + (e?.stack || e)); clientLog('error', 'render', e?.message || e, e?.stack || '', name); root.append(h('div', { class: 'banner warn' }, cleanErr(e))); }
  },
};

// The page's own errors and where the user went, into the backend's diagnostic log (never blocks anything)
let logBudget = 120; // per page load, so an error loop can't flood the log
function clientLog(level, what, msg, stack = '', page = App.pageName || '') {
  if (logBudget-- <= 0) return;
  try { window.studio.call('clientLog', { level, what, msg: String(msg || '').slice(0, 1000), stack: String(stack || '').slice(0, 2000), page }).catch(() => {}); } catch {}
}
window.addEventListener('error', e => clientLog('error', 'error', e.message, e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', e => { const r = e.reason; if (String(r?.message || r) === 'session') return; clientLog('error', 'rejection', r?.message || r, r?.stack || ''); });

let refreshTimer = null;
window.studio.on(ev => {
  // "Open in Tumblr Studio" from the browser: show that work
  if (ev.type === 'open') { App.go('posts').then(() => { if (ev.data?.item) PostsPage.openDetail({ item_id: ev.data.item }); }); return; }
  // after the local backend comes back, show its state again (events missed meanwhile are not replayed)
  if (ev.type === 'reconnected') { App.loadStatus().then(() => { if (App.pageName !== 'write') App.go(App.pageName); }).catch(() => {}); return; }
  if (ev.type === 'stopped') return;
  if (ev.type === 'pairAsk') { askPairing(ev.data); return; }
  if (ev.type === 'pairDone') { document.querySelector(`[data-pair-ask="${ev.data?.id}"]`)?.closest('.modal-back')?.remove(); return; }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await App.loadStatus();
    App.page?.refresh?.(ev);
  }, ev.type === 'job' ? 600 : 100);
});

// The browser extension asks to connect: the same code shows in the extension's page
const pairAsked = new Set();
async function askPairing(a) {
  if (!a?.id || pairAsked.has(a.id)) return;
  pairAsked.add(a.id);
  const body = h('div', { 'data-pair-ask': a.id }, h('p', {}, t('pairAskText')), h('p', { class: 'pair-code' }, a.code), h('p', { class: 'muted small' }, t('pairAskHint')));
  const ok = await modal(t('pairAskTitle'), body, [{ label: t('pairDeny'), value: false }, { label: t('pairAllow'), value: true, class: 'primary' }]);
  if (ok === true || ok === false) await window.studio.call('pairAnswer', { id: a.id, allow: ok }).catch(() => {});
  if (ok) toast(t('pairAllowed'), 'ok');
}
setTimeout(() => window.studio.call('pairAsks').then(list => (list || []).forEach(askPairing)).catch(() => {}), 800);

document.addEventListener('click', e => {
  if (e.target.closest('#newPostBtn')) { App.go('write', { create: true }); return; }
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); App.go(go.dataset.go); }
});

(async () => {
  let pref = '';
  try { pref = localStorage.getItem('lang') || ''; } catch {}
  setLang(pref);
  applyI18n();
  // the test environment says so on every page
  if (window.studio.web) call('serverInfo').then(si => { if (si.test) { document.body.classList.add('env-test'); document.body.append(h('div', { class: 'env-flag' }, t('svcTestFlag'))); } }).catch(() => {});
  await App.loadStatus();
  let start = 'home';
  try { start = localStorage.getItem('page') || 'home'; } catch {}
  if (App.status.auth !== 'connected') start = 'settings';
  App.go(start);
})();
