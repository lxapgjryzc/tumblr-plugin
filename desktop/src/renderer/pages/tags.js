'use strict';
// General categories (a fixed prefix of every new post's tags) and fandom template packs.

const TagsPage = {
  async render(root) {
    this.root = root;
    const [cats, groups, packs, bundled] = await Promise.all([call('categories'), call('categoryGroups'), call('packs'), call('bundledPacks')]);
    this.groups = groups;
    const installed = new Set(packs.map(p => p.id));
    const notInstalled = bundled.filter(b => !installed.has(b.id));
    let name = '', tag = '';
    root.replaceChildren(
      h('header', { class: 'page-head' }, h('h1', {}, t('navTags'))),
      h('div', { class: 'grid2' },
        h('section', { class: 'card' }, h('h2', {}, t('categoriesTitle')), h('p', { class: 'muted' }, t('categoriesHint')),
          catSections(groups, cats).map(([g, list], gi, all) => h('div', { class: 'cat-admin' },
            h('div', { class: 'form-row' }, h('h3', { class: 'grow' }, groupName(g)),
              g ? [
                h('button', { class: 'ghost', disabled: gi === 0, onclick: () => this.orderGroup(gi, -1) }, '↑'),
                h('button', { class: 'ghost', disabled: gi >= groups.length - 1, onclick: () => this.orderGroup(gi, 1) }, '↓'),
                h('button', { class: 'ghost', onclick: () => this.renameGroup(g) }, t('rename')),
                h('button', { class: 'ghost danger', title: t('deleteGroupHint'), onclick: async () => { await call('deleteCategoryGroup', { id: g.id }); this.render(root); } }, '✕')] : null),
            h('table', { class: 'table' }, h('tbody', {}, list.map((c, i) => h('tr', {},
              h('td', {}, h('b', {}, c.name)), h('td', { class: 'muted' }, '#' + c.tag),
              h('td', { class: 'right nowrap' },
                h('button', { class: 'ghost', disabled: i === 0, onclick: () => this.order(cats, list, i, -1) }, '↑'),
                h('button', { class: 'ghost', disabled: i === list.length - 1, onclick: () => this.order(cats, list, i, 1) }, '↓'),
                h('button', { class: 'ghost', onclick: () => this.editCat(c) }, t('edit')),
                h('button', { class: 'ghost danger', onclick: async () => { await call('deleteCategory', { id: c.id }); this.render(root); } }, '✕')))))))),
          h('div', { class: 'form-row wrap' },
            h('input', { placeholder: t('catName'), oninput: e => { name = e.target.value; } }),
            h('input', { placeholder: t('catTag'), oninput: e => { tag = e.target.value; } }),
            select([...groups.map(g => ({ value: String(g.id), label: groupName(g) })), { value: '', label: t('ungrouped') }], String(groups[0]?.id || ''), v => { this.newGroup = v; }),
            h('button', { class: 'primary', onclick: async () => { await call('saveCategory', { name, tag: tag || name, group_id: (this.newGroup ?? String(groups[0]?.id || '')) || null }); this.render(root); } }, t('add'))),
          h('div', { class: 'form-row' }, h('button', { onclick: () => this.renameGroup(null) }, t('addGroup'))),
          h('p', { class: 'muted small' }, t('catRenameNote'))),
        h('section', { class: 'card' }, h('h2', {}, t('packsTitle')), h('p', { class: 'muted' }, t('packsHint')),
          packs.length ? h('table', { class: 'table' }, h('tbody', {}, packs.map(p => h('tr', {},
            h('td', {}, p.error ? h('span', { class: 'warn-text' }, p.error) : h('b', {}, p.name)),
            h('td', { class: 'muted small' }, p.version ? 'v' + p.version : '', p.items ? ' · ' + t('itemsN', p.items) : ''),
            h('td', { class: 'right' }, p.id ? h('button', { class: 'ghost danger', onclick: async () => { await call('removePack', { id: p.id }); this.render(root); } }, t('delete')) : null))))) : h('p', { class: 'muted' }, t('noPacksYet')),
          notInstalled.length ? [h('h3', {}, t('bundledPacks')), h('div', { class: 'chips' }, notInstalled.map(b =>
            h('button', { class: 'chip', onclick: async () => { await call('installBundled', { file: b.file }); toast('✓', 'ok'); this.render(root); } }, '+ ' + b.name)))] : null,
          h('div', { class: 'actions' }, h('button', { onclick: () => this.fromFile() }, t('installFile'))))));
  },
  async order(cats, list, i, d) {
    const ids = list.map(c => c.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await call('orderCategories', { ids });
    this.render(this.root);
  },
  async orderGroup(i, d) {
    const ids = this.groups.map(g => g.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await call('orderCategoryGroups', { ids });
    this.render(this.root);
  },
  async renameGroup(g) {
    let name = g ? groupName(g) : '';
    const ok = await modal(g ? t('rename') : t('addGroup'), h('label', { class: 'field' }, h('span', {}, t('groupNameLabel')), h('input', { value: name, oninput: e => { name = e.target.value; } })),
      [{ label: t('cancel'), value: false }, { label: t('save'), value: true, class: 'primary' }]);
    if (ok) { await call('saveCategoryGroup', { id: g?.id, name }); this.render(this.root); }
  },
  async editCat(c) {
    let name = c.name, tag = c.tag, group = c.group_id ? String(c.group_id) : '';
    const ok = await modal(t('edit'), h('div', {},
      h('label', { class: 'field' }, h('span', {}, t('catName')), h('input', { value: name, oninput: e => { name = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, t('catTag')), h('input', { value: tag, oninput: e => { tag = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, t('group')), select([...this.groups.map(g => ({ value: String(g.id), label: groupName(g) })), { value: '', label: t('ungrouped') }], group, v => { group = v; })),
      h('p', { class: 'muted small' }, t('catRenameNote'))), [{ label: t('cancel'), value: false }, { label: t('save'), value: true, class: 'primary' }]);
    if (!ok) return;
    await call('saveCategory', { id: c.id, name, tag, group_id: group || null });
    this.render(this.root);
    // The tag itself changed: old posts keep the old tag unless asked (shown first, each post its own job)
    const saved = (await call('categories')).find(x => x.id === c.id);
    if (!saved || saved.tag.toLowerCase() === c.tag.toLowerCase()) return;
    const pv = await call('retagPreview', { from: c.tag, to: saved.tag });
    if (!pv.posts) return;
    const go = await modal(t('retagTitle'), h('div', {},
      h('p', {}, t('retagQ', pv.posts, c.tag, saved.tag)),
      h('p', { class: 'small' }, pv.examples.map(x => [h('a', { href: `https://www.tumblr.com/${x.blogName}/${x.id}`, target: '_blank' }, `${x.blogName}/${x.id}`), ' '])),
      h('p', { class: 'muted small' }, t('retagNote'))),
    [{ label: t('retagLeave'), value: false }, { label: t('retagGo', pv.posts), value: true, class: 'primary' }]);
    if (!go) return;
    const r = await call('retagApply', { from: c.tag, to: saved.tag });
    toast(t('queuedN', r.queued), 'ok');
  },
  fromFile() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      await call('installPack', { raw: await f.text(), source: 'file:' + f.name });
      toast('✓', 'ok');
      this.render(this.root);
    };
    input.click();
  },
};
