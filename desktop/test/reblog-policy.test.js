'use strict';
// docs/REBLOG_POLICY.md on the desktop: reblogs are frozen snapshots; a new body is a new revision with its own
// reblog; tags-only changes send nothing. All blogs, ids and tags are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const routes = require('../src/service/routes');
const { makeApi } = require('../src/service/api');
const { makeFake, netFail } = require('./fake-tumblr');

const BLOGS = [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:art', name: 'artside' }];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rp-'));
  const clock = { t: Date.UTC(2026, 10, 1) };
  const now = () => clock.t;
  const fake = makeFake({ blogs: BLOGS, now });
  const svc = createService({ dataDir: dir, tumblr: fake, now });
  svc.db.capability('edit.labels', 'not_used');
  const run = async () => { for (let i = 0; i < 30; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  const pass = async (o) => { svc.pass(o); await run(); };
  return { dir, fake, clock, svc, db: svc.db, run, pass, api: makeApi(svc, {}) };
}
const ts = ms => Math.floor(ms / 1000);
const body = text => [{ type: 'text', text }];

async function withRoute(o = {}) {
  const s = setup();
  await s.pass();
  s.db.run(`UPDATE blogs SET role = 'share' WHERE uuid = 't:art'`);
  s.routeId = routes.saveRoute(s.db, s.svc.jobs, { sources: ['t:art'], dest: 't:main', enabled: true, exclude: o.exclude || [] }, s.clock.t);
  s.db.setMeta('automation', { routes: true });
  s.clock.t += 1000;
  s.copies = id => [...s.fake.posts.values()].filter(p => p.blog.uuid === 't:main' && p.parent_post_id === id)
    .sort((a, b) => (BigInt(a.id_string) < BigInt(b.id_string) ? -1 : 1));
  s.text = p => p.trail[p.trail.length - 1].content[0].text;
  return s;
}

test('R01 R02 R10: a new body gets its own reblog with the tags of that moment; tags-only changes send nothing; A → B → A is three versions', async () => {
  const s = await withRoute();
  const A = s.fake.addPost('t:art', { content: body('version A'), tags: ['art', 'sketch'], timestamp: ts(s.clock.t) });
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 1);
  const R1 = s.copies(A.id_string)[0];
  assert.deepEqual(R1.tags, ['art', 'sketch']);

  // tags only, including order: no version, no reblog, R1 untouched
  s.fake.posts.get(A.id_string).tags = ['art', 'finished'];
  await s.pass();
  s.fake.posts.get(A.id_string).tags = ['finished', 'art'];
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 1, 'tags-only changes do not reblog');
  assert.equal(s.db.get('SELECT COUNT(*) n FROM source_revisions WHERE id = ?', A.id_string).n, 1);
  assert.ok(!s.fake.calls.includes('put:' + R1.id_string), 'R1 was never edited');

  // body B: R2 with the tags current then; R1 keeps body A and its old tags
  s.fake.posts.get(A.id_string).content = body('version B');
  await s.pass();
  const [r1, r2] = s.copies(A.id_string);
  assert.equal(s.copies(A.id_string).length, 2);
  assert.equal(s.text(r1), 'version A'); assert.deepEqual(r1.tags, ['art', 'sketch']);
  assert.equal(s.text(r2), 'version B'); assert.deepEqual(r2.tags, ['finished', 'art']);

  // back to A: a third observed revision, delivered once; rescans and restarts don't add more
  s.fake.posts.get(A.id_string).content = body('version A');
  await s.pass();
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 3);
  assert.equal(s.text(s.copies(A.id_string)[2]), 'version A');
  assert.deepEqual(s.db.all('SELECT rev, status FROM deliveries WHERE src_id = ? ORDER BY rev', A.id_string).map(r => [r.rev, r.status]),
    [[1, 'created'], [2, 'created'], [3, 'created']]);
  // the work's details list each version per destination
  s.svc.pass(); await s.run();
  const it = s.api.item({ id: s.db.get('SELECT item_id FROM posts WHERE id = ?', A.id_string).item_id });
  assert.equal(it.versions.latest, 3);
  assert.deepEqual(it.versions.dests[0].copies.map(c => c.rev), [1, 2, 3]);
  assert.ok(!s.fake.calls.some(c => c.startsWith('put:')), 'no edit of any snapshot or original');
});

