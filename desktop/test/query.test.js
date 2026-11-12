'use strict';
// The Posts page query (docs/CONTENT_BROWSER_UX_SPEC.md 3.2, CU02–CU09): any/all per category group, AND across
// groups, exclusions, "not set", "no tags" and unknown data kept apart, whole-tag identity, one unit per work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService } = require('../src/service/service');
const { makeApi } = require('../src/service/api');
const { addWriting } = require('../src/service/writing');
const { makeFake } = require('./fake-tumblr');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-q-'));
  const clock = { t: Date.now() };
  const fake = makeFake({ blogs: [{ uuid: 't:main', name: 'mainblog', primary: true }, { uuid: 't:art', name: 'artside' }], now: () => clock.t });
  const svc = createService({ dataDir: dir, tumblr: fake, now: () => clock.t });
  const extra = {};
  addWriting(svc, extra, { dataDir: dir });
  const api = makeApi(svc, { extra });
  const run = async () => { for (let i = 0; i < 20; i++) { await svc.jobs.drain(svc.ctx); clock.t += 70e3; } };
  svc.pass(); await run();
  svc.db.run(`UPDATE blogs SET role = 'share'`);
  // test configuration: two groups (not product values)
  const db = svc.db;
  db.run('DELETE FROM categories'); db.run('DELETE FROM category_groups');
  const g = name => Number(db.run('INSERT INTO category_groups (key, name, ord) VALUES (NULL, ?, 0)', name).lastInsertRowid);
  const nature = g('nature'), role = g('role'), course = g('course');
  const cat = (name, tag, gid) => Number(db.run('INSERT INTO categories (name, tag, group_id, ord) VALUES (?, ?, ?, 0)', name, tag, gid).lastInsertRowid);
  const c = { fan: cat('同人', 'fanart', nature), orig: cat('原创', 'original art', nature), study: cat('习作', 'art study', role), A: cat('课程 A', 'course A', course), B: cat('课程 B', 'course B', course) };
  const add = (tags, blog = 't:art') => fake.addPost(blog, { tags });
  const P = {
    P1: add(['fanart', 'art study', 'course A']),
    P2: add(['fanart', 'art study', 'course B', 'diary']),
    P3: add(['fanart', 'course A', 'course B']),
    P4: add(['original art', 'art study', 'course A']),
    P5: add([]),
    P6o: add(['fanart', 'course A']),
  };
  svc.pass(); await run();
  // P6: a reblog of an original that is no longer readable -> the work's data is unknown
  await fake.reblog('t:main', { parentBlog: 't:art', parentId: P.P6o.id_string, tags: ['fanart', 'course A', 'diary'] });
  svc.pass(); await run();
  db.run(`UPDATE posts SET state = 'gone' WHERE blog = 't:art' AND id = ?`, P.P6o.id_string);
  const ids = Object.fromEntries(Object.entries(P).map(([n, p]) => [p.id_string, n]));
  const names = r => r.rows.map(x => ids[x.id] || (x.origin_missing ? 'P6' : x.blog + '/' + x.id)).sort();
  const q = (extraQ = {}) => api.posts({ view: 'managed', scope: 'all', limit: 100, ...extraQ });
  return { svc, api, db, c, groups: { nature, role, course }, q, names, fake, run, P };
}

test('query: the spec\'s P1–P6 boolean examples (CU02, CU03, CU04, CU06)', async () => {
  const { c, groups: G, q, names } = await setup();
  const cats = o => ({ cats: o });
  assert.deepEqual(names(q(cats({ [G.nature]: { inc: [c.fan] }, [G.course]: { inc: [c.A, c.B] } }))), ['P1', 'P2', 'P3'], 'fanart AND (A OR B)');
  assert.deepEqual(names(q(cats({ [G.nature]: { inc: [c.fan] }, [G.role]: { inc: [c.study] }, [G.course]: { inc: [c.A, c.B] } }))), ['P1', 'P2']);
  assert.deepEqual(names(q({ ...cats({ [G.nature]: { inc: [c.fan] }, [G.role]: { inc: [c.study] }, [G.course]: { inc: [c.A, c.B] } }), tags: { exc: ['diary'] } })), ['P1']);
  assert.deepEqual(names(q(cats({ [G.nature]: { inc: [c.fan] }, [G.course]: { mode: 'all', inc: [c.A, c.B] } }))), ['P3'], 'all of a group');
  assert.deepEqual(names(q({ tags: { exc: ['diary'] } })), ['P1', 'P3', 'P4', 'P5'], 'an exclusion alone never admits unknown data');
  assert.deepEqual(names(q({ tags: { none: true } })), ['P5'], 'no tags is not unknown');
  assert.deepEqual(names(q(cats({ [G.course]: { unset: true } }))), ['P5'], 'course not set');
  assert.deepEqual(names(q(cats({ [G.role]: { unset: true } }))), ['P3', 'P5']);
  assert.deepEqual(names(q({ missing: true })), ['P6'], 'unknown data has its own condition');
  // legacy: tags: [...] means all of them, as before
  assert.deepEqual(names(q({ tags: ['fanart', 'course A'] })), ['P1', 'P3']);
  assert.deepEqual(names(q({ tags: { inc: ['course A', 'course B'], mode: 'any' } })), ['P1', 'P2', 'P3', 'P4']);
});

