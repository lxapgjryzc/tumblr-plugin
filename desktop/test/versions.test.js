'use strict';
// Version maintenance (docs/REBLOG_POLICY.md 2.1, R12-R17, A56). All blogs, ids and tags are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const routes = require('../src/service/routes');
const { makeApi } = require('../src/service/api');
const { addVersions } = require('../src/service/versions');
const { openDb } = require('../src/service/db');
const { makeFake } = require('./fake-tumblr');

const BLOGS = [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:art', name: 'artside' }];
const ts = ms => Math.floor(ms / 1000);
const IMG = n => ({ type: 'image', media: [{ url: `https://64.media.tumblr.com/k${n}/s1280x1920/p.jpg`, width: 1280 }] });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ver-'));
  const clock = { t: Date.UTC(2026, 10, 1) };
  const now = () => clock.t;
  const fake = makeFake({ blogs: BLOGS, now });
  const svc = createService({ dataDir: dir, tumblr: fake, now });
  svc.db.capability('edit.labels', 'not_used');
  const extra = {};
  addVersions(svc, extra);
  const api = makeApi(svc, { extra });
  const run = async () => { for (let i = 0; i < 30; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  const pass = async () => { svc.pass(); await run(); };
  await pass();
  svc.db.run(`UPDATE blogs SET role = 'share' WHERE uuid = 't:art'`);
  routes.saveRoute(svc.db, svc.jobs, { sources: ['t:art'], dest: 't:main', enabled: true, exclude: [] }, clock.t);
  svc.db.setMeta('automation', { routes: true });
  clock.t += 1000;
  const copies = id => [...fake.posts.values()].filter(p => p.blog.uuid === 't:main' && p.parent_post_id === id).sort((a, b) => (BigInt(a.id_string) < BigInt(b.id_string) ? -1 : 1));
  return { dir, fake, clock, svc, db: svc.db, api, run, pass, copies };
}

// A work with three versions on the main blog: v1 (text A, 1 image), v2 (text B, 2 images), v3 (text C, 2 images reordered)
async function threeVersions(s) {
  const A = s.fake.addPost('t:art', { content: [{ type: 'text', text: 'version A' }, IMG(1)], tags: ['art', 'wip'], timestamp: ts(s.clock.t) });
  await s.pass();
  s.fake.posts.get(A.id_string).content = [{ type: 'text', text: 'version B' }, IMG(1), IMG(2)];
  s.fake.posts.get(A.id_string).tags = ['art', 'final'];
  await s.pass();
  s.fake.posts.get(A.id_string).content = [{ type: 'text', text: 'version C' }, IMG(2), IMG(1)];
  await s.pass();
  return A;
}

test('R12 R13: one history from the original or any reblog; times kept apart; diffs show text and images, tags apart', async () => {
  const s = await setup();
  const A = await threeVersions(s);
  const cs = s.copies(A.id_string);
  assert.equal(cs.length, 3);
  const fromOrig = s.api.versions({ blog: 't:art', id: A.id_string });
  const fromCopy = s.api.versions({ blog: 't:main', id: cs[0].id_string });
  assert.deepEqual(fromCopy.origin, fromOrig.origin, 'entering from a reblog reaches the same work');
  assert.equal(fromOrig.latest, 3);
  assert.deepEqual(fromOrig.revisions.map(r => r.rev), [1, 2, 3]);
  const main = fromOrig.dests.find(d => d.dest === 't:main');
  assert.deepEqual(main.copies.map(c => c.rev), [1, 2, 3]);
  assert.equal(main.latestVerified, 3);
  assert.ok(main.copies.every(c => c.reblogged_at), 'each instance has its own reblog time');
  assert.ok(fromOrig.revisions[1].since > fromOrig.revisions[0].since, 'observation times per version');

  const d12 = s.api.versionDiff({ blog: 't:art', id: A.id_string, a: 1, b: 2 });
  assert.ok(d12.comparable);
  assert.deepEqual(d12.text, [{ i: 0, before: 'version A', after: 'version B' }]);
  assert.equal(d12.images.added, 1);
  assert.deepEqual(d12.tags.a.map(x => x.tags), [['art', 'wip']], 'tags of each version are listed apart');
  assert.deepEqual(d12.tags.b.map(x => x.tags), [['art', 'final']]);
  const d23 = s.api.versionDiff({ blog: 't:art', id: A.id_string, a: 2, b: 3 });
  assert.ok(d23.images.moved && !d23.images.added && !d23.images.removed, 'a reorder is a change, not "same images"');
  // a revision with no stored body and no copy holding it can't be compared, and says so
  s.db.run(`UPDATE source_revisions SET snapshot = NULL WHERE id = ? AND rev = 1`, A.id_string);
  s.db.run(`UPDATE deliveries SET version_unknown = 1 WHERE src_id = ? AND rev = 1`, A.id_string);
  assert.deepEqual(s.api.versionDiff({ blog: 't:art', id: A.id_string, a: 1, b: 2 }), { comparable: false, missing: [1] });
});

test('R14 R15: preview lists exact instances; hiding old public versions keeps the newest, respects keep-public, is one-off', async () => {
  const s = await setup();
  const A = await threeVersions(s);
  const [c1, c2, c3] = s.copies(A.id_string);
  // c2 is kept public on purpose
  s.api.versionAction({ blog: 't:art', id: A.id_string, targets: [{ dest: 't:main', dest_id: c2.id_string }], action: 'keepPublic' });
  const pv = s.api.hideOldPreview({ blog: 't:art', id: A.id_string });
  const b = pv.blogs.find(x => x.dest === 't:main');
  assert.equal(b.keep.dest_id, c3.id_string, 'the newest verified public copy stays');
  assert.deepEqual(b.hide.map(c => c.dest_id), [c1.id_string]);
  assert.deepEqual(b.left.map(c => [c.dest_id, c.why]), [[c2.id_string, 'keep_public']]);
  s.api.hideOld({ blog: 't:art', id: A.id_string });
  await s.run();
  assert.equal(s.fake.posts.get(c1.id_string).state, 'private');
  assert.equal(s.fake.posts.get(c2.id_string).state, 'published');
  assert.equal(s.fake.posts.get(c3.id_string).state, 'published');
  assert.equal(s.fake.posts.get(A.id_string).state, 'published', 'the original is untouched');
  assert.deepEqual(s.fake.posts.get(c1.id_string).tags, s.fake.posts.get(A.id_string).tags, 'reblogs carry the original’s tags; hiding changes nothing else');

  // a fourth version arrives: nothing old is hidden on its own (no standing rule)
  s.fake.posts.get(A.id_string).content = [{ type: 'text', text: 'version D' }];
  await s.pass();
  assert.equal(s.fake.posts.get(c3.id_string).state, 'published');

  // when the latest version is not public on a blog, nothing is offered there
  const c4 = s.copies(A.id_string)[3];
  s.fake.posts.get(c4.id_string).state = 'private';
  await s.pass();
  const held = s.api.hideOldPreview({ blog: 't:art', id: A.id_string }).blogs.find(x => x.dest === 't:main');
  assert.equal(held.held, 'latest_not_public');
  assert.equal(held.hide.length, 0);

  // a preview names what is skipped and why
  const p2 = s.api.versionActionPreview({ blog: 't:art', id: A.id_string, targets: [{ dest: 't:main', dest_id: c2.id_string }, { dest: 't:main', dest_id: c1.id_string }, { dest: 't:main', dest_id: 'nope' }], action: 'hide' });
  assert.deepEqual(p2.skipped.map(x => x.reason).sort(), ['already', 'keep_public', 'not_found']);
  assert.ok(p2.original.untouched);
});

test('R16 R17: deleting a version leaves a tombstone and notes; a sync never recreates it; re-sending keeps the checks; notes survive reopening', async () => {
  const s = await setup();
  const A = await threeVersions(s);
  const [c1] = s.copies(A.id_string);
  s.api.versionNote({ blog: 't:art', id: A.id_string, rev: 1, label: 'first sketch', note: 'kept for the record' });
  const orig = s.api.versionActionPreview({ blog: 't:art', id: A.id_string, targets: [{ dest: 't:art', dest_id: A.id_string }], action: 'delete' });
  assert.equal(orig.ok.length, 0, 'the original itself is never a target');
  s.api.versionAction({ blog: 't:art', id: A.id_string, targets: [{ dest: 't:main', dest_id: c1.id_string }], action: 'delete' });
  await s.run();
  assert.ok(!s.fake.posts.has(c1.id_string), 'the chosen reblog is deleted');
  assert.ok(s.fake.posts.has(A.id_string), 'the original stays');
  await s.pass();
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 2, 'not recreated');
  const v = s.api.versions({ blog: 't:art', id: A.id_string });
  const main = v.dests.find(d => d.dest === 't:main');
  assert.equal(main.copies.find(c => c.rev === 1).status, 'tombstone');
  assert.equal(v.revisions[0].label, 'first sketch');
  // re-sending the latest version goes through the dedupe: it is already there
  assert.throws(() => s.api.versionReblog({ blog: 't:art', id: A.id_string, dest: 't:main' }), /already/);
  // notes are local data: they survive closing and reopening the database, and never reach Tumblr
  s.db.close?.();
  const db2 = openDb(path.join(s.dir, 'studio.db'));
  assert.equal(db2.get('SELECT label FROM version_notes WHERE id = ? AND rev = 1', A.id_string).label, 'first sketch');
  assert.ok(![...s.fake.posts.values()].some(p => (p.tags || []).includes('first sketch')));
});
