'use strict';
// Job handlers for edits of existing posts. Each edit re-reads the post, changes only the intended fields in
// that fresh complete payload, sends the full post (Tumblr refuses partial PUTs) and then verifies by polling:
// a read right after a write can be stale, so an old read is never a reason to send the edit again.

const { upsertPost, editBody } = require('./posts');
const { policyOf, savePolicy, rulesOf } = require('./display');
const { StaleError, UnsupportedError, HttpError } = require('./errors');
const C = require('./core');

const VERIFY_DELAYS = [3e3, 6e3, 15e3, 30e3, 60e3, 5 * 60e3, 15 * 60e3];

async function fresh(ctx, blog, id) {
  let p;
  try { p = await ctx.tumblr.getPost(blog, id); }
  catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      ctx.db.run(`UPDATE posts SET state = 'gone' WHERE blog = ? AND id = ?`, blog, String(id));
      throw new UnsupportedError('the post no longer exists');
    }
    throw e;
  }
  const r = upsertPost(ctx.db, p, blog, ctx.now());
  return { p, row: r?.after };
}

function verifyStep(ctx, job, ok, out, failError = 'sent, but Tumblr still shows the old value') {
  const n = job.payload.verifyN || 0;
  if (ok) return out;
  if (n >= VERIFY_DELAYS.length) return { status: 'failed', error: failError, result: job.result };
  return { status: 'verifying', payload: { ...job.payload, phase: 'verify', verifyN: n + 1 }, nextAt: ctx.now() + VERIFY_DELAYS[n], result: job.result };
}

const visibility = {
  async run(job, ctx) {
    const { db } = ctx;
    const { blog, id, target, reason } = job.payload;
    if (job.payload.phase === 'verify') {
      const { row } = await fresh(ctx, blog, id);
      const ok = row.state === target;
      return verifyStep(ctx, job, ok, finish(ctx, job, row));
    }
    // An expiry hide must still be what the current rule and policy want
    if (reason === 'expiry') {
      const rule = rulesOf(db).find(r => r.id === job.payload.rule);
      if (!rule || !rule.enabled || rule.revision !== job.payload.ruleRevision) throw new StaleError('the rule changed');
      if (policyOf(db, blog, id).display !== 'follow_rule') throw new StaleError('the post has its own display choice now');
      if (!db.getMeta('automation', {}).expiry) return { status: 'cancelled', error: 'automatic hiding is off' };
    }
    const { p, row } = await fresh(ctx, blog, id);
    if (row.legacy) throw new UnsupportedError('legacy-format post');
    if (!['published', 'private'].includes(row.state)) return { status: 'skipped', error: 'not a published or private post' };
    if (reason === 'expiry' && row.state !== 'published') return { status: 'unchanged', error: 'already hidden' };
    if (row.state === target) return finish(ctx, job, row, 'unchanged');
    await ctx.tumblr.putPost(blog, id, editBody(p, { state: target }));
    return { status: 'verifying', payload: { ...job.payload, phase: 'verify', verifyN: 0, prev: row.state }, nextAt: ctx.now() + 2000, result: { sent: ctx.now() } };
  },
};

function finish(ctx, job, row, status = 'succeeded') {
  const { db } = ctx;
  const { blog, id, target, reason } = job.payload;
  const pol = policyOf(db, blog, id);
  if (reason === 'expiry' && row.state === 'private' && status === 'succeeded') {
    pol.auto_hide = { op: job.id, rule: job.payload.rule, revision: job.payload.ruleRevision, prev: 'published', at: ctx.now() };
    savePolicy(db, pol, ctx.now());
  }
  if (reason === 'restore' && row.state === 'published') {
    pol.auto_hide = null; pol.display = job.payload.display || 'keep_visible'; pol.display_at = ctx.now(); pol.display_src = 'user';
    savePolicy(db, pol, ctx.now());
  }
  // the owner state is verified; what a visitor sees is checked separately later (visitor.js)
  if (status === 'succeeded' && ['published', 'private'].includes(row.state)) ctx.afterVisibility?.(blog, id, row.state);
  return { status, result: { state: row.state, at: ctx.now() } };
}

