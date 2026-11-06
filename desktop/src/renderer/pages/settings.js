'use strict';

const SettingsPage = {
  async render(root) {
    this.root = root;
    const s = await App.loadStatus();
    const card = (title, ...body) => h('section', { class: 'card' }, h('h2', {}, title), ...body);
    let key = '', secret = '';

    const conn = card(t('connTitle'),
      h('p', { class: 'status-line' }, h('span', { class: 'conn ' + s.auth }, '● ', t('connStatus_' + s.auth)), s.account?.name ? h('span', { class: 'muted' }, ' · ' + t('account') + ': ' + s.account.name) : null),
      s.auth === 'connected' ? null : h('p', { class: 'muted' }, t('appKeyHint', 'http://localhost:8765/callback')),
      ['no_app', 'not_connected', 'reconnect'].includes(s.auth) ? h('div', { class: 'form-row' },
        h('input', { placeholder: t('consumerKey'), oninput: e => { key = e.target.value; }, autocomplete: 'off', spellcheck: 'false' }),
        h('input', { placeholder: t('consumerSecret'), type: 'password', oninput: e => { secret = e.target.value; }, autocomplete: 'off' }),
        h('button', { onclick: async () => { await call('setApp', { clientId: key, clientSecret: secret }); toast('✓'); this.render(root); } }, t('saveKey'))) : null,
      h('div', { class: 'actions' },
        s.auth !== 'no_app' && s.auth !== 'connected' ? h('button', { class: 'primary', onclick: async e => { e.target.disabled = true; try { await call('connect'); toast(t('connStatus_connected'), 'ok'); } finally { this.render(root); } } }, t('connect')) : null,
        s.auth !== 'connected' ? h('button', { onclick: async e => { e.target.disabled = true; try { await call('importStage0'); toast(t('connStatus_connected'), 'ok'); } finally { this.render(root); } } }, t('importStage0')) : null,
        s.auth !== 'no_app' ? h('button', { class: 'ghost danger', onclick: async () => { const ok = await modal(t('disconnect'), h('p', {}, t('disconnect') + '?'), [{ label: t('cancel'), value: false }, { label: t('disconnect'), value: true, class: 'danger' }]); if (ok) { await call('disconnect'); this.render(root); } } }, t('disconnect')) : null),
      s.budget?.perHour ? h('p', { class: 'muted small' }, t('budget', s.budget.hour, s.budget.perHour, s.budget.day, s.budget.perDay)) : null,
      h('h3', {}, t('labelsTitle')),
      h('p', { class: 'muted' }, t('labelsHint')),
      chips([{ value: 'unverified', label: t('labelsUnverified') }, { value: 'not_used', label: t('labelsNotUsed') }, { value: 'pass', label: t('labelsPass') }],
        s.capabilities['edit.labels'] || 'unverified', async v => { await call('setCapability', { key: 'edit.labels', status: v }); this.render(root); }),
    );

    const roles = card(t('rolesTitle'), h('p', { class: 'muted' }, t('rolesHint')),
      h('table', { class: 'table' }, h('tbody', {}, s.blogs.map(b => h('tr', {},
        h('td', { class: 'blogcell' }, b.avatar ? h('img', { src: b.avatar, class: 'avatar' }) : null, h('b', {}, b.name), b.is_primary ? h('span', { class: 'badge' }, 'main') : null),
        h('td', {}, b.title || ''),
        h('td', { class: 'right' }, b.is_primary ? t('role_share')
          : select(['share', 'material', ''].map(r => ({ value: r, label: t('role_' + (r || 'null')) })), b.role || '', async v => { await call('setRole', { blog: b.uuid, role: v || null }); toast('✓'); })))))));

    const auto = card(t('automationTitle'),
      toggle(!!s.paused, async v => { await call('setPaused', v); window.studio.trayRefresh(); this.render(root); }, t('pauseAll')),
      h('div', { class: 'actions' },
        h('button', { onclick: async () => { await call('syncNow', {}); toast(t('syncNow') + ' ✓'); } }, t('syncNow')),
        h('button', { onclick: async () => { await call('syncNow', { full: true }); toast(t('fullSync') + ' ✓'); } }, t('fullSync'))));

    let langPref = '';
    try { langPref = localStorage.getItem('lang') || ''; } catch {}
    const lang = card(t('language'), select([{ value: '', label: t('langAuto') }, { value: 'zh', label: '中文' }, { value: 'en', label: 'English' }], langPref, v => {
      try { localStorage.setItem('lang', v); } catch {}
      setLang(v); applyI18n(); this.render(root);
    }));

    const data = this.dataCard ? this.dataCard(card) : null;
    root.replaceChildren(h('header', { class: 'page-head' }, h('h1', {}, t('settingsTitle'))), h('div', { class: 'grid2' }, conn, roles, auto, data, lang));
  },
};

