'use strict';
// What stays on public display. Remote state (posts.state, as last read) and local policy (policies.display)
// are kept apart: a stored "keep visible" never makes a private post look public.
//
// Expiry rules hide posts by publication age:
//  - independent: one rule per physical blog; each instance's own publication time;
//  - linked: a management blog's rule for its items' owned original plus copies on selected blogs, all anchored
//    at the original's publication time. A linked rule that covers an instance shadows its independent rule.
// Turning a rule off or lengthening it never republishes anything by itself; restoring is a separate preview.

const { J, P } = require('./db');
const DAY = 86400e3;

const policyOf = (db, blog, id) => {
  const r = db.get('SELECT * FROM policies WHERE blog = ? AND id = ?', blog, String(id));
  return r ? { ...r, auto_hide: P(r.auto_hide), conflict: P(r.conflict) } : { blog, id: String(id), display: 'follow_rule', auto_hide: null, conflict: null };
};
function savePolicy(db, p, now = Date.now()) {
  db.run(`INSERT INTO policies (blog, id, display, auto_hide, conflict, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(blog, id) DO UPDATE SET display = excluded.display, auto_hide = excluded.auto_hide, conflict = excluded.conflict, updated_at = excluded.updated_at`,
  p.blog, String(p.id), p.display, J(p.auto_hide), J(p.conflict), now);
}
function setDisplay(db, blog, id, display, now) {
  const p = policyOf(db, blog, id);
  p.display = display;
  if (display !== 'follow_rule') p.auto_hide = null; // the user took over; this app no longer owns that hide
  p.conflict = null;
  savePolicy(db, p, now);
  return p;
}

const rulesOf = db => db.all('SELECT * FROM expiry_rules').map(r => ({ ...r, kinds: P(r.kinds, []), targets: P(r.targets, []) }));

// The rule that applies to one instance, with the anchor and deadline. `shadowed` = an independent rule that a
// linked rule overrides here (shown, never combined).
function effectiveRule(post, item, origin, rules) {
  const fits = r => r.enabled && (r.scope !== 'images' || post.has_images);
  let linked = null, independent = null;
  if (item && !item.external && item.status === 'ok') {
    linked = rules.find(r => r.mode === 'linked' && r.blog === item.manager && fits(r)
      && (post.kind === 'original' && origin && post.blog === origin.blog && post.id === origin.id || r.targets.includes(post.blog))) || null;
  }
  independent = rules.find(r => r.mode === 'independent' && r.blog === post.blog && r.kinds.includes(post.kind) && fits(r)) || null;
  if (linked) {
    // Linked mode needs the verified original's publication time; without it, hold rather than use a copy's time
    const at = origin?.published_at;
    return { rule: linked, anchor: origin ? { blog: origin.blog, id: origin.id, at } : null, due: at ? at + linked.days * DAY : null, shadowed: independent, hold: at ? null : 'no_anchor_time' };
  }
  if (independent) {
    const at = post.published_at;
    return { rule: independent, anchor: { blog: post.blog, id: post.id, at }, due: at ? at + independent.days * DAY : null, shadowed: null, hold: at ? null : 'no_publication_time' };
  }
  return null;
}

// Every owned instance with what expiry would do to it now. Pure read; nothing is queued here.
function evaluate(db, now = Date.now()) {
  const rules = rulesOf(db);
  const items = new Map(db.all('SELECT * FROM items').map(i => [i.id, i]));
  const posts = db.all(`SELECT blog, id, kind, state, published_at, has_images, legacy, pinned, item_id, notes, notes_at, summary, thumb FROM posts WHERE state != 'gone'`);
  const byKey = new Map(posts.map(p => [p.blog + '/' + p.id, p]));
  const pol = new Map(db.all('SELECT * FROM policies').map(p => [p.blog + '/' + p.id, { ...p, conflict: P(p.conflict) }]));
  const openWrites = new Set(db.all(`SELECT scope FROM jobs WHERE kind = 'post.visibility' AND status IN ('pending', 'running', 'verifying', 'waiting', 'unknown')`).map(j => j.scope));
  const out = [];
  for (const p of posts) {
    const item = items.get(p.item_id);
    const origin = item && !item.external ? byKey.get(item.origin_blog + '/' + item.origin_id) : null;
    const eff = effectiveRule(p, item, origin, rules);
    if (!eff) continue;
    const policy = pol.get(p.blog + '/' + p.id) || { display: 'follow_rule' };
    const r = { blog: p.blog, id: p.id, kind: p.kind, state: p.state, rule: eff.rule.id, revision: eff.rule.revision, due: eff.due,
      anchor: eff.anchor, shadowed: eff.shadowed?.id ?? null, display: policy.display, published_at: p.published_at, item_id: p.item_id, has_images: p.has_images, notes: p.notes, notes_at: p.notes_at, summary: p.summary, thumb: p.thumb };
    if (p.state === 'draft' || p.state === 'queue') r.action = 'skip', r.reason = 'not_published';
    else if (p.legacy) r.action = 'hold', r.reason = 'legacy';
    else if (policy.conflict) r.action = 'hold', r.reason = 'conflict';
    else if (item && item.status !== 'ok' && eff.rule.mode === 'linked') r.action = 'hold', r.reason = item.status;
    else if (eff.hold) r.action = 'hold', r.reason = eff.hold;
    else if (openWrites.has(`post:${p.blog}:${p.id}`)) r.action = 'hold', r.reason = 'pending_write';
    else if (policy.display === 'keep_hidden') r.action = 'none', r.reason = 'keep_hidden';
    else if (policy.display === 'keep_visible') r.action = 'none', r.reason = 'keep_visible';
    else if (eff.rule.skip_pinned && p.pinned) r.action = 'none', r.reason = 'pinned';
    else if (p.state === 'private') r.action = 'none', r.reason = 'already_private';
    else if (now >= eff.due) r.action = 'hide', r.reason = 'due';
    else r.action = 'none', r.reason = 'not_due';
    out.push(r);
  }
  return out;
}

