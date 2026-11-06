'use strict';
// Data in and out:
//  - import of the browser extension's export (format tth-export): roles, packs, tag statistics, template rules,
//    AI provider settings and "show only recent" — never secrets, never a remote change. Old recentOnly settings
//    become image-only, switched-off display rules for the user to review; their hidden posts are remembered as
//    "hidden by the extension (unverified)". The original file is kept for rollback; importing twice is harmless.
//  - backup: a consistent copy of the database (VACUUM INTO) plus the draft image files, with checksums.
//  - restore: applied at the next start (the database can't be swapped while open), with automation paused.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { J, P } = require('./db');
const { writeAtomic } = require('./auth');
const groups = require('./groups');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = now => new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);

function planImport(db, exp) {
  if (!exp || exp.format !== 'tth-export' || !exp.data) throw new Error('not an export from the browser extension');
  const d = exp.data, s = d.settings || {};
  const blogs = new Map(db.all('SELECT uuid, name FROM blogs').map(b => [b.uuid, b.name]));
  const roles = Object.entries(s.blogRoles || {}).map(([uuid, r]) => ({ uuid, role: r?.role, known: blogs.has(uuid) })).filter(r => ['share', 'material'].includes(r.role));
  if (s.collect?.blog) roles.push({ uuid: s.collect.blog, role: 'material', known: blogs.has(s.collect.blog) });
  const recent = Object.entries(s.recentOnly || {}).map(([uuid, days]) => ({ uuid, days: Number(days), known: blogs.has(uuid) })).filter(r => r.days > 0);
  const hidden = Object.entries(d.recentHidden || {}).reduce((n, [, v]) => n + Object.keys(v?.ids || {}).length, 0);
  return {
    extension: exp.extension, exported: exp.exported,
    roles, recent, hidden,
    packs: (d.packs || []).length,
    tagStats: Object.keys(d.cache?.tagStats || {}).length,
    ai: !!(s.ai?.base || s.ai?.model),
    rules: !!s.rules,
    legacy: ['collection', 'materials'].filter(k => d[k]),
    desktopManaged: !!s.desktopManaged,
    reblogSync: !!s.syncReblogs,
    unknownBlogs: [...new Set([...roles, ...recent].filter(r => !r.known).map(r => r.uuid))],
  };
}

