'use strict';
const { postGone } = require('./gone');
// Version maintenance in one place (docs/REBLOG_POLICY.md 2.1, R12-R17, A56). A work's source revisions and,
// per owned destination blog, the reblog instances that hold them, with the actions that make sense on exact
// instances. Nothing here edits a snapshot's body or tags:
//  - visibility (public / private / keep public / follow the display rules) goes through the existing
//    display module and post.visibility jobs, which send each instance's own payload back;
//  - deletion is a post.delete job per chosen reblog (never an original), verified, and leaves the delivery
//    as a tombstone so a later sync or route never recreates that version on that blog;
//  - re-sending goes through routes.manualReblog (version dedupe, unknown-outcome and exclusion checks).
// Times are kept apart: `since` is when a source revision was first observed, `at` is when a reblog was made.

const { P } = require('./db');
const routes = require('./routes');
const display = require('./display');

const LIVE = ['created', 'existing', 'conflict'];
const mediaKey = m => { const u = m?.url || m?.identifier || ''; try { return new URL(u).pathname.split('/').filter(Boolean)[0] || u; } catch { return u; } };

// The body a revision had: its own snapshot (kept since schema 9), else the trail entry of a copy known to
// hold it (not an unknown-version copy), else null = can't be compared
function bodyOf(db, blog, id, rev) {
  const r = db.get('SELECT snapshot FROM source_revisions WHERE blog = ? AND id = ? AND rev = ?', blog, String(id), rev);
  if (r?.snapshot) return { ...P(r.snapshot), from: 'source' };
  for (const d of db.all(`SELECT dest_blog, dest_id FROM deliveries WHERE src_blog = ? AND src_id = ? AND rev = ? AND dest_id IS NOT NULL AND version_unknown = 0`, blog, String(id), rev)) {
    const p = P(db.get('SELECT payload FROM posts WHERE blog = ? AND id = ?', d.dest_blog, d.dest_id)?.payload, null);
    const t = p && [...(p.trail || [])].reverse().find(x => String(x.post?.id ?? '') === String(id));
    if (t) return { content: t.content || [], layout: t.layout || [], from: 'copy' };
  }
  return null;
}

// What changed between two bodies: text blocks, images (added / removed / moved), layout rows. Tags are not
// part of a version and are compared separately by the caller.
function diffBodies(a, b) {
  const texts = body => (body.content || []).filter(x => x.type === 'text').map(x => String(x.text || ''));
  const images = body => (body.content || []).filter(x => x.type === 'image').map(x => mediaKey(x.media?.[0]));
  const rows = body => JSON.stringify((body.layout || []).filter(l => l.type === 'rows').map(l => (l.display || []).map(d => d.blocks)));
  const ta = texts(a), tb = texts(b);
  const text = [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (ta[i] === tb[i]) continue;
    text.push({ i, before: ta[i] ?? null, after: tb[i] ?? null });
  }
  const ia = images(a), ib = images(b);
  const added = ib.filter(k => !ia.includes(k)).length, removed = ia.filter(k => !ib.includes(k)).length;
  const common = ia.filter(k => ib.includes(k));
  const moved = JSON.stringify(common) !== JSON.stringify(ib.filter(k => ia.includes(k)));
  return { text, images: { before: ia.length, after: ib.length, added, removed, moved }, layoutChanged: rows(a) !== rows(b),
    same: !text.length && !added && !removed && !moved && rows(a) === rows(b) };
}

