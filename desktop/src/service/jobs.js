'use strict';
// The one durable mutation queue. Every remote write is a job persisted before its first request; the runner
// works one job at a time (user actions first, then background work) and records a result for each.
//
// Statuses: pending → running → succeeded | unchanged | skipped | failed | cancelled
//           running → verifying (polls later) | waiting (network / auth / rate limit) | unknown (a create may have landed)
// A handler is { run(job, ctx), reconcile?(job, ctx), creates?: bool }. run returns
// { status, result?, nextAt?, payload? }; throwing a typed error decides the next status (see errors.js).

const { J, P } = require('./db');
const { AuthError, NetError, RateError, HttpError, UnsupportedError, StaleError, WaitError } = require('./errors');

const DUE = ['pending', 'waiting', 'verifying'];
const FINAL = ['succeeded', 'unchanged', 'skipped', 'failed', 'cancelled'];
const OK = ['succeeded', 'unchanged'];

function makeJobs(db, { handlers = {}, now = Date.now, onChange = () => {}, log = () => {}, trace = null } = {}) {
  let timer = null, busy = false, stopped = true;

  const rowOut = r => r && { ...r, payload: P(r.payload, {}), result: P(r.result) };
  const get = id => rowOut(db.get('SELECT * FROM jobs WHERE id = ?', id));
  const set = (id, fields) => {
    const keys = Object.keys(fields);
    const vals = keys.map(k => (['payload', 'result'].includes(k) ? J(fields[k]) : fields[k]));
    db.run(`UPDATE jobs SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...vals, now(), id);
    if (trace && fields.status) { try { trace(get(id), fields); } catch {} }
    onChange(id);
  };

  // A newer job for the same scope replaces unsent older ones (e.g. Keep visible over a queued expiry hide)
  function add(kind, payload = {}, { priority = 5, scope = null, batch = null, dependsOn = null, supersede = false, at = 0 } = {}) {
    return db.tx(() => {
      if (supersede && scope) {
        for (const old of db.all(`SELECT id FROM jobs WHERE scope = ? AND status IN ('pending', 'waiting')`, scope)) {
          db.run(`UPDATE jobs SET status = 'cancelled', error = 'superseded', updated_at = ? WHERE id = ?`, now(), old.id);
        }
      }
      const t = now();
      const r = db.run(`INSERT INTO jobs (kind, status, priority, batch_id, depends_on, scope, payload, next_at, created_at, updated_at)
        VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`, kind, priority, batch, dependsOn, scope, J(payload), at, t, t);
      const id = Number(r.lastInsertRowid);
      if (trace) { try { trace(get(id), { status: 'pending' }); } catch {} }
      onChange(id);
      return id;
    });
  }

  function cancel(id, reason = 'cancelled by user') {
    const j = get(id);
    // an unknown create may have landed: only finding it or resolve() (after you checked) ends it
    if (!j || !['pending', 'waiting'].includes(j.status)) return false;
    set(id, { status: 'cancelled', error: reason });
    return true;
  }
  // Cancel every unsent job matching a scope prefix, e.g. when a rule revision changes
  function cancelScope(prefix, reason, kinds = null) {
    let n = 0;
    for (const j of db.all(`SELECT id, kind FROM jobs WHERE scope LIKE ? AND status IN ('pending', 'waiting')`, prefix + '%')) {
      if (kinds && !kinds.includes(j.kind)) continue;
      set(j.id, { status: 'cancelled', error: reason }); n++;
    }
    return n;
  }

  // After a crash: a job that was running didn't finish. An edit is re-derived from fresh state, so it can run
  // again; a create may have landed, so it must be reconciled first.
  function recover() {
    for (const j of db.all(`SELECT id, kind FROM jobs WHERE status = 'running'`)) {
      const h = handlers[j.kind];
      set(j.id, h?.creates ? { status: 'unknown', error: 'interrupted while sending' } : { status: 'pending', next_at: 0 });
    }
  }

  function nextDue() {
    const rows = db.all(`SELECT * FROM jobs WHERE (status IN ('pending', 'waiting', 'verifying') OR (status = 'unknown')) AND next_at <= ?
      ORDER BY priority, id LIMIT 50`, now());
    for (const r of rows) {
      if (r.status === 'unknown' && !handlers[r.kind]?.reconcile) continue;
      if (r.depends_on) {
        const d = db.get('SELECT status FROM jobs WHERE id = ?', r.depends_on);
        if (!d || ['failed', 'cancelled', 'skipped'].includes(d.status)) {
          set(r.id, { status: 'cancelled', error: 'an earlier step did not complete' });
          continue;
        }
        if (!OK.includes(d.status)) continue;
      }
      return rowOut(r);
    }
    return null;
  }

  async function runOne(job, ctx = {}) {
    const h = handlers[job.kind];
    if (!h) { set(job.id, { status: 'failed', error: 'no handler for ' + job.kind }); return; }
    const reconciling = job.status === 'unknown';
    set(job.id, { status: 'running', attempts: job.attempts + 1 });
    try {
      const out = reconciling ? await h.reconcile(job, ctx) : await h.run(job, ctx);
      const fields = { status: out.status, error: out.error ?? null };
      if (out.result !== undefined) fields.result = out.result;
      if (out.payload !== undefined) fields.payload = out.payload;
      fields.next_at = out.nextAt ?? (out.status === 'unknown' ? now() + 60_000 : 0);
      set(job.id, fields);
      if (FINAL.includes(out.status) || out.status === 'unknown') log(job, out);
    } catch (e) {
      const fields = classify(e, job, h, reconciling);
      // a handler may freeze what it was about to send (e.payload), so a reconcile or retry uses exactly that
      if (e && e.payload !== undefined) fields.payload = e.payload;
      set(job.id, fields);
      log(job, { status: fields.status, error: fields.error });
    }
  }

  function classify(e, job, h, reconciling) {
    const msg = String(e?.message || e).slice(0, 500);
    // A create being reconciled may already exist: whatever stopped the lookup (rate limit, signed out, a
    // server error), it stays unknown and is looked up again later. Only reconcile or "It wasn't created" ends it.
    if (h.creates && reconciling) {
      const wait = e instanceof RateError ? (e.retryAt || now() + 60_000) : e instanceof AuthError ? now() + 10 * 60_000
        : now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(job.attempts, 5));
      return { status: 'unknown', error: 'outcome unknown (lookup failed: ' + msg + ')', next_at: wait };
    }
    if (e instanceof AuthError) return { status: 'waiting', error: 'auth: ' + msg, next_at: now() + 10 * 60_000 };
    // nothing was sent: wait for the browser (woken when it connects), never another channel
    if (e instanceof WaitError) return { status: 'waiting', error: 'browser: ' + msg, next_at: e.retryAt || now() + 5 * 60_000 };
    if (e instanceof RateError) return { status: 'waiting', error: 'rate: ' + msg, next_at: e.retryAt || now() + 60_000 };
    if (e instanceof NetError) {
      if (h.creates && (e.uncertain || reconciling)) return { status: 'unknown', error: 'outcome unknown: ' + msg, next_at: now() + 60_000 };
      return { status: 'waiting', error: 'network: ' + msg, next_at: now() + Math.min(30 * 60_000, 15_000 * 2 ** Math.min(job.attempts, 7)) };
    }
    if (e instanceof StaleError) return { status: 'cancelled', error: 'stale: ' + msg };
    if (e instanceof UnsupportedError) return { status: 'skipped', error: msg };
    if (e instanceof HttpError) return { status: 'failed', error: msg };
    return { status: 'failed', error: msg };
  }

  async function tick(ctx) {
    if (busy) return false;
    busy = true;
    try {
      const j = nextDue();
      if (!j) return false;
      await runOne(j, ctx);
      return true;
    } finally { busy = false; }
  }
  // Drain everything due now (tests, and the runner loop)
  async function drain(ctx, max = 1000) { let n = 0; while (n < max && await tick(ctx)) n++; return n; }

  function start(intervalMs = 1500, ctx) {
    if (!stopped) return;
    stopped = false;
    recover();
    const loop = async () => {
      if (stopped) return;
      try { if (!db.getMeta('paused', false)) await drain(ctx, 20); } catch (e) { console.error('job loop', e); }
      timer = setTimeout(loop, intervalMs);
    };
    loop();
  }
  function stop() { stopped = true; clearTimeout(timer); }
  // Something the waiting jobs depend on came back (reconnected, online again)
  function wake(errPrefix = '') {
    db.run(`UPDATE jobs SET next_at = 0 WHERE status = 'waiting' AND (? = '' OR error LIKE ?)`, errPrefix, errPrefix + '%');
  }

  function list({ status, batch, limit = 200 } = {}) {
    let sql = 'SELECT * FROM jobs WHERE 1 = 1';
    const a = [];
    if (status === 'open') sql += ` AND status NOT IN ('succeeded', 'unchanged', 'skipped', 'cancelled')`;
    else if (status) { sql += ' AND status = ?'; a.push(status); }
    if (batch) { sql += ' AND batch_id = ?'; a.push(batch); }
    sql += ' ORDER BY id DESC LIMIT ?'; a.push(limit);
    return db.all(sql, ...a).map(rowOut);
  }
  function counts() {
    const out = {};
    for (const r of db.all('SELECT status, COUNT(*) n FROM jobs GROUP BY status')) out[r.status] = r.n;
    return out;
  }
  function batch(title, plan) {
    const r = db.run('INSERT INTO batches (title, plan, created_at) VALUES (?, ?, ?)', title, J(plan), now());
    return Number(r.lastInsertRowid);
  }
  // An unknown create you checked on Tumblr and didn't find: mark it failed (so Retry or publishing again is
  // allowed) and let the handler release what it holds. checkNow just looks again right away.
  function resolve(id, ctx = {}) {
    const j = get(id);
    if (!j || j.status !== 'unknown') return false;
    set(id, { status: 'failed', error: 'you checked: it was not created' });
    handlers[j.kind]?.abandon?.(j, ctx);
    return true;
  }
  function checkNow(id) {
    const j = get(id);
    if (!j || j.status !== 'unknown') return false;
    set(id, { next_at: 0 });
    return true;
  }
  // Put a failed or unknown-resolved job back in the queue (an explicit user action)
  function retry(id) {
    const j = get(id);
    if (!j || !['failed', 'waiting'].includes(j.status)) return false;
    set(id, { status: 'pending', error: null, next_at: 0 });
    return true;
  }

  return { add, get, cancel, cancelScope, recover, tick, drain, start, stop, wake, list, counts, batch, retry, resolve, checkNow, DUE, FINAL, OK };
}

module.exports = { makeJobs, FINAL, OK };
