'use strict';
// Stage 1–2 behaviour against the in-memory Tumblr: durable jobs, sync coverage, management, display policy,
// expiry and routes. All blogs, ids and tags are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/service/db');
const { createService } = require('../src/service/service');
const { makeJobs } = require('../src/service/jobs');
const display = require('../src/service/display');
const routes = require('../src/service/routes');
const groups = require('../src/service/groups');
const { makeFake, netFail } = require('./fake-tumblr');
const { NetError } = require('../src/service/errors');

const DAY = 86400e3;
const BLOGS = [
  { uuid: 't:main', name: 'mainblog', primary: true },
  { uuid: 't:art', name: 'artside' },
  { uuid: 't:art2', name: 'artside2' },
  { uuid: 't:ref', name: 'refside' },
];

function setup({ staleReads = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const fake = makeFake({ blogs: BLOGS, staleReads });
  const clock = { t: Date.UTC(2026, 10, 1) };
  const now = () => clock.t;
  const svc = createService({ dataDir: dir, tumblr: fake, now });
  const run = async () => {
    // drain repeatedly, moving the clock past verification waits
    for (let i = 0; i < 30; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; }
  };
  const roles = () => {
    svc.db.run(`UPDATE blogs SET role = 'share' WHERE uuid IN ('t:art', 't:art2')`);
    svc.db.run(`UPDATE blogs SET role = 'material' WHERE uuid = 't:ref'`);
  };
  return { dir, fake, clock, svc, run, roles, db: svc.db };
}
const ts = ms => Math.floor(ms / 1000);

test('jobs: crash recovery, supersede, dependencies', async () => {
  const db = openDb(':memory:');
  let t = 1000;
  const ran = [];
  const jobs = makeJobs(db, { now: () => t, handlers: {
    edit: { run: async j => { ran.push(j.id); return { status: 'succeeded' }; } },
    create: { creates: true, run: async () => { throw netFail(true); }, reconcile: async () => ({ status: 'succeeded', result: { found: 1 } }) },
    fail: { run: async () => ({ status: 'failed', error: 'no' }) },
  } });
  const a = jobs.add('edit', {}, { scope: 'post:x:1' });
  const b = jobs.add('edit', {}, { scope: 'post:x:1', supersede: true });
  assert.equal(jobs.get(a).status, 'cancelled');
  // a running create interrupted by a crash becomes unknown, an edit goes back to pending
  const c = jobs.add('create', {});
  db.run(`UPDATE jobs SET status = 'running' WHERE id IN (?, ?)`, b, c);
  jobs.recover();
  assert.equal(jobs.get(b).status, 'pending');
  assert.equal(jobs.get(c).status, 'unknown');
  t += 120e3;
  await jobs.drain({});
  assert.equal(jobs.get(c).status, 'succeeded', 'reconciled, not re-sent');
  // a lost create response is unknown, never retried blindly
  const d = jobs.add('create', {});
  await jobs.drain({});
  assert.equal(jobs.get(d).status, 'unknown');
  // dependency failure cancels the dependent step
  const f = jobs.add('fail', {});
  const g = jobs.add('edit', {}, { dependsOn: f });
  await jobs.drain({});
  assert.equal(jobs.get(g).status, 'cancelled');
});

test('sync: paging to the end, private posts, resumable full pass, gone only after a complete pass', async () => {
  const { fake, svc, run, db } = setup();
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 45; i++) fake.addPost('t:main', { timestamp: ts(base + i * DAY), state: i % 3 ? 'published' : 'private' });
  fake.addPost('t:main', { state: 'draft', timestamp: 0 });
  // the first full pass is interrupted on its second page
  let calls = 0;
  const orig = fake.postsPage;
  fake.postsPage = async (...a) => { if (a[0] === 't:main' && !a[1]?.box && ++calls === 2) throw new NetError('offline'); return orig(...a); };
  svc.pass();
  await svc.jobs.drain(svc.ctx);
  const s1 = db.get(`SELECT * FROM sync_state WHERE blog = 't:main' AND box = 'posts'`);
  assert.ok(!s1?.complete, 'incomplete pass is not complete');
  fake.postsPage = orig;
  await run();
  const s2 = db.get(`SELECT * FROM sync_state WHERE blog = 't:main' AND box = 'posts'`);
  assert.equal(s2.complete, 1);
  assert.equal(db.get(`SELECT COUNT(*) n FROM posts WHERE blog = 't:main' AND state IN ('published', 'private')`).n, 45);
  assert.equal(db.get(`SELECT COUNT(*) n FROM posts WHERE blog = 't:main' AND state = 'private'`).n, 15);
  assert.equal(db.get(`SELECT COUNT(*) n FROM posts WHERE state = 'draft'`).n, 1);
  // a deleted post is only marked gone by a full pass
  const victim = [...fake.posts.values()].find(p => p.blog.uuid === 't:main' && p.state === 'published');
  fake.posts.delete(victim.id_string);
  svc.pass({ full: true });
  await run();
  assert.equal(db.get('SELECT state FROM posts WHERE id = ?', victim.id_string).state, 'gone');
});