// Queue the hides that are due, at most `limit` per pass (the rest wait for the next pass, nothing is marked done)
function queueExpiry(db, jobs, { now = Date.now(), limit = 40 } = {}) {
  const due = evaluate(db, now).filter(r => r.action === 'hide').sort((a, b) => a.due - b.due).slice(0, limit);
  for (const r of due) {
    jobs.add('post.visibility', { blog: r.blog, id: r.id, target: 'private', reason: 'expiry', rule: r.rule, ruleRevision: r.revision, due: r.due, anchor: r.anchor },
      { priority: 6, scope: `post:${r.blog}:${r.id}` });
  }
  return due.length;
}

// A user's visibility choice: the policy is stored at once (it holds even offline), then the write is queued.
// public -> keep_visible, private -> keep_hidden unless the user picked follow_rule.
function userVisibility(db, jobs, targets, target, { display, batchTitle, now = Date.now() } = {}) {
  const disp = display || (target === 'published' ? 'keep_visible' : 'keep_hidden');
  const batch = jobs.batch(batchTitle || (target === 'published' ? 'Make public' : 'Make private'), { targets, target, display: disp });
  let queued = 0;
  db.tx(() => {
    for (const t of targets) {
      setDisplay(db, t.blog, t.id, disp, now);
      const post = db.get('SELECT state FROM posts WHERE blog = ? AND id = ?', t.blog, String(t.id));
      if (!post || !['published', 'private'].includes(post.state)) continue;
      jobs.add('post.visibility', { blog: t.blog, id: String(t.id), target, reason: 'user', display: disp },
        { priority: 1, scope: `post:${t.blog}:${t.id}`, batch, supersede: true });
      queued++;
    }
  });
  return { batch, queued };
}

// Keep visible on a post without changing its remote state now (a public post that should never expire)
function keepVisible(db, jobs, targets, now = Date.now()) {
  db.tx(() => {
    for (const t of targets) {
      setDisplay(db, t.blog, t.id, 'keep_visible', now);
      jobs.cancelScope(`post:${t.blog}:${t.id}`, 'superseded by Keep visible', ['post.visibility']);
    }
  });
  // Private ones need publishing to match the choice
  const priv = targets.filter(t => db.get('SELECT state FROM posts WHERE blog = ? AND id = ?', t.blog, String(t.id))?.state === 'private');
  return priv.length ? userVisibility(db, jobs, priv, 'published', { display: 'keep_visible', now, batchTitle: 'Keep visible' }) : { queued: 0 };
}

// Candidates for "Restore posts hidden by this rule": only hides this app made and still owns
function restorePlan(db, ruleId) {
  return db.all(`SELECT po.blog, po.id, po.auto_hide, p.state, p.summary, p.thumb FROM policies po JOIN posts p ON p.blog = po.blog AND p.id = po.id
    WHERE po.display = 'follow_rule' AND po.auto_hide IS NOT NULL AND po.conflict IS NULL AND p.state = 'private'`)
    .map(r => ({ ...r, auto_hide: P(r.auto_hide) })).filter(r => r.auto_hide?.rule === ruleId);
}

// Sync hook: a post's observed state changed. Decide whether someone else did it.
function observe(db, before, after, now = Date.now()) {
  if (!before || before.state === after.state) return null;
  const scope = `post:${after.blog}:${after.id}`;
  const inFlight = db.get(`SELECT id FROM jobs WHERE scope = ? AND kind = 'post.visibility' AND status IN ('running', 'verifying', 'unknown')`, scope);
  const p = policyOf(db, after.blog, after.id);
  if (inFlight) return null; // our own write explains it, or can't be told apart yet: the job's verification decides
  let what = null;
  if (after.state === 'published' && before.state === 'private') {
    if (p.auto_hide) { p.auto_hide = null; p.display = 'keep_visible'; what = 'external_republish'; }
    else if (p.display === 'keep_hidden') { p.conflict = { seen: 'published', at: now }; what = 'conflict'; }
  } else if (after.state === 'private' && before.state === 'published') {
    if (p.display === 'keep_visible') { p.conflict = { seen: 'private', at: now }; what = 'conflict'; }
    else if (p.display === 'follow_rule') { p.display = 'keep_hidden'; what = 'external_hide'; }
  }
  if (what) savePolicy(db, p, now);
  return what;
}

module.exports = { policyOf, savePolicy, setDisplay, rulesOf, effectiveRule, evaluate, queueExpiry, userVisibility, keepVisible, restorePlan, observe, DAY };
