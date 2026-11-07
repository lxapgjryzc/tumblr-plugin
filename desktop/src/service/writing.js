'use strict';
// Writing: local drafts (a structured document, autosaved), their image files, general categories, template
// packs, tag composition and publishing.
//
// The document is the source of truth: { v: 1, blocks: [...], rows: [[id, id], ...] }. Blocks have stable ids;
// an image block is one image occurrence (the same file used twice is two occurrences). rows lists the image
// groups shown side by side; everything else is one block per row. Markdown is never the storage format.
//
// Images are uploaded inside the single create request (multipart, one part per occurrence id), so a slow or
// failed upload can't land in the wrong place: the order is the document's order at the moment of publishing.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { J, P } = require('./db');
const C = require('./core');
const { upsertPost } = require('./posts');
const routes = require('./routes');
const { fresh, verifyStep } = require('./ops');
const { UnsupportedError, StaleError } = require('./errors');

const DOC_VERSION = 1;
const CONVERTER = 'npf-1';
const MAX_ROW = 3; // images side by side; Tumblr's editor offers up to 3
const SUBTYPES = ['heading1', 'heading2', 'quote', 'indented', 'chat', 'quirky', 'ordered-list-item', 'unordered-list-item'];
const FORMATS = ['bold', 'italic', 'strikethrough', 'small', 'link', 'color'];
// The flat list older versions seeded; kept only to recognise untouched seeds during the grouped migration
const CATEGORY_SUGGESTIONS = [['Diary', 'diary'], ['Fanart', 'fanart'], ['Original', 'original'], ['Photo', 'photo'], ['Writing', 'writing']];
const CATEGORY_DEFAULTS = path.join(__dirname, 'categories.default.json');
const cpLen = s => [...String(s)].length;

const emptyDoc = () => ({ v: DOC_VERSION, blocks: [{ id: 'b' + crypto.randomBytes(5).toString('hex'), type: 'text', text: '' }], rows: [] });

// Keep the document consistent: rows only hold existing, adjacent image blocks, 2..MAX_ROW per row
function normaliseDoc(doc) {
  const blocks = (doc.blocks || []).filter(b => b && b.id && ['text', 'image', 'link', 'readmore'].includes(b.type));
  const idx = new Map(blocks.map((b, i) => [b.id, i]));
  const used = new Set();
  const rows = [];
  for (const r of doc.rows || []) {
    const ids = [...new Set(r)].filter(id => idx.has(id) && blocks[idx.get(id)].type === 'image' && !used.has(id)).sort((a, b) => idx.get(a) - idx.get(b));
    // split into adjacent runs
    let run = [];
    const flush = () => { for (let i = 0; i < run.length; i += MAX_ROW) { const part = run.slice(i, i + MAX_ROW); if (part.length > 1) { rows.push(part); part.forEach(x => used.add(x)); } } run = []; };
    for (const id of ids) {
      if (run.length && idx.get(id) !== idx.get(run[run.length - 1]) + 1) flush();
      run.push(id);
    }
    flush();
  }
  // at most one read-more
  let seenMore = false;
  const out = blocks.filter(b => b.type !== 'readmore' || (!seenMore && (seenMore = true)));
  return { ...doc, v: DOC_VERSION, blocks: out, rows: rows.filter(r => r.every(id => out.some(b => b.id === id))) };
}