test('management: main original reblogged by one sharing side blog is managed there (A04, A06, A07, A33)', async () => {
  const { fake, svc, run, db, roles } = setup();
  svc.pass(); await run(); roles();
  const A = fake.addPost('t:main', { tags: ['fanart'] });
  const B = await fake.reblog('t:art', { parentBlog: 't:main', parentId: A.id_string, reblogKey: A.reblog_key });
  const S = fake.addPost('t:art', { tags: ['sketch'] });                 // side original…
  await fake.reblog('t:main', { parentBlog: 't:art', parentId: S.id_string }); // …reblogged to main
  const M = fake.addPost('t:main');
  await fake.reblog('t:ref', { parentBlog: 't:main', parentId: M.id_string });   // material collects it
  const Z = fake.addPost('t:main');
  await fake.reblog('t:art', { parentBlog: 't:main', parentId: Z.id_string });
  await fake.reblog('t:art2', { parentBlog: 't:main', parentId: Z.id_string });   // two candidates
  svc.pass(); await run();
  const itemOf = id => groups.item(db, db.get('SELECT item_id FROM posts WHERE id = ?', id).item_id);
  const a = itemOf(A.id_string);
  assert.equal(a.manager, 't:art');
  assert.equal(a.origin_blog, 't:main', 'the original stays on main');
  assert.equal(a.members.length, 2);
  assert.equal(itemOf(B).id, a.id);
  assert.equal(itemOf(S.id_string).manager, 't:art', 'side original stays side-managed');
  assert.equal(itemOf(M.id_string).manager, 't:main', 'material never takes management');
  const z = itemOf(Z.id_string);
  assert.equal(z.status, 'ambiguous');
  // the side reblog disappears: authority is kept and flagged, not silently moved back to main
  fake.posts.delete(B);
  svc.pass({ full: true }); await run();
  const a2 = itemOf(A.id_string);
  assert.equal(a2.manager, 't:art');
  assert.equal(a2.status, 'needs_review');
  // nothing on Tumblr was edited by any of this
  assert.ok(!fake.calls.some(c => c.startsWith('put:')));
});

test('expiry: due by age, keep visible survives restarts and rule edits, never republishes (A09, A11, A12, A32)', async () => {
  const { fake, svc, run, db, clock, roles, dir } = setup();
  const old = fake.addPost('t:main', { timestamp: ts(clock.t - 200 * DAY), content: [{ type: 'text', text: 'old text post' }] });
  const popular = fake.addPost('t:main', { timestamp: ts(clock.t - 100 * DAY), note_count: 900 });
  const fresh = fake.addPost('t:main', { timestamp: ts(clock.t - 3 * DAY) });
  const hidden = fake.addPost('t:main', { timestamp: ts(clock.t - 300 * DAY), state: 'private' });
  svc.pass(); await run(); roles();
  db.run(`INSERT INTO expiry_rules (mode, blog, enabled, days, scope) VALUES ('independent', 't:main', 1, 30, 'all')`);
  db.setMeta('automation', { expiry: true });
  display.keepVisible(db, svc.jobs, [{ blog: 't:main', id: popular.id_string }]);
  svc.pass(); await run();
  assert.equal(fake.posts.get(old.id_string).state, 'private', 'old text post expired');
  assert.equal(fake.posts.get(popular.id_string).state, 'published', 'keep visible exempt');
  assert.equal(fake.posts.get(fresh.id_string).state, 'published');
  assert.ok(display.policyOf(db, 't:main', old.id_string).auto_hide, 'the hide is recorded as ours');
  // rule edit + restart: the exception holds
  db.run(`UPDATE expiry_rules SET days = 7, revision = revision + 1`);
  svc.stop(); db.close();
  const svc2 = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  assert.equal(display.policyOf(svc2.db, 't:main', popular.id_string).display, 'keep_visible');
  svc2.pass();
  for (let i = 0; i < 30; i++) { await svc2.jobs.drain(svc2.ctx); clock.t += 70e3; }
  assert.equal(fake.posts.get(popular.id_string).state, 'published');
  // turning the rule off publishes nothing
  svc2.db.run(`UPDATE expiry_rules SET enabled = 0, revision = revision + 1`);
  svc2.pass();
  for (let i = 0; i < 10; i++) { await svc2.jobs.drain(svc2.ctx); clock.t += 70e3; }
  assert.equal(fake.posts.get(old.id_string).state, 'private');
  assert.equal(fake.posts.get(hidden.id_string).state, 'private');
  // restore lists only our own hides
  const plan = display.restorePlan(svc2.db, 1);
  assert.deepEqual(plan.map(p => p.id), [old.id_string]);
});