function applyImport(db, exp, { dataDir, now = Date.now() } = {}) {
  const plan = planImport(db, exp);
  const d = exp.data, s = d.settings || {};
  fs.mkdirSync(path.join(dataDir, 'imports'), { recursive: true });
  const keep = path.join(dataDir, 'imports', 'extension-' + stamp(now) + '.json');
  fs.writeFileSync(keep, JSON.stringify(exp));
  db.tx(() => {
    // roles: blogs not synced yet get theirs when they appear
    const pending = db.getMeta('pendingRoles', {});
    for (const r of plan.roles) {
      if (r.known) db.run(`UPDATE blogs SET role = ? WHERE uuid = ? AND is_primary = 0`, r.role, r.uuid);
      else pending[r.uuid] = r.role;
    }
    db.setMeta('pendingRoles', pending);
    // packs: one per id; a pack edited here is not replaced
    const mine = db.getMeta('packs', []);
    const idOf = p => { try { return (typeof p.raw === 'string' ? JSON.parse(p.raw) : p.raw)?.id; } catch { return null; } };
    for (const p of d.packs || []) {
      const id = idOf(p);
      if (!id) continue;
      const i = mine.findIndex(x => idOf(x) === id);
      if (i >= 0 && mine[i].edited && !p.edited) continue;
      if (i >= 0) mine[i] = { raw: p.raw, source: p.source || 'extension', edited: !!p.edited }; else mine.push({ raw: p.raw, source: p.source || 'extension', edited: !!p.edited });
    }
    db.setMeta('packs', mine);
    // tag statistics: newer sample wins
    const stats = db.getMeta('tagStats', {});
    for (const [k, v] of Object.entries(d.cache?.tagStats || {})) if (!stats[k] || (v.at || 0) > (stats[k].at || 0)) stats[k] = v;
    db.setMeta('tagStats', stats);
    // settings that mean the same here
    const mineSet = db.getMeta('settings', {});
    if (s.rules) mineSet.rules = s.rules;
    if (s.useBase !== undefined) mineSet.useBase = s.useBase;
    if (s.ai) mineSet.ai = { ...(mineSet.ai || {}), base: s.ai.base || '', model: s.ai.model || '', ...(s.ai.notes !== undefined ? { notes: s.ai.notes } : {}), ...(s.ai.notesLang ? { notesLang: s.ai.notesLang } : {}) };
    db.setMeta('settings', mineSet);
    // collecting moved here: the same blog, tags and options, automatic collecting OFF until switched on in the
    // app (it then starts from that moment; older likes are a previewed, explicit choice)
    if (s.collect?.blog) {
      const cur = db.getMeta('collect', {});
      const note = { fromExtension: { auto: !!s.collect.auto, since: d.collectSince || null } };
      // settings already made in the app are kept; the note says collecting was automatic in the browser
      if (!cur.blog) db.setMeta('collect', { ...cur, blog: s.collect.blog, tags: s.collect.tags || [], imagesOnly: s.collect.imagesOnly !== false,
        autoPalette: s.collect.autoPalette !== false, daily: s.collect.daily || 4, auto: false, since: 0, ...note });
      else db.setMeta('collect', { ...cur, ...note });
    }
    // show only recent → an image-only LINKED rule on that blog, OFF until the user turns it on: it covers the
    // originals of the works this blog manages, wherever they are posted (often the main blog), and no reblogs
    // (targets []). Auto-hiding keeps originals out of tag search; reblogs never show there. (The extension hid
    // every image post physically on the blog, reblogs too.)
    for (const r of plan.recent) {
      const ex = db.get(`SELECT id FROM expiry_rules WHERE blog = ? AND scope = 'images'`, r.uuid);
      if (ex) db.run('UPDATE expiry_rules SET days = ? WHERE id = ?', r.days, ex.id);
      else db.run(`INSERT INTO expiry_rules (mode, blog, enabled, days, scope, kinds, targets, updated_at) VALUES ('linked', ?, 0, ?, 'images', '["original"]', '[]', ?)`, r.uuid, r.days, now);
    }
    // posts the extension hid: remembered with that provenance (unverified), never published here by import
    for (const [uuid, v] of Object.entries(d.recentHidden || {})) {
      const rule = db.get(`SELECT id FROM expiry_rules WHERE mode = 'independent' AND blog = ? AND scope = 'images'`, uuid)?.id ?? null;
      for (const [id, ts] of Object.entries(v?.ids || {})) {
        const cur = db.get('SELECT display FROM policies WHERE blog = ? AND id = ?', uuid, String(id));
        if (cur && cur.display !== 'follow_rule') continue;
        db.run(`INSERT INTO policies (blog, id, display, auto_hide, updated_at) VALUES (?, ?, 'follow_rule', ?, ?)
          ON CONFLICT(blog, id) DO UPDATE SET auto_hide = COALESCE(policies.auto_hide, excluded.auto_hide)`, uuid, String(id), J({ rule, imported: true, unverified: true, at: Number(ts) || now }), now);
      }
    }
    for (const k of plan.legacy) db.setMeta('legacy:' + k, d[k]);
    db.setMeta('lastImport', { at: now, file: path.basename(keep), plan: { ...plan, roles: plan.roles.length, recent: plan.recent.length } });
  });
  groups.rebuild(db, now);
  return plan;
}

// Roles that arrived before their blogs: applied after a blog sync
function applyPendingRoles(db) {
  const pending = db.getMeta('pendingRoles', {});
  let n = 0;
  for (const [uuid, role] of Object.entries(pending)) {
    if (db.get('SELECT 1 FROM blogs WHERE uuid = ?', uuid)) { db.run('UPDATE blogs SET role = ? WHERE uuid = ? AND is_primary = 0 AND role IS NULL', role, uuid); delete pending[uuid]; n++; }
  }
  if (n) db.setMeta('pendingRoles', pending);
  return n;
}

