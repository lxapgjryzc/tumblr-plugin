'use strict';
// Fans & interactions (docs/FAN_RELATIONSHIP_SPEC.md): Today, Interactions, People, Changes, Protection.
// Everything marked here (done, later, replied, notes, stars, reminders) is local; "Open on Tumblr" only opens.

const FansPage = {
  tab: 'today',
  sel: null,            // selected person key
  last: null,           // last workflow change, for undo: { prev: [...] }
  ev: { kind: 'text', state: 'open', blog: '', q: '', limit: 50 },
  pp: { rel: 'all', q: '', label: '', star: false, sort: 'recent', limit: 80 },
  days: 7,

  // Re-rendering after an action keeps the list where it was (the reply panel stays open over it)
  async render(root, params = {}) {
    const again = this.root === root && App.page === FansPage;
    const sc = again ? root.scrollTop : 0;
    await this.renderPage(root, params);
    if (again) root.scrollTop = sc;
    if (params.thread) this.openThread(params.thread);
  },
  async renderPage(root, params = {}) {
    this.root = root;
    if (params.tab) this.tab = params.tab;
    if (params.person) this.sel = params.person;
    const [cfg, today] = await Promise.all([call('fansConfig'), call('fansToday')]);
    this.cfg = cfg;
    const tabs = ['today', 'events', 'people', 'changes', 'protect'];
    const open = today.items.length;
    root.replaceChildren(
      h('header', { class: 'page-head' }, h('h1', {}, t('navFans')),
        h('div', { class: 'head-actions' },
          cfg.collect ? h('span', { class: 'muted small' }, this.coverageLine(cfg)) : null,
          cfg.collect ? h('button', { onclick: async () => { await call('fansSync'); toast(t('fnSyncQueued')); } }, t('syncNow')) : null,
          h('button', { class: 'ghost', onclick: () => this.settings() }, t('fnSettings')))),
      cfg.collect ? null : this.setupCard(cfg),
      h('div', { class: 'fans-summary' },
        h('span', {}, t('fnOpen'), ' ', h('b', {}, open)),
        h('span', {}, t('fnDueToday'), ' ', h('b', {}, today.reminders.length)),
        h('span', { class: today.digest.review ? 'warn-text' : '' }, t('fnReview'), ' ', h('b', {}, today.digest.review))),
      h('div', { class: 'seg fans-tabs' }, tabs.map(x => h('button', { class: this.tab === x ? 'on' : '', onclick: () => { this.tab = x; this.render(root); } }, t('fnTab_' + x)))),
      h('div', { id: 'fansBody' }));
    const body = $('#fansBody', root);
    if (this.tab === 'protect') { const box = h('div'); body.append(box); await FollowersPage.render(box, { embedded: true }); return; }
    if (this.tab === 'changes') { body.append(await this.changesView()); return; }
    const list = this.tab === 'today' ? this.todayView(today) : this.tab === 'events' ? await this.eventsView() : await this.peopleView();
    const side = h('aside', { class: 'fans-side' });
    body.append(h('div', { class: 'fans-cols' }, h('div', { class: 'fans-main' }, list), side));
    this.side = side;
    await this.renderSide();
  },

  coverageLine(cfg) {
    const at = Math.max(0, ...cfg.coverage.map(c => c.notif?.at || 0));
    const err = cfg.coverage.find(c => c.notif?.error && (c.notif.errorAt || 0) > (c.notif.at || 0));
    return err ? t('fnReadFailed', blogName(err.blog)) : at ? t('fnUpdated', ago(at)) : t('fnNotYet');
  },

  setupCard(cfg) {
    let pick = new Set(cfg.blogs);
    const blogs = App.status?.blogs || [];
    const row = h('div', { class: 'chips' });
    const draw = () => row.replaceChildren(blogs.map(b => h('button', { class: 'chip' + (pick.has(b.uuid) ? ' on' : ''), onclick: () => { pick.has(b.uuid) ? pick.delete(b.uuid) : pick.add(b.uuid); draw(); } }, b.name)));
    draw();
    return h('section', { class: 'card' },
      h('h2', {}, t('fnSetupTitle')),
      h('p', { class: 'muted small' }, t('fnSetupHint')),
      h('div', { class: 'form-row wrap' }, h('span', {}, t('fnBlogs')), row),
      h('p', { class: 'muted small' }, t('fnSetupCost')),
      h('button', { class: 'primary', onclick: async () => { await call('setFansConfig', { collect: true, blogs: [...pick] }); toast(t('fnStarted')); this.render(this.root); } }, t('fnStart')));
  },

  async settings() {
    const cfg = await call('fansConfig');
    let pick = new Set(cfg.blogs), collect = cfg.collect, notif = cfg.notifications !== false;
    const blogs = App.status?.blogs || [];
    const row = h('div', { class: 'chips' });
    const draw = () => row.replaceChildren(blogs.map(b => h('button', { class: 'chip' + (pick.has(b.uuid) ? ' on' : ''), onclick: () => { pick.has(b.uuid) ? pick.delete(b.uuid) : pick.add(b.uuid); draw(); } }, b.name)));
    draw();
    const body = h('div', {},
      h('div', { class: 'form-row' }, toggle(collect, v => { collect = v; }, t('fnCollect'))),
      h('div', { class: 'form-row' }, toggle(notif, v => { notif = v; }, t('fnReadNotifs'))),
      h('div', { class: 'form-row wrap' }, h('span', {}, t('fnBlogs')), row),
      h('p', { class: 'muted small' }, t('fnSettingsNote')),
      cfg.coverage.map(c => h('p', { class: 'muted small' }, blogName(c.blog), ': ',
        c.notif?.at ? t('fnCovered', fmtDate(c.notif.coveredFrom), ago(c.notif.at)) : t('fnNotYet'),
        c.notif?.gaps?.length ? ' · ' + t('fnGaps', c.notif.gaps.length) : '',
        c.notif?.error ? ' · ' + t('fnLastError', c.notif.error) : '',
        c.scan?.at ? ' · ' + t('fnListRead', c.scan.count ?? 0, ago(c.scan.at)) : '')),
      h('p', { class: 'muted small' }, t('fnCaps', t('fcap_' + cfg.capabilities.notifications), t('fcap_' + cfg.capabilities.followedBy))));
    const ok = await modal(t('fnSettings'), body, [{ label: t('cancel'), value: false }, { label: t('save'), value: true, class: 'primary' }]);
    if (!ok) return;
    await call('setFansConfig', { collect, notifications: notif, blogs: [...pick] });
    this.render(this.root);
  },

  // ---------- Today ----------
  todayView(d) {
    const rem = d.reminders.map(r => h('div', { class: 'fan-row reminder' },
      h('div', { class: 'grow' },
        h('div', { class: 'fan-head' }, h('span', { class: 'badge accent' }, t('fnReminder')), this.nameBtn(r.uuid, r.alias || r.name), h('span', { class: 'muted small' }, r.due ? fmtTime(r.due) : '')),
        h('div', {}, r.text)),
      h('div', { class: 'fan-actions' },
        h('button', { onclick: async () => { await call('setReminder', { id: r.id, status: 'done' }); this.render(this.root); } }, t('fnDone')),
        h('button', { class: 'ghost', onclick: async () => { await call('setReminder', { id: r.id, due: tomorrow() }); this.render(this.root); } }, t('fnTomorrow')))));
    const items = d.items.map(e => this.eventRow(e));
    return [
      this.last ? h('div', { class: 'banner' }, t('fnMarked', this.last.prev.length), ' ', h('button', { class: 'ghost', onclick: async () => { await call('setFansEvents', { restore: this.last.prev }); this.last = null; this.render(this.root); } }, t('undo'))) : null,
      rem.length ? h('div', { class: 'fan-list' }, h('div', { class: 'fan-label' }, t('fnRemindersToday')), rem) : null,
      h('div', { class: 'fan-list' }, h('div', { class: 'fan-label' }, t('fnWorthAnswering')),
        items.length ? items : h('div', { class: 'fan-row muted' }, this.cfg.collect ? t('fnAllClear') : t('fnNotCollecting'))),
      h('p', { class: 'muted small' }, t('fnDigest', d.digest.likes, d.digest.reblogs, d.digest.follows), d.digest.later ? ' · ' + t('fnLaterN', d.digest.later) : ''),
      h('p', { class: 'muted small' }, t('fnLocalNote')),
    ];
  },

  eventRow(e) {
    const post = e.post_id ? `https://www.tumblr.com/${blogName(e.blog)}/${e.post_id}` : null;
    const theirs = e.reblog_id && e.from_name ? `https://www.tumblr.com/${e.from_name}/${e.reblog_id}` : null;
    const openState = ['new', 'later', 'old'].includes(e.state);
    const set = async state => {
      const prev = await call('setFansEvents', { ids: [e.id], state, until: state === 'later' ? tomorrow() : null });
      this.last = { prev };
      this.render(this.root);
    };
    const key = e.from_uuid || (e.from_name ? 'name:' + e.from_name.toLowerCase() : null);
    return h('div', { class: 'fan-row' + (key && key === this.sel ? ' on' : '') },
      h('div', { class: 'grow' },
        h('div', { class: 'fan-head' },
          key ? this.nameBtn(key, e.from_name, e.star) : h('b', {}, t('fnAnonymous')),
          h('span', { class: 'badge' + (['reply', 'mention', 'ask'].includes(e.kind) ? ' accent' : '') }, t('fk_' + e.kind)),
          !openState && e.state !== 'digest' ? h('span', { class: 'badge' }, t('fs2_' + e.state)) : null,
          e.replied ? h('span', { class: 'badge st-published' }, t('fnRepliedBadge')) : null,
          e.send ? h('span', { class: 'badge ' + (e.send.status === 'confirmed' ? 'st-published' : ['failed', 'unknown'].includes(e.send.status) ? 'warn' : ''), title: t('rsHint') }, t('rs_' + e.send.status)) : null,
          h('span', { class: 'muted small' }, ago(e.at))),
        e.text ? h('div', { class: 'fan-text' }, e.text) : null,
        e.tags?.length ? h('div', { class: 'fan-tags' }, h('span', { class: 'muted small' }, t('fnTheirTags')), e.tags.map(x => h('span', { class: 'mini-chip' }, '#' + x))) : null,
        h('div', { class: 'muted small' }, blogName(e.blog), e.summary ? ' · ' + e.summary : '')),
      h('div', { class: 'fan-actions' },
        openState ? h('button', { onclick: () => set('done') }, t('fnDone')) : h('button', { class: 'ghost', onclick: () => set('new') }, t('fnReopen')),
        openState ? h('button', { class: 'ghost', onclick: () => set('skip') }, t('fnNoReply')) : null,
        openState ? h('button', { class: 'ghost', onclick: () => set('later') }, t('fnTomorrow')) : null,
        ['reply', 'mention', 'ask', 'reblog'].includes(e.kind) ? h('button', { class: e.kind === 'reply' ? '' : 'ghost', onclick: () => this.openThread(e.id) }, e.kind === 'reply' ? t('fnReplyBtn') : t('fnContext')) : null,
        theirs || post ? h('button', { class: 'ghost', onclick: () => { call('fansHandoff', { id: e.id }).catch(() => {}); window.open(theirs || post, '_blank'); } }, t('openOnTumblr')) : null,
        !e.replied && ['reply', 'mention', 'ask', 'reblog'].includes(e.kind) ? h('button', { class: 'ghost', title: t('fnRepliedHint'), onclick: async () => { await call('markReplied', { id: e.id }); this.render(this.root); } }, t('fnReplied')) : null));
  },

  nameBtn(key, name, star) {
    return h('button', { class: 'linkish', onclick: () => { this.sel = key; this.render(this.root); } }, (star ? '★ ' : ''), name || key);
  },

  // ---------- Interactions ----------
  async eventsView() {
    const f = this.ev;
    const r = await call('fansEvents', { kind: f.kind || null, state: f.state || null, blog: f.blog || null, q: f.q, limit: f.limit });
    const blogs = App.status?.blogs || [];
    const go = patch => { Object.assign(f, patch, { limit: 50 }); this.render(this.root); };
    const q = h('input', { type: 'search', value: f.q, placeholder: t('fnSearchEvents'), onkeydown: e => { if (e.key === 'Enter' && !e.isComposing) go({ q: e.target.value }); } });
    return [
      h('div', { class: 'form-row wrap' },
        select([{ value: '', label: t('fnAllKinds') }, ...['text', 'reply', 'mention', 'ask', 'reblog', 'reblog_plain', 'like', 'follow'].map(k => ({ value: k, label: t('fk_' + k) }))], f.kind, v => go({ kind: v })),
        select([{ value: '', label: t('fnAllStates') }, ...['open', 'done', 'skip', 'old', 'digest'].map(k => ({ value: k, label: t('fs2_' + k) }))], f.state, v => go({ state: v })),
        select([{ value: '', label: t('fnAllBlogs') }, ...blogs.map(b => ({ value: b.uuid, label: b.name }))], f.blog, v => go({ blog: v })),
        q),
      h('div', { class: 'fan-list' }, h('div', { class: 'fan-label' }, t('fnShown', r.rows.length, r.total)),
        r.rows.length ? r.rows.map(e => this.eventRow(e)) : h('div', { class: 'fan-row muted' }, t('fnNoEvents'))),
      r.rows.length < r.total ? h('button', { class: 'ghost', onclick: () => { f.limit += 50; this.render(this.root); } }, t('loadMore')) : null,
    ];
  },

  // ---------- People ----------
  async peopleView() {
    const f = this.pp;
    const r = await call('fansPeople', { rel: f.rel, q: f.q, label: f.label || null, star: f.star, sort: f.sort, limit: f.limit });
    const go = patch => { Object.assign(f, patch, { limit: 80 }); this.render(this.root); };
    const rels = ['all', 'followers', 'mutual', 'following', 'interacted', 'new', 'regular', 'missing'];
    return [
      h('div', { class: 'chips' }, rels.map(x => h('button', { class: 'chip' + (f.rel === x ? ' on' : ''), onclick: () => go({ rel: x }) }, t('fr_' + x)))),
      h('div', { class: 'form-row wrap' },
        h('input', { type: 'search', value: f.q, placeholder: t('fnSearchPeople'), onkeydown: e => { if (e.key === 'Enter' && !e.isComposing) go({ q: e.target.value }); } }),
        r.labels.length ? select([{ value: '', label: t('fnAllLabels') }, ...r.labels.map(l => ({ value: l, label: l }))], f.label, v => go({ label: v })) : null,
        select([{ value: 'recent', label: t('fnSortRecent') }, { value: 'active', label: t('fnSortActive') }, { value: 'name', label: t('fnSortName') }], f.sort, v => go({ sort: v })),
        toggle(f.star, v => go({ star: v }), t('fnStarredOnly'))),
      f.rel === 'regular' ? h('p', { class: 'muted small' }, t('fnRegularDef')) : f.rel === 'mutual' ? h('p', { class: 'muted small' }, t('fnMutualDef')) : null,
      h('div', { class: 'fan-list' }, h('div', { class: 'fan-label' }, t('fnPeopleN', r.total)),
        r.rows.length ? r.rows.map(p => h('div', { class: 'fan-row clickable' + (p.key === this.sel ? ' on' : ''), onclick: () => { this.sel = p.key; this.render(this.root); } },
          h('div', { class: 'grow' },
            h('div', { class: 'fan-head' }, h('b', {}, (p.star ? '★ ' : '') + (p.alias || p.name || '?')), p.alias ? h('span', { class: 'muted small' }, '@' + p.name) : null,
              p.mutual ? h('span', { class: 'badge accent' }, t('fnMutual')) : null,
              p.labels.map(l => h('span', { class: 'mini-chip' }, l))),
            h('div', { class: 'muted small' }, this.relLine(p)),
            p.note ? h('div', { class: 'small fan-note' }, p.note.slice(0, 140)) : null),
          h('div', { class: 'muted small' }, p.last ? t('fnLastSeenAgo', ago(p.last)) : ''))) : h('div', { class: 'fan-row muted' }, t('fnNoPeople'))),
      r.rows.length < r.total ? h('button', { class: 'ghost', onclick: () => { f.limit += 80; this.render(this.root); } }, t('loadMore')) : null,
    ];
  },

  relLine(p) {
    const parts = [];
    if (p.follows.length) parts.push(t('fnFollowsYour', p.follows.map(blogName).join(', ')));
    if (p.missing.length) parts.push(t('fnMissingOn', p.missing.map(blogName).join(', ')));
    if (p.gone.length) parts.push(t('fnGoneFrom', p.gone.map(blogName).join(', ')));
    if (p.iFollow) parts.push(t('fnIFollow'));
    if (!p.follows.length && !p.missing.length && !p.gone.length && !p.iFollow) parts.push(t('fnOnlyInteracted'));
    if (p.n30) parts.push(t('fnN30', p.n30, p.days30));
    return parts.join(' · ');
  },

  // ---------- person panel ----------
  async renderSide() {
    const side = this.side;
    if (!side) return;
    if (!this.sel) { side.replaceChildren(h('p', { class: 'muted small' }, t('fnPickPerson'))); return; }
    const p = await call('fansPerson', { key: this.sel });
    if (!p) { side.replaceChildren(h('p', { class: 'muted small' }, t('fnNoPerson'))); return; }
    const save = async (patch, msg) => {
      try {
        const r = await call('savePerson', { key: p.key, patch });
        this.sel = r.key; toast(msg || t('fnSaved')); this.render(this.root);
      } catch {}
    };
    const alias = h('input', { type: 'text', value: p.alias || '', placeholder: t('fnAliasPh'), maxlength: 60 });
    const labels = h('input', { type: 'text', value: (p.labels || []).join(', '), placeholder: t('fnLabelsPh') });
    const note = h('textarea', { rows: 4, maxlength: 4000, placeholder: t('fnNotePh') }, p.note || '');
    const remText = h('input', { type: 'text', placeholder: t('fnRemindPh'), maxlength: 300 });
    const remDate = h('input', { type: 'date', value: isoDay(tomorrow()) });
    const url = p.name ? `https://www.tumblr.com/${p.name}` : null;
    const prot = p.protection;
    side.replaceChildren(
      h('div', { class: 'fan-side-head' },
        h('div', { class: 'grow' }, h('h2', {}, p.alias || p.name || '?'), h('div', { class: 'muted small' }, '@' + (p.name || '?'), p.oldNames?.length ? ' · ' + t('fnFormerly', p.oldNames.join(', ')) : '')),
        h('button', { class: p.star ? 'primary' : '', title: t('fnStarHint'), onclick: () => save({ star: !p.star }) }, p.star ? '★ ' + t('fnStarred') : '☆ ' + t('fnStar'))),
      !p.uuid ? h('p', { class: 'muted small' }, t('fnNameOnly')) : null,
      h('section', {}, h('h3', {}, t('fnRelation')),
        p.relations.length ? p.relations.map(r => h('div', { class: 'small' }, blogName(r.blog), ': ', t('frs_' + r.state),
          r.state === 'following' ? (r.baseline ? ' · ' + t('fnBeforeStart') : r.firstSeen ? ' · ' + t('fnSince', fmtDate(r.firstSeen)) : '') : '',
          r.state === 'gone' ? ' · ' + t('fnBetween', fmtDate(r.lastSeen), fmtDate(r.goneAt)) : '',
          r.note ? h('span', { class: 'muted' }, ' · ' + r.note) : null)) : h('div', { class: 'small muted' }, t('fnNotAFollower')),
        h('div', { class: 'small' }, p.followingAt ? (p.iFollow ? t('fnIFollowMain') : t('fnINotFollow')) : t('fnFollowingUnknown'), p.mutual ? ' · ' + t('fnMutual') : ''),
        p.followingAt ? h('div', { class: 'muted small' }, t('fnCheckedAt', ago(p.followingAt))) : null),
      h('section', {}, h('h3', {}, t('fnAboutThem')),
        h('label', { class: 'small muted' }, t('fnAlias')), alias,
        h('label', { class: 'small muted' }, t('fnLabels')), labels,
        h('label', { class: 'small muted' }, t('fnNote')), note,
        h('div', { class: 'form-row' },
          h('button', { class: 'primary', onclick: () => save({ alias: alias.value, labels: labels.value.split(/[,，]/), note: note.value }) }, t('save')),
          h('span', { class: 'muted small' }, t('fnLocalOnly')))),
      h('section', {}, h('h3', {}, t('fnPromises')),
        (p.reminders || []).filter(r => r.status === 'open').map(r => h('div', { class: 'fan-mini' },
          h('span', { class: 'grow small' }, r.text, h('span', { class: 'muted' }, r.due ? ' · ' + fmtDate(r.due) : '')),
          h('button', { class: 'ghost', onclick: async () => { await call('setReminder', { id: r.id, status: 'done' }); this.render(this.root); } }, t('fnDone')))),
        remText,
        h('div', { class: 'form-row' }, remDate,
          h('button', { onclick: async () => {
            if (!remText.value.trim()) return;
            try {
              const r = await call('addReminder', { key: p.key, text: remText.value, due: remDate.value ? new Date(remDate.value + 'T09:00').getTime() : null });
              this.sel = r.key; toast(t('fnReminderAdded')); this.render(this.root);
            } catch {}
          } }, t('fnAddReminder')))),
      h('section', {}, h('h3', {}, t('fnHistory')),
        p.events.length ? h('ul', { class: 'fan-timeline' }, p.events.slice(0, 25).map(e => h('li', { class: 'small' },
          h('span', { class: 'muted' }, fmtDate(e.at), ' · ', t('fk_' + e.kind), ' · ', blogName(e.blog)),
          e.text ? h('div', {}, e.text.slice(0, 200)) : null,
          e.tags?.length ? h('div', { class: 'muted' }, e.tags.map(x => '#' + x).join(' ')) : null))) : h('p', { class: 'muted small' }, t('fnNoHistory')),
        h('p', { class: 'muted small' }, t('fnHistoryNote'))),
      prot && (prot.case || prot.allowed || prot.blocks.length) ? h('section', {}, h('h3', {}, t('fnTab_protect')),
        prot.allowed ? h('div', { class: 'small' }, t('fgTab_allowed')) : null,
        prot.case ? h('div', { class: 'small' }, t('fs_' + prot.case.status)) : null,
        prot.blocks.map(b => h('div', { class: 'small' }, blogName(b.blog), ': ', t('fnBlock_' + b.status), ' · ', b.origin === 'app' ? t('fgByApp') : t('fgExternal'))),
        h('button', { class: 'ghost', onclick: () => { this.tab = 'protect'; this.render(this.root); } }, t('fnOpenProtect'))) : null,
      url ? h('div', { class: 'form-row' }, h('button', { class: 'ghost', onclick: () => window.open(url, '_blank') }, t('openOnTumblr'))) : null);
  },

  // ---------- Changes & stats ----------
  async changesView() {
    const s = await call('fansStats', { days: this.days });
    const cnt = s.counts.map(c => h('tr', {},
      h('td', {}, c.name),
      h('td', { class: 'num' }, c.now ?? '—'),
      h('td', { class: 'num' }, c.comparable && c.now != null ? fmtDelta(c.now - c.from) : h('span', { class: 'muted small' }, t('fnNotComparable'))),
      h('td', { class: 'muted small' }, c.comparable ? t('fnSinceObs', fmtDate(c.fromAt)) : c.fromAt ? t('fnFirstObs', fmtDate(c.fromAt)) : '')));
    const changes = s.changes.map(c => h('div', { class: 'fan-row' },
      h('div', { class: 'grow' }, h('div', { class: 'fan-head' }, this.nameBtnTo(c), h('span', { class: 'badge' + (c.kind === 'unfollow' ? ' warn' : ' accent') }, t('fc_' + c.kind)), h('span', { class: 'muted small' }, blogName(c.blog))),
        h('div', { class: 'muted small' }, c.kind === 'unfollow' ? t('fnBetween', fmtDate(c.since), fmtDate(c.at)) : fmtTime(c.at), c.note === 'blocked' ? ' · ' + t('fnBlockedByYou') : ''))));
    const tile = (n, label, cls = '') => h('div', { class: 'stat ' + cls }, h('b', {}, n), h('span', {}, label));
    return h('div', { class: 'fans-stats' },
      h('div', { class: 'seg' }, [7, 30].map(d => h('button', { class: this.days === d ? 'on' : '', onclick: () => { this.days = d; this.render(this.root); } }, t('fnDays', d)))),
      h('div', { class: 'fans-tiles' },
        tile(s.interactions.people, t('fnPeopleInteracted')),
        tile(s.interactions.repeat, t('fnRepeat')),
        tile(s.changes.filter(c => c.kind === 'follow').length, t('fnNewFollows'), 'accent'),
        tile(s.changes.filter(c => c.kind === 'unfollow').length, t('fnUnfollows')),
        tile(s.missing.length, t('fnPendingCheck'), s.missing.length ? 'warn' : '')),
      s.interactions.unresolved ? h('p', { class: 'muted small' }, t('fnUnresolved', s.interactions.unresolved)) : null,
      h('section', { class: 'card' }, h('h2', {}, t('fnCounts')),
        h('table', { class: 'table' }, h('tbody', {}, cnt)),
        h('p', { class: 'muted small' }, t('fnCountsNote'))),
      h('section', { class: 'card' }, h('h2', {}, t('fnRelChanges')),
        changes.length ? h('div', { class: 'fan-list flat' }, changes) : h('p', { class: 'muted small' }, t('fnNoChanges')),
        s.missing.length ? h('details', { class: 'small' }, h('summary', {}, t('fnMissingList', s.missing.length)),
          h('ul', {}, s.missing.map(m => h('li', {}, m.name, ' · ', blogName(m.blog), ' · ', t('fnLastSeen', fmtDate(m.last_seen)), m.check_note ? ' · ' + m.check_note : '')))) : null,
        h('p', { class: 'muted small' }, t('fnChangesNote'))),
      h('section', { class: 'card' }, h('h2', {}, t('fnWhatSparked')),
        s.posts.length ? h('table', { class: 'table' }, h('tbody', {}, s.posts.map(p => h('tr', {},
          h('td', {}, h('div', {}, p.title || ('#' + p.post_id)), p.tags.length ? h('div', { class: 'muted small' }, p.tags.map(x => '#' + x).join(' ')) : null),
          h('td', { class: 'num' }, t('fnPeopleN', p.people)),
          h('td', { class: 'muted small' }, t('fnPostMix', p.replies, p.reblogs, p.said, p.likes)))))) : h('p', { class: 'muted small' }, t('fnNoEvents')),
        h('p', { class: 'muted small' }, t('fnPostsNote'))),
      h('p', { class: 'muted small' }, s.coverage.map(c => blogName(c.blog) + ': ' + (c.notif?.at ? t('fnCovered', fmtDate(c.notif.coveredFrom), ago(c.notif.at)) : t('fnNotYet'))).join(' · ')));
  },
  nameBtnTo(c) {
    const key = c.uuid || 'name:' + String(c.name || '').toLowerCase();
    return h('button', { class: 'linkish', onclick: () => { this.sel = key; this.tab = 'people'; this.render(this.root); } }, c.name || '?');
  },

  refresh(ev) {
    if (ev.type === 'job' && this.thread) this.paintOps();
    if (ev.type === 'pass' && this.tab !== 'people') this.render(this.root);
  },

  // ---------- one interaction: post, discussion, person, reply (FUNCTIONAL_WORKFLOWS_SPEC 4) ----------
  // A panel over the list, so the list, its filters and scroll stay as they are; the unsent text is saved in the
  // app (it survives closing this, a refresh and a trip to Tumblr). A send is an operation with its own id: a
  // double click or a repeat after a lost answer finds the same one.
  async openThread(id) {
    this.thread = { id, op: null };
    let pane = document.querySelector('.detail-pane');
    if (!pane) { pane = h('aside', { class: 'detail-pane thread-pane', role: 'dialog', 'aria-label': t('fnThread'), tabindex: -1 }); document.body.append(pane); }
    pane.replaceChildren(h('div', { class: 'page-loading' }));
    let th;
    try { th = await call('fansThread', { id }); }
    catch (e) { pane.replaceChildren(h('header', {}, h('h2', { class: 'grow' }, t('fnThread')), this.closeBtn()), h('div', { class: 'detail-body' }, h('p', { class: 'warn-text' }, cleanErr(e)))); return; }
    if (this.thread?.id !== id) return;
    this.th = th;
    const e = th.event;
    const who = e.from_name || t('fnAnonymous');
    const body = h('div', { class: 'detail-body' });
    pane.replaceChildren(h('header', {}, h('h2', { class: 'grow' }, th.canReply ? t('fnReplyTo', who) : t('fnThread')), this.closeBtn()), body);
    const mineName = n => th.identities.some(b => b.name.toLowerCase() === String(n || '').toLowerCase());
    const replyRow = (r, depth = 0) => [h('div', { class: 'reply-row' + (mineName(r.name) ? ' mine' : '') + (r.name === e.from_name && r.text.trim() === String(e.text || '').trim() ? ' this' : ''), style: { marginLeft: depth * 16 + 'px' } },
      h('div', { class: 'fan-head' }, h('b', {}, r.name || '?'), h('span', { class: 'muted small' }, fmtTime(r.at))), h('div', { class: 'fan-text' }, r.text)),
      ...(r.children || []).flatMap(c => replyRow(c, depth + 1))];
    const p = th.post;
    body.append(
      // the interaction itself
      h('section', { class: 'thread-sec' },
        h('div', { class: 'fan-head' }, h('b', {}, who), h('span', { class: 'badge accent' }, t('fk_' + e.kind)), h('span', { class: 'muted small' }, fmtTime(e.at)), h('span', { class: 'muted small' }, '→ ' + blogName(e.blog))),
        e.text ? h('div', { class: 'fan-text' }, e.text) : null,
        e.tags?.length ? h('div', { class: 'fan-tags' }, e.tags.map(x => h('span', { class: 'mini-chip' }, '#' + x))) : null),
      // the post it is about
      p ? h('section', { class: 'thread-sec thread-post' },
        h('h3', {}, t('fnThePost')),
        h('div', { class: 'form-row' }, p.thumb ? h('img', { src: p.thumb, class: 'thread-thumb', alt: '' }) : null,
          h('div', { class: 'grow' }, h('div', {}, (p.summary || e.summary || '').slice(0, 300) || h('span', { class: 'muted' }, t('fnNoSummary'))),
            h('div', { class: 'muted small' }, (p.blog_name || blogName(p.blog)), p.state ? [' · ', stateBadge(p.state)] : null, p.published_at ? ' · ' + fmtDate(p.published_at) : '')))) : null,
      // the discussion under it
      th.canReply ? h('section', { class: 'thread-sec' },
        h('h3', {}, t('fnDiscussion')),
        th.replies ? [h('div', { class: 'reply-list' }, th.replies.list.length ? th.replies.list.flatMap(r => replyRow(r)) : h('p', { class: 'muted small' }, t('fnNoReplies'))),
          h('p', { class: 'muted small' }, t('fnRepliesFrom_' + th.replies.source))]
          : h('p', { class: 'warn-text small' }, t('fnRepliesFailed', th.repliesError || '')),
        th.seenMine.length ? h('p', { class: 'small' }, '✓ ', t('fnSeenMine', th.seenMine.length)) : null) : null,
      // who it is
      th.person ? h('section', { class: 'thread-sec' },
        h('h3', {}, t('fnWho')),
        h('div', { class: 'fan-head' }, h('b', {}, (th.person.star ? '★ ' : '') + (th.person.alias || th.person.name || who)), th.person.alias ? h('span', { class: 'muted small' }, '@' + th.person.name) : null,
          th.person.mutual ? h('span', { class: 'badge accent' }, t('fnMutual')) : null, (th.person.labels || []).map(l => h('span', { class: 'mini-chip' }, l))),
        th.person.note ? h('p', { class: 'small' }, th.person.note) : null,
        h('p', { class: 'muted small' }, (th.person.follows || []).length ? t('fnFollowsYour', th.person.follows.map(blogName).join(', ')) : t('fnOnlyInteracted'), th.person.last ? ' · ' + t('fnLastSeenAgo', ago(th.person.last)) : ''),
        (th.person.events || []).filter(x => x.id !== e.id && x.text).slice(0, 3).map(x => h('p', { class: 'muted small' }, fmtDate(x.at), ' · ', t('fk_' + x.kind), ': ', x.text.slice(0, 120))),
        h('button', { class: 'ghost small', onclick: () => { this.sel = th.person.key; this.closeThread(); this.render(this.root); } }, t('fnOpenPerson'))) : null,
      th.canReply ? this.composer(th) : h('section', { class: 'thread-sec' }, h('p', { class: 'muted small' }, t('fnAnswerWhere_' + e.kind))),
      h('section', { class: 'thread-sec', id: 'threadOps' }),
      this.threadActions(th));
    this.paintOps(th.ops);
    pane.focus({ preventScroll: true });
  },
  // the composer replaces these while a reply can be written
  async flushDraft() {},
  flush() { clearTimeout(this.draftT); this.flushDraft(); this.thread = null; },
  closeBtn() { return h('button', { class: 'ghost icon', title: t('close'), 'aria-label': t('close'), onclick: () => this.closeThread() }, '✕'); },
  closeThread() { clearTimeout(this.draftT); this.flushDraft(); this.thread = null; document.querySelector('.detail-pane')?.remove(); },

  composer(th) {
    const e = th.event;
    let as = th.draft?.reply_as || th.defaultAs;
    const ta = h('textarea', { class: 'reply-text', rows: 4, maxlength: 4096, placeholder: t('fnReplyPh', e.from_name || '') });
    ta.value = th.draft?.text || '';
    const count = h('span', { class: 'muted small' });
    const saved = h('span', { class: 'muted small' });
    const upd = () => { count.textContent = ta.value.length ? t('fnChars', ta.value.length) : ''; };
    upd();
    this.flushDraft = async () => {
      if (!this.thread || this.thread.id !== e.id || !this.dirty) return;
      this.dirty = false;
      try { await call('fansReplyDraft', { id: e.id, text: ta.value, reply_as: as }); saved.textContent = t('fnDraftSaved'); } catch { saved.textContent = t('fnDraftNotSaved'); }
    };
    ta.addEventListener('input', () => { upd(); this.dirty = true; saved.textContent = ''; clearTimeout(this.draftT); this.draftT = setTimeout(() => this.flushDraft(), 600); });
    const send = h('button', { class: 'primary' }, t('fnSend'));
    send.onclick = async () => {
      const text = ta.value;
      if (!text.trim()) return;
      send.disabled = true;
      // one operation id per text: a second click, or a retry after the app didn't answer, is the same send
      const key = as + '\n' + text;
      if (!this.thread.op || this.thread.opKey !== key) this.thread.op = 'op-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
      this.thread.opKey = key;
      try {
        await call('fansReply', { id: e.id, text, reply_as: as, op: this.thread.op });
        this.thread.op = null; this.dirty = false;
        toast(th.channel.connected ? t('fnSending') : t('fnWillWait'), 'ok', 6000);
        this.openThread(e.id);
      } catch (err) { send.disabled = false; toast(cleanErr(err), 'error', 6000); }
    };
    const ch = th.channel;
    return h('section', { class: 'thread-sec composer' },
      h('h3', {}, t('fnYourReply')),
      h('div', { class: 'form-row wrap' }, h('span', { class: 'small' }, t('fnReplyAs')),
        select(th.identities.map(b => ({ value: b.uuid, label: b.name + (b.primary ? ' (main)' : '') })), as, v => { as = v; this.dirty = true; this.flushDraft(); }),
        h('span', { class: 'muted small' }, t('fnUnder', th.post?.blog_name || blogName(e.blog)))),
      ta,
      h('div', { class: 'form-row wrap' }, send, count, saved),
      h('p', { class: 'small ' + (ch.connected ? 'muted' : 'warn-text') }, ch.connected ? t('fnChannelOn') : ch.enabled ? t('fnChannelOff') : t('fnChannelDisabled')),
      h('p', { class: 'muted small' }, ch.capability === 'pass' ? t('fnChannelVerified') : t('fnChannelUnverified')));
  },

  // The sends of this interaction, each with its own state; refreshed while the panel is open
  async paintOps(ops) {
    const box = document.getElementById('threadOps');
    if (!box || !this.thread) return;
    if (!ops) { try { ops = await call('fansReplyOps', { id: this.thread.id }); } catch { return; } }
    if (!this.thread) return;
    box.replaceChildren(...(ops.length ? [h('h3', {}, t('fnSends')), ...ops.map(o => h('div', { class: 'reply-op st-' + o.status },
      h('div', { class: 'fan-head' }, h('span', { class: 'badge ' + (o.status === 'confirmed' ? 'st-published' : ['failed', 'unknown'].includes(o.status) ? 'warn' : '') }, t('rs_' + o.status)),
        h('span', { class: 'muted small' }, t('fnAsBlog', blogName(o.reply_as)), ' · ', fmtTime(o.confirmed_at || o.sent_at || o.created_at))),
      h('div', { class: 'fan-text' }, o.text),
      o.error && o.status !== 'confirmed' ? h('div', { class: 'muted small' }, o.error) : null,
      h('div', { class: 'muted small' }, t('rsLong_' + o.status)),
      h('div', { class: 'form-row wrap' },
        ['unknown', 'waiting', 'checking'].includes(o.status) ? h('button', { class: 'ghost small', onclick: async () => { await call('fansReplyCheck', { op: o.op }); toast(t('fnChecking')); } }, t('fnCheckNow')) : null,
        o.status === 'unknown' ? h('button', { class: 'ghost small', onclick: async () => {
          const ok = await modal(t('fnNotSent'), h('p', {}, t('fnNotSentQ')), [{ label: t('cancel'), value: false }, { label: t('fnNotSent'), value: true, class: 'danger' }]);
          if (ok) { await call('fansReplyNotSent', { op: o.op }); this.openThread(this.thread.id); }
        } }, t('fnNotSent')) : null,
        ['queued', 'waiting'].includes(o.status) ? h('button', { class: 'ghost small', onclick: async () => { if (await call('fansReplyCancel', { op: o.op })) this.openThread(this.thread.id); } }, t('fnWithdraw')) : null)))] : []));
  },

  // Local states, the self-report and the hand-off, each kept apart from machine-checked sends
  threadActions(th) {
    const e = th.event;
    const openState = ['new', 'later', 'old'].includes(e.state);
    const set = async state => { await call('setFansEvents', { ids: [e.id], state, until: state === 'later' ? tomorrow() : null }); this.render(this.root); this.openThread(e.id); };
    return h('section', { class: 'thread-sec' },
      h('h3', {}, t('fnHandle')),
      h('div', { class: 'form-row wrap' },
        openState ? h('button', { onclick: () => set('done') }, t('fnDone')) : h('button', { class: 'ghost', onclick: () => set('new') }, t('fnReopen')),
        openState ? h('button', { class: 'ghost', onclick: () => set('skip') }, t('fnNoReply')) : null,
        openState ? h('button', { class: 'ghost', onclick: () => set('later') }, t('fnTomorrow')) : null,
        e.replied ? h('span', { class: 'badge st-published' }, t('fnRepliedBadge'))
          : h('button', { class: 'ghost', title: t('fnRepliedHint'), onclick: async () => { await call('markReplied', { id: e.id }); this.render(this.root); this.openThread(e.id); } }, t('fnReplied'))),
      th.handoff.url ? h('div', { class: 'form-row wrap' },
        h('button', { class: 'ghost', onclick: async () => { await this.flushDraft(); await call('fansHandoff', { id: e.id }); window.open(th.handoff.url, '_blank'); this.openThread(e.id); } }, t('openOnTumblr')),
        h('span', { class: 'muted small' }, th.handoff.at ? t('fnHandedOff', fmtTime(th.handoff.at)) : t('fnHandoffNote'))) : null,
      h('p', { class: 'muted small' }, t('fnThreadNote')));
  },
};

const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); };
const isoDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDelta = n => (n > 0 ? '+' + n : String(n));
