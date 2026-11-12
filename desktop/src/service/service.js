'use strict';
// The desktop service: one store, one job queue, one scheduler. The window, the tray and (later) the browser
// companion only send requests here. Runs in Electron's main process, or in plain Node for tests.

const path = require('node:path');
const { openDb, J, P } = require('./db');
const { makeJobs } = require('./jobs');
const sync = require('./sync');
const groups = require('./groups');
const display = require('./display');
const ops = require('./ops');
const routes = require('./routes');

const PASS_MS = 10 * 60e3;
const SOURCE_FULL_MS = 6 * 3600e3;

function createService({ dataDir, db: givenDb, tumblr, creds = null, now = Date.now, extraHandlers = {}, onEvent = () => {}, diag = null }) {
  const db = givenDb || openDb(path.join(dataDir, 'studio.db'));
  const ctx = { db, tumblr, creds, now, service: null };
  routes.baseline(db, now());
  const emit = (type, data) => { try { onEvent(type, data); } catch {} };

  const hooks = {
    onPost(before, after) {
      const what = display.observe(db, before, after, now());
      if (what) db.log('info', 'display', what, { blog: after.blog, id: after.id });
    },
    onGone(g) { routes.onGone(db, g); },
  };

  const handlers = {
    'sync.blogs': {
      async run(job) {
        const r = await tumblr.blogs();
        sync.upsertBlogs(db, r.blogs, now());
        require('./data').applyPendingRoles(db);
        db.setMeta('account', { name: r.name });
        const { mode = 'inc', priority = 6 } = job.payload;
        // An incremental read only sees recent posts. Edits to older originals are new versions a route must
        // see (REBLOG_POLICY.md §3.2), so source blogs of enabled routes are read whole every SOURCE_FULL_MS.
        const sources = new Set(routes.routesOf(db).filter(x => x.enabled).flatMap(x => x.sources));
        for (const b of r.blogs) {
          const full = mode === 'full' || (sources.has(b.uuid) && (sync.syncState(db, b.uuid, 'posts').full_done || 0) < now() - SOURCE_FULL_MS);
          for (const box of ['', 'draft', 'queue']) jobs.add('sync.blog', { blog: b.uuid, box, mode: full ? 'full' : 'inc' }, { priority, scope: `sync:${b.uuid}:${box}`, supersede: true });
        }
        return { status: 'succeeded', result: { blogs: r.blogs.length } };
      },
    },
    'sync.blog': {
      async run(job) {
        const r = await sync.syncChunk({ db, tumblr, hooks, now }, job.payload, job.result?.next || null);
        const total = { pages: (job.result?.pages || 0) + r.pages, changed: (job.result?.changed || 0) + r.changed, ...(r.next ? { next: r.next } : {}) };
        return r.done ? { status: 'succeeded', result: total } : { status: 'pending', result: total };
      },
    },
    // After the syncs of a pass: regroup, then plan expiry and routes from the fresh picture
    'maintain.after': {
      async run(job) {
        const open = db.get(`SELECT COUNT(*) n FROM jobs WHERE kind IN ('sync.blogs', 'sync.blog') AND status IN ('pending', 'running', 'waiting')`).n;
        if (open) return { status: 'pending', nextAt: now() + 5000 };
        const g = groups.rebuild(db, now());
        const auto = db.getMeta('automation', {});
        const hidden = auto.expiry ? display.queueExpiry(db, jobs, { now: now(), limit: auto.expiryLimit || 40 }) : 0;
        const reblogs = auto.routes ? routes.plan(db, jobs, now()) : 0;
        let inspect = 0, extra = 0;
        for (const f of svc.afterPass || []) { try { extra += f() || 0; } catch (e) { db.log('warn', 'pass', String(e.message || e)); } }
        try { inspect = svc.followerPass?.() || 0; } catch (e) { db.log('warn', 'followers', String(e.message || e)); }
        db.setMeta('lastPass', { at: now(), hidden, reblogs, groups: g, inspect });
        emit('pass', { hidden, reblogs });
        return { status: 'succeeded', result: { hidden, reblogs, groups: g } };
      },
    },
    'post.visibility': ops.visibility,
    'post.tags': ops.tags,
    'post.reblog': routes.reblog,
    ...extraHandlers,
  };

  const jobs = makeJobs(db, {
    handlers, now,
    // routine syncs that succeed are left out of the diagnostic log (every 10 minutes, many blogs)
    trace: diag && ((j, f) => { if (j.kind === 'sync.blog' && ['succeeded', 'pending', 'running'].includes(f.status)) return; diag.job(j, f); }),
    onChange: id => emit('job', id),
    log: (job, out) => {
      const level = ['failed', 'unknown'].includes(out.status) ? 'warn' : 'info';
      if (job.kind === 'sync.blog' && out.status === 'succeeded') return;
      db.log(level, job.kind, out.status + (out.error ? ': ' + out.error : ''), { job: job.id, ...job.payload, phase: undefined });
    },
  });
  ctx.jobs = jobs;

  // One maintenance pass: sync every blog (incremental), then plan. Skipped if one is already queued.
  function pass({ full = false, priority = 6 } = {}) {
    const open = db.get(`SELECT id FROM jobs WHERE kind = 'maintain.after' AND status IN ('pending', 'running', 'waiting')`);
    if (open) return open.id;
    jobs.add('sync.blogs', { mode: full ? 'full' : 'inc', priority }, { priority });
    return jobs.add('maintain.after', {}, { priority: priority + 1 });
  }

  let passTimer = null;
  function start({ intervalMs = PASS_MS } = {}) {
    jobs.start(1000, ctx);
    const loop = () => {
      if (!db.getMeta('paused', false) && creds?.status?.() === 'connected') pass();
      passTimer = setTimeout(loop, intervalMs);
    };
    passTimer = setTimeout(loop, 3000);
  }
  function stop() { jobs.stop(); clearTimeout(passTimer); clearTimeout(soonTimer); }
  // a pass a few seconds after a rule or automation change, instead of at the next 10-minute tick
  let soonTimer = null;
  function passSoon(ms = 5000) {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => { if (!db.getMeta('paused', false) && creds?.status?.() === 'connected') pass(); }, ms);
  }

  const svc = { db, jobs, ctx, handlers, pass, passSoon, start, stop, emit, hooks, diag };
  ctx.service = svc;
  require('./copytags').addCopyTags(svc);
  return svc;
}

module.exports = { createService, PASS_MS };