// Data: import from the extension, backups, AI provider
SettingsPage.dataCard = function (card) {
  const box = card(t('dataTitle'), h('p', { class: 'muted' }, t('importHint')));
  const ai = card(t('aiTitle'), h('p', { class: 'muted' }, t('aiHint')));
  (async () => {
    const [backups, st] = await Promise.all([call('backups'), call('aiStatus')]);
    box.append(
      h('div', { class: 'actions' },
        h('button', { onclick: () => this.importFile() }, t('importExt')),
        h('button', { onclick: async () => { const r = await call('backupNow'); toast(t('backupDone', r.files), 'ok'); this.render(this.root); } }, t('backupNow')),
        h('button', { class: 'ghost', onclick: () => call('openBackupFolder') }, t('openFolder'))),
      backups.length ? h('table', { class: 'table' }, h('tbody', {}, backups.slice(0, 5).map(b => h('tr', {}, h('td', { class: 'small' }, b.name),
        h('td', { class: 'right' }, h('button', { class: 'ghost', onclick: async () => {
          const ok = await modal(t('restore'), h('p', {}, t('restoreQ')), [{ label: t('cancel'), value: false }, { label: t('restoreBackup'), value: true, class: 'danger' }]);
          if (ok) await call('restoreBackup', { dir: b.dir });
        } }, t('restoreBackup'))))))) : null);
    let base = st.base, model = st.model, key = '';
    ai.append(
      h('label', { class: 'field' }, h('span', {}, t('aiBase')), h('input', { value: base, placeholder: 'https://…/v1', spellcheck: 'false', oninput: e => { base = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, t('aiModel')), h('input', { value: model, spellcheck: 'false', oninput: e => { model = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, t('aiKey')), h('input', { type: 'password', placeholder: st.hasKey ? '••••••••' : '', autocomplete: 'off', oninput: e => { key = e.target.value; } })),
      h('div', { class: 'actions' }, h('button', { onclick: async () => { await call('setAi', { base, model, key }); toast('✓', 'ok'); } }, t('save')),
        st.hasKey ? h('button', { class: 'ghost danger', onclick: async () => { await call('forgetAiKey'); this.render(this.root); } }, t('forgetKey')) : null));
  })();
  return [box, ai];
};

SettingsPage.importFile = function () {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    const text = await f.text();
    const p = await call('importPreview', { text });
    const body = h('div', {},
      h('ul', { class: 'plain' },
        h('li', {}, t('impRoles', p.roles.length)), h('li', {}, t('impPacks', p.packs)), h('li', {}, t('impStats', p.tagStats)),
        p.recent.length ? h('li', {}, t('impRecent', p.recent.map(r => blogName(r.uuid) + ' · ' + r.days).join(', '))) : null,
        p.hidden ? h('li', {}, t('impHidden', p.hidden)) : null,
        p.ai ? h('li', {}, t('impAi')) : null,
        p.unknownBlogs.length ? h('li', { class: 'muted' }, t('impUnknown', p.unknownBlogs.length)) : null),
      h('p', { class: 'muted' }, t('impSafe')),
      p.desktopManaged ? null : h('p', { class: 'banner warn' }, t('impTakeover')));
    const ok = await modal(t('importExt'), body, [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
    if (!ok) return;
    await call('importApply', { text });
    toast('✓', 'ok');
    this.render(this.root);
  };
  input.click();
};