test('R03 R04: a lost reblog response finds this version\'s copy, never an older one; later versions wait for it', async () => {
  const s = await withRoute();
  const A = s.fake.addPost('t:art', { content: body('one'), tags: ['art'], timestamp: ts(s.clock.t) });
  await s.pass();
  s.fake.posts.get(A.id_string).content = body('two');
  await s.pass();
  // back to "one": the response is lost after the copy was made
  s.fake.posts.get(A.id_string).content = body('one');
  const orig = s.fake.reblog;
  let sent = 0;
  s.fake.reblog = async (...a) => { sent++; await orig(...a); throw netFail(true); };
  await s.pass();
  s.fake.reblog = orig;
  await s.run();
  assert.equal(sent, 1, 'sent once');
  const copies = s.copies(A.id_string);
  assert.equal(copies.length, 3);
  const d3 = s.db.get('SELECT status, dest_id FROM deliveries WHERE src_id = ? AND rev = 3', A.id_string);
  assert.equal(d3.status, 'created');
  assert.equal(d3.dest_id, copies[2].id_string, 'the old copy of the same body was not taken as the receipt');

  // a lost response with nothing found: the next version is held, not sent around it
  s.fake.posts.get(A.id_string).content = body('three');
  s.fake.reblog = async () => { throw netFail(true); };
  await s.pass();
  s.fake.reblog = orig;
  s.fake.posts.get(A.id_string).content = body('four');
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 3);
  const pv = routes.preview(s.db, routes.routesOf(s.db)[0]).find(r => r.id === A.id_string);
  assert.equal(pv.reason, 'earlier_unresolved');
  // you check Tumblr and confirm it wasn't created: the newest version goes out
  const job = s.svc.jobs.list({ status: 'open' }).find(j => j.kind === 'post.reblog' && j.status === 'unknown');
  s.svc.jobs.resolve(job.id, s.svc.ctx);
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 4);
  assert.equal(s.text(s.copies(A.id_string)[3]), 'four');
});

test('R05 R06: a deleted version stays deleted, later versions still go; notes and visibility are not versions; hiding a snapshot keeps it', async () => {
  const s = await withRoute();
  const A = s.fake.addPost('t:art', { content: body('first'), tags: ['art'], timestamp: ts(s.clock.t) });
  await s.pass();
  const R1 = s.copies(A.id_string)[0];
  // notes, visibility of the original and a rescan change nothing
  s.fake.posts.get(A.id_string).note_count = 50;
  await s.pass({ full: true });
  assert.equal(s.copies(A.id_string).length, 1);
  // hide the snapshot explicitly: its body and tags stay
  s.api.visibility({ targets: [{ blog: 't:main', id: R1.id_string }], target: 'private' });
  await s.run();
  const hidden = s.fake.posts.get(R1.id_string);
  assert.equal(hidden.state, 'private');
  assert.deepEqual(hidden.tags, ['art']);
  assert.deepEqual(hidden.trail.at(-1).content, body('first'));
  // delete R1: tombstone for version 1 only
  s.fake.posts.delete(R1.id_string);
  await s.pass({ full: true });
  assert.equal(s.copies(A.id_string).length, 0);
  assert.equal(s.db.get('SELECT status FROM deliveries WHERE src_id = ? AND rev = 1', A.id_string).status, 'tombstone');
  s.fake.posts.get(A.id_string).content = body('second');
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 1);
  assert.equal(s.text(s.copies(A.id_string)[0]), 'second');
});

