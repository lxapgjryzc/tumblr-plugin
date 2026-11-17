'use strict';
// Optional settings blog (user request 2026-11-17). With two computers each running the app, a "keep public" chosen
// on one was unknown to the other, whose display rule then hid the post. When the user picks a blog of their own for
// it, the per-post display choices (keep public / keep hidden / back to the rules) and the posts a display rule hid
// are kept in one private post on that blog. Every computer reads it before each pass plans anything, takes the
// newer choice for each post, and writes the post back when it has newer choices of its own.
//
// - Only choices made in this app travel (display_src 'user'). A change seen on Tumblr is seen by every computer
//   anyway, so it is not sent; a hide seen here that another computer's rule made (listed under `auto`) is put
//   back to "follow the rules" instead of being kept as a choice.
// - The first time a computer joins, its earlier choices can't be ordered against the post's: wherever the two
//   differ, nothing is applied or sent for that post until the user picks one (`conflicts`).
// - The settings blog itself is not synced as posts. Without a settings blog nothing here runs.
// - Writes are full-post edits of that one private post (or its creation); an unreadable post is never
//   overwritten. A lost create is looked for by its tag before creating again.

const os = require('node:os');
const crypto = require('node:crypto');
const { P } = require('./db');
const display = require('./display');
const { editBody } = require('./posts');
const { HttpError } = require('./errors');

const TAG = 'tumblr-studio-settings';
const HEAD = 'Tumblr Studio settings, written by the app on your computers. Please don’t edit or delete this post.';
const CHUNK = 3000;                 // text per block
const AUTO_KEEP = 60 * 86400e3;     // rule hides are only needed while the other computer may not have seen them
const RESET_KEEP = 90 * 86400e3;    // "back to the rules" only has to outlive older choices elsewhere
const SLACK = 10 * 60e3;            // a hide seen here this long before the rule hide was listed still counts as it
const DISPLAYS = ['keep_visible', 'keep_hidden', 'follow_rule'];

const empty = () => ({ v: 1, posts: {}, auto: {}, by: {} });
const keyOf = (blog, id) => blog + '/' + id;
const splitKey = k => { const i = k.lastIndexOf('/'); return [k.slice(0, i), k.slice(i + 1)]; };

// The post's JSON (the text blocks after the heading), or null when it isn't a settings post this app can read
function parseDoc(post) {
  const texts = (post.content || []).filter(b => b.type === 'text').map(b => String(b.text || ''));
  if (texts[0] !== HEAD) return null;
  let d;
  try { d = JSON.parse(texts.slice(1).join('')); } catch { return null; }
  if (!d || d.v !== 1 || typeof d.posts !== 'object' || typeof d.auto !== 'object') return null;
  const out = empty();
  for (const [k, v] of Object.entries(d.posts)) if (Array.isArray(v) && DISPLAYS.includes(v[0]) && Number.isFinite(v[1])) out.posts[k] = [v[0], v[1]];
  for (const [k, v] of Object.entries(d.auto)) if (Number.isFinite(v)) out.auto[k] = v;
  out.by = d.by && typeof d.by === 'object' ? d.by : {};
  return out;
}
function render(doc) {
  const s = JSON.stringify(doc);
  const blocks = [{ type: 'text', text: HEAD }];
  for (let i = 0; i < s.length; i += CHUNK) blocks.push({ type: 'text', text: s.slice(i, i + CHUNK) });
  return blocks;
}
// Two copies of the post (a create made twice): the newer entry of each wins
function mergeDocs(a, b) {
  const out = { v: 1, posts: { ...a.posts }, auto: { ...a.auto }, by: { ...a.by, ...b.by } };
  for (const [k, v] of Object.entries(b.posts)) if (!out.posts[k] || out.posts[k][1] < v[1]) out.posts[k] = v;
  for (const [k, v] of Object.entries(b.auto)) if (!out.auto[k] || out.auto[k] < v) out.auto[k] = v;
  return out;
}
const sameContent = (a, b) => JSON.stringify([a.posts, a.auto]) === JSON.stringify([b.posts, b.auto]);

