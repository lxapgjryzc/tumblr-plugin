'use strict';
// Job handlers for edits of existing posts. Each edit re-reads the post, changes only the intended fields in
// that fresh complete payload, sends the full post (Tumblr refuses partial PUTs) and then verifies by polling:
// a read right after a write can be stale, so an old read is never a reason to send the edit again.

const { upsertPost, editBody } = require('./posts');
const { policyOf, savePolicy, rulesOf } = require('./display');
const { StaleError, UnsupportedError, HttpError } = require('./errors');
const C = require('./core');

const VERIFY_DELAYS = [3e3, 6e3, 15e3, 30e3, 60e3, 5 * 60e3, 15 * 60e3];

// Fields the OAuth payload doesn't show can't be preserved. Community labels are such a field (stage 0);
// edits wait until the user has confirmed how labels behave (capability edit.labels).
function labelGate(ctx) {
  const s = ctx.db.capStatus('edit.labels');
  if (s === 'pass' || s === 'not_used') return;
  throw new UnsupportedError('community-label preservation not confirmed (Settings → Tumblr connection)');
}

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

function verifyStep(ctx, job, ok, out) {
  const n = job.payload.verifyN || 0;
  if (ok) return out;
  if (n >= VERIFY_DELAYS.length) return { status: 'failed', error: 'sent, but Tumblr still shows the old value', result: job.result };
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
    }
    const { p, row } = await fresh(ctx, blog, id);
    if (row.legacy) throw new UnsupportedError('legacy-format post');
    if (!['published', 'private'].includes(row.state)) return { status: 'skipped', error: 'not a published or private post' };
    if (reason === 'expiry' && row.state !== 'published') return { status: 'unchanged', error: 'already hidden' };
    if (row.state === target) return finish(ctx, job, row, 'unchanged');
    labelGate(ctx);
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
    pol.auto_hide = null; pol.display = job.payload.display || 'keep_visible';
    savePolicy(db, pol, ctx.now());
  }
  // the owner state is verified; what a visitor sees is checked separately later (visitor.js)
  if (status === 'succeeded' && ['published', 'private'].includes(row.state)) ctx.afterVisibility?.(blog, id, row.state);
  return { status, result: { state: row.state, at: ctx.now() } };
}

// Tags: payload { blog, id, add?: [], remove?: [], set?: [], upkeep?: [rule ids] }. Other tags stay exactly as
// stored. `upkeep` applies those pack-upkeep rules (core upkeepTags) to the post's tags as read now, with the
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
      return verifyStep(ctx, job, JSON.stringify(row.tags) === JSON.stringify(job.payload.expect), { status: 'succeeded', result: { tags: row.tags } });
    }
    const { p, row } = await fresh(ctx, blog, id);
    if (row.legacy) throw new UnsupportedError('legacy-format post');
    // A reblog is a frozen snapshot (docs/REBLOG_POLICY.md): its tags and body are never edited
    if (row.kind === 'reblog') return { status: 'skipped', error: 'a reblog is a historical snapshot and stays as it is' };
    const next = want(row.tags);
    if (JSON.stringify(next) === JSON.stringify(row.tags)) return { status: 'unchanged' };
    labelGate(ctx);
    await ctx.tumblr.putPost(blog, id, editBody(p, { tags: next }));
    return { status: 'verifying', payload: { ...job.payload, phase: 'verify', verifyN: 0, expect: next }, nextAt: ctx.now() + 2000 };
  },
};

module.exports = { visibility, tags, fresh, labelGate, verifyStep };
