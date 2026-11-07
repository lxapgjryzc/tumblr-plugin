'use strict';

// Background sync and its upkeep run every few minutes; a run of successful ones is one log row
const ROUTINE = new Set(['sync.blog', 'sync.blogs', 'maintain.after']);
const routineOk = l => (ROUTINE.has(l.kind) || l.kind === 'routine') && l.msg === 'succeeded' && l.level === 'info';
const kindName = k => { const key = 'jk_' + String(k).replace(/\./g, '_'); const v = t(key); return v === key ? k : v; };

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
        log.length ? h('table', { class: 'table log' }, h('tbody', {}, this.collapse(log).map(({ l, n, from }) => {
          const [st, ...rest] = String(l.msg || '').split(': ');
          const isStatus = STRINGS.en['js_' + st] != null;
          return h('tr', { class: 'lv-' + l.level },
            h('td', { class: 'muted small nowrap log-time' }, n > 1 && Math.floor(from / 60000) !== Math.floor(l.at / 60000) ? fmtTime(from) + ' – ' + (new Date(from).toDateString() === new Date(l.at).toDateString() ? new Date(l.at).toLocaleTimeString(LANG === 'zh' ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : fmtTime(l.at)) : fmtTime(l.at)),
            h('td', { class: 'nowrap' }, kindName(l.kind), n > 1 ? h('span', { class: 'muted small' }, ' ' + t('timesN', n)) : null),
            h('td', {}, isStatus ? [h('span', { class: 'badge js-' + st }, t('js_' + st)), rest.length ? h('span', { class: 'muted small' }, ' ' + rest.join(': ')) : null] : l.msg),
            h('td', { class: 'muted small right' }, l.data?.blog ? blogName(l.data.blog) + (l.data.id ? ' / ' + l.data.id : '') : ''));
        }))) : empty(t('logEmpty'))),
    );
  },
  // Runs of the same routine entry (a sync every few minutes) read as one row with a count
  collapse(log) {
    const out = [];
    for (const l of log) {
      const last = out[out.length - 1];
      if (last && routineOk(l) && routineOk(last.l)) { last.n++; last.l = { ...last.l, kind: 'routine' }; last.from = l.at; }
      else if (last && last.l.kind === l.kind && last.l.msg === l.msg && last.l.level === l.level && !l.data?.id && !last.l.data?.id) { last.n++; last.from = l.at; }
      else out.push({ l, n: 1, from: l.at });
    }
    return out;
  },
  describe(j) {
    const p = j.payload || {};
    const where = p.blog ? blogName(p.blog) + (p.id ? ' / ' + p.id : '') : '';
    const detail = j.kind === 'post.visibility' ? ' · ' + (p.target === 'published' ? t('makePublic') : t('makePrivate'))
      : j.kind === 'post.reblog' && p.dest ? ' → ' + blogName(p.dest) : '';
    return [kindName(j.kind) + detail, ' ', h('span', { class: 'muted' }, where)];
  },
  refresh() { this.render(this.root); },
};