function backup(db, { dataDir, dest, now = Date.now() }) {
  const dir = path.join(dest || path.join(dataDir, 'backups'), 'studio-backup-' + stamp(now));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const dbFile = path.join(dir, 'studio.db');
  db.raw.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
  const files = [{ path: 'studio.db', sha256: sha256(dbFile) }];
  for (const a of db.all('SELECT file FROM assets')) {
    const src = path.join(dataDir, 'assets', a.file);
    if (!fs.existsSync(src)) continue;
    const to = path.join(dir, 'assets', a.file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(src, to);
    files.push({ path: 'assets/' + a.file, sha256: sha256(to) });
  }
  const schema = db.get('SELECT v FROM schema_version').v;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 'tumblr-studio-backup', version: 1, schema, created: new Date(now).toISOString(), files, note: 'No credentials are included.' }, null, 2));
  return { dir, files: files.length };
}

function verifyBackup(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (m.format !== 'tumblr-studio-backup') throw new Error('not a Tumblr Studio backup');
  for (const f of m.files) {
    const p = path.join(dir, f.path);
    if (!fs.existsSync(p) || sha256(p) !== f.sha256) throw new Error('backup file damaged: ' + f.path);
  }
  return m;
}

// Runs before the database is opened. The current data is moved aside, never deleted.
function restoreAtStartup(dataDir) {
  const marker = path.join(dataDir, 'restore-from.txt');
  if (!fs.existsSync(marker)) return null;
  const from = fs.readFileSync(marker, 'utf8').trim();
  fs.unlinkSync(marker);
  const m = verifyBackup(from);
  const aside = path.join(dataDir, 'before-restore-' + stamp(Date.now()));
  fs.mkdirSync(aside, { recursive: true });
  for (const f of ['studio.db', 'studio.db-wal', 'studio.db-shm']) if (fs.existsSync(path.join(dataDir, f))) fs.renameSync(path.join(dataDir, f), path.join(aside, f));
  if (fs.existsSync(path.join(dataDir, 'assets'))) fs.renameSync(path.join(dataDir, 'assets'), path.join(aside, 'assets'));
  fs.copyFileSync(path.join(from, 'studio.db'), path.join(dataDir, 'studio.db'));
  fs.cpSync(path.join(from, 'assets'), path.join(dataDir, 'assets'), { recursive: true });
  return { from, aside, schema: m.schema };
}

function addData(svc, api, { dataDir, vault = null, openPath = () => {}, relaunch = () => {} } = {}) {
  const { db } = svc;
  const aiFile = path.join(dataDir, 'ai.bin');
  Object.assign(api, {
    importPreview({ text }) { return planImport(db, JSON.parse(text)); },
    importApply({ text }) { const exp = JSON.parse(text); const r = applyImport(db, exp, { dataDir, now: svc.ctx.now() }); applyPendingRoles(db); svc.ctx.onImport?.(exp); return r; },
    // The same import handed over by the paired browser extension (bridge request 'import')
    importExtension({ data }) { const r = applyImport(db, data, { dataDir, now: svc.ctx.now() }); applyPendingRoles(db); svc.ctx.onImport?.(data); return r; },
    backupNow() { const r = backup(db, { dataDir, now: svc.ctx.now() }); db.setMeta('lastBackup', { at: svc.ctx.now(), dir: r.dir }); return r; },
    backups() {
      const dir = path.join(dataDir, 'backups');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => f.startsWith('studio-backup-')).sort().reverse().map(f => ({ name: f, dir: path.join(dir, f) }));
    },
    openBackupFolder() { fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true }); openPath(path.join(dataDir, 'backups')); return true; },
    restoreBackup({ dir }) {
      verifyBackup(dir);
      fs.writeFileSync(path.join(dataDir, 'restore-from.txt'), dir);
      db.setMeta('paused', true);
      setTimeout(relaunch, 300);
      return true;
    },
    aiStatus() { const s = db.getMeta('settings', {}).ai || {}; return { base: s.base || '', model: s.model || '', hasKey: fs.existsSync(aiFile) }; },
    setAi({ base, model, key }) {
      const st = db.getMeta('settings', {});
      st.ai = { base: String(base || '').trim(), model: String(model || '').trim() };
      db.setMeta('settings', st);
      if (key && vault) writeAtomic(aiFile, vault.encrypt(String(key).trim()));
      return api.aiStatus();
    },
    forgetAiKey() { try { fs.unlinkSync(aiFile); } catch {} return api.aiStatus(); },
  });
  return { aiKey: () => { try { return vault ? vault.decrypt(fs.readFileSync(aiFile)) : null; } catch { return null; } } };
}

module.exports = { addData, planImport, applyImport, applyPendingRoles, backup, verifyBackup, restoreAtStartup };
