'use strict';
// Diagnostic log: what happened, in order, so a problem met in daily use can be looked at afterwards.
// One JSON line per event in <dataDir>/logs/diag-YYYY-MM-DD.log (local time), kept DAYS days, at most
// MAX_DAY bytes a day (then one "log full" line and nothing more that day).
//
// Recorded: page actions (method, short arguments, ok / error, duration), Tumblr requests (method, path,
// status, browser or official, duration), job state changes, activity entries, errors in the page, the
// backend's own start / stop / crashes, and notes the user writes ("this just went wrong").
// Never recorded: tokens, keys, cookies, sign-in codes, pairing grants, image bytes. Long text is cut short.
//
// export() writes one file to hand over: versions and environment, capabilities, open and recent failed
// jobs, recent activity and the last days of this log.

const fs = require('node:fs');
const path = require('node:path');

const DAYS = 14;
const MAX_DAY = 25 * 1024 * 1024;
const SECRET = /token|secret|password|passwd|cookie|authorization|^code$|grant|api_?key|aikey|^key$|bearer|csrf|refresh/i;
// page calls that run all the time and say nothing about what the user did
const QUIET = new Set(['status', 'fansConfig', 'relayStats', 'serverInfo', 'clientLog', 'activity', 'jobs']);

// A short, secret-free copy of a value for the log
function brief(v, depth = 0, key = '') {
  if (key && SECRET.test(key)) return v == null ? v : '[redacted]';
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + `…(+${v.length - 300})` : v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `[bytes ${v.length}]`;
  if (typeof v === 'function') return '[fn]';
  if (depth >= 4) return Array.isArray(v) ? `[array ${v.length}]` : '[object]';
  if (Array.isArray(v)) {
    const out = v.slice(0, 20).map(x => brief(x, depth + 1));
    if (v.length > 20) out.push(`…(+${v.length - 20})`);
    return out;
  }
  const out = {};
  const keys = Object.keys(v);
  for (const k of keys.slice(0, 40)) out[k] = brief(v[k], depth + 1, k);
  if (keys.length > 40) out['…'] = `+${keys.length - 40} keys`;
  return out;
}
const errOf = e => (e ? String(e.stack || e.message || e).split('\n').slice(0, 6).join(' | ').slice(0, 1200) : null);

