'use strict';
// The Posts page's one query (docs/CONTENT_BROWSER_UX_SPEC.md). The list, its total, the category counts, the tag
// suggestions and "select every match" all run the same definition over the same local rows, so they can't
// disagree. Pure read: nothing here queues a job or changes a post.
//
// Units: the managed view has one unit per work (its owned original; an external reblog stands for itself; a work
// whose original isn't readable is one unit with unknown data). The displayed view has one unit per actual post,
// judged by its own tags. Tag matching is on whole tags by core key() identity on both sides; text search is a
// literal, case-insensitive substring (no SQL patterns).

const { P } = require('./db');
const display = require('./display');
const C = require('./core');

const QUERY_VERSION = 2;
const OPEN_JOB = ['pending', 'running', 'verifying', 'waiting'];
const k = s => C.key(String(s ?? ''));

// Any older shape (tags: [...] = all of them, tag, share: bool, expiring: true) -> the current one
function normQuery(q = {}) {
  const view = q.view === 'displayed' || q.expiring ? 'displayed' : 'managed';
  const legacy = [...(q.tag ? [q.tag] : []), ...(Array.isArray(q.tags) ? q.tags : [])];
  const tg = q.tags && !Array.isArray(q.tags) ? q.tags : {};
  const uniq = list => { const seen = new Set(); return (list || []).map(x => C.norm(String(x))).filter(x => x && !seen.has(k(x)) && seen.add(k(x))); };
  const cats = {};
  for (const [g, c] of Object.entries(q.cats || {})) {
    const inc = [...new Set((c.inc || []).map(Number))], exc = [...new Set((c.exc || []).map(Number))].filter(x => !inc.includes(x));
    if (inc.length || exc.length || c.unset) cats[g] = { mode: c.mode === 'all' ? 'all' : 'any', inc: c.unset ? [] : inc, exc, unset: !!c.unset };
  }
  const exp = q.expiring ? { days: Math.max(1, Math.min(365, Number(q.expiring.days ?? q.expiringDays ?? 7) || 7)) } : null;
  return {
    v: QUERY_VERSION, view,
    scope: q.scope ? (q.scope === 'share' ? 'share' : 'all') : q.share ? 'share' : 'all',
    blog: q.blog || null,
    text: String(q.text ?? q.q ?? '').trim(),
    state: exp ? 'published' : (q.state || null),
    kind: view === 'displayed' ? (q.kind || null) : null,
    cats,
    tags: { inc: uniq([...legacy, ...(tg.inc || [])]), mode: tg.mode === 'any' ? 'any' : 'all', exc: uniq(tg.exc), none: !!tg.none },
    missing: !!q.missing,
    from: Number(q.from) || null, to: Number(q.to) || null,
    policy: q.policy || null, proc: q.proc || null,
    expiring: exp,
    sort: ['new', 'old', 'notes', 'due'].includes(q.sort) ? q.sort : 'new',
  };
}