test('expiry: a hide queued before automatic hiding was switched off sends nothing', async () => {
  const { fake, svc, run, db, clock } = setup();
  const p = fake.addPost('t:main', { timestamp: ts(clock.t - 60 * DAY) });
  svc.pass(); await run();
  db.run(`INSERT INTO expiry_rules (mode, blog, enabled, days) VALUES ('independent', 't:main', 1, 30)`);
  assert.ok(display.queueExpiry(db, svc.jobs, { now: clock.t, limit: 40 }) >= 1, 'queued while it was on');
  db.setMeta('automation', { expiry: false });
  await run();
  assert.equal(fake.posts.get(p.id_string).state, 'published');
  assert.equal(svc.jobs.list({}).find(j => j.kind === 'post.visibility').status, 'cancelled');
});

test('expiry: an external republish of an auto-hidden post becomes keep visible (A15)', async () => {
  const { fake, svc, run, db, clock } = setup();
  const p = fake.addPost('t:main', { timestamp: ts(clock.t - 60 * DAY) });
  svc.pass(); await run();
  db.run(`INSERT INTO expiry_rules (mode, blog, enabled, days) VALUES ('independent', 't:main', 1, 30)`);
  db.setMeta('automation', { expiry: true });
  svc.pass(); await run();
  assert.equal(fake.posts.get(p.id_string).state, 'private');
  fake.posts.get(p.id_string).state = 'published'; // the user republished it on Tumblr
  svc.pass(); await run();
  assert.equal(fake.posts.get(p.id_string).state, 'published', 'not fought');
  assert.equal(display.policyOf(db, 't:main', p.id_string).display, 'keep_visible');
});

test('expiry: linked mode anchors at the original, keep visible on one instance only (A14, A34)', async () => {
  const { fake, svc, run, db, clock, roles } = setup();
  svc.pass(); await run(); roles();
  const A = fake.addPost('t:main', { timestamp: ts(clock.t - 200 * DAY) });
  const B = await fake.reblog('t:art', { parentBlog: 't:main', parentId: A.id_string });
  fake.posts.get(B).timestamp = ts(clock.t - 2 * DAY); // the copy is new
  svc.pass(); await run();
  // independent rule on the side blog alone would not hide the new copy
  db.run(`INSERT INTO expiry_rules (mode, blog, enabled, days, targets) VALUES ('linked', 't:art', 1, 30, '["t:art"]')`);
  db.setMeta('automation', { expiry: true });
  const ev = display.evaluate(db, clock.t);
  const eb = ev.find(r => r.id === B);
  assert.equal(eb.action, 'hide');
  assert.equal(eb.anchor.id, A.id_string);
  display.keepVisible(db, svc.jobs, [{ blog: 't:main', id: A.id_string }]);
  svc.pass(); await run();
  assert.equal(fake.posts.get(A.id_string).state, 'published');
  assert.equal(fake.posts.get(B).state, 'private');
});

test('stale reads after a write do not cause a second write (verification polls)', async () => {
  const { fake, svc, run, db, clock } = setup({ staleReads: 2 });
  const p = fake.addPost('t:main', { timestamp: ts(clock.t - DAY) });
  svc.pass(); await run();
  display.userVisibility(db, svc.jobs, [{ blog: 't:main', id: p.id_string }], 'private');
  await run();
  assert.equal(fake.calls.filter(c => c === 'put:' + p.id_string).length, 1);
  const j = svc.jobs.list().find(j => j.kind === 'post.visibility');
  assert.equal(j.status, 'succeeded');
  assert.equal(display.policyOf(db, 't:main', p.id_string).display, 'keep_hidden');
});

