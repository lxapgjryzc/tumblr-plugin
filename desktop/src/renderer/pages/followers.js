'use strict';
// New followers: a short digest, then the cases that need a look. Evidence is one click away.

const FollowersPage = {
  tab: 'review',
  async render(root) {
    this.root = root;
    const g = await call('followerGuard');
    const d = g.digest, c = g.config;
    const tabs = ['review', 'new', 'spam', 'blocked', 'allowed'];
    const rows = await call('followerCases', { status: this.tab });
    root.replaceChildren(
      h('header', { class: 'page-head' }, h('h1', {}, t('navFollowers')),
        h('div', { class: 'head-actions' }, c.mode && c.mode !== 'off' ? h('button', { onclick: async () => { await call('scanFollowers'); toast(t('syncNow') + ' ✓'); } }, t('scanNow')) : null)),
      h('section', { class: 'card' },
        h('div', { class: 'digest' },
          h('span', {}, h('b', {}, d.blocked), ' ', t('fgBlocked')), h('span', {}, h('b', {}, d.reportPending), ' ', t('fgReportPending')),
          h('span', { class: d.review ? 'warn-text' : '' }, h('b', {}, d.review), ' ', t('fgReview')), h('span', { class: 'muted' }, h('b', {}, d.newFollowers), ' ', t('fgNew'))),
        h('div', { class: 'form-row wrap' }, h('span', {}, t('fgMode')),
          chips([{ value: 'off', label: t('fgOff') }, { value: 'review', label: t('fgReviewMode') }], c.mode || 'off', async v => { await call('setFollowerGuard', { mode: v }); this.render(root); }),
          h('button', { class: 'chip', disabled: true, title: t('fgAutoWhy') }, t('fgAuto') + ' · ' + t('fgUnavailable'))),
        h('p', { class: 'muted small' }, t('fgHint')),
        h('div', { class: 'form-row wrap' },
          toggle(c.protectFollowing !== false, async v => { await call('setFollowerGuard', { protectFollowing: v }); }, t('fgProtectFollowing')),
          toggle(!!c.ai, async v => { await call('setFollowerGuard', { ai: v }); this.render(root); }, t('fgUseAi'))),
        c.ai ? h('p', { class: 'muted small' }, t('fgAiNote')) : null,
        h('p', { class: 'muted small' }, t('fgCaps', t('cap_' + g.capabilities.block)), ' · ', t('fgReportNote')),
        g.scans.map(s => h('p', { class: 'muted small' }, blogName(s.blog), ': ', s.at ? t('fgScanned', s.count ?? 0, ago(s.at)) : t('coverageNone'), s.baseline ? ' · ' + t('fgBaseline', fmtDate(s.baseline)) : ''))),
      h('div', { class: 'seg' }, tabs.map(x => h('button', { class: this.tab === x ? 'on' : '', onclick: () => { this.tab = x; this.render(root); } }, t('fgTab_' + x)))),
      h('div', { class: 'case-list' }, rows.length ? rows.map(r => this.caseRow(r)) : empty(t('fgEmpty'))));
  },

  caseRow(r) {
    const a = r.assessment || {};
    const url = `https://${r.name}.tumblr.com`;
    const ev = (r.evidence || []);
    const used = new Set([...(a.evidence_ids || []), ...(a.ai?.evidence_ids || [])]);
    return h('div', { class: 'case' },
      h('div', { class: 'grow' },
        h('div', { class: 'inst-line' }, h('b', {}, r.name), r.status ? h('span', { class: 'badge' + (r.status === 'review' ? ' warn' : '') }, t('fs_' + r.status)) : null,
          r.origin ? h('span', { class: 'badge' }, r.origin === 'app' ? t('fgByApp') : t('fgExternal')) : null,
          a.report === 'pending' ? h('span', { class: 'badge warn' }, t('fgReportPending')) : null,
          a.report === 'submitted_by_user' ? h('span', { class: 'badge' }, t('fgReportedByYou')) : null,
          h('a', { href: url, target: '_blank', class: 'small' }, t('openOnTumblr'))),
        r.first_seen ? h('div', { class: 'muted small' }, t('fgFirstSeen', fmtTime(r.first_seen))) : null,
        a.reasons?.length ? h('div', { class: 'small' }, t('fgSignals'), ': ', a.reasons.map(x => t('sig_' + x)).join(' · ')) : null,
        a.ai?.explanation ? h('div', { class: 'small' }, 'AI: ', a.ai.explanation) : a.ai?.error ? h('div', { class: 'small muted' }, 'AI: ', a.ai.error) : null,
        ev.length ? h('details', { class: 'small' }, h('summary', {}, t('fgEvidence', ev.length)),
          h('ul', { class: 'evidence' }, ev.map(e => h('li', { class: used.has(e.id) ? 'hit' : '' }, h('span', { class: 'muted' }, e.own ? t('fgOwn') : t('fgReblogged'), ' · '), e.text.slice(0, 300))))) : null),
      h('div', { class: 'inst-actions' }, this.actions(r)));
  },

  actions(r) {
    const done = () => this.render(this.root);
    const allow = h('button', { onclick: async () => {
      const res = await call('allowFollower', { uuid: r.uuid, name: r.name });
      if (res.appBlocks.length) {
        const ok = await modal(t('fgAllow'), h('p', {}, t('fgUndoBlockQ', res.appBlocks.map(blogName).join(', '))), [{ label: t('cancel'), value: false }, { label: t('fgUnblock'), value: true, class: 'primary' }]);
        if (ok) await call('unblockFollower', { uuid: r.uuid, name: r.name, blogs: res.appBlocks });
      }
      done();
    } }, t('fgAllow'));
    if (!r.uuid) return [h('span', { class: 'muted small' }, t('fgNoId'))];
    if (this.tab === 'allowed') return [h('button', { class: 'ghost', onclick: async () => { await call('removeAllow', { uuid: r.uuid }); done(); } }, t('delete'))];
    if (this.tab === 'blocked') return [r.origin === 'app' ? h('button', { onclick: async () => { await call('unblockFollower', { uuid: r.uuid, name: r.name, blogs: [r.blog] }); toast(t('queued', 1)); done(); } }, t('fgUnblock')) : null, allow];
    return [
      allow,
      h('button', { onclick: async () => {
        const blogs = (await call('followerGuard')).config.blogs;
        const ok = await modal(t('fgBlock'), h('p', {}, t('fgBlockQ', r.name, blogs.map(blogName).join(', '))), [{ label: t('cancel'), value: false }, { label: t('fgBlock'), value: true, class: 'danger' }]);
        if (ok) { await call('blockFollower', { uuid: r.uuid, name: r.name, blogs }); toast(t('queued', blogs.length)); done(); }
      } }, t('fgBlock')),
      h('button', { onclick: async () => {
        // Tumblr has no report API: open the blog so the user can use Tumblr's own report menu, and keep it pending
        await call('markReport', { uuid: r.uuid, state: 'pending' });
        window.open(`https://www.tumblr.com/${r.name}`, '_blank');
        const ok = await modal(t('fgReport'), h('p', {}, t('fgReportHow')), [{ label: t('fgLater'), value: false }, { label: t('fgReportDone'), value: true, class: 'primary' }]);
        if (ok) await call('markReport', { uuid: r.uuid, state: 'submitted_by_user' });
        done();
      } }, t('fgReport')),
      h('button', { class: 'ghost', onclick: async () => { await call('dismissFollower', { uuid: r.uuid }); done(); } }, t('fgLater')),
    ];
  },
  refresh(ev) { if (ev.type === 'pass') this.render(this.root); },
};
