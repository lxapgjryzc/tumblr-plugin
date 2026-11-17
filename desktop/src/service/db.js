'use strict';
// Local store: one SQLite file (node:sqlite, built into Node 24 and Electron). Everything the desktop knows lives
// here; remote state and local policy are separate columns/tables so a sync never overwrites a user's choice.
// Migrations are additive: each entry runs once, in order, inside a transaction.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = [
  // 1: foundation
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE blogs (
    uuid TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT, is_primary INTEGER DEFAULT 0,
    role TEXT, avatar TEXT, url TEXT, followers INTEGER, updated_at INTEGER, raw TEXT
  );
  CREATE TABLE posts (
    blog TEXT NOT NULL, id TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- original | reblog
    parent_blog TEXT, parent_id TEXT,   -- what it reblogged (uuid, id)
    root_blog TEXT, root_id TEXT,       -- original author's post
    state TEXT,                         -- published | private | draft | queue | gone
    published_at INTEGER,               -- ms; remote timestamp (queued/draft: null)
    tags TEXT NOT NULL DEFAULT '[]',
    notes INTEGER, notes_at INTEGER,
    summary TEXT, thumb TEXT, has_images INTEGER DEFAULT 0, legacy INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
    fingerprint TEXT, payload TEXT,     -- full NPF post as read by the owner
    synced_at INTEGER,
    item_id INTEGER,                    -- content item (group) it belongs to
    PRIMARY KEY (blog, id)
  );
  CREATE INDEX posts_item ON posts(item_id);
  CREATE INDEX posts_parent ON posts(parent_blog, parent_id);
  CREATE INDEX posts_root ON posts(root_blog, root_id);
  CREATE INDEX posts_pub ON posts(blog, published_at);
  CREATE TABLE sync_state (
    blog TEXT NOT NULL, box TEXT NOT NULL,   -- box: posts | draft | queue
    complete INTEGER DEFAULT 0,              -- paged to the end at least once
    cursor TEXT,                             -- next page of an unfinished full pass
    full_started INTEGER, full_done INTEGER, inc_done INTEGER, newest INTEGER, error TEXT,
    PRIMARY KEY (blog, box)
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_blog TEXT, origin_id TEXT,         -- the owned original (null for an external reblog item)
    manager TEXT,                            -- management blog uuid
    external INTEGER NOT NULL DEFAULT 0,     -- 1: a reblog of someone else's post (keyed by that reblog)
    status TEXT NOT NULL DEFAULT 'ok',       -- ok | ambiguous | needs_review
    evidence TEXT, managed TEXT,             -- managed: { categories, picks, extra } chosen for the work
    revision INTEGER DEFAULT 1, updated_at INTEGER,
    UNIQUE (origin_blog, origin_id)
  );
  CREATE TABLE policies (
    blog TEXT NOT NULL, id TEXT NOT NULL,
    display TEXT NOT NULL DEFAULT 'follow_rule',   -- follow_rule | keep_visible | keep_hidden
    auto_hide TEXT,         -- JSON: verified hide this app owns {op, rule, revision, prev, at}
    conflict TEXT,          -- JSON: external change awaiting the user
    updated_at INTEGER,
    PRIMARY KEY (blog, id)
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 5,     -- lower runs first; user actions 1, background 5
    batch_id INTEGER, depends_on INTEGER,
    scope TEXT,                              -- e.g. post:<blog>:<id>; used to supersede stale work
    payload TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_due ON jobs(status, next_at);
  CREATE INDEX jobs_scope ON jobs(scope);
  CREATE TABLE batches (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, plan TEXT, created_at INTEGER);
  CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, level TEXT, kind TEXT, msg TEXT, data TEXT);
  CREATE TABLE capabilities (key TEXT PRIMARY KEY, status TEXT, note TEXT, at INTEGER);
  `,
  // 2: rules, routes, categories
  `
  CREATE TABLE expiry_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,                 -- independent | linked
    blog TEXT NOT NULL,                 -- independent: the physical blog; linked: the management blog
    enabled INTEGER NOT NULL DEFAULT 0, days INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'all', -- all | images
    kinds TEXT NOT NULL DEFAULT '["original","reblog"]', -- independent mode: which instance kinds
    targets TEXT NOT NULL DEFAULT '[]', -- linked mode: owned blogs whose copies are included
    skip_pinned INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER
  );
  CREATE TABLE routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sources TEXT NOT NULL, dest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    since INTEGER, exclude TEXT NOT NULL DEFAULT '[]', delivery TEXT NOT NULL DEFAULT 'published',
    revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER
  );
  CREATE TABLE route_map (
    route_id INTEGER, src_blog TEXT NOT NULL, src_id TEXT NOT NULL, dest_blog TEXT NOT NULL, dest_id TEXT,
    status TEXT NOT NULL,               -- pending | created | unknown | tombstone | skipped
    reason TEXT, at INTEGER,
    PRIMARY KEY (src_blog, src_id, dest_blog)
  );
  CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tag TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0);
  `,
  // 3: writing
  `
  CREATE TABLE drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blog TEXT, doc TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'editing', -- editing | publishing | published | failed
    remote_blog TEXT, remote_id TEXT, published_revision INTEGER, remote_fingerprint TEXT,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE assets (
    id TEXT PRIMARY KEY, draft_id INTEGER, file TEXT NOT NULL, sha256 TEXT, mime TEXT,
    width INTEGER, height INTEGER, size INTEGER, created_at INTEGER
  );
  `,
  // 4: followers
  `
  CREATE TABLE followers (
    blog TEXT NOT NULL, name TEXT NOT NULL, uuid TEXT,
    first_seen INTEGER, last_seen INTEGER, baseline INTEGER DEFAULT 0, gone INTEGER DEFAULT 0,
    PRIMARY KEY (blog, name)
  );
  CREATE TABLE follower_cases (
    uuid TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'new', -- new | clear | review | spam | allowed | dismissed
    evidence TEXT, assessment TEXT, first_seen INTEGER, updated_at INTEGER, revision INTEGER DEFAULT 1
  );
  CREATE TABLE allowlist (uuid TEXT PRIMARY KEY, name TEXT, reason TEXT, at INTEGER);
  CREATE TABLE blocks (
    blog TEXT NOT NULL, target TEXT NOT NULL, target_name TEXT,
    origin TEXT NOT NULL,               -- app | external
    status TEXT NOT NULL,               -- blocked | unblocked | pending | unknown
    at INTEGER, verified_at INTEGER,
    PRIMARY KEY (blog, target)
  );
  `,
  // 5: reblogs are frozen snapshots (docs/REBLOG_POLICY.md). Deliveries are keyed by source + observed content
  // revision + destination; the old one-copy-per-source map is kept aside, its rows carried over as revision 1
  // with an unknown version (nothing is re-sent or rewritten because of the migration).
  `
  CREATE TABLE source_revisions (
    blog TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,          -- content + layout only (posts.contentFingerprint); never tags or state
    since INTEGER,                      -- first observed (revision 1: the post's publication time)
    baseline INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (blog, id, rev)
  );
  CREATE TABLE deliveries (
    route_id INTEGER, src_blog TEXT NOT NULL, src_id TEXT NOT NULL, rev INTEGER NOT NULL, dest_blog TEXT NOT NULL,
    dest_id TEXT,
    status TEXT NOT NULL,               -- pending | created | existing | unknown | conflict | tombstone | skipped | failed | superseded
    reason TEXT, tags TEXT,             -- tags: the ordered tags submitted with this snapshot
    fingerprint TEXT, version_unknown INTEGER NOT NULL DEFAULT 0, job_id INTEGER, at INTEGER,
    PRIMARY KEY (src_blog, src_id, rev, dest_blog)
  );
  CREATE INDEX deliveries_dest ON deliveries(dest_blog, dest_id);
  INSERT INTO deliveries (route_id, src_blog, src_id, rev, dest_blog, dest_id, status, reason, version_unknown, at)
    SELECT route_id, src_blog, src_id, 1, dest_blog, dest_id, CASE status WHEN 'pending' THEN 'superseded' ELSE status END,
      COALESCE(reason, 'recorded before version tracking'), 1, at FROM route_map;
  ALTER TABLE route_map RENAME TO route_map_v1;
  `,
  // 6: general categories in optional groups (design 6.2-6.3). Additive: existing categories keep their id, tag,
  // name and order; group_id NULL is the visible "ungrouped" area.
  `
  CREATE TABLE category_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, name TEXT, ord INTEGER NOT NULL DEFAULT 0);
  ALTER TABLE categories ADD COLUMN group_id INTEGER;
  `,
  // 7: material collection (moved from the extension). One row per original a like stands for.
  `
  CREATE TABLE collected (
    root TEXT PRIMARY KEY,              -- uuid/id of the original
    src_blog TEXT, src_id TEXT, src_name TEXT, reblog_key TEXT, liked_at INTEGER,
    dest TEXT, dest_id TEXT,
    status TEXT NOT NULL,               -- queued | created | skipped | unknown | failed
    reason TEXT, tags TEXT, at INTEGER
  );
  `,
  // 8: browser companion requests (one row per operation id, so a repeated request never makes a second job)
  `
  CREATE TABLE companion_ops (op TEXT PRIMARY KEY, kind TEXT, request TEXT, job_id INTEGER, result TEXT, at INTEGER);
  `,
  // 9: version maintenance (REBLOG_POLICY.md 2.1, R12-R17). Additive: each newly observed revision keeps the body it
  // was seen with, for comparisons (older revisions stay NULL: compared through their copies' trails, or shown as
  // not comparable). Version names and notes are local only: never written to Tumblr, never a new revision.
  `
  ALTER TABLE source_revisions ADD COLUMN snapshot TEXT;
  CREATE TABLE version_notes (
    blog TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL,
    label TEXT, note TEXT, updated_at INTEGER,
    PRIMARY KEY (blog, id, rev)
  );
  `,
  // 10: visitor checks (design public_check): what a logged-out visitor saw after a visibility change, apart from
  // the owner state the edit verified. pending | visible | not_visible_at_check | unknown, with the time and route.
  `
  CREATE TABLE public_checks (
    blog TEXT NOT NULL, id TEXT NOT NULL,
    expect TEXT, state TEXT NOT NULL, checked_at INTEGER, route TEXT, detail TEXT,
    PRIMARY KEY (blog, id)
  );
  `,
  // 11: ads the browser relay's web API mixed into post lists were stored as posts (with an item and a source
  // revision each). Nothing was ever delivered or queued for them; remove the rows. Real posts have object_type
  // 'post' or none (official API).
  `
  CREATE TEMP TABLE ad_rows AS SELECT blog, id, item_id FROM posts
    WHERE json_valid(payload) AND json_extract(payload, '$.object_type') IS NOT NULL AND json_extract(payload, '$.object_type') != 'post';
  DELETE FROM source_revisions WHERE (blog, id) IN (SELECT blog, id FROM ad_rows);
  DELETE FROM posts WHERE (blog, id) IN (SELECT blog, id FROM ad_rows);
  DELETE FROM items WHERE id IN (SELECT item_id FROM ad_rows) AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = items.id);
  DROP TABLE ad_rows;
  `,
  // 12: fans & interactions (docs/FAN_RELATIONSHIP_SPEC.md). Additive. Follower rows learn whether they were
  // inspected (so a uuid known from the list doesn't skip protection) and keep a missing → checked → confirmed
  // path: an old gone = 1 stays "missing, not checked", never a confirmed unfollow. People, reminders and
  // workflow states are local only and never written to Tumblr.
  `
  ALTER TABLE followers ADD COLUMN inspected INTEGER NOT NULL DEFAULT 0;
  UPDATE followers SET inspected = 1 WHERE uuid IS NOT NULL;
  ALTER TABLE followers ADD COLUMN gone_at INTEGER;      -- followed_by confirmed: no longer following
  ALTER TABLE followers ADD COLUMN checked_at INTEGER;   -- last followed_by check of a missing row
  ALTER TABLE followers ADD COLUMN check_note TEXT;
  CREATE TABLE people (
    uuid TEXT PRIMARY KEY, name TEXT, names TEXT NOT NULL DEFAULT '[]',   -- names: earlier names of this uuid
    star INTEGER NOT NULL DEFAULT 0, alias TEXT, labels TEXT NOT NULL DEFAULT '[]', note TEXT,
    mute INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, text TEXT NOT NULL, due INTEGER,
    status TEXT NOT NULL DEFAULT 'open',                 -- open | done | dismissed
    event TEXT, created_at INTEGER, done_at INTEGER
  );
  CREATE TABLE audience_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, blog TEXT NOT NULL, name TEXT, uuid TEXT,
    kind TEXT NOT NULL,                                  -- follow | unfollow | back
    at INTEGER NOT NULL, since INTEGER, note TEXT        -- unfollow: between since (last seen) and at (confirmed)
  );
  CREATE INDEX audience_changes_at ON audience_changes(at);
  CREATE TABLE audience_counts (blog TEXT NOT NULL, at INTEGER NOT NULL, followers INTEGER, PRIMARY KEY (blog, at));
  CREATE TABLE interactions (
    id TEXT PRIMARY KEY,                                 -- Tumblr's notification id
    blog TEXT, type TEXT, kind TEXT NOT NULL,            -- kind: reply | mention | ask | reblog | reblog_plain | like | follow | other
    from_uuid TEXT, from_name TEXT, post_id TEXT, reblog_id TEXT, text TEXT, tags TEXT, summary TEXT,
    at INTEGER, fetched_at INTEGER,
    state TEXT NOT NULL DEFAULT 'new',                   -- new | later | done | skip | old | digest
    state_at INTEGER, later_until INTEGER, replied INTEGER NOT NULL DEFAULT 0, raw TEXT
  );
  CREATE INDEX interactions_at ON interactions(at);
  CREATE INDEX interactions_from ON interactions(from_uuid);
  CREATE INDEX interactions_state ON interactions(state);
  `,
  // 13: functional workflows (docs/FUNCTIONAL_WORKFLOWS_SPEC.md). Additive.
  // Editing a published original reuses the draft row: kind 'edit' names the post it edits (target), the remote
  // body it started from (base: fingerprint, tags, state, read time) and, after a refused submit, Tumblr's newer
  // body (conflict) and the user's own text kept aside when they take Tumblr's (stash). Nothing old changes.
  // Replies sent from the app: one row per operation id (a repeat never sends twice), its target, identity and
  // the exact text, apart from the interaction's own local states; unsent text per interaction; when the user
  // last went to Tumblr from an interaction (a hand-off, never counted as a send).
  `
  ALTER TABLE drafts ADD COLUMN kind TEXT NOT NULL DEFAULT 'new';   -- new | edit
  ALTER TABLE drafts ADD COLUMN target_blog TEXT;
  ALTER TABLE drafts ADD COLUMN target_id TEXT;
  ALTER TABLE drafts ADD COLUMN base TEXT;
  ALTER TABLE drafts ADD COLUMN conflict TEXT;
  ALTER TABLE drafts ADD COLUMN stash TEXT;
  CREATE TABLE reply_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op TEXT NOT NULL UNIQUE,                             -- the page's operation id
    event TEXT,                                          -- interaction id it answers (may be null)
    blog TEXT NOT NULL, post_id TEXT NOT NULL,           -- the post replied under (uuid, id)
    reply_as TEXT NOT NULL,                              -- my blog (uuid) that speaks
    account TEXT,                                        -- account name at the time
    text TEXT NOT NULL, job INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',               -- queued | waiting | sending | checking | unknown | confirmed | failed | not_sent
    reply_id TEXT, error TEXT,
    created_at INTEGER, sent_at INTEGER, confirmed_at INTEGER, updated_at INTEGER
  );
  CREATE INDEX reply_ops_event ON reply_ops(event);
  CREATE TABLE reply_drafts (event TEXT PRIMARY KEY, text TEXT, reply_as TEXT, op TEXT, updated_at INTEGER);
  ALTER TABLE interactions ADD COLUMN handoff_at INTEGER;
  `,
  // 14: optional settings blog (settingsync.js). Each display choice remembers when it was made and where it came
  // from (user: chosen in this app; observed: a change seen on Tumblr; sync: from the settings blog; import: a
  // settings file; NULL: made before this), so choices can be merged by time between computers.
  `
  ALTER TABLE policies ADD COLUMN display_at INTEGER;
  ALTER TABLE policies ADD COLUMN display_src TEXT;
  UPDATE policies SET display_at = updated_at;
  `,
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get();
  let v = row ? row.v : 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.prepare('UPDATE schema_version SET v = ?').run(v + 1);
    });
  }
  return wrap(db);
}

// Nested calls join the outer transaction
function tx(db, fn) {
  if (db._inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db._inTx = true;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  finally { db._inTx = false; }
}

const J = v => (v == null ? null : JSON.stringify(v));
const P = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };

function wrap(db) {
  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const api = {
    raw: db,
    run: (sql, ...a) => st(sql).run(...a),
    get: (sql, ...a) => st(sql).get(...a),
    all: (sql, ...a) => st(sql).all(...a),
    tx: fn => tx(db, fn),
    close: () => db.close(),
    getMeta(key, d = null) { const r = st('SELECT value FROM meta WHERE key = ?').get(key); return r ? P(r.value, d) : d; },
    setMeta(key, v) { st('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, J(v)); },
    log(level, kind, msg, data) {
      st('INSERT INTO activity (at, level, kind, msg, data) VALUES (?, ?, ?, ?, ?)').run(Date.now(), level, kind, msg, J(data));
    },
    capability(key, status, note = '') {
      st('INSERT INTO capabilities (key, status, note, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, note = excluded.note, at = excluded.at')
        .run(key, status, note, Date.now());
    },
    capStatus(key) { return st('SELECT status FROM capabilities WHERE key = ?').get(key)?.status || 'unverified'; },
  };
  return api;
}

module.exports = { openDb, J, P };