function makeDiag(dataDir, { now = Date.now } = {}) {
  const dir = path.join(dataDir, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const day = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fileOf = t => path.join(dir, `diag-${day(t)}.log`);
  let size = { day: null, n: 0, full: false };

  function prune() {
    try {
      const keep = now() - DAYS * 86400e3;
      for (const f of fs.readdirSync(dir)) {
        const m = /^diag-(\d{4})-(\d\d)-(\d\d)\.log$/.exec(f);
        if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < keep) fs.rmSync(path.join(dir, f), { force: true });
        if (/^diagnostics-.*\.txt$/.test(f) && fs.statSync(path.join(dir, f)).mtimeMs < keep) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {}
  }
  prune();

  function write(kind, data = {}) {
    const t = now();
    const d = day(t);
    if (size.day !== d) {
      size = { day: d, n: 0, full: false };
      try { size.n = fs.statSync(fileOf(t)).size; } catch {}
      prune();
    }
    if (size.full) return;
    let line;
    try { line = JSON.stringify({ t: new Date(t).toISOString(), kind, ...brief(data) }) + '\n'; }
    catch (e) { line = JSON.stringify({ t: new Date(t).toISOString(), kind, unloggable: String(e.message) }) + '\n'; }
    if (size.n + line.length > MAX_DAY) { size.full = true; line = JSON.stringify({ t: new Date(t).toISOString(), kind: 'log.full', note: 'daily limit reached; nothing more is written today' }) + '\n'; }
    size.n += line.length;
    try { fs.appendFileSync(fileOf(t), line); } catch {}
  }

  const api = {
    dir,
    write,
    // a page action and its outcome
    call(method, args, { ok, error, ms }) {
      if (ok && QUIET.has(method)) return;
      write(ok ? 'call' : 'call.error', { method, ms, args: brief(args), ...(ok ? {} : { error: String(error).slice(0, 800) }) });
    },
    request(r) { write(r.status >= 400 || !r.status ? 'tumblr.error' : 'tumblr', r); },
    job(j, fields) { write('job', { id: j.id, job: j.kind, status: fields.status, error: fields.error ?? undefined, attempts: j.attempts, target: target(j.payload) }); },
    error(where, e, extra = {}) { write('error', { where, error: errOf(e), ...extra }); },
    // the files of the last `days` days, oldest first
    recent(days = 3) {
      const out = [];
      for (let i = days - 1; i >= 0; i--) { const f = fileOf(now() - i * 86400e3); try { out.push([path.basename(f), fs.readFileSync(f, 'utf8')]); } catch {} }
      return out;
    },
  };
  return api;
}

// What a job is about, without its content
function target(p = {}) {
  const pick = ['blog', 'id', 'draft', 'op', 'event', 'dest', 'src_blog', 'src_id', 'reason', 'target', 'mode', 'box', 'phase', 'verifyN', 'rule', 'postId', 'replyAs'];
  const out = {};
  for (const k of pick) if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  return out;
}

// The one file to hand over when something went wrong
function exportBundle(diag, { db, info = {}, days = 3, note = '' } = {}) {
  const t = new Date();
  const stamp = t.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(diag.dir, `diagnostics-${stamp}.txt`);
  const J = v => JSON.stringify(brief(v), null, 1);
  const P = s => { try { return JSON.parse(s); } catch { return s; } };
  const parts = [];
  parts.push(`Tumblr Studio diagnostics, ${t.toISOString()}`, note ? `Note: ${String(note).slice(0, 2000)}` : '', '');
  parts.push('== runtime ==', J(info), '');
  try {
    parts.push('== capabilities ==', J(db.all('SELECT key, status, note, at FROM capabilities ORDER BY key')), '');
    parts.push('== job counts ==', J(db.all('SELECT kind, status, COUNT(*) n FROM jobs GROUP BY kind, status ORDER BY kind, status')), '');
    const since = Date.now() - days * 86400e3;
    const jobRow = r => ({ id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, error: r.error, created: r.created_at && new Date(r.created_at).toISOString(), updated: r.updated_at && new Date(r.updated_at).toISOString(), target: target(P(r.payload) || {}), result: P(r.result) });
    parts.push('== open jobs ==', J(db.all(`SELECT * FROM jobs WHERE status IN ('pending', 'running', 'verifying', 'waiting', 'unknown') ORDER BY id DESC LIMIT 200`).map(jobRow)), '');
    parts.push(`== failed / skipped / cancelled jobs (last ${days} days) ==`, J(db.all(`SELECT * FROM jobs WHERE status IN ('failed', 'skipped', 'cancelled') AND updated_at >= ? ORDER BY id DESC LIMIT 300`, since).map(jobRow)), '');
    parts.push('== settings (no keys) ==', J({ automation: db.getMeta('automation', {}), settings: db.getMeta('settings', {}), audience: db.getMeta('audience', {}), runtime: db.getMeta('runtime', {}), lastPass: db.getMeta('lastPass', {}), schema: db.get('SELECT v FROM schema_version')?.v }), '');
    parts.push('== activity (newest 500) ==', db.all('SELECT * FROM activity ORDER BY id DESC LIMIT 500').map(r => `${new Date(r.at).toISOString()} ${r.level} ${r.kind}: ${r.msg}${r.data ? ' ' + JSON.stringify(brief(P(r.data))) : ''}`).join('\n'), '');
  } catch (e) { parts.push('(store not readable: ' + e.message + ')'); }
  for (const [name, text] of diag.recent(days)) parts.push(`== ${name} ==`, text);
  fs.writeFileSync(file, parts.join('\n'));
  return file;
}

module.exports = { makeDiag, exportBundle, brief };
