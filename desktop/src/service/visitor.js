'use strict';
// Visitor checks (design `public_check`, section on visibility): after a visibility change is verified for the
// owner, look again as a logged-out visitor would — the public API with the app key only, no user token — and
// record what was seen, with the time and the route. Kept apart from the owner state:
//  - `pending` until the first look; `visible` / `not_visible_at_check` are observations at that time, not
//    promises (Stage 0 saw the public view settle after ~1 s once and ~70 s another time);
//  - a timeout, network or authentication error is `unknown`, never proof that the post is hidden;
//  - a post that should be hidden but is still seen is looked at again a few times with growing waits.

const WAITS = [90e3, 5 * 60e3, 20 * 60e3]; // first look, then two more if the view hasn't settled
const ROUTE = 'api:public (app key, no login)';

function addVisitor(svc, api) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;
  const set = (blog, id, fields) => db.run(`INSERT INTO public_checks (blog, id, expect, state, checked_at, route, detail) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(blog, id) DO UPDATE SET expect = excluded.expect, state = excluded.state, checked_at = excluded.checked_at, route = excluded.route, detail = excluded.detail`,
  blog, String(id), fields.expect ?? null, fields.state, fields.checked_at ?? null, ROUTE, fields.detail ?? null);

  // ops.visibility calls this once the owner state is verified
  svc.ctx.afterVisibility = (blog, id, state) => {
    set(blog, id, { expect: state === 'private' ? 'hidden' : 'visible', state: 'pending' });
    jobs.add('post.publicCheck', { blog, id: String(id), expect: state === 'private' ? 'hidden' : 'visible', n: 0 },
      { priority: 8, scope: `public:${blog}:${id}`, supersede: true, at: now() + WAITS[0] });
  };

  svc.handlers['post.publicCheck'] = {
    async run(job, ctx) {
      const { blog, id, expect, n = 0 } = job.payload;
      const name = db.get('SELECT name FROM blogs WHERE uuid = ?', blog)?.name || blog;
      let seen;
      try {
        const r = await ctx.tumblr.request(`/v2/blog/${encodeURIComponent(name)}/posts?id=${encodeURIComponent(id)}`, { bearer: false, retries: 0 });
        seen = (r?.posts || []).some(p => String(p.id_string ?? p.id) === String(id));
      } catch (e) {
        if (e.status === 404) seen = false;
        else {
          set(blog, id, { expect, state: 'unknown', checked_at: ctx.now(), detail: String(e.message || e).slice(0, 200) });
          return { status: 'succeeded', result: { state: 'unknown' } };
        }
      }
      const state = seen ? 'visible' : 'not_visible_at_check';
      set(blog, id, { expect, state, checked_at: ctx.now() });
      // still seen although it should be hidden: the public view may not have settled yet; look again later
      if (expect === 'hidden' && seen && n + 1 < WAITS.length) {
        return { status: 'pending', payload: { ...job.payload, n: n + 1 }, nextAt: ctx.now() + WAITS[n + 1], result: { state, n: n + 1 } };
      }
      return { status: 'succeeded', result: { state } };
    },
  };

  Object.assign(api, {
    publicCheck({ blog, id }) { return db.get('SELECT * FROM public_checks WHERE blog = ? AND id = ?', blog, String(id)) || null; },
    publicCheckNow({ blog, id }) {
      const st = db.get('SELECT state FROM posts WHERE blog = ? AND id = ?', blog, String(id))?.state;
      const expect = st === 'private' ? 'hidden' : 'visible';
      set(blog, id, { expect, state: 'pending' });
      jobs.add('post.publicCheck', { blog, id: String(id), expect, n: WAITS.length - 1 }, { priority: 2, scope: `public:${blog}:${id}`, supersede: true });
      return { ok: true };
    },
  });
}

module.exports = { addVisitor, WAITS };