test('edits do not wait for a community-label confirmation', async () => {
  const { fake, svc, run, db } = setup();
  const p = fake.addPost('t:main');
  svc.pass(); await run();
  display.userVisibility(db, svc.jobs, [{ blog: 't:main', id: p.id_string }], 'private');
  await run();
  assert.equal(fake.posts.get(p.id_string).state, 'private');
});

test('routes: exclusions skip whole posts, whole-tag match, no duplicates, tombstones (A17, A19, A20)', async () => {
  const { fake, svc, run, db, clock, roles } = setup();
  svc.pass(); await run(); roles();
  const id = routes.saveRoute(db, svc.jobs, { sources: ['t:art'], dest: 't:main', enabled: true, exclude: [' #Diary ', 'art'] }, clock.t);
  db.setMeta('automation', { routes: true });
  clock.t += 1000;
  const d = fake.addPost('t:art', { tags: ['diary'], timestamp: ts(clock.t) });
  const f = fake.addPost('t:art', { tags: ['fanart'], timestamp: ts(clock.t) });
  const priv = fake.addPost('t:art', { tags: ['wip'], timestamp: ts(clock.t), state: 'private' });
  const old = fake.addPost('t:art', { tags: ['x'], timestamp: ts(clock.t - 30 * DAY) });
  svc.pass(); await run();
  const onMain = () => [...fake.posts.values()].filter(p => p.blog.uuid === 't:main').map(p => p.parent_post_id);
  assert.deepEqual(onMain(), [f.id_string], 'fanart is not excluded by "art"; diary is skipped; private/old untouched');
  assert.equal(db.get('SELECT status FROM deliveries WHERE src_id = ?', d.id_string).status, 'skipped');
  // another pass and a restart don't make a second copy
  svc.pass(); await run();
  assert.equal(onMain().length, 1);
  // the user deletes the copy: it is not recreated
  const copy = [...fake.posts.values()].find(p => p.blog.uuid === 't:main');
  fake.posts.delete(copy.id_string);
  svc.pass({ full: true }); await run();
  assert.equal(onMain().length, 0);
  assert.equal(db.get('SELECT status FROM deliveries WHERE src_id = ?', f.id_string).status, 'tombstone');
  // a lost reblog response is reconciled against the destination, not sent twice
  clock.t += 1000;
  const g = fake.addPost('t:art', { tags: ['comic'], timestamp: ts(clock.t) });
  const origReblog = fake.reblog;
  fake.reblog = async (...a) => { await origReblog(...a); throw netFail(true); };
  svc.pass(); await run();
  fake.reblog = origReblog;
  await run();
  assert.equal(onMain().filter(x => x === g.id_string).length, 1);
  assert.equal(db.get('SELECT status FROM deliveries WHERE src_id = ?', g.id_string).status, 'created');
  // an exclusion added before sending stops the queued reblog
  clock.t += 1000;
  const h = fake.addPost('t:art', { tags: ['Personal'], timestamp: ts(clock.t) });
  svc.pass();
  await svc.jobs.drain(svc.ctx, 3); // syncs only
  routes.saveRoute(db, svc.jobs, { id, sources: ['t:art'], dest: 't:main', enabled: true, exclude: ['diary', 'art', 'personal'] }, clock.t);
  await run();
  assert.ok(!onMain().includes(h.id_string));
});

test('routes: a refused reblog leaves reblog control unchanged (A20)', async () => {
  const { fake, svc, run, db, clock, roles } = setup();
  svc.pass(); await run(); roles();
  routes.saveRoute(db, svc.jobs, { sources: ['t:art'], dest: 't:main', enabled: true }, clock.t);
  db.setMeta('automation', { routes: true });
  clock.t += 1000;
  const p = fake.addPost('t:art', { timestamp: ts(clock.t), interactability_reblog: 'noone' });
  fake.fail.next = { method: 'POST', error: new (require('../src/service/errors').HttpError)('HTTP 403', { status: 403 }) };
  svc.pass(); await run();
  assert.equal(fake.posts.get(p.id_string).interactability_reblog, 'noone');
  assert.ok(!fake.calls.some(c => c === 'put:' + p.id_string), 'the original was not opened up');
});

