'use strict';

const SettingsPage = {
  async render(root) {
    this.root = root;
    const s = await App.loadStatus();
    const card = (title, ...body) => h('section', { class: 'card' }, h('h2', {}, title), ...body);
    let key = '', secret = '';
    const si = window.studio.web ? await call('serverInfo').catch(() => null) : null;
    // not connected / not paired: the way to connect sits right under that status, not only in the backend card
    const pairEntry = () => window.studio.web ? h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: () => window.open('/companion/', '_blank', 'noopener') }, t('relayPairBtn')),
      h('span', { class: 'muted small' }, t('relayPairHint', si?.profile || 'Chrome'))) : null;

    const conn = card(t('connTitle'),
      h('div', { class: 'status-line' }, h('span', { class: 'conn ' + s.auth }, '● ', t('connStatus_' + s.auth)), s.account?.name ? h('span', { class: 'muted' }, ' · ' + t('account') + ': ' + s.account.name) : null,
        s.auth === 'connected' ? [h('span', { class: 'grow' }), h('button', { class: 'ghost danger', onclick: async () => { const ok = await modal(t('disconnect'), h('p', {}, t('disconnect') + '?'), [{ label: t('cancel'), value: false }, { label: t('disconnect'), value: true, class: 'danger' }]); if (ok) { await call('disconnect'); this.render(root); } } }, t('disconnect'))] : null),
      s.auth === 'connected' ? null : h('p', { class: 'muted' }, t('appKeyHint', 'http://localhost:8765/callback')),
      ['no_app', 'not_connected', 'reconnect'].includes(s.auth) ? h('div', { class: 'form-row' },
        h('input', { placeholder: t('consumerKey'), oninput: e => { key = e.target.value; }, autocomplete: 'off', spellcheck: 'false' }),
        h('input', { placeholder: t('consumerSecret'), type: 'password', oninput: e => { secret = e.target.value; }, autocomplete: 'off' }),
        h('button', { onclick: async () => { await call('setApp', { clientId: key, clientSecret: secret }); toast('✓'); this.render(root); } }, t('saveKey'))) : null,
      h('div', { class: 'actions' },
        s.auth !== 'no_app' && s.auth !== 'connected' ? h('button', { class: 'primary', onclick: async e => { e.target.disabled = true; try { await call('connect'); toast(t('connStatus_connected'), 'ok'); } finally { this.render(root); } } }, t('connect')) : null,
        s.auth !== 'connected' ? h('button', { onclick: async e => { e.target.disabled = true; try { await call('importStage0'); toast(t('connStatus_connected'), 'ok'); } finally { this.render(root); } } }, t('importStage0')) : null,
        s.auth !== 'no_app' && s.auth !== 'connected' ? h('button', { class: 'ghost danger', onclick: async () => { const ok = await modal(t('disconnect'), h('p', {}, t('disconnect') + '?'), [{ label: t('cancel'), value: false }, { label: t('disconnect'), value: true, class: 'danger' }]); if (ok) { await call('disconnect'); this.render(root); } } }, t('disconnect')) : null),
      s.budget?.perHour ? h('p', { class: 'muted small' }, t('budget', s.budget.hour, s.budget.perHour, s.budget.day, s.budget.perDay)) : null,
      s.relay ? h('div', { class: 'setting-block' },
        h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: s.settings.browserRelay !== false, onchange: async e => { await call('setSettings', { browserRelay: e.target.checked }); this.render(root); } }), t('relayUse')),
        h('p', { class: 'muted small' }, t('relayHint')),
        s.settings.browserRelay !== false ? h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: s.settings.relaySave === true, onchange: async e => { await call('setSettings', { relaySave: e.target.checked }); this.render(root); } }), t('relaySave')) : null,
        s.settings.browserRelay !== false ? h('p', { class: 'muted small' }, t('relaySaveHint')) : null,
        s.settings.browserRelay !== false ? h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: s.settings.relayDelete !== false, onchange: async e => { await call('setSettings', { relayDelete: e.target.checked }); this.render(root); } }), t('relayDelete')) : null,
        s.settings.browserRelay !== false ? h('p', { class: 'muted small' }, t('relayDeleteHint')) : null,
        s.settings.browserRelay !== false ? h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: s.settings.relayCreate !== false, onchange: async e => { await call('setSettings', { relayCreate: e.target.checked }); this.render(root); } }), t('relayCreate')) : null,
        s.settings.browserRelay !== false ? h('p', { class: 'muted small' }, t('relayCreateHint')) : null,
        s.settings.browserRelay !== false ? h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: s.settings.relayUpload !== false, onchange: async e => { await call('setSettings', { relayUpload: e.target.checked }); this.render(root); } }), t('relayUpload')) : null,
        s.settings.browserRelay !== false ? h('p', { class: 'muted small' }, t('relayUploadHint')) : null,
        s.relay.enabled ? h('p', { class: 'muted small' }, s.relay.coolWhy ? t('relayCool_' + (['signed_out', 'other_account', 'limited'].includes(s.relay.coolWhy) ? s.relay.coolWhy : 'other'))
          : s.relay.connected ? t('relayOn', s.relay.hour) : t(s.settings.relaySave === true ? 'relayOffWait' : 'relayOff'))
          : s.settings.browserRelay !== false ? h('p', { class: 'muted small' }, t('relayUnpaired')) : null,
        s.settings.browserRelay !== false && !(s.relay.enabled && s.relay.connected && !s.relay.coolWhy) ? pairEntry() : null) : null,
    );

    const roles = card(t('rolesTitle'), h('p', { class: 'muted' }, t('rolesHint')),
      h('table', { class: 'table' }, h('tbody', {}, s.blogs.map(b => h('tr', {},
        h('td', {}, h('div', { class: 'blogcell' }, b.avatar ? h('img', { src: b.avatar, class: 'avatar' }) : null, h('b', {}, b.name), b.is_primary ? h('span', { class: 'badge' }, 'main') : null)),
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
    // the local web backend: what is running, start with Windows, stop (closing pages never stops it)
    let backend = null;
    if (si) {
      backend = card(t('svcTitle'),
        h('p', { class: 'muted small' }, t('svcInfo', si.test ? t('svcTest') : t('svcWork'), si.port, si.profile, si.version)),
        h('p', { class: 'muted small' }, t('svcHint')),
        h('p', { class: 'muted small' }, t('svcCompanionHint'), ' ', h('a', { href: '/companion/', target: '_blank', rel: 'noopener' }, t('svcCompanion'))),
        si.autostart != null ? toggle(si.autostart, async v => { try { await call('setAutostart', v); } finally { this.render(root); } }, t('svcAutostart')) : null,
        h('div', { class: 'actions' }, h('button', { class: 'ghost danger', onclick: async () => {
          const ok = await modal(t('svcStop'), h('p', {}, t('svcStopQ')), [{ label: t('cancel'), value: false }, { label: t('svcStop'), value: true, class: 'danger' }]);
          if (ok) await call('stopServer');
        } }, t('svcStop'))));
    }
    root.replaceChildren(h('header', { class: 'page-head' }, h('h1', {}, t('settingsTitle'))), h('div', { class: 'grid2' }, conn, roles, auto, backend, data, lang));
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
  // Problems met in daily use: mark the moment, export one file to hand over (diag.js)
  let note = '';
  const diag = card(t('diagTitle'), h('p', { class: 'muted' }, t('diagHint')),
    h('textarea', { class: 'reply-text', rows: 3, placeholder: t('diagNotePh'), oninput: e => { note = e.target.value; } }),
    h('div', { class: 'actions' },
      h('button', { onclick: async () => { if (!note.trim()) return toast(t('diagNoteEmpty')); await call('diagNote', { note }); toast(t('diagNoted'), 'ok'); } }, t('diagNote')),
      h('button', { class: 'primary', onclick: async e => {
        e.target.disabled = true;
        try { const r = await call('diagExport', { note }); toast(t('diagExported', r.file), 'ok', 12000); out.textContent = r.file; }
        catch (err) { toast(cleanErr(err), 'error'); } finally { e.target.disabled = false; }
      } }, t('diagExport')),
      h('button', { class: 'ghost', onclick: () => call('diagFolder') }, t('openFolder'))));
  const out = h('p', { class: 'muted small', style: { userSelect: 'all' } });
  diag.append(out, h('p', { class: 'muted small' }, t('diagPrivacy')));
  // Moving to another computer: settings only, no keys or sign-in (data.js exportSettings)
  const move = card(t('moveTitle'), h('p', { class: 'muted' }, t('moveHint')),
    h('div', { class: 'actions' },
      h('button', { onclick: async () => {
        const exp = await call('settingsExport');
        const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' })),
          download: 'tumblr-studio-settings-' + exp.exported.slice(0, 10) + '.json' });
        document.body.append(a); a.click(); a.remove();
        toast(t('moveExported'), 'ok', 8000);
      } }, t('moveExport')),
      h('button', { onclick: () => this.importFile() }, t('moveImport'))));
  return [box, ai, diag, move];
};

SettingsPage.importSettings = async function (text) {
    let p;
    try { p = await call('settingsPreview', { text }); } catch (err) { return toast(cleanErr(err), 'error'); }
    if (p.otherAccount) return toast(t('moveOtherAccount', p.account, p.here), 'error', 10000);
    const body = h('div', {},
      h('p', { class: 'muted small' }, t('moveFrom', p.account || '?', (p.exported || '').slice(0, 16).replace('T', ' '))),
      h('ul', { class: 'plain' },
        h('li', {}, t('impRoles', p.roles)), h('li', {}, t('impPacks', p.packs)), h('li', {}, t('impStats', p.tagStats)),
        h('li', {}, t('moveCats', p.categories)), h('li', {}, t('moveRules', p.rules, p.routes)),
        p.display ? h('li', {}, t('moveDisplay', p.display)) : null,
        p.ai ? h('li', {}, t('impAi')) : null),
      h('p', { class: 'banner warn' }, t('moveOff')),
      h('p', { class: 'muted' }, t('impSafe')));
    const ok = await modal(t('moveImport'), body, [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
    if (!ok) return;
    try { await call('settingsApply', { text }); toast('✓', 'ok'); } catch (err) { toast(cleanErr(err), 'error'); }
    this.render(this.root);
};

SettingsPage.importFile = function () {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    const text = await f.text();
    let format = null;
    try { format = JSON.parse(text).format; } catch { return toast(t('importBadFile'), 'error'); }
    if (format === 'tumblr-studio-settings') return this.importSettings(text);
    if (format !== 'tth-export') return toast(t('importBadFile'), 'error');
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
