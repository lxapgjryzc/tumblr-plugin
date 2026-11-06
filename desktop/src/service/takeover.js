'use strict';
// Taking over the extension's reblog sync (design 4.3, A55). The extension used to reblog new posts of my side
// (sharing) blogs onto the main blog every 10 minutes (`settings.syncReblogs`, from `autoSince` on). Its
// background passes are gone, so when an imported extension had this on, the app offers the matching route
// once — it never switches it on by itself:
//  - the offer shows what would be reblogged right away: side-blog originals since the extension's start that
//    have no copy on the main blog (existing copies are recognised and never sent again);
//  - accepting creates the route (side sharing blogs → main blog), turns route automation on and queues those
//    missed posts through routes.manualReblog (version dedupe, unknown outcomes, exclusions);
//  - declining is remembered.

const fs = require('node:fs');
const path = require('node:path');
const routes = require('./routes');

function addTakeover(svc, api, { dataDir }) {
  const { db, jobs } = svc;
  const now = svc.ctx.now;

  // Was reblog sync on in the newest imported extension data? (meta set on import; older imports: the kept file)
  function fromImports() {
    const dir = path.join(dataDir || '', 'imports');
    try {
      const f = fs.readdirSync(dir).filter(x => /^extension-.*\.json$/.test(x)).sort().pop();
      if (!f) return null;
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).data || {};
      if (!d.settings?.syncReblogs) return null;
      return { since: d.autoSince ? (d.autoSince < 1e11 ? d.autoSince * 1000 : d.autoSince) : null, file: f };
    } catch { return null; }
  }
  function offer() {
    const st = db.getMeta('reblogTakeover', null);
    if (st?.done) return null;
    if (routes.routesOf(db).length) return null; // the user has routes of their own
    return st?.offer || fromImports();
  }
  const plan = () => {
    const main = db.get('SELECT uuid, name FROM blogs WHERE is_primary = 1');
    const sources = db.all(`SELECT uuid, name FROM blogs WHERE role = 'share' AND is_primary = 0`);
    return { main, sources };
  };
  // Side-blog originals since `since` that the main blog doesn't have, as the route would judge them
  function missed(since) {
    const { main, sources } = plan();
    if (!main || !sources.length) return [];
    const route = { id: -1, sources: sources.map(s => s.uuid), dest: main.uuid, enabled: true, since: since || now(), exclude: [] };
    return routes.preview(db, route, { history: true }).filter(r => r.action === 'reblog' && (!since || (r.published_at || 0) >= since));
  }

  Object.assign(api, {
    reblogTakeoverOffer() {
      const o = offer();
      if (!o) return null;
      const { main, sources } = plan();
      return { since: o.since, main, sources, missed: missed(o.since).map(r => ({ blog: r.blog, id: r.id, summary: r.summary, thumb: r.thumb, published_at: r.published_at })) };
    },
    reblogTakeover({ accept, ids = null }) {
      const o = offer();
      if (!o) return { done: true };
      if (!accept) { db.setMeta('reblogTakeover', { done: true, declined: true, at: now() }); return { done: true }; }
      const { main, sources } = plan();
      if (!main || !sources.length) throw new Error('no sharing side blog to reblog from');
      const id = routes.saveRoute(db, jobs, { sources: sources.map(s => s.uuid), dest: main.uuid, enabled: true, exclude: [] }, now());
      db.setMeta('automation', { ...db.getMeta('automation', {}), routes: true });
      let queued = 0;
      for (const r of missed(o.since)) {
        if (ids && !ids.includes(r.id)) continue;
        try { routes.manualReblog(db, jobs, { blog: r.blog, id: r.id, dest: main.uuid }); queued++; } catch { /* already there or on its way */ }
      }
      db.setMeta('reblogTakeover', { done: true, route: id, queued, at: now() });
      db.log('info', 'routes', 'reblog sync taken over from the extension', { route: id, queued });
      return { done: true, route: id, queued };
    },
  });

  // a fresh import records the offer (data.js calls this)
  svc.ctx.onImport = exp => {
    const d = exp?.data || {};
    if (!d.settings?.syncReblogs || db.getMeta('reblogTakeover', null)?.done) return;
    db.setMeta('reblogTakeover', { offer: { since: d.autoSince ? (d.autoSince < 1e11 ? d.autoSince * 1000 : d.autoSince) : null } });
  };
}

module.exports = { addTakeover };
