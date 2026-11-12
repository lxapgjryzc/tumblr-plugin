'use strict';
// Posts (docs/CONTENT_BROWSER_UX_SPEC.md): Works (one card per work, filed under its managing blog) or Blog posts
// (each actual post). A collapsible filter pane beside the results; every condition applies at once through one
// service query (query.js), shown in a condition bar. A card click opens the detail pane, the checkbox selects.
// Filtering reads local data only: it never queues a job.

const PF_DEFAULT = () => ({ view: 'managed', scope: 'share', blog: '', text: '', state: '', kind: '', cats: {}, tags: { inc: [], mode: 'all', exc: [], none: false },
  missing: false, date: '', from: '', to: '', policy: '', proc: '', expiring: null, quick: '', sort: 'new' });
const tkey = s => String(s ?? '').replace(/%([0-9a-f]{2})/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } }).trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase();

const PostsPage = {
  f: PF_DEFAULT(),
  ui: { pane: false, layout: 'grid', open: {} },
  sel: new Map(),     // card key blog/id -> { blog, id, item_id, kind, origin_missing }
  extra: new Map(),   // linked posts added on purpose, outside the current results
  frozen: null,       // { total, at } when "every match" was chosen
  rows: [], total: 0, limit: 60, seq: 0, tagDraft: '',

  restore() {
    if (this.restored) return;
    this.restored = true;
    try {
      const f = JSON.parse(localStorage.getItem('postsQuery') || 'null');
      if (f && f.v === 2) this.f = { ...PF_DEFAULT(), ...f.f };
      const ui = JSON.parse(localStorage.getItem('postsUi') || 'null');
      if (ui) this.ui = { ...this.ui, ...ui };
    } catch {}
  },
  persist() {
    try { localStorage.setItem('postsQuery', JSON.stringify({ v: 2, f: this.f })); localStorage.setItem('postsUi', JSON.stringify(this.ui)); } catch {}
  },

  async render(root, params = {}) {
    this.restore();
    this.bindKeys();
    this.root = root;
    // Leaving the page drops the selection; the query, layout, loaded range and scroll come back
    this.sel.clear(); this.extra.clear(); this.frozen = null;
    this.cats = null; this.res = null;
    let back = true;
    if (params && Object.keys(params).length) {
      back = false;
      const keep = { scope: this.f.scope, blog: this.f.blog, sort: 'new' };
      const p = { ...params };
      if (p.review) { delete p.review; p.quick = 'attention'; p.proc = 'attention'; }
      if (p.expiring === true) { p.expiring = { days: 7 }; p.quick = 'expiring'; p.view = 'displayed'; p.sort = 'due'; }
      this.f = { ...PF_DEFAULT(), ...keep, ...p };
      this.limit = 60;
    }
    root.replaceChildren(
      this.head(), this.toolbar(), h('div', { id: 'quickbar' }), h('div', { id: 'condbar' }),
      h('div', { class: 'posts-body' + (this.ui.pane ? ' with-pane' : '') }, h('aside', { id: 'filterPane', class: 'filter-pane' }), h('section', { class: 'results' }, h('div', { id: 'resHead' }), h('div', { id: 'postList' }))),
      h('div', { id: 'selbar' }));
    this.paintChrome();
    await this.load({ restoreScroll: back });
  },
  flush() { this.scroll = $('#main')?.scrollTop || 0; this.closeDetail(true); },
  refresh(ev) { if (ev.type === 'pass' || (ev.type === 'job' && !this.loading)) this.load({ quiet: true }); },

  // ----- the query -----
  query(extra = {}) {
    const f = this.f;
    const dayMs = 86400e3;
    let from = null, to = null;
    if (f.date && f.date !== 'custom') from = Date.now() - Number(f.date) * dayMs;
    if (f.date === 'custom') {
      if (f.from) from = new Date(f.from + 'T00:00:00').getTime();
      if (f.to) to = new Date(f.to + 'T00:00:00').getTime() + dayMs - 1; // the end day is included
    }
    return { view: f.view, scope: f.blog ? 'all' : f.scope, blog: f.blog || null, text: f.text, state: f.state || null, kind: f.view === 'displayed' ? f.kind || null : null,
      cats: f.cats, tags: f.tags, missing: f.view === 'managed' && f.missing, from, to, policy: f.policy || null, proc: f.proc || null, expiring: f.expiring, sort: f.sort, ...extra };
  },
  // Every change to what is shown goes through here: selection is dropped (and said so), then one debounced load
  apply(patch, { now = false, keepSel = false } = {}) {
    this.prevF = JSON.parse(JSON.stringify(this.f));
    Object.assign(this.f, patch);
    if (this.f.view === 'managed' && this.f.kind) { this.f.kind = ''; toast(t('pfKindDropped')); }
    if (!keepSel) this.dropSel();
    this.limit = 60;
    this.persist();
    this.paintChrome();
    this.paintPane();
    clearTimeout(this.lt);
    if (now) this.load(); else this.lt = setTimeout(() => this.load(), 250);
  },
  dropSel() {
    const n = this.sel.size + this.extra.size;
    if (!n) return;
    this.sel.clear(); this.extra.clear(); this.frozen = null;
    toast(t('pfSelCleared', n));
  },
  activeCount() {
    const f = this.f;
    let n = Object.values(f.cats).reduce((s, c) => s + (c.inc?.length || 0) + (c.exc?.length || 0) + (c.unset ? 1 : 0), 0);
    n += f.tags.inc.length + f.tags.exc.length + (f.tags.none ? 1 : 0) + (f.text ? 1 : 0) + (f.state && !f.expiring ? 1 : 0) + (f.kind ? 1 : 0) + (f.missing ? 1 : 0)
      + (f.date ? 1 : 0) + (f.policy ? 1 : 0) + (f.proc ? 1 : 0) + (f.expiring ? 1 : 0);
    return n;
  },

  async load({ quiet = false, restoreScroll = false } = {}) {
    const seq = ++this.seq;
    this.loading = true;
    const list = this.root.querySelector('#postList');
    list.classList.add('updating');
    this.paintResHead();
    let r, err = null;
    try {
      [r] = await Promise.all([window.studio.call('posts', { ...this.query(), limit: this.limit, facets: true }), this.cats ? null : this.loadCats()]);
    } catch (e) { err = e; }
    // only the newest query may paint, and only on this page
    if (seq !== this.seq || App.page !== PostsPage || !this.root.isConnected) return;
    this.loading = false;
    list.classList.remove('updating');
    if (err) {
      this.failed = cleanErr(err);
      list.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'warn-text' }, t('pfFailed')), h('p', { class: 'muted small' }, this.failed), h('button', { onclick: () => this.load() }, t('retry'))));
      this.paintResHead();
      return;
    }
    this.failed = null;
    this.res = r;
    this.rows = r.rows; this.total = r.total;
    list.replaceChildren(this.rows.length ? this.results(this.rows) : this.emptyState(r),
      this.rows.length < this.total ? h('div', { class: 'center' }, h('button', { onclick: () => { this.limit += 60; this.load({ quiet: true }); } }, t('pfLoadMore', Math.min(60, this.total - this.rows.length), this.total - this.rows.length))) : null);
    this.paintResHead();
    this.paintPane();
    this.paintSel();
    if (restoreScroll && this.scroll) $('#main').scrollTop = this.scroll;
    void quiet;
  },
  async loadCats() {
    const [cats, groups] = await Promise.all([window.studio.call('categories'), window.studio.call('categoryGroups')]);
    this.cats = cats; this.groups = groups;
  },
  gid: c => String(c.group_id ?? 'none'),

  emptyState(r) {
    if (!r.scopeTotal && !r.coverage?.complete) return empty(t('pfNotSynced'), h('button', { onclick: () => call('syncNow') }, t('syncNow')));
    if (!this.activeCount()) return empty(t('noPosts'));
    return empty(t('pfNoMatch'), h('div', { class: 'form-row center' },
      this.prevF ? h('button', { onclick: () => { const p = this.prevF; this.prevF = null; this.f = p; this.persist(); this.paintChrome(); this.load(); } }, t('pfUndo')) : null,
      h('button', { onclick: () => this.clearConds() }, t('pfClear'))));
  },
  clearConds() {
    const f = this.f;
    this.apply({ ...PF_DEFAULT(), view: f.view, scope: f.scope, blog: f.blog, sort: f.sort === 'due' ? 'new' : f.sort }, { now: true });
  },

  // ----- chrome: head, toolbar, quick filters, condition bar -----
  head() {
    return h('header', { class: 'page-head' }, h('h1', {}, t('navPosts')),
      h('div', { class: 'seg', id: 'viewSeg' }), h('div', { class: 'head-actions muted small', id: 'coverage' }));
  },
  toolbar() {
    const search = h('input', { type: 'search', class: 'grow', id: 'pfText', placeholder: t('pfSearch'), value: this.f.text,
      oncompositionstart: () => { this.composing = true; }, oncompositionend: e => { this.composing = false; this.apply({ text: e.target.value.trim() }); },
      oninput: e => { if (!this.composing) this.apply({ text: e.target.value.trim() }); } });
    return h('div', { class: 'toolbar' },
      h('span', { id: 'scopeSel' }), search,
      h('button', { id: 'paneBtn', onclick: () => this.togglePane() }),
      h('span', { id: 'sortSel' }),
      h('div', { class: 'seg', id: 'layoutSeg' }));
  },
  togglePane(on = !this.ui.pane) {
    this.ui.pane = on; this.persist();
    this.root.querySelector('.posts-body').classList.toggle('with-pane', on);
    this.paintChrome(); this.paintPane();
  },
  paintChrome() {
    const f = this.f, r = this.root;
    if (!r) return;
    const blogs = App.status.blogs || [];
    const seg = r.querySelector('#viewSeg');
    seg.replaceChildren(
      h('button', { class: f.view === 'managed' ? 'on' : '', title: t('pfWorksHint'), onclick: () => f.view !== 'managed' && this.viewTo('managed') }, t('pfWorks')),
      h('button', { class: f.view === 'displayed' ? 'on' : '', title: t('pfPostsHint'), onclick: () => f.view !== 'displayed' && this.viewTo('displayed') }, t('pfPosts')));
    const shareN = blogs.filter(b => b.role === 'share').length;
    const val = f.blog ? 'blog:' + f.blog : 'scope:' + f.scope;
    r.querySelector('#scopeSel').replaceChildren(h('label', { class: 'field-inline' }, h('span', { class: 'muted small' }, t(f.view === 'managed' ? 'pfManagingBlog' : 'pfHomeBlog')),
      select([{ value: 'scope:share', label: t('pfShareBlogs', shareN) }, { value: 'scope:all', label: t('pfAllBlogs') },
        ...blogs.map(b => ({ value: 'blog:' + b.uuid, label: b.name + (b.role ? ' · ' + t('role_' + b.role) : '') }))], val,
      v => { const [k, x] = [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)]; this.apply(k === 'blog' ? { blog: x } : { blog: '', scope: x }); })));
    const ti = r.querySelector('#pfText');
    if (ti && document.activeElement !== ti && ti.value !== f.text) ti.value = f.text;
    const n = this.activeCount();
    const pb = r.querySelector('#paneBtn');
    pb.className = this.ui.pane ? 'on' : '';
    pb.setAttribute('aria-expanded', String(this.ui.pane));
    pb.replaceChildren(t('pfFilter'), n ? h('span', { class: 'count' }, n) : null);
    r.querySelector('#sortSel').replaceChildren(select([{ value: 'new', label: t('sortNew') }, { value: 'old', label: t('sortOld') }, { value: 'notes', label: t('sortNotes') },
      ...(f.expiring ? [{ value: 'due', label: t('pfSortDue') }] : [])], f.sort, v => this.apply({ sort: v }, { keepSel: true }), { 'aria-label': t('pfSort') }));
    r.querySelector('#layoutSeg').replaceChildren(...[['grid', t('pfGrid')], ['fit', t('pfFit')], ['list', t('pfList')]].map(([k, label]) =>
      h('button', { class: this.ui.layout === k ? 'on' : '', onclick: () => { this.ui.layout = k; this.persist(); this.paintChrome(); this.rerenderList(); } }, label)));
    const quick = [['', t('pfQuickAll')], ['expiring', t('expiringSoon')], ['auto_hidden', t('pfQuickAuto')], ['keep_visible', t('pol_keep_visible')], ['attention', t('pfQuickAttention')]];
    r.querySelector('#quickbar').replaceChildren(h('div', { class: 'quick' }, h('span', { class: 'muted small' }, t('pfQuick')),
      quick.map(([k, label]) => h('button', { class: 'chip' + (f.quick === k ? ' on' : ''), onclick: () => this.quickTo(k) }, label))));
    this.paintCond();
  },
  viewTo(view) {
    const patch = { view };
    if (view === 'managed' && this.f.expiring) { toast(t('pfExpiringNeedsPosts')); Object.assign(patch, this.exitQuickPatch()); }
    if (view === 'managed' && this.f.kind) patch.kind = '';
    if (view === 'displayed') patch.missing = false;
    this.apply(patch, { now: true });
  },
  // Quick filters only fill in ordinary conditions; leaving one takes back what it put in, nothing else
  exitQuickPatch() {
    const f = this.f, p = { quick: '' };
    if (f.quick === 'expiring') Object.assign(p, { expiring: null, state: f.quickPrev?.state ?? '', sort: f.quickPrev?.sort ?? 'new', view: f.quickPrev?.view ?? f.view });
    if (f.quick === 'auto_hidden' || f.quick === 'keep_visible') p.policy = f.quickPrev?.policy ?? '';
    if (f.quick === 'attention') p.proc = f.quickPrev?.proc ?? '';
    return p;
  },
  quickTo(k) {
    const f = this.f;
    if (f.quick === k) return;
    const p = this.exitQuickPatch();
    const base = { ...f, ...p };
    p.quick = k;
    p.quickPrev = { view: base.view, state: base.state, sort: base.sort, policy: base.policy, proc: base.proc };
    if (k === 'expiring') {
      if (base.view !== 'displayed') toast(t('pfExpiringSwitched'));
      if (base.state && base.state !== 'published') toast(t('pfExpiringState', t('state_' + base.state)));
      Object.assign(p, { expiring: { days: 7 }, view: 'displayed', state: 'published', sort: 'due', missing: false });
    } else if (k === 'auto_hidden' || k === 'keep_visible') p.policy = k;
    else if (k === 'attention') p.proc = 'attention';
    this.apply(p, { now: true });
  },

  // Active conditions, by group, each removable; long lists fold into "N more"
  paintCond() {
    const f = this.f;
    const bar = this.root.querySelector('#condbar');
    const items = [];
    const chip = (label, onx, cls = '') => h('span', { class: 'cond ' + cls }, h('span', {}, label), h('button', { class: 'ghost icon', 'aria-label': t('pfRemove'), title: t('pfRemove'), onclick: onx }, '✕'));
    if (f.expiring) items.push(chip(t('pfCondExpiring', f.expiring.days), () => this.apply(this.exitQuickPatch(), { now: true }), 'accent'));
    if (f.text) items.push(chip(t('pfCondText', f.text), () => { this.root.querySelector('#pfText').value = ''; this.apply({ text: '' }, { now: true }); }));
    const byId = new Map((this.cats || []).map(c => [c.id, c]));
    for (const [g, c] of Object.entries(f.cats)) {
      const gname = groupName((this.groups || []).find(x => String(x.id) === g) || null);
      const drop = patch => { const next = { ...f.cats }; const v = { ...c, ...patch }; if (!v.inc.length && !v.exc.length && !v.unset) delete next[g]; else next[g] = v; this.apply({ cats: next }, { now: true }); };
      if (c.unset) items.push(chip(t('pfCondUnset', gname), () => drop({ unset: false })));
      if (c.inc?.length) items.push(chip(gname + t('colon') + c.inc.map(id => byId.get(id)?.name || '?').join(c.mode === 'all' ? t('pfAnd') : t('pfOr')), () => drop({ inc: [] })));
      if (c.exc?.length) items.push(chip(t('pfCondExc', gname, c.exc.map(id => byId.get(id)?.name || '?').join(t('pfOr'))), () => drop({ exc: [] }), 'neg'));
    }
    if (f.tags.inc.length) items.push(chip(t(f.tags.mode === 'any' ? 'pfCondTagsAny' : 'pfCondTagsAll', f.tags.inc.map(x => '#' + x).join(' ')), () => this.apply({ tags: { ...f.tags, inc: [] } }, { now: true })));
    if (f.tags.exc.length) items.push(chip(t('pfCondTagsExc', f.tags.exc.map(x => '#' + x).join(' ')), () => this.apply({ tags: { ...f.tags, exc: [] } }, { now: true }), 'neg'));
    if (f.tags.none) items.push(chip(t('pfNoTags'), () => this.apply({ tags: { ...f.tags, none: false } }, { now: true })));
    if (f.missing) items.push(chip(t('pfMissing'), () => this.apply({ missing: false }, { now: true })));
    if (f.state && !f.expiring) items.push(chip(t(f.view === 'managed' ? 'pfCondOrigState' : 'pfCondState', t('state_' + f.state)), () => this.apply({ state: '' }, { now: true })));
    if (f.kind) items.push(chip(t('kind_' + f.kind), () => this.apply({ kind: '' }, { now: true })));
    if (f.date) items.push(chip(f.date === 'custom' ? t('pfCondDates', f.from || '…', f.to || '…') : t('pfCondDays', f.date), () => this.apply({ date: '', from: '', to: '' }, { now: true })));
    if (f.policy) items.push(chip(t('pfPol_' + f.policy), () => this.apply(f.quick === f.policy ? this.exitQuickPatch() : { policy: '' }, { now: true })));
    if (f.proc) items.push(chip(t('pfProc_' + f.proc), () => this.apply(f.quick === 'attention' ? this.exitQuickPatch() : { proc: '' }, { now: true }), 'warn'));
    if (!items.length) { bar.replaceChildren(h('div', { class: 'condbar muted small' }, t('pfNoConds'))); return; }
    const MAX = 6;
    const shown = this.condOpen ? items : items.slice(0, MAX);
    bar.replaceChildren(h('div', { class: 'condbar' }, h('span', { class: 'muted small' }, t('pfActive')), shown,
      items.length > MAX ? h('button', { class: 'ghost small', onclick: () => { this.condOpen = !this.condOpen; this.paintCond(); } }, this.condOpen ? t('pfLess') : t('pfMore', items.length - MAX)) : null,
      h('button', { class: 'ghost small', onclick: () => this.clearConds() }, t('pfClear'))));
  },

  paintResHead() {
    const head = this.root?.querySelector('#resHead');
    if (!head) return;
    const r = this.res, f = this.f;
    const unit = f.view === 'managed' ? 'pfWorksN' : 'pfPostsN';
    if (this.failed) { head.replaceChildren(h('div', { class: 'list-head' }, h('span', { class: 'warn-text' }, t('pfCantCount')))); return; }
    if (!r) { head.replaceChildren(h('div', { class: 'list-head muted' }, t('loading'))); return; }
    const allLoadedSel = this.rows.length && this.rows.every(x => this.sel.has(x.blog + '/' + x.id));
    const cov = r.coverage || {};
    head.replaceChildren(h('div', { class: 'list-head' },
      h('b', {}, this.activeCount() ? t('pfFound', t(unit, r.total)) : t('pfAllInScope', t(unit, r.total))),
      h('span', { class: 'muted' }, t('pfLoaded', this.rows.length)),
      this.loading ? h('span', { class: 'muted small' }, '⟳ ' + t('pfUpdating')) : null,
      !cov.complete ? h('span', { class: 'muted small', title: t('pfPartialHint') }, t('pfPartial')) : null,
      h('span', { class: 'sep' }),
      this.rows.length ? h('button', { class: 'ghost', disabled: this.loading, onclick: () => this.selectLoaded() }, t('pfSelectLoaded', this.rows.length)) : null,
      allLoadedSel && r.total > this.rows.length && !this.frozen ? h('button', { disabled: this.loading, onclick: () => this.selectEvery() }, t('pfSelectEvery', r.total)) : null));
    const cv = this.root.querySelector('#coverage');
    cv.replaceChildren(cov.lastSync ? t('pfSyncedAt', ago(cov.lastSync)) : t('pfNeverSynced'), cov.errors ? h('span', { class: 'warn-text' }, ' · ' + t('pfSyncErrors', cov.errors)) : null);
  },

  // ----- filter pane -----
  paintPane() {
    const pane = this.root?.querySelector('#filterPane');
    if (!pane) return;
    if (!this.ui.pane) { pane.replaceChildren(); return; }
    const keepScroll = pane.scrollTop;
    const act = document.activeElement;
    const refocus = act === this.tagInput ? [this.tagInput, act.selectionStart] : act?.classList?.contains('pf-find') ? ['.pf-find[data-g="' + act.dataset.g + '"]', act.selectionStart] : null;
    const f = this.f, fc = this.res?.facets || { cat: {}, unset: {} };
    const sections = catSections(this.groups || [], this.cats || []);
    const count = n => (n == null ? null : h('span', { class: 'cnt' + (n ? '' : ' zero'), title: t('pfAfterHint') }, n));
    const groupBox = ([g, list]) => {
      const gid = g ? String(g.id) : 'none';
      const c = f.cats[gid] || { mode: 'any', inc: [], exc: [], unset: false };
      const setC = patch => { const v = { ...c, ...patch }; const next = { ...f.cats }; if (!v.inc.length && !v.exc.length && !v.unset) delete next[gid]; else next[gid] = v; this.apply({ cats: next }); };
      const used = c.inc.length + c.exc.length + (c.unset ? 1 : 0);
      const open = this.ui.open[gid] ?? (used > 0 || list.length <= 8);
      const toggleInc = cat => {
        const on = c.inc.includes(cat.id);
        if (!on) this.dropTagDup(cat.tag);
        setC({ unset: false, inc: on ? c.inc.filter(x => x !== cat.id) : [...c.inc, cat.id], exc: c.exc.filter(x => x !== cat.id) });
        if (!on && c.exc.includes(cat.id)) toast(t('pfSwitchedToInc', cat.name));
      };
      const toggleExc = cat => {
        const on = c.exc.includes(cat.id);
        if (!on) this.dropTagDup(cat.tag);
        setC({ exc: on ? c.exc.filter(x => x !== cat.id) : [...c.exc, cat.id], inc: c.inc.filter(x => x !== cat.id) });
        if (!on && c.inc.includes(cat.id)) toast(t('pfSwitchedToExc', cat.name));
      };
      const filt = (this.groupFind || {})[gid] || '';
      const shown = filt ? list.filter(x => tkey(x.name).includes(tkey(filt)) || tkey(x.tag).includes(tkey(filt))) : list;
      return h('div', { class: 'pf-group' + (open ? ' open' : '') },
        h('div', { class: 'pf-ghead' },
          h('button', { class: 'ghost pf-gtitle', 'aria-expanded': String(open), onclick: () => { this.ui.open[gid] = !open; this.persist(); this.paintPane(); } }, open ? '▾ ' : '▸ ', groupName(g), used ? h('span', { class: 'count' }, used) : null),
          list.length ? h('div', { class: 'seg tiny' + (c.inc.length >= 2 ? ' stress' : ''), title: t('pfModeHint') },
            h('button', { class: c.mode !== 'all' ? 'on' : '', onclick: () => setC({ mode: 'any' }) }, t('pfAny')),
            h('button', { class: c.mode === 'all' ? 'on' : '', onclick: () => setC({ mode: 'all' }) }, t('pfAll'))) : null),
        open ? h('div', { class: 'pf-opts' },
          list.length > 10 ? h('input', { type: 'search', class: 'pf-find', placeholder: t('pfFindIn'), value: filt, oninput: e => { (this.groupFind ||= {})[gid] = e.target.value; this.paintPane(); }, 'data-g': gid }) : null,
          shown.map(cat => {
            const inc = c.inc.includes(cat.id), exc = c.exc.includes(cat.id);
            return h('div', { class: 'pf-opt' + (exc ? ' exc' : '') },
              h('label', { class: 'check-label grow', title: '#' + cat.tag }, h('input', { type: 'checkbox', checked: inc, disabled: c.unset, onchange: () => toggleInc(cat) }), h('span', { class: 'nm' }, cat.name), exc ? h('span', { class: 'badge warn' }, t('pfExcluded')) : null),
              inc || exc ? null : count(fc.cat?.[cat.id]),
              h('button', { class: 'ghost icon small' + (exc ? ' on' : ''), title: exc ? t('pfUnexclude') : t('pfExclude'), 'aria-label': (exc ? t('pfUnexclude') : t('pfExclude')) + ' ' + cat.name, onclick: () => toggleExc(cat) }, '⊘'));
          }),
          list.length ? h('div', { class: 'pf-opt' }, h('label', { class: 'check-label grow' }, h('input', { type: 'checkbox', checked: c.unset, onchange: e => setC({ unset: e.target.checked, inc: [] }) }), h('span', { class: 'nm muted' }, t('pfUnset'))), c.unset ? null : count(fc.unset?.[gid])) : h('p', { class: 'muted small' }, t('pfGroupEmpty'))) : null);
    };
    pane.replaceChildren(
      h('div', { class: 'pf-top' }, h('b', {}, t('pfFilter')), h('span', { class: 'sep' }), this.activeCount() ? h('button', { class: 'ghost small', onclick: () => this.clearConds() }, t('pfClear')) : null,
        h('button', { class: 'ghost icon', title: t('pfCollapse'), 'aria-label': t('pfCollapse'), onclick: () => this.togglePane(false) }, '⟨')),
      h('div', { class: 'pf-sec' }, h('div', { class: 'pf-h' }, t('pfCats')), sections.length ? sections.map(groupBox) : h('p', { class: 'muted small' }, t('pfNoCats'))),
      this.tagSection(),
      h('div', { class: 'pf-sec' }, h('div', { class: 'pf-h' }, t('pfMoreConds')),
        h('label', { class: 'pf-field' }, h('span', {}, t(f.view === 'managed' ? 'pfOrigState' : 'pfState')),
          select([{ value: '', label: t('allStates') }, ...['published', 'private', 'draft', 'queue'].map(s => ({ value: s, label: t('state_' + s) }))], f.state, v => this.apply({ state: v }), { disabled: !!f.expiring })),
        f.expiring ? h('p', { class: 'muted small' }, t('pfExpiringStateNote')) : null,
        f.view === 'displayed' ? h('label', { class: 'pf-field' }, h('span', {}, t('pfKind')), select([{ value: '', label: t('allKinds') }, { value: 'original', label: t('kind_original') }, { value: 'reblog', label: t('kind_reblog') }], f.kind, v => this.apply({ kind: v }))) : null,
        h('label', { class: 'pf-field' }, h('span', {}, t(f.view === 'managed' ? 'pfOrigDate' : 'pfDate')),
          select([{ value: '', label: t('pfAnyTime') }, ...['7', '30', '90'].map(d => ({ value: d, label: t('pfLastDays', d) })), { value: 'custom', label: t('pfCustom') }], f.date, v => this.apply({ date: v }))),
        f.date === 'custom' ? h('div', { class: 'form-row' }, h('input', { type: 'date', value: f.from, 'aria-label': t('pfFrom'), onchange: e => this.apply({ from: e.target.value }) }), '–', h('input', { type: 'date', value: f.to, 'aria-label': t('pfTo'), onchange: e => this.apply({ to: e.target.value }) })) : null,
        f.expiring ? h('label', { class: 'pf-field' }, h('span', {}, t('pfWindow')), select(['3', '7', '14', '30'].map(d => ({ value: d, label: t('pfWithinDays', d) })), String(f.expiring.days), v => this.apply({ expiring: { days: Number(v) } }))) : null,
        h('label', { class: 'pf-field' }, h('span', {}, t('pfPolicy')), select([{ value: '', label: t('pfAnyPolicy') }, ...['keep_visible', 'keep_hidden', 'follow_rule', 'auto_hidden', 'hidden_other'].map(x => ({ value: x, label: t('pfPol_' + x) }))], f.policy, v => this.apply({ policy: v, quick: ['auto_hidden', 'keep_visible'].includes(f.quick) ? '' : f.quick }))),
        h('label', { class: 'pf-field' }, h('span', {}, t('pfProc')), select([{ value: '', label: t('pfAnyProc') }, ...['attention', 'review', 'conflict', 'jobs', 'failed', 'unknown'].map(x => ({ value: x, label: t('pfProc_' + x) }))], f.proc, v => this.apply({ proc: v, quick: f.quick === 'attention' ? '' : f.quick }))),
        f.view === 'managed' ? h('div', { class: 'pf-opt' }, h('label', { class: 'check-label grow', title: t('pfMissingHint') }, h('input', { type: 'checkbox', checked: f.missing, onchange: e => this.apply({ missing: e.target.checked }) }), h('span', { class: 'nm' }, t('pfMissing'))), f.missing ? null : count(fc.missing)) : null));
    pane.scrollTop = keepScroll;
    if (refocus) { const el = typeof refocus[0] === 'string' ? pane.querySelector(refocus[0]) : refocus[0]; if (el) { el.focus(); try { el.setSelectionRange(refocus[1], refocus[1]); } catch {} } }
  },
  // A manual tag that is also a category's tag: one condition, not two
  dropTagDup(tag) {
    const kk = tkey(tag), tg = this.f.tags;
    if (tg.inc.some(x => tkey(x) === kk) || tg.exc.some(x => tkey(x) === kk)) this.f.tags = { ...tg, inc: tg.inc.filter(x => tkey(x) !== kk), exc: tg.exc.filter(x => tkey(x) !== kk) };
  },
  catByTag(tag) { const kk = tkey(tag); return (this.cats || []).find(c => tkey(c.tag) === kk); },

  // Tags: include (all/any), exclude, "no tags"; suggestions from every synced post in scope
  tagSection() {
    const f = this.f, tg = f.tags;
    if (!this.tagInput) {
      this.tagInput = h('input', { type: 'search', class: 'pf-tag-input', placeholder: t('pfTagFind'), 'aria-label': t('pfTagFind'), autocomplete: 'off',
        oncompositionstart: () => { this.composing = true; }, oncompositionend: () => { this.composing = false; this.suggest(); },
        oninput: () => { this.tagDraft = this.tagInput.value; if (!this.composing) this.suggest(); },
        onkeydown: e => {
          if (e.isComposing || this.composing) return;
          const list = this.sugg?.list || [];
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.suggIdx = Math.max(-1, Math.min(list.length - 1, (this.suggIdx ?? -1) + (e.key === 'ArrowDown' ? 1 : -1))); this.paintSugg(); }
          else if (e.key === 'Enter') { e.preventDefault(); const x = list[this.suggIdx]; if (x) this.addTag(x.tag, 'inc'); else this.addTyped('inc'); }
          else if (e.key === 'Escape' && this.tagInput.value) { e.stopPropagation(); this.tagInput.value = ''; this.tagDraft = ''; this.suggest(); }
        } });
      this.tagInput.value = this.tagDraft;
      this.suggBox = h('div', { class: 'pf-sugg', role: 'listbox' });
    }
    const rm = (which, x) => this.apply({ tags: { ...tg, [which]: tg[which].filter(y => y !== x) } });
    const flip = (which, x) => { const other = which === 'inc' ? 'exc' : 'inc'; this.apply({ tags: { ...tg, [which]: tg[which].filter(y => y !== x), [other]: [...tg[other], x] } }); };
    const tagChip = (which, x) => h('span', { class: 'cond' + (which === 'exc' ? ' neg' : '') }, h('span', {}, '#' + x),
      h('button', { class: 'ghost icon', title: which === 'inc' ? t('pfMoveToExc') : t('pfMoveToInc'), 'aria-label': which === 'inc' ? t('pfMoveToExc') : t('pfMoveToInc'), onclick: () => flip(which, x) }, '⇄'),
      h('button', { class: 'ghost icon', title: t('pfRemove'), 'aria-label': t('pfRemove'), onclick: () => rm(which, x) }, '✕'));
    if (this.suggKey !== JSON.stringify(this.query())) { this.suggKey = JSON.stringify(this.query()); queueMicrotask(() => this.suggest()); } else queueMicrotask(() => this.paintSugg());
    return h('div', { class: 'pf-sec' }, h('div', { class: 'pf-h' }, t('pfTags')),
      h('div', { class: 'form-row' }, this.tagInput, h('button', { onclick: () => this.addTyped('inc'), title: t('pfAddInc') }, t('pfAdd'))),
      h('p', { class: 'muted small' }, t('pfTagSep')),
      this.tagDraft && !this.sugg?.exact ? h('p', { class: 'small' }, t('pfDraftPending', this.tagDraft)) : null,
      this.suggBox,
      h('div', { class: 'pf-ghead' }, h('span', { class: 'small' }, t('pfInclude')),
        h('div', { class: 'seg tiny' + (tg.inc.length >= 2 ? ' stress' : '') },
          h('button', { class: tg.mode !== 'any' ? 'on' : '', onclick: () => this.apply({ tags: { ...tg, mode: 'all' } }) }, t('pfAll')),
          h('button', { class: tg.mode === 'any' ? 'on' : '', onclick: () => this.apply({ tags: { ...tg, mode: 'any' } }) }, t('pfAny')))),
      h('div', { class: 'chips' }, tg.inc.length ? tg.inc.map(x => tagChip('inc', x)) : h('span', { class: 'muted small' }, t('pfNone'))),
      h('div', { class: 'small' }, t('pfExcludeList')),
      h('div', { class: 'chips' }, tg.exc.length ? tg.exc.map(x => tagChip('exc', x)) : h('span', { class: 'muted small' }, t('pfNone'))),
      h('div', { class: 'pf-opt' }, h('label', { class: 'check-label grow' }, h('input', { type: 'checkbox', checked: tg.none, onchange: e => this.setNoTags(e.target.checked) }), h('span', { class: 'nm' }, t('pfNoTags'))),
        tg.none ? null : h('span', { class: 'cnt', title: t('pfAfterHint') }, this.res?.facets?.none ?? '—')));
  },
  setNoTags(on) {
    const tg = this.f.tags;
    if (on && (tg.inc.length || Object.values(this.f.cats).some(c => c.inc.length))) toast(t('pfNoTagsConflict'));
    const cats = on ? Object.fromEntries(Object.entries(this.f.cats).map(([g, c]) => [g, { ...c, inc: [] }]).filter(([, c]) => c.exc.length || c.unset)) : this.f.cats;
    this.apply({ tags: { ...tg, none: on, inc: on ? [] : tg.inc }, cats });
  },
  async suggest() {
    const seq = (this.suggSeq = (this.suggSeq || 0) + 1);
    const text = this.tagInput?.value || '';
    let r;
    try { r = await window.studio.call('tagCandidates', { ...this.query(), text, limit: 12 }); } catch { return; }
    if (seq !== this.suggSeq) return;
    this.sugg = r; this.suggIdx = -1;
    this.paintSugg();
  },
  paintSugg() {
    const box = this.suggBox;
    if (!box) return;
    const r = this.sugg || { list: [] };
    const text = (this.tagInput?.value || '').trim();
    const inUse = new Set([...this.f.tags.inc, ...this.f.tags.exc].map(tkey));
    box.replaceChildren(
      r.list.map((x, i) => h('div', { class: 'pf-cand' + (i === this.suggIdx ? ' on' : ''), role: 'option', 'aria-selected': String(i === this.suggIdx) },
        h('button', { class: 'ghost grow pf-cand-main', onclick: () => this.addTag(x.tag, 'inc') }, x.cat ? [h('b', {}, x.cat.name), h('span', { class: 'muted' }, ' · #' + x.tag)] : '#' + x.tag,
          h('span', { class: 'muted small' }, ' ' + t('pfUsed', x.n))),
        inUse.has(tkey(x.tag)) ? h('span', { class: 'muted small' }, t('pfInUse')) : h('span', { class: 'cnt', title: t('pfAfterHint') }, x.after ?? '—'),
        h('button', { class: 'ghost icon small', title: t('pfExclude'), 'aria-label': t('pfExclude') + ' #' + x.tag, onclick: () => this.addTag(x.tag, 'exc') }, '⊘'))),
      text && !r.exact && !this.composing ? h('div', { class: 'pf-cand' }, h('button', { class: 'ghost grow', onclick: () => this.addTyped('inc') }, t('pfUseExact', text.replace(/^#/, ''))), h('span', { class: 'muted small' }, t('pfNoKnown'))) : null);
  },
  // Pasted or typed text: split on commas (English or Chinese) and new lines; spaces inside a tag stay
  addTyped(as) {
    const parts = (this.tagInput?.value || '').split(/[,，\n]/).map(x => x.trim().replace(/^#+/, '')).filter(Boolean);
    if (!parts.length) return;
    for (const p of parts) this.addTag(p, as, { quiet: parts.length > 1 });
  },
  addTag(tag, as, { quiet = false } = {}) {
    const f = this.f, kk = tkey(tag);
    const cat = this.catByTag(tag);
    // a category's tag becomes that category's condition (one identity, one place)
    if (cat) {
      const g = this.gid(cat);
      const c = f.cats[g] || { mode: 'any', inc: [], exc: [], unset: false };
      const next = as === 'inc' ? { ...c, unset: false, inc: [...new Set([...c.inc, cat.id])], exc: c.exc.filter(x => x !== cat.id) } : { ...c, exc: [...new Set([...c.exc, cat.id])], inc: c.inc.filter(x => x !== cat.id) };
      if (!quiet) toast(t('pfAsCategory', cat.name));
      this.dropTagDup(tag);
      this.clearDraft();
      return this.apply({ cats: { ...f.cats, [g]: next } });
    }
    const tg = f.tags;
    const other = as === 'inc' ? 'exc' : 'inc';
    if (tg[other].some(x => tkey(x) === kk)) toast(t(as === 'inc' ? 'pfSwitchedToInc' : 'pfSwitchedToExc', '#' + tag));
    if (as === 'inc' && tg.none) toast(t('pfNoTagsOff'));
    const list = tg[as].some(x => tkey(x) === kk) ? tg[as] : [...tg[as], tag];
    this.clearDraft();
    this.apply({ tags: { ...tg, none: as === 'inc' ? false : tg.none, [as]: list, [other]: tg[other].filter(x => tkey(x) !== kk) } });
  },
  clearDraft() { if (this.tagInput) this.tagInput.value = ''; this.tagDraft = ''; },

  // ----- results -----
  rerenderList() {
    const list = this.root.querySelector('#postList');
    if (!this.rows.length) return;
    list.firstChild?.replaceWith(this.results(this.rows));
    this.paintSel();
  },
  results(rows) {
    return this.ui.layout === 'list' ? this.list(rows) : this.grid(rows, { selectable: true, onOpen: r => this.openDetail(r), fit: this.ui.layout === 'fit' });
  },
  badges(r) {
    const ex = r.expiry, out = [];
    if (r.origin_missing) out.push(h('span', { class: 'badge warn', title: t('pfMissingHint') }, t('pfMissingBadge')));
    else {
      out.push(h('span', { class: 'badge st-' + r.state }, (r.kind === 'reblog' ? t('pfReblogState') : t('pfOrigState2')) + ' ' + t('state_' + r.state)));
      if (r.display === 'keep_visible') out.push(h('span', { class: 'badge keep' }, t('pol_keep_visible')));
      if (r.display === 'keep_hidden') out.push(h('span', { class: 'badge' }, t('pol_keep_hidden')));
      if (r.auto_hidden && r.state === 'private') out.push(h('span', { class: 'badge' }, t('autoHidden')));
    }
    if (r.conflicted) out.push(h('span', { class: 'badge warn' }, t('conflict')));
    if (r.item_status && r.item_status !== 'ok') out.push(h('span', { class: 'badge warn' }, t('st_' + r.item_status)));
    if (r.job === 'failed' || r.job === 'unknown') out.push(h('span', { class: 'badge warn' }, t('pfProc_' + r.job)));
    if (r.pinned) out.push(h('span', { class: 'badge' }, t('pinned')));
    if (r.legacy) out.push(h('span', { class: 'badge' }, t('legacy')));
    if (r.deliv_unknown) out.push(h('span', { class: 'badge warn', title: t('delivUnknownHint') }, t('delivUnknown', r.deliv_unknown)));
    if (ex && ex.action === 'hide') out.push(h('span', { class: 'badge accent' }, t('pfOverdue')));
    else if (ex && ex.action === 'none' && ex.reason === 'not_due' && ex.due) { const d = inDays(ex.due); if (d <= 14) out.push(h('span', { class: 'badge accent' }, t('dueIn', d))); }
    return out;
  },
  // categories the card carries, the ones the query asked for first; other tags fold into "+N"
  catChips(r, max = 3) {
    if (!r.cats?.length && !r.tags?.length) return null;
    const asked = new Set(Object.values(this.f.cats).flatMap(c => c.inc || []));
    const cats = (r.cats || []).slice().sort((a, b) => asked.has(b.id) - asked.has(a.id));
    const wanted = new Set(this.f.tags.inc.map(tkey));
    const hitTags = (r.tags || []).filter(x => wanted.has(tkey(x)) && !cats.some(c => tkey(c.tag) === tkey(x)));
    const rest = (r.tags || []).length - cats.length - hitTags.length;
    return h('div', { class: 'card-cats' },
      cats.slice(0, max).map(c => h('button', { class: 'mini-chip' + (asked.has(c.id) ? ' hit' : ''), title: t('pfFilterBy', c.name) + ' (#' + c.tag + ')', onclick: e => { e.stopPropagation(); this.addTag(c.tag, 'inc'); } }, c.name)),
      hitTags.map(x => h('span', { class: 'mini-chip hit' }, '#' + x)),
      cats.length > max || rest > 0 ? h('span', { class: 'muted small', title: (r.tags || []).map(x => '#' + x).join(' ') }, '+' + (Math.max(0, cats.length - max) + Math.max(0, rest))) : null);
  },
  dateLine(r) {
    if (r.origin_missing) return t('pfDateUnknown');
    const label = this.f.view === 'managed' ? t('pfOrigPublished') : r.kind === 'reblog' ? t('pfRebloggedAt') : t('pfPublished');
    return r.published_at ? label + ' ' + fmtDate(r.published_at) : t(r.state === 'draft' ? 'pfDraftNoDate' : r.state === 'queue' ? 'pfQueueNoDate' : 'pfDateUnknown');
  },

  // Shared card grid (also used on Home)
  grid(rows, { selectable = false, onOpen, fit = false } = {}) {
    return h('div', { class: 'cards' + (fit ? ' fit' : '') }, rows.map(r => {
      const k = r.blog + '/' + r.id;
      const on = this.sel.has(k);
      const name = (r.summary || '').slice(0, 60) || r.blog_name || r.id;
      const open = e => { if (selectable && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return this.toggleKey(k); } onOpen?.(r); };
      return h('div', { class: 'pcard' + (on ? ' sel' : ''), 'data-k': k, tabindex: 0, role: 'button', 'aria-label': t('pfOpenCard', name),
        onclick: e => { if (e.target.closest('.check, .mini-chip')) return; open(e); },
        onkeydown: e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter') open(e); else if (e.key === ' ' && selectable) { e.preventDefault(); this.toggleKey(k); } } },
        selectable ? h('label', { class: 'check', title: t('pfSelect'), onclick: e => e.stopPropagation() }, h('input', { type: 'checkbox', checked: on, 'aria-label': t('pfSelectItem', name),
          onclick: e => { if (e.shiftKey && this.anchor) { e.preventDefault(); this.selectRange(this.anchor, k); } }, onchange: e => this.setKey(k, e.target.checked) })) : null,
        r.thumb ? h('div', { class: 'thumb' }, h('img', { src: r.thumb, loading: 'lazy', alt: '' }), r.images > 1 ? h('span', { class: 'img-count', title: t('pfImages', r.images) }, '▣ ' + r.images) : null)
          : h('div', { class: 'thumb text' }, (r.summary || '').slice(0, 160)),
        h('div', { class: 'meta' },
          h('div', { class: 'blog' }, r.blog_name || blogName(r.blog)),
          h('div', { class: 'muted small' }, this.dateLine(r)),
          r.thumb && r.summary ? h('div', { class: 'sum' }, r.summary.slice(0, 80)) : null,
          selectable ? this.catChips(r) : null,
          h('div', { class: 'badges' }, this.badges(r)),
          h('div', { class: 'row2 muted small' },
            r.manager && r.manager !== r.blog ? h('span', {}, t('managedBy', r.manager_name || blogName(r.manager))) : null,
            this.f.view === 'managed' && r.origin_blog && r.origin_blog !== (r.manager || r.blog) && !r.external ? h('span', {}, t('pfOriginOn', r.origin_name || blogName(r.origin_blog))) : null,
            r.copies > 1 ? h('span', {}, t('copies', r.copies)) : null,
            r.versions > 1 ? h('span', { title: t('versionsCardHint') }, t('versionsCard', r.versions)) : null,
            r.snapshot_rev ? h('span', { title: t('snapshotHint') }, t('versionN', r.snapshot_rev)) : null,
            r.deliv_pending ? h('span', { title: t('delivPendingHint') }, t('delivPending', r.deliv_pending)) : null,
            r.external ? h('span', {}, t('pfExternal')) : null,
            r.notes != null ? h('span', { title: r.notes_at ? t('pfNotesAt', fmtTime(r.notes_at)) : '' }, '♥ ' + r.notes) : null)));
    }));
  },
  list(rows) {
    return h('div', { class: 'plist', role: 'list' }, rows.map(r => {
      const k = r.blog + '/' + r.id, on = this.sel.has(k);
      const name = (r.summary || '').slice(0, 60) || r.id;
      const open = e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); return this.toggleKey(k); } this.openDetail(r); };
      return h('div', { class: 'prow pcard' + (on ? ' sel' : ''), 'data-k': k, tabindex: 0, role: 'button', 'aria-label': t('pfOpenCard', name),
        onclick: e => { if (e.target.closest('.check, .mini-chip')) return; open(e); },
        onkeydown: e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter') open(e); else if (e.key === ' ') { e.preventDefault(); this.toggleKey(k); } } },
        h('label', { class: 'check', onclick: e => e.stopPropagation() }, h('input', { type: 'checkbox', checked: on, 'aria-label': t('pfSelectItem', name), onclick: e => { if (e.shiftKey && this.anchor) { e.preventDefault(); this.selectRange(this.anchor, k); } }, onchange: e => this.setKey(k, e.target.checked) })),
        r.thumb ? h('img', { class: 'prow-thumb', src: r.thumb, loading: 'lazy', alt: '' }) : h('div', { class: 'prow-thumb text' }, '¶'),
        h('div', { class: 'prow-main' }, h('div', { class: 'sum' }, r.summary ? r.summary.slice(0, 120) : h('span', { class: 'muted' }, t('pfNoText'))), this.catChips(r, 5)),
        h('div', { class: 'prow-col' }, h('b', {}, r.blog_name || blogName(r.blog)), h('div', { class: 'muted small' }, this.dateLine(r))),
        h('div', { class: 'prow-col badges' }, this.badges(r)),
        h('div', { class: 'prow-col muted small' }, r.versions > 1 ? t('versionsCard', r.versions) : '', r.copies > 1 ? ' · ' + t('copies', r.copies) : '', r.notes != null ? ' · ♥ ' + r.notes : ''));
    }));
  },

  // ----- selection: one key per card (a work's original, or the exact post), in page order -----
  rowOf(k) { return this.rows.find(r => r.blog + '/' + r.id === k); },
  entry: r => ({ blog: r.blog, id: r.id, item_id: r.item_id, kind: r.kind, origin_missing: !!r.origin_missing }),
  setKey(k, on) {
    const r = this.rowOf(k);
    if (!r) return;
    if (on) this.sel.set(k, this.entry(r)); else this.sel.delete(k);
    if (!on) this.frozen = null;
    this.anchor = k;
    this.paintSel();
  },
  toggleKey(k) { this.setKey(k, !this.sel.has(k)); },
  selectRange(a, b) {
    const keys = this.rows.map(r => r.blog + '/' + r.id);
    let i = keys.indexOf(a), j = keys.indexOf(b);
    if (i < 0 || j < 0) return this.toggleKey(b);
    if (i > j) [i, j] = [j, i];
    for (const k of keys.slice(i, j + 1)) this.sel.set(k, this.entry(this.rowOf(k)));
    this.anchor = b;
    this.paintSel();
  },
  selectLoaded() {
    if (this.loading) return;
    for (const r of this.rows) this.sel.set(r.blog + '/' + r.id, this.entry(r));
    this.paintSel();
  },
  // Every local match, resolved by the same query and frozen now: later matches don't join
  async selectEvery() {
    if (this.loading) return;
    const seq = this.seq;
    const r = await call('postsMatch', this.query());
    if (seq !== this.seq) return;
    for (const x of r.ids) this.sel.set(x.blog + '/' + x.id, x);
    this.frozen = { total: r.total, at: Date.now() };
    this.paintSel();
  },
  paintSel() {
    for (const c of this.root?.querySelectorAll('.pcard[data-k]') || []) {
      const on = this.sel.has(c.dataset.k);
      c.classList.toggle('sel', on);
      const box = c.querySelector('.check input');
      if (box) box.checked = on;
    }
    this.root?.querySelector('.cards, .plist')?.classList.toggle('selecting', this.sel.size > 0);
    this.selbar();
    this.paintResHead();
  },
  clearSel() { this.sel.clear(); this.extra.clear(); this.frozen = null; this.paintSel(); },
  // What an action may touch: works with an unreadable original are never turned into a reblog's edit
  targets() {
    const all = [...this.sel.values(), ...this.extra.values()];
    const ok = all.filter(x => !x.origin_missing);
    const seen = new Set();
    return { list: ok.filter(x => { const k = x.blog + '/' + x.id; if (seen.has(k)) return false; seen.add(k); return true; }).map(({ blog, id }) => ({ blog, id })), missing: all.length - ok.length };
  },

  selbar() {
    const bar = this.root?.querySelector('#selbar');
    if (!bar) return;
    const n = this.sel.size;
    if (!n && !this.extra.size) { bar.replaceChildren(); return; }
    const managed = this.f.view === 'managed';
    const missing = [...this.sel.values()].filter(x => x.origin_missing).length;
    bar.replaceChildren(h('div', { class: 'selbar active', role: 'toolbar', 'aria-label': t('pfSelActions') },
      h('b', {}, t(managed ? 'pfSelWorks' : 'pfSelPosts', n)),
      this.frozen ? h('span', { class: 'muted small', title: t('pfFrozenHint') }, t('pfFrozen', fmtTime(this.frozen.at))) : null,
      missing ? h('span', { class: 'warn-text small', title: t('pfMissingHint') }, t('pfSelMissing', missing)) : null,
      this.extra.size ? h('button', { class: 'ghost small', onclick: () => this.showExtra() }, t('pfExtra', this.extra.size)) : null,
      h('span', { class: 'sep' }),
      h('button', { class: 'primary', onclick: () => this.bulkTags() }, t('bulkTags')),
      menuButton(t('pfVisibility'), [
        { label: t('makePublic'), onclick: () => this.bulk('published') },
        { label: t('makePrivate'), onclick: () => this.bulk('private') },
        { label: t('keepVisible'), onclick: () => this.policy('keep') },
        { label: t('followRule'), onclick: () => this.policy('rule') }]),
      menuButton(t('pfMoreActions'), [{ label: t('pfIncludeLinked'), onclick: () => this.includeLinked() }]),
      h('button', { class: 'ghost', onclick: () => this.clearSel() }, t('clearSel'))));
  },

  // keyboard: Ctrl+A selects what is loaded, Esc closes the detail pane or clears (never while typing or in a dialog)
  bindKeys() {
    if (this.keysBound) return;
    this.keysBound = true;
    window.addEventListener('keydown', e => {
      if (App.page !== PostsPage || document.querySelector('.modal-back, .menu-pop')) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (e.target.closest?.('.detail-pane') && e.key !== 'Escape') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectLoaded(); }
      else if (e.key === 'Escape') { if (document.querySelector('.detail-pane')) this.closeDetail(); else if (this.sel.size) this.clearSel(); }
    });
  },

  submitted(r, what) {
    toast(h('span', {}, what, ' ', h('button', { class: 'ghost small', onclick: () => App.go('activity') }, t('pfSeeProgress'))), 'ok', 7000);
    void r;
  },
  skipNote(missing) { return missing ? h('p', { class: 'warn-text' }, t('pfSkipMissing', missing)) : null; },

  // Tags on the selection: counts per tag, click to take a tag off, + to put it on the ones that lack it. Originals
  // only; a reblog selected here is not turned into its original's edit. One preview of every change, then apply.
  async bulkTags() {
    const { list: targets, missing } = this.targets();
    const [info] = await Promise.all([call('selectionTags', { targets }), this.cats ? null : this.loadCats()]);
    if (!info.originals) return toast(t('pfTagsOnlyReblogs'));
    const cats = this.cats, groups = this.groups;
    const countOf = tag => info.tags.find(x => tkey(x.tag) === tkey(tag))?.n || 0;
    const remove = new Set(), add = [];
    const box = h('div', {});
    const draw = () => box.replaceChildren(
      h('p', { class: 'muted small' }, t('bulkTagsHint', info.originals, info.snapshots)),
      info.snapshots ? h('p', { class: 'small' }, t('pfReblogsNotEdited', info.snapshots)) : null,
      this.skipNote(missing),
      cats.length ? h('div', { class: 'cat-pick' }, h('div', { class: 'muted small' }, t('bulkTagsCats')),
        catSections(groups, cats).map(([g, list]) => list.length ? h('div', { class: 'form-row wrap' }, h('span', { class: 'muted small' }, groupName(g)),
          list.map(c => { const have = countOf(c.tag), all = have >= info.originals, on = add.includes(c.tag);
            return h('button', { class: 'chip' + (on || all ? ' on' : ''), disabled: all, title: '#' + c.tag + ' · ' + have + '/' + info.originals,
              onclick: () => { on ? add.splice(add.indexOf(c.tag), 1) : add.push(c.tag); remove.delete(c.tag); draw(); } }, c.name, all ? ' ✓' : have ? ` ${have}/${info.originals}` : ''); })) : null)) : null,
      h('div', { class: 'chips' }, info.tags.map(x => h('span', { class: 'chip-pair' },
        h('button', { class: 'chip' + (remove.has(x.tag) ? ' struck' : ''), title: t('bulkTagsRemove'), onclick: () => { remove.has(x.tag) ? remove.delete(x.tag) : remove.add(x.tag); add.splice(0, add.length, ...add.filter(a => a !== x.tag)); draw(); } }, '#' + x.tag, ' ', h('span', { class: 'muted small' }, `${x.n}/${info.originals}`)),
        x.n < info.originals && !remove.has(x.tag) ? h('button', { class: 'chip' + (add.includes(x.tag) ? ' on' : ''), title: t('bulkTagsFill'), onclick: () => { add.includes(x.tag) ? add.splice(add.indexOf(x.tag), 1) : add.push(x.tag); draw(); } }, '⊕') : null))),
      add.filter(a => !info.tags.some(x => x.tag === a)).length ? h('div', { class: 'chips' }, add.filter(a => !info.tags.some(x => x.tag === a)).map(a => h('button', { class: 'chip on', onclick: () => { add.splice(add.indexOf(a), 1); draw(); } }, '+#' + a, ' ✕'))) : null,
      h('input', { placeholder: t('extraHint'), onkeydown: e => { if (e.key === 'Enter' && !e.isComposing) { const v = e.target.value.split(/[,，\n]/).map(x => x.trim().replace(/^#/, '')).filter(Boolean); add.push(...v.filter(x => !add.includes(x))); e.target.value = ''; draw(); } } }),
      h('p', { class: 'small' }, remove.size || add.length ? t('bulkTagsWill', remove.size, add.length) : t('bulkTagsNothing')));
    draw();
    const ok = await modal(t('bulkTags'), box, [{ label: t('cancel'), value: false }, { label: t('pfPreview'), value: true, class: 'primary' }], { wide: true });
    if (!ok || (!remove.size && !add.length)) return;
    // the one confirmation: every original that changes, with its own difference
    const plan = await call('tagsPlan', { targets, add, remove: [...remove] });
    const body = h('div', {},
      h('p', { class: 'big' }, t('pfTagsChange', plan.change.length)),
      plan.same ? h('p', { class: 'muted' }, t('pfTagsSame', plan.same)) : null,
      plan.snapshots ? h('p', {}, t('pfReblogsNotEdited', plan.snapshots)) : null,
      plan.gone ? h('p', { class: 'warn-text' }, t('pfGone', plan.gone)) : null,
      this.skipNote(missing),
      h('p', { class: 'muted small' }, plan.copiesFollow ? t('pfCopiesFollowOn') : t('pfCopiesFollowOff')),
      h('ul', { class: 'mini-list diff-list' }, plan.change.map(p => h('li', {}, h('b', {}, blogName(p.blog)), ' · ', (p.summary || p.id).slice(0, 60), ' ',
        p.add.map(a => h('span', { class: 'diff add' }, '+#' + a)), p.remove.map(a => h('span', { class: 'diff rm' }, '−#' + a)),
        p.reblogs ? h('span', { class: 'muted small' }, ' · ' + t('pfOwnReblogs', p.reblogs)) : null))));
    const go = await modal(t('pfConfirmTags'), body, [{ label: t('cancel'), value: false }, { label: t('pfApplyN', plan.change.length), value: true, class: 'primary', disabled: !plan.change.length }], { wide: true });
    if (!go) return;
    const r = await call('applyTags', { targets: plan.change.map(p => ({ blog: p.blog, id: p.id })), add, remove: [...remove] });
    this.submitted(r, t('queuedN', r.queued) + (r.labelsOk === false ? ' · ' + t('heldForLabels') : ''));
  },

  // Linked posts are never added silently: list them, the user ticks what joins
  async includeLinked() {
    const items = [...new Set([...this.sel.values()].map(s => s.item_id).filter(Boolean))];
    if (!items.length) return;
    const linked = (await call('linked', { items })).filter(l => !this.sel.has(l.blog + '/' + l.id) && !this.extra.has(l.blog + '/' + l.id));
    if (!linked.length) return toast(t('pfNoLinked'));
    const pick = new Set();
    const body = h('div', {}, h('p', { class: 'muted small' }, t('pfLinkedHint', linked.length)),
      h('div', { class: 'form-row' }, h('button', { class: 'ghost small', onclick: () => { linked.forEach(l => pick.add(l.blog + '/' + l.id)); body.querySelectorAll('input[type=checkbox]').forEach(b => { b.checked = true; }); } }, t('pfTickAll'))),
      h('div', { class: 'linked-list' }, linked.map(l => h('label', { class: 'check-label linked-row' },
        h('input', { type: 'checkbox', onchange: e => { const k = l.blog + '/' + l.id; e.target.checked ? pick.add(k) : pick.delete(k); } }),
        h('b', {}, l.blog_name), h('span', { class: 'badge' }, t('kind_' + l.kind)), stateBadge(l.state), l.rev ? h('span', { class: 'badge' }, t('versionN', l.rev)) : null,
        h('span', { class: 'muted small' }, (l.summary || l.id).slice(0, 50))))));
    const ok = await modal(t('pfIncludeLinked'), body, [{ label: t('cancel'), value: false }, { label: t('pfAddPicked'), value: true, class: 'primary' }], { wide: true });
    if (!ok) return;
    for (const l of linked) if (pick.has(l.blog + '/' + l.id)) this.extra.set(l.blog + '/' + l.id, { blog: l.blog, id: l.id, item_id: l.item_id, kind: l.kind, label: `${l.blog_name} · ${t('kind_' + l.kind)} · ${(l.summary || l.id).slice(0, 40)}` });
    this.selbar();
  },
  async showExtra() {
    const body = h('div', {});
    const draw = () => body.replaceChildren(h('p', { class: 'muted small' }, t('pfExtraHint')),
      [...this.extra.entries()].map(([k, x]) => h('div', { class: 'form-row' }, h('span', { class: 'grow' }, x.label), h('button', { class: 'ghost small', onclick: () => { this.extra.delete(k); draw(); this.selbar(); } }, t('pfRemove')))));
    draw();
    await modal(t('pfExtra', this.extra.size), body);
  },

  async bulk(target) {
    const { list: targets, missing } = this.targets();
    const pv = await call('visibilityPreview', { targets, target });
    const title = target === 'published' ? t('makePublic') : t('makePrivate');
    const body = h('div', {},
      h('p', { class: 'big' }, t('bulkChange', pv.change.length)),
      pv.already.length ? h('p', {}, t('bulkAlready', pv.already.length)) : null,
      pv.unsupported.length ? h('p', { class: 'warn-text' }, t('bulkUnsupported', pv.unsupported.length)) : null,
      pv.gone ? h('p', { class: 'warn-text' }, t('pfGone', pv.gone)) : null,
      this.skipNote(missing),
      pv.copies.length ? h('p', {}, t('bulkCopies', pv.copies.length)) : null,
      h('p', { class: 'muted' }, target === 'published' ? t('bulkPolicyPublic') : t('bulkPolicyPrivate')),
      target === 'private' ? h('p', { class: 'muted' }, t('bulkDelay')) : null,
      pv.labelsOk ? null : h('p', { class: 'banner warn' }, t('labelsBlocked')),
      h('ul', { class: 'mini-list' }, pv.change.map(p => h('li', {}, h('b', {}, blogName(p.blog)), ' · ', (p.summary || p.id).slice(0, 70)))));
    const ok = await modal(t('bulkTitle', title), body, [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary', disabled: !pv.change.length && !pv.already.length }]);
    if (!ok) return;
    const r = await call('visibility', { targets, target });
    this.submitted(r, t('queued', r.queued));
    this.clearSel();
    this.load({ quiet: true });
  },

  // Keep visible may publish private posts; back to the rule may make posts due right away. Both previewed.
  async policy(action) {
    const { list: targets, missing } = this.targets();
    const pv = await call('policyPreview', { targets, action });
    const body = h('div', {},
      h('p', { class: 'big' }, t(action === 'keep' ? 'pfKeepN' : 'pfRuleN', pv.targets)),
      action === 'keep' && pv.willPublish.length ? h('p', { class: 'warn-text' }, t('pfKeepPublishes', pv.willPublish.length)) : null,
      action === 'keep' ? h('ul', { class: 'mini-list' }, pv.willPublish.map(p => h('li', {}, h('b', {}, blogName(p.blog)), ' · ', (p.summary || p.id).slice(0, 70)))) : null,
      action === 'rule' && pv.dueNow.length ? h('p', { class: 'warn-text' }, t('pfRuleDue', pv.dueNow.length)) : null,
      action === 'rule' && pv.noRule ? h('p', { class: 'muted' }, t('pfRuleNone', pv.noRule)) : null,
      pv.gone ? h('p', { class: 'warn-text' }, t('pfGone', pv.gone)) : null,
      this.skipNote(missing));
    const ok = await modal(action === 'keep' ? t('keepVisible') : t('followRule'), body, [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary', disabled: !pv.targets }]);
    if (!ok) return;
    if (action === 'keep') { const r = await call('keepVisible', { targets }); this.submitted(r, t('keepDone', targets.length) + (r.queued ? ' · ' + t('queued', r.queued) : '')); }
    else { await call('followRule', { targets }); toast('✓ ' + t('followRule'), 'ok'); }
    this.clearSel();
    this.load({ quiet: true });
  },

  // ----- detail pane: the exact instance the card stands for, prev/next along the results -----
  async openDetail(r) {
    if (!r?.item_id) return;
    const it = await call('item', { id: r.item_id });
    if (!it) return;
    this.detailFor = r;
    this.lastFocus = r.blog && r.id ? r.blog + '/' + r.id : null;
    let pane = document.querySelector('.detail-pane');
    if (!pane) { pane = h('aside', { class: 'detail-pane', role: 'dialog', 'aria-label': t('detailTitle'), tabindex: -1 }); document.body.append(pane); }
    const keepScroll = pane.scrollTop && pane.dataset.k === this.lastFocus ? pane.scrollTop : 0;
    pane.dataset.k = this.lastFocus || '';
    const idx = this.rows.findIndex(x => x.blog + '/' + x.id === this.lastFocus);
    const focus = it.members.find(m => m.blog === r.blog && m.id === r.id) || it.members.find(m => m.kind === 'original') || it.members[0];
    const url = focus ? `https://${blogName(focus.blog)}.tumblr.com/post/${focus.id}` : null;
    pane.replaceChildren(
      h('header', {}, h('h2', { class: 'grow' }, t('detailTitle')),
        App.page === PostsPage && idx >= 0 ? [h('button', { class: 'ghost', disabled: idx <= 0, title: t('pfPrev'), 'aria-label': t('pfPrev'), onclick: () => this.openDetail(this.rows[idx - 1]) }, '↑'),
          h('button', { class: 'ghost', disabled: idx >= this.rows.length - 1, title: t('pfNext'), 'aria-label': t('pfNext'), onclick: () => this.openDetail(this.rows[idx + 1]) }, '↓')] : null,
        url ? h('a', { class: 'button ghost', href: url, target: '_blank' }, t('openOnTumblr')) : null,
        h('button', { class: 'ghost icon', title: t('close'), 'aria-label': t('close'), onclick: () => this.closeDetail() }, '✕')),
      h('div', { class: 'detail-body' }, this.detailBody(it, focus, r)));
    pane.scrollTop = keepScroll;
    pane.focus({ preventScroll: true });
    document.querySelectorAll('.pcard.viewing').forEach(c => c.classList.remove('viewing'));
    document.querySelector(`.pcard[data-k="${CSS.escape(this.lastFocus || '')}"]`)?.classList.add('viewing');
  },
  closeDetail(silent = false) {
    const pane = document.querySelector('.detail-pane');
    if (!pane) return;
    pane.remove();
    document.querySelectorAll('.pcard.viewing').forEach(c => c.classList.remove('viewing'));
    if (silent) return;
    const card = this.lastFocus && document.querySelector(`.pcard[data-k="${CSS.escape(this.lastFocus)}"]`);
    if (card) card.focus({ preventScroll: false });
    if (App.page === PostsPage) this.load({ quiet: true });
  },
  detailBody(it, focus, r) {
    const blogs = App.status.blogs || [];
    const ev = it.evidence || {};
    const missing = !it.external && !it.members.some(m => m.blog === it.origin_blog && m.id === it.origin_id && m.state !== 'gone');
    return [
      h('div', { class: 'detail-head' },
        focus?.thumb ? h('img', { src: focus.thumb, class: 'detail-full', alt: '' }) : null,
        h('div', {},
          focus ? h('p', {}, h('b', {}, t('pfShowing') + ' '), focus.blog_name, ' · ', t('kind_' + focus.kind), ' · ', stateBadge(focus.state),
            focus.snapshot?.rev ? [' · ', t('versionN', focus.snapshot.rev)] : null) : null,
          missing ? h('p', { class: 'banner warn' }, t('pfMissingHint')) : null,
          focus?.summary ? h('p', { class: 'muted' }, focus.summary.slice(0, 400)) : null,
          focus?.tags?.length ? h('div', { class: 'chips' }, focus.tags.map(x => h('span', { class: 'mini-chip' }, '#' + x))) : focus ? h('p', { class: 'muted small' }, t('pfNoTags')) : null,
          h('p', {}, h('b', {}, t('management') + ': '), blogName(it.manager), ' ', h('span', { class: 'muted' }, '(' + t('rule_' + (ev.rule || 'manual')) + ')')),
          it.status !== 'ok' ? h('p', { class: 'banner warn' }, t('st_' + it.status)) : null,
          it.external ? null : h('p', {}, h('b', {}, t('origin') + ': '), blogName(it.origin_blog)),
          it.external ? null : h('div', { class: 'form-row' }, h('span', {}, t('assignTo') + ' '),
            select(blogs.filter(b => b.role === 'share').map(b => ({ value: b.uuid, label: b.name })), it.manager, async v => { await call('assign', { item: it.id, manager: v }); toast('✓'); this.openDetail(r); })))),
      this.editEntry(it, focus, r),
      h('h3', {}, t('instances')),
      h('div', { class: 'instances' }, it.members.map(m => this.instanceRow(m, r, focus))),
      this.versionsView(it),
      it.external ? null : this.tagEditor(it),
      this.fileInto(it)];
  },

  // Edit the post itself in the editor (same post, same link). From a reblog it is the original that is edited:
  // the reblog is a frozen snapshot; the way back returns to this exact instance with the query kept.
  editEntry(it, focus, r) {
    if (!focus || it.external) return null;
    const editable = m => m && m.kind === 'original' && ['published', 'private', 'queue', 'draft'].includes(m.state);
    const orig = editable(focus) ? focus : it.members.find(m => editable(m) && m.blog === it.origin_blog && m.id === it.origin_id) || it.members.find(editable);
    if (!orig) return null;
    const go = () => App.go('write', { edit: { blog: orig.blog, id: orig.id }, ret: { page: 'posts', detail: r } });
    return h('div', { class: 'form-row wrap' },
      h('button', { class: 'primary', onclick: go }, orig === focus ? t('edEdit') : t('edEditOriginal', orig.blog_name || blogName(orig.blog))),
      orig === focus ? null : h('span', { class: 'muted small' }, t('edReblogFrozen')));
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
  // Reblogs are not targets; reblogs of my own originals follow the original's tags under route automation.
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
      h('input', { placeholder: t('extraHint'), onkeydown: e => { if (e.key === 'Enter' && !e.isComposing) { const v = e.target.value.trim(); if (v) { add.push(...v.split(/[,，\n]/).map(x => x.trim().replace(/^#/, '')).filter(Boolean)); draw(); } } } }),
      h('div', { class: 'form-row wrap' }, h('span', { class: 'muted small' }, t('applyTo')), live.map(m => h('label', { class: 'check-label' },
        h('input', { type: 'checkbox', checked: targets.has(m.blog + '/' + m.id), onchange: e => { const k = m.blog + '/' + m.id; e.target.checked ? targets.add(k) : targets.delete(k); } }), m.blog_name, ' · ', t('kind_' + m.kind)))),
      kept.length ? h('p', { class: 'muted small' }, t('pfCopiesFollowShort', kept.length)) : null,
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

  instanceRow(m, r, focus) {
    const ex = m.expiry;
    const pol = m.policy || {};
    const url = `https://${blogName(m.blog)}.tumblr.com/post/${m.id}`;
    const act = async (fn) => { await fn(); toast('✓'); const it = await call('item', { id: m.item_id }); row.replaceWith(this.instanceRow(it.members.find(x => x.blog === m.blog && x.id === m.id), r, focus)); };
    const tgt = [{ blog: m.blog, id: m.id }];
    const here = focus && focus.blog === m.blog && focus.id === m.id;
    const row = h('div', { class: 'instance' + (here ? ' focus' : '') },
      h('div', { class: 'inst-main' },
        h('div', { class: 'inst-line' }, h('b', {}, m.blog_name), h('span', { class: 'badge' }, t('kind_' + m.kind)), stateBadge(m.state), here ? h('span', { class: 'badge accent' }, t('pfThisOne')) : null,
          m.snapshot ? h('span', { class: 'badge', title: t('snapshotHint') }, m.snapshot.rev ? t('versionN', m.snapshot.rev) + (m.snapshot.version_unknown ? ' ?' : '') : t('snapshot')) : null,
          pol.display !== 'follow_rule' ? h('span', { class: 'badge keep' }, t('pol_' + pol.display)) : null,
          pol.auto_hide ? h('span', { class: 'badge' }, t('autoHidden')) : null),
        h('div', { class: 'muted small' }, fmtDate(m.published_at), m.notes != null ? ' · ' + t('noteCount', m.notes, ago(m.notes_at)) : '',
          ' · ', h('a', { href: url, target: '_blank' }, t('openOnTumblr'))),
        !here && m.tags?.length ? h('div', { class: 'muted small' }, m.tags.map(x => '#' + x).join(' ')) : null,
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
};

// A button that opens a small list of actions under it (no native menus)
function menuButton(label, items) {
  const btn = h('button', { 'aria-haspopup': 'menu', onclick: e => {
    e.stopPropagation();
    document.querySelector('.menu-pop')?.remove();
    const r = btn.getBoundingClientRect();
    const close = () => { pop.remove(); window.removeEventListener('mousedown', out, true); window.removeEventListener('keydown', esc, true); btn.focus(); };
    const out = ev => { if (!pop.contains(ev.target)) close(); };
    const esc = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(); } };
    const pop = h('div', { class: 'menu-pop', role: 'menu' }, items.map(it => h('button', { role: 'menuitem', class: 'ghost', onclick: () => { close(); it.onclick(); } }, it.label)));
    document.body.append(pop);
    const below = r.bottom + pop.offsetHeight + 8 < window.innerHeight;
    Object.assign(pop.style, { left: Math.min(r.left, window.innerWidth - pop.offsetWidth - 8) + 'px', top: (below ? r.bottom + 4 : r.top - pop.offsetHeight - 4) + 'px' });
    pop.querySelector('button')?.focus();
    window.addEventListener('mousedown', out, true);
    window.addEventListener('keydown', esc, true);
  } }, label, ' ▾');
  return btn;
}
