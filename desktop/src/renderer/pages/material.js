'use strict';
// Materials: liked posts collected onto a material blog (moved here from the browser extension), and today's
// quick study. Everything a collected reblog carries is chosen before it is created; nothing is written onto it
// afterwards (docs/REBLOG_POLICY.md).

const MaterialPage = {
  seed: 0,
  async render(root) {
    this.root = root;
    const [s, log] = await Promise.all([call('collectSettings'), call('collectLog', { limit: 60 })]);
    const blogs = (App.status.blogs || []).filter(b => !b.is_primary);
    const ai = App.status.settings?.ai || {};
    let tagText = (s.tags || []).join(', ');
    const save = async patch => { await call('saveCollect', patch); toast('✓', 'ok'); this.render(root); };
    const mats = (App.status.blogs || []).filter(b => b.role === 'material');
    this.artBlog = this.artBlog && mats.some(b => b.uuid === this.artBlog) ? this.artBlog : (mats.find(b => b.uuid === s.blog) || mats[0])?.uuid || '';
    const [art, artList] = this.artBlog ? await Promise.all([call('aiArtStatus', { blog: this.artBlog }), call('aiArtList', { blog: this.artBlog })]) : [null, []];
    const study = s.blog ? await call('dailyStudy', { seed: new Date().toISOString().slice(0, 10) + (this.seed ? '#' + this.seed : '') }) : [];
    root.replaceChildren(
      h('header', { class: 'page-head' }, h('h1', {}, t('navMaterial'))),
      h('div', { class: 'grid2' },
        h('section', { class: 'card' }, h('h2', {}, t('colTitle')), h('p', { class: 'muted' }, t('colHint')),
          h('label', { class: 'field' }, h('span', {}, t('colBlog')),
            select([{ value: '', label: t('colOff') }, ...blogs.map(b => ({ value: b.uuid, label: b.name + (b.role === 'material' ? ' · ' + t('role_material') : '') }))], s.blog || '', v => save({ blog: v }))),
          h('label', { class: 'field' }, h('span', {}, t('colTags')),
            h('input', { value: tagText, placeholder: 'reference, art reference', oninput: e => { tagText = e.target.value; }, onchange: () => save({ tags: tagText.split(',') }) })),
          h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: s.autoPalette !== false, onchange: e => save({ autoPalette: e.target.checked }) }), t('colPalette')),
          h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: !!s.ai, disabled: !(ai.base && ai.model), onchange: e => save({ ai: e.target.checked }) }), t('colAi')),
          !(ai.base && ai.model) ? h('p', { class: 'muted small' }, t('colAiSetup')) : null,
          h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: !!s.auto, disabled: !s.blog, onchange: e => save({ auto: e.target.checked }) }), t('colAuto')),
          h('p', { class: 'muted small' }, t('colFrozen')),
          s.fromExtension?.auto && !s.auto ? h('p', { class: 'banner warn small' }, t('colWasAuto')) : null,
          h('div', { class: 'actions' }, h('button', { disabled: !s.blog, onclick: () => this.preview() }, t('colPreview')))),
        h('section', { class: 'card' }, h('h2', {}, t('studyTitle')),
          study.length ? h('div', { class: 'study' }, study.map(x => h('a', { href: x.big, target: '_blank' }, h('img', { src: x.small, loading: 'lazy' }))))
            : h('p', { class: 'muted' }, s.blog ? t('studyNone') : t('colPickFirst')),
          study.length ? h('button', { class: 'ghost', onclick: () => { this.seed++; this.render(root); } }, t('studyAnother')) : null)),
      this.artCard(mats, art, artList),
      h('section', { class: 'card' }, h('h2', {}, t('colLog')),
        log.length ? h('table', { class: 'table' }, h('tbody', {}, log.map(r => h('tr', {},
          h('td', { class: 'nowrap' }, fmtTime(r.at)),
          h('td', {}, h('a', { href: `https://${r.src_name || 'www'}.tumblr.com/post/${r.src_id}`, target: '_blank' }, (r.src_name || '?') + '/' + r.src_id)),
          h('td', {}, h('span', { class: 'badge' + (r.status === 'created' ? ' keep' : r.status === 'failed' || r.status === 'unknown' ? ' warn' : '') }, t('cst_' + r.status) || r.status), r.reason ? ' ' + (t('csr_' + r.reason) !== 'csr_' + r.reason ? t('csr_' + r.reason) : r.reason) : ''),
          h('td', { class: 'muted small' }, r.tags ? '#' + r.tags.join(' #') : ''))))) : h('p', { class: 'muted' }, t('colLogNone'))));
  },
  refresh(ev) {
    if (ev.type === 'aiart') { const p = document.getElementById('artProg'); if (p) p.firstChild.textContent = t('artChecking', ev.data.i, ev.data.n); return; }
    if (ev.type === 'job' || ev.type === 'pass') this.render(this.root);
  },

  // AI-made images among collected material: results stay in the app; removing is a confirmed delete + unlike
  artSel: new Set(),
  artCard(mats, art, list) {
    const head = [h('h2', {}, t('artTitle')), h('p', { class: 'muted' }, t('artHint'))];
    if (!mats.length) return h('section', { class: 'card' }, ...head, h('p', { class: 'muted small' }, t('artNoMaterial')));
    const why = r => r.verdict === 'ai' ? t('artWhyOwner') : r.why === 'others' ? t('artWhyOthers', r.n) : t('artWhyVision');
    return h('section', { class: 'card' }, ...head,
      h('div', { class: 'form-row wrap' },
        mats.length > 1 ? select(mats.map(b => ({ value: b.uuid, label: b.name })), this.artBlog, v => { this.artBlog = v; this.artSel.clear(); this.render(this.root); }) : h('b', {}, mats[0].name),
        h('button', { class: 'primary', disabled: !!art?.running || !art?.posts, onclick: () => this.artCheck() }, t('artCheck')),
        h('span', { class: 'muted small' }, art ? t('artChecked', art.checked, art.posts) : '')),
      art?.running ? h('p', { class: 'muted small', id: 'artProg' }, t('artChecking', art.running.i, art.running.n), ' ', h('button', { class: 'ghost', onclick: () => call('aiArtStop') }, t('stop'))) : null,
      list.length ? h('div', { class: 'cards' }, list.map(r => h('label', { class: 'pcard' },
        r.thumb ? h('div', { class: 'thumb' }, h('img', { src: r.thumb, loading: 'lazy' })) : h('div', { class: 'thumb text' }, r.summary || r.id),
        h('div', { class: 'meta' }, h('input', { type: 'checkbox', checked: this.artSel.has(r.id), onchange: e => { e.target.checked ? this.artSel.add(r.id) : this.artSel.delete(r.id); } }), ' ',
          h('span', { class: 'badge' + (r.verdict === 'ai' ? ' warn' : '') }, t(r.verdict === 'ai' ? 'artAi' : 'artSuspect')), ' ', h('span', { class: 'muted small' }, why(r)))))) : art?.checked ? h('p', { class: 'muted small' }, t('artNone')) : null,
      list.length ? h('div', { class: 'actions' }, h('button', { class: 'danger', onclick: () => this.artRemove() }, t('artRemove'))) : null);
  },
  async artCheck() {
    const p = call('aiArtCheck', { blog: this.artBlog });
    setTimeout(() => this.render(this.root), 300);
    try { const r = await p; toast(t('artDone', r.checked, r.flagged) + (r.failed ? ' · ' + t('sampleFailed', r.failed) : ''), 'ok'); } catch (e) { toast(cleanErr(e), 'err'); }
    this.render(this.root);
  },
  async artRemove() {
    if (!this.artSel.size) return toast(t('nothingTicked'));
    let unlike = true;
    const ok = await modal(t('artRemove'), h('div', {}, h('p', {}, t('artRemoveQ', this.artSel.size)),
      toggle(true, v => { unlike = v; }, t('artUnlike')), h('p', { class: 'muted small' }, t('artRemoveNote'))),
      [{ label: t('cancel'), value: false }, { label: t('delete'), value: true, class: 'danger' }]);
    if (!ok) return;
    const r = await call('aiArtRemove', { blog: this.artBlog, ids: [...this.artSel], unlike });
    toast(t('queuedN', r.queued), 'ok');
    this.artSel.clear();
    this.render(this.root);
  },

  // Older likes are never collected by switching on; here they can be chosen, with the reason for each skip
  async preview() {
    const box = h('div', {}, h('p', { class: 'muted' }, t('loading')));
    const pick = new Map();
    const shown = modal(t('colPreview'), box, [{ label: t('cancel'), value: false }, { label: t('colCollect'), value: true, class: 'primary' }], { wide: true });
    try {
      const rows = await call('collectPreview', { limit: 60 });
      box.replaceChildren(rows.length ? h('div', { class: 'cards' }, rows.map(r => h('label', { class: 'pcard' + (r.skip ? ' dim' : '') },
        r.thumb ? h('div', { class: 'thumb' }, h('img', { src: r.thumb, loading: 'lazy' })) : h('div', { class: 'thumb text' }, r.blog + '/' + r.id),
        h('div', { class: 'meta' }, r.skip ? h('span', { class: 'badge' }, t('csr_' + r.skip)) : h('span', {}, h('input', { type: 'checkbox', onchange: e => { e.target.checked ? pick.set(r.root, r.post) : pick.delete(r.root); } }), ' ', r.blog))))) : h('p', { class: 'muted' }, t('colNoLikes')));
    } catch (e) { box.replaceChildren(h('p', { class: 'warn-text' }, cleanErr(e))); }
    if (!(await shown) || !pick.size) return;
    const r = await call('collect', { posts: [...pick.values()] });
    toast(t('queued', r.queued), 'ok');
    this.render(this.root);
  },
};
