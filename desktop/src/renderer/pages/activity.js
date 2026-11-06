'use strict';

const ActivityPage = {
  async render(root) {
    this.root = root;
    const [jobs, log] = await Promise.all([call('jobs', { status: 'open' }), call('activity', { limit: 300 })]);
    const visible = jobs.filter(j => !['sync.blog', 'sync.blogs', 'maintain.after'].includes(j.kind) || j.status !== 'pending');
    root.replaceChildren(
      h('header', { class: 'page-head' }, h('h1', {}, t('activityTitle'))),
      h('section', { class: 'card' }, h('h2', {}, t('openJobs')),
        visible.length ? h('table', { class: 'table' }, h('tbody', {}, visible.map(j => h('tr', {},
          h('td', {}, h('span', { class: 'badge js-' + j.status }, t('js_' + j.status))),
          h('td', {}, this.describe(j)),
          h('td', { class: 'muted small' }, j.error || ''),
          h('td', { class: 'muted small' }, fmtTime(j.updated_at)),
          h('td', { class: 'right' },
            ['pending', 'waiting'].includes(j.status) ? h('button', { class: 'ghost', onclick: async () => { await call('cancelJob', { id: j.id }); this.render(root); } }, t('cancelJob')) : null,
            // a lost create: look again, or (after checking Tumblr yourself) say it wasn't created; two clicks
            j.status === 'unknown' ? h('button', { class: 'ghost', onclick: async () => { await call('checkJob', { id: j.id }); this.render(root); } }, t('checkAgain')) : null,
            j.status === 'unknown' ? h('button', { class: 'ghost', title: t('notCreatedHint'), onclick: async e => {
              const b = e.currentTarget;
              if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = t('notCreatedSure'); return; }
              await call('resolveJob', { id: j.id }); this.render(root);
            } }, t('notCreated')) : null,
            ['failed', 'waiting'].includes(j.status) ? h('button', { class: 'ghost', onclick: async () => { await call('retryJob', { id: j.id }); this.render(root); } }, t('retry')) : null))))) : empty(t('noJobs'))),
      h('section', { class: 'card' }, h('h2', {}, t('log')),
        h('table', { class: 'table log' }, h('tbody', {}, log.map(l => h('tr', { class: 'lv-' + l.level },
          h('td', { class: 'muted small nowrap' }, fmtTime(l.at)), h('td', {}, l.kind), h('td', {}, l.msg),
          h('td', { class: 'muted small' }, l.data?.blog ? blogName(l.data.blog) + (l.data.id ? ' / ' + l.data.id : '') : ''))))))
    );
  },
  describe(j) {
    const p = j.payload || {};
    const where = p.blog ? blogName(p.blog) + (p.id ? ' / ' + p.id : '') : '';
    const names = { 'post.visibility': p.target === 'published' ? t('makePublic') : t('makePrivate'), 'post.tags': '#', 'post.reblog': t('reblogTo').replace('…', '') + ' ' + blogName(p.dest), 'sync.blog': '⟳', 'sync.blogs': '⟳', 'maintain.after': '⟳', 'post.publish': t('publish') };
    return [names[j.kind] || j.kind, ' ', h('span', { class: 'muted' }, where)];
  },
  refresh() { this.render(this.root); },
};
