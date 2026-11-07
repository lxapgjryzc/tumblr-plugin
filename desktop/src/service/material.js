'use strict';
// Material collection, moved from the browser extension (design 4.3 / 11.7): posts I like are reblogged onto a
// material blog with my tags. Under docs/REBLOG_POLICY.md everything a collected reblog carries — my tags, the
// palette worked out from its pixels and, when switched on, the AI vision model's tags and note — is decided
// BEFORE the reblog is created; nothing is ever written onto it afterwards. Later analysis stays local.
//
// The logic is the extension's (src/core.js: likedPosts, collectSkip, paletteTags, aiTagImage, aiArtVerdict…),
// called through an adapter for the OAuth API. Every create is a durable job: persisted first, never resent
// blindly; a lost response is looked for on the material blog.

const { J, P } = require('./db');
const C = require('./core');
const { upsertPost } = require('./posts');
const { StaleError, HttpError } = require('./errors');

const DEFAULTS = { blog: '', auto: false, tags: [], imagesOnly: true, autoPalette: true, ai: false, since: 0, daily: 4 };
const settingsOf = db => ({ ...DEFAULTS, ...db.getMeta('collect', {}) });

// core.js expects api(path, { method, body }) returning the response; the adapter is the OAuth client
const coreApi = tumblr => (path, opts = {}) => {
  const method = opts.method || 'GET';
  return tumblr.request(path, method === 'GET' ? {} : { method, json: opts.body });
};

// The original a liked post stands for, by uuid: its trail's first post, or the post itself
function rootOf(p) {
  const tr = (p.trail || [])[0];
  if (tr?.post?.id && tr.blog?.uuid) return tr.blog.uuid + '/' + tr.post.id;
  return (p.blog?.uuid || p.blog_name || p.blogName) + '/' + C.postId(p);
}
// Root keys the material blog already holds (from the synced posts table)
function holding(db, dest) {
  const have = new Set();
  for (const r of db.all(`SELECT id, kind, root_blog, root_id, parent_blog, parent_id FROM posts WHERE blog = ? AND state != 'gone'`, dest)) {
    if (r.root_blog && r.root_id) have.add(r.root_blog + '/' + r.root_id);
    else if (r.parent_blog && r.parent_id) have.add(r.parent_blog + '/' + r.parent_id);
  }
  for (const r of db.all(`SELECT root FROM collected WHERE dest = ? AND status IN ('queued', 'created', 'unknown')`, dest)) have.add(r.root);
  return have;
}