function addVersions(svc, api) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;
  const blogName = uuid => db.get('SELECT name FROM blogs WHERE uuid = ?', uuid)?.name || uuid;

  // Any member of a work (the original or one of its reblogs) → the original the versions belong to
  function originOf({ blog, id }) {
    const p = db.get('SELECT blog, id, kind, item_id, root_blog, root_id, parent_blog, parent_id FROM posts WHERE blog = ? AND id = ?', blog, String(id));
    if (!p) return null;
    if (p.kind === 'original') return { blog: p.blog, id: p.id };
    const d = db.get('SELECT src_blog, src_id FROM deliveries WHERE dest_blog = ? AND dest_id = ?', blog, String(id));
    if (d) return { blog: d.src_blog, id: d.src_id };
    const owned = new Set(db.all('SELECT uuid FROM blogs').map(b => b.uuid));
    if (p.root_blog && owned.has(p.root_blog)) return { blog: p.root_blog, id: p.root_id };
    if (p.parent_blog && owned.has(p.parent_blog)) return { blog: p.parent_blog, id: p.parent_id };
    return null;
  }

  // R12: the whole picture of one work
  function model(origin) {
    const v = routes.versionsOf(db, origin.blog, origin.id);
    const notes = new Map(db.all('SELECT rev, label, note FROM version_notes WHERE blog = ? AND id = ?', origin.blog, String(origin.id)).map(n => [n.rev, n]));
    const src = db.get('SELECT state, summary, thumb, published_at FROM posts WHERE blog = ? AND id = ?', origin.blog, String(origin.id));
    const revs = v.revisions.map(r => ({ ...r, comparable: !!bodyOf(db, origin.blog, origin.id, r.rev), label: notes.get(r.rev)?.label || '', note: notes.get(r.rev)?.note || '' }));
    const dests = v.dests.map(d => {
      const copies = d.copies.map(c => {
        const p = c.dest_id ? db.get('SELECT state, published_at, summary, thumb, tags FROM posts WHERE blog = ? AND id = ?', d.dest, c.dest_id) : null;
        const pol = c.dest_id ? display.policyOf(db, d.dest, c.dest_id) : null;
        const job = c.dest_id ? db.get(`SELECT id, kind, status, error FROM jobs WHERE scope = ? AND status NOT IN ('succeeded', 'unchanged', 'cancelled', 'skipped') ORDER BY id DESC LIMIT 1`, `post:${d.dest}:${c.dest_id}`) : null;
        const delivery = db.get('SELECT at, job_id FROM deliveries WHERE src_blog = ? AND src_id = ? AND rev = ? AND dest_blog = ?', origin.blog, String(origin.id), c.rev, d.dest);
        return {
          ...c, state: p?.state === 'gone' || c.status === 'tombstone' ? 'gone' : p?.state || null, reblogged_at: p?.published_at || delivery?.at || null,
          summary: p?.summary || null, thumb: p?.thumb || null, tags: c.tags || (p ? P(p.tags, []) : null),
          keepPublic: pol?.display === 'keep_visible', job, url: c.dest_id ? `https://www.tumblr.com/${blogName(d.dest)}/${c.dest_id}` : null,
        };
      });
      // the newest copy on this blog that was verified on Tumblr (not just planned or pending)
      const verified = copies.filter(c => LIVE.includes(c.status) && c.state && c.state !== 'gone' && !c.version_unknown).sort((a, b) => b.rev - a.rev)[0] || null;
      return { dest: d.dest, name: blogName(d.dest), copies, newer: d.newer, latestVerified: verified?.rev || null, missingLatest: !!v.latest && !copies.some(c => c.rev === v.latest && LIVE.includes(c.status)) };
    });
    const pending = dests.reduce((n, d) => n + d.copies.filter(c => ['pending', 'unknown', 'failed'].includes(c.status) || c.job).length, 0);
    return { origin: { ...origin, name: blogName(origin.blog), state: src?.state || null, summary: src?.summary || null, thumb: src?.thumb || null, published_at: src?.published_at || null,
      url: `https://www.tumblr.com/${blogName(origin.blog)}/${origin.id}` }, latest: v.latest, revisions: revs, dests, pending };
  }

  // The exact owned reblog instances a selection names; anything else is listed with the reason it is left out
  function resolve(origin, targets) {
    const m = model(origin);
    const out = { ok: [], skipped: [] };
    for (const t of targets) {
      const d = m.dests.find(x => x.dest === t.dest);
      const c = d?.copies.find(x => String(x.dest_id) === String(t.dest_id));
      if (!c) { out.skipped.push({ ...t, reason: 'not_found' }); continue; }
      const row = { dest: d.dest, name: d.name, dest_id: c.dest_id, rev: c.rev, state: c.state, keepPublic: c.keepPublic, version_unknown: c.version_unknown, url: c.url };
      if (c.state === 'gone' || !c.state) out.skipped.push({ ...row, reason: 'gone' });
      else if (c.job) out.skipped.push({ ...row, reason: 'busy' });
      else out.ok.push(row);
    }
    return { ...out, model: m };
  }

  Object.assign(api, {
    versions({ blog, id }) {
      const origin = originOf({ blog, id });
      return origin ? model(origin) : null;
    },
    // R13
    versionDiff({ blog, id, a, b }) {
      const origin = originOf({ blog, id }) || { blog, id };
      const A = bodyOf(db, origin.blog, origin.id, a), B = bodyOf(db, origin.blog, origin.id, b);
      if (!A || !B) return { comparable: false, missing: [!A && a, !B && b].filter(Boolean) };
      // tags each version was reblogged with, per blog (a version's tags are never part of its identity)
      const tagsOf = rev => db.all('SELECT dest_blog, tags FROM deliveries WHERE src_blog = ? AND src_id = ? AND rev = ? AND tags IS NOT NULL', origin.blog, String(origin.id), rev)
        .map(r => ({ dest: r.dest_blog, name: blogName(r.dest_blog), tags: P(r.tags, []) }));
      return { comparable: true, from: [A.from, B.from], ...diffBodies(A, B), tags: { a: tagsOf(a), b: tagsOf(b) } };
    },
    // R14 / R16: exactly what an action would touch, before anything is queued
    versionActionPreview({ blog, id, targets = [], action }) {
      const origin = originOf({ blog, id });
      if (!origin) throw new Error('unknown work');
      const r = resolve(origin, targets);
      const ok = [], skipped = [...r.skipped];
      for (const x of r.ok) {
        if (action === 'hide' && x.keepPublic) skipped.push({ ...x, reason: 'keep_public' });
        else if (action === 'hide' && x.state === 'private') skipped.push({ ...x, reason: 'already' });
        else if (action === 'show' && x.state === 'published') skipped.push({ ...x, reason: 'already' });
        else if (['hide', 'show'].includes(action) && !['published', 'private'].includes(x.state)) skipped.push({ ...x, reason: 'state' });
        else ok.push(x);
      }
      return { action, ok, skipped, original: { blog: origin.blog, id: origin.id, untouched: true } };
    },
    versionAction({ blog, id, targets = [], action }) {
      const pv = api.versionActionPreview({ blog, id, targets, action });
      const list = pv.ok.map(x => ({ blog: x.dest, id: x.dest_id }));
      if (!list.length) return { queued: 0, skipped: pv.skipped.length };
      if (action === 'hide' || action === 'show') return { ...display.userVisibility(db, jobs, list, action === 'hide' ? 'private' : 'published', { now: now(), display: action === 'hide' ? 'keep_hidden' : 'follow_rule', batchTitle: action === 'hide' ? 'Hide versions' : 'Show versions' }), skipped: pv.skipped.length };
      if (action === 'keepPublic') return { ...display.keepVisible(db, jobs, list, now()), skipped: pv.skipped.length };
      if (action === 'followRule') { db.tx(() => { for (const t of list) display.setDisplay(db, t.blog, t.id, 'follow_rule', now()); }); return { queued: 0, changed: list.length, skipped: pv.skipped.length }; }
      if (action === 'delete') {
        const batch = jobs.batch('Delete versions', { targets: pv.ok.map(x => ({ blog: x.dest, id: x.dest_id, rev: x.rev })) });
        for (const x of pv.ok) jobs.add('post.delete', { blog: x.dest, id: String(x.dest_id), reason: 'version', src_blog: pv.original.blog, src_id: pv.original.id, rev: x.rev }, { priority: 1, scope: `post:${x.dest}:${x.dest_id}`, batch });
        return { queued: pv.ok.length, skipped: pv.skipped.length };
      }
      throw new Error('unknown action');
    },
    // R15: one-off. Per chosen blog keep its newest verified public copy and offer the older public ones for
    // hiding — only when that newest public copy holds the source's latest revision. Never automatic.
    hideOldPreview({ blog, id, dests = null }) {
      const origin = originOf({ blog, id });
      if (!origin) throw new Error('unknown work');
      const m = model(origin);
      const out = [];
      for (const d of m.dests.filter(x => !dests || dests.includes(x.dest))) {
        const pub = d.copies.filter(c => LIVE.includes(c.status) && c.state === 'published' && !c.version_unknown).sort((a, b) => b.rev - a.rev);
        const keep = pub[0] || null;
        if (!keep) { out.push({ dest: d.dest, name: d.name, keep: null, hide: [], held: 'no_public' }); continue; }
        if (keep.rev !== m.latest) { out.push({ dest: d.dest, name: d.name, keep, hide: [], held: 'latest_not_public' }); continue; }
        const older = d.copies.filter(c => c !== keep && c.state === 'published' && LIVE.includes(c.status));
        out.push({ dest: d.dest, name: d.name, keep,
          hide: older.filter(c => !c.keepPublic && !c.version_unknown && !c.job),
          left: older.filter(c => c.keepPublic || c.version_unknown || c.job).map(c => ({ ...c, why: c.keepPublic ? 'keep_public' : c.version_unknown ? 'version_unknown' : 'busy' })) });
      }
      return { latest: m.latest, blogs: out };
    },
    hideOld({ blog, id, dests = null }) {
      const pv = api.hideOldPreview({ blog, id, dests });
      const targets = pv.blogs.flatMap(b => b.hide.map(c => ({ dest: b.dest, dest_id: c.dest_id })));
      return targets.length ? api.versionAction({ blog, id, targets, action: 'hide' }) : { queued: 0 };
    },
    // R17: re-send the latest version to a blog through the normal checks
    versionReblog({ blog, id, dest, state = 'published' }) {
      const origin = originOf({ blog, id });
      if (!origin) throw new Error('unknown work');
      return { job: routes.manualReblog(db, jobs, { blog: origin.blog, id: origin.id, dest, state }) };
    },
    // Local names and notes: kept through restarts and backups, never sent anywhere
    versionNote({ blog, id, rev, label = '', note = '' }) {
      const origin = originOf({ blog, id }) || { blog, id };
      if (!db.get('SELECT 1 FROM source_revisions WHERE blog = ? AND id = ? AND rev = ?', origin.blog, String(origin.id), rev)) throw new Error('unknown version');
      db.run(`INSERT INTO version_notes (blog, id, rev, label, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(blog, id, rev) DO UPDATE SET label = excluded.label, note = excluded.note, updated_at = excluded.updated_at`,
      origin.blog, String(origin.id), rev, String(label).slice(0, 60), String(note).slice(0, 2000), now());
      return { ok: true };
    },
  });

  // Deleting a reblog (R16): only reblogs on my blogs, never an original. The version's delivery becomes a
  // tombstone (kept with its notes), so nothing recreates it. Material reblogs: see aiart.js, same job.
  const prior = svc.handlers['post.delete'];
  svc.handlers['post.delete'] = {
    async run(job, ctx) {
      if (job.payload.reason !== 'version') return prior ? prior.run(job, ctx) : { status: 'skipped', error: 'no handler' };
      const { blog, id } = job.payload;
      const row = db.get('SELECT kind FROM posts WHERE blog = ? AND id = ?', blog, String(id));
      if (!row) return { status: 'skipped', error: 'not a known post' };
      if (row.kind !== 'reblog') return { status: 'skipped', error: 'originals are never deleted from version maintenance' };
      const gone = () => postGone(ctx.tumblr, blog, id);
      if (job.payload.phase !== 'verify') {
        if (!(await gone())) await ctx.tumblr.deletePost(blog, id);
        return { status: 'verifying', payload: { ...job.payload, phase: 'verify', tries: 0 }, nextAt: ctx.now() + 3000 };
      }
      if (!(await gone())) {
        const tries = (job.payload.tries || 0) + 1;
        if (tries > 5) return { status: 'failed', error: 'still there after deleting' };
        return { status: 'verifying', payload: { ...job.payload, tries }, nextAt: ctx.now() + 5000 * tries };
      }
      db.tx(() => {
        db.run(`UPDATE posts SET state = 'gone' WHERE blog = ? AND id = ?`, blog, String(id));
        db.run(`UPDATE deliveries SET status = 'tombstone', reason = 'deleted in version maintenance', at = ? WHERE dest_blog = ? AND dest_id = ?`, ctx.now(), blog, String(id));
        // a copy found on the blog but never recorded still gets its tombstone, so it isn't sent again
        if (job.payload.src_blog && !db.get('SELECT 1 FROM deliveries WHERE dest_blog = ? AND dest_id = ?', blog, String(id))) {
          db.run(`INSERT OR IGNORE INTO deliveries (route_id, src_blog, src_id, rev, dest_blog, dest_id, status, reason, version_unknown, at) VALUES (NULL, ?, ?, ?, ?, ?, 'tombstone', 'deleted in version maintenance', 0, ?)`,
            job.payload.src_blog, String(job.payload.src_id), job.payload.rev, blog, String(id), ctx.now());
        }
      });
      return { status: 'succeeded', result: { deleted: true } };
    },
  };
}

module.exports = { addVersions, diffBodies, bodyOf };