test('query: one unit per work, unknown data never borrows a reblog\'s tags; displayed view uses each post\'s own (CU07, CU08)', async () => {
  const { api, q, names } = await setup();
  const managed = q({ tags: { inc: ['diary'] } });
  assert.deepEqual(names(managed), ['P2'], 'the reblog carries diary, but the work\'s original is unknown');
  const all = q();
  assert.equal(all.rows.filter(r => r.origin_missing).length, 1, 'one card for the work whose original is missing');
  assert.equal(all.total, 6);
  const shown = api.posts({ view: 'displayed', scope: 'all', tags: { inc: ['diary'] }, limit: 100 });
  assert.equal(shown.total, 2, 'P2 and the reblog itself, by its own tags');
  assert.ok(shown.rows.some(r => r.kind === 'reblog' && r.blog === 't:main'));
  const match = api.postsMatch({ view: 'managed', scope: 'all', missing: true });
  assert.equal(match.total, 1);
  assert.equal(match.ids[0].origin_missing, true, 'marked so the page never makes it a write target');
});

test('query: whole-tag identity, literal text search, counts beyond the loaded page (CU05, CU09)', async () => {
  const { api, fake, svc, run, q, P } = await setup();
  for (const tg of [['Art'], ['art'], ['fanart'], ['%E7%8C%B9 fish'], ['猹 fish'], ['🎨'], ['100%'], ['a_b']]) fake.addPost('t:art', { tags: tg });
  svc.pass(); await run();
  svc.db.run(`UPDATE posts SET state = 'gone' WHERE blog = 't:art' AND id = ?`, P.P6o.id_string);
  assert.equal(q({ tags: { inc: ['art'] } }).total, 2, 'Art and art, never fanart');
  assert.equal(q({ tags: { inc: ['#猹 FISH'] } }).total, 2, 'decoded and plain spellings are one tag');
  assert.equal(q({ tags: { inc: ['🎨'] } }).total, 1);
  assert.equal(q({ text: '%' }).total, 1, 'a literal percent sign, not a wildcard');
  assert.equal(q({ text: '_' }).total, 1);
  // a tag only present past the first page is still suggested, with an "after adding" count
  const page = q({ limit: 2 });
  assert.equal(page.rows.length, 2);
  assert.ok(page.total > 2);
  const cand = api.tagCandidates({ view: 'managed', scope: 'all', text: 'a_b' });
  assert.equal(cand.list[0].tag, 'a_b');
  assert.equal(cand.list[0].after, 1);
  const cat = api.tagCandidates({ view: 'managed', scope: 'all', text: '同人' });
  assert.equal(cat.list[0].cat.name, '同人', 'categories are found by display name');
  // facet counts: the result size after adding each option
  const f = api.posts({ view: 'managed', scope: 'all', limit: 1, facets: true }).facets;
  assert.ok(Object.values(f.cat).every(n => typeof n === 'number'));
  assert.equal(f.missing, 1);
});

test('query: expiring is an ordinary condition that combines with tags; the query writes nothing (CU14, CU17)', async () => {
  const { api, svc, q } = await setup();
  const before = svc.db.get('SELECT COUNT(*) n FROM jobs').n;
  api.saveRule({ mode: 'independent', blog: 't:art', enabled: true, days: 3, kinds: ['original'] });
  const exp = api.posts({ view: 'displayed', scope: 'all', expiring: { days: 7 }, tags: { inc: ['course A'] }, limit: 100 });
  assert.ok(exp.total >= 1);
  assert.ok(exp.rows.every(r => r.tags.some(t => t.toLowerCase() === 'course a') && r.state === 'published' && r.expiry?.due));
  q({ cats: {}, tags: { exc: ['x'] }, facets: true }); api.postsMatch({}); api.tagCandidates({ text: 'a' });
  assert.equal(svc.db.get('SELECT COUNT(*) n FROM jobs').n, before, 'no job from querying');
});