function addMaterial(svc, api, { media = null, aiKey = () => '' } = {}) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;
  const myNames = () => new Set(db.all('SELECT name FROM blogs').map(b => b.name.toLowerCase()));

  // Tags fixed at creation: mine, the palette (pixels), and the AI's when switched on. Failures of the optional
  // parts never block collecting; they are simply not added (and said so in the result).
  async function creationTags(p, s, aiKey) {
    let tags = C.uniqTags(s.tags || []);
    const notes = [];
    let note = '';
    const imgs = C.postImages(p);
    if (s.autoPalette !== false && media?.pixels && imgs.length) {
      try { tags = C.withTags(tags, C.paletteTags(await media.pixels(imgs[0].small, 64))); } catch (e) { notes.push('palette: ' + (e.message || e)); }
    }
    const ai = db.getMeta('settings', {}).ai || {};
    if (s.ai && ai.base && ai.model && aiKey && media?.dataUrl && imgs.length) {
      try {
        const use = imgs.slice(0, C.AI_MAX_IMAGES);
        const urls = await Promise.all(use.map(i => media.dataUrl(i.big || i.small, C.aiImageSize(use.length))));
        const seen = await C.aiTagImage(ai, aiKey, urls, fetch, { notes: ai.notes === false ? '' : ai.notesLang || 'en' });
        tags = C.withTags(tags, [...seen.tags, C.AI_MARK]);
        note = seen.notes || '';
      } catch (e) { notes.push('AI: ' + (e.message || e)); }
    }
    return { tags, note, notes };
  }

  // Why a like isn't collected ('' = collect it): the extension's rules, plus the AI-art verdict from the
  // original poster's own tags
  async function decide(p, have, s, a) {
    const why = C.collectSkip(p, have, myNames(), s);
    if (why) return why;
    if (C.aiArtVerdict({ owner: await C.ownerTagsOf(a, p) }).verdict) return 'aiArt';
    return '';
  }

  function queueCollect(p, s, { manual = false, reason = null } = {}) {
    const root = rootOf(p);
    const row = db.get('SELECT status FROM collected WHERE root = ?', root);
    if (row && ['queued', 'created', 'unknown'].includes(row.status)) return null;
    db.run(`INSERT INTO collected (root, src_blog, src_id, src_name, reblog_key, liked_at, dest, status, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT(root) DO UPDATE SET status = 'queued', dest = excluded.dest, reason = excluded.reason, dest_id = NULL, at = excluded.at`,
    root, p.blog?.uuid || null, C.postId(p), p.blog_name || p.blog?.name || '', p.reblog_key || p.reblogKey || '', p.liked_timestamp || p.likedTimestamp || null, s.blog, reason, now());
    return jobs.add('material.collect', { root, dest: s.blog, post: slim(p), manual }, { priority: manual ? 1 : 6, scope: `collect:${root}` });
  }
  // What the job needs of the liked post (kept small: no full trail bodies)
  const slim = p => ({ id: C.postId(p), blog: { uuid: p.blog?.uuid, name: p.blog?.name || p.blog_name }, blog_name: p.blog_name || p.blog?.name,
    reblog_key: p.reblog_key || p.reblogKey, tags: p.tags || [], content: p.content || [], trail: (p.trail || []).map(t => ({ blog: t.blog, post: t.post, content: (t.content || []).filter(b => b.type === 'image') })),
    can_reblog: p.can_reblog ?? p.canReblog, interactability_reblog: p.interactability_reblog ?? p.interactabilityReblog, liked_timestamp: p.liked_timestamp ?? p.likedTimestamp });

  // The background pass: likes since the last one, oldest first. Skipped likes are recorded (aiArt ones are
  // unliked through their own job); the rest are queued.
  svc.handlers['material.scan'] = {
    async run(job, ctx) {
      const s = settingsOf(db);
      if (!s.blog || (!s.auto && !job.payload.manual)) return { status: 'skipped', error: 'collecting is off' };
      const a = coreApi(ctx.tumblr);
      const since = job.payload.since ?? s.since;
      const likes = (await C.likedPosts(a, { after: since })).reverse();
      const have = holding(db, s.blog);
      let queued = 0, skipped = 0, last = since;
      for (const p of likes) {
        const root = rootOf(p);
        const why = await decide(p, have, s, a);
        if (why === 'have') { /* already collected */ }
        else if (why) {
          skipped++;
          db.run(`INSERT INTO collected (root, src_blog, src_id, src_name, reblog_key, liked_at, dest, status, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?)
            ON CONFLICT(root) DO NOTHING`, root, p.blog?.uuid || null, C.postId(p), p.blog_name || '', p.reblog_key || '', p.liked_timestamp || null, s.blog, why, now());
          if (why === 'aiArt') jobs.add('like.remove', { id: C.postId(p), reblog_key: p.reblog_key || p.reblogKey, root }, { priority: 7, scope: `unlike:${C.postId(p)}` });
        } else if (queueCollect(p, s)) { queued++; have.add(root); }
        last = Math.max(last, p.liked_timestamp || p.likedTimestamp || 0);
      }
      if (!job.payload.manual) db.setMeta('collect', { ...db.getMeta('collect', {}), since: last });
      return { status: 'succeeded', result: { likes: likes.length, queued, skipped } };
    },
  };

  svc.handlers['material.collect'] = {
    creates: true,
    async run(job, ctx) {
      const { root, dest, post: p } = job.payload;
      const s = settingsOf(db);
      if (!s.blog || s.blog !== dest) { db.run(`UPDATE collected SET status = 'skipped', reason = 'collection blog changed' WHERE root = ?`, root); throw new StaleError('the collection blog changed'); }
      // automatic collecting may have been switched off since the scan queued this; a manual collect still goes
      if (!job.payload.manual && !s.auto) { db.run(`UPDATE collected SET status = 'skipped', reason = 'automatic collecting is off' WHERE root = ?`, root); return { status: 'cancelled', error: 'automatic collecting is off' }; }
      // the material blog may have it by now (collected by hand on Tumblr, another pass)
      const have = holding(db, dest);
      have.delete(root);
      if (db.all(`SELECT 1 FROM posts WHERE blog = ? AND state != 'gone' AND (root_blog || '/' || root_id = ? OR parent_blog || '/' || parent_id = ?)`, dest, root, root).length) {
        db.run(`UPDATE collected SET status = 'created', reason = 'already on the material blog' WHERE root = ?`, root);
        return { status: 'unchanged', error: 'already collected' };
      }
      const { tags, note, notes } = job.payload.tags ? job.payload : await creationTags(p, s, aiKey());
      // frozen before sending: a retry or reconcile uses exactly these
      const frozen = { ...job.payload, tags, note, notes, sentAt: ctx.now() };
      let id;
      try {
        id = await ctx.tumblr.reblog(dest, { parentBlog: p.blog?.uuid || p.blog_name, parentId: p.id, reblogKey: p.reblog_key, state: 'published', tags,
          content: note ? [{ type: 'text', text: C.AI_NOTE_MARK + note }] : [] });
      } catch (e) {
        if (e instanceof HttpError) { db.run(`UPDATE collected SET status = 'failed', reason = ? WHERE root = ?`, e.message, root); }
        else db.run(`UPDATE collected SET status = 'unknown', tags = ? WHERE root = ?`, J(tags), root);
        throw Object.assign(e, { payload: frozen });
      }
      if (!id) { db.run(`UPDATE collected SET status = 'unknown', tags = ? WHERE root = ?`, J(tags), root); return { status: 'unknown', error: 'no id in the response', payload: frozen, nextAt: ctx.now() + 30_000 }; }
      db.run(`UPDATE collected SET status = 'created', dest_id = ?, tags = ?, at = ? WHERE root = ?`, id, J(tags), ctx.now(), root);
      try { upsertPost(db, await ctx.tumblr.getPost(dest, id), dest, ctx.now()); } catch {}
      return { status: 'succeeded', payload: frozen, result: { dest_id: id, tags, notes } };
    },
    // Look on the material blog for a reblog of this original made after the attempt; never resend from here
    async reconcile(job, ctx) {
      const { root, dest } = job.payload;
      const since = (job.payload.sentAt || job.created_at) - 120e3;
      const found = [];
      let next = null;
      for (let i = 0; i < 5; i++) {
        const page = await ctx.tumblr.postsPage(dest, { next });
        for (const q of page.posts) {
          const r = upsertPost(db, q, dest, ctx.now())?.after;
          if (!r || (r.published_at && r.published_at < since)) continue;
          if ((r.root_blog && r.root_blog + '/' + r.root_id === root) || (r.parent_blog && r.parent_blog + '/' + r.parent_id === root)) found.push(r.id);
        }
        next = page.next;
        if (!next) break;
      }
      const tries = (job.result?.reconciles || 0) + 1;
      if (found.length === 1) { db.run(`UPDATE collected SET status = 'created', dest_id = ? WHERE root = ?`, found[0], root); return { status: 'succeeded', result: { dest_id: found[0], reconciled: true } }; }
      if (found.length > 1) return { status: 'unknown', error: `several possible reblogs (${found.join(', ')}); check the material blog`, nextAt: ctx.now() + 365 * 86400e3, result: { found } };
      const needsUser = tries >= 5;
      return { status: 'unknown', error: needsUser ? 'not found on the material blog yet; check there, then choose “It wasn\'t created”' : 'looking for the reblog on the material blog',
        nextAt: ctx.now() + (needsUser ? 6 * 3600e3 : 60_000 * tries), result: { reconciles: tries, needsUser } };
    },
    abandon(job) { db.run(`UPDATE collected SET status = 'failed', reason = 'you confirmed it was not created' WHERE root = ?`, job.payload.root); },
  };

  svc.handlers['like.remove'] = {
    async run(job, ctx) {
      await coreApi(ctx.tumblr)('/v2/user/unlike', { method: 'POST', body: { id: job.payload.id, reblog_key: job.payload.reblog_key } });
      return { status: 'succeeded' };
    },
  };

  // The pass: a scan job when automatic collecting is on
  svc.afterPass = [...(svc.afterPass || []), () => {
    const s = settingsOf(db);
    if (!s.blog || !s.auto || db.get(`SELECT 1 FROM jobs WHERE kind = 'material.scan' AND status IN ('pending', 'running', 'waiting')`)) return 0;
    if (!s.since) { db.setMeta('collect', { ...db.getMeta('collect', {}), since: Math.floor(now() / 1000) }); return 0; } // start from now, never the whole history
    jobs.add('material.scan', {}, { priority: 7 });
    return 1;
  }];

  Object.assign(api, {
    collectSettings() { return settingsOf(db); },
    saveCollect(patch) {
      const cur = settingsOf(db);
      const next = { ...cur, ...patch };
      if (next.blog) {
        const b = db.get('SELECT role, is_primary FROM blogs WHERE uuid = ?', next.blog);
        if (!b) throw new Error('unknown blog');
        if (b.is_primary) throw new Error('the main blog can\'t be the collection blog');
        if (b.role !== 'material') db.run(`UPDATE blogs SET role = 'material' WHERE uuid = ?`, next.blog);
      }
      if (patch.tags) next.tags = C.uniqTags(patch.tags.map(t => C.norm(String(t)).trim()).filter(Boolean));
      // switching on starts from now: older likes are a separate, previewed choice (collectPreview)
      if (next.auto && !cur.auto) next.since = Math.floor(now() / 1000);
      db.setMeta('collect', next);
      return next;
    },
    // Likes not collected yet, with the reason for each skip; nothing is sent
    async collectPreview({ limit = 60 } = {}) {
      const s = settingsOf(db);
      if (!s.blog) throw new Error('choose a collection blog first');
      const a = coreApi(svc.ctx.tumblr);
      const ctl = { aborted: false };
      const likes = (await C.likedPosts(a, { after: 0, ctl, onProgress: n => { if (n >= limit) ctl.aborted = true; } })).slice(0, limit);
      const have = holding(db, s.blog);
      const out = [];
      for (const p of likes) {
        const why = C.collectSkip(p, have, myNames(), s);
        const img = C.postImages(p)[0];
        out.push({ root: rootOf(p), blog: p.blog_name || p.blog?.name, id: C.postId(p), thumb: img?.small || null, skip: why || null, post: why ? null : slim(p) });
      }
      return out;
    },
    // Explicit collect of chosen likes (from the preview or a browser entry point)
    collect({ posts }) {
      const s = settingsOf(db);
      if (!s.blog) throw new Error('choose a collection blog first');
      const ids = posts.map(p => queueCollect(p, s, { manual: true })).filter(Boolean);
      return { queued: ids.length, jobs: ids };
    },
    collectLog({ limit = 100 } = {}) {
      return db.all('SELECT * FROM collected ORDER BY at DESC LIMIT ?', limit).map(r => ({ ...r, tags: P(r.tags, null) }));
    },
    // Today's quick study: n posts with images from a material blog, stable for the same seed
    dailyStudy({ blog = null, n = null, seed = '' } = {}) {
      const s = settingsOf(db);
      const uuid = blog || s.blog || db.get(`SELECT uuid FROM blogs WHERE role = 'material' ORDER BY name LIMIT 1`)?.uuid;
      if (!uuid) return [];
      const store = { posts: {} };
      for (const r of db.all(`SELECT id, payload FROM posts WHERE blog = ? AND state = 'published' AND has_images = 1`, uuid)) {
        const imgs = C.postImages(P(r.payload, {}), 250, 1280);
        if (imgs.length) store.posts[r.id] = [null, 0, imgs.map(i => [i.small, i.big]), []];
      }
      return C.dailyPick(store, n || s.daily || 4, seed || new Date(now()).toISOString().slice(0, 10)).map(x => ({ ...x, blog: uuid }));
    },
  });
  return { rootOf, queueCollect };
}

module.exports = { addMaterial, rootOf, coreApi, DEFAULTS };
