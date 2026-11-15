'use strict';
// Fans & interactions (docs/FAN_RELATIONSHIP_SPEC.md): who responds to my posts, what is worth answering,
// what I promised whom, how the follower lists change. Read only towards Tumblr: nothing here writes a post,
// follows, blocks or sends a message. Notes, labels, stars, reminders and "done" marks are local.
//
// Sources
// - Notifications (/v2/blog/{blog}/notifications, rollups off): the incremental source of interactions. Newest
//   first, paged by `before` (= the oldest timestamp of the page, in seconds), so events sharing that second are
//   read again on the next page and deduped by Tumblr's notification id. A page that doesn't move `before` back
//   ends the walk and records a gap instead of looping.
// - Follower lists: collected by followers.js (one scan for protection and for this module). A follower missing
//   from a complete walk is checked with /followed_by before it counts as gone; an error leaves it "missing".
// - Follower counts: the blogs' own counts from each sync, kept as observations (no computed totals).
//
// Identity: a Tumblr blog uuid. Notifications always carry it; follower lists only through the browser relay or
// after protection's lookup. Notes and stars need a uuid; a name-only person is resolved (public blog info)
// when the user first saves something about them.

const { J, P } = require('./db');
const { HttpError } = require('./errors');

const DAY = 86400e3;
const RETAIN_DAYS = 180;
const BACKFILL_DAYS = 30;
const PAGES_PER_RUN = 5;
const TODO_KINDS = ['reply', 'mention', 'ask', 'reblog'];