// General categories come first on every original, in their configured group and option order (spec 6.2–6.3:
// categories → template tags → extras; heat sorting never pushes them back). Every other tag keeps its place.
function categoryFirst(db, tags) {
  const rank = new Map();
  db.all(`SELECT c.tag FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id
    ORDER BY c.group_id IS NULL, g.ord, g.id, c.ord, c.id`).forEach((c, i) => { if (!rank.has(C.key(c.tag))) rank.set(C.key(c.tag), i); });
  const cats = tags.filter(t => rank.has(C.key(t))).sort((a, b) => rank.get(C.key(a)) - rank.get(C.key(b)));
  return [...cats, ...tags.filter(t => !rank.has(C.key(t)))];
}
// Originals whose category tags aren't in front (with nothing else to change): one tags job each
function queueCategoryFirst(db, jobs) {
  let n = 0;
  for (const p of db.all(`SELECT blog, id, tags FROM posts WHERE kind = 'original' AND state IN ('published', 'private', 'queue', 'draft')`)) {
    const cur = JSON.parse(p.tags || '[]');
    if (JSON.stringify(categoryFirst(db, cur)) === JSON.stringify(cur)) continue;
    const scope = `post:${p.blog}:${p.id}`;
    if (db.get(`SELECT 1 FROM jobs WHERE scope = ? AND status IN ('pending', 'running', 'verifying', 'waiting', 'unknown')`, scope)) continue;
    jobs.add('post.tags', { blog: p.blog, id: String(p.id), add: [] }, { priority: 4, scope }); n++;
  }
  return n;
}

// Tags: payload { blog, id, add?: [], remove?: [], set?: [], upkeep?: [rule ids] }. Other tags stay exactly as
// stored, except that general categories are moved to the front (categoryFirst). `upkeep` applies those pack-upkeep rules (core upkeepTags) to the post's tags as read now, with the
// packs as they are now (ctx.packs, see tidy.js). Originals only.
const tags = {
  async run(job, ctx) {
    const { blog, id, add = [], remove = [], set, upkeep } = job.payload;
    const want = cur => {
      if (set) return set.slice();
      if (upkeep) { const allow = new Set(upkeep); return C.upkeepTags(cur, ctx.packs ? ctx.packs() : [], ch => allow.has(ch.rule)).tags; }
      // a category's tag changed: the old tag is replaced where it stands (or dropped if the new one is there)
      if (job.payload.replace) {
        const { from, to } = job.payload.replace;
        const fk = C.key(from), tk = C.key(to);
        const hasTo = cur.some(x => C.key(x) === tk);
        return cur.flatMap(x => (C.key(x) !== fk ? [x] : hasTo ? [] : [to]));
      }
      const rm = new Set(remove.map(C.key));
      return C.withTags(cur.filter(t => !rm.has(C.key(t))), add);
    };
    if (job.payload.phase === 'verify') {
      const { row } = await fresh(ctx, blog, id);
      const ok = JSON.stringify(row.tags) === JSON.stringify(job.payload.expect);
      if (ok) ctx.afterTags?.(blog, id); // my reblogs of this original take its new tags (copytags.js)
      return verifyStep(ctx, job, ok, { status: 'succeeded', result: { tags: row.tags } });
    }
    const { p, row } = await fresh(ctx, blog, id);
    if (row.legacy) throw new UnsupportedError('legacy-format post');
    // A reblog is a frozen snapshot (docs/REBLOG_POLICY.md): its tags and body are never edited
    if (row.kind === 'reblog') return { status: 'skipped', error: 'a reblog takes its tags from its original; edit the original' };
    const next = categoryFirst(ctx.db, want(row.tags));
    if (JSON.stringify(next) === JSON.stringify(row.tags)) return { status: 'unchanged' };
    await ctx.tumblr.putPost(blog, id, editBody(p, { tags: next }));
    return { status: 'verifying', payload: { ...job.payload, phase: 'verify', verifyN: 0, expect: next }, nextAt: ctx.now() + 2000 };
  },
};

module.exports = { visibility, tags, fresh, verifyStep, categoryFirst, queueCategoryFirst };
