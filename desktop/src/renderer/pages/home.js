'use strict';

const HomePage = {
  async render(root) {
    this.root = root;
    const s = App.status;
    if (s.auth !== 'connected' && s.auth !== 'reconnect') {
      root.replaceChildren(h('header', { class: 'page-head' }, h('h1', {}, t('homeTitle'))),
        empty(t('notConnected'), h('p', { class: 'muted' }, t('connectHint')), h('button', { class: 'primary', 'data-go': 'settings' }, t('goSettings'))));
      return;
    }
    const [all, pub, priv, expiring, review, recent, drafts] = await Promise.all([
      call('posts', { view: 'displayed', limit: 1, share: true }),
      call('posts', { view: 'displayed', state: 'published', limit: 1, share: true }),
      call('posts', { view: 'displayed', state: 'private', limit: 1, share: true }),
      call('expiring', { days: 7 }),
      call('review'),
      call('posts', { view: 'managed', limit: 8, share: true }),
      window.studio.call('drafts', {}).catch(() => []),
    ]);
    const stat = (n, label, go, cls = '') => h('button', { class: 'stat ' + cls, onclick: go }, h('b', {}, String(n)), h('span', {}, label));
    const reviewN = review.ambiguous + review.lost + review.conflicts;
    const lp = s.lastPass;
    root.replaceChildren(
      h('header', { class: 'page-head' }, h('h1', {}, t('homeTitle')),
        h('div', { class: 'head-actions' }, h('span', { class: 'muted' }, t('lastPass') + ': ' + (lp ? ago(lp.at) : t('never'))),
          h('button', { onclick: async () => { await call('syncNow', {}); toast(t('syncNow') + ' ✓'); } }, t('syncNow')))),
      s.auth === 'reconnect' ? h('div', { class: 'banner warn' }, t('authReconnect'), h('button', { 'data-go': 'settings' }, t('goSettings'))) : null,
      s.paused ? h('div', { class: 'banner warn' }, t('paused'), h('button', { onclick: async () => { await call('setPaused', false); window.studio.trayRefresh(); await App.loadStatus(); this.render(root); } }, t('resume'))) : null,
      h('div', { class: 'stats' },
        stat(all.total, t('statPosts'), () => App.go('posts', { view: 'displayed' })),
        stat(pub.total, t('statPublic'), () => App.go('posts', { view: 'displayed', state: 'published' })),
        stat(priv.total, t('statHidden'), () => App.go('posts', { view: 'displayed', state: 'private' })),
        stat(expiring.length, t('statExpiring'), () => App.go('posts', { expiring: true, scope: 'all' }), expiring.length ? 'accent' : ''),
        stat(reviewN, t('statReview'), () => App.go('posts', { review: true }), reviewN ? 'warn' : '')),
      reviewN ? h('section', { class: 'card' }, h('h2', {}, t('statReview')), h('ul', { class: 'plain' },
        review.ambiguous ? h('li', {}, t('reviewAmbiguous', review.ambiguous)) : null,
        review.lost ? h('li', {}, t('reviewLost', review.lost)) : null,
        review.conflicts ? h('li', {}, t('reviewConflict', review.conflicts)) : null)) : null,
      drafts.length ? h('section', { class: 'card' }, h('h2', {}, t('continueWriting')),
        h('div', { class: 'draft-list' }, drafts.slice(0, 4).map(d => h('button', { class: 'draft-item', onclick: () => App.go('write', { id: d.id }) },
          h('b', {}, d.title || t('untitled')), h('span', { class: 'muted' }, fmtTime(d.updated_at)))))) : null,
      h('section', { class: 'card home-recent' }, h('h2', {}, t('recentPosts')), PostsPage.grid(recent.rows, { onOpen: r => PostsPage.openDetail(r) })),
      h('section', { class: 'card' }, h('h2', {}, t('coverage')), h('table', { class: 'table' }, h('tbody', {},
        s.blogs.map(b => {
          const c = s.coverage.filter(x => x.uuid === b.uuid);
          const posts = c.find(x => x.box === 'posts');
          return h('tr', {}, h('td', {}, h('b', {}, b.name), ' ', b.role ? h('span', { class: 'badge' }, t('role_' + b.role)) : h('span', { class: 'badge warn' }, t('role_null'))),
            h('td', {}, posts?.posts ?? 0, ' ', t('statPosts')),
            h('td', { class: 'muted' }, !posts?.box ? t('coverageNone') : posts.complete ? t('coverageDone') + ' · ' + ago(Math.max(posts.full_done || 0, posts.inc_done || 0)) : t('coveragePartial')));
        })))),
    );
  },
  refresh(ev) { if (ev.type === 'pass' || ev.type === 'status' || ev.type === 'auth') this.render(this.root); },
};
