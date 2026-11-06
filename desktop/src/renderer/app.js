'use strict';
// Router and shared state. Each page is { render(root, params) } and may expose refresh() for live events.

const App = {
  status: null,
  page: null,
  pages: { home: HomePage, posts: PostsPage, rules: RulesPage, activity: ActivityPage, settings: SettingsPage, write: WritePage, followers: FollowersPage, tags: TagsPage, material: MaterialPage, tidy: TidyPage },
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
    const Page = App.pages[name] || HomePage;
    document.querySelectorAll('#side a').forEach(a => a.classList.toggle('on', a.dataset.go === name));
    App.page = Page;
    App.pageName = name;
    try { localStorage.setItem('page', name); } catch {}
    const root = $('#main');
    root.replaceChildren();
    root.scrollTop = 0;
    try { await Page.render(root, params); }
    catch (e) { console.error('render ' + name + ': ' + (e?.stack || e)); root.append(h('div', { class: 'banner warn' }, cleanErr(e))); }
  },
};

let refreshTimer = null;
window.studio.on(ev => {
  // "Open in Tumblr Studio" from the browser: show that work
  if (ev.type === 'open') { App.go('posts').then(() => { if (ev.data?.item) PostsPage.openDetail({ item_id: ev.data.item }); }); return; }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await App.loadStatus();
    App.page?.refresh?.(ev);
  }, ev.type === 'job' ? 600 : 100);
});

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) { e.preventDefault(); App.go(go.dataset.go); }
});

(async () => {
  let pref = '';
  try { pref = localStorage.getItem('lang') || ''; } catch {}
  setLang(pref);
  applyI18n();
  await App.loadStatus();
  let start = 'home';
  try { start = localStorage.getItem('page') || 'home'; } catch {}
  if (App.status.auth !== 'connected') start = 'settings';
  App.go(start);
})();
