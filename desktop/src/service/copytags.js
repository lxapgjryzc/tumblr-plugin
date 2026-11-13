'use strict';
// Reblog snapshot tags follow their original (user revision 2026-11-06, docs/REBLOG_POLICY.md): every reblog of
// one of my own originals, on any of my blogs and of any version, carries exactly the original's current tags in
// the same order. Only the tags: the reblog's body, layout and the version it holds stay frozen, and a tags-only
// change is still not a new version, so it never makes another reblog (routes.js decides that by content alone).
//
// Each copy is its own `copy.tags` job: the copy and the original are read fresh, the copy is sent back whole
// with the original's tags (posts.editBody keeps everything else as stored), then read back. Queued right after
// an original's tags are edited here, and by every pass for edits made on Tumblr. Runs while route automation
// is on (it is part of keeping my blogs' reblogs in line), behind the community-label gate like every edit.

const { P } = require('./db');
const { editBody } = require('./posts');
const { fresh, verifyStep } = require('./ops');

const PER_PASS = 40;

function addCopyTags(svc) {
  const { db, jobs } = svc;
  const on = () => !!db.getMeta('automation', {}).routes;

  // Reblogs of my own originals whose tags differ from the original's (exact, ordered)
  function drifted(src = null) {
    const owned = new Set(db.all('SELECT uuid FROM blogs').map(b => b.uuid));
    const copies = db.all(`SELECT blog, id, tags, parent_blog, parent_id, root_blog, root_id FROM posts WHERE kind = 'reblog' AND state IN ('published', 'private', 'queue')`);
    const out = [];
    for (const c of copies) {
      const cand = [[c.root_blog, c.root_id], [c.parent_blog, c.parent_id]].filter(([b, i]) => b && i && owned.has(b));
      const o = cand.map(([b, i]) => db.get(`SELECT blog, id, tags FROM posts WHERE blog = ? AND id = ? AND kind = 'original' AND state != 'gone'`, b, String(i))).find(Boolean);
      if (!o || (src && (o.blog !== src.blog || o.id !== String(src.id)))) continue;
      if (c.tags !== o.tags && JSON.stringify(P(c.tags, [])) !== JSON.stringify(P(o.tags, []))) out.push({ blog: c.blog, id: c.id, src_blog: o.blog, src_id: o.id });
    }
    return out;
  }
  function queue(list) {
    let n = 0;
    for (const x of list) {
      const scope = `post:${x.blog}:${x.id}`;
      if (db.get(`SELECT 1 FROM jobs WHERE scope = ? AND status IN ('pending', 'running', 'verifying', 'waiting', 'unknown')`, scope)) continue;
      jobs.add('copy.tags', x, { priority: 3, scope });
      if (++n >= PER_PASS) break;
    }
    return n;
  }

  // after a tag edit on an original made here (ops.tags calls this once verified)
  svc.ctx.afterTags = (blog, id) => { if (on()) queue(drifted({ blog, id })); };
  // every pass: edits made on Tumblr
  svc.afterPass = [...(svc.afterPass || []), () => (on() ? queue(drifted()) : 0)];

  svc.handlers['copy.tags'] = {
    async run(job, ctx) {
      const { blog, id, src_blog, src_id } = job.payload;
      if (job.payload.phase === 'verify') {
        const { row } = await fresh(ctx, blog, id);
        return verifyStep(ctx, job, JSON.stringify(row.tags) === JSON.stringify(job.payload.expect), { status: 'succeeded', result: { tags: row.tags } });
      }
      // the original's tags as last verified (a tag edit here reads it back; a pass syncs edits made on Tumblr
      // before queueing), so only the reblog itself is read: one request saved per copy
      // route automation may have been switched off since this was queued: nothing is sent then (a copy already
      // sent is still verified above)
      if (!on()) return { status: 'cancelled', error: 'route automation is off' };
      const src = db.get(`SELECT tags FROM posts WHERE blog = ? AND id = ? AND kind = 'original' AND state != 'gone'`, src_blog, String(src_id));
      if (!src) return { status: 'skipped', error: 'the original is gone' };
      const { p, row } = await fresh(ctx, blog, id);
      if (row.kind !== 'reblog') return { status: 'skipped', error: 'not a reblog' };
      if (row.legacy) return { status: 'skipped', error: 'legacy-format post' };
      const want = P(src.tags, []);
      if (JSON.stringify(want) === JSON.stringify(row.tags)) return { status: 'unchanged' };
      await ctx.tumblr.putPost(blog, id, editBody(p, { tags: want }));
      return { status: 'verifying', payload: { ...job.payload, phase: 'verify', verifyN: 0, expect: want }, nextAt: ctx.now() + 2000 };
    },
  };

  return { drifted, queue };
}

module.exports = { addCopyTags };