// Document -> NPF { content, layout, problems }. assetsById: id -> { file, mime, width, height }
function compile(doc, assetsById = new Map()) {
  doc = normaliseDoc(doc);
  const content = [], problems = [], map = new Map();
  let truncateAfter = null;
  for (const b of doc.blocks) {
    if (b.type === 'readmore') { if (content.length) truncateAfter = content.length - 1; continue; }
    map.set(b.id, content.length);
    if (b.type === 'text') {
      const blk = { type: 'text', text: String(b.text || '') };
      if (b.subtype && SUBTYPES.includes(b.subtype)) blk.subtype = b.subtype;
      const n = cpLen(blk.text);
      const f = (b.formatting || []).filter(x => FORMATS.includes(x.type) && x.start >= 0 && x.end <= n && x.start < x.end)
        .map(x => ({ type: x.type, start: x.start, end: x.end, ...(x.type === 'link' ? { url: x.url } : {}), ...(x.type === 'color' ? { hex: x.hex } : {}) }));
      if (f.length) blk.formatting = f;
      content.push(blk);
    } else if (b.type === 'image') {
      const a = assetsById.get(b.asset);
      if (!a || !a.exists) problems.push({ block: b.id, problem: 'missing_image' });
      const blk = { type: 'image', media: [{ type: a?.mime || 'image/jpeg', identifier: b.id, width: a?.width || undefined, height: a?.height || undefined }] };
      if (b.alt) blk.alt_text = String(b.alt);
      if (b.caption) blk.caption = String(b.caption);
      content.push(blk);
    } else if (b.type === 'link') {
      if (!/^https?:\/\//i.test(b.url || '')) problems.push({ block: b.id, problem: 'bad_link' });
      content.push({ type: 'link', url: String(b.url || ''), ...(b.title ? { title: String(b.title) } : {}) });
    }
  }
  // empty trailing text blocks are dropped (an empty editor line is not content)
  while (content.length && content[content.length - 1].type === 'text' && !content[content.length - 1].text.trim()) {
    const id = [...map.entries()].find(([, i]) => i === content.length - 1)?.[0];
    if (id) map.delete(id);
    content.pop();
  }
  if (!content.length) problems.push({ problem: 'empty' });
  let layout = [];
  if (doc.rows.length || truncateAfter !== null) {
    const inRow = new Map();
    for (const r of doc.rows) for (const id of r) inRow.set(id, r);
    const display = [], done = new Set();
    for (const b of doc.blocks) {
      if (!map.has(b.id) || done.has(b.id)) continue;
      const r = inRow.get(b.id);
      if (r) { display.push({ blocks: r.filter(id => map.has(id)).map(id => map.get(id)) }); r.forEach(id => done.add(id)); }
      else display.push({ blocks: [map.get(b.id)] });
    }
    const l = { type: 'rows', display };
    if (truncateAfter !== null && truncateAfter < content.length - 1) l.truncate_after = truncateAfter;
    layout = [l];
  }
  return { content, layout, problems };
}

// Final tag order: general categories → template tags → hand-written extras. Duplicates keep the earliest
// segment's spelling. Returns [{ tag, from: 'category' | 'template' | 'extra' }].
function composeTags({ categories = [], template = [], extra = [] }) {
  const out = [], seen = new Set();
  const push = (tags, from) => { for (const t of tags) { const n = C.norm(t); const k = C.key(n); if (!k || seen.has(k)) continue; seen.add(k); out.push({ tag: n, from }); } };
  push(categories, 'category'); push(template, 'template'); push(extra, 'extra');
  return out;
}

function addWriting(svc, api, { dataDir }) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;
  const assetDir = path.join(dataDir, 'assets');

  const assetRow = id => {
    const a = db.get('SELECT * FROM assets WHERE id = ?', id);
    if (!a) return null;
    const file = path.join(assetDir, a.file);
    return { ...a, path: file, url: pathToFileURL(file).href, exists: fs.existsSync(file) };
  };
  const assetsOf = doc => new Map((doc.blocks || []).filter(b => b.type === 'image' && b.asset).map(b => [b.asset, assetRow(b.asset)]).filter(([, a]) => a));

  // ----- categories -----
  // Groups come from categories.default.json once. An existing category with the same tag joins its group and
  // keeps its id, name, tag and draft/default selections; anything else stays ungrouped (never deleted, never
  // given an invented course or role). Nothing remote changes.
  function seedCategories() {
    if (db.getMeta('categoryGroupsSeeded')) return;
    let conf = { groups: [] };
    try { conf = JSON.parse(fs.readFileSync(CATEGORY_DEFAULTS, 'utf8')); } catch {}
    db.tx(() => {
      conf.groups.forEach((g, gi) => {
        const gid = Number(db.run('INSERT INTO category_groups (key, name, ord) VALUES (?, NULL, ?)', g.key || null, gi).lastInsertRowid);
        (g.categories || []).forEach((c, ci) => {
          const have = db.all('SELECT id, tag, group_id FROM categories').find(x => C.key(x.tag) === C.key(c.tag));
          if (have) { if (have.group_id == null) db.run('UPDATE categories SET group_id = ?, ord = ? WHERE id = ?', gid, ci, have.id); }
          else db.run('INSERT INTO categories (name, tag, ord, group_id) VALUES (?, ?, ?, ?)', c.name, c.tag, ci, gid);
        });
      });
      db.setMeta('categoriesSeeded', true);
      db.setMeta('categoryGroupsSeeded', true);
    });
  }
  // Default tags that changed (`was`): a category still holding a default name (or the old flat seed's name) and
  // an earlier default tag moves to the new tag, once. Ids, selections and posts are untouched; nothing remote.
  function upgradeDefaultTags() {
    if (db.getMeta('categoryTagsUpgraded')) return;
    let conf = { groups: [] };
    try { conf = JSON.parse(fs.readFileSync(CATEGORY_DEFAULTS, 'utf8')); } catch {}
    db.tx(() => {
      const all = db.all('SELECT id, name, tag FROM categories');
      for (const c of conf.groups.flatMap(g => g.categories || [])) {
        if (!c.was || all.some(x => C.key(x.tag) === C.key(c.tag))) continue;
        const hit = all.find(x => c.was.some(w => C.key(w) === C.key(x.tag))
          && (x.name === c.name || CATEGORY_SUGGESTIONS.some(([n, t]) => n === x.name && C.key(t) === C.key(x.tag))));
        if (hit) { db.run('UPDATE categories SET tag = ? WHERE id = ?', c.tag, hit.id); hit.tag = c.tag; }
      }
      // Retired defaults go only while untouched and selected nowhere (drafts, blog defaults)
      const selected = new Set([
        ...db.all('SELECT options FROM drafts').flatMap(r => { try { return JSON.parse(r.options || '{}').categoryIds || []; } catch { return []; } }),
        ...Object.values(db.getMeta('blogDefaults') || {}).flatMap(d => (d && d.categoryIds) || [])].map(Number));
      for (const r of conf.retired || []) {
        const hit = all.find(x => x.name === r.name && C.key(x.tag) === C.key(r.tag));
        if (hit && !selected.has(Number(hit.id))) db.run('DELETE FROM categories WHERE id = ?', hit.id);
      }
      db.setMeta('categoryTagsUpgraded', true);
    });
  }
  upgradeDefaultTags(); // first, so seeding finds the moved tags instead of adding duplicates
  seedCategories();
  const groupsList = () => db.all('SELECT * FROM category_groups ORDER BY ord, id');
  // Configured order: group order, then category order inside the group; ungrouped entries last
  const categories = () => db.all(`SELECT c.* FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id
    ORDER BY c.group_id IS NULL, g.ord, g.id, c.ord, c.id`);
  const orderedTags = ids => { const want = new Set(ids.map(Number)); return categories().filter(c => want.has(c.id)).map(c => c.tag); };

  // ----- packs (same format as the extension's) -----
  const packsRaw = () => db.getMeta('packs', []); // [{ raw, source, edited }]
  const packDir = () => [path.join(__dirname, 'packs'), path.join(__dirname, '..', '..', '..', 'packs')].find(d => fs.existsSync(d));
  function parsedPacks() {
    const out = [];
    for (const p of packsRaw()) { try { out.push(C.parsePack(p.raw)); } catch {} }
    return out;
  }

  function draftOut(r) {
    if (!r) return null;
    const doc = P(r.doc, emptyDoc());
    const assets = {};
    for (const [id, a] of assetsOf(doc)) assets[id] = { url: a.url, exists: a.exists, width: a.width, height: a.height, mime: a.mime };
    return { ...r, doc, options: P(r.options, {}), assets };
  }
  const titleOf = doc => (doc.blocks || []).find(b => b.type === 'text' && b.text?.trim())?.text.trim().slice(0, 60) || '';

  Object.assign(api, {
    categories,
    categoryGroups: groupsList,
    // A name change is display only: the tag it puts on posts stays until the tag itself is edited, and
    // changing the tag affects future posts only (old originals need a separate previewed batch; reblogs never).
    saveCategory({ id, name, tag, group_id }) {
      if (id && tag == null) tag = db.get('SELECT tag FROM categories WHERE id = ?', id)?.tag;
      tag = C.norm(tag || name || '').trim(); name = String(name || tag).trim();
      if (!tag) throw new Error('a category needs a tag');
      const gid = group_id === undefined ? undefined : (group_id ? Number(group_id) : null);
      if (id) {
        db.run('UPDATE categories SET name = ?, tag = ? WHERE id = ?', name, tag, id);
        if (gid !== undefined) db.run('UPDATE categories SET group_id = ?, ord = (SELECT COALESCE(MAX(ord), -1) + 1 FROM categories WHERE group_id IS ?) WHERE id = ? AND group_id IS NOT ?', gid, gid, id, gid);
      } else db.run('INSERT INTO categories (name, tag, group_id, ord) VALUES (?, ?, ?, (SELECT COALESCE(MAX(ord), -1) + 1 FROM categories WHERE group_id IS ?))', name, tag, gid ?? null, gid ?? null);
      return categories();
    },
    deleteCategory({ id }) { db.run('DELETE FROM categories WHERE id = ?', id); return categories(); },
    orderCategories({ ids }) { db.tx(() => ids.forEach((id, i) => db.run('UPDATE categories SET ord = ? WHERE id = ?', i, id))); return categories(); },
    saveCategoryGroup({ id, name }) {
      name = String(name || '').trim() || null;
      if (id) db.run('UPDATE category_groups SET name = ? WHERE id = ?', name, id);
      else db.run('INSERT INTO category_groups (key, name, ord) VALUES (NULL, ?, (SELECT COALESCE(MAX(ord), -1) + 1 FROM category_groups))', name);
      return groupsList();
    },
    // Its categories move to the ungrouped area; none is deleted
    deleteCategoryGroup({ id }) { db.tx(() => { db.run('UPDATE categories SET group_id = NULL WHERE group_id = ?', id); db.run('DELETE FROM category_groups WHERE id = ?', id); }); return groupsList(); },
    orderCategoryGroups({ ids }) { db.tx(() => ids.forEach((id, i) => db.run('UPDATE category_groups SET ord = ? WHERE id = ?', i, id))); return groupsList(); },

    packs() {
      return packsRaw().map((p, i) => { try { const x = C.parsePack(p.raw); return { i, id: x.id, name: x.name, version: x.version, items: x.items.size, source: p.source || '', edited: !!p.edited }; } catch (e) { return { i, error: e.message }; } });
    },
    installPack({ raw, source = '' }) {
      const x = C.parsePack(raw); // throws a readable error
      const list = packsRaw().filter(p => { try { return C.parsePack(p.raw).id !== x.id; } catch { return true; } });
      list.push({ raw: typeof raw === 'string' ? JSON.parse(raw) : raw, source, edited: false });
      db.setMeta('packs', list);
      return api.packs();
    },
    // Packs maintained in the repository (packs/*.json), offered for one-click install
    bundledPacks() {
      const dir = packDir();
      if (!dir) return [];
      return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
        try { const x = C.parsePack(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); return { file: f, id: x.id, name: x.name, version: x.version, items: x.items.size }; } catch { return null; }
      }).filter(Boolean);
    },
    installBundled({ file }) {
      const dir = packDir();
      if (!dir || !/^[\w.-]+\.json$/.test(file)) throw new Error('not found');
      return api.installPack({ raw: fs.readFileSync(path.join(dir, file), 'utf8'), source: 'bundled:' + file });
    },
    removePack({ id }) {
      db.setMeta('packs', packsRaw().filter(p => { try { return C.parsePack(p.raw).id !== id; } catch { return true; } }));
      return api.packs();
    },
    // Items of one pack for the picker: [{ id, name, kind, tags }]
    packItems({ id, q = '' }) {
      const p = parsedPacks().find(x => x.id === id);
      if (!p) return [];
      return C.searchItems(p, q).map(it => ({ id: it.id, name: it.name, kind: it.kind, tags: it.tags.slice(), with: it.with.slice() }));
    },
    // The composer's picker, as the browser panel shows it: the pack's sections (relations only while searching;
    // otherwise they are offered once their members are picked), what the picks pull in, and those relations
    packView({ id, q = '', picks = [] }) {
      const p = parsedPacks().find(x => x.id === id);
      if (!p) return null;
      const item = it => ({ id: it.id, name: it.name, kind: it.kind, rel: it.rel || null, tags: it.tags.slice() });
      const match = new Set(C.searchItems(p, q).filter(it => q || !it.rel).map(it => it.id));
      const sections = p.sections.map(s => ({ name: s.name || null, kind: s.kind, items: s.items.filter(it => match.has(it.id)).map(item) })).filter(s => s.items.length);
      const picked = new Set(picks);
      const pulled = {}; // item id -> name of the picked item that pulled it in
      for (const pid of picks) for (const it of C.expandPicks(p, [pid])) if (!picked.has(it.id) && !pulled[it.id]) pulled[it.id] = { name: it.name, by: p.items.get(pid)?.name || pid };
      const order = ['romance', 'friendship', 'family'];
      const rank = o => (order.indexOf(o.item.rel) + 1 || order.length + 1);
      const combos = C.suggestCombos(p, picks).map(g => ({ key: g.key, members: g.members.map(m => m.name),
        options: g.options.slice().sort((a, b) => rank(a) - rank(b)).map(o => ({ ...item(o.item), relName: p.types[o.item.rel] || o.item.rel, picked: o.picked, pulled: o.pulled })) }));
      return { id: p.id, sections, picked: picks.map(x => p.items.get(x)).filter(Boolean).map(item), pulled, combos,
        favs: db.getMeta('tplFavs', []).map((f, i) => ({ ...f, index: i })).filter(f => f.pack === p.id) };
    },
    // Picking in the composer, with the browser panel's rules: a preset adds its members (each can then be
    // dropped), and dropping someone also drops the relations they are part of
    togglePick({ id, picks = [], item }) {
      const p = parsedPacks().find(x => x.id === id);
      const it = p?.items.get(item);
      if (!it) return picks;
      if (it.kind === 'preset') return [...new Set([...picks, ...it.with])];
      if (picks.includes(item)) return picks.filter(x => x !== item && !(p.items.get(x)?.rel && p.items.get(x).with.includes(item)));
      return [...picks, item];
    },
    // Saved combinations of picks, per pack (the app's own; the browser panel keeps its own list)
    saveTplFav({ pack, name, ids }) {
      name = String(name || '').trim();
      if (!pack || !name || !ids?.length) throw new Error('a saved combination needs a name and picks');
      const all = db.getMeta('tplFavs', []);
      all.push({ pack, name, ids: ids.slice() });
      db.setMeta('tplFavs', all);
      return all;
    },
    deleteTplFav({ index }) { const all = db.getMeta('tplFavs', []); all.splice(index, 1); db.setMeta('tplFavs', all); return all; },
    // Tags for a draft's choices, in final order, with the search cutoffs
    // rows: the template's tags with why a tag is off or flagged (the browser panel's preview), for the editor
    composeTags({ categoryIds = [], pack = null, picks = [], extra = [], overrides = {} }) {
      const cats = orderedTags(categoryIds);
      let template = [], rows = [];
      if (pack && picks.length) {
        const packs = parsedPacks();
        const p = packs.find(x => x.id === pack);
        if (p) {
          const stats = db.getMeta('tagStats', {});
          const settings = db.getMeta('settings', {});
          const res = C.composeTemplate(p, { ids: picks, stats, overrides: overrides || {}, rules: settings.rules, useBase: settings.useBase !== false, exclude: cats });
          template = C.sortTagsFair(res.tags.slice(), stats, { groups: C.packGrouping(packs).groups });
          // in final order, then the tags left out
          const at = new Map(template.map((tg, i) => [C.key(tg), i]));
          const heat = tg => { const st = stats[C.key(tg)]; return st ? { followers: st.followers ?? null, notes: st.notes ?? null, match: st.match ?? null } : null; };
          rows = res.rows.map(r => ({ tag: r.tag, on: r.on, why: r.why, flag: r.flag, forced: r.forced, fit: r.fit, rank: r.rank, of: r.of, heat: heat(r.tag) }))
            .sort((a, b) => (at.get(C.key(a.tag)) ?? 1e9) - (at.get(C.key(b.tag)) ?? 1e9));
        }
      }
      const tags = composeTags({ categories: cats, template, extra });
      return { tags, rows, cuts: C.TPL_SEARCH_CUTS.slice() };
    },
    blogDefaults({ blog }) { return db.getMeta('blogDefaults', {})[blog] || null; },
    setBlogDefaults({ blog, defaults }) { const all = db.getMeta('blogDefaults', {}); all[blog] = defaults; db.setMeta('blogDefaults', all); return all[blog]; },

    // ----- drafts -----
    drafts() {
      return db.all(`SELECT id, blog, doc, status, remote_blog, remote_id, updated_at FROM drafts WHERE status != 'published' ORDER BY updated_at DESC`).map(r => {
        const doc = P(r.doc, emptyDoc());
        const img = doc.blocks.find(b => b.type === 'image');
        return { id: r.id, blog: r.blog, status: r.status, updated_at: r.updated_at, title: titleOf(doc), thumb: img ? assetRow(img.asset)?.url : null };
      });
    },
    draft({ id }) { return draftOut(db.get('SELECT * FROM drafts WHERE id = ?', id)); },
    newDraft({ blog = null } = {}) {
      const def = blog ? api.blogDefaults({ blog }) : null;
      const options = { categoryIds: def?.categoryIds || [], pack: def?.pack || null, picks: def?.picks || [], extra: [], state: 'published', fromDefaults: !!def };
      const r = db.run('INSERT INTO drafts (blog, doc, options, revision, status, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)', blog, J(emptyDoc()), J(options), 'editing', now(), now());
      return api.draft({ id: Number(r.lastInsertRowid) });
    },
    // Autosave. revision = the revision the editor started from; a mismatch means another save won.
    saveDraft({ id, doc, options, revision, blog }) {
      const cur = db.get('SELECT revision, status FROM drafts WHERE id = ?', id);
      if (!cur) throw new Error('draft not found');
      if (cur.status === 'publishing') throw new Error('the draft is being published');
      if (revision != null && cur.revision !== revision) throw new Error('conflict: the draft was saved elsewhere (reload it)');
      const clean = normaliseDoc(doc);
      db.run('UPDATE drafts SET doc = ?, options = ?, blog = ?, revision = revision + 1, updated_at = ? WHERE id = ?', J(clean), J(options || {}), blog ?? null, now(), id);
      return { revision: cur.revision + 1, saved_at: now() };
    },
    deleteDraft({ id }) {
      const d = db.get('SELECT status FROM drafts WHERE id = ?', id);
      if (d?.status === 'publishing') throw new Error('the draft is being published');
      db.run('DELETE FROM drafts WHERE id = ?', id);
      return true;
    },
    // Image bytes from the window (file picker or paste). Stored by content hash; each insertion is its own block.
    addAsset({ draftId, name = 'image', mime = 'image/png', bytes, width = null, height = null }) {
      const buf = Buffer.from(bytes);
      if (!buf.length) throw new Error('empty image');
      if (buf.length > 20 * 1024 * 1024) throw new Error('image larger than 20 MB');
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new Error('unsupported image type ' + mime);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime];
      const file = sha.slice(0, 2) + '/' + sha + '.' + ext;
      const full = path.join(assetDir, file);
      if (!fs.existsSync(full)) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full + '.tmp', buf); fs.renameSync(full + '.tmp', full); }
      const id = 'a' + sha.slice(0, 24);
      db.run(`INSERT INTO assets (id, draft_id, file, sha256, mime, width, height, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`, id, draftId ?? null, file, sha, mime, width, height, buf.length, now());
      const a = assetRow(id);
      return { id, url: a.url, width: a.width, height: a.height, mime, name };
    },
    compileDraft({ doc }) { return compile(doc, assetsOf(doc)); },
    // Where a post would go: the destination, and what each enabled route would do with these tags
    routeEffect({ blog, tags = [] }) {
      return routes.routesOf(db).filter(r => r.enabled && r.sources.includes(blog)).map(r => {
        const ex = routes.excludedBy(tags, r.exclude);
        return { route: r.id, dest: r.dest, excluded: ex };
      });
    },
    // Publish: freeze this revision, queue the create. mode: published | private | draft | queue | schedule
    publish({ id, mode = 'published', at = null }) {
      const d = db.get('SELECT * FROM drafts WHERE id = ?', id);
      if (!d) throw new Error('draft not found');
      if (d.status === 'publishing') throw new Error('already publishing');
      if (d.status === 'published') throw new Error('already published');
      if (!d.blog) throw new Error('choose a blog');
      const doc = P(d.doc), opts = P(d.options, {});
      const c = compile(doc, assetsOf(doc));
      if (c.problems.length) throw new Error('fix first: ' + c.problems.map(p => p.problem).join(', '));
      const tags = api.composeTags(opts).tags.map(x => x.tag);
      const state = mode === 'schedule' ? 'queue' : mode;
      if (mode === 'schedule' && !at) throw new Error('choose a time');
      db.run(`UPDATE drafts SET status = 'publishing', updated_at = ? WHERE id = ?`, now(), id);
      // remember this blog's choices for the next post (never applied to existing drafts)
      api.setBlogDefaults({ blog: d.blog, defaults: { categoryIds: opts.categoryIds || [], pack: opts.pack || null, picks: opts.picks || [] } });
      const jid = jobs.add('post.publish', { draft: id, revision: d.revision, blog: d.blog, doc, tags, state, publishOn: at, startedAt: now() }, { priority: 1, scope: `draft:${id}` });
      return { job: jid };
    },
    // After a failed publish: back to editing (the frozen job is finished, the draft is untouched)
    reopenDraft({ id }) {
      const open = db.get(`SELECT id FROM jobs WHERE scope = ? AND status IN ('pending', 'running', 'verifying', 'waiting', 'unknown')`, `draft:${id}`);
      if (open) throw new Error('the publish is still in progress or its outcome is unknown');
      db.run(`UPDATE drafts SET status = 'editing' WHERE id = ? AND status IN ('publishing', 'failed')`, id);
      return api.draft({ id });
    },
  });

  // ----- the publish job -----
  const boxOf = state => (state === 'draft' ? 'draft' : state === 'queue' ? 'queue' : '');
  // The body as far as it can be compared after the fact, block by block in order: text (subtype, text and
  // every formatting range with its link/colour), links (url), images (alt text, caption; the files come back
  // as Tumblr's copies) and any other block by type, plus the layout's rows, order and read-more. A link title
  // we set must come back too (sameBody); one Tumblr fills in itself is not compared.
  // Tumblr returns URLs percent-encoded (non-ASCII paths, %XX), so both sides are compared in one decoded form
  const urlKey = u => { const s = String(u || '').trim(); try { return decodeURI(new URL(s).href); } catch { return s; } };
  const fmtKey = f => (f || []).map(x => JSON.stringify([x.type, x.start, x.end, x.url ? urlKey(x.url) : '', String(x.hex || '').toLowerCase()])).sort();
  const blockKey = b => b.type === 'text' ? ['t', b.subtype || '', (b.text || '').trim(), fmtKey(b.formatting)]
    : b.type === 'image' ? ['i', b.alt_text || '', b.caption || '']
      : b.type === 'link' ? ['l', urlKey(b.url)]
        : ['?', b.type || ''];
  const layoutKey = (layout, n) => {
    const l = (layout || []).find(x => x.type === 'rows');
    if (!l) return [];
    const rows = (l.display || []).map(r => r.blocks || []);
    const plain = rows.every((r, i) => r.length === 1 && r[0] === i) && rows.length === n;
    return [plain ? [] : rows, l.truncate_after ?? null];
  };
  const bodyKey = (content = [], layout = []) => {
    const c = content || [];
    const lk = layoutKey(layout, c.length);
    return JSON.stringify([c.map(blockKey), lk.length && (lk[0].length || lk[1] !== null) ? lk : []]);
  };
  const sameBody = (want, got) => bodyKey(want.content, want.layout) === bodyKey(got.content, got.layout)
    && (want.content || []).every((b, i) => b.type !== 'link' || !b.title || (got.content || [])[i]?.title === b.title);
  const tagKey = tags => JSON.stringify((tags || []).map(C.key));
  // Every post since shortly before the publish started, however many pages that takes (newest first, so it
  // stops at the first older post; MAX_PAGES is only a safety net, and the result then says it was cut short)
  const MAX_PAGES = 40;
  async function findPublished(ctx, p) {
    const want = compile(p.doc, assetsOf(p.doc));
    const tags = tagKey(p.tags), since = p.startedAt - 120e3;
    const found = [];
    let next = null, complete = false;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await ctx.tumblr.postsPage(p.blog, { box: boxOf(p.state), next });
      let older = false;
      for (const q of page.posts) {
        const ts = (q.timestamp || 0) * 1000;
        if (ts && ts < since) { older = true; continue; }
        if (sameBody(want, q) && tagKey(q.tags) === tags) found.push(String(q.id_string ?? q.id));
      }
      next = page.next;
      // the queue is ordered by publish time, not creation time: read all of it
      if (!next || (older && p.state !== 'queue')) { complete = true; break; }
    }
    return { found, complete };
  }
  function done(ctx, p, remoteId, row) {
    db.run(`UPDATE drafts SET status = 'published', remote_blog = ?, remote_id = ?, published_revision = ?, remote_fingerprint = ?, updated_at = ? WHERE id = ?`,
      p.blog, remoteId, p.revision, row?.fingerprint || null, now(), p.draft);
    const auto = db.getMeta('automation', {});
    if (auto.routes && row?.state === 'published') { svc.ctx.service && require('./groups').rebuild(db, now()); routes.plan(db, jobs, now()); }
  }
  svc.handlers['post.publish'] = {
    creates: true,
    async run(job, ctx) {
      const p = job.payload;
      if (p.phase === 'verify') {
        const { row } = await fresh(ctx, p.blog, p.remoteId);
        const okTags = JSON.stringify(row.tags.map(C.key)) === JSON.stringify(p.tags.map(C.key));
        const okState = p.state === 'published' ? row.state === 'published' : p.state === 'private' ? row.state === 'private' : true;
        const want = compile(p.doc, assetsOf(p.doc));
        const stored = ctx.db.get('SELECT payload FROM posts WHERE blog = ? AND id = ?', p.blog, p.remoteId);
        const got = (stored && P(stored.payload)) || {};
        const okBody = sameBody(want, got);
        return verifyStep(ctx, job, okTags && okState && okBody, { status: 'succeeded', result: { id: p.remoteId, state: row.state, tags: row.tags, images: (got.content || []).filter(b => b.type === 'image').length } });
      }
      const d = db.get('SELECT status, revision FROM drafts WHERE id = ?', p.draft);
      if (!d) throw new StaleError('the draft was deleted');
      const assets = assetsOf(p.doc);
      const c = compile(p.doc, assets);
      if (c.problems.length) { db.run(`UPDATE drafts SET status = 'failed' WHERE id = ?`, p.draft); throw new UnsupportedError('cannot publish: ' + c.problems.map(x => x.problem).join(', ')); }
      const files = [];
      for (const b of p.doc.blocks.filter(b => b.type === 'image')) {
        const a = assets.get(b.asset);
        files.push({ identifier: b.id, blob: new Blob([fs.readFileSync(a.path)], { type: a.mime }), filename: path.basename(a.path) });
      }
      const json = { content: c.content, layout: c.layout, state: p.state, tags: p.tags.join(',') };
      if (p.publishOn) json.publish_on = new Date(p.publishOn).toISOString();
      let id;
      try { id = await ctx.tumblr.createPost(p.blog, json, files); }
      catch (e) { if (!e.uncertain && !(e instanceof require('./errors').NetError)) db.run(`UPDATE drafts SET status = 'failed' WHERE id = ?`, p.draft); throw e; }
      if (!id) return { status: 'unknown', error: 'no id in the response', nextAt: now() + 30_000 };
      let row = null;
      try { row = (await fresh(ctx, p.blog, id)).row; } catch {}
      done(ctx, p, id, row);
      return { status: 'verifying', payload: { ...p, phase: 'verify', verifyN: 0, remoteId: id }, nextAt: now() + 2000, result: { id } };
    },
    // A create whose response was lost. Not finding it never counts as "it wasn't created": the job stays
    // unknown (and keeps looking, less often) until it is found or you resolve it after checking Tumblr.
    // A found post is verified like a fresh one before the draft counts as published.
    async reconcile(job, ctx) {
      const p = job.payload;
      const { found, complete } = await findPublished(ctx, p);
      const tries = (job.result?.reconciles || 0) + 1;
      if (found.length === 1) {
        const { row } = await fresh(ctx, p.blog, found[0]);
        done(ctx, p, found[0], row);
        return { status: 'verifying', payload: { ...p, phase: 'verify', verifyN: 0, remoteId: found[0] }, nextAt: now() + 2000, result: { id: found[0], reconciled: true } };
      }
      if (found.length > 1) return { status: 'unknown', error: `several matching posts (${found.join(', ')}); check on Tumblr`, nextAt: now() + 365 * 86400e3, result: { reconciles: tries, found, needsUser: true } };
      const needsUser = tries >= 5;
      const error = needsUser
        ? `not found${complete ? '' : ` in the newest ${MAX_PAGES} pages`}; check on Tumblr, then choose “It wasn't created” to edit and publish again`
        : 'looking for the post on Tumblr';
      return { status: 'unknown', error, nextAt: now() + (needsUser ? 6 * 3600e3 : 60_000 * tries), result: { reconciles: tries, needsUser } };
    },
    // You checked Tumblr and the post isn't there: the draft can be edited and published again
    abandon(job) { db.run(`UPDATE drafts SET status = 'failed' WHERE id = ? AND status = 'publishing'`, job.payload.draft); },
  };
}

module.exports = { addWriting, compile, composeTags, normaliseDoc, emptyDoc, MAX_ROW };
