'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/service/db');
const { createService } = require('../src/service/service');
const { planImport, applyImport, backup, verifyBackup, restoreAtStartup } = require('../src/service/data');
const display = require('../src/service/display');
const { makeFake } = require('./fake-tumblr');

const EXPORT = {
  format: 'tth-export', version: 1, extension: '0.9.5',
  data: {
    settings: { blogRoles: { 't:art': { role: 'share' }, 't:later': { role: 'share' } }, collect: { blog: 't:ref' }, recentOnly: { 't:main': 30 }, ai: { base: 'https://ai.example/v1', model: 'm' }, rules: { cold: true } },
    packs: [{ raw: { format: 'tth-template-pack', id: 'demo', name: 'Demo', characters: [{ id: 'a', name: 'Alpha', tags: ['character alpha'] }] }, source: 'x' }],
    cache: { tagStats: { 'character alpha': { followers: 10, at: 1 } } },
    recentHidden: { 't:main': { ids: { '1000000000000000001': 1700000000000 }, done: 0 } },
    aiKey: 'should-not-be-here-but-is-ignored',
  },
};

test('extension import: idempotent, no remote changes, recentOnly becomes an image-only rule that is off (A28, A29)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-d-'));
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'm', primary: true }, { uuid: 't:art', name: 'a' }, { uuid: 't:ref', name: 'r' }] });
  const svc = createService({ dataDir: dir, tumblr: fake });
  svc.pass(); for (let i = 0; i < 5; i++) await svc.jobs.drain(svc.ctx);
  const plan = planImport(svc.db, EXPORT);
  assert.deepEqual(plan.unknownBlogs, ['t:later']);
  applyImport(svc.db, EXPORT, { dataDir: dir });
  applyImport(svc.db, EXPORT, { dataDir: dir });
  const rules = display.rulesOf(svc.db);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].scope, 'images');
  assert.equal(rules[0].enabled, 0);
  // auto-hiding keeps originals from filling tag search; reblogs never show there, so they are never hidden by it
  assert.equal(rules[0].mode, 'linked', 'the originals of the works the blog manages, wherever they are posted');
  assert.deepEqual(rules[0].targets, [], 'no reblogs');
  assert.equal(svc.db.get(`SELECT role FROM blogs WHERE uuid = 't:art'`).role, 'share');
  assert.equal(svc.db.get(`SELECT role FROM blogs WHERE uuid = 't:ref'`).role, 'material');
  assert.equal(svc.db.getMeta('packs').length, 1);
  assert.equal(svc.db.getMeta('settings').ai.base, 'https://ai.example/v1');
  assert.ok(!JSON.stringify(svc.db.getMeta('settings')).includes('should-not-be-here'), 'no key copied');
  assert.ok(display.policyOf(svc.db, 't:main', '1000000000000000001').auto_hide.imported);
  assert.ok(!fake.calls.some(c => /^(put|create|reblog|delete)/.test(c)), 'nothing sent to Tumblr');
  assert.equal(fs.readdirSync(path.join(dir, 'imports')).length >= 1, true);
});

test('backup and restore: checksums, restore at startup keeps the old data aside', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-b-'));
  const db = openDb(path.join(dir, 'studio.db'));
  db.setMeta('marker', 'before');
  fs.mkdirSync(path.join(dir, 'assets', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'ab', 'x.png'), 'png');
  db.run(`INSERT INTO assets (id, file, created_at) VALUES ('a1', 'ab/x.png', 0)`);
  const b = backup(db, { dataDir: dir });
  assert.equal(verifyBackup(b.dir).files.length, 2);
  db.setMeta('marker', 'after');
  db.close();
  fs.writeFileSync(path.join(dir, 'restore-from.txt'), b.dir);
  const r = restoreAtStartup(dir);
  assert.ok(fs.existsSync(path.join(r.aside, 'studio.db')));
  const db2 = openDb(path.join(dir, 'studio.db'));
  assert.equal(db2.getMeta('marker'), 'before');
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'ab', 'x.png')));
  // a damaged backup is refused
  fs.writeFileSync(path.join(b.dir, 'studio.db'), 'garbage');
  assert.throws(() => verifyBackup(b.dir), /damaged/);
});

test('migration 11 removes ads stored as posts, with their items and revisions', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ads-'));
  const file = path.join(dir, 'studio.db');
  openDb(file).close?.();
  const raw = new DatabaseSync(file);
  raw.exec('UPDATE schema_version SET v = 10');
  const add = (id, payload) => {
    const item = raw.prepare("INSERT INTO items (origin_blog, origin_id) VALUES ('t:b', ?)").run(id).lastInsertRowid;
    raw.prepare("INSERT INTO posts (blog, id, kind, state, payload, item_id) VALUES ('t:b', ?, 'original', 'published', ?, ?)").run(id, JSON.stringify(payload), item);
    raw.prepare("INSERT INTO source_revisions (blog, id, rev, fingerprint) VALUES ('t:b', ?, 1, 'f')").run(id);
  };
  add('1', { object_type: 'post', id_string: '1' });
  add('2', { id_string: '2' });
  add('ad-1', { object_type: 'backfill_ad' });
  add('google_native_1', { object_type: 'client_side_ad_waterfall' });
  raw.close();
  const db = openDb(file);
  assert.deepEqual(db.all('SELECT id FROM posts ORDER BY id').map(r => r.id), ['1', '2']);
  assert.deepEqual(db.all('SELECT id FROM source_revisions ORDER BY id').map(r => r.id), ['1', '2']);
  assert.deepEqual(db.all('SELECT origin_id FROM items ORDER BY origin_id').map(r => r.origin_id), ['1', '2']);
  db.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
});
