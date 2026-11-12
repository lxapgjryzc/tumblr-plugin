'use strict';
// Replying to an interaction from the app (docs/FUNCTIONAL_WORKFLOWS_SPEC.md 4, FW05-FW08, FAN_RELATIONSHIP_SPEC
// FR23-FR24). Tumblr has no public API for sending a reply. The web client sends POST /v2/user/post/reply
// (found in its own scripts on 2026-11-07, read only); the app sends exactly that through the paired browser's
// signed-in session (tumblr.sendReply, browserOnly) and never through the official key.
//
// Every send is an operation persisted before anything leaves: operation id (from the page, so a double click or
// a refresh finds the same row), account, my blog that speaks, the post replied under and the exact text. The
// job is a create: a lost answer is `unknown`, never retried on its own; it is settled by finding the reply under
// the post (same blog, same text, after the attempt) or by the user saying it wasn't sent. Only a reply seen on
// Tumblr counts as "confirmed"; a 2xx answer alone is "sent, checking".
//
// Kept apart: the interaction's local states (done / later / no reply needed), "I replied on Tumblr" (what the
// user says), a hand-off to the official page (when the user went there) and these machine-checked sends.
// No automatic replies, greetings or AI sends: only a reply the user writes and submits here.

const { J, P } = require('./db');
const { HttpError, NetError, WaitError } = require('./errors');
const { fresh } = require('./ops');

const VERIFY_DELAYS = [3e3, 8e3, 20e3, 60e3];
const MAX_TEXT = 4096;
const OPEN = ['queued', 'waiting', 'sending', 'checking', 'unknown'];
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const flat = list => (list || []).flatMap(r => [r, ...flat(r.children)]);

