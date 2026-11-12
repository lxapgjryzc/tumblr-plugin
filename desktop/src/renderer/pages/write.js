'use strict';
// The editor. A visual list of blocks (text, image, link, read-more) stored as a structured document, never as
// markup the user has to maintain. Images are placed with buttons: insert here, move up/down, move to a chosen
// paragraph, put side by side, separate, replace. Dragging is not needed for anything. Undo/redo covers every
// change; the draft autosaves.

const uid = () => 'b' + Math.random().toString(16).slice(2, 12);
const cps = s => [...String(s)];

// ---- rich text <-> DOM (NPF formatting ranges count code points) ----
const TAGS = { bold: 'b', italic: 'i', strikethrough: 's', small: 'small' };
function textToDom(el, text, formatting = []) {
  const chars = cps(text);
  const cuts = new Set([0, chars.length]);
  for (const f of formatting) { cuts.add(f.start); cuts.add(f.end); }
  const pts = [...cuts].filter(x => x >= 0 && x <= chars.length).sort((a, b) => a - b);
  el.replaceChildren();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let node = document.createTextNode(chars.slice(a, b).join(''));
    for (const f of formatting.filter(f => f.start <= a && f.end >= b)) {
      const w = f.type === 'link' ? h('a', { href: f.url, title: f.url }) : TAGS[f.type] ? document.createElement(TAGS[f.type]) : null;
      if (!w) continue;
      w.append(node); node = w;
    }
    el.append(node);
  }
}
function domToText(el) {
  let text = '';
  const open = [];
  const ranges = [];
  const fmtOf = n => {
    const tag = n.nodeName;
    if (tag === 'B' || tag === 'STRONG') return { type: 'bold' };
    if (tag === 'I' || tag === 'EM') return { type: 'italic' };
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return { type: 'strikethrough' };
    if (tag === 'SMALL') return { type: 'small' };
    if (tag === 'A' && n.getAttribute('href')) return { type: 'link', url: n.getAttribute('href') };
    if (tag === 'SPAN' && n.style) {
      if (/bold|[6-9]00/.test(n.style.fontWeight)) return { type: 'bold' };
      if (n.style.fontStyle === 'italic') return { type: 'italic' };
    }
    return null;
  };
  const walk = (n, depth) => {
    if (n.nodeType === 3) { text += n.nodeValue.replace(/ /g, ' '); return; }
    if (n.nodeName === 'BR') { text += '\n'; return; }
    const f = fmtOf(n);
    const start = cps(text).length;
    if ((n.nodeName === 'DIV' || n.nodeName === 'P') && depth > 0 && text && !text.endsWith('\n')) text += '\n';
    n.childNodes.forEach(c => walk(c, depth + 1));
    if (f) { const end = cps(text).length; if (end > start) ranges.push({ ...f, start, end }); }
  };
  walk(el, 0);
  text = text.replace(/\n$/, '');
  const n = cps(text).length;
  // merge touching ranges of the same kind
  const merged = [];
  for (const r of ranges.map(r => ({ ...r, end: Math.min(r.end, n) })).filter(r => r.start < r.end).sort((a, b) => a.type.localeCompare(b.type) || (a.url || '').localeCompare(b.url || '') || a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && last.type === r.type && (last.url || '') === (r.url || '') && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return { text, formatting: merged };
}
// caret position in code points inside el
function caretOffset(el) {
  const s = window.getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const frag = h('div');
  frag.append(pre.cloneContents());
  return cps(domToText(frag).text).length;
}
// The Tumblr image size nearest to the editor's width (a published post's images keep their own media)
const nearMedia = media => (media || []).reduce((a, b) => (!a || Math.abs((b.width || 0) - 540) < Math.abs((a.width || 0) - 540) ? b : a), null)?.url || null;
const sliceFmt = (fmt, a, b) => fmt.filter(f => f.end > a && f.start < b).map(f => ({ ...f, start: Math.max(f.start, a) - a, end: Math.min(f.end, b) - a }));

const WritePage = {
  async render(root, params = {}) {
    this.root = root;
    // where an edit of a published post came from (Posts with its query, the exact instance), to go back to it
    this.ret = params.ret || null;
    if (params.edit) return this.startEdit(params.edit);
    if (params.id) return this.open(params.id);
    if (params.create) return this.create();
    const drafts = await call('drafts');
    root.replaceChildren(h('header', { class: 'page-head' }, h('h1', {}, t('navWrite')),
      h('div', { class: 'head-actions' }, h('button', { class: 'primary', onclick: () => this.create() }, t('newPost')))),
      drafts.length ? h('div', { class: 'cards draft-cards' }, drafts.map(d => h('div', { class: 'pcard', onclick: () => this.open(d.id) },
        d.thumb ? h('div', { class: 'thumb' }, h('img', { src: d.thumb })) : h('div', { class: 'thumb text' }, d.title || t('untitled')),
        h('div', { class: 'meta' }, h('div', { class: 'row1' }, h('span', { class: 'blog' }, d.blog ? blogName(d.blog) : '—'), h('span', { class: 'muted' }, fmtTime(d.updated_at))),
          d.kind === 'edit' ? h('span', { class: 'badge accent' }, t('edBadge')) : null,
          d.status !== 'editing' ? h('span', { class: 'badge warn' }, t('ds_' + d.status)) : null)))) : empty(t('noDrafts'), h('button', { class: 'primary', onclick: () => this.create() }, t('newPost'))));
  },

  async create() {
    let blog = null;
    try { blog = localStorage.getItem('lastBlog'); } catch {}
    const share = (App.status.blogs || []).filter(b => b.role === 'share');
    if (!share.some(b => b.uuid === blog)) blog = share.find(b => !b.is_primary)?.uuid || share[0]?.uuid || null;
    const d = await call('newDraft', { blog });
    this.open(d.id, d);
  },

  // Edit one of my published originals in this editor (FUNCTIONAL_WORKFLOWS_SPEC 3.2). The app reads the post
  // from Tumblr first; an unfinished edit of the same post is resumed.
  async startEdit({ blog, id }) {
    this.root.replaceChildren(h('div', { class: 'page-loading' }));
    let d;
    try { d = await call('editPublished', { blog, id }); }
    catch (e) {
      const m = cleanErr(e);
      let code = /unsupported:(\w+)/.exec(m)?.[1];
      if (code && !['layout_ask', 'layout_rows', 'layout_order'].includes(code)) code = 'layout_other';
      this.root.replaceChildren(h('header', { class: 'page-head' }, h('button', { class: 'ghost', onclick: () => this.goBack() }, '← ' + t('edBack'))),
        h('div', { class: 'banner warn' }, code ? t('edUnsupported_' + code) : m),
        h('p', { class: 'muted small' }, t('edUnsupportedNote')),
        h('a', { class: 'button', href: `https://www.tumblr.com/edit/${blogName(blog)}/${id}`, target: '_blank' }, t('edOnTumblr')));
      return;
    }
    this.open(d.id, d);
  },
  isEdit() { return this.d?.kind === 'edit'; },
  // Back where the edit started: Posts keeps its query, layout and scroll; the exact instance is shown again
  async goBack() {
    try { await this.flush(); } catch {}
    const r = this.ret;
    if (!r) return this.render(this.root);
    if (r.page === 'fans') return App.go('fans');
    await App.go('posts');
    if (r.detail) PostsPage.openDetail(r.detail);
  },

  async open(id, d) {
    d = d || await call('draft', { id });
    if (!d) return this.render(this.root);
    this.d = d;
    this.doc = d.doc;
    this.opts = { categoryIds: [], pack: null, picks: [], extra: [], ...d.options };
    this.assets = d.assets || {};
    this.revision = d.revision;
    this.past = []; this.future = [];
    this.sel = new Set();
    this.saveState = 'saved';
    this.categories = await call('categories');
    this.catGroups = await call('categoryGroups');
    this.packList = (await call('packs')).filter(p => !p.error);
    this.layout();
  },

  layout() {
    const d = this.d;
    this.canvas = h('div', { class: 'canvas', onkeydown: e => this.keys(e) });
    this.side = h('aside', { class: 'write-side' });
    this.statusEl = h('span', { class: 'save-state muted' });
    this.root.replaceChildren(
      h('header', { class: 'page-head' },
        this.isEdit() && this.ret ? h('button', { class: 'ghost', onclick: () => this.goBack() }, '← ' + t('edBack'))
          : h('button', { class: 'ghost', onclick: () => { this.flush(); this.render(this.root); } }, '← ' + t('allDrafts')),
        h('div', { class: 'head-actions' }, this.statusEl,
          h('button', { title: 'Ctrl+Z', onclick: () => this.undo() }, '↶ ' + t('undo')),
          h('button', { title: 'Ctrl+Y', onclick: () => this.redo() }, '↷ ' + t('redo')),
          h('button', { onclick: () => this.preview() }, t('preview')))),
      this.isEdit() ? this.editBanner() : null,
      !this.isEdit() && d.status === 'published' ? h('div', { class: 'banner' }, t('publishedNote'), h('a', { href: `https://${blogName(d.remote_blog)}.tumblr.com/post/${d.remote_id}`, target: '_blank' }, t('openOnTumblr'))) : null,
      !this.isEdit() && (d.status === 'publishing' || d.status === 'failed') ? this.publishBanner() : null,
      h('div', { class: 'write' }, h('div', { class: 'canvas-wrap' }, this.toolbar(), this.canvas), this.side));
    this.drawCanvas();
    this.drawSide();
    this.showSave();
  },

  readOnly() { return this.d.status !== 'editing'; },

  // What this edit is and where it stands: the target post, Tumblr's newer version, sending, done
  editBanner() {
    const d = this.d, b = d.base || {};
    const url = `https://${blogName(d.target_blog)}.tumblr.com/post/${d.target_id}`;
    const from = this.ret?.detail && (this.ret.detail.blog !== d.target_blog || this.ret.detail.id !== d.target_id) ? this.ret.detail : null;
    const head = h('div', { class: 'banner' }, h('span', {}, t('edEditing', blogName(d.target_blog)), ' ', b.state ? stateBadge(b.state) : null, ' ',
      from ? h('span', { class: 'muted small' }, t('edFromReblog', blogName(from.blog))) : null),
      h('a', { href: url, target: '_blank' }, t('openOnTumblr')));
    const parts = [head];
    if (d.status === 'editing' && d.remoteChanged) parts.push(h('div', { class: 'banner warn small' }, t('edRemoteChanged')));
    if (d.status === 'editing' && d.stash) parts.push(h('div', { class: 'banner small' }, t('edStash', fmtTime(d.stash.at)),
      h('button', { onclick: async () => { this.open(d.id, await call('restoreStash', { id: d.id })); } }, t('edRestore'))));
    if (d.status === 'submitting') parts.push(h('div', { class: 'banner' }, t('edSubmitting'), h('button', { 'data-go': 'activity' }, t('navActivity'))));
    if (d.status === 'failed') parts.push(h('div', { class: 'banner warn' }, t('edFailed'),
      h('button', { onclick: async () => { await call('reopenDraft', { id: d.id }); this.open(d.id); } }, t('backToEditing')),
      h('button', { 'data-go': 'activity' }, t('navActivity'))));
    if (d.status === 'conflict' && d.conflict) {
      const c = d.conflict;
      parts.push(h('div', { class: 'banner warn' }, h('span', {}, t('edConflict_' + c.why, fmtTime(c.at))),
        h('button', { onclick: () => this.showRemote(c) }, t('edSeeTheirs')),
        h('button', { onclick: async () => { try { this.open(d.id, await call('resolveEdit', { id: d.id, use: 'theirs' })); } catch (e) { toast(cleanErr(e), 'error'); } } }, t('edUseTheirs')),
        h('button', { class: 'primary', onclick: async () => { try { this.open(d.id, await call('resolveEdit', { id: d.id, use: 'mine' })); toast(t('edMineKept')); } catch (e) { toast(cleanErr(e), 'error'); } } }, t('edUseMine'))));
    }
    if (d.status === 'published') parts.push(h('div', { class: 'banner ok' }, t('edDone', fmtTime(d.updated_at)),
      h('button', { onclick: () => VersionsDialog.open({ blog: d.target_blog, id: d.target_id }) }, t('versionsManage')),
      this.ret ? h('button', { onclick: () => this.goBack() }, t('edBack')) : null));
    return parts;
  },
  // Tumblr's version as it is now (text blocks, images, other blocks), next to the edit
  async showRemote(c) {
    const blocks = (c.content || []).map(b => b.type === 'text' ? h('p', { class: 'npf-text st-' + (b.subtype || 'p') }, b.text)
      : b.type === 'image' ? h('img', { src: nearMedia(b.media), alt: b.alt_text || '', class: 'remote-img' })
        : h('p', { class: 'muted small' }, '[' + (b.type || '?') + ']'));
    await modal(t('edTheirsTitle'), h('div', { class: 'npf-preview' }, blocks, (c.tags || []).length ? h('div', { class: 'npf-tags' }, c.tags.map(x => h('span', {}, '#' + x))) : null), [{ label: t('close'), value: null }], { wide: true });
  },

  publishBanner() {
    const b = h('div', { class: 'banner warn' }, this.d.status === 'publishing' ? t('publishing') : t('publishFailed'),
      h('button', { onclick: async () => { await call('reopenDraft', { id: this.d.id }); this.open(this.d.id); } }, t('backToEditing')),
      h('button', { 'data-go': 'activity' }, t('navActivity')));
    return b;
  },

  // ---------- document operations (each one is undoable) ----------
  commit(fn) {
    if (this.readOnly()) return;
    this.past.push(JSON.stringify(this.doc));
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    fn(this.doc);
    this.normalise();
    this.drawCanvas();
    this.scheduleSave();
  },
  normalise() {
    const d = this.doc;
    const idx = new Map(d.blocks.map((b, i) => [b.id, i]));
    const rows = [];
    for (const r of d.rows || []) {
      const ids = r.filter(id => idx.has(id) && d.blocks[idx.get(id)].type === 'image').sort((a, b) => idx.get(a) - idx.get(b));
      let run = [];
      const flush = () => { if (run.length > 1) rows.push(run.slice(0, 3)); run = []; };
      for (const id of ids) { if (run.length && idx.get(id) !== idx.get(run[run.length - 1]) + 1) flush(); run.push(id); }
      flush();
    }
    d.rows = rows;
    if (!d.blocks.length) d.blocks.push({ id: uid(), type: 'text', text: '' });
  },
  undo() { if (!this.past.length) return; this.syncText(); this.future.push(JSON.stringify(this.doc)); this.doc = JSON.parse(this.past.pop()); this.drawCanvas(); this.scheduleSave(); },
  redo() { if (!this.future.length) return; this.past.push(JSON.stringify(this.doc)); this.doc = JSON.parse(this.future.pop()); this.drawCanvas(); this.scheduleSave(); },
  rowOf(id) { return (this.doc.rows || []).find(r => r.includes(id)) || null; },
  // Units = what is shown as one line: a text/link block, a lone image, or an image row
  units() {
    const out = [], done = new Set();
    for (const b of this.doc.blocks) {
      if (done.has(b.id)) continue;
      const r = this.rowOf(b.id);
      if (r) { r.forEach(x => done.add(x)); out.push({ ids: r.slice(), row: true }); }
      else out.push({ ids: [b.id], row: false });
    }
    return out;
  },
  insertAt(index, blocks) { this.commit(d => d.blocks.splice(index, 0, ...blocks)); },
  indexOf(id) { return this.doc.blocks.findIndex(b => b.id === id); },
  removeBlock(id) { this.commit(d => { d.blocks = d.blocks.filter(b => b.id !== id); this.sel.delete(id); }); },
  // Move a unit (block or whole row) one unit up/down
  moveUnit(ids, dir) {
    this.commit(d => {
      const units = this.units();
      const ui = units.findIndex(u => u.ids.includes(ids[0]));
      const other = units[ui + dir];
      if (!other) return;
      const take = d.blocks.filter(b => ids.includes(b.id));
      const rest = d.blocks.filter(b => !ids.includes(b.id));
      const anchor = dir < 0 ? rest.findIndex(b => b.id === other.ids[0]) : rest.findIndex(b => b.id === other.ids[other.ids.length - 1]) + 1;
      rest.splice(anchor, 0, ...take);
      d.blocks = rest;
    });
  },
  // Swap an image with its neighbour inside a row
  swapInRow(id, dir) {
    this.commit(d => {
      const r = this.rowOf(id);
      const i = r.indexOf(id), j = i + dir;
      if (j < 0 || j >= r.length) return;
      const a = this.indexOf(r[i]), b = this.indexOf(r[j]);
      [d.blocks[a], d.blocks[b]] = [d.blocks[b], d.blocks[a]];
    });
  },
  // Put a block right after another block (or at the start when after = null). It leaves its row.
  moveAfter(id, after) {
    this.commit(d => {
      const blk = d.blocks.find(b => b.id === id);
      d.blocks = d.blocks.filter(b => b.id !== id);
      d.rows = d.rows.map(r => r.filter(x => x !== id));
      let at = after ? d.blocks.findIndex(b => b.id === after) + 1 : 0;
      const r = after ? this.rowOf(after) : null; // never split a row: go after its end
      if (r) at = Math.max(...r.map(x => d.blocks.findIndex(b => b.id === x))) + 1;
      d.blocks.splice(at, 0, blk);
    });
  },
  groupSelected() {
    const ids = [...this.sel].sort((a, b) => this.indexOf(a) - this.indexOf(b));
    const pos = ids.map(id => this.indexOf(id));
    const adjacent = ids.length >= 2 && ids.length <= 3 && pos.every((p, i) => !i || p === pos[i - 1] + 1) && ids.every(id => this.doc.blocks[this.indexOf(id)].type === 'image');
    if (!adjacent) { toast(t('groupNeedsAdjacent'), 'error'); return; }
    this.commit(d => { d.rows = d.rows.filter(r => !r.some(x => ids.includes(x))); d.rows.push(ids); this.sel.clear(); });
  },
  ungroup(ids) { this.commit(d => { d.rows = d.rows.filter(r => !r.some(x => ids.includes(x))); }); },

  async pickImages(index, replaceId = null) {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: !replaceId });
    input.onchange = async () => {
      const files = [...input.files];
      if (!files.length) return;
      // confirm the order before inserting several
      const list = files.length > 1 && !replaceId ? await this.confirmOrder(files) : files;
      if (!list) return;
      const blocks = [];
      for (const f of list) { const a = await this.upload(f); if (a) blocks.push({ id: uid(), type: 'image', asset: a.id, alt: '' }); }
      if (replaceId && blocks[0]) {
        this.commit(d => { const b = d.blocks.find(x => x.id === replaceId); b.asset = blocks[0].asset; b.altCheck = true; });
        toast(t('checkAlt'));
      } else if (blocks.length) this.insertAt(index, blocks);
    };
    input.click();
  },
  async confirmOrder(files) {
    let order = files.slice();
    const urls = new Map(files.map(f => [f, URL.createObjectURL(f)]));
    const box = h('div');
    const draw = () => box.replaceChildren(h('p', { class: 'muted' }, t('orderHint')), h('div', { class: 'order-list' }, order.map((f, i) => h('div', { class: 'order-item' },
      h('b', {}, i + 1), h('img', { src: urls.get(f) }), h('span', { class: 'grow' }, f.name),
      h('button', { disabled: i === 0, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); } }, '↑'),
      h('button', { disabled: i === order.length - 1, onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); } }, '↓')))));
    draw();
    const ok = await modal(t('insertImages', files.length), box, [{ label: t('cancel'), value: false }, { label: t('insert'), value: true, class: 'primary' }]);
    urls.forEach(u => URL.revokeObjectURL(u));
    return ok ? order : null;
  },
  async upload(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dim = await new Promise(res => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => { res([im.naturalWidth, im.naturalHeight]); URL.revokeObjectURL(u); }; im.onerror = () => res([null, null]); im.src = u; });
    try {
      const a = await call('addAsset', { draftId: this.d.id, name: file.name, mime: file.type || 'image/png', bytes, width: dim[0], height: dim[1] });
      this.assets[a.id] = { url: a.url, exists: true, width: a.width, height: a.height, mime: a.mime };
      return a;
    } catch { return null; }
  },

  // ---------- drawing ----------
  toolbar() {
    this.tb = h('div', { class: 'write-toolbar' });
    this.drawToolbar();
    return this.tb;
  },
  drawToolbar() {
    if (!this.tb) return;
    const n = this.sel.size;
    this.tb.replaceChildren(
      h('button', { title: 'Ctrl+B', onmousedown: e => { e.preventDefault(); document.execCommand('bold'); } }, h('b', {}, 'B')),
      h('button', { title: 'Ctrl+I', onmousedown: e => { e.preventDefault(); document.execCommand('italic'); } }, h('i', {}, 'I')),
      h('button', { onmousedown: e => { e.preventDefault(); document.execCommand('strikeThrough'); } }, h('s', {}, 'S')),
      h('button', { onmousedown: e => { e.preventDefault(); this.link(); } }, '🔗 ' + t('link')),
      h('span', { class: 'sep' }),
      n ? h('span', { class: 'muted' }, t('imagesSelected', n)) : h('span', { class: 'muted small' }, t('selectImagesHint')),
      h('button', { disabled: n < 2 || n > 3, onclick: () => this.groupSelected() }, '▥ ' + t('sideBySide')),
      n ? h('button', { class: 'ghost', onclick: () => { this.sel.clear(); this.drawCanvas(); } }, t('clearSel')) : null);
  },
  async link() {
    const s = window.getSelection();
    if (!s.rangeCount || s.isCollapsed) { toast(t('selectTextFirst')); return; }
    const range = s.getRangeAt(0).cloneRange();
    let url = '';
    const ok = await modal(t('link'), h('input', { class: 'wide-input', placeholder: 'https://', oninput: e => { url = e.target.value.trim(); } }), [{ label: t('cancel'), value: false }, { label: t('apply'), value: true, class: 'primary' }]);
    if (!ok || !/^https?:\/\//i.test(url)) return;
    s.removeAllRanges(); s.addRange(range);
    document.execCommand('createLink', false, url);
    const el = range.startContainer.parentElement?.closest('[data-block]');
    if (el) this.textChanged(el);
  },

  drawCanvas() {
    this.drawToolbar();
    const ro = this.readOnly();
    const units = this.units();
    const kids = [];
    units.forEach((u, ui) => {
      if (!ro) kids.push(this.inserter(this.indexOf(u.ids[0])));
      kids.push(u.row ? this.rowEl(u, ui, units.length) : this.blockEl(this.doc.blocks[this.indexOf(u.ids[0])], ui, units.length));
    });
    if (!ro) kids.push(this.inserter(this.doc.blocks.length));
    this.canvas.replaceChildren(...kids);
    this.canvas.classList.toggle('ro', ro);
  },
  inserter(index) {
    return h('div', { class: 'inserter' },
      h('button', { onclick: () => { const b = { id: uid(), type: 'text', text: '' }; this.insertAt(index, [b]); this.focusBlock(b.id); } }, '+ ' + t('blockText')),
      h('button', { onclick: () => this.pickImages(index) }, '+ ' + t('blockImage')),
      h('button', { onclick: async () => {
        let url = '';
        const ok = await modal(t('blockLink'), h('input', { class: 'wide-input', placeholder: 'https://', oninput: e => { url = e.target.value.trim(); } }), [{ label: t('cancel'), value: false }, { label: t('insert'), value: true, class: 'primary' }]);
        if (ok && url) this.insertAt(index, [{ id: uid(), type: 'link', url }]);
      } }, '+ ' + t('blockLink')),
      this.doc.blocks.some(b => b.type === 'readmore') ? null : h('button', { onclick: () => this.insertAt(index, [{ id: uid(), type: 'readmore' }]) }, '+ ' + t('blockReadMore')));
  },
  unitTools(ids, ui, n, extra = []) {
    if (this.readOnly()) return null;
    return h('div', { class: 'unit-tools' },
      h('button', { title: t('moveUp'), disabled: ui === 0, onclick: () => this.moveUnit(ids, -1) }, '↑'),
      h('button', { title: t('moveDown'), disabled: ui === n - 1, onclick: () => this.moveUnit(ids, 1) }, '↓'),
      ...extra);
  },
  blockEl(b, ui, n) {
    if (b.type === 'text') return this.textEl(b, ui, n);
    if (b.type === 'image') return h('div', { class: 'unit' }, this.unitTools([b.id], ui, n), h('div', { class: 'img-row' }, this.imageTile(b, null)));
    if (b.type === 'link') return h('div', { class: 'unit' }, this.unitTools([b.id], ui, n, [h('button', { class: 'ghost', title: t('delete'), onclick: () => this.removeBlock(b.id) }, '✕')]),
      h('div', { class: 'link-block' }, '🔗 ', h('input', { value: b.url, readonly: this.readOnly(), onchange: e => this.commit(d => { d.blocks.find(x => x.id === b.id).url = e.target.value.trim(); }) })));
    if (b.type === 'readmore') return h('div', { class: 'unit' }, this.unitTools([b.id], ui, n, [h('button', { class: 'ghost', onclick: () => this.removeBlock(b.id) }, '✕')]), h('div', { class: 'readmore' }, t('blockReadMore')));
    // a block of a published post this editor can't change: kept exactly, can be moved or removed on purpose
    if (b.type === 'keep') return h('div', { class: 'unit' }, this.unitTools([b.id], ui, n, [h('button', { class: 'ghost', title: t('delete'), onclick: () => this.removeBlock(b.id) }, '✕')]),
      h('div', { class: 'keep-block' }, h('b', {}, t('keepBlock', b.label || b.raw?.type || '?')), h('span', { class: 'muted small' }, t('keepBlockNote'))));
    return h('div');
  },
  textEl(b, ui, n) {
    if (b.locked) {
      // formatting the editor can't show (colour, mentions): the text is kept exactly as it is on Tumblr
      const el = h('div', { class: 'text-block locked st-' + (b.subtype || 'p'), 'data-locked': b.id });
      textToDom(el, b.text || '', (b.formatting || []).filter(f => TAGS[f.type] || f.type === 'link'));
      return h('div', { class: 'unit text-unit' }, this.unitTools([b.id], ui, n, [h('span', { class: 'muted small', title: t('lockedHint') }, '🔒 ' + t('locked')), h('button', { class: 'ghost', title: t('delete'), onclick: () => this.removeBlock(b.id) }, '✕')]), el);
    }
    const el = h('div', { class: 'text-block st-' + (b.subtype || 'p'), contenteditable: this.readOnly() ? 'false' : 'true', 'data-block': b.id, 'data-ph': t('typeHere'), spellcheck: 'true' });
    textToDom(el, b.text || '', b.formatting || []);
    el.addEventListener('input', () => this.textChanged(el));
    el.addEventListener('paste', e => this.paste(e, b.id));
    el.addEventListener('keydown', e => this.textKeys(e, el, b.id));
    const sub = h('select', { class: 'subtype', disabled: this.readOnly(), onchange: e => this.commit(d => { const x = d.blocks.find(x => x.id === b.id); x.subtype = e.target.value || undefined; }) },
      ['', 'heading1', 'heading2', 'quote', 'indented', 'chat', 'unordered-list-item', 'ordered-list-item'].map(s => h('option', { value: s, selected: (b.subtype || '') === s }, t('sub_' + (s || 'p')))));
    return h('div', { class: 'unit text-unit' }, this.unitTools([b.id], ui, n, [sub, h('button', { class: 'ghost', title: t('delete'), onclick: () => this.removeBlock(b.id) }, '✕')]), el);
  },
  rowEl(u, ui, n) {
    const blocks = u.ids.map(id => this.doc.blocks[this.indexOf(id)]);
    return h('div', { class: 'unit' }, this.unitTools(u.ids, ui, n, [h('button', { onclick: () => this.ungroup(u.ids) }, '▤ ' + t('separate'))]),
      h('div', { class: 'img-row grouped' }, blocks.map(b => this.imageTile(b, u.ids))));
  },
  imageTile(b, row) {
    const a = b.remote ? { exists: true, url: nearMedia(b.remote) } : this.assets[b.asset];
    const on = this.sel.has(b.id);
    const ro = this.readOnly();
    const others = this.doc.blocks.filter(x => x.id !== b.id && !(row || []).includes(x.id));
    return h('figure', { class: 'img-tile' + (on ? ' sel' : '') },
      a?.exists ? h('img', { src: a.url, alt: b.alt || '' }) : h('div', { class: 'img-missing' }, t('imageMissing')),
      ro ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: e => { e.target.checked ? this.sel.add(b.id) : this.sel.delete(b.id); this.drawToolbar(); e.target.closest('figure').classList.toggle('sel', e.target.checked); } })),
      ro ? null : h('div', { class: 'img-tools' },
        row ? h('button', { title: t('moveLeft'), disabled: row.indexOf(b.id) === 0, onclick: () => this.swapInRow(b.id, -1) }, '←') : null,
        row ? h('button', { title: t('moveRight'), disabled: row.indexOf(b.id) === row.length - 1, onclick: () => this.swapInRow(b.id, 1) }, '→') : null,
        select([{ value: '', label: t('moveTo') }, { value: '^', label: t('toStart') }, ...others.map((x, i) => ({ value: x.id, label: t('afterBlock', this.describe(x)) }))], '', v => { if (v) this.moveAfter(b.id, v === '^' ? null : v); }, { class: 'move-to' }),
        h('button', { title: t('replace'), onclick: () => this.pickImages(0, b.id) }, '⟳'),
        h('button', { title: t('delete'), onclick: () => this.removeBlock(b.id) }, '✕')),
      h('input', { class: 'alt' + (b.altCheck ? ' attention' : ''), placeholder: t('altText'), value: b.alt || '', readonly: ro,
        onchange: e => this.commit(d => { const x = d.blocks.find(x => x.id === b.id); x.alt = e.target.value; delete x.altCheck; }) }));
  },
  describe(x) {
    if (x.type === 'text') return '“' + (x.text || '').slice(0, 24) + ((x.text || '').length > 24 ? '…' : '') + '”';
    if (x.type === 'image') return t('blockImage') + ' ' + (this.doc.blocks.filter(b => b.type === 'image').indexOf(x) + 1);
    if (x.type === 'link') return t('blockLink');
    if (x.type === 'keep') return '[' + (x.label || '?') + ']';
    return t('blockReadMore');
  },
  focusBlock(id, atEnd = false) {
    requestAnimationFrame(() => {
      const el = this.canvas.querySelector(`[data-block="${id}"]`);
      if (!el) return;
      el.focus();
      if (atEnd) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    });
  },

  // ---------- text editing ----------
  textChanged(el) {
    const id = el.dataset.block;
    const b = this.doc.blocks.find(x => x.id === id);
    if (!b) return;
    // one undo step per pause in typing
    if (!this.typing) { this.past.push(JSON.stringify(this.doc)); this.future = []; }
    clearTimeout(this.typing);
    this.typing = setTimeout(() => { this.typing = null; }, 800);
    Object.assign(b, domToText(el));
    this.scheduleSave();
  },
  syncText() { this.canvas?.querySelectorAll('[data-block]').forEach(el => { const b = this.doc.blocks.find(x => x.id === el.dataset.block); if (b) Object.assign(b, domToText(el)); }); },
  textKeys(e, el, id) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const off = caretOffset(el);
      const cur = domToText(el);
      const chars = cps(cur.text);
      const at = off ?? chars.length;
      const nb = { id: uid(), type: 'text', text: chars.slice(at).join(''), formatting: sliceFmt(cur.formatting, at, chars.length) };
      const b = this.doc.blocks.find(x => x.id === id);
      if (['unordered-list-item', 'ordered-list-item'].includes(b.subtype)) nb.subtype = b.subtype;
      this.commit(d => {
        const x = d.blocks.find(x => x.id === id);
        x.text = chars.slice(0, at).join(''); x.formatting = sliceFmt(cur.formatting, 0, at);
        d.blocks.splice(d.blocks.findIndex(y => y.id === id) + 1, 0, nb);
      });
      this.focusBlock(nb.id);
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\n');
    } else if (e.key === 'Backspace' && caretOffset(el) === 0 && window.getSelection().isCollapsed) {
      // join with the previous text block
      const i = this.indexOf(id);
      const prev = this.doc.blocks[i - 1];
      if (prev?.type !== 'text') { if (!domToText(el).text && this.doc.blocks.length > 1) { e.preventDefault(); this.removeBlock(id); } return; }
      e.preventDefault();
      const cur = domToText(el);
      const shift = cps(prev.text || '').length;
      this.commit(d => {
        const p = d.blocks[i - 1];
        p.text = (p.text || '') + cur.text;
        p.formatting = [...(p.formatting || []), ...cur.formatting.map(f => ({ ...f, start: f.start + shift, end: f.end + shift }))];
        d.blocks.splice(i, 1);
      });
      this.focusBlock(prev.id, true);
    }
  },
  async paste(e, id) {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    e.preventDefault();
    if (files.length) {
      const blocks = [];
      for (const f of files) { const a = await this.upload(f); if (a) blocks.push({ id: uid(), type: 'image', asset: a.id, alt: '' }); }
      this.syncText();
      if (blocks.length) this.insertAt(this.indexOf(id) + 1, blocks);
      return;
    }
    // plain text only: pasted HTML would bring styles Tumblr can't take
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  },
  keys(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.syncText(); this.undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.flush(); }
  },

  // ---------- autosave ----------
  scheduleSave() {
    this.saveState = 'dirty'; this.showSave();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 700);
  },
  async flush() {
    clearTimeout(this.saveTimer);
    if (this.saveState !== 'dirty' || this.readOnly()) return;
    this.syncText();
    this.saveState = 'saving'; this.showSave();
    try {
      const r = await window.studio.call('saveDraft', { id: this.d.id, doc: this.doc, options: this.opts, revision: this.revision, blog: this.d.blog });
      this.revision = r.revision; this.savedAt = r.saved_at; this.saveState = 'saved';
    } catch (e) { this.saveState = 'error'; this.saveErr = cleanErr(e); }
    this.showSave();
  },
  showSave() {
    if (!this.statusEl) return;
    const s = this.saveState;
    this.statusEl.className = 'save-state ' + (s === 'error' ? 'warn-text' : 'muted');
    this.statusEl.textContent = s === 'saved' ? t('savedAt', this.savedAt ? fmtTime(this.savedAt) : '✓') : s === 'error' ? t('saveError', this.saveErr || '') : t('saving');
  },

  // ---------- side panel: destination, categories, templates, tags, publish ----------
  async drawSide() {
    if (this.isEdit()) return this.drawEditSide();
    const o = this.opts, ro = this.readOnly();
    const share = (App.status.blogs || []).filter(b => b.role === 'share');
    const tagsRes = await call('composeTags', o);
    const tags = tagsRes.tags;
    const effects = this.d.blog ? await call('routeEffect', { blog: this.d.blog, tags: tags.map(x => x.tag) }) : [];
    const setOpt = patch => { Object.assign(this.opts, patch, { fromDefaults: false }); this.scheduleSave(); this.drawSide(); };
    let extraInput;
    const view = o.pack ? await call('packView', { id: o.pack, q: this.packQ || '', picks: o.picks }) : null;
    const dismissed = this.dismissed || (this.dismissed = new Set());
    const pick = async id => { const next = await call('togglePick', { id: o.pack, picks: o.picks, item: id }); setOpt({ picks: next }); };
    const itemTitle = it => (view.pulled[it.id] ? t('tplIncludedBy', view.pulled[it.id].by) : it.tags.length ? it.tags.map(x => '#' + x).join(' ') : t('tplMarkerOnly'));
    const itemChip = it => h('button', { class: 'chip' + (o.picks.includes(it.id) ? ' on' : view.pulled[it.id] ? ' inc' : ''), disabled: ro, title: itemTitle(it), onclick: () => pick(it.id) }, it.name);
    const sectionName = sc => sc.name || t(sc.kind === 'preset' ? 'tplPresets' : sc.kind === 'ship' || sc.kind === 'group' ? 'tplRelations' : 'tplOther');
    // Why a template tag is off or flagged, plus its heat, as the browser panel says it
    const rowTitle = r => {
      const code = r.why || r.flag;
      const why = code === 'cold' ? t('why_cold', r.rank, r.of) : code === 'offtopic' ? t('why_offtopic', Math.round((r.fit || 0) * 100))
        : code === 'fuzzy' ? t('why_fuzzy', r.heat?.match ?? '?') : code ? t('why_' + code) : '';
      const heat = r.heat ? [r.heat.followers != null ? t('followersN', r.heat.followers) : '', r.heat.notes != null ? t('tagNotesN', r.heat.notes) : ''].filter(Boolean).join(' · ') : '';
      return [why, heat].filter(Boolean).join(' · ');
    };
    const rowOf = new Map((tagsRes.rows || []).map(r => [r.tag.toLowerCase(), r]));
    // Flip what a row shows now; a flip back to the computed state clears the override
    const flip = async r => {
      const k = r.tag.toLowerCase(), want = !r.on;
      const ov = { ...(o.overrides || {}) };
      delete ov[k];
      const plain = (await call('composeTags', { ...o, overrides: ov })).rows.find(x => x.tag.toLowerCase() === k);
      if (plain && plain.on !== want) ov[k] = want;
      setOpt({ overrides: ov });
    };
    const flagged = (tagsRes.rows || []).filter(r => r.on && r.flag);
    const offRows = (tagsRes.rows || []).filter(r => !r.on);
    const box = [
      h('section', { class: 'side-card' }, h('h3', {}, t('destination')),
        select(share.map(b => ({ value: b.uuid, label: b.name + (b.is_primary ? ' (main)' : '') })), this.d.blog || '', async v => {
          this.d.blog = v;
          try { localStorage.setItem('lastBlog', v); } catch {}
          // a blog's remembered choices fill an untouched draft only
          if (!o.categoryIds.length && !o.picks.length) { const def = await call('blogDefaults', { blog: v }); if (def) Object.assign(this.opts, { categoryIds: def.categoryIds || [], pack: def.pack, picks: def.picks || [] }); }
          else toast(t('keptChoices'));
          this.scheduleSave(); this.drawSide();
        }, { disabled: ro }),
        effects.map(ef => h('p', { class: 'small ' + (ef.excluded ? 'muted' : '') }, ef.excluded ? t('routeSkip', blogName(ef.dest), ef.excluded) : t('routeGo', blogName(ef.dest))))),
      // Every group is optional; choices combine freely and are composed in configured order, not click order
      h('section', { class: 'side-card' }, h('h3', {}, t('category'), ' ', h('span', { class: 'muted small' }, t('optional'))),
        catSections(this.catGroups, this.categories).map(([g, list]) => h('div', { class: 'cat-group' },
          h('div', { class: 'muted small' }, groupName(g)),
          h('div', { class: 'chips' }, list.map(c => h('button', { class: 'chip' + (o.categoryIds.includes(c.id) ? ' on' : ''), disabled: ro, title: '#' + c.tag,
            onclick: () => setOpt({ categoryIds: o.categoryIds.includes(c.id) ? o.categoryIds.filter(x => x !== c.id) : [...o.categoryIds, c.id].sort((a, b) => this.categories.findIndex(x => x.id === a) - this.categories.findIndex(x => x.id === b)) }) }, c.name)))))),
      h('section', { class: 'side-card tpl-card' }, h('h3', {}, t('template')),
        this.packList.length ? [
          select([{ value: '', label: t('noTemplate') }, ...this.packList.map(p => ({ value: p.id, label: p.name }))], o.pack || '', v => setOpt({ pack: v || null, picks: [], overrides: {} }), { disabled: ro }),
          view ? [
            // what is picked (click to drop) and what it pulls in
            h('div', { class: 'tpl-sub' }, t('tplPicked')),
            view.picked.length ? h('div', { class: 'chips' },
              view.picked.map(it => h('button', { class: 'chip on', disabled: ro, title: itemTitle(it), onclick: () => pick(it.id) }, it.name, ' ✕')),
              Object.values(view.pulled).map(p => h('span', { class: 'chip inc', title: t('tplIncludedBy', p.by) }, p.name)))
              : h('p', { class: 'muted small' }, t('tplNone')),
            // relations between the picked people; "neither" hides a row until the picks change
            view.combos.filter(g => !dismissed.has(g.key) || g.options.some(x => x.picked)).map(g => h('div', { class: 'tpl-combo' },
              h('div', { class: 'muted small' }, g.members.join(' + ')),
              h('div', { class: 'chips' }, g.options.map(x => h('button', { class: 'chip' + (x.picked ? ' on' : x.pulled ? ' inc' : ''), disabled: ro,
                title: x.tags.length ? x.tags.map(y => '#' + y).join(' ') : t('tplMarkerOnly'), onclick: () => pick(x.id) }, h('b', {}, x.relName), ' ', x.name)),
                g.options.some(x => x.picked) ? null : h('button', { class: 'chip ghost', onclick: () => { dismissed.add(g.key); this.drawSide(); } }, t('tplNotCombo'))))),
            h('input', { type: 'search', placeholder: t('searchItems'), value: this.packQ || '', oninput: e => { this.packQ = e.target.value; clearTimeout(this.pqT); this.pqT = setTimeout(() => this.drawSide(), 250); } }),
            h('div', { class: 'tpl-browse' },
              view.favs.length && !this.packQ ? [h('div', { class: 'tpl-sub' }, t('tplFavs')), h('div', { class: 'chips' }, view.favs.map(f => h('span', { class: 'chip-pair' },
                h('button', { class: 'chip', disabled: ro, onclick: () => { dismissed.clear(); setOpt({ picks: f.ids.slice() }); } }, f.name),
                h('button', { class: 'chip ghost', disabled: ro, title: t('tplRemoveFav'), onclick: async () => { await call('deleteTplFav', { index: f.index }); this.drawSide(); } }, '✕'))))] : null,
              view.sections.map(sc => [h('div', { class: 'tpl-sub' }, sectionName(sc)), h('div', { class: 'chips' }, sc.items.map(itemChip))])),
            ro ? null : h('div', { class: 'tpl-actions' },
              h('button', { disabled: !o.picks.length, onclick: async () => {
                let name = view.picked.map(it => it.name).join(' + ');
                const ok = await modal(t('tplSaveFav'), h('label', { class: 'field' }, t('tplFavName'), h('input', { value: name, oninput: e => { name = e.target.value; } })), [{ label: t('cancel'), value: false }, { label: t('tplSaveFav'), value: true, class: 'primary' }]);
                if (ok && name.trim()) { await call('saveTplFav', { pack: o.pack, name, ids: o.picks }); this.drawSide(); }
              } }, t('tplSaveFav')),
              h('button', { disabled: !o.picks.length, onclick: () => { dismissed.clear(); setOpt({ picks: [], overrides: {} }); } }, t('tplClear'))),
          ] : null,
        ] : h('p', { class: 'muted small' }, t('noPacks'), ' ', h('a', { href: '#', 'data-go': 'tags' }, t('navTags')))),
      h('section', { class: 'side-card' }, h('h3', {}, t('extraTags')),
        extraInput = h('input', { placeholder: t('extraHint'), disabled: ro, onkeydown: e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const v = e.target.value.trim(); if (v) setOpt({ extra: [...o.extra, ...v.split(',').map(s => s.trim()).filter(Boolean)] }); } } }),
        h('div', { class: 'chips' }, o.extra.map(x => h('button', { class: 'chip', disabled: ro, onclick: () => setOpt({ extra: o.extra.filter(y => y !== x) }) }, '#' + x, ' ✕')))),
      h('section', { class: 'side-card' }, h('h3', {}, t('finalTags'), ' ', h('span', { class: 'muted small' }, tags.length)),
        (tagsRes.rows || []).length ? h('div', { class: 'tpl-actions' },
          flagged.length && !ro ? h('button', { onclick: () => setOpt({ overrides: { ...(o.overrides || {}), ...Object.fromEntries(flagged.map(r => [r.tag.toLowerCase(), false])) } }) }, t('dropFlagged', flagged.length))
            : h('span', { class: 'muted small' }, t('tplToggleHint')),
          h('button', { onclick: async e => {
            e.target.disabled = true; toast(t('checkingHeat'));
            try { await call('sampleTags', { tags: tagsRes.rows.map(r => r.tag) }); toast(t('checkedHeat'), 'ok'); } catch (err) { toast(cleanErr(err), 'error'); }
            this.drawSide();
          } }, t('checkHeat'))) : null,
        h('ol', { class: 'tag-order' }, tags.map((x, i) => {
          const r = x.from === 'template' ? rowOf.get(x.tag.toLowerCase()) : null;
          return [
            i === tagsRes.cuts[0] ? h('li', { class: 'cut' }, t('cutBlog', tagsRes.cuts[0])) : null,
            i === tagsRes.cuts[1] ? h('li', { class: 'cut' }, t('cutSite', tagsRes.cuts[1])) : null,
            h('li', { class: 'seg-' + x.from + (r ? ' flip' : '') + (r?.flag ? ' flag' : '') + (r?.forced ? ' forced' : ''), title: r ? rowTitle(r) : '', onclick: r && !ro ? () => flip(r) : null }, '#' + x.tag)];
        })),
        offRows.length ? [h('div', { class: 'tpl-sub' }, t('tagsOff')), h('div', { class: 'tag-off' }, offRows.map(r =>
          h('button', { class: 'chip struck', disabled: ro, title: rowTitle(r), onclick: () => flip(r) }, '#' + r.tag)))] : null),
      ro ? null : h('section', { class: 'side-card publish' },
        h('button', { class: 'primary big-btn', onclick: () => this.publish('published') }, t('publish')),
        h('div', { class: 'pub-more' },
          h('button', { onclick: () => this.publish('private') }, t('publishPrivate')),
          h('button', { onclick: () => this.publish('draft') }, t('saveTumblrDraft')),
          h('button', { onclick: () => this.publish('queue') }, t('addQueue')),
          h('button', { onclick: () => this.schedule() }, t('schedule'))),
        h('p', { class: 'muted small' }, t('localDraftNote')),
        h('button', { class: 'ghost danger', onclick: async () => { const ok = await modal(t('deleteDraft'), h('p', {}, t('deleteDraftQ')), [{ label: t('cancel'), value: false }, { label: t('delete'), value: true, class: 'danger' }]); if (ok) { await call('deleteDraft', { id: this.d.id }); this.render(this.root); } } }, t('deleteDraft'))),
    ];
    this.side.replaceChildren(...box);
  },

  // Editing a published post: the blog is fixed, visibility stays as it is, tags are the post's own list
  async drawEditSide() {
    const d = this.d, ro = this.readOnly();
    const tags = this.opts.tags || [];
    const k = x => String(x).toLowerCase();
    const setTags = next => { this.opts = { ...this.opts, tags: next }; this.scheduleSave(); this.drawSide(); };
    const has = tag => tags.some(x => k(x) === k(tag));
    const effects = await call('routeEffect', { blog: d.target_blog, tags });
    const tagsChanged = JSON.stringify(tags.map(k)) !== JSON.stringify((d.base?.tags || []).map(k));
    this.side.replaceChildren(
      h('section', { class: 'side-card' }, h('h3', {}, t('edTarget')),
        h('p', {}, h('b', {}, blogName(d.target_blog)), ' ', d.base?.state ? stateBadge(d.base.state) : null),
        h('p', { class: 'muted small' }, t('edSameLink'))),
      h('section', { class: 'side-card' }, h('h3', {}, t('category'), ' ', h('span', { class: 'muted small' }, t('optional'))),
        catSections(this.catGroups, this.categories).map(([g, list]) => h('div', { class: 'cat-group' },
          h('div', { class: 'muted small' }, groupName(g)),
          h('div', { class: 'chips' }, list.map(c => h('button', { class: 'chip' + (has(c.tag) ? ' on' : ''), disabled: ro, title: '#' + c.tag,
            onclick: () => setTags(has(c.tag) ? tags.filter(x => k(x) !== k(c.tag)) : [...tags, c.tag]) }, c.name)))))),
      h('section', { class: 'side-card' }, h('h3', {}, t('finalTags'), ' ', h('span', { class: 'muted small' }, tags.length)),
        h('div', { class: 'chips' }, tags.map(x => h('button', { class: 'chip', disabled: ro, title: t('delete'), onclick: () => setTags(tags.filter(y => y !== x)) }, '#' + x, ' ✕'))),
        h('input', { placeholder: t('extraHint'), disabled: ro, onkeydown: e => { if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) { e.preventDefault(); const v = e.target.value.split(/[,，]/).map(x => x.trim().replace(/^#/, '')).filter(Boolean); if (v.length) setTags([...tags, ...v.filter(x => !has(x))]); } } }),
        h('p', { class: 'muted small' }, t('edTagsNote')),
        tagsChanged ? h('p', { class: 'small' }, t('edTagsChanged')) : null),
      effects.length ? h('section', { class: 'side-card' }, h('h3', {}, t('edRoutes')),
        effects.map(ef => h('p', { class: 'small ' + (ef.excluded ? 'muted' : '') }, ef.excluded ? t('routeSkip', blogName(ef.dest), ef.excluded) : t('edRouteGo', blogName(ef.dest)))),
        h('p', { class: 'muted small' }, t('edRoutesNote'))) : null,
      ro ? null : h('section', { class: 'side-card publish' },
        h('button', { class: 'primary big-btn', onclick: () => this.submitEdit() }, t('edSubmit')),
        h('p', { class: 'muted small' }, t('edSubmitNote')),
        h('button', { class: 'ghost danger', onclick: async () => {
          const ok = await modal(t('edDiscard'), h('p', {}, t('edDiscardQ')), [{ label: t('cancel'), value: false }, { label: t('edDiscard'), value: true, class: 'danger' }]);
          if (ok) { await call('deleteDraft', { id: d.id }); this.goBack(); }
        } }, t('edDiscard'))));
  },
  async submitEdit() {
    await this.flush();
    if (this.saveState === 'error') return;
    try { await window.studio.call('submitEdit', { id: this.d.id }); toast(t('edQueued'), 'ok'); this.open(this.d.id); }
    catch (e) { toast(cleanErr(e), 'error'); }
  },

  async publish(mode, at = null) {
    await this.flush();
    if (this.saveState === 'error') return;
    try {
      await window.studio.call('publish', { id: this.d.id, mode, at });
      toast(t('publishQueued'), 'ok');
      this.open(this.d.id);
    } catch (e) { toast(cleanErr(e), 'error'); }
  },
  async schedule() {
    let v = '';
    const ok = await modal(t('schedule'), h('input', { type: 'datetime-local', oninput: e => { v = e.target.value; } }), [{ label: t('cancel'), value: false }, { label: t('schedule'), value: true, class: 'primary' }]);
    if (ok && v) this.publish('schedule', new Date(v).getTime());
  },

  async preview() {
    this.syncText();
    const c = await call('compileDraft', { doc: this.doc });
    const tags = this.isEdit() ? (this.opts.tags || []) : (await call('composeTags', this.opts)).tags.map(x => x.tag);
    const assetsById = this.assets;
    const blockById = new Map(this.doc.blocks.filter(b => b.type === 'image').map(b => [b.id, b]));
    const render = (width) => {
      const rows = c.layout[0]?.display || c.content.map((_, i) => ({ blocks: [i] }));
      const trunc = c.layout[0]?.truncate_after;
      return h('div', { class: 'npf-preview', style: { width: width + 'px' } }, rows.map(r => {
        const cells = r.blocks.map(i => {
          const b = c.content[i];
          if (b.type === 'image') { const src = b.media[0].identifier ? assetsById[blockById.get(b.media[0].identifier)?.asset]?.url : nearMedia(b.media); return h('img', { src, alt: b.alt_text || '' }); }
          if (b.type !== 'text' && b.type !== 'link') return h('div', { class: 'npf-link' }, '[' + b.type + ']');
          if (b.type === 'link') return h('div', { class: 'npf-link' }, '🔗 ', b.url);
          const el = h('div', { class: 'npf-text st-' + (b.subtype || 'p') });
          textToDom(el, b.text, b.formatting || []);
          return el;
        });
        const after = trunc != null && r.blocks.includes(trunc) ? h('div', { class: 'npf-more' }, t('blockReadMore')) : null;
        return [h('div', { class: 'npf-row n' + r.blocks.length }, cells), after];
      }), tags.length ? h('div', { class: 'npf-tags' }, tags.map(tg => h('span', {}, '#' + tg))) : null);
    };
    const holder = h('div', { class: 'preview-holder' }, render(540));
    const sizes = [{ value: 540, label: t('wide') }, { value: 320, label: t('narrow') }];
    const pick = w => { holder.replaceChildren(render(w)); const next = chips(sizes, w, pick); sizeChips.replaceWith(next); sizeChips = next; };
    let sizeChips = chips(sizes, 540, pick);
    const body = h('div', {}, sizeChips,
      c.problems.length ? h('p', { class: 'warn-text' }, c.problems.map(p => t('prob_' + p.problem)).join(' · ')) : null, holder,
      h('p', { class: 'muted small' }, t('previewNote')));
    await modal(t('preview'), body, [{ label: t('close'), value: null }], { wide: true });
  },

  refresh(ev) {
    if (ev.type === 'job' && this.d && ['publishing', 'submitting'].includes(this.d.status)) {
      clearTimeout(this.rt);
      this.rt = setTimeout(async () => { const d = await call('draft', { id: this.d.id }); if (d && d.status !== this.d.status) this.open(d.id, d); }, 500);
    }
  },
};

window.addEventListener('beforeunload', () => { if (App.pageName === 'write') WritePage.flush(); });
