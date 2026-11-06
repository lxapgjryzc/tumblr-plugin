'use strict';
// Owned posts as stored locally: one row per physical post (display instance) with its own remote payload.
// A reblog keeps its own copy of what it reblogged; nothing here ever replaces it with the original's body.

const crypto = require('node:crypto');
const { J, P } = require('./db');

const str = v => (v == null || v === '' ? null : String(v));

// Remote NPF post -> row fields
function normalise(p, blogUuid) {
  const trail = p.trail || [];
  const parentId = str(p.parent_post_id ?? p.parentPostId);
  const parentBlog = str(p.parent_tumblelog_uuid ?? p.parentTumblelogUuid);
  const isReblog = !!(parentId || trail.length);
  const root = trail[0] || null;
  const images = [...(p.content || []), ...trail.flatMap(t => t.content || [])].filter(b => b.type === 'image' && b.media?.length);
  const near = (media, w) => media.reduce((a, b) => (Math.abs((b.width || 0) - w) < Math.abs((a.width || 0) - w) ? b : a)).url;
  const text = [...(p.content || []), ...trail.flatMap(t => t.content || [])].filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
  const body = { content: p.content || [], layout: p.layout || [], trail: trail.map(t => [t.blog?.uuid || t.broken_blog_name || null, str(t.post?.id)]) };
  return {
    blog: blogUuid || p.blog?.uuid,
    id: str(p.id_string ?? p.id),
    kind: isReblog ? 'reblog' : 'original',
    parent_blog: parentBlog || (trail.length ? trail[trail.length - 1].blog?.uuid || null : null),
    parent_id: parentId || (trail.length ? str(trail[trail.length - 1].post?.id) : null),
    root_blog: root ? root.blog?.uuid || null : null,
    root_id: root ? str(root.post?.id) : null,
    state: p.state === 'submission' ? 'draft' : p.state || 'published',
    published_at: ['published', 'private'].includes(p.state || 'published') && p.timestamp ? Number(p.timestamp) * 1000 : null,
    tags: (p.tags || []).slice(),
    notes: p.note_count ?? null,
    summary: text.slice(0, 200) || null,
    thumb: images.length ? near(images[0].media, 540) ?? null : null,
    has_images: images.length ? 1 : 0,
    legacy: (p.should_open_in_legacy ?? p.shouldOpenInLegacy) ? 1 : 0,
    pinned: (p.is_pinned ?? p.isPinned) ? 1 : 0,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32),
  };
}

// Content identity of a post body for version tracking (REBLOG_POLICY.md): content blocks and layout only, never
// tags, state, notes or timestamps. Image media lists are reduced to the image's own path key (Tumblr serves the
// same picture under several sizes and hosts) and presentation-only fields are dropped, so a re-read or a
// tags-only edit can't look like a new version.
const VOLATILE = new Set(['colors', 'feedback_token', 'feedbackToken', 'has_original_dimensions', 'hasOriginalDimensions', 'cropped', 'exif', 'blurhash']);
const mediaKey = m => { const u = m?.url || m?.identifier || ''; try { return new URL(u).pathname.split('/').filter(Boolean)[0] || u; } catch { return u; } };
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (VOLATILE.has(k)) continue;
    out[k] = k === 'media' && Array.isArray(v[k]) ? (v[k].length ? [mediaKey(v[k][0])] : []) : k === 'poster' && Array.isArray(v[k]) ? [] : canon(v[k]);
  }
  return out;
}
const contentFingerprint = (content = [], layout = []) =>
  crypto.createHash('sha256').update(JSON.stringify([canon(content || []), canon((layout || []).filter(l => l.type !== 'ask'))])).digest('hex').slice(0, 32);
// The body a reblog carries of one post in its trail (the snapshot of that post at reblog time)
function trailFingerprint(p, srcId) {
  const t = [...(p?.trail || [])].reverse().find(x => String(x.post?.id ?? '') === String(srcId));
  return t ? contentFingerprint(t.content, t.layout) : null;
}

