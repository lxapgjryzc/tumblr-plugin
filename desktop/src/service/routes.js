'use strict';
// Reblog routes under docs/REBLOG_POLICY.md: every reblog is a frozen snapshot of the source's body and the tags
// it was sent with, and is never edited afterwards. What a route delivers is a *content revision* of a source
// original: a new body (text, images, layout) is a new revision and gets its own reblog; a tags-only change is
// not a revision and sends nothing. `deliveries` remembers every source + revision + destination decision
// (created, existing, skipped, tombstone, unknown…), so rescans, restarts and rule edits never send a revision
// twice, an older copy never blocks a newer revision, and deleting one version's copy only tombstones that
// version. A post carrying an excluded tag is skipped as a whole, never published with the tag removed.

const { J, P } = require('./db');
const C = require('./core');
const { fresh } = require('./ops');
const { upsertPost, payloadOf, contentFingerprint, trailFingerprint, observeRevision, latestRevision } = require('./posts');
const { StaleError, HttpError, NetError, RateError, AuthError, WaitError } = require('./errors');

// The one tag comparison used everywhere: whole tags, case-insensitive, '#' and outer spaces ignored
const cleanRuleTag = t => C.norm(String(t || '')).trim();
const excludedBy = (tags, exclude) => {
  const ks = new Set(exclude.map(t => C.key(cleanRuleTag(t))).filter(Boolean));
  return (tags || []).find(t => ks.has(C.key(t))) || null;
};

const routesOf = db => db.all('SELECT * FROM routes').map(r => ({ ...r, sources: P(r.sources, []), exclude: P(r.exclude, []) }));

// Statuses that settle a revision for a destination (it is never planned again by a route)
const SETTLED = ['created', 'existing', 'skipped', 'tombstone', 'conflict', 'failed'];
const OPEN = ['pending', 'unknown'];

