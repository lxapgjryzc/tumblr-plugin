'use strict';
const { postGone } = require('./gone');
// AI-made images among collected material (moved from the extension's collection page, A55). The rule is the
// extension's (src/core.js aiArtCheck / aiArtVerdict): the original poster's own tags decide; otherwise two or
// more other blogs saying so (their reblog tags and replies) with none against.
//
// Under docs/REBLOG_POLICY.md a collected reblog is a frozen snapshot, so the result is kept here (meta
// `aiArt`, per post) and never written onto the post (the extension used to add the tag `suspected ai`).
// Removing is an explicit, confirmed action: a post.delete job per reblog (only reblogs on material blogs are
// accepted), verified by reading it back, and optionally a like.remove job for the liked post it came from.

const C = require('./core');

const RECHECK_MS = 30 * 86400e3;

function addAiArt(svc, api) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;
  const coreApi = svc.ctx.tumblr && ((path, opts = {}) => svc.ctx.tumblr.request(path, (opts.method || 'GET') === 'GET' ? {} : { method: opts.method, json: opts.body }));
  const store = () => db.getMeta('aiArt', {}); // { 'blog:id': { verdict, why, n, at, root } }
  let run = null;

  const materialReblogs = blog => db.all(`SELECT p.blog, p.id, p.root_blog, p.root_id, p.parent_blog, p.parent_id, p.thumb, p.summary, p.published_at
    FROM posts p JOIN blogs b ON b.uuid = p.blog WHERE p.blog = ? AND b.role = 'material' AND p.kind = 'reblog' AND p.state IN ('published', 'private', 'queue') AND p.root_id IS NOT NULL
    ORDER BY p.published_at DESC`, blog);

  Object.assign(api, {
    aiArtStatus({ blog }) {
      const seen = store();
      const all = materialReblogs(blog);
      const fresh = all.filter(p => (seen[p.blog + ':' + p.id]?.at || 0) > now() - RECHECK_MS).length;
      return { posts: all.length, checked: fresh, running: run ? { i: run.i, n: run.n } : null };
    },
    aiArtStop() { if (run) run.aborted = true; return true; },
    // Reads only: the original post and its notes (about 3 requests a post), at most `limit` posts a run
    async aiArtCheck({ blog, limit = 60 }) {
      if (run) throw Object.assign(new Error('a check is already running'), { status: 409 });
      const seen = store();
      const todo = materialReblogs(blog).filter(p => (seen[p.blog + ':' + p.id]?.at || 0) <= now() - RECHECK_MS).slice(0, limit);
      const ctl = run = { aborted: false, i: 0, n: todo.length };
      let flagged = 0, failed = 0;
      try {
        for (const p of todo) {
          if (ctl.aborted) break;
          ctl.i++;
          svc.emit('aiart', { i: ctl.i, n: ctl.n });
          try {
            const v = await C.aiArtCheck(coreApi, p.root_blog + '/' + p.root_id);
            seen[p.blog + ':' + p.id] = { verdict: v.gone ? 'gone' : v.verdict, why: v.why || null, n: v.n || null, at: now() };
            if (v.verdict) flagged++;
          } catch { failed++; }
          db.setMeta('aiArt', seen);
        }
      } finally { run = null; }
      return { checked: ctl.i - failed, flagged, failed, stopped: ctl.aborted, left: Math.max(0, materialReblogs(blog).length - Object.keys(seen).length) };
    },
    // What was found (newest first); 'gone' = the original was deleted, so there is nothing to judge
    aiArtList({ blog }) {
      const seen = store();
      return materialReblogs(blog).map(p => ({ ...p, ...seen[p.blog + ':' + p.id] })).filter(p => p.verdict === 'ai' || p.verdict === 'suspect');
    },
    // Delete the chosen reblogs (and take back the likes they came from). Confirmed by the user in the page.
    aiArtRemove({ blog, ids = [], unlike = true }) {
      const ok = new Map(materialReblogs(blog).map(p => [p.id, p]));
      const chosen = ids.map(String).filter(id => ok.has(id));
      if (!chosen.length) return { queued: 0 };
      const batch = jobs.batch('Delete AI-made material', { blog, ids: chosen, unlike });
      for (const id of chosen) jobs.add('post.delete', { blog, id, unlike, reason: 'ai-art' }, { priority: 2, scope: `post:${blog}:${id}`, batch });
      return { queued: chosen.length };
    },
  });

  // Taking back a like (material.js registers the same job; whichever module loads first provides it)
  svc.handlers['like.remove'] ||= {
    async run(job, ctx) {
      await ctx.tumblr.request('/v2/user/unlike', { method: 'POST', json: { id: job.payload.id, reblog_key: job.payload.reblog_key } });
      return { status: 'succeeded' };
    },
  };

  // Delete one of my reblogs on a material blog. Idempotent: a post that is already gone counts as deleted.
  svc.handlers['post.delete'] = {
    async run(job, ctx) {
      const { blog, id, unlike } = job.payload;
      const row = db.get(`SELECT p.kind, p.parent_blog, p.parent_id, b.role FROM posts p JOIN blogs b ON b.uuid = p.blog WHERE p.blog = ? AND p.id = ?`, blog, id);
      if (!row) return { status: 'skipped', error: 'not a known post' };
      if (row.kind !== 'reblog' || row.role !== 'material') return { status: 'skipped', error: 'only reblogs on material blogs are deleted here' };
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
      db.run(`UPDATE posts SET state = 'gone' WHERE blog = ? AND id = ?`, blog, id);
      if (unlike && row.parent_blog && row.parent_id) {
        try {
          const parent = await ctx.tumblr.getPost(row.parent_blog, row.parent_id);
          const key = parent?.reblog_key || parent?.reblogKey;
          if (key) jobs.add('like.remove', { id: String(row.parent_id), reblog_key: key }, { priority: 7, scope: `unlike:${row.parent_id}` });
        } catch { /* the liked post is gone: nothing to unlike */ }
      }
      return { status: 'succeeded', result: { deleted: true } };
    },
  };
}

module.exports = { addAiArt };
