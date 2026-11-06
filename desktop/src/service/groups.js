'use strict';
// Content items: one logical work = the user's own original plus their own reblogs of it, linked by actual
// reblog identities (root/parent ids), never by similar text or images. Each item has a management blog:
//
//  - an original on a side blog is managed by that blog;
//  - an original on main is managed by main until exactly one *sharing* side blog reblogs it, then by that blog;
//  - two or more such side blogs: status 'ambiguous', automatic group work pauses (the user deferred this case);
//  - the managing reblog disappears or its blog stops being a sharing blog: 'needs_review', authority stays put;
//  - material blogs and blogs with no role never take management.
// Rebuilding only changes local organisation; it never edits anything on Tumblr.

const { J, P } = require('./db');

function blogsById(db) {
  const m = new Map();
  for (const b of db.all('SELECT * FROM blogs')) m.set(b.uuid, b);
  return m;
}

function rebuild(db, now = Date.now()) {
  const blogs = blogsById(db);
  const owned = uuid => blogs.has(uuid);
  const sharingSide = uuid => { const b = blogs.get(uuid); return !!b && !b.is_primary && b.role === 'share'; };
  const posts = db.all(`SELECT blog, id, kind, parent_blog, parent_id, root_blog, root_id, state, published_at FROM posts`);
  const byKey = new Map(posts.map(p => [p.blog + '/' + p.id, p]));
  const live = p => p && p.state !== 'gone';
  // The owned original a reblog descends from: its root when the root is mine, else follow parents through my posts
  const originOf = p => {
    if (p.kind === 'original') return p;
    if (p.root_blog && owned(p.root_blog)) return byKey.get(p.root_blog + '/' + p.root_id) || { blog: p.root_blog, id: p.root_id, kind: 'original', missing: true };
    return null;
  };
  const items = new Map(db.all('SELECT * FROM items').map(i => [i.external ? 'x:' + i.origin_blog + '/' + i.origin_id : i.origin_blog + '/' + i.origin_id, i]));
  const groups = new Map(); // origin key -> { origin, members: [] }
  for (const p of posts) {
    const o = originOf(p);
    const k = o ? o.blog + '/' + o.id : 'x:' + p.blog + '/' + p.id;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { key: k, origin: o, external: !o, members: [] });
    g.members.push(p);
  }
  const stats = { items: 0, changed: 0, ambiguous: 0, review: 0 };
  db.tx(() => {
    for (const g of groups.values()) {
      const prev = items.get(g.key);
      let manager, status = 'ok', evidence;
      if (g.external) {
        const p = g.members[0];
        manager = p.blog; evidence = { rule: 'external' };
      } else {
        const o = g.origin;
        const originBlog = blogs.get(o.blog);
        if (originBlog && !originBlog.is_primary) { manager = o.blog; evidence = { rule: 'side_original' }; }
        else {
          const sides = [...new Set(g.members.filter(m => m.kind === 'reblog' && live(m) && sharingSide(m.blog)).map(m => m.blog))];
          if (sides.length === 1) { manager = sides[0]; evidence = { rule: 'side_reblog', via: g.members.find(m => m.blog === sides[0] && m.kind === 'reblog').id }; }
          else if (sides.length > 1) { manager = prev?.manager || o.blog; status = 'ambiguous'; evidence = { rule: 'ambiguous', candidates: sides }; }
          else if (prev && prev.manager !== o.blog && P(prev.evidence)?.rule === 'side_reblog') {
            // The side blog that managed it lost its reblog or its sharing role: keep authority, ask the user
            manager = prev.manager; status = 'needs_review'; evidence = { rule: 'manager_lost', was: P(prev.evidence) };
          } else { manager = o.blog; evidence = { rule: 'main_original' }; }
        }
        if (prev && P(prev.evidence)?.rule === 'manual' && status === 'ok') { manager = prev.manager; evidence = P(prev.evidence); }
      }
      if (status === 'ambiguous') stats.ambiguous++;
      if (status === 'needs_review') stats.review++;
      const [ob, oid] = g.external ? [g.members[0].blog, g.members[0].id] : [g.origin.blog, g.origin.id];
      let id;
      if (!prev) {
        const r = db.run(`INSERT INTO items (origin_blog, origin_id, manager, external, status, evidence, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
          ob, oid, manager, g.external ? 1 : 0, status, J(evidence), now);
        id = Number(r.lastInsertRowid); stats.changed++;
      } else {
        id = prev.id;
        if (prev.manager !== manager || prev.status !== status) {
          db.run(`UPDATE items SET manager = ?, status = ?, evidence = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, manager, status, J(evidence), now, id);
          stats.changed++;
        }
      }
      for (const m of g.members) db.run('UPDATE posts SET item_id = ? WHERE blog = ? AND id = ? AND (item_id IS NULL OR item_id != ?)', id, m.blog, m.id, id);
      stats.items++;
    }
  });
  return stats;
}

// Manual (re)assignment: local only, recorded as such so a rebuild keeps it
function assign(db, itemId, manager, now = Date.now()) {
  db.run(`UPDATE items SET manager = ?, status = 'ok', evidence = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
    manager, J({ rule: 'manual', at: now }), now, itemId);
}

function item(db, id) {
  const i = db.get('SELECT * FROM items WHERE id = ?', id);
  if (!i) return null;
  const members = db.all(`SELECT p.*, b.name AS blog_name, b.is_primary FROM posts p JOIN blogs b ON b.uuid = p.blog WHERE p.item_id = ? ORDER BY p.kind = 'reblog', p.published_at`, id)
    .map(r => ({ ...r, tags: P(r.tags, []) }));
  return { ...i, evidence: P(i.evidence), managed: P(i.managed), members };
}

module.exports = { rebuild, assign, item };