function saveRoute(db, jobs, r, now = Date.now()) {
  const exclude = [...new Set((r.exclude || []).map(cleanRuleTag).filter(Boolean))];
  if (r.id) {
    const old = routesOf(db).find(x => x.id === r.id);
    const since = r.enabled && !old.enabled ? now : old.since;
    db.run('UPDATE routes SET sources = ?, dest = ?, enabled = ?, since = ?, exclude = ?, delivery = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      J(r.sources), r.dest, r.enabled ? 1 : 0, since, J(exclude), r.delivery || 'published', now, r.id);
    jobs?.cancelScope(`route:${r.id}:`, 'the route changed', ['post.reblog']);
    // unsent decisions go back to undecided
    db.run(`DELETE FROM deliveries WHERE route_id = ? AND status = 'pending'`, r.id);
    return r.id;
  }
  const res = db.run('INSERT INTO routes (sources, dest, enabled, since, exclude, delivery, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    J(r.sources), r.dest, r.enabled ? 1 : 0, r.enabled ? now : null, J(exclude), r.delivery || 'published', now);
  return Number(res.lastInsertRowid);
}

// Revision 1 for originals stored before version tracking existed (their current body is the baseline; no
// earlier history is invented and nothing counts as "just edited").
function baseline(db, now = Date.now()) {
  const rows = db.all(`SELECT p.blog, p.id, p.kind, p.state, p.published_at FROM posts p WHERE p.kind = 'original' AND p.state IN ('published', 'private')
    AND NOT EXISTS (SELECT 1 FROM source_revisions r WHERE r.blog = p.blog AND r.id = p.id)`);
  db.tx(() => { for (const r of rows) { const p = payloadOf(db, r.blog, r.id); if (p) observeRevision(db, r, p, now); } });
  return rows.length;
}

const revisions = (db, blog, id) => db.all('SELECT * FROM source_revisions WHERE blog = ? AND id = ? ORDER BY rev', blog, String(id));
const deliveriesOf = (db, blog, id, dest) => db.all('SELECT * FROM deliveries WHERE src_blog = ? AND src_id = ? AND dest_blog = ? ORDER BY rev', blog, String(id), dest)
  .map(d => ({ ...d, tags: P(d.tags, null) }));

// Reblogs of src on dest (parent or root is src), as stored locally
const copiesOn = (db, blog, id, dest) => db.all(`SELECT id, published_at, payload FROM posts WHERE blog = ? AND kind = 'reblog' AND state != 'gone'
  AND ((parent_blog = ? AND parent_id = ?) OR (root_blog = ? AND root_id = ?)) ORDER BY published_at`, dest, blog, String(id), blog, String(id));

// Which revision a copy holds: the trail's own body when it matches a revision that may already have existed when
// the copy was made, else the revision current when the copy was made (marked as an unknown version). A revision's
// `since` is when the app first *observed* it; it may be older (edited on Tumblr and reblogged there before the next
// pass). It can only have begun after the previous revision was observed, so that is the bound used for bodies.
function revisionOfCopy(revs, copy, srcId) {
  const fp = trailFingerprint(P(copy.payload, {}), srcId);
  const t = copy.published_at ? copy.published_at + 120e3 : Infinity;
  const byBody = revs.filter((r, i) => (i === 0 || revs[i - 1].since <= t) && r.fingerprint === fp);
  if (byBody.length) return { rev: byBody[byBody.length - 1].rev, unknown: false, fp };
  const before = revs.filter(r => r.since <= t);
  const r = before.length ? before[before.length - 1] : revs[0];
  return r ? { rev: r.rev, unknown: true, fp } : null;
}

// The earliest time a copy of this revision can have been made (see revisionOfCopy): the previous revision's
// observation, less the usual 2 minutes of clock slack; 0 for the first revision
function revisionStart(db, blog, id, rev) {
  const prev = db.get('SELECT since FROM source_revisions WHERE blog = ? AND id = ? AND rev < ? ORDER BY rev DESC LIMIT 1', blog, String(id), rev);
  return prev?.since ? prev.since - 120e3 : 0;
}

// Copies on dest that no delivery row claims yet, attributed to revisions
function unclaimedCopies(db, blog, id, dest, revs) {
  const claimed = new Set(db.all('SELECT dest_id FROM deliveries WHERE dest_blog = ? AND dest_id IS NOT NULL', dest).map(r => r.dest_id));
  return copiesOn(db, blog, id, dest).filter(c => !claimed.has(c.id)).map(c => ({ id: c.id, ...revisionOfCopy(revs, c, id) })).filter(c => c.rev);
}

// Where a source stands for one destination: { latest, delivered: Map(rev → status), open: an unsettled earlier
// revision (pending/unknown), copies: unclaimed copies with their revisions }
function standing(db, blog, id, dest) {
  const revs = revisions(db, blog, id);
  const latest = revs[revs.length - 1] || null;
  const dels = deliveriesOf(db, blog, id, dest);
  const delivered = new Map(dels.map(d => [d.rev, d]));
  const copies = unclaimedCopies(db, blog, id, dest, revs);
  for (const c of copies) if (!delivered.has(c.rev)) delivered.set(c.rev, { rev: c.rev, status: 'existing', dest_id: c.id, version_unknown: c.unknown ? 1 : 0, _copy: true });
  const open = latest ? dels.find(d => d.rev < latest.rev && OPEN.includes(d.status)) : null;
  return { revs, latest, delivered, open, copies };
}

// What a route would do with each candidate now. Pure read.
function preview(db, route, { history = false } = {}) {
  const out = [];
  const roles = new Map(db.all('SELECT uuid, role, is_primary FROM blogs').map(b => [b.uuid, b]));
  const destRole = roles.get(route.dest);
  for (const src of route.sources) {
    const role = roles.get(src);
    const posts = db.all(`SELECT blog, id, kind, state, tags, published_at, item_id, summary, thumb FROM posts WHERE blog = ? AND kind = 'original' AND state IN ('published', 'private', 'queue') ORDER BY published_at DESC`, src);
    for (const p of posts) {
      const tags = P(p.tags, []);
      const r = { blog: p.blog, id: p.id, summary: p.summary, thumb: p.thumb, published_at: p.published_at };
      const st = standing(db, p.blog, p.id, route.dest);
      const cur = st.latest;
      r.rev = cur?.rev || null;
      const mine = cur && st.delivered.get(cur.rev);
      const earlier = cur ? [...st.delivered.values()].filter(d => d.rev < cur.rev) : [];
      r.update = earlier.length > 0;
      const item = p.item_id ? db.get('SELECT status, origin_blog FROM items WHERE id = ?', p.item_id) : null;
      // a revision counts from its observation; a source the route never handled counts from its publication
      const from = r.update ? cur.since : p.published_at;
      if (role?.role !== 'share' || (destRole && destRole.role === 'material')) r.action = 'skip', r.reason = 'role';
      else if (p.blog === route.dest || item?.origin_blog === route.dest) r.action = 'skip', r.reason = 'original_here';
      else if (!cur) r.action = p.state === 'queue' ? 'wait' : 'hold', r.reason = p.state === 'queue' ? 'queued' : 'not_read';
      else if (mine) r.action = 'done', r.reason = mine._copy ? 'already_there' : mine.status;
      else if (st.open) r.action = 'hold', r.reason = 'earlier_unresolved';
      else if (!history && (!route.since || !from || from < route.since)) r.action = 'skip', r.reason = 'before_route';
      else if (item && item.status === 'ambiguous') r.action = 'hold', r.reason = 'ambiguous';
      else if (excludedBy(tags, route.exclude)) r.action = 'skip', r.reason = 'excluded', r.tag = excludedBy(tags, route.exclude);
      else if (p.state === 'queue') r.action = 'wait', r.reason = 'queued';
      else if (p.state !== 'published') r.action = 'wait', r.reason = 'private';
      else r.action = 'reblog';
      out.push(r);
    }
  }
  return out;
}

// Claim copies already on the destination for the revision they hold, so they are never sent again and an
// older one can't be mistaken for a newer revision's receipt.
function claimCopies(db, blog, id, dest, routeId, now) {
  const revs = revisions(db, blog, id);
  for (const c of unclaimedCopies(db, blog, id, dest, revs)) {
    db.run(`INSERT OR IGNORE INTO deliveries (route_id, src_blog, src_id, rev, dest_blog, dest_id, status, reason, fingerprint, version_unknown, at)
      VALUES (?, ?, ?, ?, ?, ?, 'existing', ?, ?, ?, ?)`, routeId, blog, String(id), c.rev, dest, c.id, 'found on the destination', c.fp, c.unknown ? 1 : 0, now);
  }
}

// Queue reblogs for new revisions of every enabled route; record excluded revisions so that removing an exclusion
// later doesn't flood the destination (that is a separate, previewed backfill).
function plan(db, jobs, now = Date.now()) {
  let n = 0;
  for (const route of routesOf(db).filter(r => r.enabled)) {
    for (const r of preview(db, route)) {
      if (r.action === 'done' && r.reason === 'already_there') claimCopies(db, r.blog, r.id, route.dest, route.id, now);
      if (r.action === 'skip' && r.reason === 'excluded') {
        db.run(`INSERT OR IGNORE INTO deliveries (route_id, src_blog, src_id, rev, dest_blog, status, reason, at) VALUES (?, ?, ?, ?, ?, 'skipped', ?, ?)`,
          route.id, r.blog, r.id, r.rev, route.dest, 'excluded: ' + r.tag, now);
      }
      if (r.action !== 'reblog') continue;
      if (r.update) claimCopies(db, r.blog, r.id, route.dest, route.id, now);
      const rev = latestRevision(db, r.blog, r.id);
      db.run(`INSERT OR IGNORE INTO deliveries (route_id, src_blog, src_id, rev, dest_blog, status, fingerprint, at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        route.id, r.blog, r.id, rev.rev, route.dest, rev.fingerprint, now);
      jobs.add('post.reblog', { route: route.id, revision: route.revision, blog: r.blog, id: r.id, rev: rev.rev, fp: rev.fingerprint, dest: route.dest, state: route.delivery },
        { priority: 5, scope: `route:${route.id}:${r.blog}:${r.id}` });
      n++;
    }
  }
  return n;
}

// A user's explicit reblog of the source's current revision ("File into side blog", "Reblog the new version",
// backfill): no route checks, but a revision already on the destination is not sent again.
function manualReblog(db, jobs, { blog, id, dest, state = 'published' }) {
  id = String(id);
  const rev = latestRevision(db, blog, id);
  if (!rev) throw new Error('the source has not been read yet (sync first)');
  const st = standing(db, blog, id, dest);
  const have = st.delivered.get(rev.rev);
  if (have?.status === 'tombstone') throw new Error('this version’s reblog was deleted from that blog; it is not sent again (a new version can be)');
  if (have && ['created', 'existing', 'pending', 'unknown'].includes(have.status)) throw new Error('this version is already on the destination or on its way');
  if (st.open) throw new Error('an earlier version\'s reblog has an unknown outcome; resolve it in Activity first');
  db.run(`INSERT INTO deliveries (route_id, src_blog, src_id, rev, dest_blog, status, fingerprint, at) VALUES (NULL, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(src_blog, src_id, rev, dest_blog) DO UPDATE SET status = 'pending', dest_id = NULL, reason = NULL, fingerprint = excluded.fingerprint, at = excluded.at
    WHERE deliveries.status != 'tombstone'`,
  blog, id, rev.rev, dest, rev.fingerprint, Date.now());
  return jobs.add('post.reblog', { route: null, blog, id, rev: rev.rev, fp: rev.fingerprint, dest, state, manual: true }, { priority: 1, scope: `reblog:${blog}:${id}:${dest}` });
}

function mapSet(db, p, status, fields = {}) {
  db.run(`UPDATE deliveries SET status = ?, dest_id = COALESCE(?, dest_id), reason = ?, tags = COALESCE(?, tags), at = ? WHERE src_blog = ? AND src_id = ? AND rev = ? AND dest_blog = ?`,
    status, fields.destId ?? null, fields.reason ?? null, fields.tags ? J(fields.tags) : null, Date.now(), p.blog, String(p.id), p.rev, p.dest);
}
function mapClear(db, p) {
  db.run(`DELETE FROM deliveries WHERE src_blog = ? AND src_id = ? AND rev = ? AND dest_blog = ? AND status = 'pending'`, p.blog, String(p.id), p.rev, p.dest);
}

// Reblogs of src on dest made for this revision and not claimed by another delivery (read fresh from the
// destination's newest pages). since: only copies at least this new can be this attempt's.
async function findCopies(ctx, p, pages = 2, { since = 0, tags = null } = {}) {
  const found = [];
  let next = null;
  const claimed = new Set(ctx.db.all(`SELECT dest_id FROM deliveries WHERE dest_blog = ? AND dest_id IS NOT NULL AND NOT (src_blog = ? AND src_id = ? AND rev = ?)`,
    p.dest, p.blog, String(p.id), p.rev).map(r => r.dest_id));
  for (let i = 0; i < pages; i++) {
    const page = await ctx.tumblr.postsPage(p.dest, { next });
    for (const q of page.posts) {
      const r = upsertPost(ctx.db, q, p.dest, ctx.now());
      if (!r) continue;
      const a = r.after;
      if (!((a.parent_blog === p.blog && a.parent_id === String(p.id)) || (a.root_blog === p.blog && a.root_id === String(p.id)))) continue;
      if (claimed.has(a.id) || (a.published_at && a.published_at < since)) continue;
      if (trailFingerprint(q, p.id) !== p.fp) continue;
      if (tags && JSON.stringify(a.tags.map(C.key)) !== JSON.stringify(tags.map(C.key))) continue;
      found.push(a.id);
    }
    next = page.next;
    if (!next) break;
  }
  return found;
}

// After a create: the copy must hold this revision's body and the submitted tags. A mismatch is shown as a
// conflict; the new reblog is never edited to hide it and nothing is sent again on its own.
async function verifyCopy(ctx, p, destId, tags) {
  let q;
  try { q = await ctx.tumblr.getPost(p.dest, destId); upsertPost(ctx.db, q, p.dest, ctx.now()); } catch { return { ok: null }; }
  const bodyOk = trailFingerprint(q, p.id) === p.fp;
  const tagsOk = JSON.stringify((q.tags || []).map(C.key)) === JSON.stringify(tags.map(C.key));
  return { ok: bodyOk && tagsOk, bodyOk, tagsOk };
}

const reblog = {
  creates: true,
  async run(job, ctx) {
    const { db } = ctx;
    const p = job.payload;
    if (p.rev == null) throw new StaleError('planned before version tracking; it will be planned again');
    let route = null;
    if (!p.manual) {
      route = routesOf(db).find(r => r.id === p.route);
      if (!route || !route.enabled || route.revision !== p.revision) { mapClear(db, p); throw new StaleError('the route changed'); }
      // route automation may have been switched off since this was planned: nothing is sent (the next pass with
      // it on plans again)
      if (!db.getMeta('automation', {}).routes) { mapClear(db, p); return { status: 'cancelled', error: 'route automation is off' }; }
    }
    // An earlier revision whose reblog is unresolved goes first (no out-of-order or duplicate versions)
    const earlier = db.get(`SELECT rev FROM deliveries WHERE src_blog = ? AND src_id = ? AND dest_blog = ? AND rev < ? AND status = 'unknown'`, p.blog, String(p.id), p.dest, p.rev);
    if (earlier) { mapClear(db, p); return { status: 'skipped', error: 'an earlier version\'s reblog has an unknown outcome; resolve it first' }; }
    // Everything checked again right before sending, including that the source still has this body
    const { p: src, row } = await fresh(ctx, p.blog, p.id);
    if (contentFingerprint(src.content, src.layout) !== p.fp) {
      mapSet(db, p, 'superseded', { reason: 'the original changed again before sending' });
      return { status: 'skipped', error: 'the original changed again before sending; its newest version is planned on the next pass' };
    }
    if (row.state !== 'published') { mapClear(db, p); return { status: 'skipped', error: row.state === 'private' ? 'the original is private (Tumblr can\'t reblog it)' : 'not published' }; }
    if (route) {
      const ex = excludedBy(row.tags, route.exclude);
      if (ex) { mapSet(db, p, 'skipped', { reason: 'excluded: ' + ex }); return { status: 'skipped', error: 'excluded tag: ' + ex }; }
    }
    // a copy of this body made since the previous version was observed is this version's, even if it predates
    // the app noticing the edit (an edit on Tumblr reblogged there before the next pass)
    const existing = await findCopies(ctx, p, 1, { since: revisionStart(db, p.blog, p.id, p.rev) });
    if (existing.length) { mapSet(db, p, 'existing', { destId: existing[0], reason: 'already on the destination' }); return { status: 'unchanged', result: { dest_id: existing[0], note: 'this version is already on the destination' } }; }
    const tags = row.tags.slice();
    let id;
    try {
      id = await ctx.tumblr.reblog(p.dest, { parentBlog: p.blog, parentId: p.id, reblogKey: src.reblog_key ?? src.reblogKey, state: p.state || 'published',
        tags, reblogControl: (src.interactability_reblog ?? src.interactabilityReblog) === 'noone' ? 'noone' : undefined });
    } catch (e) {
      // A refusal leaves the original's reblog setting as it is; no temporary opening
      if (e instanceof NetError && e.uncertain) mapSet(db, p, 'unknown', { tags });
      else if (!(e instanceof NetError || e instanceof RateError || e instanceof AuthError || e instanceof WaitError)) mapSet(db, p, 'failed', { reason: String(e.message || e) });
      throw e;
    }
    if (!id) { mapSet(db, p, 'unknown', { tags }); return { status: 'unknown', error: 'no id in the response', nextAt: ctx.now() + 30_000, payload: { ...p, tags, sentAt: ctx.now() } }; }
    const v = await verifyCopy(ctx, p, id, tags);
    // the new copy belongs to its original's work now (and may change which blog manages it)
    require('./groups').rebuild(db, ctx.now());
    if (v.ok === false) {
      mapSet(db, p, 'conflict', { destId: id, tags, reason: !v.bodyOk ? 'the reblog does not hold the expected version of the original' : 'the reblog\'s tags differ from the ones sent' });
      return { status: 'succeeded', error: 'created, but not as expected (left as it is)', result: { dest_id: id, mismatch: true } };
    }
    mapSet(db, p, 'created', { destId: id, tags });
    return { status: 'succeeded', result: { dest_id: id, verified: v.ok === true } };
  },
  // A reblog whose response was lost: look for this revision's copy on the destination, never send it again
  // from here. Only an unclaimed copy with this body (and the sent tags) made after the attempt counts.
  async reconcile(job, ctx) {
    const p = job.payload;
    const tags = p.tags || deliveriesOf(ctx.db, p.blog, p.id, p.dest).find(d => d.rev === p.rev)?.tags || null;
    const found = await findCopies(ctx, p, 10, { since: (p.sentAt || job.created_at) - 120e3, tags });
    const tries = (job.result?.reconciles || 0) + 1;
    if (found.length === 1) { mapSet(ctx.db, p, 'created', { destId: found[0], tags }); return { status: 'succeeded', result: { dest_id: found[0], reconciled: true } }; }
    if (found.length > 1) { mapSet(ctx.db, p, 'unknown', { reason: 'several copies' }); return { status: 'unknown', error: `several possible copies (${found.join(', ')}); resolve by hand`, nextAt: ctx.now() + 365 * 86400e3, result: { found } }; }
    // Not finding it is no proof it wasn't made: stay unknown (looking every 6 hours) until found or resolved by you
    const needsUser = tries >= 5;
    const error = needsUser ? `no copy found on the destination yet; check there, then choose “It wasn't created” to allow sending it again`
      : 'looking for the copy on the destination';
    return { status: 'unknown', error, nextAt: ctx.now() + (needsUser ? 6 * 3600e3 : 60_000 * tries), result: { reconciles: tries, needsUser } };
  },
  abandon(job, ctx) { mapSet(ctx.db, job.payload, 'failed', { reason: 'you confirmed it was not created' }); },
};

// Sync hook: a destination copy was deleted → that version's tombstone (it won't be recreated; later versions can be)
function onGone(db, g) {
  db.run(`UPDATE deliveries SET status = 'tombstone', at = ? WHERE dest_blog = ? AND dest_id = ? AND status IN ('created', 'existing', 'conflict')`, Date.now(), g.blog, g.id);
}

// For a work's details: each destination's copies by version, and whether the source has a newer version
function versionsOf(db, blog, id) {
  const revs = revisions(db, blog, id);
  const latest = revs[revs.length - 1] || null;
  const dests = db.all(`SELECT DISTINCT dest_blog FROM deliveries WHERE src_blog = ? AND src_id = ?
    UNION SELECT DISTINCT blog FROM posts WHERE kind = 'reblog' AND state != 'gone' AND ((parent_blog = ? AND parent_id = ?) OR (root_blog = ? AND root_id = ?))`,
  blog, String(id), blog, String(id), blog, String(id)).map(r => r.dest_blog);
  const out = dests.map(dest => {
    const st = standing(db, blog, id, dest);
    const list = [...st.delivered.values()].sort((a, b) => a.rev - b.rev)
      .map(d => ({ rev: d.rev, status: d.status, dest_id: d.dest_id || null, version_unknown: !!d.version_unknown, tags: d.tags || null, reason: d.reason || null }));
    // further reblogs of the source on this blog that no delivery claims (a second copy of a version, made by
    // hand on Tumblr or elsewhere): listed so they can be seen, hidden or deleted like any other instance
    const shown = new Set(list.map(d => d.dest_id).filter(Boolean));
    for (const c of st.copies) if (!shown.has(c.id)) list.push({ rev: c.rev, status: 'extra', dest_id: c.id, version_unknown: !!c.unknown, tags: null, reason: null });
    list.sort((a, b) => a.rev - b.rev);
    const has = latest && st.delivered.get(latest.rev);
    return { dest, copies: list, newer: !!latest && !has && list.some(d => ['created', 'existing', 'tombstone', 'conflict'].includes(d.status)) };
  });
  return { revisions: revs.map(r => ({ rev: r.rev, since: r.since, baseline: !!r.baseline })), latest: latest?.rev || null, dests: out };
}

// Which revision a stored reblog instance holds (for labelling it as a historical snapshot)
function copyRevision(db, blog, id) {
  const d = db.get('SELECT src_blog, src_id, rev, version_unknown FROM deliveries WHERE dest_blog = ? AND dest_id = ?', blog, String(id));
  if (d) return { src_blog: d.src_blog, src_id: d.src_id, rev: d.rev, version_unknown: !!d.version_unknown };
  return null;
}

module.exports = { routesOf, saveRoute, preview, plan, manualReblog, reblog, excludedBy, cleanRuleTag, onGone, findCopies, baseline, versionsOf, copyRevision, standing };
