'use strict';
// Posts: "Managed here" (one card per work, filed under its management blog) and "Displayed here" (the actual
// posts of a blog). Multi-select, one preview, one Apply. The detail drawer lists every owned instance.

const PostsPage = {
  f: { view: 'managed', blog: '', state: '', kind: '', q: '', sort: 'new', expiring: false, review: false, tags: [] },
  sel: new Map(), // key blog/id -> { blog, id, item_id }
  rows: [], total: 0, limit: 60,

  async render(root, params = {}) {
    this.bindKeys();
    this.root = root;
    if (params && Object.keys(params).length) {
      this.f = { ...this.f, expiring: false, review: false, state: '', ...params };
      if (params.expiring) this.f.view = 'displayed';
    }
    this.limit = 60;
    root.replaceChildren(h('header', { class: 'page-head' }, h('h1', {}, t('navPosts'))), this.toolbar(), h('div', { id: 'selbar' }), h('div', { id: 'postList' }));
    await this.load();
  },
  refresh(ev) { if (ev.type === 'pass' || (ev.type === 'job' && !this.loading)) this.load(true); },

  toolbar() {
    const f = this.f;
    const set = patch => { Object.assign(this.f, patch); this.limit = 60; this.load(); this.root.querySelector('.toolbar').replaceWith(this.toolbar()); };
    const blogs = App.status.blogs || [];
    return h('div', { class: 'toolbar' },
      h('div', { class: 'seg' },
        h('button', { class: f.view === 'managed' && !f.expiring ? 'on' : '', title: t('managedHint'), onclick: () => set({ view: 'managed', expiring: false }) }, t('managedHere')),
        h('button', { class: f.view === 'displayed' && !f.expiring ? 'on' : '', title: t('displayedHint'), onclick: () => set({ view: 'displayed', expiring: false }) }, t('displayedHere')),
        h('button', { class: f.expiring ? 'on' : '', onclick: () => set({ expiring: true, view: 'displayed' }) }, '⏱ ' + t('expiringSoon'))),
      select([{ value: '', label: t('allBlogs') }, ...blogs.map(b => ({ value: b.uuid, label: b.name + (b.role === 'material' ? ' · ' + t('role_material') : '') }))], f.blog, v => set({ blog: v })),
      f.expiring ? null : select([{ value: '', label: t('allStates') }, ...['published', 'private', 'draft', 'queue'].map(s => ({ value: s, label: t('state_' + s) }))], f.state, v => set({ state: v })),
      f.expiring || f.view === 'managed' ? null : select([{ value: '', label: t('allKinds') }, { value: 'original', label: t('kind_original') }, { value: 'reblog', label: t('kind_reblog') }], f.kind, v => set({ kind: v })),
      f.expiring ? null : h('input', { type: 'search', class: 'grow', placeholder: t('search'), value: f.q, oninput: e => { clearTimeout(this.qt); this.qt = setTimeout(() => { this.f.q = e.target.value; this.load(); }, 300); } }),
      select([{ value: 'new', label: f.expiring ? t('dueIn', '…') : t('sortNew') }, ...(f.expiring ? [] : [{ value: 'old', label: t('sortOld') }]), { value: 'notes', label: t('sortNotes') }], f.sort, v => set({ sort: v })),
      f.expiring ? null : h('button', { class: f.tags.length ? 'on' : '', onclick: () => this.tagFilter(set) }, t('filterTags') + (f.tags.length ? ' (' + f.tags.length + ')' : '')),
      f.tags.length && !f.expiring ? h('div', { class: 'filter-line small' }, h('span', { class: 'muted' }, t(f.view === 'managed' ? 'filterAllManaged' : 'filterAllDisplayed') + ' '),
        f.tags.map((tg, i) => [i ? h('span', { class: 'muted' }, ' AND ') : null, h('button', { class: 'chip on', onclick: () => set({ tags: f.tags.filter(x => x !== tg) }) }, '#' + tg, ' ✕')])) : null,
    );
  },

  // Several category/tag conditions at once; every one must hold (whole tags)
  async tagFilter(set) {
    const [cats, groups] = await Promise.all([call('categories'), call('categoryGroups')]);
    const chosen = new Set(this.f.tags);
    const box = h('div', {});
    const draw = () => box.replaceChildren(
      h('p', { class: 'muted small' }, t('filterHint')),
      catSections(groups, cats).map(([g, list]) => h('div', { class: 'cat-group' }, h('div', { class: 'muted small' }, groupName(g)),
        h('div', { class: 'chips' }, list.map(c => h('button', { class: 'chip' + (chosen.has(c.tag) ? ' on' : ''), title: '#' + c.tag, onclick: () => { chosen.has(c.tag) ? chosen.delete(c.tag) : chosen.add(c.tag); draw(); } }, c.name))))),
      h('input', { placeholder: t('filterTagInput'), onkeydown: e => { if (e.key === 'Enter') { e.target.value.split(',').map(x => x.trim().replace(/^#/, '')).filter(Boolean).forEach(x => chosen.add(x)); draw(); } } }),
      h('div', { class: 'chips' }, [...chosen].map(tg => h('button', { class: 'chip on', onclick: () => { chosen.delete(tg); draw(); } }, '#' + tg, ' ✕'))));
    draw();
    const ok = await modal(t('filterTags'), box, [{ label: t('clear'), value: 'clear' }, { label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }], { wide: true });
    if (ok === 'clear') set({ tags: [] });
    else if (ok) set({ tags: [...chosen] });
  },

  async load(quiet = false) {
    this.loading = true;
    const list = this.root.querySelector('#postList');
    if (!quiet) list.classList.add('loading');
    try {
      if (this.f.review) {
        const r = await call('review');
        list.replaceChildren(this.reviewView(r));
        return;
      }
      if (this.f.expiring) {
        const rows = await call('expiring', { days: 7, blog: this.f.blog || null, sort: this.f.sort === 'notes' ? 'notes' : 'due' });
        this.rows = rows.map(r => ({ ...r, expiry: r, tags: [] }));
        this.total = rows.length;
      } else {
        const r = await call('posts', { ...this.f, share: !this.f.blog, blog: this.f.blog || null, state: this.f.state || null, kind: this.f.kind || null, limit: this.limit });
        this.rows = r.rows; this.total = r.total;
      }
      list.replaceChildren(
        h('div', { class: 'list-head' }, h('span', { class: 'muted' }, t('total', this.total))),
        this.rows.length ? this.grid(this.rows, { selectable: true, onOpen: r => this.openDetail(r) })
          : this.f.q || this.f.blog || this.f.state || this.f.kind || this.f.tags.length
            ? empty(t('noMatch'), h('button', { onclick: () => { Object.assign(this.f, { q: '', blog: '', state: '', kind: '', tags: [] }); this.render(this.root); } }, t('clearFilters')))
            : empty(t('noPosts')),
        this.rows.length < this.total ? h('div', { class: 'center' }, h('button', { onclick: () => { this.limit += 60; this.load(); } }, t('loadMore'))) : null);
      this.selbar();
    } finally { this.loading = false; list.classList.remove('loading'); }
  },

  // Shared card grid (also used on Home)
  grid(rows, { selectable = false, onOpen } = {}) {
    return h('div', { class: 'cards' }, rows.map(r => {
      const k = r.blog + '/' + r.id;
      const on = this.sel.has(k);
      const ex = r.expiry;
      const badges = [stateBadge(r.state)];
      if (r.display === 'keep_visible') badges.push(h('span', { class: 'badge keep' }, t('pol_keep_visible')));
      if (r.display === 'keep_hidden') badges.push(h('span', { class: 'badge' }, t('pol_keep_hidden')));
      if (r.auto_hidden) badges.push(h('span', { class: 'badge' }, t('autoHidden')));
      if (r.conflicted) badges.push(h('span', { class: 'badge warn' }, t('conflict')));
      if (r.pinned) badges.push(h('span', { class: 'badge' }, t('pinned')));
      if (r.legacy) badges.push(h('span', { class: 'badge' }, t('legacy')));
      if (ex && ex.action === 'hide') badges.push(h('span', { class: 'badge accent' }, t('dueNow')));
      else if (ex && ex.action === 'none' && ex.reason === 'not_due' && ex.due) { const d = inDays(ex.due); if (d <= 14) badges.push(h('span', { class: 'badge accent' }, t('dueIn', d))); }
      const card = h('div', { class: 'pcard' + (on ? ' sel' : ''), 'data-k': k,
        onclick: e => {
          if (e.target.closest('.check') || e.target.closest('.open')) return;
          if (!selectable) return onOpen?.(r);
          if (this.dragMoved) { this.dragMoved = false; return; }
          // with a selection (or a modifier) a click selects, as in the old manager; otherwise it opens
          if (e.shiftKey && this.anchor) return this.selectRange(this.anchor, k);
          if (e.ctrlKey || e.metaKey || this.sel.size) return this.toggleKey(k);
          onOpen?.(r);
        },
        ondblclick: e => { if (selectable && !e.target.closest('.check')) onOpen?.(r); },
        onmousedown: e => { if (selectable && e.button === 0 && !e.target.closest('.check, .open, a, button, input')) this.dragStart(k, e); },
        onmouseenter: () => { if (this.drag) this.dragOver(k); } },
        selectable ? h('label', { class: 'check', onclick: e => e.stopPropagation() }, h('input', { type: 'checkbox', checked: on, onclick: e => { if (e.shiftKey && this.anchor) { e.preventDefault(); this.selectRange(this.anchor, k); } }, onchange: e => { this.setKey(k, e.target.checked); } })) : null,
        selectable ? h('button', { class: 'open ghost icon', title: t('openDetail'), onclick: e => { e.stopPropagation(); onOpen?.(r); } }, '↗') : null,
        r.thumb ? h('div', { class: 'thumb' }, h('img', { src: r.thumb, loading: 'lazy', alt: '' })) : h('div', { class: 'thumb text' }, (r.summary || '').slice(0, 160)),
        h('div', { class: 'meta' },
          h('div', { class: 'row1' }, h('span', { class: 'blog' }, r.blog_name || blogName(r.blog)), h('span', { class: 'muted' }, fmtDate(r.published_at))),
          r.thumb && r.summary ? h('div', { class: 'sum' }, r.summary.slice(0, 80)) : null,
          h('div', { class: 'badges' }, badges),
          h('div', { class: 'row2 muted small' },
            r.manager && r.manager !== r.blog ? h('span', {}, t('managedBy', r.manager_name || blogName(r.manager))) : null,
            r.copies > 1 ? h('span', {}, t('copies', r.copies)) : null,
            r.kind === 'reblog' && r.external ? h('span', {}, t('kind_reblog')) : null,
            r.notes != null ? h('span', {}, '♥ ' + r.notes) : null)));
      return card;
    }));
  },

  // ----- selection: one key per physical post (blog/id), in page order -----
  rowOf(k) { return this.rows.find(r => r.blog + '/' + r.id === k); },
  setKey(k, on) {
    const r = this.rowOf(k);
    if (!r) return;
    if (on) this.sel.set(k, { blog: r.blog, id: r.id, item_id: r.item_id, kind: r.kind }); else this.sel.delete(k);
    this.anchor = k;
    this.paintSel();
  },
  toggleKey(k) { this.setKey(k, !this.sel.has(k)); },
  selectRange(a, b) {
    const keys = this.rows.map(r => r.blog + '/' + r.id);
    let i = keys.indexOf(a), j = keys.indexOf(b);
    if (i < 0 || j < 0) return this.toggleKey(b);
    if (i > j) [i, j] = [j, i];
    for (const k of keys.slice(i, j + 1)) { const r = this.rowOf(k); this.sel.set(k, { blog: r.blog, id: r.id, item_id: r.item_id, kind: r.kind }); }
    this.anchor = b;
    this.paintSel();
  },
  // drag across cards: everything between the first card and the one under the pointer takes the first card's new state
  dragStart(k, e) {
    this.drag = { start: k, value: !this.sel.has(k), base: new Map(this.sel) };
    this.dragMoved = false;
    const up = () => { this.drag = null; window.removeEventListener('mouseup', up); };
    window.addEventListener('mouseup', up);
    void e;
  },
  dragOver(k) {
    const d = this.drag;
    if (!d || k === d.last) return;
    d.last = k;
    this.dragMoved = true;
    const keys = this.rows.map(r => r.blog + '/' + r.id);
    let i = keys.indexOf(d.start), j = keys.indexOf(k);
    if (i > j) [i, j] = [j, i];
    this.sel = new Map(d.base);
    for (const key of keys.slice(i, j + 1)) {
      const r = this.rowOf(key);
      if (d.value) this.sel.set(key, { blog: r.blog, id: r.id, item_id: r.item_id, kind: r.kind }); else this.sel.delete(key);
    }
    this.anchor = k;
    this.paintSel();
  },
  // repaint the cards' state without reloading the list
  paintSel() {
    for (const c of this.root.querySelectorAll('.pcard[data-k]')) {
      const on = this.sel.has(c.dataset.k);
      c.classList.toggle('sel', on);
      const box = c.querySelector('.check input');
      if (box) box.checked = on;
    }
    this.selbar();
  },

  toggleSel(r, on) { this.setKey(r.blog + '/' + r.id, on); },

  selbar() {
    const bar = this.root.querySelector('#selbar');
    if (!bar) return;
    const n = this.sel.size;
    bar.replaceChildren(n || this.rows.length ? h('div', { class: 'selbar' + (n ? ' active' : '') },
      h('button', { class: 'ghost', onclick: () => this.selectAll() }, t('selectPage')),
      n ? null : h('span', { class: 'muted small' }, t('selHint')),
      n ? [
        h('b', {}, t('selected', n)),
        h('button', { class: 'ghost', onclick: () => { this.sel.clear(); this.load(true); } }, t('clearSel')),
        h('span', { class: 'sep' }),
        h('button', { class: 'primary', onclick: () => this.bulkTags() }, t('bulkTags')),
        h('button', { onclick: () => this.includeLinked() }, t('includeLinked')),
        h('button', { onclick: () => this.bulk('published') }, t('makePublic')),
        h('button', { onclick: () => this.bulk('private') }, t('makePrivate')),
        h('button', { onclick: () => this.keep() }, t('keepVisible')),
        h('button', { class: 'ghost', onclick: async () => { await call('followRule', { targets: [...this.sel.values()] }); toast('✓'); this.load(true); } }, t('followRule')),
      ] : null) : '');
  },

  selectAll() {
    for (const r of this.rows) this.sel.set(r.blog + '/' + r.id, { blog: r.blog, id: r.id, item_id: r.item_id, kind: r.kind });
    this.paintSel();
  },
  // keyboard: Ctrl+A selects what is loaded, Esc clears (not while typing)
  bindKeys() {
    if (this.keysBound) return;
    this.keysBound = true;
    window.addEventListener('keydown', e => {
      if (App.page !== PostsPage || document.querySelector('.modal-back')) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); }
      else if (e.key === 'Escape' && this.sel.size) { this.sel.clear(); this.paintSel(); }
    });
  },

  // Tags on the selection, as the old manager's Tags card: counts per tag, click to take a tag off, + to put it on
  // the chosen posts that lack it, a box for new tags. Originals only; reblogs keep the tags they were made with.
  async bulkTags() {
    const targets = [...this.sel.values()].map(({ blog, id }) => ({ blog, id }));
    const [info, cats, groups] = await Promise.all([call('selectionTags', { targets }), call('categories'), call('categoryGroups')]);
    if (!info.originals) return toast(t('bulkTagsNoOriginals'));
    const countOf = tag => info.tags.find(x => x.tag.toLowerCase() === tag.toLowerCase())?.n || 0;
    const remove = new Set(), add = [];
    const box = h('div', {});
    const draw = () => box.replaceChildren(
      h('p', { class: 'muted small' }, t('bulkTagsHint', info.originals, info.snapshots)),
      // general categories: one tap puts the category's tag on the selected originals that lack it
      cats.length ? h('div', { class: 'cat-pick' }, h('div', { class: 'muted small' }, t('bulkTagsCats')),
        catSections(groups, cats).map(([g, list]) => list.length ? h('div', { class: 'form-row wrap' }, h('span', { class: 'muted small' }, groupName(g)),
          list.map(c => { const have = countOf(c.tag), all = have >= info.originals, on = add.includes(c.tag);
            return h('button', { class: 'chip' + (on || all ? ' on' : ''), disabled: all, title: '#' + c.tag + ' · ' + have + '/' + info.originals,
              onclick: () => { on ? add.splice(add.indexOf(c.tag), 1) : add.push(c.tag); remove.delete(c.tag); draw(); } }, c.name, all ? ' ✓' : have ? ` ${have}/${info.originals}` : ''); })) : null)) : null,
      h('div', { class: 'chips' }, info.tags.map(x => h('span', { class: 'chip-pair' },
        h('button', { class: 'chip' + (remove.has(x.tag) ? ' struck' : ''), title: t('bulkTagsRemove'), onclick: () => { remove.has(x.tag) ? remove.delete(x.tag) : remove.add(x.tag); add.splice(0, add.length, ...add.filter(a => a !== x.tag)); draw(); } }, '#' + x.tag, ' ', h('span', { class: 'muted small' }, `${x.n}/${info.originals}`)),
        x.n < info.originals && !remove.has(x.tag) ? h('button', { class: 'chip' + (add.includes(x.tag) ? ' on' : ''), title: t('bulkTagsFill'), onclick: () => { add.includes(x.tag) ? add.splice(add.indexOf(x.tag), 1) : add.push(x.tag); draw(); } }, '⊕') : null))),
      add.filter(a => !info.tags.some(x => x.tag === a)).length ? h('div', { class: 'chips' }, add.filter(a => !info.tags.some(x => x.tag === a)).map(a => h('button', { class: 'chip on', onclick: () => { add.splice(add.indexOf(a), 1); draw(); } }, '+#' + a, ' ✕'))) : null,
      h('input', { placeholder: t('extraHint'), onkeydown: e => { if (e.key === 'Enter') { const v = e.target.value.split(',').map(x => x.trim().replace(/^#/, '')).filter(Boolean); add.push(...v.filter(x => !add.includes(x))); e.target.value = ''; draw(); } } }),
      h('p', { class: 'small' }, remove.size || add.length ? t('bulkTagsWill', remove.size, add.length) : t('bulkTagsNothing')));
    draw();
    const ok = await modal(t('bulkTags'), box, [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }], { wide: true });
    if (!ok || (!remove.size && !add.length)) return;
    const r = await call('applyTags', { targets, add, remove: [...remove] });
    toast(t('queuedN', r.queued) + (r.snapshots ? ' · ' + t('snapshotsKept', r.snapshots) : '') + (r.labelsOk === false ? ' · ' + t('heldForLabels') : ''), 'ok');
  },

  async includeLinked() {
    const items = [...new Set([...this.sel.values()].map(s => s.item_id).filter(Boolean))];
    if (!items.length) return;
    const linked = await call('linked', { items });
    for (const l of linked) this.sel.set(l.blog + '/' + l.id, { blog: l.blog, id: l.id });
    this.load(true);
  },

  async bulk(target) {
    const targets = [...this.sel.values()].map(({ blog, id }) => ({ blog, id }));
    const pv = await call('visibilityPreview', { targets, target });
    const title = target === 'published' ? t('makePublic') : t('makePrivate');
    const body = h('div', {},
      h('p', { class: 'big' }, t('bulkChange', pv.change.length)),
      pv.already.length ? h('p', {}, t('bulkAlready', pv.already.length)) : null,
      pv.unsupported.length ? h('p', { class: 'warn-text' }, t('bulkUnsupported', pv.unsupported.length)) : null,
      pv.copies.length ? h('p', {}, t('bulkCopies', pv.copies.length)) : null,
      h('p', { class: 'muted' }, target === 'published' ? t('bulkPolicyPublic') : t('bulkPolicyPrivate')),
      target === 'private' ? h('p', { class: 'muted' }, t('bulkDelay')) : null,
      pv.labelsOk ? null : h('p', { class: 'banner warn' }, t('labelsBlocked')),
      h('ul', { class: 'mini-list' }, pv.change.slice(0, 30).map(p => h('li', {}, h('b', {}, blogName(p.blog)), ' · ', (p.summary || p.id).slice(0, 70)))));
    const ok = await modal(t('bulkTitle', title), body, [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary', disabled: !pv.change.length && !pv.already.length }]);
    if (!ok) return;
    const r = await call('visibility', { targets, target });
    toast(t('queued', r.queued), 'ok');
    this.sel.clear();
    this.load(true);
  },

  async keep() {
    const targets = [...this.sel.values()].map(({ blog, id }) => ({ blog, id }));
    const r = await call('keepVisible', { targets });
    toast(t('keepDone', targets.length) + (r.queued ? ' · ' + t('queued', r.queued) : ''), 'ok');
    this.sel.clear();
    this.load(true);
  },

  async openDetail(r) {
    if (!r.item_id) return;
    const it = await call('item', { id: r.item_id });
    if (!it) return;
    const blogs = App.status.blogs || [];
    const ev = it.evidence || {};
    const body = h('div', { class: 'detail' },
      h('div', { class: 'detail-head' },
        it.members[0]?.thumb ? h('img', { src: it.members[0].thumb, class: 'detail-thumb' }) : null,
        h('div', {},
          h('p', {}, h('b', {}, t('management') + ': '), blogName(it.manager), ' ', h('span', { class: 'muted' }, '(' + t('rule_' + (ev.rule || 'manual')) + ')')),
          it.status !== 'ok' ? h('p', { class: 'banner warn' }, t('st_' + it.status)) : null,
          it.external ? null : h('p', {}, h('b', {}, t('origin') + ': '), blogName(it.origin_blog)),
          it.external ? null : h('div', { class: 'form-row' }, h('span', {}, t('assignTo') + ' '),
            select(blogs.filter(b => b.role === 'share').map(b => ({ value: b.uuid, label: b.name })), it.manager, async v => { await call('assign', { item: it.id, manager: v }); toast('✓'); this.openDetail(r); })),
          (it.members.find(m => m.summary)?.summary) ? h('p', { class: 'muted' }, it.members.find(m => m.summary).summary.slice(0, 300)) : null)),
      h('h3', {}, t('instances')),
      h('div', { class: 'instances' }, it.members.map(m => this.instanceRow(m, r))),
      this.versionsView(it),
      it.external ? null : this.tagEditor(it),
      this.fileInto(it));
    await modal(t('detailTitle'), body, [{ label: t('close'), value: null }], { wide: true });
    this.load(true);
  },

  // Logical work -> source versions -> reblog instances (docs/REBLOG_POLICY.md). A destination whose newest copy
  // holds an older version offers "Reblog the new version"; nothing is ever re-sent or rewritten on its own.
  versionsView(it) {
    const v = it.versions;
    const orig = it.members.find(m => m.kind === 'original');
    const anchor = orig || it.members[0];
    const manage = anchor ? h('button', { onclick: async () => { await VersionsDialog.open({ blog: anchor.blog, id: anchor.id }); } }, t('versionsManage')) : null;
    if (!v || !v.dests.length) return v && v.revisions?.length > 1 ? h('div', { class: 'versions' }, h('h3', {}, t('versions')), manage) : null;
    return h('div', { class: 'versions' }, h('div', { class: 'form-row' }, h('h3', { class: 'grow' }, t('versions')), manage), h('p', { class: 'muted small' }, t('versionsHint', v.latest || '?')),
      v.dests.map(d => h('div', { class: 'form-row wrap' }, h('b', {}, blogName(d.dest)), ' ',
        d.copies.map(c => h('span', { class: 'badge' + (c.status === 'tombstone' ? '' : c.status === 'conflict' ? ' warn' : ' keep'), title: (c.tags ? '#' + c.tags.join(' #') : '') + (c.reason ? ' - ' + c.reason : '') },
          t('versionN', c.rev) + (c.version_unknown ? ' ?' : '') + ' · ' + t('dst_' + c.status))),
        d.newer && orig?.state === 'published' ? h('button', { onclick: async () => {
          const ok = await modal(t('reblogNew'), h('p', {}, t('reblogNewQ', blogName(d.dest))), [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
          if (!ok) return;
          try { await call('reblogTo', { targets: [{ blog: orig.blog, id: orig.id }], dest: d.dest }); toast(t('queued', 1), 'ok'); } catch (e) { toast(String(e.message || e), 'error'); }
        } }, t('reblogNew')) : d.newer ? h('span', { class: 'muted small' }, t('sourceUpdated')) : null)));
  },

  // Tags of the work, edited once and applied to the chosen originals (each one shown, each its own edit).
  // Reblogs are frozen snapshots: listed as kept as they are, never offered as targets.
  tagEditor(it) {
    const all = it.members.filter(m => ['published', 'private', 'draft', 'queue'].includes(m.state));
    const live = all.filter(m => m.kind !== 'reblog');
    const kept = all.filter(m => m.kind === 'reblog');
    const mgr = live.find(m => m.blog === it.manager) || live[0];
    if (!mgr) return null;
    const remove = new Set(), add = [];
    const targets = new Set(live.map(m => m.blog + '/' + m.id));
    const box = h('div', { class: 'tag-edit' });
    const draw = () => box.replaceChildren(
      h('h3', {}, t('workTags')), h('p', { class: 'muted small' }, t('workTagsHint', blogName(mgr.blog))),
      h('div', { class: 'chips' }, mgr.tags.map(tg => h('button', { class: 'chip' + (remove.has(tg) ? ' struck' : ''), onclick: () => { remove.has(tg) ? remove.delete(tg) : remove.add(tg); draw(); } }, '#' + tg)),
        add.map(tg => h('button', { class: 'chip on', onclick: () => { add.splice(add.indexOf(tg), 1); draw(); } }, '+#' + tg))),
      h('input', { placeholder: t('extraHint'), onkeydown: e => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) { add.push(...v.split(',').map(x => x.trim()).filter(Boolean)); draw(); } } } }),
      h('div', { class: 'form-row wrap' }, h('span', { class: 'muted small' }, t('applyTo')), live.map(m => h('label', { class: 'check-label' },
        h('input', { type: 'checkbox', checked: targets.has(m.blog + '/' + m.id), onchange: e => { const k = m.blog + '/' + m.id; e.target.checked ? targets.add(k) : targets.delete(k); } }), m.blog_name, ' · ', t('kind_' + m.kind)))),
      kept.length ? h('p', { class: 'muted small' }, t('snapshotsKept', kept.length)) : null,
      h('button', { class: 'primary', disabled: !remove.size && !add.length, onclick: async () => {
        const list = live.filter(m => targets.has(m.blog + '/' + m.id)).map(m => ({ blog: m.blog, id: m.id }));
        if (!list.length) return;
        const r = await call('applyTags', { targets: list, add, remove: [...remove] });
        toast(t('queued', r.queued) + (r.labelsOk ? '' : ' · ' + t('labelsBlocked')), r.labelsOk ? 'ok' : 'error', 6000);
        remove.clear(); add.length = 0; draw();
      } }, t('applyTags')));
    draw();
    return box;
  },
  // A main-blog original with no sharing side blog yet can be filed into one (an explicit reblog)
  fileInto(it) {
    if (it.external || it.status !== 'ok') return null;
    const orig = it.members.find(m => m.blog === it.origin_blog && m.id === it.origin_id);
    const main = (App.status.blogs || []).find(b => b.is_primary);
    if (!orig || orig.blog !== main?.uuid || it.manager !== main.uuid || orig.state !== 'published') return null;
    const sides = (App.status.blogs || []).filter(b => b.role === 'share' && !b.is_primary);
    if (!sides.length) return null;
    let dest = sides[0].uuid;
    return h('div', { class: 'form-row wrap' }, h('span', {}, t('fileInto')), select(sides.map(b => ({ value: b.uuid, label: b.name })), dest, v => { dest = v; }),
      h('button', { onclick: async () => {
        const ok = await modal(t('fileInto'), h('p', {}, t('fileIntoQ', blogName(dest))), [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
        if (ok) { await call('reblogTo', { targets: [{ blog: orig.blog, id: orig.id }], dest }); toast(t('queued', 1), 'ok'); }
      } }, t('apply')));
  },

  instanceRow(m, r) {
    const ex = m.expiry;
    const pol = m.policy || {};
    const url = `https://${blogName(m.blog)}.tumblr.com/post/${m.id}`;
    const act = async (fn) => { await fn(); toast('✓'); const it = await call('item', { id: m.item_id }); row.replaceWith(this.instanceRow(it.members.find(x => x.blog === m.blog && x.id === m.id), r)); };
    const tgt = [{ blog: m.blog, id: m.id }];
    const row = h('div', { class: 'instance' },
      h('div', { class: 'inst-main' },
        h('div', { class: 'inst-line' }, h('b', {}, m.blog_name), h('span', { class: 'badge' }, t('kind_' + m.kind)), stateBadge(m.state),
          m.snapshot ? h('span', { class: 'badge', title: t('snapshotHint') }, m.snapshot.rev ? t('versionN', m.snapshot.rev) + (m.snapshot.version_unknown ? ' ?' : '') : t('snapshot')) : null,
          pol.display !== 'follow_rule' ? h('span', { class: 'badge keep' }, t('pol_' + pol.display)) : null,
          pol.auto_hide ? h('span', { class: 'badge' }, t('autoHidden')) : null),
        h('div', { class: 'muted small' }, fmtDate(m.published_at), m.notes != null ? ' · ' + t('noteCount', m.notes, ago(m.notes_at)) : '',
          ' · ', h('a', { href: url, target: '_blank' }, t('openOnTumblr'))),
        h('div', { class: 'small' }, ex ? [t('effRule', Math.round((ex.due - (ex.anchor?.at || 0)) / 86400e3) || '?', ex.due ? fmtDate(ex.due) : '—'),
          ex.anchor && (ex.anchor.blog !== m.blog || ex.anchor.id !== m.id) ? ' · ' + t('anchor') : '', ex.shadowed ? ' · ' + t('shadowed') : ''] : h('span', { class: 'muted' }, t('noRule'))),
        // what a logged-out visitor saw (apart from the owner state); never shown as checked when it wasn't
        ['published', 'private'].includes(m.state) ? h('div', { class: 'small muted' },
          m.publicCheck ? [t('pc_' + m.publicCheck.state), m.publicCheck.checked_at ? ' · ' + fmtTime(m.publicCheck.checked_at) : '']
            : t('pc_none'),
          ' ', h('button', { class: 'ghost small', onclick: () => act(() => call('publicCheckNow', { blog: m.blog, id: m.id })) }, t('pcCheckNow'))) : null,
        (m.jobs || []).map(j => h('div', { class: 'small muted' }, '⟳ ', t('js_' + j.status), j.error ? ' — ' + j.error : '')),
        pol.conflict ? h('div', { class: 'banner warn small' }, t('conflict'),
          h('button', { onclick: () => act(() => call('resolveConflict', { blog: m.blog, id: m.id, display: 'keep_visible' })) }, t('resolveVisible')),
          h('button', { onclick: () => act(() => call('resolveConflict', { blog: m.blog, id: m.id, display: 'keep_hidden' })) }, t('resolveHidden')),
          h('button', { onclick: () => act(() => call('resolveConflict', { blog: m.blog, id: m.id, display: 'follow_rule' })) }, t('resolveRule'))) : null),
      h('div', { class: 'inst-actions' },
        m.state === 'published' ? h('button', { title: t('onlyThis'), onclick: () => act(() => call('visibility', { targets: tgt, target: 'private' })) }, t('makePrivate')) : null,
        m.state === 'private' ? h('button', { title: t('onlyThis'), onclick: () => act(() => call('visibility', { targets: tgt, target: 'published' })) }, t('makePublic')) : null,
        pol.display !== 'keep_visible' ? h('button', { onclick: () => act(() => call('keepVisible', { targets: tgt })) }, t('keepVisible')) : null,
        pol.display !== 'follow_rule' ? h('button', { class: 'ghost', onclick: () => act(() => call('followRule', { targets: tgt })) }, t('followRule')) : null));
    return row;
  },

  reviewView(r) {
    return h('div', {},
      r.items.length ? h('section', { class: 'card' }, h('h2', {}, t('management')),
        h('div', { class: 'cards' }, r.items.map(i => h('div', { class: 'pcard', onclick: () => this.openDetail({ item_id: i.id }) },
          i.thumb ? h('div', { class: 'thumb' }, h('img', { src: i.thumb })) : h('div', { class: 'thumb text' }, (i.summary || '').slice(0, 120)),
          h('div', { class: 'meta' }, h('span', { class: 'badge warn' }, t('st_' + i.status))))))) : null,
      r.conflictPosts.length ? h('section', { class: 'card' }, h('h2', {}, t('conflict')),
        h('div', { class: 'cards' }, r.conflictPosts.map(p => h('div', { class: 'pcard', onclick: () => this.openDetail(p) },
          p.thumb ? h('div', { class: 'thumb' }, h('img', { src: p.thumb })) : h('div', { class: 'thumb text' }, (p.summary || '').slice(0, 120)),
          h('div', { class: 'meta' }, h('b', {}, blogName(p.blog)), ' ', stateBadge(p.state), ' ', h('span', { class: 'badge keep' }, t('pol_' + p.display))))))) : null,
      !r.items.length && !r.conflictPosts.length ? empty('✓') : null);
  },
};