// snake_case (official API, browser relay) or camelCase (web client) field
const f = (o, snake) => {
  if (!o) return undefined;
  if (o[snake] !== undefined) return o[snake];
  return o[snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
};
const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// The newer activity feed sends some notifications as a structured "generic" item: the subtype says what
// happened, the title's mention formatting holds the sender (name and uuid), actions.long_tap.meta holds the post
// and body.content holds the text (often cut with "..."). Found 2026-11-16 on this computer: a reply
// ("Hello are you going to receive COMM? If yes ...") was stored as an unexplained "other" item, so follower
// protection never saw its sender or text. Reads camelCase too.
function structured(n) {
  const title = f(n, 'title') || {};
  const tc = f(title, 'text_content') || {};
  const formatting = f(tc, 'formatting') || [];
  const mention = (Array.isArray(formatting) ? formatting : []).find(x => x?.type === 'mention' && x.blog)?.blog || {};
  const images = f(f(n, 'avatar') || {}, 'images') || [];
  const img = Array.isArray(images) ? images[0] || {} : {};
  const imgMeta = f(f(f(img, 'actions') || {}, 'hover') || {}, 'meta') || {};
  const actions = f(n, 'actions') || {};
  const meta = f(f(actions, 'long_tap') || {}, 'meta') || {};
  const href = String(f(f(actions, 'tap') || {}, 'href') || '');
  const blocks = ((f(f(n, 'body') || {}, 'content') || []).filter(b => b?.type === 'text' && b.text));
  const quote = blocks.filter(b => f(b, 'subtype') === 'indented');
  const texts = quote.length ? quote : blocks.filter(b => !/^(replied to your post|asked|sent you an ask|mentioned you)\b/i.test(b.text));
  const label = blocks.map(b => b.text).join(' ');
  const subtype = String(f(n, 'subtype') || '').toLowerCase();
  const kind = /reply/.test(subtype) || /replied to your/i.test(label) ? 'reply'
    : /mention/.test(subtype) || /mentioned you/i.test(label) ? 'mention'
      : /ask|question|submission/.test(subtype) || /asked|sent you an ask/i.test(label) ? 'ask' : null;
  return {
    kind,
    from_uuid: f(mention, 'uuid') || f(imgMeta, 'tumblelog_id') || null,
    from_name: f(mention, 'name') || String(f(tc, 'text') || '') || f(img, 'alt_text') || null,
    // the notification links to /<blog>/<post>/replies/<reply>; the post id is also next to the mute action
    post_id: String(f(meta, 'post_id') || /^\/[^/]+\/(\d{1,25})\/replies\//.exec(href)?.[1] || '') || null,
    text: strip(texts.map(b => b.text).join('\n')).slice(0, 2000) || null,
  };
}

// One notification → an interaction row, or null for what isn't about my blog (e.g. "what you missed")
function normalize(n, now) {
  const type = String(f(n, 'type') || '');
  const id = String(f(n, 'id') || '');
  if (!id || !type || type === 'what_you_missed') return null;
  const tagsRaw = f(n, 'post_tags');
  const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String) : [];
  const added = strip(f(n, 'added_text'));
  const reply = strip(f(n, 'reply_text'));
  const s = structured(n);
  let kind;
  if (/^(reply|conversational_note|note_mention)$/.test(type)) kind = 'reply';
  else if (/mention/.test(type)) kind = 'mention';
  else if (/^(ask|answered_ask|ask_answer|submission)$/.test(type)) kind = 'ask';
  else if (type === 'reblog' || type === 'reblog_naked' || type === 'reblog_with_content') kind = added || tags.length ? 'reblog' : 'reblog_plain';
  else if (type === 'like') kind = 'like';
  else if (type === 'follower' || type === 'follow') kind = 'follow';
  else if (type === 'generic' && s.kind) kind = s.kind;
  else kind = 'other';
  const anon = !!f(n, 'is_anonymous');
  return {
    id, type, kind,
    blog: f(n, 'target_tumblelog_uuid') || null,
    from_uuid: anon ? null : (f(n, 'from_tumblelog_uuid') || s.from_uuid || null),
    from_name: anon ? null : (f(n, 'from_tumblelog_name') || s.from_name || null),
    post_id: String(f(n, 'target_post_id') || '') || s.post_id || null,
    reblog_id: String(f(n, 'post_id') || '') || null,
    text: (reply || added || strip(f(n, 'answer_text')) || strip(f(n, 'question')) || s.text || '').slice(0, 2000) || null,
    tags,
    summary: strip(f(n, 'target_post_summary')).slice(0, 200) || null,
    at: (Number(f(n, 'timestamp')) || 0) * 1000,
    fetched_at: now,
  };
}

function addAudience(svc, api) {
  const { db, jobs } = svc;
  const now = () => svc.ctx.now();
  const cfg = () => ({ collect: false, notifications: true, blogs: null, enabledAt: null, ...db.getMeta('audience', {}) });
  const primary = () => db.get('SELECT uuid FROM blogs WHERE is_primary = 1')?.uuid || null;
  const blogsOf = () => cfg().blogs || [primary()].filter(Boolean);
  const ownIds = () => new Set(db.all('SELECT uuid FROM blogs').map(b => b.uuid));
  const ownNames = () => new Set(db.all('SELECT name FROM blogs').map(b => String(b.name).toLowerCase()));
  const open = (kind, scope) => db.get(`SELECT id FROM jobs WHERE kind = ? AND scope = ? AND status IN ('pending', 'running', 'waiting')`, kind, scope);

  // ---------- collection ----------
  function store(row, history, own) {
    const todo = TODO_KINDS.includes(row.kind) && !own;
    const state = !todo ? 'digest' : history ? 'old' : 'new';
    const ex = db.get('SELECT kind, text, from_uuid, from_name, post_id, summary, state FROM interactions WHERE id = ?', row.id);
    let added = 0;
    if (!ex) {
      db.run(`INSERT INTO interactions (id, blog, type, kind, from_uuid, from_name, post_id, reblog_id, text, tags, summary, at, fetched_at, state, state_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      row.id, row.blog, row.type, row.kind, row.from_uuid, row.from_name, row.post_id, row.reblog_id, row.text, J(row.tags), row.summary, row.at, row.fetched_at, state, now());
      added = 1;
    } else {
      // A notification read again can carry more than its first read did (a reply that arrived as an unexplained
      // "generic" item now has its sender, post and text). Fill only blanks; the person's state and tags stay.
      const patch = {};
      if (ex.kind === 'other' && row.kind !== 'other') patch.kind = row.kind;
      for (const k of ['text', 'from_uuid', 'from_name', 'post_id', 'summary']) if (!ex[k] && row[k]) patch[k] = row[k];
      // it was a to-do all along; history still never lands in the to-do list
      if (patch.kind && TODO_KINDS.includes(patch.kind) && !own && ex.state === 'digest' && !TODO_KINDS.includes(ex.kind)) patch.state = history ? 'old' : 'new';
      const cols = Object.keys(patch);
      if (cols.length) {
        db.run(`UPDATE interactions SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, ...cols.map(c => patch[c]), row.id);
        row = { ...row, ...patch };
        added = 1;
      }
    }
    if (added && row.from_uuid && row.from_name) noteName(row.from_uuid, row.from_name);
    // ad / scam texts go to follower protection's review (followers.js); a screening error never stops collection
    if (added && !own) try { svc.screenInteraction?.(row); } catch (e) { db.log('warn', 'screen', String(e?.message || e)); }
    return added;
  }
  // a known person seen under a new name keeps the old one in their history
  function noteName(uuid, name) {
    const p = db.get('SELECT name, names FROM people WHERE uuid = ?', uuid);
    if (!p || !name || p.name === name) return;
    const names = [...new Set([...(P(p.names, []) || []), p.name].filter(Boolean))].filter(x => x !== name);
    db.run('UPDATE people SET name = ?, names = ? WHERE uuid = ?', name, J(names), uuid);
  }

  // Which notification types Tumblr actually sends, with one local sample of each (diagnosis of the mapping in
  // normalize; never sent anywhere): meta notifTypes = { "type" or "type:subtype": { n, kind, sample } }.
  // The subtype matters: "generic" is reply, ask or something else entirely.
  function noteTypes(list) {
    const seen = db.getMeta('notifTypes', {}) || {};
    for (const n of list) {
      const type = String(f(n, 'type') || '?');
      const subtype = String(f(n, 'subtype') || '');
      const key = subtype ? type + ':' + subtype : type;
      const e = seen[key] || (seen[key] = { n: 0, kind: normalize(n, now())?.kind || null, sample: JSON.stringify(n).slice(0, 3000) });
      e.n++;
    }
    db.setMeta('notifTypes', seen);
  }
  svc.handlers['audience.notifications'] = {
    async run(job, ctx) {
      try { return await readNotifications(job, ctx); }
      catch (e) {
        const key = 'notif:' + job.payload.blog;
        db.setMeta(key, { ...(db.getMeta(key, {}) || {}), error: String(e?.message || e).slice(0, 200), errorAt: now() });
        throw e;
      }
    },
  };
  // A notification stored before its shape was understood is read once more just around its own second (not a
  // full backfill): the row then gains its sender and text, and store() lets protection screen it again.
  const REMAP_VERSION = 2;
  svc.handlers['audience.remap'] = {
    async run(job, ctx) {
      const { blog, id } = job.payload;
      const target = Math.floor(Number(job.payload.at) / 1000);
      let before = job.payload.before;
      for (let page = 0; page < 3 && before != null; page++) {
        const r = await ctx.tumblr.notifications(blog, { before });
        const list = r?.notifications || [];
        if (!list.length) break;
        noteTypes(list);
        const rows = list.map(n => normalize(n, now())).filter(Boolean);
        const hit = rows.filter(row => row.id === String(id));
        if (hit.length) {
          const enabledAt = cfg().enabledAt || now();
          const own = ownIds();
          db.tx(() => { for (const row of hit) store({ ...row, blog: row.blog || blog }, row.at < enabledAt, own.has(row.from_uuid)); });
          return { status: 'succeeded', result: { found: true } };
        }
        const links = r?._links || r?.links;
        const next = links?.next ? f(links.next, 'query_params')?.before : null;
        const oldest = Math.min(...list.map(n => Number(f(n, 'timestamp')) || 0));
        if (!next || Number(next) >= Number(before) || oldest < target) break; // the page already reaches past it
        before = next;
      }
      return { status: 'skipped', error: 'the notification is no longer in the feed' };
    },
  };
  async function readNotifications(job, ctx) {
      const { blog } = job.payload;
      const key = 'notif:' + blog;
      const st = db.getMeta(key, {}) || {};
      const c = cfg();
      // first run backfills BACKFILL_DAYS (as history: nothing old lands in the to-do list); later runs stop
      // once they reach what was read before (one second of overlap; ids dedupe)
      const floor = st.high ? st.high - 1 : Math.floor((now() - BACKFILL_DAYS * DAY) / 1000);
      const enabledAt = c.enabledAt || now();
      const own = ownIds();
      let before = job.payload.before || null;
      let newest = job.payload.newest || 0, added = job.payload.added || 0;
      let oldest = job.payload.oldest || null, end = null;
      for (let page = 0; page < PAGES_PER_RUN; page++) {
        const r = await ctx.tumblr.notifications(blog, before ? { before } : {});
        const list = r?.notifications || [];
        const rows = list.map(n => normalize(n, now())).filter(Boolean);
        noteTypes(list);
        db.tx(() => { for (const row of rows) added += store({ ...row, blog: row.blog || blog }, row.at < enabledAt, own.has(row.from_uuid)); });
        const stamps = list.map(n => Number(f(n, 'timestamp')) || 0).filter(Boolean);
        if (stamps.length) { newest = Math.max(newest, ...stamps); oldest = Math.min(oldest ?? Infinity, ...stamps); }
        const links = r?._links || r?.links;
        const next = links?.next ? (f(links.next, 'query_params')?.before ?? null) : null;
        if (!list.length || !next) { end = 'end'; break; }
        if (Math.min(...stamps) <= floor) { end = 'reached'; break; }
        if (before && Number(next) >= Number(before)) { end = 'stuck'; break; } // no progress: stop, keep the gap
        before = next;
      }
      if (!end) return { status: 'pending', payload: { ...job.payload, before, newest, added, oldest } };
      const gaps = [...(st.gaps || [])];
      if (end === 'stuck') gaps.push({ from: (oldest || 0) * 1000, to: (st.high || oldest || 0) * 1000, at: now(), why: 'paging did not move back' });
      const coveredFrom = st.coveredFrom ?? (end === 'reached' ? floor * 1000 : (oldest ?? Math.floor(now() / 1000)) * 1000);
      db.setMeta(key, { ...st, high: Math.max(st.high || 0, newest), coveredFrom, at: now(), gaps: gaps.slice(-20), error: null });
      db.capability('audience.notifications', 'pass', 'read on ' + new Date(now()).toISOString());
      return { status: 'succeeded', result: { added, end } };
  }

  // Check followers that a complete scan didn't see. Yes → still following (the walk missed them); no → gone,
  // with the interval in which it happened; any error → stays "missing", checked again later.
  svc.handlers['audience.verify'] = {
    async run(job, ctx) {
      const { blog } = job.payload;
      const rows = db.all(`SELECT * FROM followers WHERE blog = ? AND gone = 1 AND gone_at IS NULL AND (checked_at IS NULL OR checked_at < ?) ORDER BY last_seen DESC LIMIT 25`, blog, now() - 12 * 3600e3);
      let gone = 0, back = 0, unknown = 0;
      for (const r of rows) {
        let res;
        try { res = await ctx.tumblr.followedBy(blog, r.name); }
        catch (e) {
          unknown++;
          const note = e instanceof HttpError && e.status === 404 ? 'blog not found (renamed or deleted)' : String(e.message || e).slice(0, 120);
          db.run('UPDATE followers SET checked_at = ?, check_note = ? WHERE blog = ? AND name = ?', now(), note, blog, r.name);
          if (!(e instanceof HttpError)) throw e; // network / limits: retry the job
          continue;
        }
        const yes = f(res, 'followed_by');
        if (yes === true) {
          back++;
          db.run('UPDATE followers SET gone = 0, last_seen = ?, checked_at = ?, check_note = ? WHERE blog = ? AND name = ?', now(), now(), 'still following (missed by the list)', blog, r.name);
        } else if (yes === false) {
          gone++;
          const blocked = r.uuid && db.get(`SELECT 1 FROM blocks WHERE blog = ? AND target = ? AND status = 'blocked'`, blog, r.uuid);
          db.run('UPDATE followers SET gone_at = ?, checked_at = ?, check_note = NULL WHERE blog = ? AND name = ?', now(), now(), blog, r.name);
          db.run('INSERT INTO audience_changes (blog, name, uuid, kind, at, since, note) VALUES (?, ?, ?, ?, ?, ?, ?)', blog, r.name, r.uuid || null, 'unfollow', now(), r.last_seen, blocked ? 'blocked' : null);
        } else {
          unknown++;
          db.run('UPDATE followers SET checked_at = ?, check_note = ? WHERE blog = ? AND name = ?', now(), 'no answer', blog, r.name);
        }
      }
      if (gone || back) db.capability('audience.followedBy', 'pass', 'answered on ' + new Date(now()).toISOString());
      return { status: 'succeeded', result: { checked: rows.length, gone, back, unknown } };
    },
  };

  function planVerify(blog) {
    if (!cfg().collect) return;
    const n = db.get('SELECT COUNT(*) n FROM followers WHERE blog = ? AND gone = 1 AND gone_at IS NULL AND (checked_at IS NULL OR checked_at < ?)', blog, now() - 12 * 3600e3).n;
    if (n && !open('audience.verify', 'verify:' + blog)) jobs.add('audience.verify', { blog }, { priority: 8, scope: 'verify:' + blog });
  }
  svc.afterFollowerScan = blog => planVerify(blog);

  // One-time repair for rows stored before the generic notification shape was understood (2026-11-16): each is
  // read again around its own second. Rows the feed no longer has stay as they are.
  function planRemap() {
    if ((db.getMeta('notifRemap', 1) || 1) >= REMAP_VERSION) return 0;
    const rows = db.all(`SELECT id, blog, at FROM interactions WHERE type = 'generic' AND (kind = 'other' OR text IS NULL)`);
    for (const r of rows) {
      if (!open('audience.remap', 'remap:' + r.id)) jobs.add('audience.remap', { blog: r.blog, id: r.id, at: r.at, before: Math.floor(r.at / 1000) + 1 }, { priority: 9, scope: 'remap:' + r.id });
    }
    db.setMeta('notifRemap', REMAP_VERSION);
    return rows.length;
  }

  function plan() {
    const c = cfg();
    if (!c.collect) return 0;
    let n = 0;
    for (const blog of blogsOf()) {
      if (c.notifications !== false && !open('audience.notifications', 'notif:' + blog)) { jobs.add('audience.notifications', { blog }, { priority: 7, scope: 'notif:' + blog }); n++; }
      planVerify(blog);
    }
    planRemap();
    // follower count observations: one row when the count changes, otherwise one every 6 hours
    for (const b of db.all('SELECT uuid, followers FROM blogs WHERE followers IS NOT NULL')) {
      const last = db.get('SELECT at, followers FROM audience_counts WHERE blog = ? ORDER BY at DESC LIMIT 1', b.uuid);
      if (!last || last.followers !== b.followers || last.at < now() - 6 * 3600e3) db.run('INSERT OR IGNORE INTO audience_counts (blog, at, followers) VALUES (?, ?, ?)', b.uuid, now(), b.followers);
    }
    // retention: plain events older than RETAIN_DAYS go; open items and anything a reminder points at stay
    if ((db.getMeta('audiencePrune', 0) || 0) < now() - DAY) {
      db.run(`DELETE FROM interactions WHERE at < ? AND state NOT IN ('new', 'later') AND id NOT IN (SELECT event FROM reminders WHERE event IS NOT NULL)`, now() - RETAIN_DAYS * DAY);
      db.setMeta('audiencePrune', now());
    }
    return n;
  }
  (svc.afterPass ||= []).push(plan);

  // ---------- people ----------
  // A person's key: their uuid, or "name:<name>" while only the name is known
  const keyOf = (uuid, name) => (uuid ? uuid : 'name:' + String(name || '').toLowerCase());
  function nameMap() {
    // name → uuid, from everything that saw both
    const m = new Map();
    for (const r of db.all(`SELECT from_name n, from_uuid u FROM interactions WHERE from_uuid IS NOT NULL AND from_name IS NOT NULL GROUP BY from_uuid, from_name`)) m.set(r.n.toLowerCase(), r.u);
    for (const r of db.all(`SELECT name n, uuid u FROM followers WHERE uuid IS NOT NULL AND uuid != ''`)) m.set(r.n.toLowerCase(), r.u);
    for (const r of db.all('SELECT name n, uuid u FROM people WHERE name IS NOT NULL')) m.set(r.n.toLowerCase(), r.u);
    return m;
  }
  function everyone() {
    const map = new Map(), names = nameMap(), mine = ownIds(), myNames = ownNames();
    const following = new Set(db.getMeta('following', []) || []);
    const followingNames = new Set((db.getMeta('followingNames', []) || []).map(n => String(n).toLowerCase()));
    const pri = primary();
    const get = (uuid, name) => {
      const u = uuid || names.get(String(name || '').toLowerCase()) || null;
      if (u && mine.has(u)) return null;
      if (!u && myNames.has(String(name || '').toLowerCase())) return null;
      const k = keyOf(u, name);
      let p = map.get(k);
      if (!p) map.set(k, p = { key: k, uuid: u, name: name || null, follows: [], missing: [], gone: [], firstSeen: null, last: null, n30: 0, days30: 0, texts: 0, star: 0, labels: [], alias: null, note: null, mute: 0 });
      if (name && !p.name) p.name = name;
      return p;
    };
    for (const r of db.all('SELECT * FROM followers')) {
      const p = get(r.uuid || null, r.name);
      if (!p) continue;
      if (r.gone_at) p.gone.push(r.blog); else if (r.gone) p.missing.push(r.blog); else p.follows.push(r.blog);
      if (!r.baseline && r.first_seen && (!p.firstSeen || r.first_seen < p.firstSeen)) p.firstSeen = r.first_seen;
    }
    const since = now() - 30 * DAY;
    for (const r of db.all(`SELECT from_uuid u, MAX(from_name) n, MAX(at) last, SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) n30,
        COUNT(DISTINCT CASE WHEN at >= ? THEN date(at / 1000, 'unixepoch') END) days30,
        SUM(CASE WHEN kind IN ('reply', 'mention', 'ask', 'reblog') THEN 1 ELSE 0 END) texts
        FROM interactions WHERE from_uuid IS NOT NULL AND kind != 'other' GROUP BY from_uuid`, since, since)) {
      const latest = db.get('SELECT from_name FROM interactions WHERE from_uuid = ? ORDER BY at DESC LIMIT 1', r.u)?.from_name || r.n;
      const p = get(r.u, latest);
      if (!p) continue;
      p.name = latest || p.name; p.last = r.last; p.n30 = r.n30; p.days30 = r.days30; p.texts = r.texts;
    }
    for (const r of db.all('SELECT * FROM people')) {
      const p = get(r.uuid, r.name);
      if (!p) continue;
      Object.assign(p, { star: r.star, alias: r.alias, labels: P(r.labels, []) || [], note: r.note, mute: r.mute, oldNames: P(r.names, []) || [] });
      if (r.name) p.name = r.name;
    }
    for (const p of map.values()) {
      p.iFollow = p.uuid ? following.has(p.uuid) : (p.name ? followingNames.has(p.name.toLowerCase()) : false);
      p.mutual = p.iFollow && !!pri && p.follows.includes(pri);
    }
    return [...map.values()];
  }

  function person(key) {
    const all = everyone();
    const p = all.find(x => x.key === key) || (key.startsWith('name:') ? null : all.find(x => x.uuid === key));
    if (!p) return null;
    const names = [p.name, ...(p.oldNames || [])].filter(Boolean);
    const followRows = db.all(`SELECT * FROM followers WHERE ${p.uuid ? 'uuid = ? OR ' : ''}lower(name) IN (${names.map(() => '?').join(',') || "''"})`,
      ...(p.uuid ? [p.uuid] : []), ...names.map(n => n.toLowerCase()));
    const events = p.uuid
      ? db.all(`SELECT * FROM interactions WHERE from_uuid = ? ORDER BY at DESC LIMIT 60`, p.uuid)
      : db.all(`SELECT * FROM interactions WHERE lower(from_name) = ? ORDER BY at DESC LIMIT 60`, String(p.name || '').toLowerCase());
    return {
      ...p,
      relations: followRows.map(r => ({ blog: r.blog, state: r.gone_at ? 'gone' : r.gone ? 'missing' : 'following', firstSeen: r.baseline ? null : r.first_seen, baseline: !!r.baseline, lastSeen: r.last_seen, goneAt: r.gone_at, note: r.check_note })),
      followingAt: db.getMeta('followingAt', null),
      events: events.map(rowOut),
      reminders: p.uuid ? db.all(`SELECT * FROM reminders WHERE uuid = ? ORDER BY status = 'open' DESC, due`, p.uuid) : [],
      changes: db.all(`SELECT * FROM audience_changes WHERE ${p.uuid ? 'uuid = ? OR ' : ''}lower(name) = ? ORDER BY at DESC LIMIT 20`, ...(p.uuid ? [p.uuid] : []), String(p.name || '').toLowerCase()),
      protection: p.uuid ? {
        case: (c => c && { status: c.status, assessment: P(c.assessment) })(db.get('SELECT status, assessment FROM follower_cases WHERE uuid = ?', p.uuid)),
        allowed: !!db.get('SELECT 1 FROM allowlist WHERE uuid = ?', p.uuid),
        blocks: db.all(`SELECT blog, origin, status FROM blocks WHERE target = ?`, p.uuid),
      } : null,
    };
  }

  // Notes and stars need a stable identity: look the name up once (public blog info)
  async function resolve(key) {
    if (!key.startsWith('name:')) return key;
    const name = key.slice(5);
    let info;
    try { info = await svc.ctx.tumblr.publicInfo(name); }
    catch (e) { throw new Error(e instanceof HttpError && e.status === 404 ? 'this blog no longer exists under that name' : 'could not confirm who this is: ' + (e.message || e)); }
    const uuid = info?.blog?.uuid;
    if (!uuid) throw new Error('Tumblr gave no stable id for this blog');
    db.run('UPDATE followers SET uuid = ? WHERE lower(name) = ? AND (uuid IS NULL OR uuid = \'\')', uuid, name);
    return uuid;
  }
  function ensurePerson(uuid, name) {
    db.run('INSERT INTO people (uuid, name, resolved_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(uuid) DO NOTHING', uuid, name || null, now(), now());
  }

  const rowOut = r => ({ ...r, tags: P(r.tags, []) || [], raw: undefined });

  // ---------- views ----------
  function todayList() {
    const t = now();
    const endOfDay = new Date(t); endOfDay.setHours(23, 59, 59, 999);
    const stars = new Set(db.all('SELECT uuid FROM people WHERE star = 1').map(r => r.uuid));
    const muted = new Set(db.all('SELECT uuid FROM people WHERE mute = 1').map(r => r.uuid));
    const reminders = db.all(`SELECT r.*, p.name, p.alias FROM reminders r LEFT JOIN people p ON p.uuid = r.uuid WHERE r.status = 'open' AND (r.due IS NULL OR r.due <= ?) ORDER BY r.due`, endOfDay.getTime());
    const items = db.all(`SELECT * FROM interactions WHERE (state = 'new' OR (state = 'later' AND later_until <= ?)) ORDER BY at DESC LIMIT 300`, t)
      .filter(r => !muted.has(r.from_uuid))
      .map(rowOut)
      .map(r => ({ ...r, star: stars.has(r.from_uuid) ? 1 : 0 }))
      .sort((a, b) => b.star - a.star || b.at - a.at);
    const day = t - DAY, week = t - 7 * DAY;
    const count = (sql, ...a) => db.get(sql, ...a).n;
    return {
      reminders, items,
      digest: {
        likes: count(`SELECT COUNT(*) n FROM interactions WHERE kind = 'like' AND at >= ?`, day),
        reblogs: count(`SELECT COUNT(*) n FROM interactions WHERE kind = 'reblog_plain' AND at >= ?`, day),
        follows: count(`SELECT COUNT(*) n FROM audience_changes WHERE kind = 'follow' AND at >= ?`, week),
        later: count(`SELECT COUNT(*) n FROM interactions WHERE state = 'later' AND later_until > ?`, t),
        review: count(`SELECT COUNT(*) n FROM follower_cases WHERE status = 'review'`),
      },
    };
  }

  function stats(days = 7) {
    const t = now(), since = t - days * DAY;
    const counts = db.all('SELECT uuid, name, followers FROM blogs ORDER BY is_primary DESC, name').map(b => {
      const first = db.get('SELECT at, followers FROM audience_counts WHERE blog = ? AND at >= ? ORDER BY at LIMIT 1', b.uuid, since);
      const before = db.get('SELECT at, followers FROM audience_counts WHERE blog = ? AND at < ? ORDER BY at DESC LIMIT 1', b.uuid, since);
      const base = before || first;
      return { blog: b.uuid, name: b.name, now: b.followers, from: base?.followers ?? null, fromAt: base?.at ?? null, comparable: !!before };
    });
    const changes = db.all('SELECT * FROM audience_changes WHERE at >= ? ORDER BY at DESC LIMIT 200', since);
    const missing = db.all('SELECT blog, name, last_seen, checked_at, check_note FROM followers WHERE gone = 1 AND gone_at IS NULL ORDER BY last_seen DESC LIMIT 100');
    const people = db.get(`SELECT COUNT(DISTINCT from_uuid) n FROM interactions WHERE at >= ? AND from_uuid IS NOT NULL AND kind NOT IN ('other', 'follow')`, since).n;
    const unresolved = db.get(`SELECT COUNT(*) n FROM interactions WHERE at >= ? AND from_uuid IS NULL AND kind NOT IN ('other', 'follow')`, since).n;
    const repeat = db.get(`SELECT COUNT(*) n FROM (SELECT from_uuid FROM interactions WHERE at >= ? AND from_uuid IS NOT NULL AND kind NOT IN ('other', 'follow')
      GROUP BY from_uuid HAVING COUNT(DISTINCT date(at / 1000, 'unixepoch')) >= 2)`, since).n;
    // per post (the post that was interacted with; an original and my own reblogs of it stay separate events)
    const posts = db.all(`SELECT i.blog, i.post_id, COUNT(DISTINCT i.from_uuid) people,
        SUM(i.kind IN ('reply', 'mention')) replies, SUM(i.kind IN ('reblog', 'reblog_plain')) reblogs, SUM(i.kind = 'like') likes,
        SUM(i.kind = 'reblog' AND (i.text IS NOT NULL OR i.tags != '[]')) said, MAX(i.summary) summary
        FROM interactions i WHERE i.at >= ? AND i.post_id IS NOT NULL GROUP BY i.blog, i.post_id ORDER BY people DESC, said DESC LIMIT 15`, since)
      .map(r => {
        const p = db.get('SELECT summary, thumb, item_id FROM posts WHERE id = ?', r.post_id);
        const tags = db.all(`SELECT tags FROM interactions WHERE post_id = ? AND at >= ? AND kind = 'reblog' AND tags != '[]' ORDER BY at DESC LIMIT 12`, r.post_id, since).flatMap(x => P(x.tags, []) || []);
        return { ...r, title: p?.summary || r.summary, thumb: p?.thumb || null, item_id: p?.item_id || null, tags: [...new Set(tags)].slice(0, 12) };
      });
    const coverage = blogsOf().map(b => ({ blog: b, notif: db.getMeta('notif:' + b, null), scan: db.getMeta('followerScan:' + b, null), baseline: db.getMeta('followerBaseline:' + b, null) }));
    return { days, counts, changes, missing, interactions: { people, unresolved, repeat }, posts, coverage };
  }

  Object.assign(api, {
    fansConfig() {
      const c = cfg();
      return { ...c, blogs: blogsOf(), capabilities: { notifications: db.capStatus('audience.notifications'), followedBy: db.capStatus('audience.followedBy') },
        coverage: blogsOf().map(b => ({ blog: b, notif: db.getMeta('notif:' + b, null), scan: db.getMeta('followerScan:' + b, null) })) };
    },
    setFansConfig(patch) {
      const c = { ...cfg(), ...patch };
      // only my own blogs; before the first sync there is nothing to check against yet
      if (patch.blogs) { const mine = ownIds(); c.blogs = mine.size ? patch.blogs.filter(b => mine.has(b)) : patch.blogs; if (!c.blogs.length) c.blogs = null; }
      if (c.collect && !c.enabledAt) c.enabledAt = now();
      db.setMeta('audience', c);
      if (c.collect) { svc.followerPass?.({ force: true }); plan(); }
      return api.fansConfig();
    },
    fansSync() { plan(); svc.followerPass?.({ force: true }); return true; },
    fansToday: todayList,
    fansEvents({ kind = null, blog = null, state = null, who = null, q = '', offset = 0, limit = 50 } = {}) {
      const where = ["kind != 'other'"], args = [];
      if (kind === 'text') where.push(`kind IN ('reply', 'mention', 'ask', 'reblog')`);
      else if (kind) { where.push('kind = ?'); args.push(kind); }
      if (blog) { where.push('blog = ?'); args.push(blog); }
      if (state === 'open') where.push(`state IN ('new', 'later')`);
      else if (state) { where.push('state = ?'); args.push(state); }
      if (who) { where.push('from_uuid = ?'); args.push(who); }
      if (q) { where.push('(from_name LIKE ? OR text LIKE ? OR tags LIKE ? OR summary LIKE ?)'); const l = '%' + q + '%'; args.push(l, l, l, l); }
      const w = where.join(' AND ');
      return { total: db.get(`SELECT COUNT(*) n FROM interactions WHERE ${w}`, ...args).n,
        rows: db.all(`SELECT * FROM interactions WHERE ${w} ORDER BY at DESC LIMIT ? OFFSET ?`, ...args, Math.min(limit, 200), offset).map(rowOut) };
    },
    // Local workflow only: nothing is sent or marked read on Tumblr. Returns the earlier states for undo.
    setFansEvents({ ids, state, until = null, restore = null }) {
      if (restore) {
        db.tx(() => { for (const r of restore) db.run('UPDATE interactions SET state = ?, later_until = ?, state_at = ? WHERE id = ?', r.state, r.later_until ?? null, now(), r.id); });
        return [];
      }
      if (!['done', 'skip', 'later', 'new'].includes(state)) throw new Error('bad state');
      const prev = ids.map(id => db.get('SELECT id, state, later_until FROM interactions WHERE id = ?', id)).filter(Boolean);
      db.tx(() => { for (const id of ids) db.run('UPDATE interactions SET state = ?, later_until = ?, state_at = ? WHERE id = ?', state, state === 'later' ? (until || now() + DAY) : null, now(), id); });
      return prev;
    },
    // "I replied on Tumblr": what the user says, kept apart from any machine-confirmed send (there is none)
    markReplied({ id, on = true }) {
      db.run('UPDATE interactions SET replied = ?, state = CASE WHEN ? = 1 AND state IN (\'new\', \'later\', \'old\') THEN \'done\' ELSE state END, state_at = ? WHERE id = ?', on ? 1 : 0, on ? 1 : 0, now(), id);
      return true;
    },
    fansPeople({ rel = 'all', q = '', label = null, star = false, blog = null, sort = 'recent', offset = 0, limit = 60 } = {}) {
      let list = everyone();
      if (rel === 'followers') list = list.filter(p => p.follows.length);
      else if (rel === 'mutual') list = list.filter(p => p.mutual);
      else if (rel === 'following') list = list.filter(p => p.iFollow);
      else if (rel === 'interacted') list = list.filter(p => p.texts > 0 || p.n30 > 0);
      else if (rel === 'new') list = list.filter(p => p.firstSeen && p.firstSeen >= now() - 7 * DAY);
      else if (rel === 'regular') list = list.filter(p => p.days30 >= 3);
      else if (rel === 'missing') list = list.filter(p => p.missing.length || p.gone.length);
      else list = list.filter(p => p.follows.length || p.missing.length || p.texts || p.n30 || p.star || p.note || p.labels.length || p.iFollow);
      if (star) list = list.filter(p => p.star);
      if (label) list = list.filter(p => p.labels.includes(label));
      if (blog) list = list.filter(p => p.follows.includes(blog));
      if (q) {
        const k = q.toLowerCase();
        list = list.filter(p => [p.name, p.alias, p.note, ...(p.oldNames || []), ...p.labels].some(x => x && String(x).toLowerCase().includes(k)));
      }
      const by = { recent: (a, b) => (b.last || b.firstSeen || 0) - (a.last || a.firstSeen || 0), active: (a, b) => b.days30 - a.days30 || b.n30 - a.n30, name: (a, b) => String(a.alias || a.name).localeCompare(String(b.alias || b.name)) }[sort] || (() => 0);
      list.sort((a, b) => b.star - a.star || by(a, b));
      const labels = [...new Set(db.all('SELECT labels FROM people').flatMap(r => P(r.labels, []) || []))].sort();
      return { total: list.length, rows: list.slice(offset, offset + Math.min(limit, 200)), labels };
    },
    fansPerson({ key }) { return person(key); },
    async savePerson({ key, patch }) {
      const p0 = everyone().find(x => x.key === key);
      const uuid = await resolve(key);
      ensurePerson(uuid, p0?.name || (key.startsWith('name:') ? key.slice(5) : null));
      const cur = db.get('SELECT * FROM people WHERE uuid = ?', uuid);
      const next = {
        star: patch.star != null ? (patch.star ? 1 : 0) : cur.star,
        alias: patch.alias !== undefined ? (String(patch.alias || '').trim().slice(0, 60) || null) : cur.alias,
        labels: patch.labels ? J([...new Set(patch.labels.map(x => String(x).trim()).filter(Boolean))].slice(0, 20)) : cur.labels,
        note: patch.note !== undefined ? (String(patch.note || '').slice(0, 4000) || null) : cur.note,
        mute: patch.mute != null ? (patch.mute ? 1 : 0) : cur.mute,
      };
      db.run('UPDATE people SET star = ?, alias = ?, labels = ?, note = ?, mute = ?, updated_at = ? WHERE uuid = ?', next.star, next.alias, next.labels, next.note, next.mute, now(), uuid);
      return { key: uuid };
    },
    async addReminder({ key, text, due = null, event = null }) {
      const uuid = await resolve(key);
      const p0 = everyone().find(x => x.key === key || x.uuid === uuid);
      ensurePerson(uuid, p0?.name || null);
      const r = db.run('INSERT INTO reminders (uuid, text, due, status, event, created_at) VALUES (?, ?, ?, ?, ?, ?)', uuid, String(text || '').trim().slice(0, 300) || '…', due, 'open', event, now());
      return { id: Number(r.lastInsertRowid), key: uuid };
    },
    setReminder({ id, status = null, due }) {
      const r = db.get('SELECT * FROM reminders WHERE id = ?', id);
      if (!r) throw new Error('no such reminder');
      if (status && !['open', 'done', 'dismissed'].includes(status)) throw new Error('bad status');
      db.run('UPDATE reminders SET status = ?, due = ?, done_at = ? WHERE id = ?', status || r.status, due !== undefined ? due : r.due, status && status !== 'open' ? now() : null, id);
      return true;
    },
    fansReminders({ status = 'open' } = {}) {
      return db.all('SELECT r.*, p.name, p.alias FROM reminders r LEFT JOIN people p ON p.uuid = r.uuid WHERE r.status = ? ORDER BY r.due IS NULL, r.due LIMIT 200', status);
    },
    fansStats({ days = 7 } = {}) { return stats(days); },
  });
  return { plan, normalize };
}

module.exports = { addAudience, normalize, TODO_KINDS };
