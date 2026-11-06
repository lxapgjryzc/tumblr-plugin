'use strict';
// Display duration rules and reblog routes. A new rule has no preselected scope mode: the user picks
// "per blog" or "whole work" explicitly, sees what it would hide now, then switches it on.

const RulesPage = {
  async render(root) {
    this.root = root;
    const s = await App.loadStatus();
    const [rules, routes, takeover] = await Promise.all([call('rules'), call('routes'), call('reblogTakeoverOffer')]);
    const auto = s.automation || {};
    root.replaceChildren(
      h('header', { class: 'page-head' }, h('h1', {}, t('rulesTitle'))),
      h('section', { class: 'card' },
        h('h2', {}, t('expiryTitle')), h('p', { class: 'muted' }, t('expiryHint')),
        toggle(!!auto.expiry, async v => { await call('setAutomation', { expiry: v }); this.render(root); }, t('autoExpiry')),
        h('div', { class: 'rule-list' }, rules.map(r => this.ruleRow(r))),
        h('button', { class: 'primary', onclick: () => this.editRule({}) }, '+ ' + t('newRule')),
        h('p', { class: 'muted small' }, t('offNote'))),
      h('section', { class: 'card' },
        h('h2', {}, t('routesTitle')), h('p', { class: 'muted' }, t('routesHint')),
        takeover ? this.takeoverBanner(takeover) : null,
        toggle(!!auto.routes, async v => { await call('setAutomation', { routes: v }); this.render(root); }, t('autoRoutes')),
        h('div', { class: 'rule-list' }, routes.map(r => this.routeRow(r))),
        h('button', { class: 'primary', onclick: () => this.editRoute({}) }, '+ ' + t('newRoute'))),
    );
  },

  ruleRow(r) {
    const mode = r.mode === 'linked' ? t('modeLinked') : t('modeIndependent');
    return h('div', { class: 'rule' },
      h('div', { class: 'grow' }, h('b', {}, blogName(r.blog)), ' ', h('span', { class: 'muted' }, t('ruleSummary', mode, r.days, r.scope === 'images' ? t('scopeImages') : t('scopeAll')))),
      h('span', { class: 'badge ' + (r.enabled ? 'st-published' : '') }, r.enabled ? t('enabled') : t('disabled')),
      h('button', { onclick: () => this.editRule(r) }, t('edit')),
      h('button', { class: 'ghost', onclick: () => this.restore(r) }, t('restore')));
  },

  async editRule(r0) {
    const blogs = (App.status.blogs || []).filter(b => b.role === 'share');
    const r = { mode: null, blog: blogs[0]?.uuid, days: 30, scope: 'all', kinds: ['original', 'reblog'], targets: [], skip_pinned: true, enabled: false, ...r0 };
    const box = h('div', { class: 'rule-edit' });
    const pvBox = h('div', { class: 'preview-box' });
    const draw = () => {
      box.replaceChildren(
        h('label', { class: 'field' }, h('span', {}, t('modeLabel')),
          h('div', { class: 'mode-pick' }, ['independent', 'linked'].map(m => h('button', { class: 'mode' + (r.mode === m ? ' on' : ''), onclick: () => { r.mode = m; draw(); } },
            h('b', {}, m === 'linked' ? t('modeLinked') : t('modeIndependent')), h('span', { class: 'muted small' }, m === 'linked' ? t('modeLinkedHint') : t('modeIndependentHint')))))),
        r.mode ? [
          h('label', { class: 'field' }, h('span', {}, r.mode === 'linked' ? t('ruleManager') : t('ruleBlog')), select(blogs.map(b => ({ value: b.uuid, label: b.name })), r.blog, v => { r.blog = v; draw(); })),
          h('label', { class: 'field' }, h('span', {}, t('days')),
            h('div', { class: 'form-row' }, chips([7, 30, 90, 180, 365].map(d => ({ value: d, label: String(d) })), r.days, v => { r.days = v; draw(); }),
              h('input', { type: 'number', min: 1, value: r.days, style: { width: '90px' }, onchange: e => { r.days = Number(e.target.value); } }), h('span', {}, t('daysUnit')))),
          h('label', { class: 'field' }, h('span', {}, ''), chips([{ value: 'all', label: t('scopeAll') }, { value: 'images', label: t('scopeImages') }], r.scope, v => { r.scope = v; draw(); })),
          r.mode === 'independent' ? h('label', { class: 'field' }, h('span', {}, t('kindsLabel')), h('div', { class: 'form-row' }, ['original', 'reblog'].map(k =>
            h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: r.kinds.includes(k), onchange: e => { r.kinds = e.target.checked ? [...new Set([...r.kinds, k])] : r.kinds.filter(x => x !== k); } }), t('kind_' + k))))) : null,
          r.mode === 'linked' ? h('label', { class: 'field' }, h('span', {}, t('copiesOn')), h('div', { class: 'form-row wrap' }, (App.status.blogs || []).filter(b => b.role === 'share').map(b =>
            h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: r.targets.includes(b.uuid), onchange: e => { r.targets = e.target.checked ? [...new Set([...r.targets, b.uuid])] : r.targets.filter(x => x !== b.uuid); } }), b.name)))) : null,
          h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: r.skip_pinned !== false && r.skip_pinned !== 0, onchange: e => { r.skip_pinned = e.target.checked; } }), t('skipPinned')),
          h('div', { class: 'actions' }, h('button', { onclick: () => this.preview(r, pvBox) }, t('preview'))),
          pvBox,
        ] : h('p', { class: 'muted' }, t('chooseMode')));
    };
    draw();
    const res = await modal(r0.id ? t('edit') : t('newRule'), box, [
      r0.id ? { label: t('delete'), value: 'delete', class: 'ghost danger' } : null,
      { label: t('cancel'), value: null },
      { label: t('save') + ' · ' + t('disabled'), value: 'off' },
      { label: t('save') + ' · ' + t('enabled'), value: 'on', class: 'primary' },
    ].filter(Boolean), { wide: true });
    if (!res) return;
    if (res === 'delete') { await call('deleteRule', { id: r0.id }); return this.render(this.root); }
    if (!r.mode) { toast(t('chooseMode'), 'error'); return; }
    await call('saveRule', { ...r, enabled: res === 'on' });
    toast('✓', 'ok');
    this.render(this.root);
  },

  async preview(r, box) {
    if (!r.mode) return;
    const pv = await call('rulePreview', { ...r, enabled: true });
    box.replaceChildren(h('h3', {}, t('previewTitle')),
      h('p', { class: 'big' }, t('hideNowN', pv.hideNow.length)),
      h('p', {}, t('soonN', pv.soon.length), ' · ', t('keptN', pv.kept.length), pv.held.length ? ' · ' + t('heldN', pv.held.length) : ''),
      pv.hideNow.length ? h('div', { class: 'cards small-cards' }, pv.hideNow.slice(0, 24).map(x => h('div', { class: 'pcard' },
        x.thumb ? h('div', { class: 'thumb' }, h('img', { src: x.thumb, loading: 'lazy' })) : h('div', { class: 'thumb text' }, (x.summary || '').slice(0, 80)),
        h('div', { class: 'meta small' }, blogName(x.blog), ' · ', fmtDate(x.anchor?.at))))) : null);
  },

  async restore(r) {
    const plan = await call('restorePreview', { rule: r.id });
    if (!plan.length) { await modal(t('restore'), h('p', {}, t('nothingToRestore'))); return; }
    const ok = await modal(t('restore'), h('div', {}, h('p', {}, t('restoreHint')), h('p', { class: 'big' }, t('bulkChange', plan.length))),
      [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
    if (!ok) return;
    const res = await call('restore', { rule: r.id, targets: plan.map(p => ({ blog: p.blog, id: p.id })) });
    toast(t('queued', res.queued), 'ok');
  },

  // The extension used to reblog side-blog posts onto the main blog; continue that here, on one click
  takeoverBanner(o) {
    const pick = new Set(o.missed.map(m => m.id));
    return h('div', { class: 'banner warn' },
      h('p', {}, h('b', {}, t('takeoverTitle')), ' ', t('takeoverText', o.sources.map(s => s.name).join(', '), o.main?.name || '?')),
      o.missed.length ? [h('p', { class: 'small' }, t('takeoverMissed', o.missed.length)),
        h('div', {}, o.missed.map(m => h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', checked: true, onchange: e => { e.target.checked ? pick.add(m.id) : pick.delete(m.id); } }),
          m.thumb ? h('img', { src: m.thumb, class: 'avatar' }) : null, h('span', {}, blogName(m.blog) + '/' + m.id), h('span', { class: 'muted small' }, fmtTime(m.published_at) + ' · ' + (m.summary || '').slice(0, 60)))))]
        : h('p', { class: 'small muted' }, t('takeoverNone')),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: async () => { const r = await call('reblogTakeover', { accept: true, ids: [...pick] }); toast(t('takeoverDone', r.queued), 'ok'); this.render(this.root); } }, t('takeoverAccept')),
        h('button', { class: 'ghost', onclick: async () => { await call('reblogTakeover', { accept: false }); this.render(this.root); } }, t('takeoverDecline'))));
  },
  routeRow(r) {
    return h('div', { class: 'rule' },
      h('div', { class: 'grow' }, h('b', {}, r.sources.map(blogName).join(', ')), ' → ', h('b', {}, blogName(r.dest)),
        r.exclude.length ? h('div', { class: 'muted small' }, t('exclude') + ': ' + r.exclude.join(', ')) : null),
      h('span', { class: 'badge ' + (r.enabled ? 'st-published' : '') }, r.enabled ? t('enabled') : t('disabled')),
      h('button', { onclick: () => this.editRoute(r) }, t('edit')),
      h('button', { class: 'ghost', onclick: () => this.backfill(r) }, t('backfill')));
  },

  async editRoute(r0) {
    const share = (App.status.blogs || []).filter(b => b.role === 'share');
    const main = share.find(b => b.is_primary);
    const r = { sources: share.filter(b => !b.is_primary).map(b => b.uuid), dest: main?.uuid, exclude: [], enabled: false, ...r0 };
    let excludeText = r.exclude.join(', ');
    const pvBox = h('div', { class: 'preview-box' });
    const box = h('div', { class: 'rule-edit' },
      h('label', { class: 'field' }, h('span', {}, t('routeFrom')), h('div', { class: 'form-row wrap' }, share.map(b =>
        h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: r.sources.includes(b.uuid), onchange: e => { r.sources = e.target.checked ? [...new Set([...r.sources, b.uuid])] : r.sources.filter(x => x !== b.uuid); } }), b.name)))),
      h('label', { class: 'field' }, h('span', {}, t('routeTo')), select(share.map(b => ({ value: b.uuid, label: b.name })), r.dest, v => { r.dest = v; })),
      h('label', { class: 'field' }, h('span', {}, t('exclude')), h('input', { value: excludeText, placeholder: t('excludeHint'), oninput: e => { excludeText = e.target.value; } })),
      h('p', { class: 'muted small' }, t('routeSince')),
      h('div', { class: 'actions' }, h('button', { onclick: async () => {
        const rows = await call('routePreview', { ...r, sources: r.sources.filter(x => x !== r.dest), exclude: excludeText.split(','), history: false });
        this.drawRoutePreview(pvBox, rows.slice(0, 40));
      } }, t('previewRoute'))),
      pvBox);
    const res = await modal(r0.id ? t('edit') : t('newRoute'), box, [
      r0.id ? { label: t('delete'), value: 'delete', class: 'ghost danger' } : null,
      { label: t('cancel'), value: null },
      { label: t('save') + ' · ' + t('disabled'), value: 'off' },
      { label: t('save') + ' · ' + t('enabled'), value: 'on', class: 'primary' },
    ].filter(Boolean), { wide: true });
    if (!res) return;
    if (res === 'delete') { await call('deleteRoute', { id: r0.id }); return this.render(this.root); }
    await call('saveRoute', { ...r, sources: r.sources.filter(x => x !== r.dest), exclude: excludeText.split(','), enabled: res === 'on' });
    toast('✓', 'ok');
    this.render(this.root);
  },

  drawRoutePreview(box, rows) {
    box.replaceChildren(h('table', { class: 'table' }, h('tbody', {}, rows.map(x => h('tr', {},
      h('td', { class: 'thumbcell' }, x.thumb ? h('img', { src: x.thumb, loading: 'lazy' }) : ''),
      h('td', {}, (x.summary || x.id).slice(0, 60)),
      h('td', {}, fmtDate(x.published_at)),
      h('td', {}, h('span', { class: 'badge' + (x.action === 'reblog' ? ' accent' : '') }, t('act_' + x.action)), x.reason ? ' ' + t('why_' + x.reason) : '', x.tag ? ' #' + x.tag : ''))))));
  },

  // Older posts are never reblogged by switching a route on; here they can be picked explicitly
  async backfill(r) {
    const rows = (await call('routePreview', { ...r, history: true })).filter(x => x.action === 'reblog');
    const pick = new Set();
    const body = h('div', {}, rows.length ? h('table', { class: 'table' }, h('tbody', {}, rows.slice(0, 200).map(x => h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', onchange: e => { e.target.checked ? pick.add(x) : pick.delete(x); } })),
      h('td', { class: 'thumbcell' }, x.thumb ? h('img', { src: x.thumb, loading: 'lazy' }) : ''),
      h('td', {}, (x.summary || x.id).slice(0, 60)), h('td', {}, fmtDate(x.published_at)))))) : empty(t('noPosts')));
    const ok = await modal(t('backfill'), body, [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }], { wide: true });
    if (!ok || !pick.size) return;
    await call('reblogTo', { targets: [...pick].map(x => ({ blog: x.blog, id: x.id })), dest: r.dest });
    toast(t('queued', pick.size), 'ok');
  },
};
