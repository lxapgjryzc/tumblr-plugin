'use strict';
// The browser companion's way in (design 4.3, A53, A54). The extension is an accessory: it may read a versioned,
// read-only snapshot of app data for in-page help (tag suggestions, template insertion) and submit typed requests
// that the app previews, runs and records as its own jobs. It never queues or runs business work itself.
//
// Transport: a loopback HTTP endpoint run by the main process (main.js). This module is the protocol, free of
// sockets so it can be tested: handle({ origin, host, auth, path, body }) → { status, json }.
// Checks, in order: loopback Host (no DNS rebinding), an extension Origin (web pages can't forge it), protocol
// version, then — for everything but hello/pair — the paired extension id, its bearer token and the account it
// was paired with. Requests carry an operation id; the same id never makes a second job.

const crypto = require('node:crypto');
const { J, P } = require('./db');
const C = require('./core');

const PROTOCOL = 1;
const PORTS = [47823, 47824, 47825];
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function makeBridge(svc, api, { version = '0', relay = null, approve = async () => false, onOpen = () => {}, getPost = null } = {}) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;
  const paired = () => db.getMeta('companion', null); // { extId, tokenHash, account, at }
  const account = () => db.getMeta('account', {})?.name || null;
  const primaryName = () => db.get('SELECT name FROM blogs WHERE is_primary = 1')?.name || null;

  // The data the extension may use in pages, as one versioned object. Read-only: editing happens in the app.
  function snapshot() {
    const settings = db.getMeta('settings', {});
    const blogs = db.all('SELECT uuid, name, is_primary, role FROM blogs ORDER BY is_primary DESC, name');
    // the tag library in the extension's cache shape (blogs → posts → [tags, ts, state, notes]), sharing blogs only
    const cache = { blogs: {}, blogList: blogs.map(b => ({ uuid: b.uuid, name: b.name, primary: !!b.is_primary })), custom: [], hidden: [], tagStats: db.getMeta('tagStats', {}) };
    for (const b of blogs.filter(x => x.role === 'share' || x.is_primary)) {
      const posts = {};
      for (const r of db.all(`SELECT id, tags, published_at, state, notes FROM posts WHERE blog = ? AND state IN ('published', 'private', 'queue', 'draft')`, b.uuid)) {
        posts[r.id] = [P(r.tags, []), Math.floor((r.published_at || 0) / 1000), r.state, r.notes ?? null];
      }
      cache.blogs[b.uuid] = { name: b.name, posts };
    }
    const categories = api.categories ? api.categories().map(c => ({ id: c.id, name: c.name, tag: c.tag, group: c.group_id })) : [];
    const groups = api.categoryGroups ? api.categoryGroups().map(g => ({ id: g.id, key: g.key, name: g.name })) : [];
    const body = {
      packs: db.getMeta('packs', []).map(p => ({ raw: p.raw, source: p.source || '' })),
      rules: settings.rules || null, useBase: settings.useBase !== false,
      categories, groups, cache,
      roles: Object.fromEntries(blogs.filter(b => b.role).map(b => [b.uuid, b.role])),
    };
    return { version: sha(JSON.stringify(body)).slice(0, 16), at: now(), ...body };
  }

  function checkAuth(origin, auth) {
    const pr = paired();
    if (!pr) return { status: 401, json: { error: 'not_paired' } };
    if (origin !== 'chrome-extension://' + pr.extId) return { status: 403, json: { error: 'other_extension' } };
    if (!auth || sha(String(auth).replace(/^Bearer\s+/i, '')) !== pr.tokenHash) return { status: 401, json: { error: 'bad_token' } };
    return null;
  }

  // Typed requests. Each returns { result } or { job } (the app's own job id); kinds are a fixed list.
  const KINDS = {
    // Open a post's work in the app (no remote change)
    async open(r) {
      const b = db.get('SELECT uuid FROM blogs WHERE lower(name) = lower(?) OR uuid = ?', r.blog || '', r.blog || '');
      const row = b && db.get('SELECT item_id FROM posts WHERE blog = ? AND id = ?', b.uuid, String(r.id || ''));
      onOpen({ blog: b?.uuid || null, id: String(r.id || ''), item: row?.item_id || null });
      return { result: { opened: true, known: !!row } };
    },
    // Bring the app forward (the companion page's "Open Tumblr Studio")
    async focus() { onOpen({}); return { result: { opened: true } }; },
    // Collect a post onto the material blog: the app reads the post itself (identity only comes from the page)
    async collect(r) {
      if (!api.collect) throw Object.assign(new Error('collecting is not available'), { status: 400 });
      if (!/^\d{1,25}$/.test(String(r.id || '')) || !/^[\w-]{1,64}$/.test(String(r.blog || ''))) throw Object.assign(new Error('bad post identity'), { status: 400 });
      const p = await (getPost || ((blog, id) => svc.ctx.tumblr.getPost(blog, id)))(r.blog, r.id);
      if (!p || !C.isPost({ object_type: 'post', ...p })) throw Object.assign(new Error('post not found'), { status: 404 });
      const q = api.collect({ posts: [p] });
      return q.jobs.length ? { job: q.jobs[0] } : { result: { already: true } };
    },
    // One-time move of the legacy extension data (local only; repeating it is harmless)
    async import(r) {
      if (!api.importExtension) throw Object.assign(new Error('import not available'), { status: 400 });
      return { result: api.importExtension({ data: r.export }) };
    },
  };

  async function request(body) {
    const op = String(body.op || '');
    if (!/^[\w-]{8,64}$/.test(op)) return { status: 400, json: { error: 'bad_op' } };
    const kind = String(body.kind || '');
    if (!Object.hasOwn(KINDS, kind)) return { status: 400, json: { error: 'unknown_kind' } };
    const seen = db.get('SELECT * FROM companion_ops WHERE op = ?', op);
    if (seen) return { status: 200, json: { op, repeated: true, ...stateOf(seen) } };
    let out;
    try { out = await KINDS[kind](body.request || {}); } catch (e) { return { status: e.status || 500, json: { op, error: String(e.message || e) } }; }
    const rec = { op, kind, request: J(kind === 'import' ? { size: JSON.stringify(body.request || {}).length } : body.request || {}), job_id: out.job || null, result: J(out.result ?? null), at: now() };
    db.run('INSERT INTO companion_ops (op, kind, request, job_id, result, at) VALUES (?, ?, ?, ?, ?, ?)', rec.op, rec.kind, rec.request, rec.job_id, rec.result, rec.at);
    if (out.job) jobs.wake?.();
    return { status: 200, json: { op, ...stateOf(rec) } };
  }
  // A request's state as the app sees it: accepted (durably recorded) and, for a job, the job's own status
  function stateOf(rec) {
    const out = { accepted: true, kind: rec.kind, result: P(rec.result, null) };
    if (rec.job_id) { const j = jobs.get(rec.job_id); out.job = { id: rec.job_id, status: j?.status || 'unknown', error: j?.error || null }; }
    return out;
  }

  async function handle({ origin = '', host = '', auth = '', path = '', body = {} }) {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return { status: 403, json: { error: 'host' } };
    const ext = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin || '');
    if (!ext) return { status: 403, json: { error: 'origin' } };
    if (body?.v !== PROTOCOL) return { status: 400, json: { error: 'protocol', want: PROTOCOL } };
    if (path === '/hello') {
      const pr = paired();
      // The same unpacked extension has the same id in every Chrome profile, so the id alone can't say which
      // browser is paired: only the one holding the current token is (pairing another profile replaces it).
      const tokenOk = !!pr && !!auth && sha(String(auth).replace(/^Bearer\s+/i, '')) === pr.tokenHash;
      return { status: 200, json: { v: PROTOCOL, app: 'tumblr-studio', version, paired: !!pr && pr.extId === ext[1] && tokenOk, account: account(), primary: primaryName() } };
    }
    if (path === '/pair') {
      // the extension says which account its browser is logged into; a different account is refused
      if (body.primary && primaryName() && String(body.primary).toLowerCase() !== primaryName().toLowerCase()) return { status: 409, json: { error: 'other_account', primary: primaryName() } };
      if (!(await approve(ext[1]))) return { status: 403, json: { error: 'declined' } };
      const token = crypto.randomBytes(24).toString('hex');
      db.setMeta('companion', { extId: ext[1], tokenHash: sha(token), primary: primaryName(), at: now() });
      db.log('info', 'companion', 'browser extension paired', { extId: ext[1] });
      return { status: 200, json: { token, primary: primaryName() } };
    }
    const bad = checkAuth(origin, auth);
    if (bad) return bad;
    const pr = paired();
    if (body.primary && pr.primary && String(body.primary).toLowerCase() !== pr.primary.toLowerCase()) return { status: 409, json: { error: 'other_account', primary: pr.primary } };
    if (path === '/status') {
      const st = api.status();
      return { status: 200, json: { account: st.account, auth: st.auth, paused: st.paused, jobs: st.jobs, blogs: st.blogs.map(b => ({ uuid: b.uuid, name: b.name, role: b.role, primary: !!b.is_primary })), collect: api.collectSettings?.() || null } };
    }
    if (path === '/snapshot') {
      const s = snapshot();
      return { status: 200, json: body.have === s.version ? { version: s.version, unchanged: true } : s };
    }
    if (path === '/request') return request(body);
    if (path === '/result') {
      const rec = db.get('SELECT * FROM companion_ops WHERE op = ?', String(body.op || ''));
      return rec ? { status: 200, json: { op: rec.op, ...stateOf(rec) } } : { status: 404, json: { error: 'unknown_op' } };
    }
    // The browser relay (relay.js): the extension takes requests to carry out in its tumblr.com session and
    // answers each one. It is told the account's blogs so it can refuse when the browser is logged in elsewhere.
    if (path === '/relay/next') {
      if (!relay) return { status: 404, json: { error: 'path' } };
      if (!relay.stats().enabled) return { status: 200, json: { items: [], enabled: false } };
      const items = await relay.next(Math.min(Math.max(Number(body.wait) || 0, 0), 25e3));
      const blogs = db.all('SELECT uuid, name FROM blogs');
      return { status: 200, json: { items, blogs: blogs.flatMap(b => [b.uuid, b.name]), enabled: relay.stats().enabled } };
    }
    if (path === '/relay/done') {
      if (!relay) return { status: 404, json: { error: 'path' } };
      for (const a of [].concat(body.answers || [])) relay.done(a);
      return { status: 200, json: { ok: true } };
    }
    if (path === '/unpair') { db.setMeta('companion', null); return { status: 200, json: { ok: true } }; }
    return { status: 404, json: { error: 'path' } };
  }

  return { handle, snapshot, PROTOCOL };
}

module.exports = { makeBridge, PROTOCOL, PORTS };