function addSettingsSync(svc, api) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;
  const state = () => db.getMeta('settingsSync', {});
  const save = patch => db.setMeta('settingsSync', { ...state(), ...patch });
  const installId = () => {
    let id = db.getMeta('installId', null);
    if (!id) { id = crypto.randomUUID(); db.setMeta('installId', id); }
    return id;
  };

  function schedule(priority = 6) {
    if (!state().blog) return null;
    const open = db.get(`SELECT id FROM jobs WHERE kind = 'settings.sync' AND status IN ('pending', 'running', 'waiting')`);
    return open ? open.id : jobs.add('settings.sync', {}, { priority, scope: 'settings-sync' });
  }
  // something of this computer's that the settings post doesn't have yet
  function dirty() {
    const st = state();
    if (!st.blog || st.error) return false;
    const since = st.lastSync || 0;
    return !!db.get(`SELECT 1 FROM policies WHERE (display_src = 'user' AND display_at > ?)
      OR (auto_hide IS NOT NULL AND json_extract(auto_hide, '$.at') > ? AND json_extract(auto_hide, '$.unverified') IS NULL) LIMIT 1`, since, since);
  }
  svc.tickers?.push(() => { if (dirty()) schedule(3); });

  // The blog is not a blog of works: a stored copy of its settings post and the content item left without posts go.
  function dropStored(blog, t) {
    const orphan = `items.origin_blog = ? AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = items.id)`;
    const n = db.get(`SELECT (SELECT COUNT(*) FROM posts WHERE blog = ?) + (SELECT COUNT(*) FROM items WHERE ${orphan}) n`, blog, blog).n;
    if (!n) return false;
    db.run('DELETE FROM posts WHERE blog = ?', blog);
    db.run(`DELETE FROM items WHERE ${orphan}`, blog);
    require('./groups').rebuild(db, t);
    return true;
  }

  async function findPosts(ctx, blog) {
    const found = [];
    let next = null;
    for (let i = 0; i < 10; i++) {
      const page = await ctx.tumblr.postsPage(blog, { next });
      for (const q of page.posts) if ((q.tags || []).includes(TAG)) found.push(q);
      next = page.next;
      if (!next) break;
    }
    return found.sort((a, b) => (BigInt(a.id_string || a.id) < BigInt(b.id_string || b.id) ? -1 : 1));
  }

  // Take what the post says into the local choices. On the first join, differing choices become conflicts; posts
  // with an unresolved conflict (`held`) are left alone both ways until the user picks.
  function pull(remote, joined, t, held) {
    const local = new Map(db.all('SELECT * FROM policies').map(p => [keyOf(p.blog, p.id), { ...p, auto_hide: P(p.auto_hide) }]));
    const conflicts = [], publish = [];
    const differs = (k, here, there, thereAt) => conflicts.push({ key: k, here, there, thereAt });
    db.tx(() => {
      for (const [k, [d, at]] of Object.entries(remote.posts)) {
        if (held.has(k)) continue;
        const L = local.get(k);
        if (!joined && L) {
          if (L.display !== 'follow_rule' && L.display !== d) { differs(k, L.display, d, at); continue; }
          if (L.display === 'follow_rule' && L.auto_hide && !L.auto_hide.unverified && d !== 'follow_rule') { differs(k, 'rule_hidden', d, at); continue; }
        }
        if (L && ['user', 'observed'].includes(L.display_src) && (L.display_at || 0) >= at) continue;
        if (L ? L.display === d : d === 'follow_rule') continue;
        const [blog, id] = splitKey(k);
        // this computer's own rule hid it and the newer choice is to keep it public: take that hide back
        if (d === 'keep_visible' && L?.auto_hide && db.get(`SELECT state FROM posts WHERE blog = ? AND id = ?`, blog, id)?.state === 'private') publish.push({ blog, id });
        display.setDisplay(db, blog, id, d, t, { src: 'sync', at });
      }
      for (const [k, at] of Object.entries(remote.auto)) {
        const L = local.get(k);
        if (held.has(k) || !L || L.display !== 'keep_hidden' || remote.posts[k]) continue;
        if (!joined && L.display_src !== 'observed') { differs(k, 'keep_hidden', 'rule_hidden', at); continue; }
        // a hide seen here that another computer's rule made is not a choice
        if (L.display_src === 'observed' && (L.display_at || 0) >= at - SLACK) {
          const [blog, id] = splitKey(k);
          display.setDisplay(db, blog, id, 'follow_rule', t, { src: 'sync', at });
        }
      }
      // joining: what was chosen here before (or imported) and the post doesn't contradict goes up as this
      // computer's choice
      if (!joined) {
        const skip = new Set([...held, ...conflicts.map(c => c.key)]);
        for (const p of local.values()) {
          if (p.display === 'follow_rule' || skip.has(keyOf(p.blog, p.id))) continue;
          if (p.display_src == null || p.display_src === 'import') db.run(`UPDATE policies SET display_src = 'user', display_at = COALESCE(display_at, updated_at) WHERE blog = ? AND id = ?`, p.blog, p.id);
        }
      }
    });
    for (const x of publish) jobs.add('post.visibility', { blog: x.blog, id: String(x.id), target: 'published', reason: 'settings' }, { priority: 2, scope: `post:${x.blog}:${x.id}`, supersede: true });
    return { conflicts, published: publish.length };
  }

  // The post as it should be: what it said plus this computer's newer choices and rule hides
  function build(remote, held, t) {
    const doc = { v: 1, posts: { ...remote.posts }, auto: { ...remote.auto }, by: { ...remote.by } };
    for (const p of db.all(`SELECT blog, id, display, display_at FROM policies WHERE display_src = 'user'`)) {
      const k = keyOf(p.blog, p.id);
      if (held.has(k)) continue;
      const at = p.display_at || 0, r = doc.posts[k];
      if (!r || r[1] < at) doc.posts[k] = [p.display, at];
    }
    for (const p of db.all(`SELECT blog, id, auto_hide FROM policies WHERE auto_hide IS NOT NULL`)) {
      const a = P(p.auto_hide);
      if (!a?.at || a.unverified) continue;
      const k = keyOf(p.blog, p.id);
      if (!doc.auto[k] || doc.auto[k] < a.at) doc.auto[k] = a.at;
    }
    for (const [k, at] of Object.entries(doc.auto)) if (at < t - AUTO_KEEP) delete doc.auto[k];
    for (const [k, [d, at]] of Object.entries(doc.posts)) if (d === 'follow_rule' && at < t - RESET_KEEP) delete doc.posts[k];
    return doc;
  }

  svc.handlers['settings.sync'] = {
    async run(job, ctx) {
      const st = state();
      if (!st.blog) return { status: 'skipped', error: 'no settings blog' };
      const t = ctx.now();
      // a copy stored before the blog was picked (or by a sync job queued then) is not a work
      dropStored(st.blog, t);
      let posts = [];
      if (st.post) {
        try { posts = [await ctx.tumblr.getPost(st.blog, st.post)]; } catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; }
      }
      if (!posts.length) posts = await findPosts(ctx, st.blog);
      let remote = empty();
      for (const q of posts) {
        const d = parseDoc(q);
        if (!d) {
          const error = `the settings post ${q.id_string || q.id} can't be read (edited by hand?); nothing was written`;
          save({ error, post: String(q.id_string || q.id) });
          return { status: 'failed', error };
        }
        remote = mergeDocs(remote, d);
      }
      const main = posts[0] || null;
      const held = new Set((st.conflicts || []).map(c => c.key));
      const { conflicts, published } = pull(remote, !!st.joined, t, held);
      const next = build(remote, new Set([...held, ...conflicts.map(c => c.key)]), t);
      let id = main ? String(main.id_string || main.id) : null, wrote = false;
      if (!main || !sameContent(next, remote)) {
        next.by[installId()] = { name: os.hostname(), at: t };
        if (main) await ctx.tumblr.putPost(st.blog, id, editBody(main, { content: render(next), layout: [] }));
        else id = await ctx.tumblr.createPost(st.blog, { content: render(next), layout: [], state: 'private', tags: TAG });
        wrote = true;
      }
      // what was written must read back as written; a copy Tumblr changed would otherwise be overwritten blindly
      if (wrote && id) {
        const back = parseDoc(await ctx.tumblr.getPost(st.blog, id).catch(() => ({ content: render(next) })));
        if (!back) { const error = 'the settings post did not read back as written'; save({ error, post: id }); return { status: 'failed', error }; }
      }
      // conflicts resolved while this ran are not brought back
      const kept = (state().conflicts || []).filter(c => held.has(c.key));
      save({ post: id, joined: true, lastSync: t, error: null, conflicts: [...kept, ...conflicts],
        entries: Object.keys(next.posts).length, computers: Object.values(next.by).map(b => b.name) });
      return { status: 'succeeded', result: { wrote, conflicts: conflicts.length, published, entries: Object.keys(next.posts).length } };
    },
  };

  svc.settingsSync = { blog: () => state().blog || null, schedule };

  const blogName = uuid => db.get('SELECT name FROM blogs WHERE uuid = ?', uuid)?.name || uuid;
  Object.assign(api, {
    settingsSyncStatus() {
      const st = state();
      const conflicts = (st.conflicts || []).map(c => {
        const [blog, id] = splitKey(c.key);
        const p = db.get('SELECT state, summary, thumb FROM posts WHERE blog = ? AND id = ?', blog, id);
        return { ...c, blog, id, name: blogName(blog), state: p?.state || null, summary: p?.summary || null, thumb: p?.thumb || null };
      });
      return {
        blog: st.blog || null, name: st.blog ? blogName(st.blog) : null, post: st.post || null,
        url: st.blog && st.post ? `https://www.tumblr.com/${blogName(st.blog)}/${st.post}` : null,
        lastSync: st.lastSync || null, error: st.error || null, joined: !!st.joined, entries: st.entries ?? null, computers: st.computers || [],
        conflicts,
        candidates: db.all('SELECT uuid, name, role FROM blogs WHERE is_primary = 0 ORDER BY name'),
        open: db.get(`SELECT id, status, error FROM jobs WHERE kind = 'settings.sync' ORDER BY id DESC LIMIT 1`) || null,
      };
    },
    // Optional: a blog used for nothing else. Turning it off keeps every choice here as it is.
    setSettingsBlog({ blog = null }) {
      if (!blog) { db.setMeta('settingsSync', {}); return api.settingsSyncStatus(); }
      const b = db.get('SELECT uuid, is_primary, role FROM blogs WHERE uuid = ?', blog);
      if (!b) throw new Error('unknown blog');
      if (b.is_primary) throw new Error('the main blog can’t be the settings blog');
      if (b.role) throw new Error('this blog is used for posts (sharing or material); pick a blog used for nothing else');
      const own = db.get(`SELECT COUNT(*) n FROM posts WHERE blog = ? AND state != 'gone' AND tags NOT LIKE ?`, blog, `%"${TAG}"%`).n;
      if (own) throw new Error(`this blog has ${own} posts of its own; pick an empty blog used for nothing else`);
      // a new choice of blog joins afresh (its post may hold another computer's choices)
      db.setMeta('settingsSync', { blog });
      // its settings post, if an earlier version read it as a post, is not one of the works
      dropStored(blog, now());
      schedule(2);
      return api.settingsSyncStatus();
    },
    settingsSyncNow() { if (state().error) save({ error: null }); return { job: schedule(2) }; },
    // A first-join difference: keep this computer's choice ('here') or the settings blog's ('there'). Either way
    // it is a choice made now, so it is applied (publishing or hiding as needed) and sent to the other computers.
    settingsSyncResolve({ keys, pick }) {
      const st = state();
      const want = new Set(keys);
      const left = [];
      for (const c of st.conflicts || []) {
        if (!want.has(c.key)) { left.push(c); continue; }
        const [blog, id] = splitKey(c.key);
        const side = pick === 'here' ? c.here : c.there;
        const t = now();
        if (side === 'keep_visible') display.keepVisible(db, jobs, [{ blog, id }], t);
        else if (side === 'keep_hidden') display.userVisibility(db, jobs, [{ blog, id }], 'private', { display: 'keep_hidden', now: t, batchTitle: 'Keep hidden' });
        // 'rule_hidden' / 'follow_rule': the display rules decide again (a rule hide stays as it is)
        else display.setDisplay(db, blog, id, 'follow_rule', t);
      }
      save({ conflicts: left });
      schedule(2);
      return api.settingsSyncStatus();
    },
  });
  return svc.settingsSync;
}

module.exports = { addSettingsSync, parseDoc, render, TAG, HEAD };