function addReplies(svc, api) {
  const { db, jobs } = svc;
  const now = () => svc.ctx.now();
  const blogRow = u => db.get('SELECT uuid, name FROM blogs WHERE uuid = ? OR lower(name) = lower(?)', u, u);
  const opOut = r => r && { ...r };
  const setOp = (op, fields) => {
    const keys = Object.keys(fields);
    db.run(`UPDATE reply_ops SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE op = ?`, ...keys.map(k => fields[k]), now(), op);
  };
  const relayState = () => svc.ctx.tumblr.relay?.stats?.() || { enabled: false, connected: false };

  // The reply this operation sent, among the post's replies: my blog, the same text, not before the attempt,
  // not already claimed by another confirmed operation
  function findMine(list, p) {
    const claimed = new Set(db.all(`SELECT reply_id FROM reply_ops WHERE status = 'confirmed' AND reply_id IS NOT NULL AND op != ?`, p.op).map(r => r.reply_id));
    const me = blogRow(p.replyAs);
    return flat(list).filter(r => (r.uuid ? r.uuid === me?.uuid : String(r.name || '').toLowerCase() === String(me?.name || '').toLowerCase())
      && norm(r.text) === norm(p.text) && r.at >= p.startedAt - 5 * 60e3
      && !claimed.has(r.id || `${r.at}:${r.name}`)).sort((a, b) => a.at - b.at)[0] || null;
  }
  async function look(ctx, p) {
    const blog = blogRow(p.blog);
    const r = await ctx.tumblr.replies(blog?.name || p.blog, p.postId);
    return { found: findMine(r.replies, p), source: r.source };
  }
  function confirm(p, found, source) {
    const replyId = found.id || `${found.at}:${found.name}`;
    setOp(p.op, { status: 'confirmed', reply_id: replyId, confirmed_at: now(), error: null });
    // the interaction this answered is handled; others (older or newer) keep their own state
    if (p.event) db.run(`UPDATE interactions SET state = 'done', state_at = ? WHERE id = ? AND state IN ('new', 'later', 'old')`, now(), p.event);
    db.run('DELETE FROM reply_drafts WHERE event = ? AND op = ?', p.event || '', p.op);
    db.capability('reply.send', 'pass', `a reply sent through the browser was seen under the post (${source}) on ${new Date(now()).toISOString()}`);
    return { status: 'succeeded', result: { replyId, at: found.at, source } };
  }

  svc.handlers['reply.send'] = {
    creates: true,
    async run(job, ctx) {
      const p = job.payload;
      const op = db.get('SELECT * FROM reply_ops WHERE op = ?', p.op);
      if (!op || op.status === 'not_sent') return { status: 'cancelled', error: 'the operation was withdrawn' };
      if (p.phase === 'verify') {
        const { found, source } = await look(ctx, p);
        if (found) return confirm(p, found, source);
        const n = p.verifyN || 0;
        if (n < VERIFY_DELAYS.length) return { status: 'verifying', payload: { ...p, verifyN: n + 1 }, nextAt: now() + VERIFY_DELAYS[n] };
        // Tumblr answered, but the reply isn't visible (yet): never "failed", never resent
        setOp(p.op, { status: 'unknown', error: 'Tumblr accepted it, but the reply is not visible under the post yet' });
        return { status: 'unknown', error: 'sent; not seen under the post yet', nextAt: now() + 5 * 60e3, result: { reconciles: 0 } };
      }
      setOp(p.op, { status: 'sending', error: null });
      try {
        let reblogKey = p.reblogKey;
        if (!reblogKey) {
          const pay = P(db.get('SELECT payload FROM posts WHERE blog = ? AND id = ?', p.blog, String(p.postId))?.payload, null);
          reblogKey = pay?.reblog_key || pay?.reblogKey || (await fresh(ctx, p.blog, p.postId)).p?.reblog_key;
        }
        if (!reblogKey) throw new HttpError('the post has no reblog key (it may be gone)', { status: 404 });
        const me = blogRow(p.replyAs), target = blogRow(p.blog);
        const startedAt = now();
        // frozen before sending: a reconcile looks for exactly this text, from this time
        const sentPayload = { ...p, reblogKey, startedAt };
        try {
          await ctx.tumblr.sendReply({ postId: p.postId, postBlog: target?.name || p.blogName, reblogKey, text: p.text, replyAs: me?.name || p.replyAsName });
        } catch (e) { e.payload = sentPayload; throw e; }
        setOp(p.op, { status: 'checking', sent_at: startedAt });
        return { status: 'verifying', payload: { ...sentPayload, phase: 'verify', verifyN: 0 }, nextAt: now() + 2500 };
      } catch (e) {
        if (e instanceof WaitError) setOp(p.op, { status: 'waiting', error: String(e.message) });
        else if (e instanceof NetError && e.uncertain) setOp(p.op, { status: 'unknown', error: 'no answer from Tumblr: ' + String(e.message).slice(0, 160) });
        else if (e instanceof NetError) setOp(p.op, { status: 'waiting', error: String(e.message).slice(0, 200) });
        else setOp(p.op, { status: 'failed', error: String(e.message || e).slice(0, 300) });
        throw e;
      }
    },
    // The answer was lost or the reply isn't visible: look under the post again; not finding it is not "not sent"
    async reconcile(job, ctx) {
      const p = job.payload;
      const tries = (job.result?.reconciles || 0) + 1;
      if (!p.startedAt) {
        // never reached the browser's fetch (interrupted before sending): still looked for, from when it was queued
        p.startedAt = job.created_at;
      }
      const { found, source } = await look(ctx, p);
      if (found) return confirm(p, found, source);
      const needsUser = tries >= 5;
      setOp(p.op, { status: 'unknown', error: needsUser ? 'not seen under the post; check on Tumblr, then choose “It wasn’t sent”' : 'looking for the reply under the post' });
      return { status: 'unknown', error: needsUser ? 'not seen under the post; check on Tumblr' : 'looking for the reply under the post',
        nextAt: now() + (needsUser ? 6 * 3600e3 : 60e3 * tries), result: { reconciles: tries, needsUser } };
    },
    // You checked Tumblr and it isn't there: the text stays as an unsent draft, and a new send is allowed
    abandon(job) {
      const p = job.payload;
      setOp(p.op, { status: 'not_sent', error: 'you checked: it was not sent' });
      if (p.event && !db.get('SELECT 1 FROM reply_drafts WHERE event = ?', p.event)) db.run('INSERT INTO reply_drafts (event, text, reply_as, op, updated_at) VALUES (?, ?, ?, NULL, ?)', p.event, p.text, p.replyAs, now());
    },
  };
  // A job the runner put aside (waiting / failed by classify) keeps its op row in step on the next look
  function opsOf(event) {
    return db.all('SELECT o.*, j.status job_status, j.error job_error, j.result job_result FROM reply_ops o LEFT JOIN jobs j ON j.id = o.job WHERE o.event = ? ORDER BY o.id DESC LIMIT 20', event)
      .map(r => ({ ...r, needsUser: !!P(r.job_result, {})?.needsUser, job_result: undefined }));
  }

  const ownBlogs = () => db.all('SELECT uuid, name, is_primary FROM blogs ORDER BY is_primary DESC, name');
  const postUrl = (blog, id) => `https://www.tumblr.com/${blogRow(blog)?.name || blog}/${id}`;

  Object.assign(api, {
    // Everything needed to answer one interaction without leaving it: the post, the discussion under it, who it
    // is, my earlier sends and unsent text, and where the official page is
    async fansThread({ id }) {
      const e = db.get('SELECT * FROM interactions WHERE id = ?', id);
      if (!e) throw new Error('no such interaction');
      const ev = { ...e, tags: P(e.tags, []) || [], raw: undefined };
      const mine = !!blogRow(e.blog);
      const post = e.post_id ? db.get('SELECT blog, id, kind, state, summary, thumb, tags, item_id, published_at FROM posts WHERE blog = ? AND id = ?', e.blog, e.post_id) : null;
      // a reply under my post can be answered here; anything else (their reblog, an ask, a mention) is answered
      // where it lives, so only the hand-off is offered
      const canReply = e.kind === 'reply' && mine && !!e.post_id;
      let replies = null, repliesError = null;
      if (canReply) {
        try { replies = await svc.ctx.tumblr.replies(blogRow(e.blog)?.name || e.blog, e.post_id); }
        catch (err) { repliesError = String(err.message || err).slice(0, 200); }
      }
      // replies from any of my blogs after this interaction: what Tumblr shows, whoever sent it
      const myIds = new Set(ownBlogs().map(b => b.uuid)), myNames = new Set(ownBlogs().map(b => b.name.toLowerCase()));
      const seenMine = replies ? flat(replies.replies).filter(r => (r.uuid ? myIds.has(r.uuid) : myNames.has(String(r.name || '').toLowerCase())) && r.at >= (e.at || 0) - 60e3) : [];
      const key = e.from_uuid || (e.from_name ? 'name:' + e.from_name.toLowerCase() : null);
      let person = null;
      try { person = key ? api.fansPerson({ key }) : null; } catch {}
      const theirs = e.reblog_id && e.from_name ? `https://www.tumblr.com/${e.from_name}/${e.reblog_id}` : null;
      const draft = db.get('SELECT * FROM reply_drafts WHERE event = ?', id) || null;
      const rs = relayState();
      return {
        event: ev, mine, canReply,
        post: post ? { ...post, tags: P(post.tags, []) || [], blog_name: blogRow(post.blog)?.name || null } : (e.post_id ? { blog: e.blog, id: e.post_id, blog_name: blogRow(e.blog)?.name || null, summary: e.summary } : null),
        replies: replies ? { source: replies.source, list: replies.replies } : null, repliesError,
        seenMine,
        person: person && { key: person.key, uuid: person.uuid, name: person.name, alias: person.alias, star: person.star, labels: person.labels, note: person.note,
          follows: person.follows, mutual: person.mutual, texts: person.texts, last: person.last, events: (person.events || []).slice(0, 6) },
        ops: opsOf(id), draft,
        identities: ownBlogs().map(b => ({ uuid: b.uuid, name: b.name, primary: !!b.is_primary })),
        defaultAs: mine ? e.blog : ownBlogs()[0]?.uuid || null,
        handoff: { url: canReply ? postUrl(e.blog, e.post_id) : theirs || (e.post_id ? postUrl(e.blog, e.post_id) : null), at: e.handoff_at || null },
        channel: { kind: 'browser', connected: !!rs.connected, enabled: rs.enabled !== false, capability: db.capStatus('reply.send') },
      };
    },
    // Unsent text survives closing the panel, a refresh, going to Tumblr and back
    fansReplyDraft({ id, text = '', reply_as = null, op = null }) {
      text = String(text).slice(0, MAX_TEXT);
      if (!text.trim()) { db.run('DELETE FROM reply_drafts WHERE event = ?', id); return null; }
      db.run(`INSERT INTO reply_drafts (event, text, reply_as, op, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(event) DO UPDATE SET text = excluded.text, reply_as = excluded.reply_as, op = COALESCE(excluded.op, reply_drafts.op), updated_at = excluded.updated_at`, id, text, reply_as, op, now());
      return { saved_at: now() };
    },
    // Send a reply the user wrote. op: the page's operation id. The same op again returns the same operation.
    fansReply({ id, text, reply_as, op }) {
      if (!op || !/^[\w-]{8,64}$/.test(op)) throw new Error('missing operation id');
      const have = db.get('SELECT * FROM reply_ops WHERE op = ?', op);
      if (have) return { op: opOut(have), repeated: true };
      const e = db.get('SELECT * FROM interactions WHERE id = ?', id);
      if (!e) throw new Error('no such interaction');
      if (e.kind !== 'reply' || !e.post_id || !blogRow(e.blog)) throw new Error('only a reply under one of your posts can be answered here; open it on Tumblr');
      text = String(text || '');
      if (!text.trim()) throw new Error('write something first');
      if (text.length > MAX_TEXT) throw new Error('the reply is too long');
      const me = blogRow(reply_as);
      if (!me) throw new Error('choose one of your blogs to reply as');
      const open = db.get(`SELECT op, status FROM reply_ops WHERE event = ? AND status IN (${OPEN.map(() => '?').join(',')})`, id, ...OPEN);
      if (open) throw new Error(open.status === 'unknown' ? 'an earlier reply to this has an unknown outcome; settle it first' : 'a reply to this is still being sent');
      const account = db.getMeta('account', {})?.name || null;
      const target = blogRow(e.blog);
      return db.tx(() => {
        db.run(`INSERT INTO reply_ops (op, event, blog, post_id, reply_as, account, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          op, id, target.uuid, e.post_id, me.uuid, account, text, now(), now());
        const job = jobs.add('reply.send', { op, event: id, blog: target.uuid, blogName: target.name, postId: e.post_id, replyAs: me.uuid, replyAsName: me.name, text }, { priority: 1, scope: `reply:${id}` });
        db.run('UPDATE reply_ops SET job = ? WHERE op = ?', job, op);
        db.run('UPDATE reply_drafts SET op = ? WHERE event = ?', op, id);
        return { op: opOut(db.get('SELECT * FROM reply_ops WHERE op = ?', op)) };
      });
    },
    fansReplyOps({ id }) { return opsOf(id); },
    // Look under the post again now (an unknown or checking send)
    fansReplyCheck({ op }) {
      const r = db.get('SELECT job FROM reply_ops WHERE op = ?', op);
      if (!r?.job) return false;
      const j = jobs.get(r.job);
      if (j?.status === 'unknown') return jobs.checkNow(r.job);
      if (j?.status === 'waiting') { db.run('UPDATE jobs SET next_at = 0 WHERE id = ?', r.job); return true; }
      return false;
    },
    // You looked on Tumblr and the reply isn't there (only for an unknown outcome)
    fansReplyNotSent({ op }) {
      const r = db.get('SELECT job FROM reply_ops WHERE op = ?', op);
      return !!r?.job && jobs.resolve(r.job, svc.ctx);
    },
    // A send still waiting (for the browser) can be withdrawn; nothing went out
    fansReplyCancel({ op }) {
      const r = db.get('SELECT job, event, text, reply_as FROM reply_ops WHERE op = ?', op);
      if (!r?.job || !jobs.cancel(r.job, 'withdrawn before sending')) return false;
      setOp(op, { status: 'not_sent', error: 'withdrawn before sending' });
      if (r.event && !db.get('SELECT 1 FROM reply_drafts WHERE event = ?', r.event)) db.run('INSERT INTO reply_drafts (event, text, reply_as, op, updated_at) VALUES (?, ?, ?, NULL, ?)', r.event, r.text, r.reply_as, now());
      return true;
    },
    // The user goes to the official page for this interaction: remembered as a hand-off, never as a send
    fansHandoff({ id }) {
      db.run('UPDATE interactions SET handoff_at = ? WHERE id = ?', now(), id);
      return true;
    },
  });
  // Lists show each interaction's latest send (a machine-checked state, apart from "I replied")
  const latest = ids => {
    const out = new Map();
    if (!ids.length) return out;
    for (const r of db.all(`SELECT event, status, confirmed_at FROM reply_ops WHERE event IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids)) out.set(r.event, { status: r.status, at: r.confirmed_at });
    return out;
  };
  const withSends = rows => { const m = latest(rows.map(r => r.id)); return rows.map(r => ({ ...r, send: m.get(r.id) || null })); };
  for (const name of ['fansToday', 'fansEvents']) {
    const orig = api[name];
    if (!orig) continue;
    api[name] = (...a) => {
      const res = orig(...a);
      if (res?.items) res.items = withSends(res.items);
      if (res?.rows) res.rows = withSends(res.rows);
      return res;
    };
  }
  return { findMine };
}

module.exports = { addReplies, OPEN };