test('routes: waiting for the browser leaves the delivery open, and it is created once later', async () => {
  const { fake, svc, run, db, clock, roles } = setup();
  svc.pass(); await run(); roles();
  routes.saveRoute(db, svc.jobs, { sources: ['t:art'], dest: 't:main', enabled: true }, clock.t);
  db.setMeta('automation', { routes: true });
  clock.t += 1000;
  const p = fake.addPost('t:art', { timestamp: ts(clock.t) });
  const orig = fake.reblog;
  fake.reblog = async () => { throw new (require('../src/service/errors').WaitError)('waiting for the browser'); };
  svc.pass();
  for (let i = 0; i < 6; i++) await svc.jobs.drain(svc.ctx);
  assert.notEqual(db.get('SELECT status FROM deliveries WHERE src_id = ?', p.id_string)?.status, 'failed');
  assert.ok(svc.jobs.list({}).some(j => j.kind === 'post.reblog' && j.status === 'waiting'), JSON.stringify(svc.jobs.list({}).map(j => [j.kind, j.status])));
  fake.reblog = orig;
  await run();
  assert.equal([...fake.posts.values()].filter(x => x.blog.uuid === 't:main' && x.parent_post_id === p.id_string).length, 1);
  assert.equal(db.get('SELECT status FROM deliveries WHERE src_id = ?', p.id_string).status, 'created');
});

test('work tags: one change applied to the chosen originals keeps visibility and other tags; reblogs are skipped (A05, A14, R02, R08)', async () => {
  const { fake, svc, run, db, roles } = setup();
  const { makeApi } = require('../src/service/api');
  const api = makeApi(svc, {});
  svc.pass(); await run(); roles();
  const A = fake.addPost('t:main', { tags: ['fanart', 'Character Alpha', 'old tag'], state: 'published' });
  const B = await fake.reblog('t:art', { parentBlog: 't:main', parentId: A.id_string, tags: ['fanart', 'side only'] });
  fake.posts.get(B).state = 'private';
  svc.pass(); await run();
  api.applyTags({ targets: [{ blog: 't:main', id: A.id_string }, { blog: 't:art', id: B }], add: ['example series'], remove: ['old tag'] });
  await run();
  assert.deepEqual(fake.posts.get(A.id_string).tags, ['fanart', 'Character Alpha', 'example series']);
  assert.deepEqual(fake.posts.get(B).tags, ['fanart', 'side only'], 'the reblog is a snapshot: its tags stay as they were (R02)');
  assert.ok(!fake.calls.includes('put:' + B), 'the snapshot was not even re-sent');
  assert.equal(fake.posts.get(A.id_string).state, 'published');
  assert.equal(fake.posts.get(B).state, 'private');
});

test('sync: an incremental pass over many pages inside the overlap window ends (no re-reading from the top)', async () => {
  const { fake, svc, db, clock } = setup();
  // a collection-like blog: 400 posts made within one day, so every page is newer than "newest − 2 days"
  for (let i = 0; i < 400; i++) fake.addPost('t:ref', { timestamp: ts(clock.t - i * 60e3), tags: ['ref'] });
  const sync = require('../src/service/sync');
  const ctx = { db, tumblr: fake, now: () => clock.t };
  // first a complete full pass
  let r = { done: false }, guard = 0;
  while (!r.done && guard++ < 10) r = await sync.syncChunk(ctx, { blog: 't:ref', mode: 'full' });
  assert.ok(r.done);
  // then an incremental one, chunk by chunk, carrying `next` the way the job handler does
  fake.calls.length = 0;
  let next = null, pages = 0; r = { done: false }; guard = 0;
  while (!r.done && guard++ < 20) { r = await sync.syncChunk(ctx, { blog: 't:ref', mode: 'inc' }, next); next = r.next; pages += r.pages; }
  assert.ok(r.done, 'the incremental pass finished');
  assert.equal(pages, 20, 'each page read once (400 posts / 20)');
  // and through the job handler itself
  svc.jobs.add('sync.blog', { blog: 't:ref', box: '', mode: 'inc' }, { scope: 'sync:t:ref:' });
  for (let i = 0; i < 10; i++) await svc.jobs.drain(svc.ctx);
  const j = db.get(`SELECT status, result FROM jobs WHERE kind = 'sync.blog' ORDER BY id DESC LIMIT 1`);
  assert.equal(j.status, 'succeeded');
  assert.equal(JSON.parse(j.result).pages, 20);
});