function makeQuery(db, now) {
  // Everything the matcher needs, read once per call
  function load(q) {
    const blogs = new Map(db.all('SELECT uuid, name, role FROM blogs').map(b => [b.uuid, b]));
    const rows = db.all(`SELECT p.blog, p.id, p.kind, p.state, p.published_at, p.synced_at, p.tags, p.notes, p.notes_at, p.summary, p.thumb, p.has_images, p.legacy, p.pinned,
        p.item_id, i.manager, i.status AS item_status, i.external, i.origin_blog, i.origin_id,
        po.display, po.auto_hide IS NOT NULL AS auto_hidden, po.conflict IS NOT NULL AS conflicted
      FROM posts p LEFT JOIN items i ON i.id = p.item_id LEFT JOIN policies po ON po.blog = p.blog AND po.id = p.id
      WHERE p.state != 'gone'`);
    const jobState = new Map(); // scope -> state of its newest job that still matters
    for (const j of db.all(`SELECT scope, status FROM jobs WHERE scope LIKE 'post:%' AND id IN (SELECT MAX(id) FROM jobs WHERE scope LIKE 'post:%' GROUP BY scope)`)) {
      const s = OPEN_JOB.includes(j.status) ? 'jobs' : j.status === 'failed' ? 'failed' : j.status === 'unknown' ? 'unknown' : null;
      if (s) jobState.set(j.scope, s);
    }
    const ev = new Map(display.evaluate(db, now()).map(r => [r.blog + '/' + r.id, r]));
    const enrich = r => {
      const key = r.blog + '/' + r.id;
      const tags = P(r.tags, []);
      return { ...r, tags, keys: new Set(tags.map(k)), job: jobState.get(`post:${r.blog}:${r.id}`) || null, expiry: ev.get(key) || null,
        blog_name: blogs.get(r.blog)?.name, manager_name: blogs.get(r.manager)?.name };
    };
    const all = rows.map(enrich);
    let units;
    if (q.view === 'displayed') {
      units = all.map(r => ({ ...r, unit: r.blog + '/' + r.id }));
    } else {
      const byItem = new Map();
      for (const r of all) { if (r.item_id == null) continue; let g = byItem.get(r.item_id); if (!g) byItem.set(r.item_id, g = []); g.push(r); }
      units = [];
      for (const r of all) if (r.item_id == null) units.push({ ...r, unit: 'p:' + r.blog + '/' + r.id, members: [r] });
      for (const [id, members] of byItem) {
        const m0 = members[0];
        const origin = m0.external ? members[0] : members.find(m => m.blog === m0.origin_blog && m.id === m0.origin_id);
        if (origin) { units.push({ ...origin, unit: 'i:' + id, members }); continue; }
        // The original isn't readable: one card with unknown data. A reblog's own tags, state or date never stand in.
        const rep = members.slice().sort((a, b) => (b.published_at || 0) - (a.published_at || 0))[0];
        units.push({ ...rep, unit: 'i:' + id, members, origin_missing: true, tags: null, keys: null, state: null, published_at: null, notes: null, display: null, auto_hidden: 0 });
      }
    }
    // Scope: blog and sharing/all. Managed units are filed under their management blog.
    const home = u => (q.view === 'managed' ? u.manager || u.blog : u.blog);
    units = units.filter(u => (q.blog ? home(u) === q.blog : q.scope === 'all' || blogs.get(home(u))?.role === 'share'));
    const cats = db.all('SELECT id, name, tag, group_id FROM categories');
    return { units, cats, blogs };
  }

  // Category conditions -> tag key lists, per group
  function catConds(q, cats) {
    const byId = new Map(cats.map(c => [c.id, c]));
    return Object.entries(q.cats).map(([g, c]) => ({
      group: g, mode: c.mode, unset: c.unset,
      inc: c.inc.map(id => byId.get(id)).filter(Boolean).map(x => k(x.tag)),
      exc: c.exc.map(id => byId.get(id)).filter(Boolean).map(x => k(x.tag)),
      all: cats.filter(x => String(x.group_id ?? 'none') === g).map(x => k(x.tag)),
    }));
  }
  const wantsTags = (q, conds) => conds.length > 0 || q.tags.inc.length > 0 || q.tags.exc.length > 0 || q.tags.none;

  function tagMatch(S, q, conds) {
    for (const c of conds) {
      if (c.unset) { if (c.all.some(x => S.has(x))) return false; continue; }
      if (c.inc.length && !(c.mode === 'all' ? c.inc.every(x => S.has(x)) : c.inc.some(x => S.has(x)))) return false;
      if (c.exc.some(x => S.has(x))) return false;
    }
    const inc = q.tags.inc.map(k);
    if (inc.length && !(q.tags.mode === 'any' ? inc.some(x => S.has(x)) : inc.every(x => S.has(x)))) return false;
    if (q.tags.exc.some(x => S.has(k(x)))) return false;
    if (q.tags.none && S.size) return false;
    return true;
  }

  function procOf(u) {
    const list = u.members || [u];
    const s = new Set();
    if (u.item_status && u.item_status !== 'ok') s.add('review');
    for (const m of list) { if (m.conflicted) s.add('conflict'); if (m.job) s.add(m.job); }
    return s;
  }

  // Everything but the tag/category conditions (shared by the main match and the "after adding" counts)
  function baseMatch(u, q) {
    if (q.missing && !u.origin_missing) return false;
    if (q.state && u.state !== q.state) return false;
    if (q.kind && u.kind !== q.kind) return false;
    if (q.from || q.to) {
      if (!u.published_at) return false;
      if (q.from && u.published_at < q.from) return false;
      if (q.to && u.published_at > q.to) return false;
    }
    if (q.text) {
      const needle = q.text.toLowerCase();
      if (u.origin_missing) return false;
      if (!(String(u.summary || '').toLowerCase().includes(needle) || (u.tags || []).some(tg => k(tg).includes(needle)))) return false;
    }
    if (q.policy) {
      if (u.origin_missing) return false;
      const d = u.display || 'follow_rule';
      const ok = q.policy === 'auto_hidden' ? u.state === 'private' && !!u.auto_hidden
        : q.policy === 'hidden_other' ? u.state === 'private' && !u.auto_hidden
          : d === q.policy;
      if (!ok) return false;
    }
    if (q.proc) {
      const s = procOf(u);
      if (q.proc === 'attention' ? !(s.has('review') || s.has('conflict')) : !s.has(q.proc)) return false;
    }
    if (q.expiring) {
      const e = u.expiry;
      if (!e || u.state !== 'published' || e.action === 'skip' || e.reason === 'keep_visible' || e.reason === 'keep_hidden' || !e.due || e.due > now() + q.expiring.days * 86400e3) return false;
    }
    return true;
  }
  const match = (u, q, conds, needTags) => baseMatch(u, q) && (!needTags || (u.keys && tagMatch(u.keys, q, conds)));

  function sorter(q) {
    const tie = (a, b) => (a.blog < b.blog ? -1 : a.blog > b.blog ? 1 : 0) || (String(b.id).length - String(a.id).length) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
    const when = u => u.published_at ?? u.synced_at ?? 0;
    if (q.sort === 'old') return (a, b) => (a.published_at ?? Infinity) - (b.published_at ?? Infinity) || tie(a, b);
    if (q.sort === 'notes') return (a, b) => (b.notes ?? -1) - (a.notes ?? -1) || tie(a, b);
    if (q.sort === 'due') return (a, b) => (a.expiry?.due ?? Infinity) - (b.expiry?.due ?? Infinity) || tie(a, b);
    return (a, b) => when(b) - when(a) || tie(a, b);
  }

  function run(raw) {
    const q = normQuery(raw);
    const data = load(q);
    const conds = catConds(q, data.cats);
    const needTags = wantsTags(q, conds);
    const hits = data.units.filter(u => match(u, q, conds, needTags)).sort(sorter(q));
    return { q, data, conds, hits };
  }

  // One page of matches, with counts and coverage
  function page(raw = {}) {
    const { limit = 60, offset = 0, facets = false } = raw;
    const { q, data, hits } = run(raw);
    const slice = hits.slice(offset, offset + limit).map(u => detail(u, data));
    const out = { q, total: hits.length, scopeTotal: data.units.length, missingTotal: data.units.filter(u => u.origin_missing).length, rows: slice, coverage: coverage(q) };
    if (facets) out.facets = facetCounts(raw, q, data);
    return out;
  }

  // Count after adding each option, the way the panel would add it (same view, same unit, same data)
  function facetCounts(raw, q, data) {
    const count = qq => { const c = catConds(qq, data.cats), n = wantsTags(qq, c); return data.units.reduce((s, u) => s + (match(u, qq, c, n) ? 1 : 0), 0); };
    const out = { cat: {}, unset: {}, none: 0, missing: 0 };
    const groups = new Set(data.cats.map(c => String(c.group_id ?? 'none')));
    for (const c of data.cats) {
      const g = String(c.group_id ?? 'none');
      const cur = q.cats[g] || { mode: 'any', inc: [], exc: [], unset: false };
      if (cur.inc.includes(c.id)) continue;
      out.cat[c.id] = count({ ...q, cats: { ...q.cats, [g]: { ...cur, unset: false, inc: [...cur.inc, c.id], exc: cur.exc.filter(x => x !== c.id) } } });
    }
    for (const g of groups) {
      const cur = q.cats[g];
      if (cur?.unset) continue;
      out.unset[g] = count({ ...q, cats: { ...q.cats, [g]: { mode: 'any', inc: [], exc: cur?.exc || [], unset: true } } });
    }
    out.none = q.tags.none ? null : count({ ...q, tags: { ...q.tags, none: true } });
    out.missing = q.missing ? null : count({ ...q, missing: true });
    return out;
  }

  // Card fields for the rows actually shown
  function detail(u, data) {
    const src = [u.origin_blog || u.blog, u.origin_id || u.id];
    const one = (sql, ...a) => db.get(sql, ...a)?.n || 0;
    let images = 0;
    if (!u.origin_missing && u.has_images) {
      const pl = P(db.get('SELECT payload FROM posts WHERE blog = ? AND id = ?', u.blog, u.id)?.payload, {});
      images = [...(pl.content || []), ...(pl.trail || []).flatMap(t => t.content || [])].filter(b => b.type === 'image').length;
    }
    const keys = u.keys || new Set();
    const catHits = data.cats.filter(c => keys.has(k(c.tag))).map(c => ({ id: c.id, name: c.name, tag: c.tag, group_id: c.group_id }));
    const r = {
      blog: u.blog, id: u.id, kind: u.kind, state: u.state, published_at: u.published_at, tags: u.tags, notes: u.notes, notes_at: u.notes_at,
      summary: u.summary, thumb: u.thumb, has_images: u.has_images, images, legacy: u.legacy, pinned: u.pinned, item_id: u.item_id, manager: u.manager,
      item_status: u.item_status, external: u.external, blog_name: u.blog_name, manager_name: u.manager_name, display: u.display, auto_hidden: u.auto_hidden,
      conflicted: u.conflicted, job: u.job, expiry: u.expiry, origin_missing: !!u.origin_missing, cats: catHits,
      origin_blog: u.origin_blog, origin_name: data.blogs.get(u.origin_blog)?.name,
      copies: u.item_id ? one(`SELECT COUNT(*) n FROM posts c WHERE c.item_id = ? AND c.state != 'gone'`, u.item_id) : 1,
      versions: one('SELECT COUNT(*) n FROM source_revisions WHERE blog = ? AND id = ?', ...src),
      deliv_pending: one(`SELECT COUNT(*) n FROM deliveries WHERE src_blog = ? AND src_id = ? AND status = 'pending'`, ...src),
      deliv_unknown: one(`SELECT COUNT(*) n FROM deliveries WHERE src_blog = ? AND src_id = ? AND status = 'unknown'`, ...src),
    };
    if (u.kind === 'reblog' && !u.origin_missing) r.snapshot_rev = db.get('SELECT rev FROM deliveries WHERE dest_blog = ? AND dest_id = ?', u.blog, u.id)?.rev ?? null;
    return r;
  }

  // Whether the blogs in scope have been read to the end, and when they were last read
  function coverage(q) {
    const rows = db.all(`SELECT b.uuid, b.role, s.complete, s.cursor IS NOT NULL AS partial, s.error, MAX(COALESCE(s.inc_done, 0), COALESCE(s.full_done, 0)) AS at
      FROM blogs b LEFT JOIN sync_state s ON s.blog = b.uuid AND s.box = 'posts'`).filter(r => (q.blog ? r.uuid === q.blog : q.scope === 'all' || r.role === 'share'));
    return { complete: rows.length > 0 && rows.every(r => r.complete && !r.partial), lastSync: rows.length ? Math.min(...rows.map(r => r.at || 0)) || null : null, errors: rows.filter(r => r.error).length };
  }

  // Every match's identity, frozen by the caller: works keep item_id, posts keep blog + id
  function ids(raw = {}) {
    const { q, hits } = run(raw);
    return { v: q.v, total: hits.length, ids: hits.map(u => ({ blog: u.blog, id: u.id, item_id: u.item_id, kind: u.kind, origin_missing: !!u.origin_missing })) };
  }

  // Tags known in the current scope (all synced rows, not only the loaded cards), merged with category names
  function tagCandidates(raw = {}) {
    const { text = '', limit = 20, sortBy = 'count' } = raw;
    const q = normQuery(raw);
    const data = load(q);
    const counts = new Map();
    for (const u of data.units) for (const tg of u.tags || []) {
      const kk = k(tg); if (!kk) continue;
      const c = counts.get(kk); if (c) c.n++; else counts.set(kk, { tag: C.norm(tg), n: 1 });
    }
    for (const c of data.cats) { const kk = k(c.tag); const x = counts.get(kk) || { tag: C.norm(c.tag), n: 0 }; x.cat = { id: c.id, name: c.name, group_id: c.group_id }; counts.set(kk, x); }
    const needle = k(text);
    let list = [...counts.values()].filter(x => !needle || k(x.tag).includes(needle) || (x.cat && k(x.cat.name).includes(needle)));
    list.sort(sortBy === 'name' ? (a, b) => a.tag.localeCompare(b.tag) : (a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
    list = list.slice(0, limit);
    // "after adding": the result size if this tag joined the include list (same view, same data)
    const conds = catConds(q, data.cats);
    const inc = new Set(q.tags.inc.map(k));
    for (const x of list) {
      if (inc.has(k(x.tag))) { x.after = null; continue; }
      const qq = { ...q, tags: { ...q.tags, inc: [...q.tags.inc, x.tag], exc: q.tags.exc.filter(e => k(e) !== k(x.tag)) } };
      x.after = data.units.reduce((s, u) => s + (match(u, qq, conds, true) ? 1 : 0), 0);
    }
    return { text, exact: list.some(x => k(x.tag) === needle), list };
  }

  return { page, ids, tagCandidates, normQuery };
}

module.exports = { makeQuery, normQuery, QUERY_VERSION };
