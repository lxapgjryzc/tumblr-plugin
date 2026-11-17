'use strict';
// The request surface the window (and later the companion) uses. Plain data in, plain data out; every remote
// change goes through the job queue. Kept free of Electron so it can be tested in Node.

const { J, P } = require('./db');
const display = require('./display');
const routes = require('./routes');
const groups = require('./groups');
const sync = require('./sync');
const C = require('./core');
const { makeQuery } = require('./query');

function makeApi(svc, { creds, openUrl = () => {}, importStage0 = null, extra = {} } = {}) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;
  const query = makeQuery(db, now);

  // Run fn inside a savepoint and roll it back: previews of a rule that isn't saved yet
  function dryRun(fn) {
    db.raw.exec('SAVEPOINT preview');
    try { return fn(); } finally { db.raw.exec('ROLLBACK TO preview'); db.raw.exec('RELEASE preview'); }
  }
  const blogs = () => db.all('SELECT uuid, name, title, is_primary, role, avatar, url, followers FROM blogs ORDER BY is_primary DESC, name');
  const postRow = r => ({ ...r, tags: P(r.tags, []), payload: undefined });

  const api = {
    status() {
      return {
        auth: creds ? creds.status() : 'no_app',
        account: db.getMeta('account'),
        blogs: blogs(),
        coverage: sync.coverage(db).filter(c => c.uuid !== svc.settingsSync?.blog()),
        jobs: jobs.counts(),
        lastPass: db.getMeta('lastPass'),
        paused: db.getMeta('paused', false),
        automation: db.getMeta('automation', {}),
        capabilities: Object.fromEntries(db.all('SELECT key, status FROM capabilities').map(r => [r.key, r.status])),
        budget: svc.ctx.tumblr?.budget?.stats?.() || null,
        relay: svc.ctx.tumblr?.relay?.stats?.() || null,
        settings: db.getMeta('settings', {}),
      };
    },
    // ----- connection -----
    setApp({ clientId, clientSecret }) {
      if (!clientId || !clientSecret) throw new Error('both the consumer key and secret are needed');
      creds.setApp(clientId, clientSecret);
      return api.status();
    },
    async connect() {
      await creds.authorize(openUrl);
      jobs.wake('auth');
      svc.pass({ priority: 2 });
      return api.status();
    },
    disconnect() { creds.forget(); return api.status(); },
    async importStage0() {
      if (!importStage0) throw new Error('not available');
      const rec = importStage0();
      creds.save({ ...rec, generation: 0, revoked: false });
      await creds.accessToken(true); // proves the token works (and rotates it into this store)
      jobs.wake('auth');
      svc.pass({ priority: 2 });
      return api.status();
    },
    setSettings(patch) { db.setMeta('settings', { ...db.getMeta('settings', {}), ...patch }); return api.status(); },
    setRole({ blog, role }) {
      if (!['share', 'material', null].includes(role)) throw new Error('bad role');
      if (role && blog === svc.settingsSync?.blog()) throw new Error('this is the settings blog; turn that off in Settings first');
      const b = db.get('SELECT is_primary FROM blogs WHERE uuid = ?', blog);
      if (b?.is_primary && role !== 'share') throw new Error('the main blog is always a sharing blog');
      db.run('UPDATE blogs SET role = ? WHERE uuid = ?', role, blog);
      groups.rebuild(db, now());
      return blogs();
    },
    syncNow({ full = false } = {}) { return svc.pass({ full, priority: 2 }); },
    setPaused(paused) { db.setMeta('paused', !!paused); return api.status(); },
    setAutomation(patch) { db.setMeta('automation', { ...db.getMeta('automation', {}), ...patch }); svc.passSoon?.(); return api.status(); },

    // ----- posts -----
    // One query definition for the list, its counts, tag suggestions and "select every match" (query.js).
    // Older callers' shapes (tags: [...] all required, share: bool) still mean what they meant.
    posts(q = {}) { return query.page(q); },
    postsMatch(q = {}) { return query.ids(q); },
    tagCandidates(q = {}) { return query.tagCandidates(q); },
    item({ id }) {
      const it = groups.item(db, id);
      if (!it) return null;
      const ev = new Map(display.evaluate(db, now()).map(r => [r.blog + '/' + r.id, r]));
      const origin = it.members.find(m => m.kind === 'original');
      it.versions = origin ? routes.versionsOf(db, origin.blog, origin.id) : null;
      it.members = it.members.map(m => ({ ...m, payload: undefined, snapshot: m.kind === 'reblog' ? (routes.copyRevision(db, m.blog, m.id) || { rev: null }) : null, policy: display.policyOf(db, m.blog, m.id), publicCheck: db.get('SELECT state, expect, checked_at, route FROM public_checks WHERE blog = ? AND id = ?', m.blog, String(m.id)) || null, expiry: ev.get(m.blog + '/' + m.id) || null,
        jobs: db.all(`SELECT id, kind, status, error FROM jobs WHERE scope = ? AND status NOT IN ('succeeded', 'unchanged', 'cancelled') ORDER BY id DESC LIMIT 3`, `post:${m.blog}:${m.id}`) }));
      return it;
    },
    payload({ blog, id }) { return P(db.get('SELECT payload FROM posts WHERE blog = ? AND id = ?', blog, String(id))?.payload); },
    assign({ item, manager }) { groups.assign(db, item, manager, now()); return api.item({ id: item }); },

    // What needs the user: ambiguous / lost management, external changes
    review() {
      return {
        ambiguous: db.get(`SELECT COUNT(*) n FROM items WHERE status = 'ambiguous'`).n,
        lost: db.get(`SELECT COUNT(*) n FROM items WHERE status = 'needs_review'`).n,
        conflicts: db.get(`SELECT COUNT(*) n FROM policies WHERE conflict IS NOT NULL`).n,
        items: db.all(`SELECT i.id, i.status, i.origin_blog, i.origin_id, p.summary, p.thumb FROM items i LEFT JOIN posts p ON p.blog = i.origin_blog AND p.id = i.origin_id
          WHERE i.status != 'ok' ORDER BY i.updated_at DESC LIMIT 100`),
        conflictPosts: db.all(`SELECT po.blog, po.id, po.display, po.conflict, p.state, p.summary, p.thumb, p.item_id FROM policies po JOIN posts p ON p.blog = po.blog AND p.id = po.id
          WHERE po.conflict IS NOT NULL LIMIT 100`).map(r => ({ ...r, conflict: P(r.conflict) })),
      };
    },

    // ----- visibility -----
    // targets: [{ blog, id }] exact instances. Preview first, then apply with the same frozen list.
    visibilityPreview({ targets, target }) {
      const out = { change: [], already: [], unsupported: [], copies: [], gone: 0 };
      for (const t of targets) {
        const p = db.get('SELECT blog, id, state, legacy, item_id, summary FROM posts WHERE blog = ? AND id = ?', t.blog, String(t.id));
        if (!p || p.state === 'gone') { out.gone++; continue; }
        if (p.legacy || !['published', 'private'].includes(p.state)) out.unsupported.push(p);
        else if (p.state === target) out.already.push(p);
        else out.change.push(p);
        // linked copies that are NOT included, so the user sees what stays as it is
        for (const c of db.all(`SELECT blog, id, state FROM posts WHERE item_id = ? AND state != 'gone' AND NOT (blog = ? AND id = ?)`, p.item_id, p.blog, p.id)) {
          if (!targets.some(x => x.blog === c.blog && String(x.id) === c.id)) out.copies.push(c);
        }
      }
      return out;
    },
    visibility({ targets, target, display: disp }) { return display.userVisibility(db, jobs, targets, target, { display: disp, now: now() }); },
    keepVisible({ targets }) { return display.keepVisible(db, jobs, targets, now()); },
    followRule({ targets }) {
      db.tx(() => { for (const t of targets) display.setDisplay(db, t.blog, t.id, 'follow_rule', now()); });
      return { ok: true };
    },
    // all linked owned instances of the given items, with what the page needs to list them before adding any
    linked({ items }) {
      if (!items?.length) return [];
      return db.all(`SELECT p.blog, p.id, p.state, p.kind, p.item_id, p.summary, p.thumb, p.published_at, b.name AS blog_name,
          (SELECT rev FROM deliveries d WHERE d.dest_blog = p.blog AND d.dest_id = p.id) AS rev
        FROM posts p JOIN blogs b ON b.uuid = p.blog WHERE p.item_id IN (${items.map(() => '?').join(',')}) AND p.state != 'gone' ORDER BY p.item_id, p.kind = 'reblog', p.published_at`, ...items);
    },
    // What "Keep visible" / "Back to the rule" would do to these exact posts: keep visible publishes private ones;
    // back to the rule can make a post due for hiding right away. Nothing is changed here.
    policyPreview({ targets, action }) {
      const ev = new Map(display.evaluate(db, now()).map(r => [r.blog + '/' + r.id, r]));
      const out = { targets: 0, gone: 0, willPublish: [], dueNow: [], noRule: 0 };
      for (const t of targets) {
        const p = db.get('SELECT blog, id, state, summary FROM posts WHERE blog = ? AND id = ?', t.blog, String(t.id));
        if (!p || p.state === 'gone') { out.gone++; continue; }
        out.targets++;
        if (action === 'keep' && p.state === 'private') out.willPublish.push(p);
        const e = ev.get(p.blog + '/' + p.id);
        if (action === 'rule') { if (!e) out.noRule++; else if (p.state === 'published' && e.due && e.due <= now()) out.dueNow.push(p); }
      }
      return out;
    },
    resolveConflict({ blog, id, display: disp }) {
      const p = display.policyOf(db, blog, id);
      p.conflict = null; p.display = disp; p.display_at = now(); p.display_src = 'user';
      display.savePolicy(db, p, now());
      return p;
    },

    // Tags on chosen instances: each target is its own edit (full post, verified); other tags stay as stored
    // Reblogs are frozen snapshots (docs/REBLOG_POLICY.md): they are listed as kept as they are, never edited.
    tagsPreview({ targets }) {
      const out = { edit: [], snapshots: [] };
      for (const t of targets) {
        const p = db.get('SELECT blog, id, kind, summary FROM posts WHERE blog = ? AND id = ?', t.blog, String(t.id));
        if (p) (p.kind === 'reblog' ? out.snapshots : out.edit).push(p);
      }
      return out;
    },
    selectionTags({ targets }) {
      const { edit, snapshots } = api.tagsPreview({ targets });
      const counts = new Map();
      for (const p of edit) {
        const row = db.get('SELECT tags FROM posts WHERE blog = ? AND id = ?', p.blog, String(p.id));
        for (const tg of new Set(P(row?.tags, []))) { const k = C.key(tg); const c = counts.get(k); if (c) c.n++; else counts.set(k, { tag: tg, n: 1 }); }
      }
      return { originals: edit.length, snapshots: snapshots.length, tags: [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)) };
    },
    // Per-post difference an edit would make (only originals; reblogs are listed apart), for the one confirmation
    tagsPlan({ targets, add = [], remove = [] }) {
      const { edit, snapshots } = api.tagsPreview({ targets });
      const rm = new Set(remove.map(C.key));
      const out = { change: [], same: 0, snapshots: snapshots.length, gone: targets.length - edit.length - snapshots.length,
        copiesFollow: !!db.getMeta('automation', {}).routes };
      for (const p of edit) {
        const tags = P(db.get('SELECT tags FROM posts WHERE blog = ? AND id = ?', p.blog, String(p.id))?.tags, []);
        const have = new Set(tags.map(C.key));
        const plus = add.filter(a => !have.has(C.key(a)) && !rm.has(C.key(a)));
        const minus = tags.filter(tg => rm.has(C.key(tg)));
        if (plus.length || minus.length) out.change.push({ blog: p.blog, id: p.id, summary: p.summary, add: plus, remove: minus,
          reblogs: db.get(`SELECT COUNT(*) n FROM posts c WHERE c.item_id = (SELECT item_id FROM posts WHERE blog = ? AND id = ?) AND c.kind = 'reblog' AND c.state != 'gone'`, p.blog, String(p.id)).n });
        else out.same++;
      }
      return out;
    },
    applyTags({ targets, add = [], remove = [] }) {
      const { edit, snapshots } = api.tagsPreview({ targets });
      const batch = jobs.batch('Edit tags', { targets: edit, add, remove, snapshots: snapshots.length });
      for (const t of edit) jobs.add('post.tags', { blog: t.blog, id: String(t.id), add, remove }, { priority: 1, scope: `post:${t.blog}:${t.id}`, batch });
      return { batch, queued: edit.length, snapshots: snapshots.length };
    },

    // ----- expiry rules -----
    rules() { return display.rulesOf(db); },
    rulePreview(rule) {
      return dryRun(() => {
        upsertRule(rule, true);
        const ev = display.evaluate(db, now());
        const id = rule.id || db.get('SELECT MAX(id) m FROM expiry_rules').m;
        const mine = ev.filter(r => r.rule === id);
        return {
          hideNow: mine.filter(r => r.action === 'hide'),
          soon: mine.filter(r => r.action === 'none' && r.reason === 'not_due' && r.due - now() < 7 * 86400e3),
          kept: mine.filter(r => r.reason === 'keep_visible'),
          held: mine.filter(r => r.action === 'hold'),
          total: mine.length,
        };
      });
    },
    saveRule(rule) { const id = upsertRule(rule, false); svc.passSoon?.(); return display.rulesOf(db).find(r => r.id === id); },
    deleteRule({ id }) { db.run('DELETE FROM expiry_rules WHERE id = ?', id); return display.rulesOf(db); },
    restorePreview({ rule }) { return display.restorePlan(db, rule); },
    restore({ rule, targets }) {
      const plan = new Set(display.restorePlan(db, rule).map(r => r.blog + '/' + r.id));
      const ok = targets.filter(t => plan.has(t.blog + '/' + t.id));
      const batch = jobs.batch('Restore hidden posts', { rule, targets: ok });
      for (const t of ok) jobs.add('post.visibility', { blog: t.blog, id: String(t.id), target: 'published', reason: 'restore', display: 'keep_visible' }, { priority: 1, scope: `post:${t.blog}:${t.id}`, batch, supersede: true });
      return { queued: ok.length };
    },
    expiring({ days = 7, blog = null, sort = 'due' } = {}) {
      const horizon = now() + days * 86400e3;
      const ev = display.evaluate(db, now()).filter(r => r.state === 'published' && r.action !== 'skip' && r.reason !== 'keep_visible' && r.reason !== 'keep_hidden' && r.due && r.due <= horizon && (!blog || r.blog === blog));
      const names = new Map(blogs().map(b => [b.uuid, b.name]));
      ev.forEach(r => { r.blog_name = names.get(r.blog); });
      return ev.sort(sort === 'notes' ? (a, b) => (b.notes || 0) - (a.notes || 0) : (a, b) => a.due - b.due);
    },

    // ----- routes -----
    routes() { return routes.routesOf(db); },
    routePreview(route) {
      return dryRun(() => {
        const id = routes.saveRoute(db, null, { ...route, enabled: true }, now());
        const r = routes.routesOf(db).find(x => x.id === id);
        return routes.preview(db, r, { history: !!route.history });
      });
    },
    saveRoute(route) { const id = routes.saveRoute(db, jobs, route, now()); return routes.routesOf(db).find(r => r.id === id); },
    deleteRoute({ id }) { db.run('DELETE FROM routes WHERE id = ?', id); jobs.cancelScope(`route:${id}:`, 'route deleted'); return routes.routesOf(db); },
    reblogTo({ targets, dest, state = 'published' }) { return targets.map(t => routes.manualReblog(db, jobs, { ...t, dest, state })); },

    // ----- activity -----
    jobs({ status = 'open', limit = 200 } = {}) { return jobs.list({ status, limit }); },
    activity({ limit = 200 } = {}) { return db.all('SELECT * FROM activity ORDER BY id DESC LIMIT ?', limit).map(r => ({ ...r, data: P(r.data) })); },
    cancelJob({ id }) { return jobs.cancel(id); },
    retryJob({ id }) { return jobs.retry(id); },
    resolveJob({ id }) { return jobs.resolve(id, svc.ctx); },
    checkJob({ id }) { const ok = jobs.checkNow(id); jobs.wake(); return ok; },
    ...extra,
  };

  function upsertRule(r, dry) {
    const days = Math.round(Number(r.days));
    if (!(days > 0)) throw new Error('days must be a positive number');
    if (!['independent', 'linked'].includes(r.mode)) throw new Error('choose a scope mode');
    const vals = [r.mode, r.blog, r.enabled ? 1 : 0, days, r.scope === 'images' ? 'images' : 'all', J(r.kinds || ['original', 'reblog']), J(r.targets || []), r.skip_pinned === false ? 0 : 1, now()];
    if (r.id) {
      db.run('UPDATE expiry_rules SET mode = ?, blog = ?, enabled = ?, days = ?, scope = ?, kinds = ?, targets = ?, skip_pinned = ?, updated_at = ?, revision = revision + 1 WHERE id = ?', ...vals, r.id);
      return r.id;
    }
    return Number(db.run('INSERT INTO expiry_rules (mode, blog, enabled, days, scope, kinds, targets, skip_pinned, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...vals).lastInsertRowid);
  }

  return api;
}

module.exports = { makeApi };
