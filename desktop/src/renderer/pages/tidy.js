'use strict';
// Tag upkeep (moved from the extension's manager): weak tags on my originals, tidying old posts by the template
// packs, and suggestions for a pack's own tags. Every scan only reads; nothing is written until a ticked list
// is confirmed, and then each post is its own job in Activity. Reblogs are snapshots and are never touched.

const TidyPage = {
  reasonText: r => r.reason === 'offtopic' ? t('why_offtopic', Math.round((r.share || 0) * 100)) : r.reason === 'fuzzy' ? t('why_fuzzy', r.match)
    : r.reason === 'cold' ? t('why_cold', r.rank, r.of) : r.reason === 'dead' ? t('why_dead') : r.reason === 'notes' ? t('why_notes') : r.reason,
  clean: null, cleanSel: new Set(), upk: null, upkSel: new Set(), review: null, progress: null,
  async render(root) {
    this.root = root;
    const [packs, st] = await Promise.all([call('packs'), call('tidyStatus')]);
    this.packs = packs.filter(p => p.id);
    const card = (title, hint, ...body) => h('section', { class: 'card' }, h('h2', {}, title), hint ? h('p', { class: 'muted' }, hint) : null, ...body);
    const running = st.running;
    const prog = running ? h('p', { class: 'muted small', id: 'tidyProg' }, t('tidyScanning', st.i || 0, st.n || '?'), ' ', h('button', { class: 'ghost', onclick: () => call('tidyStop') }, t('stop'))) : null;
    root.replaceChildren(
      h('header', { class: 'page-head' }, h('h1', {}, t('navTidy'))),
      h('p', { class: 'muted' }, t('tidyIntro')),
      prog,
      card(t('cleanTitle'), t('cleanHint'), this.cleanBody(running)),
      card(t('upkTitle'), t('upkHint'), this.upkBody()),
      card(t('reviewTitle'), t('reviewHint'), this.reviewBody(running)),
    );
  },
  refresh(ev) {
    if (ev?.type === 'tidy') {
      const p = document.getElementById('tidyProg');
      if (p) p.firstChild.textContent = t('tidyScanning', ev.data.i, ev.data.n);
    }
  },

  // ----- weak tags -----
  cleanBody(running) {
    const reasonText = TidyPage.reasonText;
    const c = this.clean;
    const box = h('div', {},
      h('div', { class: 'form-row wrap' },
        h('button', { class: 'primary', disabled: !!running, onclick: () => this.scanClean() }, c ? t('scanAgain') : t('scan')),
        toggle(!!this.notesOn, v => { this.notesOn = v; }, t('notesRule')),
        h('input', { type: 'number', class: 'num', min: 0, value: this.notesMax ?? 1, oninput: e => { this.notesMax = +e.target.value || 0; } })));
    if (!c) return box;
    box.append(h('p', { class: 'muted small' }, t('cleanFound', c.results.length, c.tags) + (c.failed ? ' · ' + t('sampleFailed', c.failed) : '') + (c.stopped ? ' · ' + t('stopped') : '')));
    if (!c.results.length) return box;
    box.append(
      h('div', { class: 'checklist' }, c.results.map(r => h('label', { class: 'check-row' + (r.reason === 'offtopic' ? ' bad' : '') },
        h('input', { type: 'checkbox', checked: this.cleanSel.has(r.key), onchange: e => { e.target.checked ? this.cleanSel.add(r.key) : this.cleanSel.delete(r.key); this.render(this.root); } }),
        h('b', {}, '#' + r.tag),
        h('span', { class: 'muted small' }, [reasonText(r), r.followers != null ? t('followersN', r.followers) : '', r.avg != null ? t('avgNotes', Math.round(r.avg * 10) / 10) : '', t('usedTimes', r.uses)].filter(Boolean).join(' · '))))),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', disabled: !this.cleanSel.size, onclick: () => this.applyClean() }, t('removeTicked', this.cleanSel.size))));
    return box;
  },
  async scanClean() {
    const p = call('cleanupScan', { notesOn: !!this.notesOn, notesMax: this.notesMax ?? 1 });
    setTimeout(() => this.render(this.root), 300);
    try { this.clean = await p; } catch (e) { toast(cleanErr(e), 'err'); }
    for (const k of [...this.cleanSel]) if (!this.clean?.results.some(r => r.key === k)) this.cleanSel.delete(k);
    this.render(this.root);
  },
  async applyClean() {
    const tags = this.clean.results.filter(r => this.cleanSel.has(r.key)).map(r => r.tag);
    const pv = await call('cleanupPreview', { tags });
    const ok = await modal(t('removeTicked', tags.length), h('div', {},
      h('p', {}, t('cleanConfirm', tags.length, pv.posts)),
      h('p', { class: 'muted small' }, tags.map(x => '#' + x).join('  ')),
      h('p', { class: 'muted small' }, t('snapshotsUntouched'))), [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
    if (!ok) return;
    const r = await call('cleanupApply', { tags });
    toast(t('queuedN', r.queued), 'ok');
    this.clean.results = this.clean.results.filter(x => !this.cleanSel.has(x.key));
    this.cleanSel.clear();
    this.render(this.root);
  },

  // ----- tidy by packs -----
  upkBody() {
    const u = this.upk;
    const box = h('div', {}, h('div', { class: 'form-row' },
      h('button', { class: 'primary', disabled: !this.packs.length, onclick: async () => { this.upk = await call('upkeepScan'); this.upkSel = new Set(this.upk.rules.map(r => r.rule)); this.render(this.root); } }, u ? t('scanAgain') : t('scan'))),
    !this.packs.length ? h('p', { class: 'muted small' }, t('upkNeedPack')) : null);
    if (!u) return box;
    if (!u.rules.length) { box.append(h('p', { class: 'muted small' }, t('upkNone'))); return box; }
    const targets = u.rules.filter(r => this.upkSel.has(r.rule)).reduce((n, r) => n + r.posts, 0);
    box.append(
      h('p', { class: 'muted small' }, t('upkFound', u.rules.length, u.posts)),
      h('div', { class: 'checklist' }, u.rules.map(r => h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: this.upkSel.has(r.rule), onchange: e => { e.target.checked ? this.upkSel.add(r.rule) : this.upkSel.delete(r.rule); this.render(this.root); } }),
        r.type === 'add' ? h('span', {}, h('b', {}, '+ #' + r.to), ' ', h('span', { class: 'muted small' }, t('upkAdd')))
          : r.to ? h('span', {}, h('s', {}, '#' + r.from), ' → ', h('b', {}, '#' + r.to))
          : h('span', {}, h('s', {}, '#' + r.from), ' ', h('span', { class: 'muted small' }, t(r.why === 'dropped' ? 'upkRemoveDropped' : 'upkRemoveHas'))),
        h('span', { class: 'muted small' }, `${r.item} · ${r.pack} · ${t('postsN', r.posts)}`),
        h('span', { class: 'small' }, r.examples.map(x => [' ', h('a', { href: `https://www.tumblr.com/${x.blogName}/${x.id}`, target: '_blank' }, `${x.blogName}/${x.id}`)]))))),
      h('div', { class: 'actions' }, h('button', { class: 'primary', disabled: !this.upkSel.size, onclick: () => this.applyUpk(targets) }, t('applyTicked'))));
    return box;
  },
  async applyUpk(targets) {
    const ok = await modal(t('upkTitle'), h('div', {}, h('p', {}, t('upkConfirm', this.upkSel.size, targets)), h('p', { class: 'muted small' }, t('snapshotsUntouched'))),
      [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
    if (!ok) return;
    const r = await call('upkeepApply', { rules: [...this.upkSel] });
    toast(t('queuedN', r.queued), 'ok');
    this.upk = null;
    this.render(this.root);
  },

  // ----- pack review -----
  reviewBody(running) {
    const rv = this.review;
    const box = h('div', {}, h('div', { class: 'form-row wrap' },
      select(this.packs.map(p => ({ value: p.id, label: p.name })), this.reviewPack || this.packs[0]?.id || '', v => { this.reviewPack = v; }),
      h('button', { class: 'primary', disabled: !this.packs.length || !!running, onclick: () => this.scanReview() }, t('suggestChanges'))));
    if (!rv) return box;
    box.append(h('p', { class: 'muted small' }, t('reviewFound', rv.items.length, rv.name) + (rv.failed ? ' · ' + t('sampleFailed', rv.failed) : '') + (rv.stopped ? ' · ' + t('stopped') : '')));
    for (const it of rv.items) {
      box.append(h('div', { class: 'review-item' }, h('h3', {}, it.name, ' ', h('span', { class: 'muted small' }, it.tags.map(x => '#' + x).join(' '))),
        it.remove.map(r => h('label', { class: 'check-row' + (r.reason === 'offtopic' ? ' bad' : '') },
          h('input', { type: 'checkbox', checked: r.on, onchange: e => { r.on = e.target.checked; } }), h('s', {}, '#' + r.tag), h('span', { class: 'muted small' }, TidyPage.reasonText(r)))),
        it.add.map(a => h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', checked: a.on, onchange: e => { a.on = e.target.checked; } }), h('b', {}, '+ #' + a.tag), h('span', { class: 'muted small' }, t('coUsed', Math.round((a.share || 0) * 100)))))));
    }
    if (rv.items.length) box.append(h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: () => this.applyReview() }, t('writeIntoPack')),
      h('button', { onclick: async () => { const j = await call('packJson', { id: rv.pack }); await navigator.clipboard.writeText(j); toast(t('copied'), 'ok'); } }, t('copyPackJson'))));
    return box;
  },
  async scanReview() {
    const id = this.reviewPack || this.packs[0]?.id;
    const p = call('packReview', { id });
    setTimeout(() => this.render(this.root), 300);
    try { this.review = await p; } catch (e) { toast(cleanErr(e), 'err'); }
    this.render(this.root);
  },
  async applyReview() {
    const items = this.review.items.map(it => ({ id: it.id, remove: it.remove.filter(r => r.on).map(r => r.tag), add: it.add.filter(a => a.on).map(a => a.tag) }))
      .filter(it => it.remove.length || it.add.length);
    if (!items.length) return toast(t('nothingTicked'));
    const r = await call('packReviewApply', { pack: this.review.pack, items });
    toast(t('packChanged', r.changed) + (r.keptOne.length ? ' · ' + t('keptOneTag', r.keptOne.length) : ''), 'ok');
    this.review = null;
    this.render(this.root);
  },
};
