'use strict';
// Sponsored posts (Blaze ads) that got into the local post list. The web API mixes them into a blog's own post
// list as object_type 'post' of another blog; before 2026-11-14 the app stored them as the synced blog's
// originals, so they showed as works, got revisions and expiry/route jobs (no ad was ever reblogged or edited:
// those writes were skipped or refused). The filters now keep them out (core isSponsored, tumblr.postsPage,
// posts.upsertPost); this removes what is already stored. Local only: nothing is sent to Tumblr.

const C = require('./core');
const { P } = require('./db');

const OPEN = ['pending', 'waiting', 'verifying'];

function removeAds(db, { now = Date.now(), log = () => {} } = {}) {
  const rows = db.all(`SELECT blog, id, item_id, payload FROM posts WHERE payload LIKE '%sponsored%' OR payload LIKE '%"adm":%'`)
    .filter(r => C.isSponsored(P(r.payload, {})));
  if (!rows.length) return { removed: 0 };
  let cancelled = 0, kept = 0;
  db.tx(() => {
    for (const r of rows) {
      // a delivery that was really created is a post of mine on Tumblr: keep its record (none is expected)
      const created = db.get(`SELECT 1 FROM deliveries WHERE src_blog = ? AND src_id = ? AND status IN ('created', 'existing', 'tombstone')`, r.blog, r.id);
      if (created) { kept++; continue; }
      db.run('DELETE FROM posts WHERE blog = ? AND id = ?', r.blog, r.id);
      db.run('DELETE FROM source_revisions WHERE blog = ? AND id = ?', r.blog, r.id);
      db.run('DELETE FROM deliveries WHERE src_blog = ? AND src_id = ?', r.blog, r.id);
      db.run('DELETE FROM route_map_v1 WHERE src_blog = ? AND src_id = ? AND dest_id IS NULL', r.blog, r.id);
      db.run('DELETE FROM policies WHERE blog = ? AND id = ?', r.blog, r.id);
      db.run('DELETE FROM version_notes WHERE blog = ? AND id = ?', r.blog, r.id);
      db.run('DELETE FROM public_checks WHERE blog = ? AND id = ?', r.blog, r.id);
      if (r.item_id != null && !db.get('SELECT 1 FROM posts WHERE item_id = ?', r.item_id)) db.run('DELETE FROM items WHERE id = ?', r.item_id);
      // jobs still waiting to act on it (expiry hides, route reblogs, tag copies…)
      for (const j of db.all(`SELECT id, payload FROM jobs WHERE status IN (${OPEN.map(() => '?').join(',')}) AND payload LIKE ?`, ...OPEN, `%${r.id}%`)) {
        const p = P(j.payload, {});
        if (String(p.id ?? '') !== r.id || (p.blog && p.blog !== r.blog)) continue;
        db.run(`UPDATE jobs SET status = 'cancelled', error = 'not a post: a sponsored post (ad) from the web post list', updated_at = ? WHERE id = ?`, now, j.id);
        cancelled++;
      }
    }
  });
  const removed = rows.length - kept;
  log({ removed, cancelled, kept, blogs: [...new Set(rows.map(r => r.blog))] });
  return { removed, cancelled, kept };
}

module.exports = { removeAds };
