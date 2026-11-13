'use strict';
// "Versions & reblogs" for one work (docs/REBLOG_POLICY.md 2.1, R12-R17): every observed source version and,
// per blog, the reblogs holding them; compare two versions; act on exactly the chosen reblogs after a preview.
// The original is never a target here, and nothing edits a reblog's body or tags.

const VersionsDialog = {
  async open({ blog, id }) {
    this.key = { blog, id };
    this.sel = new Set();
    this.filter = { dest: '', state: '' };
    this.box = h('div', { class: 'versions-dlg' }, h('p', { class: 'muted' }, t('loading')));
    const shown = modal(t('versionsTitle'), this.box, [{ label: t('close'), value: null }], { wide: true });
    await this.draw();
    await shown;
  },
  async draw() {
    const v = this.v = await call('versions', this.key);
    if (!v) { this.box.replaceChildren(h('p', { class: 'muted' }, t('versionsNone'))); return; }
    const k = c => c.dest + '/' + c.dest_id;
    const stateOk = c => !this.filter.state || (this.filter.state === 'problem' ? ['pending', 'unknown', 'failed'].includes(c.status) || !!c.job : c.state === this.filter.state);
    const dests = v.dests.filter(d => !this.filter.dest || d.dest === this.filter.dest);
    const shownCopies = dests.flatMap(d => d.copies.filter(c => c.dest_id && stateOk(c)).map(c => ({ ...c, dest: d.dest })));
    for (const s of [...this.sel]) if (!shownCopies.some(c => k(c) === s)) this.sel.delete(s);
    const verBadge = c => t('versionN', c.rev) + (c.version_unknown ? ' ?' : '');
    this.box.replaceChildren(
      // the work
      h('div', { class: 'form-row' },
        v.origin.thumb ? h('img', { src: v.origin.thumb, class: 'vthumb' }) : null,
        h('div', { class: 'grow' }, h('b', {}, v.origin.name), ' · ', stateBadge(v.origin.state || 'gone'), ' ',
          h('a', { href: v.origin.url, target: '_blank' }, t('openOnTumblr')),
          h('p', { class: 'muted small' }, v.origin.summary || ''),
          h('p', { class: 'small' }, t('latestSource', v.latest || '?'), v.pending ? ' · ' + t('pendingN', v.pending) : ''))),
      // versions
      h('h3', {}, t('sourceVersions')),
      h('table', { class: 'table' }, h('tbody', {}, v.revisions.map(r => h('tr', {},
        h('td', { class: 'nowrap' }, h('b', {}, t('versionN', r.rev)), r.rev === v.latest ? h('span', { class: 'badge keep' }, t('latestTag')) : null),
        h('td', { class: 'nowrap muted small' }, (r.baseline ? t('publishedAt') : t('observedAt')) + ' ' + fmtTime(r.since)),
        h('td', {}, h('input', { value: r.label, placeholder: t('versionLabel'), onchange: e => this.note(r, { label: e.target.value }) })),
        h('td', {}, h('input', { value: r.note, placeholder: t('versionNote'), onchange: e => this.note(r, { note: e.target.value }) })),
        h('td', { class: 'nowrap' }, r.comparable
          ? [h('label', { class: 'check-label' }, h('input', { type: 'radio', name: 'cmpA', checked: this.a === r.rev, onchange: () => { this.a = r.rev; } }), 'A'),
            h('label', { class: 'check-label' }, h('input', { type: 'radio', name: 'cmpB', checked: this.b === r.rev, onchange: () => { this.b = r.rev; } }), 'B')]
          : h('span', { class: 'muted small' }, t('notComparable'))))))),
      h('div', { class: 'actions' }, h('button', { onclick: () => this.compare() }, t('compareAB')), h('span', { class: 'muted small' }, t('notesLocal'))),
      this.diffBox = h('div', {}),
      // reblogs per blog
      h('h3', {}, t('reblogsPerBlog')),
      h('div', { class: 'form-row wrap' },
        select([{ value: '', label: t('allBlogs') }, ...v.dests.map(d => ({ value: d.dest, label: d.name }))], this.filter.dest, x => { this.filter.dest = x; this.draw(); }),
        select([{ value: '', label: t('anyState') }, { value: 'published', label: t('state_published') }, { value: 'private', label: t('state_private') }, { value: 'gone', label: t('state_gone') }, { value: 'problem', label: t('needsAttention') }], this.filter.state, x => { this.filter.state = x; this.draw(); }),
        h('span', { class: 'muted small' }, t('versionCoverage', shownCopies.length))),
      dests.map(d => h('div', { class: 'vdest' },
        h('div', { class: 'form-row' }, h('b', { class: 'grow' }, d.name),
          h('span', { class: 'muted small' }, d.latestVerified ? t('latestVerifiedHere', d.latestVerified) : t('noneVerifiedHere')),
          d.missingLatest && v.origin.state === 'published' ? h('button', { onclick: () => this.resend(d) }, t('reblogLatest', v.latest)) : null,
          h('button', { class: 'ghost', onclick: () => { for (const c of d.copies) if (c.dest_id && stateOk(c) && c.state && c.state !== 'gone') this.sel.add(d.dest + '/' + c.dest_id); this.draw(); } }, t('selectAllHere'))),
        h('table', { class: 'table' }, h('tbody', {}, d.copies.filter(stateOk).map(c => h('tr', {},
          h('td', {}, c.dest_id && c.state !== 'gone' ? h('input', { type: 'checkbox', checked: this.sel.has(d.dest + '/' + c.dest_id), onchange: e => { const x = d.dest + '/' + c.dest_id; e.target.checked ? this.sel.add(x) : this.sel.delete(x); this.drawBar(); } }) : null),
          h('td', { class: 'nowrap' }, h('b', {}, verBadge(c))),
          h('td', {}, c.thumb ? h('img', { src: c.thumb, class: 'vthumb small' }) : h('span', { class: 'muted small' }, (c.summary || '').slice(0, 60))),
          h('td', { class: 'nowrap' }, c.state ? stateBadge(c.state) : null, c.keepPublic ? h('span', { class: 'badge keep' }, t('keepPublicBadge')) : null),
          h('td', { class: 'nowrap small' }, h('span', { class: 'badge' + (['failed', 'unknown', 'conflict'].includes(c.status) ? ' warn' : '') }, t('dst_' + c.status)), c.job ? h('span', { class: 'badge warn' }, t('jobOpen', c.job.status)) : null),
          h('td', { class: 'nowrap muted small' }, t('rebloggedAt') + ' ' + fmtTime(c.reblogged_at)),
          h('td', { class: 'muted small' }, c.tags ? '#' + c.tags.join(' #') : ''),
          h('td', {}, c.url && c.state !== 'gone' ? h('a', { href: c.url, target: '_blank' }, '↗') : null))))))),
      this.bar = h('div', { class: 'actions sticky' }));
    this.drawBar();
  },
  drawBar() {
    const n = this.sel.size;
    this.bar.replaceChildren(
      h('span', { class: 'muted small' }, t('selectedN', n)),
      ...[['show', 'makePublic'], ['hide', 'makePrivate'], ['keepPublic', 'keepPublicAct'], ['followRule', 'followRuleAct']].map(([a, label]) => h('button', { disabled: !n, onclick: () => this.act(a) }, t(label))),
      h('button', { class: 'danger', disabled: !n, onclick: () => this.act('delete') }, t('deleteChosen')),
      h('button', { class: 'ghost', onclick: () => this.hideOld() }, t('hideOldAct')));
  },
  targets() { return [...this.sel].map(x => { const i = x.lastIndexOf('/'); return { dest: x.slice(0, i), dest_id: x.slice(i + 1) }; }); },
  async note(r, patch) { await call('versionNote', { ...this.key, rev: r.rev, label: patch.label ?? r.label, note: patch.note ?? r.note }); Object.assign(r, patch); toast('✓', 'ok'); },
  async compare() {
    if (!this.a || !this.b || this.a === this.b) return toast(t('pickTwo'));
    const d = await call('versionDiff', { ...this.key, a: this.a, b: this.b });
    if (!d.comparable) { this.diffBox.replaceChildren(h('p', { class: 'banner warn small' }, t('cantCompare', d.missing.join(', ')))); return; }
    const im = d.images;
    this.diffBox.replaceChildren(h('div', { class: 'card inset' },
      h('h3', {}, t('diffTitle', this.a, this.b)),
      d.same ? h('p', {}, t('diffSame')) : null,
      d.text.map(x => h('div', { class: 'diff-row' }, h('div', { class: 'del' }, x.before ?? '—'), h('div', { class: 'add' }, x.after ?? '—'))),
      h('p', { class: 'small' }, t('diffImages', im.before, im.after, im.added, im.removed) + (im.moved ? ' · ' + t('diffMoved') : '') + (d.layoutChanged ? ' · ' + t('diffLayout') : '')),
      h('p', { class: 'muted small' }, t('diffTagsApart')),
      ['a', 'b'].map(s => h('p', { class: 'small' }, h('b', {}, t('versionN', s === 'a' ? this.a : this.b)), ': ', d.tags[s].length ? d.tags[s].map(x => x.name + ' #' + x.tags.join(' #')).join(' · ') : t('noTagsRecorded')))));
  },
  async act(action) {
    const pv = await call('versionActionPreview', { ...this.key, targets: this.targets(), action });
    const row = x => h('li', {}, `${x.name} · ${t('versionN', x.rev)}${x.version_unknown ? ' ?' : ''} · ${x.dest_id}`, x.reason ? h('span', { class: 'muted small' }, ' — ' + t('skip_' + x.reason)) : null);
    const ok = await modal(t('act_' + action), h('div', {},
      action === 'delete' ? h('p', { class: 'banner warn' }, t('deleteWarn')) : null,
      h('p', {}, t('actWill', pv.ok.length)), h('ul', { class: 'plain' }, pv.ok.map(row)),
      pv.skipped.length ? [h('p', { class: 'muted' }, t('actSkips', pv.skipped.length)), h('ul', { class: 'plain muted' }, pv.skipped.map(row))] : null,
      h('p', { class: 'muted small' }, t('originalUntouched'))),
    [{ label: t('cancel'), value: false }, { label: action === 'delete' ? t('deleteN', pv.ok.length) : t('apply'), value: true, class: action === 'delete' ? 'danger' : 'primary', disabled: !pv.ok.length }]);
    if (!ok || !pv.ok.length) return;
    const r = await call('versionAction', { ...this.key, targets: this.targets(), action });
    toast(action === 'followRule' ? '✓' : t('queuedN', r.queued), 'ok');
    this.sel.clear();
    this.draw();
  },
  async hideOld() {
    const pv = await call('hideOldPreview', this.key);
    const n = pv.blogs.reduce((a, b) => a + b.hide.length, 0);
    const ok = await modal(t('hideOldAct'), h('div', {}, h('p', { class: 'muted' }, t('hideOldHint')),
      pv.blogs.map(b => h('div', { class: 'vdest' }, h('b', {}, b.name), ' ',
        b.held ? h('span', { class: 'muted small' }, t('held_' + b.held)) : [
          h('p', { class: 'small' }, t('keepsVersion', b.keep.rev)),
          b.hide.length ? h('p', { class: 'small' }, t('hidesVersions', b.hide.map(c => c.rev).join(', '))) : h('p', { class: 'muted small' }, t('nothingToHide')),
          (b.left || []).length ? h('p', { class: 'muted small' }, t('leftAlone', b.left.map(c => t('versionN', c.rev) + ' (' + t('skip_' + c.why) + ')').join(', '))) : null]))),
    [{ label: t('cancel'), value: false }, { label: t('hideN', n), value: true, class: 'primary', disabled: !n }]);
    if (!ok || !n) return;
    const r = await call('hideOld', this.key);
    toast(t('queuedN', r.queued), 'ok');
    this.draw();
  },
  async resend(d) {
    const ok = await modal(t('reblogLatest', this.v.latest), h('p', {}, t('reblogNewQ', d.name)), [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
    if (!ok) return;
    try { await call('versionReblog', { ...this.key, dest: d.dest }); toast(t('queued', 1), 'ok'); } catch (e) { toast(cleanErr(e), 'err'); }
    this.draw();
  },
};
