'use strict';
// Reading the user's blogs and posts into the local store, with durable coverage.
// A full pass pages to the end (Tumblr's total_posts leaves out private posts, so counts prove nothing) and keeps
// its cursor, so an interrupted pass continues where it stopped. An incremental pass reads from the newest post
// until it overlaps what is already known. Only a completed full pass may conclude that a post is gone.

const { upsertPost } = require('./posts');

const OVERLAP_MS = 2 * 86400e3;
const PAGES_PER_RUN = 8; // a long pass yields between chunks so user actions get in

function upsertBlogs(db, list, now = Date.now()) {
  db.tx(() => {
    for (const b of list) {
      db.run(`INSERT INTO blogs (uuid, name, title, is_primary, avatar, url, followers, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, title = excluded.title, is_primary = excluded.is_primary,
          avatar = excluded.avatar, url = excluded.url, followers = excluded.followers, updated_at = excluded.updated_at`,
      b.uuid, b.name, b.title || null, b.primary ? 1 : 0, b.avatar || null, b.url || null, b.followers ?? null, now);
    }
    // The main blog is always a sharing blog; other roles are set by the user, never guessed
    for (const b of list) if (b.primary) db.run(`UPDATE blogs SET role = 'share' WHERE uuid = ? AND role IS NULL`, b.uuid);
  });
}

function syncState(db, blog, box) {
  return db.get('SELECT * FROM sync_state WHERE blog = ? AND box = ?', blog, box)
    || { blog, box, complete: 0, cursor: null, full_started: null, full_done: null, inc_done: null, newest: null, error: null };
}
function saveSync(db, s) {
  db.run(`INSERT INTO sync_state (blog, box, complete, cursor, full_started, full_done, inc_done, newest, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(blog, box) DO UPDATE SET complete = excluded.complete, cursor = excluded.cursor,
    full_started = excluded.full_started, full_done = excluded.full_done, inc_done = excluded.inc_done, newest = excluded.newest, error = excluded.error`,
  s.blog, s.box, s.complete, s.cursor, s.full_started, s.full_done, s.inc_done, s.newest, s.error);
}

// One chunk of a blog sync. payload: { blog, box, mode: 'full' | 'inc' }. Returns { done, pages, changed, next }.
// resume: the `next` an earlier chunk of the same incremental pass returned (a full pass keeps its cursor in
// sync_state). Without it every chunk would start again at the newest page, and a blog whose newest pages all
// fall inside the overlap window would be read round and round.
async function syncChunk(ctx, { blog, box = '', mode = 'inc' }, resume = null) {
  const { db, tumblr, hooks = {} } = ctx;
  const now = ctx.now || Date.now;
  const boxKey = box || 'posts';
  const s = syncState(db, blog, boxKey);
  // Drafts and the queue are short: always read them whole. Without one finished full pass, an
  // incremental request is a full pass.
  if (box || !s.complete) mode = 'full';
  let next = null, changed = 0, pages = 0;
  if (mode === 'full') {
    if (s.cursor && s.full_started) next = JSON.parse(s.cursor);
    else { s.full_started = now(); s.cursor = null; }
  } else if (resume) next = resume;
  const stopBefore = mode === 'inc' && s.newest ? s.newest - OVERLAP_MS : null;
  let done = false;
  while (pages < PAGES_PER_RUN) {
    const page = await ctx.tumblr.postsPage(blog, { box, next });
    pages++;
    let oldest = Infinity;
    db.tx(() => {
      for (const p of page.posts) {
        const r = upsertPost(db, p, blog, now());
        if (!r) continue;
        if (!r.before || r.before.fingerprint !== r.after.fingerprint || r.before.state !== r.after.state
          || JSON.stringify(r.before.tags) !== JSON.stringify(r.after.tags)) changed++;
        if (r.after.published_at) oldest = Math.min(oldest, r.after.published_at);
        if (r.after.published_at && (!s.newest || r.after.published_at > s.newest)) s.newest = r.after.published_at;
        hooks.onPost?.(r.before, r.after);
      }
    });
    next = page.next;
    if (!next) { done = true; break; }
    if (stopBefore && oldest < stopBefore) { done = true; break; }
    if (mode === 'full') { s.cursor = JSON.stringify(next); saveSync(db, s); }
  }
  if (done) {
    if (mode === 'full') {
      // Everything of this box not seen since the pass started is gone from it
      const states = box === 'draft' ? ['draft'] : box === 'queue' ? ['queue'] : ['published', 'private'];
      const gone = db.all(`SELECT blog, id FROM posts WHERE blog = ? AND state IN (${states.map(() => '?').join(',')}) AND synced_at < ?`,
        blog, ...states, s.full_started);
      for (const g of gone) {
        db.run(`UPDATE posts SET state = 'gone' WHERE blog = ? AND id = ?`, g.blog, g.id);
        hooks.onGone?.(g);
      }
      s.complete = 1; s.full_done = now(); s.cursor = null;
    } else s.inc_done = now();
    s.error = null;
  }
  saveSync(db, s);
  return { done, pages, changed, next: done ? null : next };
}

// Coverage for the UI: per blog, whether the post list is complete and how fresh it is
function coverage(db) {
  return db.all(`SELECT b.uuid, b.name, s.box, s.complete, s.full_done, s.inc_done, s.cursor IS NOT NULL AS partial, s.error,
    (SELECT COUNT(*) FROM posts p WHERE p.blog = b.uuid AND p.state != 'gone') AS posts
    FROM blogs b LEFT JOIN sync_state s ON s.blog = b.uuid ORDER BY b.is_primary DESC, b.name`);
}

module.exports = { upsertBlogs, syncChunk, syncState, coverage, PAGES_PER_RUN };
