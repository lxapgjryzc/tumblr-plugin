'use strict';
// Tag upkeep moved from the extension's manager (design 4.3, A55): the weak-tag cleanup, tidying old posts by
// template pack, and the pack review ("Suggest changes"). The rules are the extension's (src/core.js:
// judgeTags, planUpkeep / upkeepTags, suggestTagChanges); this module only feeds them the app's data.
//
// - Only originals on sharing blogs are looked at or edited: a reblog is a frozen snapshot (REBLOG_POLICY.md),
//   and material blogs keep other people's tags.
// - Tags a pack knows are the pack's business, so the cleanup never lists them (it can't remove a tag a
//   template would put back).
// - Scans only read. Every edit is a post.tags job (full post, verified), and the pack-upkeep job recomputes
//   from the post's tags at run time, so a tag changed meanwhile is not overwritten.
// - Tag popularity is sampled through the OAuth API (/v2/tagged, one request per tag, counted against the
//   request budget) and kept 7 days in meta `tagStats`, shared with the composer.

const C = require('./core');

const REASON_ORDER = ['offtopic', 'dead', 'fuzzy', 'cold'];

function addTidy(svc, api, { fetchFn = fetch } = {}) {
  const { db, jobs } = svc;
  const packsRaw = () => db.getMeta('packs', []);
  const parsedPacks = () => packsRaw().flatMap(p => { try { return [C.parsePack(p.raw)]; } catch { return []; } });
  svc.ctx.packs = parsedPacks; // the post.tags job's `upkeep` option reads the packs when it runs

  // core.js wants api(path, { method, body }); reads only here
  const coreApi = path => svc.ctx.tumblr.request(path, {});
  let scan = null; // { kind, aborted, i, n } while a sampling run is going

  async function sample(tags, kind) {
    if (scan) throw Object.assign(new Error('a scan is already running'), { status: 409 });
    const cache = { tagStats: db.getMeta('tagStats', {}) };
    const ctl = scan = { kind, aborted: false, i: 0, n: 0 };
    try {
      const failed = await C.ensureTagStats(coreApi, cache, tags, {
        ctl, fetch: fetchFn,
        save: async () => db.setMeta('tagStats', cache.tagStats),
        onProgress: (i, n) => { ctl.i = i; ctl.n = n; svc.emit('tidy', { kind, i, n }); },
      });
      db.setMeta('tagStats', cache.tagStats);
      return { stats: cache.tagStats, failed, stopped: ctl.aborted };
    } finally { scan = null; }
  }

  // Originals on sharing blogs (the main blog is always one), with their stored tags and notes
  const originals = () => db.all(`SELECT p.blog, p.id, p.tags, p.notes, b.name blog_name FROM posts p JOIN blogs b ON b.uuid = p.blog
    WHERE p.kind = 'original' AND p.legacy = 0 AND p.state IN ('published', 'private', 'queue', 'draft') AND (b.role = 'share' OR b.is_primary = 1)`)
    .map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') }));

  Object.assign(api, {
    // Sample tags for the composer's "Check heat" (only tags without a fresh sample are read)
    async sampleTags({ tags = [] }) { const { failed, stopped } = await sample(tags, 'compose'); return { failed, stopped }; },
        tidyStatus() { return scan ? { running: scan.kind, i: scan.i, n: scan.n } : { running: null }; },
    tidyStop() { if (scan) scan.aborted = true; return true; },

    // ----- weak-tag cleanup -----
    async cleanupScan({ notesOn = false, notesMax = 0 } = {}) {
      const packs = parsedPacks();
      const owned = C.packGrouping(packs).groups;
      const stats = new Map();
      let missingNotes = 0;
      for (const p of originals()) {
        if (p.notes == null) missingNotes++;
        const tags = C.uniqTags(p.tags);
        const have = new Set(tags.map(C.key));
        const fandoms = packs.filter(pk => pk.base.some(tg => have.has(C.key(tg))));
        for (const tag of tags) {
          const k = C.key(tag);
          if (owned.has(k)) continue;
          let s = stats.get(k);
          if (!s) stats.set(k, s = { tag, uses: 0, notes: 0, noted: 0, packs: new Set() });
          s.uses++;
          fandoms.forEach(pk => s.packs.add(pk));
          if (p.notes != null) { s.notes += p.notes; s.noted++; }
        }
      }
      const { stats: site, failed, stopped } = await sample([...stats.values()].map(s => s.tag), 'cleanup');
      const rules = { ...C.TAG_RULES, ...(db.getMeta('settings', {}).rules || {}) };
      const weak = C.judgeTags([...stats.values()].map(s => s.tag), site, rules, {
        fandom: tg => [...(stats.get(C.key(tg))?.packs || [])].flatMap(pk => pk.base),
      });
      const results = [];
      for (const [k, s] of stats) {
        const avg = s.noted ? s.notes / s.noted : null;
        const v = weak.get(k) || (notesOn && avg !== null && avg < notesMax ? { reason: 'notes' } : null);
        if (v) results.push({ key: k, tag: s.tag, uses: s.uses, avg, reason: v.reason, share: v.share ?? null, match: v.match ?? null, rank: v.rank ?? null, of: v.of ?? null,
          followers: site[k]?.followers ?? null, tagNotes: site[k]?.notes ?? null });
      }
      const ord = r => (REASON_ORDER.indexOf(r.reason) + 1 || REASON_ORDER.length + 1);
      results.sort((a, b) => ord(a) - ord(b) || (b.rank ?? 0) - (a.rank ?? 0) || (a.avg ?? Infinity) - (b.avg ?? Infinity));
      return { results, tags: stats.size, failed, stopped, missingNotes };
    },
    // Which originals carry the chosen tags (shown before anything is queued)
    cleanupPreview({ tags = [] }) {
      const ks = new Set(tags.map(C.key));
      const posts = originals().filter(p => p.tags.some(tg => ks.has(C.key(tg))));
      return { posts: posts.length, examples: posts.slice(0, 5).map(p => ({ blog: p.blog, blogName: p.blog_name, id: p.id })) };
    },
    cleanupApply({ tags = [] }) {
      const ks = new Set(tags.map(C.key));
      const targets = originals().filter(p => p.tags.some(tg => ks.has(C.key(tg)))).map(p => ({ blog: p.blog, id: p.id }));
      if (!targets.length) return { queued: 0 };
      const batch = jobs.batch('Remove weak tags', { tags, targets: targets.length });
      for (const p of targets) jobs.add('post.tags', { blog: p.blog, id: String(p.id), remove: tags }, { priority: 1, scope: `post:${p.blog}:${p.id}`, batch });
      return { queued: targets.length };
    },

    // ----- tidy old posts by pack (retired spellings, missing search spellings) -----
    upkeepScan() {
      const packs = parsedPacks();
      if (!packs.length) return { rules: [], posts: 0, noPacks: true };
      const recs = originals().map(p => ({ key: p.blog + ':' + p.id, blog: p.blog, id: p.id, tags: p.tags, blogName: p.blog_name }));
      const plan = C.planUpkeep(recs, packs);
      return {
        posts: plan.posts.length,
        rules: plan.rules.map(r => ({ ...r, examples: plan.posts.filter(p => p.changes.some(c => c.rule === r.rule)).slice(0, 3).map(p => ({ blog: p.blog, blogName: p.blogName, id: p.id })) })),
      };
    },
    upkeepApply({ rules = [] }) {
      const allow = new Set(rules);
      const packs = parsedPacks();
      const recs = originals().map(p => ({ key: p.blog + ':' + p.id, blog: p.blog, id: p.id, tags: p.tags }));
      const posts = C.planUpkeep(recs, packs).posts.filter(p => p.changes.some(c => allow.has(c.rule)));
      if (!posts.length) return { queued: 0 };
      const batch = jobs.batch('Tidy tags by packs', { rules: [...allow], targets: posts.length });
      for (const p of posts) jobs.add('post.tags', { blog: p.blog, id: String(p.id), upkeep: [...allow] }, { priority: 1, scope: `post:${p.blog}:${p.id}`, batch });
      return { queued: posts.length };
    },

    // ----- a category's tag changed: optionally bring old originals along (design 6.3; never automatic) -----
    retagPreview({ from, to }) {
      const fk = C.key(C.norm(from || ''));
      if (!fk || fk === C.key(C.norm(to || ''))) return { posts: 0, examples: [] };
      const posts = originals().filter(p => p.tags.some(tg => C.key(tg) === fk));
      return { posts: posts.length, examples: posts.slice(0, 5).map(p => ({ blog: p.blog, blogName: p.blog_name, id: p.id })) };
    },
    retagApply({ from, to }) {
      from = C.norm(from || '').trim(); to = C.norm(to || '').trim();
      const fk = C.key(from);
      if (!fk || !to || fk === C.key(to)) return { queued: 0 };
      const posts = originals().filter(p => p.tags.some(tg => C.key(tg) === fk));
      if (!posts.length) return { queued: 0 };
      const batch = jobs.batch('Retag after a category change', { from, to, targets: posts.length });
      for (const p of posts) jobs.add('post.tags', { blog: p.blog, id: String(p.id), replace: { from, to } }, { priority: 1, scope: `post:${p.blog}:${p.id}`, batch });
      return { queued: posts.length };
    },

    // ----- pack review: suggestions for one pack's character and relation tags -----
    async packReview({ id }) {
      const pk = parsedPacks().find(p => p.id === id);
      if (!pk) throw Object.assign(new Error('no such pack'), { status: 404 });
      const rules = { ...C.TAG_RULES, ...(db.getMeta('settings', {}).rules || {}) };
      let { stats, failed, stopped } = await sample(C.packTags(pk), 'review');
      const targets = [...pk.items.values()].filter(it => (it.kind === 'char' || it.rel) && it.tags.length);
      const items = targets.map(it => ({ it, ...C.suggestTagChanges(it.tags, stats, { exclude: pk.base, fandom: pk.base, rules }) }));
      const candidates = [...new Set(items.flatMap(x => x.add.map(a => a.tag)))];
      if (!stopped && candidates.length) {
        const more = await sample(candidates, 'review');
        stats = more.stats; failed += more.failed; stopped = more.stopped;
      }
      const out = [];
      for (const x of items) {
        const add = x.add.map(a => ({ ...a, fit: C.fandomShare(a.tag, stats[C.key(a.tag)], pk.base) }))
          .filter(a => a.fit === null || a.fit >= C.OFFTOPIC_SHARE).map(a => ({ ...a, on: false }));
        // every item keeps at least one tag: a remove that would empty it is listed but never ticked by default
        const remove = x.remove.map(r => ({ ...r, on: r.reason === 'offtopic' }));
        if (add.length || remove.length) out.push({ id: x.it.id, name: x.it.name, tags: x.it.tags, add, remove });
      }
      return { pack: id, name: pk.name, items: out, failed, stopped };
    },
    // Ticked changes are written into the installed pack, which is then marked as edited
    packReviewApply({ pack, items = [] }) {
      const list = packsRaw();
      const entry = list.find(p => { try { return C.parsePack(p.raw).id === pack; } catch { return false; } });
      if (!entry) throw Object.assign(new Error('no such pack'), { status: 404 });
      const raw = JSON.parse(JSON.stringify(typeof entry.raw === 'string' ? JSON.parse(entry.raw) : entry.raw));
      const all = [...(raw.characters || []), ...(Array.isArray(raw.relations) ? raw.relations : []), ...(raw.sections || []).flatMap(s => s.items || [])];
      let n = 0;
      const kept1 = [];
      for (const it of items) {
        const target = all.find(x => x.id === it.id);
        if (!target) continue;
        const before = target.tags || [];
        const drop = new Set((it.remove || []).map(C.key));
        let kept = before.filter(tg => !drop.has(C.key(tg)));
        const add = it.add || [];
        // never leave a character or relation without a tag (pack upkeep rule): keep its first spelling
        if (!kept.length && !add.length && before.length) { kept = [before[0]]; kept1.push(it.id); }
        target.tags = C.withTags(kept, add);
        n += (before.length - kept.length) + (target.tags.length - kept.length);
      }
      if (!n) return { changed: 0, keptOne: kept1 };
      C.parsePack(raw); // still a valid pack
      entry.raw = raw;
      entry.edited = true;
      db.setMeta('packs', list);
      return { changed: n, keptOne: kept1 };
    },
    packJson({ id }) {
      const entry = packsRaw().find(p => { try { return C.parsePack(p.raw).id === id; } catch { return false; } });
      return entry ? JSON.stringify(typeof entry.raw === 'string' ? JSON.parse(entry.raw) : entry.raw, null, 2) : null;
    },
  });
}

module.exports = { addTidy };