test('R07 R11: an excluded new version is skipped; a disabled route only offers it; a change right before sending is redone; a private source waits', async () => {
  const s = await withRoute({ exclude: ['diary'] });
  const A = s.fake.addPost('t:art', { content: body('a1'), tags: ['art'], timestamp: ts(s.clock.t) });
  await s.pass();
  s.fake.posts.get(A.id_string).content = body('a2');
  s.fake.posts.get(A.id_string).tags = ['art', 'diary'];
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 1);
  assert.match(s.db.get('SELECT reason FROM deliveries WHERE src_id = ? AND rev = 2', A.id_string).reason, /excluded/);
  // removing the tag doesn't send the skipped version
  s.fake.posts.get(A.id_string).tags = ['art'];
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 1);

  // route off: a new body is only offered
  routes.saveRoute(s.db, s.svc.jobs, { id: s.routeId, sources: ['t:art'], dest: 't:main', enabled: false, exclude: ['diary'] }, s.clock.t);
  s.fake.posts.get(A.id_string).content = body('a3');
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 1);
  const it = s.api.item({ id: s.db.get('SELECT item_id FROM posts WHERE id = ?', A.id_string).item_id });
  assert.equal(it.versions.dests[0].newer, true, 'shown as "the original was updated"');
  s.api.reblogTo({ targets: [{ blog: 't:art', id: A.id_string }], dest: 't:main' });
  await s.run();
  assert.equal(s.copies(A.id_string).length, 2);
  assert.throws(() => s.api.reblogTo({ targets: [{ blog: 't:art', id: A.id_string }], dest: 't:main' }), /already/);

  // route on again; the source changes between planning and sending: that plan is dropped, the newest goes
  routes.saveRoute(s.db, s.svc.jobs, { id: s.routeId, sources: ['t:art'], dest: 't:main', enabled: true, exclude: ['diary'] }, s.clock.t);
  s.fake.posts.get(A.id_string).content = body('a4');
  s.svc.pass();
  const realGet = s.fake.getPost;
  s.fake.getPost = async (blog, id) => { const p = await realGet(blog, id); if (id === A.id_string && JSON.stringify(p.content) === JSON.stringify(body('a4'))) { s.fake.posts.get(A.id_string).content = body('a5'); p.content = body('a5'); } return p; };
  await s.run();
  s.fake.getPost = realGet;
  await s.pass();
  const texts = s.copies(A.id_string).map(s.text);
  assert.ok(!texts.includes('a4'), 'the version that changed before sending was not sent as if current');
  assert.equal(texts.at(-1), 'a5');
  assert.ok(s.db.all('SELECT status FROM deliveries WHERE src_id = ?', A.id_string).some(r => r.status === 'superseded'), 'the changed plan was marked superseded');

  // a private source waits; it is never opened up to reblog it
  s.fake.posts.get(A.id_string).content = body('a6');
  s.fake.posts.get(A.id_string).state = 'private';
  await s.pass();
  assert.ok(!s.copies(A.id_string).map(s.text).includes('a6'));
  assert.equal(s.fake.posts.get(A.id_string).state, 'private');
});

test('R10: existing copies from before tracking are claimed, not re-sent; a copy made by hand of the current body counts', async () => {
  const s = setup();
  const A = s.fake.addPost('t:art', { content: body('old'), tags: ['art'], timestamp: ts(s.clock.t - 3 * 86400e3) });
  await s.fake.reblog('t:main', { parentBlog: 't:art', parentId: A.id_string, tags: ['art'] });
  await s.pass();
  s.db.run(`UPDATE blogs SET role = 'share' WHERE uuid = 't:art'`);
  routes.saveRoute(s.db, s.svc.jobs, { sources: ['t:art'], dest: 't:main', enabled: true }, s.clock.t);
  s.db.setMeta('automation', { routes: true });
  await s.pass({ full: true });
  const onMain = () => [...s.fake.posts.values()].filter(p => p.blog.uuid === 't:main');
  assert.equal(onMain().length, 1);
  // an edit of an already-delivered source is a new version even though the post is older than the route
  s.fake.posts.get(A.id_string).content = body('new');
  await s.pass({ full: true });
  assert.equal(onMain().length, 2);
});

test('version discovery: an edit to an older delivered original is seen without a manual full sync', async () => {
  const s = await withRoute();
  const A = s.fake.addPost('t:art', { content: body('v1'), tags: ['art'], timestamp: ts(s.clock.t) });
  await s.pass();
  // many newer posts push A out of the incremental window
  for (let i = 0; i < 25; i++) s.fake.addPost('t:art', { content: body('filler ' + i), tags: ['diary'], timestamp: ts(s.clock.t + 5 * 86400e3 + i * 6 * 3600e3) });
  s.clock.t += 12 * 86400e3;
  await s.pass();
  s.fake.posts.get(A.id_string).content = body('v2');
  s.clock.t += 7 * 3600e3;
  await s.pass();
  assert.equal(s.copies(A.id_string).length, 2);
});