// Every distinct body an owned original has been seen with, numbered in observation order: A → B → A is three
// revisions. Revision 1 counts from publication (edits before tracking started are unknown and not invented).
function observeRevision(db, n, p, now) {
  if (n.kind !== 'original' || !['published', 'private'].includes(n.state)) return null;
  const fp = contentFingerprint(p.content, p.layout);
  const last = db.get('SELECT rev, fingerprint FROM source_revisions WHERE blog = ? AND id = ? ORDER BY rev DESC LIMIT 1', n.blog, n.id);
  if (last && last.fingerprint === fp) return last.rev;
  const rev = last ? last.rev + 1 : 1;
  db.run('INSERT INTO source_revisions (blog, id, rev, fingerprint, since, baseline, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)',
    n.blog, n.id, rev, fp, last ? now : (n.published_at || now), last ? 0 : 1, JSON.stringify({ content: p.content || [], layout: p.layout || [] }));
  return rev;
}
const latestRevision = (db, blog, id) => db.get('SELECT * FROM source_revisions WHERE blog = ? AND id = ? ORDER BY rev DESC LIMIT 1', blog, String(id));

// Insert or update a post read from Tumblr. Returns { before, after } rows (before = null if new).
function upsertPost(db, p, blogUuid, now = Date.now()) {
  const n = normalise(p, blogUuid);
  if (!n.blog || !n.id) return null;
  const before = getPost(db, n.blog, n.id);
  db.run(`INSERT INTO posts (blog, id, kind, parent_blog, parent_id, root_blog, root_id, state, published_at, tags, notes, notes_at,
      summary, thumb, has_images, legacy, pinned, fingerprint, payload, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(blog, id) DO UPDATE SET kind = excluded.kind, parent_blog = excluded.parent_blog, parent_id = excluded.parent_id,
      root_blog = excluded.root_blog, root_id = excluded.root_id, state = excluded.state,
      published_at = COALESCE(excluded.published_at, posts.published_at), tags = excluded.tags,
      notes = COALESCE(excluded.notes, posts.notes), notes_at = CASE WHEN excluded.notes IS NULL THEN posts.notes_at ELSE excluded.notes_at END,
      summary = excluded.summary, thumb = excluded.thumb, has_images = excluded.has_images, legacy = excluded.legacy, pinned = excluded.pinned,
      fingerprint = excluded.fingerprint, payload = excluded.payload, synced_at = excluded.synced_at`,
  n.blog, n.id, n.kind, n.parent_blog, n.parent_id, n.root_blog, n.root_id, n.state, n.published_at, J(n.tags), n.notes,
  n.notes == null ? null : now, n.summary, n.thumb, n.has_images, n.legacy, n.pinned, n.fingerprint, J(p), now);
  observeRevision(db, n, p, now);
  return { before, after: getPost(db, n.blog, n.id) };
}

function rowOut(r) {
  if (!r) return null;
  return { ...r, tags: P(r.tags, []) };
}
const getPost = (db, blog, id) => rowOut(db.get('SELECT * FROM posts WHERE blog = ? AND id = ?', blog, String(id)));
const payloadOf = (db, blog, id) => P(db.get('SELECT payload FROM posts WHERE blog = ? AND id = ?', blog, String(id))?.payload);

// Full edit body for PUT from a fresh remote post (Tumblr refuses partial PUTs). Only `changes` differ.
// Fields the OAuth payload doesn't carry can't be sent back; see capability edit.labels.
function editBody(p, changes = {}) {
  const out = {
    content: p.content || [],
    layout: p.layout || [],
    tags: (p.tags || []).join(','),
    state: p.state,
  };
  const keep = [['date', 'date'], ['slug', 'slug'], ['interactability_reblog', 'interactabilityReblog'],
    ['interactability_blaze', 'interactabilityBlaze'], ['hide_trail', 'hideTrail'], ['can_be_tipped', 'canBeTipped'],
    ['parent_tumblelog_uuid', 'parentTumblelogUuid'], ['parent_post_id', 'parentPostId'], ['reblog_key', 'reblogKey'],
    ['has_community_label', 'hasCommunityLabel'], ['community_label_categories', 'communityLabelCategories']];
  for (const [snake, camel] of keep) {
    const v = p[snake] ?? p[camel];
    if (v !== undefined && v !== null) out[snake] = v;
  }
  if (p.state === 'queue' && (p.publish_on || p.scheduled_publish_time)) out.publish_on = p.publish_on;
  if (Array.isArray(changes.tags)) changes = { ...changes, tags: changes.tags.join(',') };
  return { ...out, ...changes };
}

module.exports = { normalise, upsertPost, getPost, payloadOf, editBody, rowOut, contentFingerprint, trailFingerprint, observeRevision, latestRevision };
